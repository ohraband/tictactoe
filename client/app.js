import { createState, applyMove, VARIANTS, VARIANT_LIST } from '/shared/game.js';
import { createCube } from '/client/cube.js';
import { chooseMove } from '/shared/ai.js';
import { REACTIONS } from '/shared/protocol.js';

const app = document.getElementById('app');
const VISITOR = (() => {
  try {
    let v = localStorage.getItem('ttt:visitor');
    if (!v) { v = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('ttt:visitor', v); }
    return v;
  } catch { return 'anon'; }
})();
const track = (name, props = {}) => fetch('/api/track', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json', 'x-visitor': VISITOR }, body: JSON.stringify({ name, props }) }).catch(() => {});
const other = (m) => (m === 'X' ? 'O' : 'X');
const empty = () => [];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const SVG = {
  X: '<svg viewBox="0 0 40 40" aria-hidden="true"><path pathLength="1" d="M9 9L31 31M31 9L9 31"/></svg>',
  O: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle pathLength="1" cx="20" cy="20" r="12"/></svg>',
};

let g = { screen: 'menu' };
let prev = empty();
let gameId = 0;
let level = 'medium';
let side = 'X';
let variant = (() => { try { const v = localStorage.getItem('ttt:variant'); return VARIANTS[v] ? v : 'classic'; } catch { return 'classic'; } })();
let cube = null; // the 3D view is created on first use and reused between screens
const getCube = () => cube || (cube = createCube({ onPick: (peg) => play(peg) }));

const st = () => (g.mode === 'online' ? g.view : g.s);
const me = () => (g.mode === 'online' ? g.view.marks[g.seat] : g.you);
const who = (m) => (g.mode === 'local' ? m : m === me() ? 'You' : g.mode === 'ai' ? 'Computer' : 'Opponent');

async function post(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-visitor': VISITOR }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong. Try again.'), { status: r.status });
  return d;
}

const nick = () => {
  let v = document.getElementById('nick')?.value;
  if (v === undefined) { try { v = localStorage.getItem('ttt:nick'); } catch { v = null; } }
  v = (v || 'Player').trim().slice(0, 16) || 'Player';
  try { localStorage.setItem('ttt:nick', v); } catch { /* storage unavailable */ }
  return v;
};

let dbOn = false;
let pending = null;
const getPlayer = () => { try { return JSON.parse(localStorage.getItem('ttt:player')); } catch { return null; } };
const savePlayer = (p) => { try { localStorage.setItem('ttt:player', JSON.stringify(p)); } catch { /* storage unavailable */ } };
const clearPlayer = () => { try { localStorage.removeItem('ttt:player'); } catch { /* storage unavailable */ } };
async function loadHealth() { try { dbOn = !!(await (await fetch('/api/health')).json()).database; } catch { dbOn = false; } }

const reactionBar = () => `<div class="reactions" role="group" aria-label="Send a reaction">${REACTIONS.map((r) => `<button class="react" data-a="react" data-v="${r.id}" aria-label="${r.label}">${r.emoji}</button>`).join('')}</div>`;
const toastHTML = () => `<div class="toastbox">${g.toast ? `<p class="toast ${g.toast.mine ? 'mine' : 'theirs'}" aria-hidden="true">${esc(g.toast.text)}</p>` : ''}</div>`;

function showReaction(v) {
  const r = REACTIONS.find((x) => x.id === v.reaction.id);
  const name = v.names.find((n) => n.mark === v.reaction.mark)?.name || 'Opponent';
  const mine = v.reaction.mark === v.marks[g.seat];
  if (!r) return;
  g.toast = { text: mine ? `You ${r.emoji}` : `${name} ${r.emoji}`, mine };
  const live = document.getElementById('live');
  if (live) live.textContent = mine ? `You sent ${r.label}` : `${name} sent ${r.label}`;
  clearTimeout(g.toastTimer);
  g.toastTimer = setTimeout(() => { if (g.toast) { g.toast = null; render(); } }, 2500);
}

const profileHTML = () => {
  if (!dbOn) return `<input id="nick" class="nick" maxlength="16" placeholder="Your nickname" value="${esc(nick())}" aria-label="Your nickname">`;
  const p = getPlayer();
  if (p) return `<p>Playing as <b>${esc(p.name)}</b></p><div class="row"><button class="btn" data-a="history">My match history</button><button class="btn" data-a="switchNick">Switch nickname</button></div>`;
  return `<div class="stack"><label for="nick">Pick a nickname to play online</label><div class="row"><input id="nick" class="nick" maxlength="16" placeholder="Your nickname" aria-label="Your nickname"><button class="btn primary" data-a="claim">Save nickname</button></div></div>`;
};

const historyView = () => `
  <h2>${esc(g.name)}</h2>
  ${g.rows?.length ? `<table class="scores"><tr><th>Result</th><th>Opponent</th><th>Board</th><th>Moves</th><th>Date</th></tr>${g.rows.map((r) => `<tr><td>${esc(r.result)}</td><td>${esc(r.opponent)}</td><td>${esc(VARIANTS[r.variant]?.name ?? r.variant ?? '')}</td><td>${r.moves}</td><td>${esc(new Date(r.created_at).toLocaleDateString())}</td></tr>`).join('')}</table>` : '<p class="muted">No matches recorded yet.</p>'}
  <div class="row"><button class="btn" data-a="board">Leaderboard</button><button class="btn" data-a="menu">Menu</button></div>`;

const boardView = () => `
  <h2>Leaderboard</h2>
  ${g.rows?.length ? `<table class="scores"><tr><th>Player</th><th>W</th><th>L</th><th>D</th></tr>${g.rows.map((r) => `<tr><td><button class="link" data-a="history" data-v="${esc(r.name)}">${esc(r.name)}</button></td><td>${r.wins}</td><td>${r.losses}</td><td>${r.draws}</td></tr>`).join('')}</table>` : '<p class="muted">No online games recorded yet.</p>'}
  <button class="btn" data-a="menu">Back</button>`;

/* ---------- views ---------- */
const menuView = () => `
  <h1>Tic Tac Toe</h1>
  <p class="muted">Pick how you want to play.</p>
  <div class="stack">
    <button class="btn primary" data-a="setup">Play the computer</button>
    <button class="btn" data-a="localSetup">Play on this device</button>
    <button class="btn" data-a="lobby">Play a friend online</button>
    <button class="btn" data-a="board">Leaderboard</button>
  </div>`;

const pressed = (cond) => `aria-pressed="${cond}"`;
const variantPicker = () => `<div class="stack" role="group" aria-label="Board type">${VARIANT_LIST.map((v) => `<button class="btn variant" data-a="variant" data-v="${v.id}" ${pressed(variant === v.id)}><b>${esc(v.name)}</b><span class="muted">${esc(v.blurb)}</span></button>`).join('')}</div>`;
const setupView = () => `
  <h2>Play the computer</h2>
  ${variantPicker()}
  <div class="stack" role="group" aria-label="Difficulty">
    ${['easy', 'medium', 'hard'].map((l) => `<button class="btn" data-a="level" data-v="${l}" ${pressed(level === l)}>${l[0].toUpperCase() + l.slice(1)}</button>`).join('')}
  </div>
  <div class="row" role="group" aria-label="Your side">
    <button class="btn" data-a="side" data-v="X" ${pressed(side === 'X')}>Play as X (moves first)</button>
    <button class="btn" data-a="side" data-v="O" ${pressed(side === 'O')}>Play as O</button>
  </div>
  <div class="row"><button class="btn primary" data-a="start">Start game</button><button class="btn" data-a="menu">Back</button></div>`;

const localSetupView = () => `
  <h2>Play on this device</h2>
  ${variantPicker()}
  <div class="row"><button class="btn primary" data-a="local">Start game</button><button class="btn" data-a="menu">Back</button></div>`;

const lobbyView = () => `
  <h2>Play a friend online</h2>
  ${profileHTML()}
  <h3 class="sub">Board for a new game</h3>
  ${variantPicker()}
  <button class="btn primary" data-a="create">Create a game</button>
  <div class="stack">
    <label for="code">Have a code? Enter it to join.</label>
    <div class="row"><input id="code" class="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="K7QD"><button class="btn" data-a="join">Join game</button></div>
  </div>
  ${g.err ? `<p class="error" role="alert">${esc(g.err)}</p>` : ''}
  <button class="btn" data-a="menu">Back</button>`;

const errorView = () => `<p class="error" role="alert">${esc(g.err || 'Something went wrong.')}</p><button class="btn primary" data-a="menu">Back to menu</button>`;

function canPlay(s) {
  if (s.winner || s.draw) return false;
  if (g.mode === 'local') return true;
  if (g.mode === 'ai') return s.turn === g.you;
  return s.status === 'playing' && s.turn === me() && !g.offline;
}

function statusText(s) {
  if (g.mode === 'online' && s.status === 'waiting') return 'Waiting for your friend to join';
  if (g.offline) return 'Connection lost. Reconnecting…';
  if (s.winner) { const w = who(s.winner) === 'You' ? 'You win!' : `${who(s.winner)} wins`; return s.forfeit ? `${w} (opponent left)` : w; }
  if (s.draw) return "It's a draw.";
  if (g.mode === 'online' && s.connected && !s.connected[s.marks.indexOf(other(me()))]) return 'Your opponent disconnected. They forfeit if they do not return soon.';
  if (g.mode === 'local') return `${s.turn}'s turn`;
  if (s.turn === me()) return 'Your turn';
  return g.mode === 'ai' ? 'Computer is thinking…' : "Opponent's turn";
}

function boardHTML(s, blocked) {
  const v = VARIANTS[s.variant] || VARIANTS.classic;
  if (v.kind === 'cube') return cubeHTML(s, blocked);
  const n = v.size;
  const cells = s.board.map((m, i) => {
    const cls = ['cell', m ? m.toLowerCase() : '', m && prev[i] !== m ? 'new' : '', s.line?.includes(i) ? 'win' : '', s.last === i ? 'last' : ''].filter(Boolean).join(' ');
    return `<button class="${cls}" data-a="cell" data-i="${i}" aria-label="Row ${Math.floor(i / n) + 1}, column ${(i % n) + 1}, ${m || 'empty'}"${m || blocked ? ' aria-disabled="true"' : ''}>${m ? SVG[m] : ''}</button>`;
  }).join('');
  return `<div class="board n${n}" role="group" aria-label="Game board, ${esc(v.name)}">${cells}</div>`;
}

// The cube: a 3D picture (drawn by cube.js) plus one button per peg, which is how keyboards and screen readers play.
function cubeHTML(s, blocked) {
  const win = new Set(s.line || []);
  const pegs = Array.from({ length: 16 }, (_, p) => {
    const stack = [0, 1, 2, 3].map((layer) => s.board[layer * 16 + p]);
    const dots = [3, 2, 1, 0].map((layer) => `<i class="dot ${stack[layer] ? stack[layer].toLowerCase() : ''}${win.has(layer * 16 + p) ? ' win' : ''}">${stack[layer] || ''}</i>`).join('');
    return `<button class="peg" data-a="cell" data-i="${p}" aria-label="Peg row ${Math.floor(p / 4) + 1}, column ${(p % 4) + 1}, ${stack.filter(Boolean).length} of 4 filled"${stack.every(Boolean) || blocked ? ' aria-disabled="true"' : ''}>${dots}</button>`;
  }).join('');
  return `
    <div class="cubebox">
      <div id="cube-slot"></div>
      <div class="row cubebtns" role="group" aria-label="Turn the cube">
        <button class="btn" data-a="cam" data-v="left" aria-label="Turn left">⟲</button>
        <button class="btn" data-a="cam" data-v="right" aria-label="Turn right">⟳</button>
        <button class="btn" data-a="cam" data-v="top">Top view</button>
        <button class="btn" data-a="cam" data-v="reset">Reset</button>
      </div>
    </div>
    <p class="muted center">Pegs, seen from above. Pick a peg to drop a piece.</p>
    <div class="pegs" role="group" aria-label="Pegs">${pegs}</div>`;
}

function scoreHTML(s) {
  let items;
  if (g.mode === 'online') { const m = me(); items = [['You', s.scores[m]], ['Opponent', s.scores[other(m)]], ['Draws', s.draws]]; }
  else if (g.mode === 'ai') items = [['You', g.sc.you], ['Computer', g.sc.opp], ['Draws', g.sc.draws]];
  else items = [['X', g.sc.X], ['O', g.sc.O], ['Draws', g.sc.draws]];
  return `<p class="score">${items.map(([l, n]) => `<span>${l} <b>${n}</b></span>`).join('')}</p>`;
}

function rematchBtn(s) {
  if (g.mode !== 'online') return '<button class="btn primary" data-a="rematch">Play again</button>';
  const mine = s.rematch.includes(me());
  const label = mine ? 'Waiting for opponent…' : s.rematch.length ? 'Accept rematch' : 'Rematch';
  return `<button class="btn primary" data-a="rematch"${mine ? ' aria-disabled="true"' : ''}>${label}</button>`;
}

function gameView() {
  const s = st();
  if (!s) return '<p class="status" role="status">Connecting…</p>';
  const over = s.winner || s.draw;
  const waiting = g.mode === 'online' && s.status === 'waiting';
  return `
    <p class="status" role="status" aria-live="polite">${esc(statusText(s))}</p>
    ${waiting ? `<div class="waiting"><p>Send this link to a friend</p><code>${esc(g.code)}</code><button class="btn" data-a="copy">${g.copied ? 'Link copied' : 'Copy link'}</button></div>` : ''}
    ${g.mode === 'online' && g.view?.names ? `<p class="muted">${esc(g.view.names.find((n) => n.mark === 'X')?.name || 'X')} (X) vs ${esc(g.view.names.find((n) => n.mark === 'O')?.name || 'O')} (O)</p>` : ''}
    ${g.mode === 'online' ? toastHTML() : ''}
    <p class="muted center">${esc((VARIANTS[s.variant] || VARIANTS.classic).name)}</p>
    ${boardHTML(s, !canPlay(s))}
    ${scoreHTML(s)}
    ${g.mode === 'online' && s.status !== 'waiting' ? reactionBar() : ''}
    <div class="row">${over ? rematchBtn(s) : ''}<button class="btn" data-a="menu">${over ? 'Back to menu' : 'Leave game'}</button></div>`;
}

function render() {
  const views = { menu: menuView, setup: setupView, localSetup: localSetupView, lobby: lobbyView, game: gameView, error: errorView, board: boardView, history: historyView };
  const a = document.activeElement;
  let sel = null;
  if (a && a.dataset && app.contains(a)) {
    if (a.dataset.i !== undefined) sel = `[data-i="${a.dataset.i}"]`;
    else if (a.dataset.a) sel = `[data-a="${a.dataset.a}"]${a.dataset.v ? `[data-v="${a.dataset.v}"]` : ''}`;
  }
  app.innerHTML = views[g.screen]();
  const s = g.screen === 'game' ? st() : null;
  prev = s ? s.board.slice() : empty();
  const slot = document.getElementById('cube-slot');
  if (slot && s) {
    const c = getCube();
    slot.appendChild(c.canvas);
    c.set({ board: s.board, last: s.last ?? null, line: s.line, turn: s.turn, canPlay: canPlay(s) });
  }
  if (sel) app.querySelector(sel)?.focus();
}

/* ---------- game control ---------- */
function newGame() {
  gameId++;
  cube?.clear();
  g.s = createState(g.variant);
  render();
  aiTurn();
}

function aiTurn() {
  const id = gameId;
  if (g.mode !== 'ai' || g.s.winner || g.s.draw || g.s.turn === g.you) return;
  setTimeout(() => { if (id === gameId) place(chooseMove(g.s, g.level)); }, 450);
}

function place(i) {
  const n = applyMove(g.s, i);
  if (!n) return;
  g.s = n;
  if (n.winner) { if (g.mode === 'ai') g.sc[n.winner === g.you ? 'you' : 'opp']++; else g.sc[n.winner]++; }
  else if (n.draw) g.sc.draws++;
  if (n.winner || n.draw) {
    const result = n.draw ? 'draw' : g.mode === 'ai' ? (n.winner === g.you ? 'win' : 'loss') : n.winner;
    track('game_end', { mode: g.mode, level: g.level, variant: g.variant, result, moves: n.board.filter(Boolean).length });
  }
  render();
  aiTurn();
}

function play(i) {
  const s = st();
  if (!s || !canPlay(s)) return;
  if (g.mode === 'online') { post(`/api/rooms/${g.code}/move`, { token: g.token, index: i }).catch(() => {}); return; }
  place(i);
}

function leave() {
  g.es?.close();
  cube?.clear();
  gameId++;
  g = { screen: 'menu' };
  if (location.pathname !== '/') history.pushState(null, '', '/');
  render();
}

/* ---------- online ---------- */
function openRoom(seat) {
  g.es?.close();
  cube?.clear();
  store.set('ttt:' + seat.code, seat);
  g = { screen: 'game', mode: 'online', code: seat.code, seat: seat.seat, token: seat.token, view: null };
  history.pushState(null, '', '/room/' + seat.code);
  render();
  const es = new EventSource(`/api/rooms/${seat.code}/events?token=${seat.token}`);
  g.es = es;
  es.onmessage = (ev) => {
    const v = JSON.parse(ev.data);
    if (g.view && v.version < g.view.version) return; // ignore an update that arrived out of order
    // The first message only syncs state; later ones with a newer reaction show it.
    if (g.seenReaction !== undefined && v.reaction && v.reaction.seq > g.seenReaction) showReaction(v);
    g.seenReaction = v.reaction ? v.reaction.seq : 0;
    g.view = v;
    g.offline = false;
    render();
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) { g = { screen: 'error', err: 'This game is no longer available.' }; }
    else g.offline = true;
    render();
  };
}

async function enterRoom(code) {
  try {
    const saved = store.get('ttt:' + code);
    openRoom(await post(`/api/rooms/${code}/join`, { token: saved?.token, name: nick(), secret: getPlayer()?.secret }));
  } catch (e) {
    if (e.status === 401) { pending = code; await loadHealth(); g = { screen: 'lobby', err: e.message }; }
    else g = { screen: g.screen === 'lobby' ? 'lobby' : 'error', err: e.message };
    render();
  }
}

/* ---------- events ---------- */
const actions = {
  setup() { g = { screen: 'setup' }; render(); },
  level(_, v) { level = v; render(); },
  side(_, v) { side = v; render(); },
  variant(_, v) { if (VARIANTS[v]) { variant = v; try { localStorage.setItem('ttt:variant', v); } catch { /* storage unavailable */ } render(); } },
  cam(_, v) { getCube().view(v); },
  localSetup() { g = { screen: 'localSetup' }; render(); },
  start() { g = { screen: 'game', mode: 'ai', variant, you: side, level, sc: { you: 0, opp: 0, draws: 0 } }; track('game_start', { mode: 'ai', level, side, variant }); newGame(); },
  local() { g = { screen: 'game', mode: 'local', variant, sc: { X: 0, O: 0, draws: 0 } }; track('game_start', { mode: 'local', variant }); newGame(); },
  async lobby() { await loadHealth(); g = { screen: 'lobby' }; render(); },
  async claim() {
    const name = (document.getElementById('nick')?.value || '').trim();
    try {
      savePlayer(await post('/api/players', { name }));
      if (pending) { const code = pending; pending = null; return enterRoom(code); }
      g = { screen: 'lobby' };
    } catch (e) { g = { screen: 'lobby', err: e.message }; }
    render();
  },
  async history(_, v) {
    const name = v || getPlayer()?.name;
    if (!name) return;
    let rows = [];
    try { rows = await (await fetch(`/api/players/${encodeURIComponent(name)}/history`)).json(); } catch { /* offline */ }
    g = { screen: 'history', name, rows: Array.isArray(rows) ? rows : [] };
    render();
  },
  react(_, v) { post(`/api/rooms/${g.code}/react`, { token: g.token, id: v }).catch(() => {}); },
  switchNick() { clearPlayer(); g = { screen: 'lobby' }; render(); },
  async board() {
    let rows = [];
    try { rows = await (await fetch('/api/leaderboard')).json(); } catch { /* offline */ }
    g = { screen: 'board', rows: Array.isArray(rows) ? rows : [] };
    render();
  },
  menu: leave,
  cell(i) { play(Number(i)); },
  rematch() {
    if (g.mode === 'online') post(`/api/rooms/${g.code}/rematch`, { token: g.token }).catch(() => {});
    else { if (g.mode === 'ai') g.you = other(g.you); newGame(); }
  },
  async create() {
    try { openRoom(await post('/api/rooms', { name: nick(), secret: getPlayer()?.secret, variant })); } catch (e) { g.err = e.message; render(); }
  },
  join() {
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { g.err = 'Enter the 4-character code.'; render(); return; }
    enterRoom(code);
  },
  async copy() {
    try { await navigator.clipboard.writeText(location.href); g.copied = true; } catch { g.copied = false; }
    render();
  },
};

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.getAttribute('aria-disabled') === 'true') return;
  actions[b.dataset.a]?.(b.dataset.i, b.dataset.v);
});
const hoverPeg = (e) => { const peg = e.target.closest?.('.peg'); if (cube) cube.setHover(peg ? Number(peg.dataset.i) : -1); };
app.addEventListener('mouseover', hoverPeg);
app.addEventListener('focusin', hoverPeg);
app.addEventListener('mouseout', () => cube?.setHover(-1));
window.addEventListener('popstate', () => location.reload());

const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{4})$/);
if (m) { g = { screen: 'game', mode: 'online', code: m[1].toUpperCase(), view: null }; render(); enterRoom(m[1].toUpperCase()); }
else render();
track('page_view');
