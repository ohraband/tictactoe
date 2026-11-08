// Where room state lives. The default keeps it in this process; redis.ts shares it between servers.
import type { GameState, Mark } from '../shared/game.ts';
import type { Reaction, RoomView } from '../shared/protocol.ts';

export interface Seat {
  token: string; mark: Mark; visitor: string; name: string; playerId: string | null;
  wins: number; rematch: boolean; lastReact: number;
}
export interface Room {
  code: string; state: GameState; seats: Seat[]; draws: number;
  forfeit: Mark | null; reaction: Reaction | null; reactionSeq: number; version: number;
}

export interface RoomStore {
  /** Saves a new room. Returns false if the code is already taken. */
  create(room: Room): Promise<boolean>;
  get(code: string): Promise<Room | null>;
  /** Atomic read-modify-write. If `fn` throws, nothing is saved. Returns null if the room does not exist. */
  update<T>(code: string, fn: (room: Room) => T): Promise<{ value: T; room: Room } | null>;
  /** Number of live rooms (across all servers when shared). */
  count(): Promise<number>;
  /** Marks a seat as connected. The connection id lets a newer connection replace an older one. */
  setPresent(code: string, token: string, connId: string): Promise<void>;
  clearPresent(code: string, token: string, connId: string): Promise<void>;
  present(code: string, tokens: string[]): Promise<boolean[]>;
  /** Keeps a room alive while someone is connected. */
  touch(code: string): Promise<void>;
  /** Sends a room update to every server (including this one). */
  publish(code: string, view: RoomView): Promise<void>;
  subscribe(handler: (code: string, view: RoomView) => void): Promise<void>;
  /** Fixed-window rate limit. Returns 0 if allowed, otherwise seconds to wait. */
  take(key: string, max: number, windowMs: number): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export const IDLE_MS = 10 * 60 * 1000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function createMemoryRoomStore(): RoomStore {
  const rooms = new Map<string, { room: Room; touched: number }>();
  const presence = new Map<string, string>();
  const handlers = new Set<(code: string, view: RoomView) => void>();
  const hits = new Map<string, { n: number; reset: number }>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.reset <= now) hits.delete(k);
    for (const [code, e] of rooms) {
      const occupied = [...presence.keys()].some((k) => k.startsWith(code + ':'));
      if (now - e.touched > IDLE_MS && !occupied) rooms.delete(code);
    }
  }, 60000);
  sweep.unref();

  return {
    async create(room) {
      if (rooms.has(room.code)) return false;
      rooms.set(room.code, { room: clone(room), touched: Date.now() });
      return true;
    },
    async get(code) { const e = rooms.get(code); return e ? clone(e.room) : null; },
    async update(code, fn) {
      const e = rooms.get(code);
      if (!e) return null;
      const copy = clone(e.room); // work on a copy so a thrown error leaves the room untouched
      const value = fn(copy);
      copy.version++;
      e.room = copy;
      e.touched = Date.now();
      return { value, room: clone(copy) };
    },
    async count() { return rooms.size; },
    async setPresent(code, token, connId) { presence.set(`${code}:${token}`, connId); },
    async clearPresent(code, token, connId) { if (presence.get(`${code}:${token}`) === connId) presence.delete(`${code}:${token}`); },
    async present(code, tokens) { return tokens.map((t) => presence.has(`${code}:${t}`)); },
    async touch(code) { const e = rooms.get(code); if (e) e.touched = Date.now(); },
    async publish(code, view) { for (const h of handlers) void Promise.resolve().then(() => h(code, view)); },
    async subscribe(handler) { handlers.add(handler); },
    async take(key, max, windowMs) {
      const now = Date.now();
      const e = hits.get(key);
      if (!e || e.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return 0; }
      if (e.n >= max) return Math.ceil((e.reset - now) / 1000);
      e.n++;
      return 0;
    },
    async ping() {},
    async close() { clearInterval(sweep); handlers.clear(); },
  };
}
