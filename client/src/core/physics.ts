// Spin-aware ball physics. Deterministic: only + - * / and sqrt are used inside the step,
// so every browser that runs the same shot from the same start lands on the same result.
//
// Each ball carries its linear velocity (vx, vy) and the velocity of its contact patch caused
// by rotation (sx, sy). While v + s != 0 the ball slides and cloth friction pulls the two
// together; once they cancel the ball rolls. Side spin is a separate scalar that only acts at
// cushions. Units: mm, seconds.

import type { BallKind, TableGeometry } from './table';

export interface Ball {
  id: number;
  kind: BallKind;
  x: number; y: number;
  vx: number; vy: number;
  sx: number; sy: number;
  /** Side spin as contact surface speed; positive is anticlockwise seen from above (right-hand side). */
  side: number;
  on: boolean;
  /** Pool ball number (1-15). Snooker balls are identified by `kind` alone. */
  n?: number;
}

export interface ShotParams {
  /** Unit aim vector. */
  dx: number; dy: number;
  /** 0..1 */
  power: number;
  /** Tip offset across the ball, -1 (left) .. 1 (right). */
  spinX: number;
  /** Tip offset up the ball, -1 (screw/draw) .. 1 (top). */
  spinY: number;
}

export type SimEvent =
  | { type: 'ball'; a: number; b: number; speed: number }
  | { type: 'cushion'; id: number; speed: number }
  | { type: 'pot'; id: number; pocket: number; speed: number; vx: number; vy: number };

export interface ShotRecord {
  firstHit: number | null;
  potted: number[];
}

export const DT = 1 / 500;
export const MAX_SPEED = 6800;
const G = 9810;
const MU_SLIDE = 0.2;
const MU_ROLL = 0.0145;
const SIDE_DECAY = 700;
const BALL_E = 0.94;
const STOP_SPEED = 4;

export interface World {
  table: TableGeometry;
  balls: Ball[];
  record: ShotRecord;
  time: number;
}

export function makeWorld(table: TableGeometry, balls: Ball[]): World {
  return { table, balls: balls.map((b) => ({ ...b })), record: { firstHit: null, potted: [] }, time: 0 };
}

export function cueSpeed(power: number): number {
  const p = Math.min(1, Math.max(0, power));
  return MAX_SPEED * p * Math.sqrt(p) + 60 * p;
}

/** Apply the cue to ball 0. */
export function strike(world: World, shot: ShotParams): void {
  const cue = world.balls[0];
  const V = cueSpeed(shot.power);
  const tip = 0.55; // max tip offset as a fraction of the radius
  const a = clamp(shot.spinX, -1, 1) * tip;
  const b = clamp(shot.spinY, -1, 1) * tip;
  cue.vx = shot.dx * V;
  cue.vy = shot.dy * V;
  // Hitting 0.4R above centre gives natural roll (s = -v). Below centre gives backspin.
  cue.sx = -2.5 * b * V * shot.dx;
  cue.sy = -2.5 * b * V * shot.dy;
  cue.side = 2.5 * a * V;
}

/** Advance one fixed step. Events are pushed onto `out` when given. */
export function step(world: World, out?: SimEvent[]): void {
  const { balls, table } = world;
  const R = table.R;
  const fr = table.tuning.friction;
  const slideA = MU_SLIDE * G * fr;
  const rollA = MU_ROLL * G * fr;
  const n = balls.length;

  for (let i = 0; i < n; i++) {
    const b = balls[i];
    if (!b.on) continue;
    if (b.vx === 0 && b.vy === 0) { b.sx = 0; b.sy = 0; b.side = 0; continue; }
    const ux = b.vx + b.sx, uy = b.vy + b.sy;
    const u = Math.sqrt(ux * ux + uy * uy);
    if (u > 1) {
      // Sliding: friction opposes the slip. Slip shrinks at 3.5x the linear deceleration.
      const f = Math.min(1, u / (3.5 * slideA * DT));
      const dv = slideA * DT * f;
      const ex = ux / u, ey = uy / u;
      b.vx -= ex * dv; b.vy -= ey * dv;
      b.sx -= 2.5 * ex * dv; b.sy -= 2.5 * ey * dv;
      if (f < 1) { b.sx = -b.vx; b.sy = -b.vy; }
    } else {
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const dv = rollA * DT;
      if (sp <= dv || sp < STOP_SPEED) {
        b.vx = 0; b.vy = 0; b.sx = 0; b.sy = 0; b.side = 0;
        continue;
      }
      const k = (sp - dv) / sp;
      b.vx *= k; b.vy *= k;
      b.sx = -b.vx; b.sy = -b.vy;
    }
    if (b.side !== 0) {
      const d = SIDE_DECAY * DT;
      b.side = Math.abs(b.side) <= d ? 0 : b.side - (b.side > 0 ? d : -d);
    }
    b.x += b.vx * DT;
    b.y += b.vy * DT;
  }

  // Ball to ball.
  const minD = 2 * R;
  const minD2 = minD * minD;
  for (let i = 0; i < n; i++) {
    const a = balls[i];
    if (!a.on) continue;
    for (let j = i + 1; j < n; j++) {
      const b = balls[j];
      if (!b.on) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      const rel = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
      // Separate overlapping balls.
      const push = (minD - d) / 2;
      a.x -= nx * push; a.y -= ny * push;
      b.x += nx * push; b.y += ny * push;
      if (rel <= 0) continue;
      const jImp = ((1 + BALL_E) / 2) * rel;
      a.vx -= jImp * nx; a.vy -= jImp * ny;
      b.vx += jImp * nx; b.vy += jImp * ny;
      if (world.record.firstHit === null) {
        if (a.id === 0) world.record.firstHit = b.id;
        else if (b.id === 0) world.record.firstHit = a.id;
      }
      out?.push({ type: 'ball', a: a.id, b: b.id, speed: rel });
    }
  }

  // Cushions and jaws.
  const e = table.tuning.cushionBounce;
  for (let i = 0; i < n; i++) {
    const b = balls[i];
    if (!b.on) continue;
    for (const s of table.segments) {
      const ex = s.bx - s.ax, ey = s.by - s.ay;
      const len2 = ex * ex + ey * ey;
      let t = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = s.ax + ex * t, qy = s.ay + ey * t;
      const dx = b.x - qx, dy = b.y - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, ny = dy / d;
      b.x = qx + nx * R; b.y = qy + ny * R;
      const vn = b.vx * nx + b.vy * ny;
      if (vn >= 0) continue;
      // Tangent direction is (ny, -nx). Side spin throws the ball along it.
      let vt = b.vx * ny - b.vy * nx;
      const grip = Math.min(1, -vn / 900 + 0.35);
      vt = vt * 0.96 + b.side * 0.28 * grip;
      const vnOut = -vn * e;
      b.vx = nx * vnOut + ny * vt;
      b.vy = ny * vnOut - nx * vt;
      b.side *= 0.5;
      b.sx *= 0.3; b.sy *= 0.3;
      out?.push({ type: 'cushion', id: b.id, speed: -vn });
    }
  }

  // Pockets.
  for (let i = 0; i < n; i++) {
    const b = balls[i];
    if (!b.on) continue;
    for (let p = 0; p < table.pockets.length; p++) {
      const pk = table.pockets[p];
      // A ball falls once its centre is over the hole: nothing is holding it up any more.
      const hx = b.x - pk.hx, hy = b.y - pk.hy;
      const edge = pk.hr - R * 0.5;
      if (hx * hx + hy * hy < edge * edge) {
        pot(world, b, p, out);
        break;
      }
      const rx = b.x - pk.mx, ry = b.y - pk.my;
      const depth = rx * pk.nx + ry * pk.ny;
      if (depth <= pk.drop) continue;
      const lat = rx * -pk.ny + ry * pk.nx;
      if (lat > pk.half + R || lat < -pk.half - R) continue;
      pot(world, b, p, out);
      break;
    }
    // Safety net: anything that escaped the cloth is treated as potted in the nearest pocket.
    if (b.on && (b.x < -R * 3 || b.y < -R * 3 || b.x > table.L + R * 3 || b.y > table.W + R * 3)) {
      let best = 0, bd = Infinity;
      table.pockets.forEach((pk, idx) => {
        const ddx = pk.mx - b.x, ddy = pk.my - b.y;
        const d = ddx * ddx + ddy * ddy;
        if (d < bd) { bd = d; best = idx; }
      });
      pot(world, b, best, out);
    }
  }

  world.time += DT;
}

function pot(world: World, b: Ball, pocket: number, out?: SimEvent[]) {
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const vx = b.vx, vy = b.vy;
  b.on = false;
  b.vx = b.vy = b.sx = b.sy = b.side = 0;
  world.record.potted.push(b.id);
  out?.push({ type: 'pot', id: b.id, pocket, speed, vx, vy });
}

export function isSettled(world: World): boolean {
  for (const b of world.balls) if (b.on && (b.vx !== 0 || b.vy !== 0)) return false;
  return true;
}

/** Run a shot to completion. Used by the host to decide the outcome instantly. */
export function simulate(world: World, shot: ShotParams, maxSeconds = 90): ShotRecord {
  strike(world, shot);
  const maxSteps = Math.ceil(maxSeconds / DT);
  for (let i = 0; i < maxSteps; i++) {
    step(world);
    if (isSettled(world)) break;
  }
  // Freeze anything still moving after the limit.
  for (const b of world.balls) { b.vx = b.vy = b.sx = b.sy = b.side = 0; }
  return world.record;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
