import { describe, expect, it } from 'vitest';
import type { Ball, ShotRecord } from '../src/core/physics';
import { groupOf, rackPool } from '../src/core/pool8';
import { DEFAULT_SETTINGS, newMatch, resolveShot, tableFor, type MatchSettings, type MatchState } from '../src/core/rules';

const settings: MatchSettings = { ...DEFAULT_SETTINGS, game: 'pool8' };
const table = tableFor(settings);
const rec = (firstHit: number | null, potted: number[] = []): ShotRecord => ({ firstHit, potted });
const byNum = (m: MatchState, n: number) => m.frame.balls.find((b) => b.n === n)!.id;
const pot = (m: MatchState, ids: number[]): Ball[] => m.frame.balls.map((b) => (ids.includes(b.id) ? { ...b, on: false } : { ...b }));

/** A match just after a quiet break, with the table open. */
function afterBreak(): MatchState {
  const m = newMatch(settings, 0);
  m.frame.pool!.broken = true;
  m.frame.ballInHand = false;
  return m;
}

describe('8-ball', () => {
  it('racks fifteen with the 8 in the middle and mixed back corners', () => {
    const balls = rackPool(table);
    const objects = balls.filter((b) => b.kind === 'pool');
    expect(objects.length).toBe(15);
    expect(new Set(objects.map((b) => b.n)).size).toBe(15);
    expect(objects[4].n).toBe(8);
    expect(groupOf(objects[10].n)).not.toBe(groupOf(objects[14].n));
    expect(objects[0].x).toBeCloseTo(table.footSpot.x);
  });

  it('the first legal pot on an open table decides the groups', () => {
    const m = afterBreak();
    const three = byNum(m, 3);
    const n = resolveShot(m, rec(three, [three]), pot(m, [three]));
    expect(n.frame.pool!.groups).toEqual(['solid', 'stripe']);
    expect(n.frame.turn).toBe(0);
    expect(n.frame.scores[0]).toBe(1);
  });

  it('a scratch gives the opponent ball in hand anywhere', () => {
    const m = afterBreak();
    const three = byNum(m, 3);
    const n = resolveShot(m, rec(three, [0]), pot(m, [0]));
    expect(n.frame.turn).toBe(1);
    expect(n.frame.ballInHand).toBe(true);
    expect(n.frame.hand).toBe('table');
    expect(n.frame.balls[0].on).toBe(true);
  });

  it('hitting the other group first is a foul', () => {
    const m = afterBreak();
    m.frame.pool!.groups = ['solid', 'stripe'];
    const n = resolveShot(m, rec(byNum(m, 12)), pot(m, []));
    expect(n.lastShot?.foul).toBeTruthy();
    expect(n.frame.hand).toBe('table');
  });

  it('pocketing the 8 early loses the frame', () => {
    const m = afterBreak();
    m.frame.pool!.groups = ['solid', 'stripe'];
    const eight = byNum(m, 8);
    const one = byNum(m, 1);
    const n = resolveShot(m, rec(one, [eight]), pot(m, [eight]));
    expect(n.frame.over).toBe(true);
    expect(n.frame.winner).toBe(1);
  });

  it('pocketing the 8 after clearing your group wins it', () => {
    const m = afterBreak();
    m.frame.pool!.groups = ['solid', 'stripe'];
    for (const b of m.frame.balls) if (groupOf(b.n) === 'solid') b.on = false;
    const eight = byNum(m, 8);
    const n = resolveShot(m, rec(eight, [eight]), pot(m, [eight]));
    expect(n.frame.over).toBe(true);
    expect(n.frame.winner).toBe(0);
    expect(n.over).toBe(true);
  });

  it('an 8 on the break comes back to the foot spot', () => {
    const m = newMatch(settings, 0);
    const eight = byNum(m, 8);
    const one = byNum(m, 1);
    const n = resolveShot(m, rec(one, [eight]), pot(m, [eight]));
    expect(n.frame.over).toBe(false);
    expect(n.frame.balls[eight].on).toBe(true);
    expect(n.frame.pool!.broken).toBe(true);
  });
});
