// Pure game logic shared by the browser, the AI, and the server.
// One engine handles several board types ("variants"). A move is always a single number:
//   grid boards: the cell index.   cube: the peg (0-15); the piece drops to the lowest free slot.
export type Mark = 'X' | 'O';
export type Cell = Mark | null;
export type Variant = 'classic' | 'grid4' | 'grid5' | 'cube';

export interface VariantInfo {
  id: Variant;
  name: string;
  blurb: string;
  kind: 'grid' | 'cube';
  size: number;          // cells along one side
  win: number;           // pieces in a row needed to win
  cells: number;         // number of cells on the board
  moves: number;         // number of different moves: one per cell on a grid, one per peg on the cube
  lines: number[][];     // every winning line, as cell indexes
  through: number[][][]; // through[cell] = the lines that contain that cell
}

export interface GameState {
  variant: Variant;
  board: Cell[];
  turn: Mark;
  winner: Mark | null;
  line: number[] | null; // the winning cells
  draw: boolean;
  last: number | null;   // the cell played most recently
}

const CUBE = 4; // the cube is 4 x 4 x 4. Cell index = layer * 16 + row * 4 + column, layer 0 is the bottom.

function gridLines(n: number, w: number): number[][] {
  const out: number[][] = [];
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      for (const [dr, dc] of dirs) {
        const er = r + (w - 1) * dr, ec = c + (w - 1) * dc;
        if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
        out.push(Array.from({ length: w }, (_, k) => (r + k * dr) * n + (c + k * dc)));
      }
    }
  }
  return out;
}

// All straight lines of 4 in the cube: 13 directions, 76 lines in total.
function cubeLines(): number[][] {
  const dirs: number[][] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && dz > 0)) dirs.push([dx, dy, dz]); // half of them, so no line is counted twice
  }
  const inside = (v: number) => v >= 0 && v < CUBE;
  const out: number[][] = [];
  for (let z = 0; z < CUBE; z++) for (let y = 0; y < CUBE; y++) for (let x = 0; x < CUBE; x++) {
    for (const [dx, dy, dz] of dirs) {
      if (!inside(x + 3 * dx) || !inside(y + 3 * dy) || !inside(z + 3 * dz)) continue;
      out.push([0, 1, 2, 3].map((k) => (z + k * dz) * 16 + (y + k * dy) * 4 + (x + k * dx)));
    }
  }
  return out;
}

function makeVariant(id: Variant, name: string, blurb: string, kind: 'grid' | 'cube', size: number, win: number): VariantInfo {
  const cells = kind === 'cube' ? CUBE ** 3 : size * size;
  const lines = kind === 'cube' ? cubeLines() : gridLines(size, win);
  const through: number[][][] = Array.from({ length: cells }, () => []);
  for (const line of lines) for (const c of line) through[c].push(line);
  return { id, name, blurb, kind, size, win, cells, moves: kind === 'cube' ? CUBE * CUBE : cells, lines, through };
}

export const VARIANTS: Record<Variant, VariantInfo> = {
  classic: makeVariant('classic', 'Classic 3×3', 'Three in a row. The original.', 'grid', 3, 3),
  grid4: makeVariant('grid4', 'Big 4×4', 'Four in a row on a 4×4 board. Tighter and trickier.', 'grid', 4, 4),
  grid5: makeVariant('grid5', 'Bigger 5×5', 'Four in a row on a 5×5 board. Room for traps.', 'grid', 5, 4),
  cube: makeVariant('cube', '3D Cube 4×4×4', 'Drop pieces down pegs. Four in a row in any direction, even diagonally through the cube.', 'cube', 4, 4),
};
export const VARIANT_LIST: VariantInfo[] = [VARIANTS.classic, VARIANTS.grid4, VARIANTS.grid5, VARIANTS.cube];
export const LINES = VARIANTS.classic.lines; // the 8 lines of the classic board

export const isVariant = (x: unknown): x is Variant => typeof x === 'string' && Object.prototype.hasOwnProperty.call(VARIANTS, x);

export const createState = (variant: Variant = 'classic'): GameState => ({
  variant, board: Array<Cell>(VARIANTS[variant].cells).fill(null), turn: 'X', winner: null, line: null, draw: false, last: null,
});

// The cell a move would fill, or -1 if the move is not possible. On the cube this is where the piece lands.
export function landingCell(s: GameState, move: number): number {
  const v = VARIANTS[s.variant];
  if (v.kind === 'cube') {
    for (let layer = 0; layer < CUBE; layer++) if (s.board[layer * 16 + move] === null) return layer * 16 + move;
    return -1;
  }
  return s.board[move] === null ? move : -1;
}

export function getWinner(board: Cell[], variant: Variant = 'classic'): { winner: Mark; line: number[] } | null {
  for (const line of VARIANTS[variant].lines) {
    const m = board[line[0]];
    if (m && line.every((c) => board[c] === m)) return { winner: m, line };
  }
  return null;
}

export function getLegalMoves(s: GameState): number[] {
  if (s.winner || s.draw) return [];
  const out: number[] = [];
  for (let m = 0; m < VARIANTS[s.variant].moves; m++) if (landingCell(s, m) >= 0) out.push(m);
  return out;
}

// Returns the next state, or null if the move is illegal. The move may come from the network, so it is `unknown`.
export function applyMove(s: GameState, move: unknown): GameState | null {
  const v = VARIANTS[s.variant];
  if (typeof move !== 'number' || !Number.isInteger(move) || move < 0 || move >= v.moves || s.winner || s.draw) return null;
  const cell = landingCell(s, move);
  if (cell < 0) return null;
  const board = [...s.board];
  board[cell] = s.turn;
  const line = v.through[cell].find((l) => l.every((c) => board[c] === s.turn)) ?? null; // only lines through the new piece can win
  return {
    variant: s.variant, board, turn: s.turn === 'X' ? 'O' : 'X',
    winner: line ? s.turn : null, line, draw: !line && board.every(Boolean), last: cell,
  };
}
