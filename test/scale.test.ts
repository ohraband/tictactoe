// Two server instances sharing one room store: a player on one server can play someone on the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, sse, until } from './helpers.ts';
import { createMemoryRoomStore } from '../server/rooms.ts';
import { createRedisRoomStore } from '../server/redis.ts';
import type { RoomStore } from '../server/rooms.ts';

async function crossServerGame(makeStore: () => Promise<RoomStore>) {
  const a = await start({ roomStore: await makeStore() });
  const b = await start({ roomStore: await makeStore() });
  try {
    const x = (await a.post('/api/rooms')).body; // created on server A
    const o = (await b.post(`/api/rooms/${x.code}/join`)).body; // joined on server B
    assert.equal(o.mark, 'O');

    const ex = await sse(a.base, x.code, x.token); // X watches via A
    const eo = await sse(b.base, x.code, o.token); // O watches via B
    await until(ex, (v) => v.connected[0] && v.connected[1]);
    await until(eo, (v) => v.connected[0] && v.connected[1]);

    assert.equal((await a.post(`/api/rooms/${x.code}/move`, { token: x.token, index: 4 })).status, 200);
    assert.equal((await until(eo, (v) => v.board[4] === 'X')).turn, 'O', 'B sees the move made on A');
    assert.equal((await b.post(`/api/rooms/${x.code}/move`, { token: o.token, index: 0 })).status, 200);
    await until(ex, (v) => v.board[0] === 'O'); // A sees the move made on B

    assert.equal((await b.post(`/api/rooms/${x.code}/move`, { token: o.token, index: 1 })).status, 409, 'turn order is shared');
    ex.close(); eo.close();
  } finally { await a.stop(); await b.stop(); }
}

test('rooms are shared across servers (shared in-memory store)', async () => {
  const shared = createMemoryRoomStore();
  await crossServerGame(async () => shared);
});

test('rooms are shared across servers (real Redis)', { skip: !process.env.TEST_REDIS_URL && 'TEST_REDIS_URL not set' }, async () => {
  await crossServerGame(() => createRedisRoomStore(process.env.TEST_REDIS_URL!));
});
