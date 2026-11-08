import test from 'node:test';
import assert from 'node:assert/strict';
import { start, sse, until } from './helpers.ts';

test('static files and health', async () => {
  const t = await start();
  try {
    assert.equal((await fetch(t.base + '/')).status, 200);
    assert.equal((await fetch(t.base + '/room/ABCD')).status, 200);
    assert.match((await fetch(t.base + '/shared/game.js')).headers.get('content-type')!, /javascript/);
    assert.equal((await fetch(t.base + '/client/app.js')).status, 200);
    assert.equal((await fetch(t.base + '/server/server.ts')).status, 404);
    assert.equal((await fetch(t.base + '/client/..%2Fpackage.json')).status, 404);
    assert.equal(((await (await fetch(t.base + '/api/health')).json()) as any).ok, true);
    assert.equal(((await (await fetch(t.base + '/api/ready')).json()) as any).ready, true);
  } finally { await t.stop(); }
});

test('full online game: join, validation, win, rematch with swapped sides', async () => {
  const t = await start();
  try {
    const a = (await t.post('/api/rooms')).body;
    assert.match(a.code, /^[A-HJKMNP-Z2-9]{4}$/);
    assert.equal(a.mark, 'X');

    const ea = await sse(t.base, a.code, a.token);
    assert.equal((await until(ea, () => true)).status, 'waiting');
    assert.equal((await t.post(`/api/rooms/${a.code}/move`, { token: a.token, index: 0 })).status, 409, 'cannot move alone');

    const b = (await t.post(`/api/rooms/${a.code}/join`)).body;
    assert.equal(b.mark, 'O');
    await until(ea, (v) => v.status === 'playing');
    const eb = await sse(t.base, a.code, b.token);
    await until(eb, (v) => v.status === 'playing');

    assert.equal((await t.post(`/api/rooms/${a.code}/join`)).status, 409, 'third player is rejected');
    assert.equal((await t.post(`/api/rooms/${a.code}/join`, { token: b.token })).body.seat, 1, 'rejoin with token keeps seat');
    assert.equal((await t.post('/api/rooms/ZZZZ/join')).status, 404);
    assert.equal((await t.post(`/api/rooms/${a.code}/move`, { token: 'nope', index: 0 })).status, 403);

    const mv = (s: { token: string }, i: number) => t.post(`/api/rooms/${a.code}/move`, { token: s.token, index: i });
    assert.equal((await mv(b, 0)).status, 409, 'out of turn');
    assert.equal((await mv(a, 99)).status, 409, 'bad index');
    assert.equal((await mv(a, 0)).status, 200);
    assert.equal((await mv(a, 1)).status, 409, 'duplicate click is out of turn');
    assert.equal((await mv(b, 0)).status, 409, 'occupied cell');
    for (const [s, i] of [[b, 3], [a, 1], [b, 4], [a, 2]] as const) assert.equal((await mv(s, i)).status, 200);

    const won = await until(ea, (v) => !!v.winner);
    assert.equal(won.winner, 'X');
    assert.deepEqual(won.line, [0, 1, 2]);
    assert.equal(won.status, 'over');
    assert.equal(won.scores.X, 1);
    assert.equal((await mv(b, 5)).status, 409, 'no moves after game over');

    await t.post(`/api/rooms/${a.code}/rematch`, { token: a.token });
    const waiting = await until(ea, (v) => v.rematch.length === 1);
    assert.equal(waiting.status, 'over', 'needs both players');
    await t.post(`/api/rooms/${a.code}/rematch`, { token: b.token });
    const again = await until(ea, (v) => v.status === 'playing');
    assert.deepEqual(again.marks, ['O', 'X'], 'sides swapped');
    assert.deepEqual(again.board, Array(9).fill(null));
    assert.equal(again.scores.O, 1, 'win follows the player, not the mark');
    ea.close(); eb.close();
  } finally { await t.stop(); }
});

test('events require a valid token; malformed bodies are rejected', async () => {
  const t = await start();
  try {
    const a = (await t.post('/api/rooms')).body;
    assert.equal((await sse(t.base, a.code, 'bad')).status, 403);
    assert.equal((await fetch(`${t.base}/api/rooms/${a.code}/join`, { method: 'POST', body: '{not json' })).status, 400);
    assert.equal((await fetch(`${t.base}/api/rooms/${a.code}/join`, { method: 'POST', body: '[1]' })).status, 400);
    const big = await fetch(`${t.base}/api/rooms/${a.code}/join`, { method: 'POST', body: 'x'.repeat(5000) }).catch(() => ({ status: 0 }));
    assert.ok(big.status === 413 || big.status === 0);
  } finally { await t.stop(); }
});
