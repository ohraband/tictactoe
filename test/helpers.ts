import { createApp } from '../server/server.ts';
import type { AppOptions } from '../server/server.ts';
import type { RoomView } from '../shared/protocol.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function within<T>(p: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('timed out')), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer); }
}

export async function start(opts: AppOptions = {}) {
  const app = createApp({ log: () => {}, ...opts });
  await app.ready;
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = async (p: string, body: unknown = {}) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  return { app, base, post, stop: () => app.shutdown() };
}

export interface Stream { status: number; next(): Promise<RoomView | null>; close(): void }

// Opens the live event stream for one seat and lets tests read events one at a time.
export async function sse(base: string, code: string, token: string): Promise<Stream> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/rooms/${code}/events?token=${token}`, { signal: ac.signal });
  if (res.status !== 200 || !res.body) return { status: res.status, next: async () => null, close: () => ac.abort() };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return {
    status: 200,
    close: () => ac.abort(),
    async next() {
      for (;;) {
        const i = buf.indexOf('\n\n');
        if (i >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6)) as RoomView;
          continue;
        }
        try {
          const { value, done } = await reader.read();
          if (done) return null;
          buf += dec.decode(value);
        } catch { return null; }
      }
    },
  };
}

// Reads events until one matches. Fails if the stream ends or nothing matches in time.
export async function until(s: Stream, pred: (v: RoomView) => boolean, ms = 3000): Promise<RoomView> {
  return within((async () => {
    for (;;) {
      const v = await s.next();
      if (!v) throw new Error('stream ended');
      if (pred(v)) return v;
    }
  })(), ms);
}

// A room with two players, both connected.
export async function twoPlayerRoom(t: Awaited<ReturnType<typeof start>>) {
  const a = (await t.post('/api/rooms')).body;
  const b = (await t.post(`/api/rooms/${a.code}/join`)).body;
  const ea = await sse(t.base, a.code, a.token);
  const eb = await sse(t.base, a.code, b.token);
  await until(ea, (v) => v.connected[0] && v.connected[1]);
  await until(eb, (v) => v.connected[0] && v.connected[1]);
  return { a, b, ea, eb, code: a.code as string };
}
