// The computer opponent. It never guesses where balls go: every candidate shot is played out with
// the real physics and scored with the real rules, then the best one is chosen. Difficulty comes
// from how many shots it looks at and how much its aim and power wobble.

import { makeWorld, simulate, type Ball, type ShotParams } from './physics';
import {
  ballOn, canPlaceCue, resolveShot, tableFor,
  type MatchState, type Seat,
} from './rules';
import type { Pocket, TableGeometry } from './table';

export type BotLevel = 'easy' | 'medium' | 'hard';

export const BOT_ID = 'bot';

export const BOT_PROFILES: Record<BotLevel, { name: string; avatar: string; cue: string }> = {
  easy: { name: 'Rookie Rae', avatar: '🐣', cue: 'candy' },
  medium: { name: 'Club Carlo', avatar: '🦉', cue: 'maple' },
  hard: { name: 'Pro Petra', avatar: '🦅', cue: 'carbon' },
};

export interface BotShot {
  params: ShotParams;
  cueX?: number;
  cueY?: number;
}

interface Tuning {
  /** Pot candidates simulated per cue position. */
  pots: number;
  powers: number[];
  spins: number[];
  safeties: number;
  /** Standard deviation of aim error, radians. */
  aimNoise: number;
  powerNoise: number;
  /** How much it cares about leaving itself a next shot. */
  position: number;
}

const TUNING: Record<BotLevel, Tuning> = {
  easy: { pots: 3, powers: [1], spins: [0], safeties: 2, aimNoise: 0.012, powerNoise: 0.12, position: 0.2 },
  medium: { pots: 6, powers: [0.9, 1.2], spins: [0, -0.55], safeties: 4, aimNoise: 0.004, powerNoise: 0.06, position: 0.7 },
  hard: { pots: 9, powers: [0.85, 1.05, 1.3], spins: [0, -0.6, 0.55], safeties: 6, aimNoise: 0.0012, powerNoise: 0.025, position: 1 },
};

interface Candidate { params: ShotParams; cue: { x: number; y: number }; ease: number }

// ---------------------------------------------------------------------------------------------
// Geometry

function clearPath(R: number, balls: Ball[], x0: number, y0: number, x1: number, y1: number, ignore: number[]): boolean {
  const ex = x1 - x0, ey = y1 - y0;
  const l2 = ex * ex + ey * ey || 1;
  const lim = 2 * R + 1;
  for (const b of balls) {
    if (!b.on || ignore.includes(b.id)) continue;
    let t = ((b.x - x0) * ex + (b.y - y0) * ey) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = b.x - (x0 + ex * t), dy = b.y - (y0 + ey * t);
    if (dx * dx + dy * dy < lim * lim) return false;
  }
  return true;
}

/** Where to send an object ball so it drops: just inside the middle of the pocket mouth. */
function pocketTarget(pk: Pocket, R: number) {
  return { x: pk.mx + pk.nx * R * 0.6, y: pk.my + pk.ny * R * 0.6 };
}

interface PotLine { target: Ball; pocket: Pocket; gx: number; gy: number; ux: number; uy: number; cueDist: number; potDist: number; cut: number; ease: number }

/** Straight pots available from (cx, cy) onto any ball for which `isTarget` holds. */
export function potLines(table: TableGeometry, balls: Ball[], cx: number, cy: number, isTarget: (b: Ball) => boolean): PotLine[] {
  const R = table.R;
  const out: PotLine[] = [];
  for (const t of balls) {
    if (!t.on || t.id === 0 || !isTarget(t)) continue;
    for (const pk of table.pockets) {
      const p = pocketTarget(pk, R);
      let ux = p.x - t.x, uy = p.y - t.y;
      const potDist = Math.sqrt(ux * ux + uy * uy);
      if (potDist < 1) continue;
      ux /= potDist; uy /= potDist;
      // The ball has to arrive roughly along the pocket's opening.
      const along = ux * pk.nx + uy * pk.ny;
      const corner = pk.nx !== 0 && pk.ny !== 0;
      if (along < (corner ? 0.45 : 0.55)) continue;
      const gx = t.x - ux * 2 * R, gy = t.y - uy * 2 * R;
      const vx = gx - cx, vy = gy - cy;
      const cueDist = Math.sqrt(vx * vx + vy * vy);
      if (cueDist < R) continue;
      const cut = (vx * ux + vy * uy) / cueDist;
      if (cut < 0.3) continue;
      if (!clearPath(R, balls, cx, cy, gx, gy, [0, t.id])) continue;
      if (!clearPath(R, balls, t.x, t.y, p.x, p.y, [0, t.id])) continue;
      const ease = (cut * cut * along) / (1 + (cueDist + potDist * 1.5) / 2200);
      out.push({ target: t, pocket: pk, gx, gy, ux, uy, cueDist, potDist, cut, ease });
    }
  }
  return out.sort((a, b) => b.ease - a.ease);
}

/** How good is the easiest pot for whoever is at the table? 0 when nothing is on. */
function bestEase(table: TableGeometry, m: MatchState): number {
  const f = m.frame;
  const cue = f.balls[0];
  if (!cue.on || f.ballInHand) return 0.6; // ball in hand is worth a fair bit
  const lines = potLines(table, f.balls, cue.x, cue.y, (b) => ballOn(m, b));
  return lines.length ? lines[0].ease : 0;
}

// ---------------------------------------------------------------------------------------------
// Candidate shots

function cuePositions(table: TableGeometry, m: MatchState): Array<{ x: number; y: number }> {
  const f = m.frame;
  const c = f.balls[0];
  if (!f.ballInHand) return [{ x: c.x, y: c.y }];
  const out: Array<{ x: number; y: number }> = [];
  const zone = f.hand ?? 'D';
  if (zone !== 'D') {
    // Pool: try a spread of spots, preferring ones with an easy pot.
    const maxX = zone === 'kitchen' ? table.baulkX : table.L - table.R;
    for (let i = 1; i <= 5; i++) {
      for (let j = 1; j <= 4; j++) {
        const x = (maxX * i) / 6, y = (table.W * j) / 5;
        if (canPlaceCue(table, f.balls, x, y, zone)) out.push({ x, y });
      }
    }
    const score = (p: { x: number; y: number }) => potLines(table, f.balls, p.x, p.y, (b) => ballOn(m, b))[0]?.ease ?? 0;
    out.sort((a, b) => score(b) - score(a));
    return out.length ? out : [{ x: c.x, y: c.y }];
  }
  const { dCenter: d, dRadius: r } = table;
  // Spread points across the D: angle measured from straight back towards the baulk cushion.
  for (const deg of [0, -35, 35, -70, 70]) {
    for (const k of [0.4, 0.8]) {
      const a = (deg * Math.PI) / 180;
      const x = d.x - Math.cos(a) * r * k;
      const y = d.y + Math.sin(a) * r * k;
      if (canPlaceCue(table, f.balls, x, y)) out.push({ x, y });
    }
  }
  return out.length ? out : [{ x: c.x, y: c.y }];
}

function powerFor(line: PotLine): number {
  const travel = line.cueDist + line.potDist / Math.max(line.cut, 0.35);
  return Math.min(0.9, Math.max(0.16, travel / 4600 + 0.14));
}

function potCandidates(table: TableGeometry, m: MatchState, cue: { x: number; y: number }, t: Tuning): Candidate[] {
  const f = m.frame;
  const lines = potLines(table, f.balls, cue.x, cue.y, (b) => ballOn(m, b)).slice(0, t.pots);
  const out: Candidate[] = [];
  for (const l of lines) {
    const vx = l.gx - cue.x, vy = l.gy - cue.y;
    const d = Math.sqrt(vx * vx + vy * vy);
    const base = powerFor(l);
    for (const pm of t.powers) {
      for (const spinY of t.spins) {
        out.push({ cue, ease: l.ease, params: { dx: vx / d, dy: vy / d, power: Math.min(1, base * pm), spinX: 0, spinY } });
      }
    }
  }
  return out;
}

/** Thin contacts on balls on, played softly: the bones of a safety shot. */
function safetyCandidates(table: TableGeometry, m: MatchState, cue: { x: number; y: number }, t: Tuning): Candidate[] {
  const f = m.frame;
  const R = table.R;
  const targets = f.balls
    .filter((b) => ballOn(m, b))
    .sort((a, b) => (a.x - cue.x) ** 2 + (a.y - cue.y) ** 2 - ((b.x - cue.x) ** 2 + (b.y - cue.y) ** 2))
    .slice(0, t.safeties);
  const out: Candidate[] = [];
  for (const b of targets) {
    const dx = b.x - cue.x, dy = b.y - cue.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 2 * R) continue;
    const px = -dy / d, py = dx / d;
    for (const side of [-1, -0.5, 0, 0.5, 1]) {
      const ax = b.x + px * side * R * 1.7 - cue.x;
      const ay = b.y + py * side * R * 1.7 - cue.y;
      const al = Math.sqrt(ax * ax + ay * ay);
      for (const power of [0.2, 0.32, 0.5]) {
        out.push({ cue, ease: 0, params: { dx: ax / al, dy: ay / al, power, spinX: 0, spinY: 0 } });
      }
    }
  }
  return out;
}

/** Last resort when snookered: try the whole compass. */
function escapeCandidates(cue: { x: number; y: number }): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    for (const power of [0.35, 0.6]) out.push({ cue, ease: 0, params: { dx: Math.cos(a), dy: Math.sin(a), power, spinX: 0, spinY: 0 } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Evaluation

function evaluate(table: TableGeometry, m: MatchState, c: Candidate, me: Seat, t: Tuning): number {
  const balls = m.frame.balls.map((b) => ({ ...b }));
  balls[0].x = c.cue.x; balls[0].y = c.cue.y; balls[0].on = true;
  const world = makeWorld(table, balls);
  const rec = simulate(world, c.params, 40);
  const next = resolveShot(m, rec, world.balls, { random: () => 0.5 });
  const nf = next.frame;
  const mine = nf.scores[me] - m.frame.scores[me];
  const theirs = nf.scores[1 - me] - m.frame.scores[1 - me];
  if (nf.over) return nf.winner === me ? 10000 : -10000;
  let score = mine * 12 - theirs * 12;
  if (next.lastShot?.foul) score -= 40;
  const myTurn = nf.turn === me && !nf.decision;
  const ease = bestEase(table, next);
  if (myTurn) score += 30 + ease * 60 * t.position;
  else score -= ease * 70 * Math.max(0.4, t.position);
  return score;
}

// ---------------------------------------------------------------------------------------------

function gauss(): number {
  return Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * Pick a shot for the side at the table. Async so the search can yield to the page between
 * simulations and the table keeps animating while the computer "thinks".
 */
export async function planShot(m: MatchState, level: BotLevel): Promise<BotShot> {
  const t = TUNING[level];
  const table = tableFor(m.settings);
  const me = m.frame.turn;

  // Pool break: smash the apex from behind the head string.
  if (m.settings.game === 'pool8' && !m.frame.pool?.broken) {
    const x = table.baulkX * 0.8, y = table.W / 2 + (Math.random() - 0.5) * table.W * 0.3;
    const dx = table.footSpot.x - x, dy = table.footSpot.y - y;
    const a = Math.atan2(dy, dx) + gauss() * t.aimNoise;
    return { params: { dx: Math.cos(a), dy: Math.sin(a), power: 0.9 + Math.random() * 0.1, spinX: 0, spinY: -0.15 }, cueX: x, cueY: y };
  }
  let slice = performance.now();
  const breathe = async () => {
    if (performance.now() - slice > 24) {
      await new Promise((r) => setTimeout(r, 0));
      slice = performance.now();
    }
  };

  let best: { c: Candidate; score: number } | null = null;
  const consider = async (cands: Candidate[]) => {
    for (const c of cands) {
      const s = evaluate(table, m, c, me, t) + Math.random() * 2;
      if (!best || s > best.score) best = { c, score: s };
      await breathe();
    }
  };

  const positions = cuePositions(table, m).slice(0, level === 'hard' ? 8 : level === 'medium' ? 5 : 2);
  for (const p of positions) await consider(potCandidates(table, m, p, t));
  // Nothing worth potting: play safe.
  const current = best as { c: Candidate; score: number } | null;
  if (!current || current.score < 25) {
    for (const p of positions.slice(0, 3)) await consider(safetyCandidates(table, m, p, t));
  }
  const settled = best as { c: Candidate; score: number } | null;
  if (!settled || settled.score < -30) await consider(escapeCandidates(positions[0]));

  const pick = (best as { c: Candidate; score: number } | null)?.c ?? escapeCandidates(positions[0])[0];
  // Human error.
  const a = Math.atan2(pick.params.dy, pick.params.dx) + gauss() * t.aimNoise;
  const power = Math.min(1, Math.max(0.08, pick.params.power * (1 + gauss() * t.powerNoise)));
  return {
    params: { ...pick.params, dx: Math.cos(a), dy: Math.sin(a), power },
    ...(m.frame.ballInHand ? { cueX: pick.cue.x, cueY: pick.cue.y } : {}),
  };
}
