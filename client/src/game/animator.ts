// Plays a shot back in real time from the same physics the host used, so every screen sees
// the same balls move. Also tracks each ball's rotation so the spots on the cue ball roll.

import { DT, makeWorld, step, strike, type Ball, type ShotParams, type SimEvent, type World } from '../core/physics';
import type { TableGeometry } from '../core/table';
import type { PotAnim } from '../render/renderer3d';
import { sfx } from '../audio/sound';

/** Something hit something hard enough to show: used for flashes, shake and hit-stop. */
export interface Impact { kind: 'ball' | 'cushion' | 'pot'; x: number; y: number; speed: number }

export interface AnimatorOptions {
  speed?: number;
  sound?: boolean;
  onImpact?: (i: Impact) => void;
}

export class ShotAnimator {
  world: World;
  done = false;
  pots: PotAnim[] = [];
  private acc = 0;
  private events: SimEvent[] = [];
  private freezeUntil = 0;
  private firstContact = true;
  private speed: number;
  private sound: boolean;

  constructor(private table: TableGeometry, start: Ball[], params: ShotParams, private orients: Orientations, private opts: AnimatorOptions = {}) {
    this.world = makeWorld(table, start);
    this.speed = opts.speed ?? 1;
    this.sound = opts.sound ?? true;
    strike(this.world, params);
    this.power = params.power;
  }

  private power = 0;
  private started = false;

  /** Advance by wall-clock seconds. Returns true once everything has stopped. */
  advance(dtSeconds: number, now: number): boolean {
    if (this.done) return true;
    if (!this.started) {
      this.started = true;
      if (this.sound) sfx.strike(this.power);
    }
    // Hit-stop: hold the frame for a moment after a big contact so it lands.
    if (now < this.freezeUntil) return false;
    this.acc += Math.min(dtSeconds, 0.1) * this.speed;
    let guard = 0;
    while (this.acc >= DT && guard++ < 400) {
      this.acc -= DT;
      this.events.length = 0;
      step(this.world, this.events);
      for (const b of this.world.balls) this.orients.spin(b, this.table.R, DT);
      const pan = (x: number) => ((x / this.table.L) * 2 - 1) * 0.7;
      for (const e of this.events) {
        const balls = this.world.balls;
        if (e.type === 'ball') {
          const a = balls[e.a], b = balls[e.b];
          if (this.sound) sfx.ball(e.speed, pan((a.x + b.x) / 2));
          this.opts.onImpact?.({ kind: 'ball', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, speed: e.speed });
          if (this.firstContact && e.speed > 1800 && this.speed >= 1) {
            this.freezeUntil = now + Math.min(90, 30 + e.speed / 80);
          }
          this.firstContact = false;
        } else if (e.type === 'cushion') {
          const b = balls[e.id];
          if (this.sound) sfx.cushion(e.speed, pan(b.x));
          this.opts.onImpact?.({ kind: 'cushion', x: b.x, y: b.y, speed: e.speed });
        } else if (e.type === 'pot') {
          const b = balls[e.id];
          const pk = this.table.pockets[e.pocket];
          this.pots.push({ id: b.id, kind: b.kind, x: b.x, y: b.y, vx: e.vx, vy: e.vy, hx: pk.hx, hy: pk.hy, hr: pk.hr, t0: now });
          if (this.sound) sfx.pot(e.speed, pan(pk.hx));
          this.opts.onImpact?.({ kind: 'pot', x: pk.hx, y: pk.hy, speed: e.speed });
        }
      }
      if (now < this.freezeUntil) break;
      if (this.world.balls.every((b) => !b.on || (b.vx === 0 && b.vy === 0))) {
        this.done = true;
        if (this.sound) sfx.roll(0);
        return true;
      }
    }
    if (this.sound) {
      let total = 0;
      for (const b of this.world.balls) if (b.on) total += Math.abs(b.vx) + Math.abs(b.vy);
      sfx.roll(total);
    }
    if (this.world.time > 90) this.done = true;
    return this.done;
  }
}

/**
 * Visual orientation of every ball as a 3x3 matrix (row-major) in the physics frame:
 * x along the table, y across it, z down into the cloth.
 */
export class Orientations {
  private m = new Map<number, number[]>();

  get(id: number): number[] {
    let o = this.m.get(id);
    if (!o) {
      // Start each ball at a different tilt so spots and numbers don't all line up.
      o = rot(0.7 + id * 0.9, 0.4 + id * 0.37, 0.2 + id * 0.61, 1.1 + id * 0.5);
      this.m.set(id, o);
    }
    return o;
  }

  spin(b: Ball, R: number, dt: number) {
    if (!b.on || (b.vx === 0 && b.vy === 0 && b.side === 0)) return;
    // Angular velocity from the contact patch velocity: s = (R wy, -R wx).
    const wx = -b.sy / R, wy = b.sx / R, wz = -b.side / R;
    const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (w < 1e-6) return;
    const r = rot(wx / w, wy / w, wz / w, w * dt);
    const m = this.get(b.id);
    const out = new Array(9);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        out[i * 3 + j] = r[i * 3] * m[j] + r[i * 3 + 1] * m[3 + j] + r[i * 3 + 2] * m[6 + j];
      }
    }
    this.m.set(b.id, out);
  }
}

function rot(x: number, y: number, z: number, a: number): number[] {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  const kx = x / l, ky = y / l, kz = z / l;
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  return [
    t * kx * kx + c, t * kx * ky - s * kz, t * kx * kz + s * ky,
    t * kx * ky + s * kz, t * ky * ky + c, t * ky * kz - s * kx,
    t * kx * kz - s * ky, t * ky * kz + s * kx, t * kz * kz + c,
  ];
}
