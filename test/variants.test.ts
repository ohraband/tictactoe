import test from 'node:test';
import assert from 'node:assert/strict';
import { VARIANTS, createState, applyMove, getLegalMoves, landingCell } from '../shared/game.ts';
import type { GameState, Variant } from '../shared/game.ts';
import { chooseMove } from '../shared/ai.ts';
import { start, sse, until } from './helpers.ts';

const play = (variant: Variant, moves: number[]): GameState => moves.reduce<GameState>((s, m) => applyMove(s, m)!, createState(variant));
const rng = () => 0;

test('each board type has the expected number of winning lines', () => {
  assert.deepEqual(Object.values(VARIANTS).map((v) => v.lines.length), [8, 10, 28, 76]);
});

test('cube: pieces fall to the lowest free slot, and a full peg is rejected', () => {
  const s = play('cube', [5, 5, 5]);
  assert.deepEqual([0, 1, 2].map((z) => s.board[z * 16 + 5]), ['X', 'O', 'X']);
  assert.equal(landingCell(s, 5), 3 * 16 + 5);
  assert.equal(s.last, 2 * 16 + 5);
  const full = play('cube', [3, 3, 3, 3]);
  assert.equal(applyMove(full, 3), null);
  assert.equal(getLegalMoves(full).length, 15);
  assert.equal(applyMove(createState('cube'), 16), null, 'there are only 16 pegs');
});

test('cube: a pillar, a flat row, and a diagonal through the cube all win', () => {
  const pillar = play('cube', [0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual([pillar.winner, pillar.line!.map((c) => c % 16)], ['X', [0, 0, 0, 0]]);
  assert.deepEqual(play('cube', [0, 4, 1, 5, 2, 6, 3]).line, [0, 1, 2, 3]);
  // X on (0,0,0), (1,1,1), (2,2,2); the last piece lands at (3,3,3) on peg 15
  const board = createState('cube').board;
  board[0] = 'X'; board[21] = 'X'; board[42] = 'X';
  for (const c of [5, 10, 26, 15, 31, 47]) board[c] = 'O';
  const next = applyMove({ ...createState('cube'), board }, 15)!;
  assert.equal(next.winner, 'X');
  assert.deepEqual([...next.line!].sort((a, b) => a - b), [0, 21, 42, 63]);
});

test('4x4 needs four in a row, and 5x5 also needs four (not five)', () => {
  assert.equal(play('grid4', [0, 1, 4, 2, 8, 3, 12]).winner, 'X');
  assert.equal(play('grid4', [0, 4, 1, 5, 2, 6]).winner, null, 'three is not enough');
  assert.equal(play('grid5', [0, 5, 1, 6, 2, 7, 3]).winner, 'X');
});

test('the AI takes a win and blocks a loss on the cube and on 5x5', () => {
  for (const level of ['medium', 'hard'] as const) {
    assert.equal(chooseMove(play('cube', [0, 1, 0, 1, 0, 1]), level, rng, 150), 0, `${level} wins on the cube`);
    assert.equal(chooseMove(play('cube', [0, 5, 0, 6, 0]), level, rng, 150), 0, `${level} blocks on the cube`);
    assert.equal(chooseMove(play('grid5', [0, 5, 1, 6, 2, 11]), level, rng, 150), 3, `${level} wins on 5x5`);
    assert.equal(chooseMove(play('grid5', [5, 0, 6, 1, 7]), level, rng, 150), 8, `${level} blocks on 5x5`);
  }
});

test('hard AI answers within its time budget on the cube', () => {
  const t0 = Date.now();
  const move = chooseMove(createState('cube'), 'hard', rng, 200);
  assert.ok(move !== null && move >= 0 && move < 16);
  assert.ok(Date.now() - t0 < 1000);
});

test('online: a cube room can be played, and unknown board types are rejected', async () => {
  const t = await start();
  try {
    assert.equal((await t.post('/api/rooms', { variant: 'hexagon' })).status, 400);
    const a = (await t.post('/api/rooms', { variant: 'cube' })).body;
    const b = (await t.post(`/api/rooms/${a.code}/join`)).body;
    const ea = await sse(t.base, a.code, a.token);
    const first = await until(ea, (v) => v.status === 'playing');
    assert.deepEqual([first.variant, first.board.length], ['cube', 64]);

    const mv = (s: { token: string }, i: number) => t.post(`/api/rooms/${a.code}/move`, { token: s.token, index: i });
    assert.equal((await mv(a, 16)).status, 409, 'there are only 16 pegs');
    assert.equal((await mv(a, 5)).status, 200);
    assert.equal((await until(ea, (v) => v.board[5] === 'X')).last, 5);
    for (const [s, i] of [[b, 6], [a, 5], [b, 6], [a, 5], [b, 6], [a, 5]] as const) assert.equal((await mv(s, i)).status, 200);
    const won = await until(ea, (v) => !!v.winner);
    assert.deepEqual([won.winner, won.line!.map((c) => c % 16)], ['X', [5, 5, 5, 5]]);

    await t.post(`/api/rooms/${a.code}/rematch`, { token: a.token });
    await t.post(`/api/rooms/${a.code}/rematch`, { token: b.token });
    const again = await until(ea, (v) => v.status === 'playing' && v.board.every((c) => c === null));
    assert.deepEqual([again.variant, again.board.length], ['cube', 64], 'a rematch keeps the board type');
    ea.close();
  } finally { await t.stop(); }
});
