import test from 'node:test';
import assert from 'node:assert/strict';
import { start, sse, until, twoPlayerRoom, within, sleep } from './helpers.ts';

test('security headers, gzip, and ETag caching', async () => {
  const t = await start();
  try {
    const r = await fetch(t.base + '/');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);

    const zipped = await fetch(t.base + '/client/app.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(zipped.headers.get('content-encoding'), 'gzip');
    assert.match(await zipped.text(), /EventSource/, 'body still decodes');

    const etag = (await fetch(t.base + '/client/style.css')).headers.get('etag')!;
    assert.ok(etag);
    assert.equal((await fetch(t.base + '/client/style.css', { headers: { 'if-none-match': etag } })).status, 304);
  } finally { await t.stop(); }
});

test('rate limiting returns 429 with Retry-After', async () => {
  const t = await start({ limits: { create: [2, 60_000] } });
  try {
    assert.equal((await t.post('/api/rooms')).status, 201);
    assert.equal((await t.post('/api/rooms')).status, 201);
    const limited = await t.post('/api/rooms');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally { await t.stop(); }
});

test('emoji reactions: validated, rate limited, broadcast to both players', async () => {
  const t = await start();
  try {
    const solo = (await t.post('/api/rooms')).body;
    assert.equal((await t.post(`/api/rooms/${solo.code}/react`, { token: solo.token, id: 'fire' })).status, 409, 'needs an opponent');

    const room = await twoPlayerRoom(t);
    const react = (token: string, id: unknown) => t.post(`/api/rooms/${room.code}/react`, { token, id });
    assert.equal((await react(room.a.token, 'not-a-reaction')).status, 400);
    assert.equal((await react(room.a.token, '<script>')).status, 400);
    assert.equal((await react('bad-token', 'fire')).status, 403);

    assert.equal((await react(room.a.token, 'fire')).status, 200);
    for (const stream of [room.ea, room.eb]) {
      const v = await until(stream, (x) => x.reaction?.id === 'fire');
      assert.deepEqual([v.reaction!.mark, v.reaction!.seq], ['X', 1]);
    }
    assert.equal((await react(room.a.token, 'clap')).status, 429, 'cooldown');
    assert.equal((await react(room.b.token, 'clap')).status, 200, 'cooldown is per player');
    room.ea.close(); room.eb.close();
  } finally { await t.stop(); }
});

test('a player who stays disconnected forfeits; one who returns in time does not', async () => {
  const t = await start({ graceMs: 250 });
  try {
    // Returns in time: no forfeit.
    const r1 = await twoPlayerRoom(t);
    r1.eb.close();
    await until(r1.ea, (v) => !v.connected[1]);
    const back = await sse(t.base, r1.code, r1.b.token);
    await until(back, (v) => v.connected[1]);
    await sleep(450);
    const fresh = await sse(t.base, r1.code, r1.a.token);
    const state = await within(fresh.next());
    assert.equal(state!.winner, null);
    assert.equal(state!.forfeit, null);
    [r1.ea, back, fresh].forEach((s) => s.close());

    // Does not return: the other player wins.
    const r2 = await twoPlayerRoom(t);
    r2.eb.close();
    const over = await until(r2.ea, (v) => v.forfeit === 'O');
    assert.equal(over.winner, 'X');
    assert.equal(over.status, 'over');
    assert.equal(over.scores.X, 1);
    r2.ea.close();
  } finally { await t.stop(); }
});

test('graceful shutdown ends live streams and resolves', async () => {
  const t = await start();
  const room = await twoPlayerRoom(t);
  await within(t.stop(), 5000);
  assert.equal(await within(room.ea.next()), null, 'stream ended');
});
