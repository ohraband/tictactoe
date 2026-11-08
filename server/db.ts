// Optional Postgres storage. If DATABASE_URL is not set, the game runs without a database.
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Mark } from '../shared/game.ts';
import { ROOT } from './root.ts';

export interface SavedGame {
  code: string; xId: string | null; oId: string | null; xName: string; oName: string;
  winner: Mark | null; draw: boolean; moves: number; variant: string;
}
export interface LeaderRow { name: string; wins: number; losses: number; draws: number; games: number }
export interface HistoryRow { created_at: string; moves: number; variant: string; opponent: string; result: 'win' | 'loss' | 'draw' }
export interface Store {
  registerPlayer(name: string): Promise<{ name: string; secret: string } | null>;
  playerBySecret(secret: string): Promise<{ id: string; name: string } | null>;
  saveGame(g: SavedGame): Promise<void>;
  leaderboard(): Promise<LeaderRow[]>;
  history(name: string): Promise<HistoryRow[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Applies migrations/*.sql in order, once each, each inside a transaction.
async function migrate(pool: Pool): Promise<void> {
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(ROOT, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(727274)'); // one instance migrates at a time
      const done = await client.query('select 1 from schema_migrations where name = $1', [file]);
      if (!done.rowCount) {
        await client.query(await readFile(path.join(dir, file), 'utf8'));
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        console.log(JSON.stringify({ severity: 'info', msg: 'migration applied', file }));
      }
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function createStore(url: string | undefined): Promise<Store | null> {
  if (!url) return null;
  const mod: any = await import('pg');
  const PoolCtor = mod.default?.Pool ?? mod.Pool;
  const pool: Pool = new PoolCtor({ connectionString: url, max: 5 });

  // The database container may still be starting, so retry for up to ~30 seconds.
  for (let attempt = 1; ; attempt++) {
    try { await pool.query('select 1'); break; }
    catch (err) {
      if (attempt >= 20) throw err;
      console.log(JSON.stringify({ severity: 'info', msg: 'waiting for database', attempt }));
      await sleep(1500);
    }
  }
  await migrate(pool);

  const mine = '(g.x_player_id = p.id or g.o_player_id = p.id)';
  const won = "((g.x_player_id = p.id and g.winner = 'X') or (g.o_player_id = p.id and g.winner = 'O'))";
  const lost = "((g.x_player_id = p.id and g.winner = 'O') or (g.o_player_id = p.id and g.winner = 'X'))";

  return {
    async registerPlayer(name) {
      const secret = randomBytes(24).toString('hex');
      try {
        const { rows } = await pool.query(
          'insert into players (name, name_key, secret_hash) values ($1, $2, $3) returning name',
          [name, name.toLowerCase(), hash(secret)]);
        return { name: rows[0].name, secret };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') return null; // nickname already taken
        throw e;
      }
    },
    async playerBySecret(secret) {
      const { rows } = await pool.query('select id::text as id, name from players where secret_hash = $1', [hash(secret)]);
      return rows[0] ?? null;
    },
    async saveGame(g) {
      await pool.query(
        `insert into games (room_code, x_name, o_name, x_player_id, o_player_id, winner, draw, moves, variant)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [g.code, g.xName, g.oName, g.xId, g.oId, g.winner, g.draw, g.moves, g.variant]);
    },
    async leaderboard() {
      const { rows } = await pool.query(`
        select p.name,
               count(*) filter (where ${won})::int as wins,
               count(*) filter (where ${lost})::int as losses,
               count(*) filter (where g.draw)::int as draws,
               count(g.id)::int as games
        from players p join games g on ${mine}
        group by p.id, p.name
        order by wins desc, games asc, p.name
        limit 20`);
      return rows;
    },
    async history(name) {
      const { rows } = await pool.query(`
        select g.created_at, g.moves, g.variant,
               case when g.x_player_id = p.id then g.o_name else g.x_name end as opponent,
               case when g.draw then 'draw' when ${won} then 'win' else 'loss' end as result
        from players p join games g on ${mine}
        where p.name_key = $1
        order by g.id desc
        limit 25`, [name.toLowerCase()]);
      return rows;
    },
    async ping() { await pool.query('select 1'); },
    close: () => pool.end(),
  };
}
