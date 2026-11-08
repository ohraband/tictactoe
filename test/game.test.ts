import test from 'node:test';
import assert from 'node:assert/strict';
import { LINES, createState, applyMove, getWinner, getLegalMoves } from '../shared/game.ts';
import type { GameState, Mark } from '../shared/game.ts';
import { chooseMove } from '../shared/ai.ts';
import type { Level } from '../shared/ai.ts';

const play = (moves: number[]): GameState => moves.reduce<GameState>((s, m) => applyMove(s, m)!, createState());

test('every one of the 8 lines wins for X', () => {
  assert.equal(LINES.length, 8);
  for (const line of LINES) {
    const others = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => !line.includes(i)).slice(0, 2);
    const s = play([line[0], others[0], line[1], others[1], line[2]]);
    assert.equal(s.winner, 'X', `line ${line}`);
    assert.deepEqual(s.line, [...line]);
  }
});

test('draw is detected and no moves remain', () => {
  const s = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
  assert.equal(s.winner, null);
  assert.equal(s.draw, true);
  assert.deepEqual(getLegalMoves(s), []);
});

test('illegal moves are rejected', () => {
  assert.equal(applyMove(play([0]), 0), null, 'occupied');
  for (const bad of [-1, 9, 1.5, NaN, '1', null, undefined]) assert.equal(applyMove(createState(), bad), null);
  assert.equal(applyMove(play([0, 3, 1, 4, 2]), 8), null, 'after win');
});

test('applyMove does not mutate the previous state', () => {
  const s = createState();
  applyMove(s, 4);
  assert.equal(s.board[4], null);
});

test('getWinner returns null on an open board', () => assert.equal(getWinner(createState().board), null));

test('easy AI always plays a legal move', () => {
  for (let i = 0; i < 100; i++) {
    const s = play([0, 4]);
    assert.ok(getLegalMoves(s).includes(chooseMove(s, 'easy')!));
  }
});

test('medium AI takes a win and blocks a loss', () => {
  assert.equal(chooseMove(play([0, 3, 1, 4]), 'medium'), 2, 'wins when it can');
  assert.equal(chooseMove(play([0, 4, 1]), 'medium'), 2, 'blocks otherwise');
});

function hardLosses(hardMark: Mark, level: Level, games: number): number {
  let losses = 0;
  for (let g = 0; g < games; g++) {
    let s = createState();
    while (!s.winner && !s.draw) s = applyMove(s, chooseMove(s, s.turn === hardMark ? 'hard' : level))!;
    if (s.winner && s.winner !== hardMark) losses++;
  }
  return losses;
}

test('hard AI never loses to random or medium play, as X or O', () => {
  for (const level of ['easy', 'medium'] as const) {
    assert.equal(hardLosses('X', level, 20), 0);
    assert.equal(hardLosses('O', level, 20), 0);
  }
});

test('hard vs hard always draws', () => {
  let s = createState();
  while (!s.winner && !s.draw) s = applyMove(s, chooseMove(s, 'hard'))!;
  assert.equal(s.draw, true);
});
