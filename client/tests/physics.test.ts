import { describe, expect, it } from 'vitest';
import { buildTable } from '../src/core/table';
import { makeWorld, simulate, step, type Ball, type ShotParams } from '../src/core/physics';
import { rack, DEFAULT_SETTINGS } from '../src/core/rules';

const table = buildTable();
const R = table.R;

function ball(id: number, kind: Ball['kind'], x: number, y: number): Ball {
  return { id, kind, x, y, vx: 0, vy: 0, sx: 0, sy: 0, side: 0, on: true };
}

function aim(fromX: number, fromY: number, toX: number, toY: number, power: number, spinY = 0, spinX = 0): ShotParams {
  const dx = toX - fromX, dy = toY - fromY;
  const d = Math.sqrt(dx * dx + dy * dy);
  return { dx: dx / d, dy: dy / d, power, spinX, spinY };
}

describe('physics', () => {
  it('a lone ball slows to a stop on the cloth', () => {
    const w = makeWorld(table, [ball(0, 'cue', 600, 889)]);
    simulate(w, aim(600, 889, 3000, 889, 0.3));
    const c = w.balls[0];
    expect(c.on).toBe(true);
    expect(c.vx).toBe(0);
    expect(c.x).toBeGreaterThan(600);
    expect(c.x).toBeLessThan(table.L);
  });

  it('pots a red along the diagonal into the top-right corner', () => {
    const red = ball(1, 'red', table.L - 300, 300);
    const cue = ball(0, 'cue', table.L - 900, 900);
    const w = makeWorld(table, [cue, red]);
    const rec = simulate(w, aim(cue.x, cue.y, red.x, red.y, 0.45, -0.7));
    expect(rec.firstHit).toBe(1);
    expect(rec.potted).toContain(1);
    expect(rec.potted).not.toContain(0);
  });

  it('pots a ball into the middle pocket', () => {
    const red = ball(1, 'red', table.L / 2, 260);
    const cue = ball(0, 'cue', table.L / 2, 900);
    const w = makeWorld(table, [cue, red]);
    const rec = simulate(w, aim(cue.x, cue.y, red.x, red.y, 0.4));
    expect(rec.potted).toContain(1);
  });

  it('backspin draws the cue ball back after a straight hit', () => {
    const red = ball(1, 'red', 1800, 889);
    const cue = ball(0, 'cue', 1400, 889);
    const w = makeWorld(table, [cue, red]);
    simulate(w, aim(cue.x, cue.y, red.x, red.y, 0.5, -1));
    expect(w.balls[0].x).toBeLessThan(1400 - 2 * R);
  });

  it('topspin makes the cue ball follow through', () => {
    const red = ball(1, 'red', 1800, 889);
    const cue = ball(0, 'cue', 1400, 889);
    const w = makeWorld(table, [cue, red]);
    simulate(w, aim(cue.x, cue.y, red.x, red.y, 0.4, 1));
    expect(w.balls[0].x).toBeGreaterThan(1800);
  });

  it('is deterministic for the same shot', () => {
    const run = () => {
      const balls = rack(DEFAULT_SETTINGS, table);
      const w = makeWorld(table, balls);
      const c = w.balls[0];
      simulate(w, aim(c.x, c.y, 2730, 889 + 30, 0.9, 0.2, 0.3));
      return w.balls.map((b) => [b.on, b.x, b.y]);
    };
    expect(run()).toEqual(run());
  });

  it('a full-power break keeps every ball on the bed or in a pocket and settles', () => {
    const balls = rack(DEFAULT_SETTINGS, table);
    const w = makeWorld(table, balls);
    const c = w.balls[0];
    simulate(w, aim(c.x, c.y, 2730, 889 + 12, 1, 0, 0.5));
    for (const b of w.balls) {
      if (!b.on) continue;
      expect(b.x).toBeGreaterThanOrEqual(R - 0.5);
      expect(b.x).toBeLessThanOrEqual(table.L - R + 0.5);
      expect(b.y).toBeGreaterThanOrEqual(R - 0.5);
      expect(b.y).toBeLessThanOrEqual(table.W - R + 0.5);
    }
    expect(w.time).toBeLessThan(60);
  });
});

describe('pockets', () => {
  it('a ball resting with its centre over the hole drops', () => {
    for (const game of ['snooker', 'pool8'] as const) {
      const t = buildTable(undefined, game);
      const pk = t.pockets[1]; // top-right corner
      const w = makeWorld(t, [ball(0, 'cue', t.L / 2, t.W / 2), ball(1, 'red', pk.mx - pk.nx * 2, pk.my - pk.ny * 2)]);
      step(w);
      expect(w.balls[1].on).toBe(false);
    }
  });

  it('a ball on the cloth beside a corner stays up', () => {
    for (const game of ['snooker', 'pool8'] as const) {
      const t = buildTable(undefined, game);
      const w = makeWorld(t, [ball(0, 'cue', t.L / 2, t.W / 2), ball(1, 'red', t.L - 140, t.R + 1)]);
      step(w);
      expect(w.balls[1].on).toBe(true);
    }
  });

  it('a slow ball rolled into a pool corner falls instead of stopping in the jaws', () => {
    const t = buildTable(undefined, 'pool8');
    const b = ball(1, 'red', t.L - 300, 300);
    const w = makeWorld(t, [ball(0, 'cue', t.L / 2, t.W - 100), b]);
    // Send the object ball straight at the pocket, just hard enough to arrive.
    const target = t.pockets[1];
    const dx = target.mx - b.x, dy = target.my - b.y, d = Math.sqrt(dx * dx + dy * dy);
    w.balls[1].vx = (dx / d) * 520; w.balls[1].vy = (dy / d) * 520;
    w.balls[1].sx = -w.balls[1].vx; w.balls[1].sy = -w.balls[1].vy;
    for (let i = 0; i < 20000 && w.balls[1].on && (w.balls[1].vx || w.balls[1].vy); i++) step(w);
    expect(w.balls[1].on).toBe(false);
  });
});
