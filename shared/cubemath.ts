// Geometry for the 3D cube view: a tiny perspective camera, with no graphics library.
// World: x and y span the base, z is height. Peg p stands at column p % 4, row floor(p / 4); each peg holds 4 pieces.
export interface Pt { x: number; y: number; z: number }
export interface Camera { yaw: number; pitch: number; zoom: number }
export interface Projected { x: number; y: number; depth: number; scale: number }

export const DEFAULT_CAMERA: Camera = { yaw: 0.6, pitch: 0.6, zoom: 1 };
export const PITCH_MIN = 0.1;  // nearly side-on
export const PITCH_MAX = 1.5;  // nearly straight down
export const PIECE_RADIUS = 0.42;
export const PEG_HEIGHT = 4.3;
export const CENTER_Z = 2.1;   // the point the camera looks at, on the middle of the cube
const DISTANCE = 14;
const FOCAL = 1.65;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function pegCenter(peg: number): { x: number; y: number } {
  return { x: (peg % 4) - 1.5, y: Math.floor(peg / 4) - 1.5 };
}

// The centre of a slot: layer 0 is the bottom piece on a peg.
export function slotCenter(peg: number, layer: number): Pt {
  const c = pegCenter(peg);
  return { x: c.x, y: c.y, z: layer + 0.5 };
}

// Turns a world point into a screen point for a square canvas of `size` pixels.
export function project(p: Pt, cam: Camera, size: number): Projected {
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const x1 = p.x * cy - p.y * sy; // spin around the vertical axis
  const y1 = p.x * sy + p.y * cy;
  const z1 = p.z - CENTER_Z;
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const y2 = y1 * cp - z1 * sp;   // tilt towards the viewer
  const z2 = y1 * sp + z1 * cp;
  const depth = DISTANCE + y2;    // bigger = further away
  const scale = (size * FOCAL * cam.zoom) / depth;
  return { x: size / 2 + x1 * scale, y: size / 2 - z2 * scale, depth, scale };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Which peg is under a screen point? Returns -1 if none is close enough.
// Each peg is a vertical rod, so the point is compared with the rod's drawn line. If rods overlap, the nearer one wins.
export function pickPeg(sx: number, sy: number, cam: Camera, size: number): number {
  let best = -1, bestDist = Infinity, bestDepth = Infinity;
  for (let peg = 0; peg < 16; peg++) {
    const c = pegCenter(peg);
    const a = project({ x: c.x, y: c.y, z: 0 }, cam, size);
    const b = project({ x: c.x, y: c.y, z: PEG_HEIGHT }, cam, size);
    const d = distToSegment(sx, sy, a.x, a.y, b.x, b.y);
    const reach = PIECE_RADIUS * 1.15 * ((a.scale + b.scale) / 2); // about the size of a piece
    const depth = (a.depth + b.depth) / 2;
    if (d > reach) continue;
    if (d < bestDist - 0.75 || (Math.abs(d - bestDist) <= 0.75 && depth < bestDepth)) { best = peg; bestDist = d; bestDepth = depth; }
  }
  return best;
}
