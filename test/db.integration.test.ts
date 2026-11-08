// Runs against a real Postgres. Skipped unless TEST_DATABASE_URL is set (CI provides one).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/db.ts';

const url = process.env.TEST_DATABASE_URL;

test('postgres store: migrations, players, games, leaderboard, history', { skip: !url && 'TEST_DATABASE_URL not set' }, async () => {
  const first = (await createStore(url))!;
  await first.close();
  const store = (await createStore(url))!; // second start proves migrations are idempotent
  try {
    const tag = String(Date.now() % 1_000_000);
    const ann = (await store.registerPlayer('Ann' + tag))!;
    assert.equal(await store.registerPlayer('ANN' + tag), null, 'nicknames are case-insensitive');
    const bob = (await store.registerPlayer('Bob' + tag))!;
    const annRow = (await store.playerBySecret(ann.secret))!;
    const bobRow = (await store.playerBySecret(bob.secret))!;
    assert.equal(await store.playerBySecret('wrong'), null);

    await store.saveGame({ code: 'TEST', xId: annRow.id, oId: bobRow.id, xName: ann.name, oName: bob.name, winner: 'X', draw: false, moves: 5, variant: 'classic' });
    await store.saveGame({ code: 'TEST', xId: bobRow.id, oId: annRow.id, xName: bob.name, oName: ann.name, winner: null, draw: true, moves: 9, variant: 'classic' });

    const board = await store.leaderboard();
    const row = board.find((r) => r.name === ann.name)!;
    assert.deepEqual([row.wins, row.losses, row.draws, row.games], [1, 0, 1, 2]);

    const annHistory = await store.history(ann.name);
    assert.deepEqual(annHistory.map((h) => h.result), ['draw', 'win']);
    assert.equal(annHistory[1].opponent, bob.name);
    assert.equal((await store.history(bob.name))[1].result, 'loss');
    await store.ping();
  } finally { await store.close(); }
});
