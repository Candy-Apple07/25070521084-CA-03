import { describe, expect, it } from 'vitest';
import { planShot, potLines } from '../src/core/ai';
import { makeWorld, simulate } from '../src/core/physics';
import { canPlaceCue, DEFAULT_SETTINGS, newMatch, tableFor, type MatchState } from '../src/core/rules';

const settings = { ...DEFAULT_SETTINGS };
const table = tableFor(settings);

/** A frame with only the cue ball and one red, the red sitting near the top-right corner. */
function simplePot(): MatchState {
  const m = newMatch(settings, 0);
  m.frame.ballInHand = false;
  const balls = m.frame.balls;
  for (const b of balls) if (b.kind !== 'cue') b.on = false;
  const red = balls.find((b) => b.kind === 'red')!;
  red.on = true;
  red.x = table.L - 420; red.y = 420;
  balls[0].x = table.L - 1100; balls[0].y = 1000;
  return m;
}

describe('computer opponent', () => {
  it('finds the straight pot', () => {
    const m = simplePot();
    const c = m.frame.balls[0];
    const lines = potLines(table, m.frame.balls, c.x, c.y, (b) => b.kind === 'red');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0].pocket.nx).toBeGreaterThan(0);
    expect(lines[0].pocket.ny).toBeLessThan(0);
  });

  it('pots an easy red on hard', async () => {
    let potted = 0;
    for (let i = 0; i < 5; i++) {
      const m = simplePot();
      const shot = await planShot(m, 'hard');
      const w = makeWorld(table, m.frame.balls);
      const rec = simulate(w, shot.params);
      if (rec.potted.some((id) => m.frame.balls[id].kind === 'red')) potted++;
    }
    expect(potted).toBeGreaterThanOrEqual(4);
  });

  it('places the cue ball legally in the D when breaking off', async () => {
    const m = newMatch(settings, 0);
    const shot = await planShot(m, 'medium');
    expect(shot.cueX).toBeDefined();
    expect(canPlaceCue(table, m.frame.balls, shot.cueX!, shot.cueY!)).toBe(true);
    expect(Number.isFinite(shot.params.dx) && Number.isFinite(shot.params.power)).toBe(true);
  });
});
