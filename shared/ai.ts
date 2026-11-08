import { applyMove, getLegalMoves, VARIANTS } from './game.ts';
import type { Cell, GameState, Mark, Variant } from './game.ts';

export type Level = 'easy' | 'medium' | 'hard';
const other = (m: Mark): Mark => (m === 'X' ? 'O' : 'X');
const WIN = 1_000_000;
// Thinking time for Hard on the bigger boards (the classic board is solved exactly instead).
const THINK_MS: Record<Variant, number> = { classic: 0, grid4: 300, grid5: 400, cube: 450 };

/* ---- classic 3x3: exact, never loses. Position scores never change, so they are cached. ---- */
const memo = new Map<string, number>();

function solve(s: GameState, me: Mark): number {
  const filled = s.board.filter(Boolean).length;
  if (s.winner) return s.winner === me ? 10 - filled : filled - 10; // faster wins score higher
  if (s.draw) return 0;
  const key = s.board.map((c) => c ?? '-').join('') + s.turn + me;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const scores = getLegalMoves(s).map((m) => solve(applyMove(s, m)!, me));
  const score = s.turn === me ? Math.max(...scores) : Math.min(...scores);
  memo.set(key, score);
  return score;
}

/* ---- bigger boards and the cube: depth-limited search with a time budget ---- */
class SearchTimeout extends Error {}
interface Ctx { nodes: number; deadline: number; order: number[] }

// Moves nearest the middle first: they take part in more lines, and good ordering makes pruning faster.
const orders = new Map<Variant, number[]>();
function orderFor(v: Variant): number[] {
  let o = orders.get(v);
  if (!o) {
    const info = VARIANTS[v];
    const side = info.kind === 'cube' ? 4 : info.size;
    const mid = (side - 1) / 2;
    const dist = (m: number) => ((m % side) - mid) ** 2 + (Math.floor(m / side) - mid) ** 2;
    o = Array.from({ length: info.moves }, (_, m) => m).sort((a, b) => dist(a) - dist(b));
    orders.set(v, o);
  }
  return o;
}

// How good is the position for `who`? Open lines count: more of your own pieces in a line is better.
function evaluate(variant: Variant, board: Cell[], who: Mark): number {
  let score = 0;
  for (const line of VARIANTS[variant].lines) {
    let x = 0, o = 0;
    for (const c of line) { const m = board[c]; if (m === 'X') x++; else if (m === 'O') o++; }
    if ((x && o) || (!x && !o)) continue; // a blocked or empty line is worth nothing
    const weight = 10 ** ((x || o) - 1);
    score += (x ? 'X' : 'O') === who ? weight : -weight;
  }
  return score;
}

// Score from the point of view of the player whose turn it is in `s`.
function negamax(s: GameState, depth: number, alpha: number, beta: number, ply: number, ctx: Ctx): number {
  if (s.winner) return -(WIN - ply); // the player who just moved has won
  if (s.draw) return 0;
  if (depth === 0) return evaluate(s.variant, s.board, s.turn);
  if ((++ctx.nodes & 255) === 0 && Date.now() > ctx.deadline) throw new SearchTimeout();
  let best = -Infinity;
  for (const m of ctx.order) {
    const child = applyMove(s, m);
    if (!child) continue;
    const sc = -negamax(child, depth - 1, -beta, -alpha, ply + 1, ctx);
    if (sc > best) best = sc;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// Searches one move deeper each round until time runs out, and keeps the last finished round.
function search(s: GameState, timeMs: number, rng: () => number): number {
  const order = orderFor(s.variant);
  const ctx: Ctx = { nodes: 0, deadline: Date.now() + timeMs, order };
  const moves = order.filter((m) => applyMove(s, m) !== null);
  if (moves.length === 1) return moves[0];
  let candidates = [moves[0]];
  let first = moves[0];
  for (let depth = 1; depth <= 14; depth++) {
    let bestScore = -Infinity;
    let tied: number[] = [];
    try {
      for (const m of [first, ...moves.filter((x) => x !== first)]) {
        const child = applyMove(s, m)!;
        // The window is just below the best score so far, so equal moves are still found and can be chosen between.
        const sc = -negamax(child, depth - 1, -Infinity, -(bestScore - 1), 1, ctx);
        if (sc > bestScore) { bestScore = sc; tied = [m]; } else if (sc === bestScore) tied.push(m);
      }
    } catch (e) {
      if (e instanceof SearchTimeout) break;
      throw e;
    }
    candidates = tied;
    first = tied[0];
    if (Math.abs(bestScore) >= WIN - 100) break; // a forced win or loss is known, no need to look deeper
  }
  return candidates[Math.floor(rng() * candidates.length)];
}

// easy: random. medium: win, block, else random. hard: exact on 3x3, time-limited search elsewhere.
export function chooseMove(s: GameState, level: Level, rng: () => number = Math.random, timeMs?: number): number | null {
  const moves = getLegalMoves(s);
  if (!moves.length) return null;
  const me = s.turn;
  const pick = (a: number[]): number => a[Math.floor(rng() * a.length)];
  if (level === 'easy') return pick(moves);
  if (level === 'medium') {
    const win = moves.find((m) => applyMove(s, m)!.winner === me);
    if (win !== undefined) return win;
    const block = moves.find((m) => applyMove({ ...s, turn: other(me) }, m)!.winner === other(me));
    if (block !== undefined) return block;
    return pick(moves);
  }
  if (s.variant === 'classic') {
    let best = -Infinity;
    let bestMoves: number[] = [];
    for (const m of moves) {
      const sc = solve(applyMove(s, m)!, me);
      if (sc > best) { best = sc; bestMoves = [m]; } else if (sc === best) bestMoves.push(m);
    }
    return pick(bestMoves);
  }
  return search(s, timeMs ?? THINK_MS[s.variant], rng);
}
