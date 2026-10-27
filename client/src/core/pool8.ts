// 8-ball pool rules. Solids are 1-7, stripes 9-15, and the 8 is pocketed last to win.
// Like the snooker rules these are pure functions; the host runs them and broadcasts the result.
//
// The house version: any foul gives the opponent ball in hand anywhere (behind the head string
// after a scratch on the break). An 8 pocketed on the break is re-spotted. Pocketing the 8 early,
// or on a foul, loses the frame.

import type { Ball, ShotRecord } from './physics';
import { cloneMatch, endVisit, type MatchState, type ResolveOptions, type Seat, type ShotSummary } from './rules';
import { inZone, type TableGeometry } from './table';

export type Group = 'solid' | 'stripe';

export interface PoolState {
  /** Each side's group once the table is no longer open. */
  groups: [Group | null, Group | null];
  /** False until the break has been played. */
  broken: boolean;
}

export const groupOf = (n: number | undefined): Group | 'eight' | null =>
  n === undefined ? null : n === 8 ? 'eight' : n < 8 ? 'solid' : 'stripe';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A rack of fifteen: the 1 at the apex, the 8 in the middle, one of each group in the back corners. */
export function rackPool(table: TableGeometry, random: () => number = Math.random): Ball[] {
  const R = table.R;
  const balls: Ball[] = [];
  const add = (x: number, y: number, n?: number) =>
    balls.push({ id: balls.length, kind: n === undefined ? 'cue' : 'pool', n, x, y, vx: 0, vy: 0, sx: 0, sy: 0, side: 0, on: true });

  add(table.baulkX * 0.8, table.W / 2);
  const order = new Array<number>(15);
  order[0] = 1;
  order[4] = 8;
  const solidBack = random() < 0.5;
  const solids = [2, 3, 4, 5, 6, 7];
  const stripes = [9, 10, 11, 12, 13, 14, 15];
  const take = (arr: number[]) => arr.splice(Math.floor(random() * arr.length), 1)[0];
  order[10] = take(solidBack ? solids : stripes);
  order[14] = take(solidBack ? stripes : solids);
  const rest = [...solids, ...stripes];
  for (let i = 0; i < 15; i++) if (order[i] === undefined) order[i] = rest.splice(Math.floor(random() * rest.length), 1)[0];

  const gap = 0.2;
  const rowDx = Math.sqrt(3) * R + gap;
  let k = 0;
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      add(table.footSpot.x + row * rowDx, table.footSpot.y + (j - row / 2) * (2 * R + gap), order[k++]);
    }
  }
  return balls;
}

function remaining(balls: Ball[], g: Group): number {
  let c = 0;
  for (const b of balls) if (b.on && groupOf(b.n) === g) c++;
  return c;
}

/** Is `b` a legal first object ball for `side` in this frame? */
export function poolBallOn(f: { balls: Ball[]; pool?: PoolState }, b: Ball, side: Seat): boolean {
  if (b.kind !== 'pool') return false;
  const ps = f.pool;
  const g = ps?.groups[side] ?? null;
  if (!g) {
    // Open table: anything but the 8, unless only the 8 is left.
    if (b.n !== 8) return true;
    return !f.balls.some((x) => x.on && x.kind === 'pool' && x.n !== 8);
  }
  if (remaining(f.balls, g) > 0) return groupOf(b.n) === g;
  return b.n === 8;
}

export function poolOnLabel(f: { balls: Ball[]; pool?: PoolState; turn: Seat }): string {
  const ps = f.pool;
  if (!ps?.broken) return 'Break';
  const g = ps.groups[f.turn];
  if (!g) return 'Open table';
  return remaining(f.balls, g) > 0 ? cap(g) + 's' : 'The 8-ball';
}

export function poolLeft(f: { balls: Ball[]; pool?: PoolState }, side: Seat): number | null {
  const g = f.pool?.groups[side];
  return g ? remaining(f.balls, g) : null;
}

/** Put a ball back on the foot spot, or as close behind it as possible. */
function spot(table: TableGeometry, balls: Ball[], b: Ball) {
  const free = (x: number, y: number) => balls.every((o) => !o.on || o.id === b.id || (o.x - x) ** 2 + (o.y - y) ** 2 >= (2 * table.R + 0.5) ** 2);
  for (let x = table.footSpot.x; x < table.L - table.R; x += 1) {
    if (free(x, table.footSpot.y)) { Object.assign(b, { x, y: table.footSpot.y, on: true, vx: 0, vy: 0, sx: 0, sy: 0, side: 0 }); return; }
  }
  for (let x = table.footSpot.x; x > table.R; x -= 1) {
    if (free(x, table.footSpot.y)) { Object.assign(b, { x, y: table.footSpot.y, on: true, vx: 0, vy: 0, sx: 0, sy: 0, side: 0 }); return; }
  }
}

/** After a scratch the cue ball comes back to a sensible default spot; the next player can move it. */
function returnCue(table: TableGeometry, balls: Ball[]) {
  const cue = balls[0];
  Object.assign(cue, { on: true, vx: 0, vy: 0, sx: 0, sy: 0, side: 0 });
  const free = (x: number, y: number) => balls.every((o) => !o.on || o.id === 0 || (o.x - x) ** 2 + (o.y - y) ** 2 >= (2 * table.R + 0.5) ** 2);
  for (let dy = 0; dy < table.W / 2 - table.R; dy += table.R) {
    for (const s of [1, -1]) {
      const x = table.baulkX * 0.8, y = table.W / 2 + s * dy;
      if (inZone(table, 'kitchen', x, y) && free(x, y)) { cue.x = x; cue.y = y; return; }
    }
  }
}

export function resolvePool(prev: MatchState, record: ShotRecord, finalBalls: Ball[], table: TableGeometry, opts: ResolveOptions = {}): MatchState {
  void opts;
  const m = cloneMatch(prev);
  const f = m.frame;
  const practice = m.settings.mode === 'practice';
  const shooter = f.turn;
  const other: Seat = practice ? shooter : ((1 - shooter) as Seat);
  f.balls = finalBalls.map((b) => ({ ...b, vx: 0, vy: 0, sx: 0, sy: 0, side: 0 }));
  const balls = f.balls;
  const ps: PoolState = f.pool ?? { groups: [null, null], broken: false };
  f.pool = ps;
  const stats = m.stats[shooter];
  stats.shots++;

  const breakShot = !ps.broken;
  const first = record.firstHit === null ? null : prev.frame.balls[record.firstHit];
  const potted = record.potted.map((id) => balls[id]);
  const cuePotted = potted.some((b) => b.id === 0);
  const eight = potted.find((b) => b.n === 8);
  const objects = potted.filter((b) => b.kind === 'pool' && b.n !== 8);
  stats.pots += objects.length;

  const reasons: string[] = [];
  if (!first) reasons.push('missed everything');
  else if (!breakShot && !poolBallOn(prev.frame, first, shooter)) reasons.push(`hit the ${first.n === 8 ? '8-ball' : groupOf(first.n)} first`);
  if (cuePotted) reasons.push('scratch');
  const foul = reasons.length > 0;

  const summary: ShotSummary = { seat: shooter, points: objects.length, potted: potted.map((b) => b.kind), foul: foul ? { penalty: 0, reason: reasons.join(', ') } : null, text: '', freeBallUsed: false };
  f.decision = null;
  f.freeBall = false;

  const pass = (handZone: 'kitchen' | 'table' | null) => {
    if (other !== shooter) endVisit(m, shooter);
    f.turn = other;
    f.currentBreak = 0;
    f.ballInHand = handZone !== null;
    f.hand = handZone ?? undefined;
  };
  const tally = () => {
    for (const s of [0, 1] as Seat[]) {
      const g = ps.groups[s];
      f.scores[s] = g ? 7 - remaining(balls, g) : 0;
    }
  };

  if (foul) stats.fouls++;

  // ---- the break
  if (breakShot) {
    ps.broken = true;
    if (eight) { spot(table, balls, eight); summary.text = 'The 8 went down on the break, so it comes back up.'; }
    if (foul) {
      if (cuePotted) returnCue(table, balls);
      pass('kitchen');
      summary.text = `${summary.text} Foul on the break: ${reasons.join(', ')}. Ball in hand behind the line.`.trim();
    } else if (objects.length > 0) {
      f.currentBreak = objects.length;
      f.ballInHand = false;
      summary.text = `${summary.text} ${objects.length} down on the break. Table is open.`.trim();
    } else {
      pass(null);
      summary.text = summary.text || 'Nothing down on the break. Table is open.';
    }
    tally();
    m.lastShot = summary;
    m.seq++;
    return m;
  }

  // ---- the 8-ball decides the frame
  if (eight) {
    const wasOn = poolBallOn(prev.frame, eight, shooter);
    if (practice) {
      if (!balls.some((b) => b.on && b.kind === 'pool')) {
        summary.text = 'Table cleared.';
        return finish(m, shooter, summary);
      }
      spot(table, balls, eight);
      summary.text = 'The 8 went down early, so it comes back up.';
    } else {
      const win = wasOn && !foul;
      summary.text = win ? 'The 8-ball, and the frame.' : foul ? `The 8 went down on a foul (${reasons.join(', ')}). Frame lost.` : 'The 8 went down too early. Frame lost.';
      tally();
      return finish(m, win ? shooter : other, summary);
    }
  }

  if (foul) {
    if (cuePotted) returnCue(table, balls);
    pass('table');
    summary.text = `Foul: ${reasons.join(', ')}. Ball in hand.`;
  } else {
    // An open table is decided by the first ball legally potted.
    if (!ps.groups[shooter] && objects.length > 0 && !practice) {
      const g = groupOf(objects[0].n) as Group;
      ps.groups[shooter] = g;
      ps.groups[other] = g === 'solid' ? 'stripe' : 'solid';
      summary.text = `${cap(g)}s for this player.`;
    }
    const mine = ps.groups[shooter];
    const scored = objects.filter((b) => !mine || groupOf(b.n) === mine).length;
    f.ballInHand = false;
    f.hand = undefined;
    if (scored > 0) {
      f.currentBreak += scored;
      if (f.currentBreak > stats.highBreak) stats.highBreak = f.currentBreak;
      if (!summary.text) summary.text = objects.length === 1 ? `The ${objects[0].n} goes in.` : `${objects.length} balls down.`;
    } else {
      pass(null);
      if (!summary.text) summary.text = objects.length ? 'Only their ball went down.' : 'No pot.';
    }
  }
  if (practice && !balls.some((b) => b.on && b.kind === 'pool')) {
    summary.text = 'Table cleared.';
    return finish(m, shooter, summary);
  }
  tally();
  m.lastShot = summary;
  m.seq++;
  return m;
}

function finish(m: MatchState, winner: Seat, summary: ShotSummary): MatchState {
  const f = m.frame;
  f.over = true;
  f.winner = winner;
  if (m.settings.mode !== 'practice') {
    m.frames[winner]++;
    if (m.frames[winner] > m.settings.bestOf / 2) { m.over = true; m.winner = winner; }
  }
  m.lastShot = summary;
  m.seq++;
  return m;
}
