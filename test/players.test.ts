import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from './helpers.ts';
import type { Store, SavedGame } from '../server/db.ts';

// In-memory stand-in for the Postgres store, so the player logic is tested without a database.
function fakeStore() {
  const players = new Map<string, { id: string; name: string }>();
  const games: SavedGame[] = [];
  let up = true;
  const store: Store = {
    async registerPlayer(name) {
      if ([...players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase())) return null;
      const secret = 'secret' + players.size;
      players.set(secret, { id: String(players.size + 1), name });
      return { name, secret };
    },
    async playerBySecret(s) { return players.get(s) ?? null; },
    async saveGame(g) { games.push(g); },
    async leaderboard() { return [{ name: 'Ann', wins: 1, losses: 0, draws: 0, games: 1 }]; },
    async history() { return [{ result: 'win', opponent: 'Bob', moves: 5, variant: 'classic', created_at: new Date().toISOString() }]; },
    async ping() { if (!up) throw new Error('down'); },
    async close() {},
  };
  return { store, games, setUp: (v: boolean) => { up = v; } };
}

test('guest nicknames, identified seats, saved games, history', async () => {
  const fake = fakeStore();
  const t = await start({ store: fake.store });
  try {
    assert.equal((await t.post('/api/players', { name: 'A' })).status, 400, 'too short');
    const ann = (await t.post('/api/players', { name: 'Ann' })).body;
    assert.equal((await t.post('/api/players', { name: 'ann' })).status, 409, 'nicknames are case-insensitive');
    const bob = (await t.post('/api/players', { name: 'Bob' })).body;

    assert.equal((await t.post('/api/rooms', { name: 'Ann' })).status, 401, 'a name alone is not enough');
    const room = await t.post('/api/rooms', { secret: ann.secret });
    assert.equal(room.status, 201);
    const code = room.body.code, a = room.body;

    assert.equal((await t.post(`/api/rooms/${code}/join`, { secret: ann.secret })).status, 409, 'cannot play yourself');
    assert.equal((await t.post(`/api/rooms/${code}/join`, { secret: 'bad' })).status, 401);
    const b = (await t.post(`/api/rooms/${code}/join`, { secret: bob.secret })).body;

    const mv = (s: { token: string }, i: number) => t.post(`/api/rooms/${code}/move`, { token: s.token, index: i });
    for (const [s, i] of [[a, 0], [b, 3], [a, 1], [b, 4], [a, 2]] as const) assert.equal((await mv(s, i)).status, 200);

    assert.equal(fake.games.length, 1);
    assert.deepEqual([fake.games[0].xId, fake.games[0].oId, fake.games[0].winner], ['1', '2', 'X']);
    assert.equal(fake.games[0].xName, 'Ann');

    assert.equal(((await (await fetch(t.base + '/api/leaderboard')).json()) as any)[0].name, 'Ann');
    assert.equal(((await (await fetch(t.base + '/api/players/Ann/history')).json()) as any)[0].opponent, 'Bob');
  } finally { await t.stop(); }
});

test('nickname registration is rate limited', async () => {
  const t = await start({ store: fakeStore().store, limits: { register: [3, 60_000] } });
  try {
    for (const n of ['Aa1', 'Bb2', 'Cc3']) assert.equal((await t.post('/api/players', { name: n })).status, 201);
    assert.equal((await t.post('/api/players', { name: 'Dd4' })).status, 429);
  } finally { await t.stop(); }
});

test('readiness reflects database health; liveness does not', async () => {
  const fake = fakeStore();
  const t = await start({ store: fake.store });
  try {
    assert.equal((await fetch(t.base + '/api/ready')).status, 200);
    fake.setUp(false);
    assert.equal((await fetch(t.base + '/api/ready')).status, 503);
    assert.equal((await fetch(t.base + '/api/health')).status, 200);
  } finally { await t.stop(); }
});
