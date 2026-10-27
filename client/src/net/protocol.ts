import type { Ball, ShotParams } from '../core/physics';
import type { MatchSettings, MatchState, Seat } from '../core/rules';

export interface Profile {
  name: string;
  avatar: string;
  cue: string;
}

export interface Member extends Profile {
  id: string;
  connected: boolean;
}

export interface RoomState {
  code: string;
  hostId: string;
  /** 'online' rooms go over the network. 'local' covers practice and pass-and-play. */
  kind: 'online' | 'local';
  members: Member[];
  /** Chairs [A1, B1, A2, B2]. Singles uses the first two; a chair's side is its index % 2. */
  seats: Array<string | null>;
  settings: MatchSettings;
  status: 'lobby' | 'playing';
  rematchVotes: string[];
}

export interface AimState {
  dx: number; dy: number;
  /** Cue pull-back 0..1 */
  pull: number;
  spinX: number; spinY: number;
  cueX?: number; cueY?: number;
}

export type ClientMsg =
  | { t: 'hello'; clientId: string; profile: Profile }
  | { t: 'profile'; profile: Profile }
  | { t: 'chat'; text: string }
  | { t: 'react'; emoji: string }
  | { t: 'aim'; aim: AimState }
  | { t: 'shot'; seq: number; params: ShotParams; cueX?: number; cueY?: number }
  | { t: 'decide'; seq: number; choice: 'play' | 'putBack' }
  | { t: 'concede'; seq: number; seat: Seat }
  | { t: 'settings'; settings: MatchSettings }
  | { t: 'sit'; seat: number | null }
  | { t: 'start' }
  | { t: 'nextFrame'; seq: number }
  | { t: 'rematch' }
  | { t: 'toLobby' };

export type HostMsg =
  | { t: 'welcome'; you: string; room: RoomState; match: MatchState | null }
  | { t: 'room'; room: RoomState }
  | { t: 'match'; match: MatchState; clockMs: number | null }
  | { t: 'shot'; seq: number; start: Ball[]; params: ShotParams; result: MatchState; clockMs: number | null }
  /** `seat` is the chair of the player aiming. */
  | { t: 'aim'; seat: number; aim: AimState }
  | { t: 'chat'; from: string; name: string; text: string }
  | { t: 'react'; from: string; name: string; emoji: string }
  | { t: 'notice'; text: string };

export const PEER_PREFIX = 'obsidian-v1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeCode(): string {
  let s = '';
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (const n of buf) s += ALPHABET[n % ALPHABET.length];
  return s;
}

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
