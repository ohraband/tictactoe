// Tic Tac Toe server: static files, room API, Server-Sent Events, optional Postgres and Redis.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createState, applyMove, isVariant, VARIANTS } from '../shared/game.ts';
import type { Mark } from '../shared/game.ts';
import { REACTIONS } from '../shared/protocol.ts';
import type { RoomView, SeatInfo } from '../shared/protocol.ts';
import { createStore } from './db.ts';
import type { Store } from './db.ts';
import { createMemoryRoomStore } from './rooms.ts';
import type { Room, RoomStore, Seat } from './rooms.ts';
import { createRedisRoomStore } from './redis.ts';
import { createMetrics } from './metrics.ts';
import { ROOT } from './root.ts';

const gz = promisify(gzip);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const MAX_ROOMS = 1000;
const REACT_COOLDOWN_MS = 800;
const ACTIONS = new Set(['join', 'move', 'rematch', 'react']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const CLIENT_EVENTS = new Set(['page_view', 'game_start', 'game_end']);
const VISITOR_ID = /^[\w-]{8,64}$/;
const REACTION_IDS = new Set<string>(REACTIONS.map((r) => r.id));

type Body = Record<string, unknown>;
type Limit = [max: number, windowMs: number];
export interface Limits { global: Limit; create: Limit; register: Limit }
export interface AppOptions {
  store?: Store | null;       // Postgres (nicknames, history), optional
  roomStore?: RoomStore;      // where rooms live: in memory (default) or Redis
  graceMs?: number;           // how long a disconnected player keeps their seat before forfeiting
  limits?: Partial<Limits>;
  trustProxy?: boolean;       // read the client IP from X-Forwarded-For (only behind a proxy you control)
  log?: (line: Record<string, unknown>) => void;
}

interface Asset { mtime: number; type: string; body: Uint8Array; gz: Uint8Array; etag: string }
interface Conn { id: string; res: ServerResponse }

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const cleanName = (n: unknown): string =>
  (typeof n === 'string' ? n.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 16) : '') || 'Player';

// A short, low-cardinality name for a request, used as a metrics label.
function routeOf(p: string): string {
  if (!p.startsWith('/api/')) return 'static';
  if (p === '/api/rooms') return 'room_create';
  const m = p.match(/^\/api\/rooms\/[^/]+\/(\w+)$/);
  if (m) return m[1] === 'events' || ACTIONS.has(m[1]) ? `room_${m[1]}` : 'room_other';
  if (/^\/api\/players\/[^/]+\/history$/.test(p)) return 'player_history';
  if (['/api/health', '/api/ready', '/api/track', '/api/leaderboard', '/api/players'].includes(p)) return p.slice(5);
  return 'api_other';
}

export function createApp(opts: AppOptions = {}) {
  const { store = null, graceMs = 60_000, trustProxy = false } = opts;
  const roomStore = opts.roomStore ?? createMemoryRoomStore();
  const limits: Limits = { global: [240, 60_000], create: [20, 60_000], register: [10, 60_000], ...opts.limits };
  const log = opts.log ?? ((line: Record<string, unknown>) => console.log(JSON.stringify(line)));
  const conns = new Map<string, Map<string, Conn>>(); // live streams on THIS server: room code -> seat token -> stream
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pending = new Set<Promise<void>>(); // background work that must finish before shutdown
  const assets = new Map<string, Asset>();
  let shuttingDown = false;

  // ---- metrics ----
  const metrics = createMetrics();
  const requests = metrics.counter('tictactoe_http_requests_total', 'HTTP requests by route, method, and status.');
  const duration = metrics.histogram('tictactoe_http_request_duration_seconds', 'HTTP request duration (live streams excluded).', [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]);
  const roomsCreated = metrics.counter('tictactoe_rooms_created_total', 'Online rooms created.');
  const gamesFinished = metrics.counter('tictactoe_games_finished_total', 'Finished online games by outcome.');
  const reactionsSent = metrics.counter('tictactoe_reactions_total', 'Emoji reactions sent.');
  const rateLimited = metrics.counter('tictactoe_rate_limited_total', 'Requests rejected by rate limiting.');
  const saveErrors = metrics.counter('tictactoe_db_save_errors_total', 'Finished games that could not be saved.');
  const clientEvents = metrics.counter('tictactoe_client_events_total', 'Events reported by the browser (computer and same-device games).');
  metrics.gauge('tictactoe_rooms_active', 'Live online rooms (across all servers when Redis is used).', () => roomStore.count());
  metrics.gauge('tictactoe_sse_connections', 'Live event streams on this server.', () => [...conns.values()].reduce((n, m) => n + m.size, 0));
  metrics.gauge('process_resident_memory_bytes', 'Resident memory size.', () => process.memoryUsage().rss);
  metrics.gauge('process_cpu_seconds_total', 'CPU time used by the process.', () => { const c = process.cpuUsage(); return (c.user + c.system) / 1e6; }, 'counter');
  metrics.gauge('process_uptime_seconds', 'Seconds since the process started.', () => process.uptime());

  const track = (name: string, visitor: string, props: Record<string, unknown> = {}) =>
    log({ ts: new Date().toISOString(), severity: 'info', event: name, visitor, ...props });
  const logError = (msg: string, e: unknown) =>
    log({ ts: new Date().toISOString(), severity: 'error', msg, error: e instanceof Error ? e.message : String(e) });
  const background = (work: Promise<unknown>, what: string) => {
    const p: Promise<void> = work.then(() => {}, (e) => logError(what, e)).finally(() => { pending.delete(p); });
    pending.add(p);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, error: string) => json(res, status, { error });
  const visitorOf = (req: IncomingMessage): string => {
    const v = req.headers['x-visitor'];
    return typeof v === 'string' && VISITOR_ID.test(v) ? v : 'anon';
  };
  const clientIp = (req: IncomingMessage): string => {
    if (trustProxy) {
      const f = req.headers['x-forwarded-for'];
      const first = (Array.isArray(f) ? f[0] : f)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };
  const limited = async (req: IncomingMessage, res: ServerResponse, scope: string, [max, windowMs]: Limit): Promise<boolean> => {
    const wait = await roomStore.take(`${scope}:${clientIp(req)}`, max, windowMs);
    if (!wait) return false;
    rateLimited.inc({ scope });
    res.setHeader('retry-after', String(wait));
    fail(res, 429, 'Too many requests. Slow down and try again shortly.');
    return true;
  };

  const newCode = (): string => Array.from(randomBytes(4), (b) => ALPHA[b % ALPHA.length]).join('');
  const auth = (r: Room, token: unknown): Seat | undefined =>
    typeof token === 'string' ? r.seats.find((s) => s.token === token) : undefined;
  const addSeat = (r: Room, mark: Mark, visitor: string, name: string, playerId: string | null): Seat => {
    const seat: Seat = { token: randomBytes(16).toString('hex'), mark, visitor, name, playerId, wins: 0, rematch: false, lastReact: 0 };
    r.seats.push(seat);
    return seat;
  };
  const seatInfo = (r: Room, seat: Seat): SeatInfo => ({ code: r.code, token: seat.token, seat: r.seats.indexOf(seat), mark: seat.mark });

  const toView = (r: Room, connected: boolean[]): RoomView => {
    const x = r.seats.find((s) => s.mark === 'X'), o = r.seats.find((s) => s.mark === 'O');
    return {
      code: r.code, board: r.state.board, turn: r.state.turn, winner: r.state.winner, line: r.state.line, draw: r.state.draw,
      status: r.seats.length < 2 ? 'waiting' : r.state.winner || r.state.draw ? 'over' : 'playing',
      marks: r.seats.map((s) => s.mark), names: r.seats.map((s) => ({ mark: s.mark, name: s.name })),
      connected, scores: { X: x?.wins ?? 0, O: o?.wins ?? 0 }, draws: r.draws,
      rematch: r.seats.filter((s) => s.rematch).map((s) => s.mark), forfeit: r.forfeit, reaction: r.reaction, version: r.version,
      variant: r.state.variant, last: r.state.last,
    };
  };

  // Sends the latest room state to everyone in the room, on every server.
  const broadcast = async (code: string) => {
    const room = await roomStore.get(code);
    if (!room) return;
    const connected = await roomStore.present(code, room.seats.map((s) => s.token));
    await roomStore.publish(code, toView(room, connected));
  };
  // Runs on every server for every published update; writes to this server's own live streams.
  const deliver = (code: string, view: RoomView) => {
    const m = conns.get(code);
    if (!m) return;
    const d = `data: ${JSON.stringify(view)}\n\n`;
    for (const c of m.values()) c.res.write(d);
  };
  const ready = roomStore.subscribe(deliver);

  // Called once when a game finishes, whether by a move or a forfeit.
  const endGame = (r: Room) => {
    const moves = r.state.board.filter(Boolean).length;
    gamesFinished.inc({ result: r.forfeit ? 'forfeit' : r.state.draw ? 'draw' : 'win', variant: r.state.variant });
    if (store) {
      const x = r.seats.find((s) => s.mark === 'X'), o = r.seats.find((s) => s.mark === 'O');
      background(
        store.saveGame({ code: r.code, xId: x?.playerId ?? null, oId: o?.playerId ?? null, xName: x?.name ?? 'Player', oName: o?.name ?? 'Player', winner: r.state.winner, draw: r.state.draw, moves, variant: r.state.variant })
          .catch((e) => { saveErrors.inc(); throw e; }),
        'could not save game');
    }
    for (const s of r.seats) {
      const result = r.state.draw ? 'draw' : s.mark === r.state.winner ? 'win' : 'loss';
      track('game_end', s.visitor, { mode: 'online', variant: r.state.variant, seat: s.mark, result, moves, code: r.code, ...(r.forfeit ? { forfeit: true } : {}) });
    }
  };

  // Runs after the grace period. Checks presence again, because the player may have reconnected to any server.
  const forfeitIfGone = async (code: string, token: string) => {
    const [here] = await roomStore.present(code, [token]);
    if (here) return;
    const out = await roomStore.update(code, (room) => {
      const quitter = room.seats.find((s) => s.token === token);
      if (!quitter || room.seats.length < 2 || room.state.winner || room.state.draw) return false;
      const winner = room.seats.find((s) => s !== quitter)!;
      room.state = { ...room.state, winner: winner.mark, line: null };
      room.forfeit = quitter.mark;
      winner.wins++;
      return true;
    });
    if (out?.value) { endGame(out.room); await broadcast(code); }
  };

  const readBody = (req: IncomingMessage): Promise<Body> => new Promise((ok, no) => {
    let b = '';
    req.on('data', (c: unknown) => {
      b += String(c);
      if (b.length > 1024) { no(new HttpError(413, 'Request too large.')); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const v: unknown = b ? JSON.parse(b) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) ok(v as Body);
        else no(new HttpError(400, 'Invalid request.'));
      } catch { no(new HttpError(400, 'Invalid request.')); }
    });
    req.on('error', no);
  });

  // With a database, online play needs a registered guest nickname; without one, a free-text name is used.
  const identify = async (b: Body): Promise<{ name: string; playerId: string | null } | null> => {
    if (!store) return { name: cleanName(b.name), playerId: null };
    const pl = typeof b.secret === 'string' ? await store.playerBySecret(b.secret) : null;
    return pl ? { name: pl.name, playerId: pl.id } : null;
  };

  async function openStream(req: IncomingMessage, res: ServerResponse, code: string, seat: Seat) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const connId = randomBytes(6).toString('hex');
    let m = conns.get(code);
    if (!m) { m = new Map(); conns.set(code, m); }
    m.get(seat.token)?.res.end(); // a refresh replaces the old stream
    m.set(seat.token, { id: connId, res });
    res.write(': ok\n\n');
    await roomStore.setPresent(code, seat.token, connId);
    const ping = setInterval(() => {
      res.write(': ping\n\n');
      background(roomStore.setPresent(code, seat.token, connId).then(() => roomStore.touch(code)), 'heartbeat failed');
    }, 20000);

    const onClose = async () => {
      clearInterval(ping);
      const mine = conns.get(code);
      if (mine?.get(seat.token)?.id !== connId) return; // already replaced by a newer stream
      mine.delete(seat.token);
      if (!mine.size) conns.delete(code);
      await roomStore.clearPresent(code, seat.token, connId);
      track('disconnect', seat.visitor, { mode: 'online', code });
      const r = await roomStore.get(code);
      if (r && r.seats.length === 2 && !r.state.winner && !r.state.draw && !shuttingDown) {
        const t = setTimeout(() => { timers.delete(t); background(forfeitIfGone(code, seat.token), 'forfeit failed'); }, graceMs);
        t.unref();
        timers.add(t);
      }
      await broadcast(code);
    };
    req.on('close', () => background(onClose(), 'disconnect handling failed'));
    await broadcast(code);
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, p: string): Promise<void> {
    const v = visitorOf(req);
    const parts = p.split('/').filter(Boolean); // ['api','rooms',CODE,action]
    if (parts.length === 2) {
      if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
      if (await limited(req, res, 'create', limits.create)) return;
      if ((await roomStore.count()) >= MAX_ROOMS) return fail(res, 503, 'Server is full. Try again later.');
      const body = await readBody(req).catch(() => ({}) as Body);
      const who = await identify(body);
      if (!who) return fail(res, 401, 'Pick a nickname first.');
      const variant = body.variant === undefined ? 'classic' : body.variant;
      if (!isVariant(variant)) return fail(res, 400, 'Unknown board type.');
      for (let tries = 0; tries < 5; tries++) {
        const r: Room = { code: newCode(), state: createState(variant), seats: [], draws: 0, forfeit: null, reaction: null, reactionSeq: 0, version: 0 };
        const seat = addSeat(r, 'X', v, who.name, who.playerId);
        if (!(await roomStore.create(r))) continue; // code already in use, try another
        roomsCreated.inc();
        track('room_create', v, { mode: 'online', variant, code: r.code });
        return json(res, 201, seatInfo(r, seat));
      }
      return fail(res, 503, 'Could not create a room. Try again.');
    }
    const code = (parts[2] ?? '').toUpperCase();
    const room = await roomStore.get(code);
    if (!room) return fail(res, 404, 'Room not found. Check the code.');
    const action = parts[3] ?? '';

    if (action === 'events' && req.method === 'GET') {
      const seat = auth(room, url.searchParams.get('token'));
      if (!seat) return fail(res, 403, 'You are not in this room.');
      return openStream(req, res, code, seat);
    }
    if (req.method !== 'POST') return fail(res, 405, 'Method not allowed.');
    if (!ACTIONS.has(action)) return fail(res, 404, 'Not found.');
    const b = await readBody(req);
    const gone = () => fail(res, 404, 'Room not found. Check the code.');
    // Every change below runs inside roomStore.update, which is atomic even with several servers.
    const mustBeSeated = (r: Room): Seat => {
      const s = auth(r, b.token);
      if (!s) throw new HttpError(403, 'You are not in this room.');
      return s;
    };

    if (action === 'join') {
      const existing = auth(room, b.token);
      if (existing) return json(res, 200, seatInfo(room, existing));
      if (room.seats.length >= 2) return fail(res, 409, 'This room is full.');
      const who = await identify(b);
      if (!who) return fail(res, 401, 'Pick a nickname first.');
      const out = await roomStore.update(code, (r) => {
        const again = auth(r, b.token);
        if (again) return seatInfo(r, again);
        if (r.seats.length >= 2) throw new HttpError(409, 'This room is full.');
        if (who.playerId && r.seats.some((s) => s.playerId === who.playerId)) throw new HttpError(409, 'You are already in this room.');
        return seatInfo(r, addSeat(r, 'O', v, who.name, who.playerId));
      });
      if (!out) return gone();
      track('room_join', v, { mode: 'online', code });
      await broadcast(code);
      return json(res, 200, out.value);
    }

    if (action === 'move') {
      const out = await roomStore.update(code, (r) => {
        const s = mustBeSeated(r);
        if (r.seats.length < 2) throw new HttpError(409, 'Waiting for an opponent.');
        if (s.mark !== r.state.turn) throw new HttpError(409, "It's not your turn.");
        const next = applyMove(r.state, b.index);
        if (!next) throw new HttpError(409, 'That move is not allowed.');
        r.state = next;
        if (next.winner) s.wins++; else if (next.draw) r.draws++;
        return !!(next.winner || next.draw);
      });
      if (!out) return gone();
      if (out.value) endGame(out.room);
      await broadcast(code);
      return json(res, 200, { ok: true });
    }

    if (action === 'rematch') {
      const out = await roomStore.update(code, (r) => {
        const s = mustBeSeated(r);
        if (!(r.state.winner || r.state.draw)) throw new HttpError(409, 'The game is not over yet.');
        s.rematch = true;
        if (r.seats.length === 2 && r.seats.every((x) => x.rematch)) {
          r.seats.forEach((x) => { x.mark = x.mark === 'X' ? 'O' : 'X'; x.rematch = false; });
          r.state = createState(r.state.variant); // a rematch keeps the board type
          r.forfeit = null;
          return true;
        }
        return false;
      });
      if (!out) return gone();
      if (out.value) out.room.seats.forEach((s) => track('rematch', s.visitor, { mode: 'online', code }));
      await broadcast(code);
      return json(res, 200, { ok: true });
    }

    // react
    const id = b.id;
    if (typeof id !== 'string' || !REACTION_IDS.has(id)) return fail(res, 400, 'Unknown reaction.');
    const out = await roomStore.update(code, (r) => {
      const s = mustBeSeated(r);
      if (r.seats.length < 2) throw new HttpError(409, 'Waiting for an opponent.');
      const now = Date.now();
      if (now - s.lastReact < REACT_COOLDOWN_MS) throw new HttpError(429, 'Slow down a little.');
      s.lastReact = now;
      r.reaction = { seq: ++r.reactionSeq, mark: s.mark, id };
      return s.visitor;
    });
    if (!out) return gone();
    reactionsSent.inc();
    track('reaction', out.value, { mode: 'online', code, reaction: id });
    await broadcast(code);
    return json(res, 200, { ok: true });
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, p: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');
    let file: string;
    if (p === '/' || /^\/room\/[A-Za-z0-9]{4}$/.test(p)) file = 'client/index.html';
    else if (/^\/client\/[\w.-]+$/.test(p)) file = p.slice(1);
    else if (/^\/shared\/[\w-]+\.js$/.test(p)) file = 'dist' + p; // compiled by `npm run build`
    else return fail(res, 404, 'Not found.');
    const abs = path.join(ROOT, file);
    const st = await stat(abs).catch(() => null);
    if (!st) return fail(res, 404, 'Not found.');
    let a = assets.get(file);
    if (!a || a.mtime !== st.mtimeMs) {
      const body = await readFile(abs);
      a = {
        mtime: st.mtimeMs, body, gz: await gz(body),
        type: TYPES[path.extname(file)] ?? 'application/octet-stream',
        etag: `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      };
      assets.set(file, a);
    }
    const headers = { 'content-type': a.type, etag: a.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' };
    if (req.headers['if-none-match'] === a.etag) { res.writeHead(304, headers); res.end(); return; }
    const useGz = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    res.writeHead(200, useGz ? { ...headers, 'content-encoding': 'gzip' } : headers);
    res.end(req.method === 'HEAD' ? undefined : useGz ? a.gz : a.body);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('content-security-policy', CSP);
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const route = routeOf(p);
    const started = Date.now();
    res.on('close', () => {
      requests.inc({ route, method: req.method ?? 'GET', status: String(res.statusCode) });
      if (route !== 'room_events') duration.observe({ route }, (Date.now() - started) / 1000);
    });
    try {
      // Liveness: the process is up. Readiness: it can serve traffic (database and Redis reachable, not shutting down).
      if (p === '/api/health') return json(res, 200, { ok: true, database: !!store });
      if (p === '/api/ready') {
        if (shuttingDown) return json(res, 503, { ready: false, reason: 'shutting down' });
        try { await store?.ping(); } catch { return json(res, 503, { ready: false, reason: 'database unavailable' }); }
        try { await roomStore.ping(); } catch { return json(res, 503, { ready: false, reason: 'room store unavailable' }); }
        return json(res, 200, { ready: true });
      }
      if (p.startsWith('/api/') && (await limited(req, res, 'all', limits.global))) return;

      if (p === '/api/leaderboard') return json(res, 200, store ? await store.leaderboard() : []);
      if (store && p === '/api/players' && req.method === 'POST') {
        if (await limited(req, res, 'register', limits.register)) return;
        const name = cleanName((await readBody(req)).name);
        if (name.length < 2 || name.toLowerCase() === 'player') return fail(res, 400, 'Nicknames need 2 to 16 letters or numbers.');
        const pl = await store.registerPlayer(name);
        return pl ? json(res, 201, pl) : fail(res, 409, 'That nickname is taken. Try another.');
      }
      const hm = p.match(/^\/api\/players\/([^/]+)\/history$/);
      if (store && hm) return json(res, 200, await store.history(decodeURIComponent(hm[1])));
      if (p === '/api/track' && req.method === 'POST') {
        const b = await readBody(req);
        if (typeof b.name !== 'string' || !CLIENT_EVENTS.has(b.name)) return fail(res, 400, 'Unknown event.');
        const props = (b.props && typeof b.props === 'object' ? b.props : {}) as Body;
        const clean: Record<string, unknown> = {};
        const pick = (key: string, allowed: string[]) => { const val = props[key]; if (typeof val === 'string' && allowed.includes(val)) clean[key] = val; };
        pick('mode', ['ai', 'local']); pick('level', ['easy', 'medium', 'hard']);
        pick('result', ['X', 'O', 'draw', 'win', 'loss']); pick('side', ['X', 'O']); pick('variant', Object.keys(VARIANTS));
        const m = props.moves;
        if (typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= 9) clean.moves = m;
        clientEvents.inc({ event: b.name, mode: String(clean.mode ?? 'unknown') });
        track(b.name, visitorOf(req), clean);
        return json(res, 200, { ok: true });
      }
      if (p.startsWith('/api/rooms')) return await api(req, res, url, p);
      return await serveStatic(req, res, p);
    } catch (e) {
      if (e instanceof HttpError) { if (!res.headersSent) fail(res, e.status, e.message); else res.end(); return; }
      logError(`request failed: ${p}`, e);
      if (!res.headersSent) fail(res, 500, 'Something went wrong. Try again.'); else res.end();
    }
  });

  // Stop accepting connections, end live streams, and wait for background work (saves, disconnect handling).
  async function shutdown(): Promise<void> {
    shuttingDown = true;
    for (const t of timers) clearTimeout(t);
    for (const m of conns.values()) for (const c of m.values()) c.res.end();
    const closed = new Promise<void>((ok) => server.close(() => ok()));
    server.closeIdleConnections();
    setTimeout(() => server.closeAllConnections(), 2000).unref();
    await closed;
    await Promise.allSettled([...pending]);
    await roomStore.close();
  }

  return { server, shutdown, ready, roomStore, renderMetrics: metrics.render };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  const metricsPort = Number(process.env.METRICS_PORT ?? 9100); // 0 turns the metrics server off
  const store = await createStore(process.env.DATABASE_URL);
  const roomStore = process.env.REDIS_URL ? await createRedisRoomStore(process.env.REDIS_URL) : createMemoryRoomStore();
  const app = createApp({ store, roomStore, trustProxy: process.env.TRUST_PROXY === '1' });
  await app.ready;
  app.server.listen(port, () => console.log(JSON.stringify({
    severity: 'info', msg: `Tic Tac Toe running at http://localhost:${port}`, database: !!store, rooms: process.env.REDIS_URL ? 'redis' : 'memory',
  })));

  // Metrics are served on their own port, which is not published outside Docker.
  const metricsServer = metricsPort > 0 ? http.createServer(async (req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(await app.renderMetrics());
  }) : null;
  metricsServer?.listen(metricsPort);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ severity: 'info', msg: 'shutting down', signal }));
    setTimeout(() => process.exit(1), 10000).unref(); // never hang forever
    metricsServer?.close();
    await app.shutdown();
    await store?.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
