import { describe, expect, it } from 'vitest';
import type { Ball, ShotRecord } from '../src/core/physics';
import {
  activeChair, DEFAULT_SETTINGS, decide, isSnookered, newMatch, resolveShot, respot, tableFor,
  type MatchSettings, type MatchState,
} from '../src/core/rules';

const settings: MatchSettings = { ...DEFAULT_SETTINGS };
const table = tableFor(settings);

const rec = (firstHit: number | null, potted: number[] = []): ShotRecord => ({ firstHit, potted });
const pot = (m: MatchState, ids: number[]) => m.frame.balls.map((b) => (ids.includes(b.id) ? { ...b, on: false } : { ...b }));
const idOf = (m: MatchState, kind: Ball['kind']) => m.frame.balls.find((b) => b.kind === kind)!.id;
const firstRed = (m: MatchState) => m.frame.balls.find((b) => b.kind === 'red' && b.on)!.id;

function start(): MatchState {
  const m = newMatch(settings, 0);
  m.frame.ballInHand = false;
  return m;
}

describe('rules', () => {
  it('a potted red scores one and leaves the shooter on a colour', () => {
    const m = start();
    const r = firstRed(m);
    const n = resolveShot(m, rec(r, [r]), pot(m, [r]));
    expect(n.frame.scores).toEqual([1, 0]);
    expect(n.frame.turn).toBe(0);
    expect(n.frame.phase).toBe('color');
    expect(n.frame.currentBreak).toBe(1);
  });

  it('a colour after a red scores and is respotted', () => {
    let m = start();
    const r = firstRed(m);
    m = resolveShot(m, rec(r, [r]), pot(m, [r]));
    const k = idOf(m, 'black');
    m = resolveShot(m, rec(k, [k]), pot(m, [k]));
    expect(m.frame.scores[0]).toBe(8);
    expect(m.frame.phase).toBe('reds');
    const black = m.frame.balls[k];
    expect(black.on).toBe(true);
    expect(black.x).toBe(table.spots.black.x);
    expect(m.stats[0].highBreak).toBe(8);
  });

  it('missing everything is a four-point foul and the opponent chooses', () => {
    const m = start();
    const n = resolveShot(m, rec(null), pot(m, []));
    expect(n.frame.scores).toEqual([0, 4]);
    expect(n.frame.decision).toMatchObject({ seat: 1, offender: 0 });
    expect(decide(n, 'putBack').frame.turn).toBe(0);
    expect(decide(n, 'play').frame.turn).toBe(1);
  });

  it('hitting the pink first when on a red costs six', () => {
    const m = start();
    const n = resolveShot(m, rec(idOf(m, 'pink')), pot(m, []));
    expect(n.frame.scores).toEqual([0, 6]);
    expect(n.lastShot?.foul?.penalty).toBe(6);
  });

  it('an in-off gives the next player the ball in hand', () => {
    const m = start();
    const r = firstRed(m);
    const n = resolveShot(m, rec(r, [0]), pot(m, [0]));
    expect(n.frame.ballInHand).toBe(true);
    expect(n.frame.balls[0].on).toBe(true);
    expect(n.frame.balls[0].x).toBeLessThanOrEqual(table.baulkX);
    expect(n.frame.scores[1]).toBe(4);
  });

  it('colours stay down once the reds are gone', () => {
    const m = start();
    for (const b of m.frame.balls) if (b.kind === 'red') b.on = false;
    m.frame.phase = 'sequence';
    const y = idOf(m, 'yellow');
    const n = resolveShot(m, rec(y, [y]), pot(m, [y]));
    expect(n.frame.balls[y].on).toBe(false);
    expect(n.frame.scores[0]).toBe(2);
    expect(n.frame.phase).toBe('sequence');
  });

  it('potting the last black with a lead wins the frame and the match', () => {
    const m = start();
    for (const b of m.frame.balls) if (b.kind !== 'cue' && b.kind !== 'black') b.on = false;
    m.frame.phase = 'sequence';
    m.frame.scores = [40, 45];
    const k = idOf(m, 'black');
    const n = resolveShot(m, rec(k, [k]), pot(m, [k]));
    expect(n.frame.over).toBe(true);
    expect(n.frame.winner).toBe(0);
    expect(n.frames).toEqual([1, 0]);
    expect(n.over).toBe(true);
  });

  it('level scores after the black bring a re-spotted black', () => {
    const m = start();
    for (const b of m.frame.balls) if (b.kind !== 'cue' && b.kind !== 'black') b.on = false;
    m.frame.phase = 'sequence';
    m.frame.scores = [40, 47];
    const k = idOf(m, 'black');
    const n = resolveShot(m, rec(k, [k]), pot(m, [k]), { random: () => 0.9 });
    expect(n.frame.over).toBe(false);
    expect(n.frame.respottedBlack).toBe(true);
    expect(n.frame.balls[k].on).toBe(true);
    expect(n.frame.ballInHand).toBe(true);
    expect(n.frame.turn).toBe(1);
  });

  it('respots a colour on the highest free spot when its own is taken', () => {
    const m = start();
    const balls = m.frame.balls;
    const pink = balls[idOf(m, 'pink')];
    const red = balls.find((b) => b.kind === 'red')!;
    red.x = table.spots.pink.x; red.y = table.spots.pink.y;
    pink.on = false;
    balls[idOf(m, 'black')].on = false;
    respot(table, balls, pink);
    expect(pink.x).toBe(table.spots.black.x);
  });

  it('detects a snooker behind a colour', () => {
    const m = start();
    const balls = m.frame.balls;
    for (const b of balls) if (b.kind !== 'cue') b.on = false;
    const red = balls.find((b) => b.kind === 'red')!;
    const blue = balls[idOf(m, 'blue')];
    balls[0].x = 1000; balls[0].y = 889;
    red.on = true; red.x = 2000; red.y = 889;
    blue.on = true; blue.x = 1500; blue.y = 889;
    expect(isSnookered(table, m.frame)).toBe(true);
    blue.y = 600;
    expect(isSnookered(table, m.frame)).toBe(false);
  });
});

describe('doubles', () => {
  const dbl: MatchSettings = { ...DEFAULT_SETTINGS, teamSize: 2 };
  const startDbl = () => {
    const m = newMatch(dbl, 0);
    m.frame.ballInHand = false;
    return m;
  };

  it('rotates A1, B1, A2, B2 as visits end', () => {
    let m = startDbl();
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      order.push(activeChair(m));
      const r = m.frame.balls.find((b) => b.kind === 'red' && b.on)!.id;
      m = resolveShot(m, rec(r), m.frame.balls.map((b) => ({ ...b })));
    }
    expect(order).toEqual([0, 1, 2, 3, 0]);
  });

  it('keeps the same player at the table during a break', () => {
    let m = startDbl();
    const r = m.frame.balls.find((b) => b.kind === 'red' && b.on)!.id;
    m = resolveShot(m, rec(r, [r]), pot(m, [r]));
    expect(activeChair(m)).toBe(0);
  });

  it('putting the offender back returns the same player', () => {
    let m = startDbl();
    m = resolveShot(m, rec(null), pot(m, []));
    expect(activeChair(m)).toBe(1);
    m = decide(m, 'putBack');
    expect(activeChair(m)).toBe(0);
  });
});
