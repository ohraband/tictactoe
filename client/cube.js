// The 3D cube view. Plain canvas, no libraries. The maths lives in /shared/cubemath.js (tested).
import { DEFAULT_CAMERA, PITCH_MIN, PITCH_MAX, PIECE_RADIUS, PEG_HEIGHT, clamp, pegCenter, slotCenter, project, pickPeg } from '/shared/cubemath.js';

const DROP_MS = 380;
const GOLD = '#F5B800';
const filled = (board) => board.reduce((n, c) => n + (c ? 1 : 0), 0);

export function createCube({ onPick }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'cube';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D game board. Drag to turn the cube. To play with a keyboard or screen reader, use the peg buttons below it.');
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cam = { ...DEFAULT_CAMERA };
  let state = null;   // { board, last, line, turn, canPlay }
  let hover = -1;     // peg under the mouse (or under a peg button)
  let drop = null;    // { cell, start } while a piece is falling
  let frame = 0;

  const colors = () => {
    const css = getComputedStyle(document.documentElement);
    const get = (n, fallback) => css.getPropertyValue(n).trim() || fallback;
    return { ink: get('--ink', '#17233B'), paper: get('--paper', '#EEF3F8'), grid: get('--grid', '#D3DEEA'), x: get('--x', '#C8372D'), o: get('--o', '#1F55B5') };
  };

  function sphere(p, mark, C, { alpha = 1, ring = false, last = false } = {}) {
    const r = PIECE_RADIUS * p.scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = mark === 'X' ? C.x : C.o;
    ctx.fill();
    const shine = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.05, p.x - r * 0.2, p.y - r * 0.25, r * 0.95);
    shine.addColorStop(0, 'rgba(255,255,255,0.55)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.08);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.stroke();
    ctx.fillStyle = C.paper; // the letter makes X and O easy to tell apart without relying on colour
    ctx.font = `700 ${Math.round(r * 1.05)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mark, p.x, p.y + r * 0.04);
    if (last) { ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.84, 0, Math.PI * 2); ctx.lineWidth = Math.max(1.5, r * 0.08); ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke(); }
    if (ring) { ctx.beginPath(); ctx.arc(p.x, p.y, r * 1.2, 0, Math.PI * 2); ctx.lineWidth = Math.max(3, r * 0.2); ctx.strokeStyle = GOLD; ctx.stroke(); }
    ctx.restore();
  }

  function draw() {
    frame = 0;
    const size = canvas.clientWidth;
    if (!size || !state) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const C = colors();

    // base plate
    const corners = [[-2, -2], [2, -2], [2, 2], [-2, 2]].map(([x, y]) => project({ x, y, z: 0 }, cam, size));
    ctx.beginPath();
    corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = C.grid;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.ink;
    ctx.stroke();

    // pegs, far ones first
    const pegs = Array.from({ length: 16 }, (_, peg) => {
      const c = pegCenter(peg);
      return { peg, a: project({ x: c.x, y: c.y, z: 0 }, cam, size), b: project({ x: c.x, y: c.y, z: PEG_HEIGHT }, cam, size) };
    }).sort((p, q) => q.a.depth - p.a.depth);
    for (const { peg, a, b } of pegs) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(2, a.scale * (peg === hover ? 0.14 : 0.08));
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = peg === hover ? 1 : 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // pieces, far ones first. A falling piece starts above the peg.
    const win = new Set(state.line || []);
    const now = performance.now();
    let falling = false;
    const items = [];
    state.board.forEach((mark, cell) => {
      if (!mark) return;
      const layer = Math.floor(cell / 16);
      let z = layer;
      if (drop && drop.cell === cell) {
        const t = clamp((now - drop.start) / DROP_MS, 0, 1);
        z = layer + (1 - t * t) * (5 - layer); // accelerates downwards, like gravity
        if (t < 1) falling = true;
      }
      items.push({ mark, cell, p: project(slotCenter(cell % 16, z), cam, size) });
    });
    items.sort((a, b) => b.p.depth - a.p.depth);

    // a faint preview of where the next piece would land
    if (hover >= 0 && state.canPlay) {
      let layer = 0;
      while (layer < 4 && state.board[layer * 16 + hover]) layer++;
      if (layer < 4) sphere(project(slotCenter(hover, layer), cam, size), state.turn, C, { alpha: 0.35 });
    }
    for (const { mark, cell, p } of items) {
      sphere(p, mark, C, { alpha: win.size && !win.has(cell) ? 0.35 : 1, ring: win.has(cell), last: cell === state.last && !win.size });
    }
    if (!falling) drop = null; else schedule();
  }

  function schedule() { if (!frame) frame = requestAnimationFrame(draw); }

  /* ---- mouse and touch: drag to turn, tap to pick a peg ---- */
  let drag = null;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 6) drag.moved = true; // small wobble still counts as a tap
      if (drag.moved) {
        cam.yaw += (e.clientX - drag.x) * 0.01;
        cam.pitch = clamp(cam.pitch + (e.clientY - drag.y) * 0.01, PITCH_MIN, PITCH_MAX);
        schedule();
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else if (e.pointerType === 'mouse') {
      api.setHover(pickPeg(...local(e), cam, canvas.clientWidth));
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (drag && !drag.moved) { const peg = pickPeg(...local(e), cam, canvas.clientWidth); if (peg >= 0) onPick(peg); }
    drag = null;
  });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('pointerleave', () => { if (!drag) api.setHover(-1); });
  new ResizeObserver(schedule).observe(canvas);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);

  const api = {
    canvas,
    // Called after every screen update with the current board.
    set(next) {
      const prev = state;
      state = next;
      if (!reduceMotion && prev && next.last != null && filled(next.board) === filled(prev.board) + 1) drop = { cell: next.last, start: performance.now() };
      schedule();
    },
    clear() { state = null; drop = null; },
    setHover(peg) { if (peg !== hover) { hover = peg; schedule(); } },
    view(name) {
      if (name === 'left') cam.yaw -= Math.PI / 6;
      else if (name === 'right') cam.yaw += Math.PI / 6;
      else if (name === 'top') cam.pitch = PITCH_MAX;
      else Object.assign(cam, DEFAULT_CAMERA);
      schedule();
    },
  };
  return api;
}
