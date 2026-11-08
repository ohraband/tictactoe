// Redis-backed room store, so several game servers can share rooms.
//   room:CODE        the room as JSON, with a time limit that is refreshed while players are connected
//   lock:CODE        short-lived lock that makes updates atomic across servers
//   pres:CODE:TOKEN  "this seat is connected" marker, refreshed by a heartbeat
//   rooms:idx        sorted set of room codes, used to count live rooms
//   rl:KEY           rate limit counters
// Room changes are announced on one pub/sub channel, and each server forwards them to its own live streams.
import { randomBytes } from 'node:crypto';
import type { Room, RoomStore } from './rooms.ts';
import type { RoomView } from '../shared/protocol.ts';

// The small part of the ioredis client that is used here.
export interface RedisLike {
  get(k: string): Promise<string | null>;
  mget(...k: string[]): Promise<(string | null)[]>;
  set(...args: (string | number)[]): Promise<string | null>;
  expire(k: string, s: number): Promise<number>;
  incr(k: string): Promise<number>;
  pexpire(k: string, ms: number): Promise<number>;
  pttl(k: string): Promise<number>;
  zadd(k: string, score: number, member: string): Promise<number>;
  zcount(k: string, min: string | number, max: string | number): Promise<number>;
  zremrangebyscore(k: string, min: string | number, max: string | number): Promise<number>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string): Promise<unknown>;
  on(event: string, fn: (...a: any[]) => void): unknown;
  duplicate(): RedisLike;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

const ROOM_TTL_S = 600;
const PRESENCE_TTL_S = 45;
const LOCK_MS = 3000;
const CHANNEL = 'tictactoe:rooms';
const IDX = 'rooms:idx';
// Deletes a key only if it still holds the value we put there (safe lock release and presence clearing).
const DEL_IF_EQUALS = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const logError = (e: Error) => console.error(JSON.stringify({ severity: 'error', msg: 'redis error', error: e.message }));

export async function createRedisRoomStore(url: string, injected?: RedisLike): Promise<RoomStore> {
  let redis: RedisLike;
  if (injected) redis = injected;
  else {
    const mod: any = await import('ioredis');
    const Redis = mod.Redis ?? mod.default?.Redis ?? mod.default;
    redis = new Redis(url, { maxRetriesPerRequest: 3 });
  }
  redis.on('error', logError);
  const sub = redis.duplicate();
  sub.on('error', logError);

  // Redis may still be starting, so retry for up to ~30 seconds.
  for (let attempt = 1; ; attempt++) {
    try { await redis.ping(); break; }
    catch (err) {
      if (attempt >= 20) throw err;
      console.log(JSON.stringify({ severity: 'info', msg: 'waiting for redis', attempt }));
      await sleep(1500);
    }
  }

  const rk = (code: string) => `room:${code}`;
  const pk = (code: string, token: string) => `pres:${code}:${token}`;
  const saveRoom = async (room: Room, nx: boolean): Promise<boolean> => {
    const args: (string | number)[] = [rk(room.code), JSON.stringify(room), 'EX', ROOM_TTL_S];
    if (nx) args.push('NX');
    if ((await redis.set(...args)) !== 'OK') return false;
    await redis.zadd(IDX, Date.now() + ROOM_TTL_S * 1000, room.code);
    return true;
  };

  return {
    create: (room) => saveRoom(room, true),
    async get(code) {
      const raw = await redis.get(rk(code));
      return raw ? (JSON.parse(raw) as Room) : null;
    },
    async update(code, fn) {
      const lockKey = `lock:${code}`;
      const owner = randomBytes(8).toString('hex');
      for (let i = 0; ; i++) {
        if ((await redis.set(lockKey, owner, 'PX', LOCK_MS, 'NX')) === 'OK') break;
        if (i >= 80) throw new Error('could not lock room');
        await sleep(25);
      }
      try {
        const raw = await redis.get(rk(code));
        if (!raw) return null;
        const room = JSON.parse(raw) as Room;
        const value = fn(room); // if this throws, nothing is saved
        room.version++;
        await saveRoom(room, false);
        return { value, room };
      } finally {
        await redis.eval(DEL_IF_EQUALS, 1, lockKey, owner);
      }
    },
    async count() {
      await redis.zremrangebyscore(IDX, '-inf', Date.now());
      return redis.zcount(IDX, '-inf', '+inf');
    },
    async setPresent(code, token, connId) { await redis.set(pk(code, token), connId, 'EX', PRESENCE_TTL_S); },
    async clearPresent(code, token, connId) { await redis.eval(DEL_IF_EQUALS, 1, pk(code, token), connId); },
    async present(code, tokens) {
      if (!tokens.length) return [];
      return (await redis.mget(...tokens.map((t) => pk(code, t)))).map((v) => v !== null);
    },
    async touch(code) {
      await redis.expire(rk(code), ROOM_TTL_S);
      await redis.zadd(IDX, Date.now() + ROOM_TTL_S * 1000, code);
    },
    async publish(code, view) { await redis.publish(CHANNEL, JSON.stringify({ code, view })); },
    async subscribe(handler) {
      sub.on('message', (channel: string, message: string) => {
        if (channel !== CHANNEL) return;
        try { const m = JSON.parse(message) as { code: string; view: RoomView }; handler(m.code, m.view); } catch { /* ignore bad message */ }
      });
      await sub.subscribe(CHANNEL);
    },
    async take(key, max, windowMs) {
      const k = `rl:${key}`;
      const n = await redis.incr(k);
      if (n === 1) await redis.pexpire(k, windowMs);
      if (n <= max) return 0;
      const ttl = await redis.pttl(k);
      if (ttl < 0) await redis.pexpire(k, windowMs); // never leave a counter without an expiry
      return Math.max(1, Math.ceil((ttl > 0 ? ttl : windowMs) / 1000));
    },
    async ping() { await redis.ping(); },
    async close() { await Promise.allSettled([redis.quit(), sub.quit()]); },
  };
}
