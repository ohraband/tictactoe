// Shapes shared by the server and the browser.
import type { Cell, Mark, Variant } from './game.ts';

export const REACTIONS = [
  { id: 'thumbs', emoji: '👍', label: 'Thumbs up' },
  { id: 'laugh', emoji: '😂', label: 'Laughing' },
  { id: 'wow', emoji: '😮', label: 'Surprised' },
  { id: 'fire', emoji: '🔥', label: 'On fire' },
  { id: 'sad', emoji: '😢', label: 'Sad' },
  { id: 'clap', emoji: '👏', label: 'Clapping' },
  { id: 'gg', emoji: '🤝', label: 'Good game' },
  { id: 'luck', emoji: '🍀', label: 'Good luck' },
] as const;

export interface Reaction { seq: number; mark: Mark; id: string }

export interface RoomView {
  code: string;
  variant: Variant;
  last: number | null; // the cell played most recently
  board: Cell[];
  turn: Mark;
  winner: Mark | null;
  line: number[] | null;
  draw: boolean;
  status: 'waiting' | 'playing' | 'over';
  marks: Mark[];
  names: { mark: Mark; name: string }[];
  connected: boolean[];
  scores: Record<Mark, number>;
  draws: number;
  rematch: Mark[];
  forfeit: Mark | null;
  reaction: Reaction | null;
  version: number; // increases on every change, so clients can ignore out-of-order updates
}

export interface SeatInfo { code: string; token: string; seat: number; mark: Mark }
