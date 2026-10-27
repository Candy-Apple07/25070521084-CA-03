// Snooker rules, plus the shared match plumbing that 8-ball (see pool8.ts) plugs into.
// Pure functions over plain data: the host runs these and broadcasts the result.

import { buildTable, BALL_VALUE, COLOR_ORDER, DEFAULT_TUNING, inZone, type BallKind, type Game, type HandZone, type SnookerColour, type TableGeometry, type TableTuning } from './table';
import type { Ball, ShotRecord } from './physics';
import { poolBallOn, poolOnLabel, rackPool, resolvePool, type PoolState } from './pool8';

export type Seat = 0 | 1;
export type Phase = 'reds' | 'color' | 'sequence';
export type AimGuide = 'full' | 'ghost' | 'line' | 'off';

export interface Mutators {
  bigPockets: boolean;
  iceCloth: boolean;
  rubberCushions: boolean;
  miniBalls: boolean;
}

export interface MatchSettings {
  /** Snooker or 8-ball pool. */
  game: Game;
  mode: 'match' | 'practice';
  /** 1 = singles, 2 = doubles (two players a side, alternating visits). */
  teamSize: number;
  reds: number;
  bestOf: number;
  /** Seconds per shot, 0 = off. */
  shotClock: number;
  aimGuide: AimGuide;
  freeBall: boolean;
  playAgain: boolean;
  tableTheme: string;
  mutators: Mutators;
}

export const DEFAULT_SETTINGS: MatchSettings = {
  game: 'snooker',
  mode: 'match',
  teamSize: 1,
  reds: 15,
  bestOf: 1,
  shotClock: 0,
  aimGuide: 'full',
  freeBall: true,
  playAgain: true,
  tableTheme: 'championship',
  mutators: { bigPockets: false, iceCloth: false, rubberCushions: false, miniBalls: false },
};

export function tuningFor(s: MatchSettings): TableTuning {
  return {
    pocketScale: s.mutators.bigPockets ? 1.45 : DEFAULT_TUNING.pocketScale,
    ballScale: s.mutators.miniBalls ? 0.78 : DEFAULT_TUNING.ballScale,
    friction: s.mutators.iceCloth ? 0.45 : DEFAULT_TUNING.friction,
    cushionBounce: s.mutators.rubberCushions ? 0.95 : DEFAULT_TUNING.cushionBounce,
  };
}

export function tableFor(s: MatchSettings): TableGeometry {
  return buildTable(tuningFor(s), s.game ?? 'snooker');
}

export interface Foul { penalty: number; reason: string }

export interface ShotSummary {
  seat: Seat;
  points: number;
  potted: BallKind[];
  foul: Foul | null;
  /** Short line for the commentary strip. */
  text: string;
  freeBallUsed: boolean;
}

export interface Decision {
  /** The player who must choose. */
  seat: Seat;
  /** The player who committed the foul. */
  offender: Seat;
  freeBall: boolean;
}

export interface FrameState {
  balls: Ball[];
  scores: [number, number];
  turn: Seat;
  phase: Phase;
  ballInHand: boolean;
  currentBreak: number;
  /** The current shooter may treat any ball as the ball on. */
  freeBall: boolean;
  decision: Decision | null;
  respottedBlack: boolean;
  over: boolean;
  winner: Seat | null;
  /** Where the cue ball may go when in hand (snooker: always the D). */
  hand?: HandZone;
  /** 8-ball only: groups and whether the break has been played. */
  pool?: PoolState;
}

export interface PlayerStats {
  pots: number;
  shots: number;
  fouls: number;
  highBreak: number;
  centuries: number;
}

export interface MatchState {
  settings: MatchSettings;
  frames: [number, number];
  frameNo: number;
  breaker: Seat;
  frame: FrameState;
  stats: [PlayerStats, PlayerStats];
  over: boolean;
  winner: Seat | null;
  lastShot: ShotSummary | null;
  /** Increments for every resolved shot; guards against stale or duplicate messages. */
  seq: number;
  /** Doubles: which partner (0 or 1) is up for each side. */
  up: [number, number];
}

const COLORS = new Set<BallKind>(COLOR_ORDER);
export const isColor = (k: BallKind) => COLORS.has(k);

// ---------------------------------------------------------------------------------------------
// Setup

export function rack(settings: MatchSettings, table: TableGeometry = tableFor(settings)): Ball[] {
  if (settings.game === 'pool8') return rackPool(table);
  const R = table.R;
  const balls: Ball[] = [];
  const add = (kind: BallKind, x: number, y: number) =>
    balls.push({ id: balls.length, kind, x, y, vx: 0, vy: 0, sx: 0, sy: 0, side: 0, on: true });

  add('cue', table.baulkX - 55, table.dCenter.y + table.dRadius * 0.45);
  for (const k of COLOR_ORDER) {
    const s = table.spots[k as SnookerColour];
    add(k, s.x, s.y);
  }
  const reds = Math.max(1, Math.min(15, Math.round(settings.reds)));
  const gap = 0.15;
  const apexX = table.spots.pink.x + 2 * R + 1.5;
  const rowDx = Math.sqrt(3) * R + gap;
  let placed = 0;
  for (let row = 0; placed < reds; row++) {
    for (let j = 0; j <= row && placed < reds; j++) {
      add('red', apexX + row * rowDx, table.dCenter.y + (j - row / 2) * (2 * R + gap));
      placed++;
    }
  }
  return balls;
}

export function newFrame(settings: MatchSettings, breaker: Seat): FrameState {
  return {
    balls: rack(settings),
    scores: [0, 0],
    turn: breaker,
    phase: 'reds',
    ballInHand: true,
    hand: settings.game === 'pool8' ? 'kitchen' : 'D',
    pool: settings.game === 'pool8' ? { groups: [null, null], broken: false } : undefined,
    currentBreak: 0,
    freeBall: false,
    decision: null,
    respottedBlack: false,
    over: false,
    winner: null,
  };
}

const emptyStats = (): PlayerStats => ({ pots: 0, shots: 0, fouls: 0, highBreak: 0, centuries: 0 });

export function newMatch(settings: MatchSettings, breaker: Seat): MatchState {
  return {
    settings,
    frames: [0, 0],
    frameNo: 1,
    breaker,
    frame: newFrame(settings, breaker),
    stats: [emptyStats(), emptyStats()],
    over: false,
    winner: null,
    lastShot: null,
    seq: 0,
    up: [0, 0],
  };
}

export const isDoubles = (s: MatchSettings) => s.mode === 'match' && s.teamSize === 2;

/** Chairs are laid out [A1, B1, A2, B2]; a chair's side is chair % 2. */
export function chairCount(s: MatchSettings): number {
  return s.mode === 'practice' ? 1 : isDoubles(s) ? 4 : 2;
}

/** The chair whose player is at the table right now. */
export function activeChair(m: MatchState): number {
  const side = m.frame.turn;
  return isDoubles(m.settings) ? side + 2 * (m.up?.[side] ?? 0) : side;
}

/** In doubles, when a side's visit ends its partners swap for next time. */
export function endVisit(m: MatchState, side: Seat) {
  if (!isDoubles(m.settings)) return;
  m.up = m.up ?? [0, 0];
  m.up[side] = 1 - m.up[side];
}

// ---------------------------------------------------------------------------------------------
// Queries

export function redsLeft(balls: Ball[]): number {
  let n = 0;
  for (const b of balls) if (b.on && b.kind === 'red') n++;
  return n;
}

/** Lowest-value colour still on the table, used once the reds are gone. */
export function sequenceTarget(balls: Ball[]): BallKind | null {
  for (const k of COLOR_ORDER) if (balls.some((b) => b.on && b.kind === k)) return k;
  return null;
}

export function isBallOn(f: FrameState, kind: BallKind): boolean {
  if (kind === 'cue') return false;
  switch (f.phase) {
    case 'reds': return kind === 'red';
    case 'color': return isColor(kind);
    case 'sequence': return kind === sequenceTarget(f.balls);
  }
}

/** Human description of what the shooter should hit. */
export function ballOnLabel(f: FrameState): string {
  if (f.freeBall) return 'Free ball';
  switch (f.phase) {
    case 'reds': return 'Red';
    case 'color': return 'Any colour';
    case 'sequence': {
      const t = sequenceTarget(f.balls);
      return t ? cap(t) : '';
    }
  }
}

/** Points still available to be scored on the table. */
export function pointsRemaining(f: FrameState): number {
  const reds = redsLeft(f.balls);
  let colors = 0;
  for (const b of f.balls) if (b.on && isColor(b.kind)) colors += BALL_VALUE[b.kind];
  // While reds remain every colour is worth up to 7 after each red.
  const pending = f.phase === 'color' ? 7 : 0;
  return reds * 8 + colors + pending;
}

// ---------------------------------------------------------------------------------------------
// Placement

function isFree(table: TableGeometry, balls: Ball[], x: number, y: number, ignore: number): boolean {
  const min = 2 * table.R + 0.5;
  for (const b of balls) {
    if (!b.on || b.id === ignore) continue;
    const dx = b.x - x, dy = b.y - y;
    if (dx * dx + dy * dy < min * min) return false;
  }
  return true;
}

export function canPlaceCue(table: TableGeometry, balls: Ball[], x: number, y: number, zone: HandZone = 'D'): boolean {
  return inZone(table, zone, x, y) && isFree(table, balls, x, y, 0);
}

/** Is `b` a legal ball to hit first for whoever is at the table? Works for both games. */
export function ballOn(m: { settings: MatchSettings; frame: FrameState }, b: Ball): boolean {
  if (b.id === 0 || !b.on) return false;
  if (m.settings.game === 'pool8') return poolBallOn(m.frame, b, m.frame.turn);
  return m.frame.freeBall || isBallOn(m.frame, b.kind);
}

/** What the player at the table is on, in words. */
export function onLabel(m: { settings: MatchSettings; frame: FrameState }): string {
  return m.settings.game === 'pool8' ? poolOnLabel(m.frame) : ballOnLabel(m.frame);
}

/** Put a colour back on its spot following the official order of fallbacks. */
export function respot(table: TableGeometry, balls: Ball[], ball: Ball): void {
  const own = table.spots[ball.kind as SnookerColour];
  const place = (x: number, y: number) => {
    ball.x = x; ball.y = y; ball.on = true;
    ball.vx = ball.vy = ball.sx = ball.sy = ball.side = 0;
  };
  if (isFree(table, balls, own.x, own.y, ball.id)) return place(own.x, own.y);
  for (const k of [...COLOR_ORDER].reverse()) {
    const s = table.spots[k as SnookerColour];
    if (isFree(table, balls, s.x, s.y, ball.id)) return place(s.x, s.y);
  }
  // As close as possible to its own spot towards the top cushion, then towards baulk.
  for (let x = own.x; x <= table.L - table.R; x += 1) {
    if (isFree(table, balls, x, own.y, ball.id)) return place(x, own.y);
  }
  for (let x = own.x; x >= table.R; x -= 1) {
    if (isFree(table, balls, x, own.y, ball.id)) return place(x, own.y);
  }
  place(own.x, own.y);
}

// ---------------------------------------------------------------------------------------------
// Snookers

function pathBlocked(R: number, cx: number, cy: number, tx: number, ty: number, blockers: Ball[]): boolean {
  const ex = tx - cx, ey = ty - cy;
  const len2 = ex * ex + ey * ey;
  const lim = 2 * R - 0.01;
  for (const o of blockers) {
    let t = ((o.x - cx) * ex + (o.y - cy) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = o.x - (cx + ex * t), dy = o.y - (cy + ey * t);
    if (dx * dx + dy * dy < lim * lim) return true;
  }
  return false;
}

/** True when no ball on can be struck at both extreme edges without hitting a ball not on. */
export function isSnookered(table: TableGeometry, f: FrameState): boolean {
  const cue = f.balls[0];
  if (!cue.on) return false;
  const R = table.R;
  const targets = f.balls.filter((b) => b.on && isBallOn(f, b.kind));
  if (targets.length === 0) return false;
  const notOn = f.balls.filter((b) => b.on && b.id !== 0 && !isBallOn(f, b.kind));
  for (const t of targets) {
    const dx = t.x - cue.x, dy = t.y - cue.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 2 * R + 0.5) return false;
    const ux = dx / d, uy = dy / d;
    const sin = (2 * R) / d;
    const cos = Math.sqrt(1 - sin * sin);
    let clear = true;
    for (const sgn of [1, -1]) {
      const rx = ux * cos - uy * sin * sgn;
      const ry = uy * cos + ux * sin * sgn;
      const reach = d * cos;
      if (pathBlocked(R, cue.x, cue.y, cue.x + rx * reach, cue.y + ry * reach, notOn)) { clear = false; break; }
    }
    if (clear) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Resolution

export interface ResolveOptions {
  /** Used to pick who plays first on a re-spotted black. */
  random?: () => number;
}

export function cloneMatch(m: MatchState): MatchState {
  return JSON.parse(JSON.stringify(m)) as MatchState;
}

/**
 * Score a finished shot. `record` and `finalBalls` come from the physics simulation.
 * Returns a new state; the input is not modified.
 */
export function resolveShot(prev: MatchState, record: ShotRecord, finalBalls: Ball[], opts: ResolveOptions = {}): MatchState {
  if (prev.settings.game === 'pool8') return resolvePool(prev, record, finalBalls, tableFor(prev.settings), opts);
  const m = cloneMatch(prev);
  const f = m.frame;
  const table = tableFor(m.settings);
  const practice = m.settings.mode === 'practice';
  const shooter = f.turn;
  const other: Seat = practice ? shooter : ((1 - shooter) as Seat);
  const kindOf = (id: number) => finalBalls[id].kind;

  f.balls = finalBalls.map((b) => ({ ...b, vx: 0, vy: 0, sx: 0, sy: 0, side: 0 }));
  const balls = f.balls;
  const stats = m.stats[shooter];
  stats.shots++;

  const firstHit = record.firstHit === null ? null : kindOf(record.firstHit);
  const pottedIds = record.potted;
  const potted = pottedIds.map(kindOf);
  const cuePotted = potted.includes('cue');
  const objectPots = pottedIds.filter((id) => id !== 0);
  const target = f.phase === 'sequence' ? sequenceTarget(prev.frame.balls) : null;
  const freeBallId = f.freeBall && record.firstHit !== null ? record.firstHit : null;

  // Value of the ball on for penalty purposes.
  let onValue = 4;
  if (f.phase === 'reds') onValue = 1;
  else if (f.phase === 'color') onValue = firstHit && isColor(firstHit) ? BALL_VALUE[firstHit] : 4;
  else if (target) onValue = BALL_VALUE[target];

  const hitIsOn = (kind: BallKind, id: number) => {
    if (freeBallId !== null && id === freeBallId) return true;
    if (f.phase === 'reds') return kind === 'red';
    if (f.phase === 'color') return isColor(kind);
    return kind === target;
  };

  let penalty = 0;
  const reasons: string[] = [];
  const addFoul = (value: number, reason: string) => {
    penalty = Math.max(penalty, 4, value);
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (firstHit === null) addFoul(onValue, 'missed everything');
  else if (!hitIsOn(firstHit, record.firstHit!)) addFoul(Math.max(onValue, BALL_VALUE[firstHit]), `hit the ${firstHit} first`);

  // Which pots are legal.
  for (const id of objectPots) {
    const k = kindOf(id);
    let legal = false;
    if (freeBallId !== null && id === freeBallId) legal = true;
    else if (f.phase === 'reds') legal = k === 'red';
    else if (f.phase === 'color') legal = isColor(k) && record.firstHit === id;
    else legal = k === target;
    if (!legal) addFoul(Math.max(onValue, BALL_VALUE[k]), `potted the ${k}`);
  }
  if (cuePotted) addFoul(onValue, 'in-off');

  const summary: ShotSummary = { seat: shooter, points: 0, potted, foul: null, text: '', freeBallUsed: freeBallId !== null };
  f.freeBall = false;
  f.decision = null;

  if (penalty > 0) {
    // ----- Foul -----
    summary.foul = { penalty, reason: reasons.join(', ') };
    stats.fouls++;
    endBreak(m, shooter);
    f.currentBreak = 0;
    if (!practice) f.scores[other] += penalty;

    // Colours come back; reds stay down.
    for (const id of objectPots) {
      const b = balls[id];
      if (isColor(b.kind)) respot(table, balls, b);
    }
    if (cuePotted) placeCueInHand(table, balls);
    f.ballInHand = cuePotted;

    const onlyBlackWasLeft = prev.frame.phase === 'sequence' && target === 'black';
    if (onlyBlackWasLeft && !practice) {
      summary.text = `Foul: ${summary.foul.reason}. ${penalty} away.`;
      finishFrame(m, opts, summary);
      return m;
    }

    f.phase = redsLeft(balls) > 0 ? 'reds' : 'sequence';
    f.turn = other;
    if (other !== shooter) endVisit(m, shooter);
    if (!practice) {
      const freeBall = m.settings.freeBall && !f.ballInHand && isSnookered(table, f);
      if (m.settings.playAgain || freeBall) f.decision = { seat: other, offender: shooter, freeBall };
    }
    summary.text = practice ? `Foul: ${summary.foul.reason}.` : `Foul: ${summary.foul.reason}. ${penalty} points.`;
    m.lastShot = summary;
    m.seq++;
    return m;
  }

  // ----- Legal shot -----
  f.ballInHand = false;
  let points = 0;
  if (f.phase === 'reds') {
    for (const id of objectPots) {
      const b = balls[id];
      points += 1;
      if (isColor(b.kind)) respot(table, balls, b); // free ball colour nominated as a red
    }
  } else if (f.phase === 'color') {
    for (const id of objectPots) {
      points += BALL_VALUE[balls[id].kind];
      respot(table, balls, balls[id]);
    }
  } else if (objectPots.length > 0 && target) {
    points += BALL_VALUE[target];
    for (const id of objectPots) {
      if (balls[id].kind !== target) respot(table, balls, balls[id]);
    }
  }

  summary.points = points;
  stats.pots += objectPots.length;

  if (points > 0) {
    f.scores[shooter] += points;
    f.currentBreak += points;
    const s = m.stats[shooter];
    if (f.currentBreak > s.highBreak) s.highBreak = f.currentBreak;

    if (f.phase === 'reds') f.phase = 'color';
    else if (f.phase === 'color') f.phase = redsLeft(balls) > 0 ? 'reds' : 'sequence';
    summary.text = potText(potted.filter((k) => k !== 'cue'), points, f.currentBreak);

    if (prev.frame.phase === 'sequence' && target === 'black' && !balls.some((b) => b.on && b.kind === 'black')) {
      finishFrame(m, opts, summary);
      return m;
    }
    if (practice && !balls.some((b) => b.on && b.id !== 0)) {
      summary.text = `Table cleared with a ${f.currentBreak} break.`;
      finishFrame(m, opts, summary);
      return m;
    }
  } else {
    endBreak(m, shooter);
    f.phase = redsLeft(balls) > 0 ? 'reds' : 'sequence';
    f.turn = other;
    if (other !== shooter) endVisit(m, shooter);
    f.currentBreak = 0;
    summary.text = firstHit ? 'No pot.' : '';
  }

  m.lastShot = summary;
  m.seq++;
  return m;
}

function endBreak(m: MatchState, seat: Seat) {
  const brk = m.frame.currentBreak;
  if (brk >= 100) m.stats[seat].centuries++;
}

function placeCueInHand(table: TableGeometry, balls: Ball[]) {
  const cue = balls[0];
  cue.on = true;
  cue.vx = cue.vy = cue.sx = cue.sy = cue.side = 0;
  const tries: Array<[number, number]> = [
    [table.baulkX - 55, table.dCenter.y + table.dRadius * 0.45],
    [table.baulkX - 55, table.dCenter.y - table.dRadius * 0.45],
    [table.baulkX - 150, table.dCenter.y],
  ];
  for (const [x, y] of tries) {
    if (canPlaceCue(table, balls, x, y)) { cue.x = x; cue.y = y; return; }
  }
  for (let a = 0; a < 360; a += 10) {
    for (let r = 20; r < table.dRadius; r += 20) {
      const x = table.dCenter.x - Math.abs(Math.cos((a * Math.PI) / 180)) * r;
      const y = table.dCenter.y + Math.sin((a * Math.PI) / 180) * r;
      if (canPlaceCue(table, balls, x, y)) { cue.x = x; cue.y = y; return; }
    }
  }
}

function finishFrame(m: MatchState, opts: ResolveOptions, summary: ShotSummary) {
  const f = m.frame;
  const practice = m.settings.mode === 'practice';
  endBreak(m, summary.seat);
  if (!practice && f.scores[0] === f.scores[1]) {
    // Re-spotted black decides it.
    const table = tableFor(m.settings);
    for (const b of f.balls) if (b.kind !== 'cue') b.on = false;
    const black = f.balls.find((b) => b.kind === 'black')!;
    respot(table, f.balls, black);
    placeCueInHand(table, f.balls);
    f.ballInHand = true;
    f.phase = 'sequence';
    f.respottedBlack = true;
    f.currentBreak = 0;
    f.decision = null;
    f.turn = ((opts.random ?? Math.random)() < 0.5 ? 0 : 1) as Seat;
    summary.text = `${summary.text} Scores level: re-spotted black.`.trim();
    m.lastShot = summary;
    m.seq++;
    return;
  }
  f.over = true;
  f.winner = practice ? 0 : f.scores[0] > f.scores[1] ? 0 : 1;
  if (!practice) {
    m.frames[f.winner]++;
    if (m.frames[f.winner] > m.settings.bestOf / 2) {
      m.over = true;
      m.winner = f.winner;
    }
  }
  m.lastShot = summary;
  m.seq++;
}

/** Start the next frame after one has finished. */
export function nextFrame(prev: MatchState): MatchState {
  const m = cloneMatch(prev);
  const breaker: Seat = m.settings.mode === 'practice' ? 0 : ((1 - m.breaker) as Seat);
  m.breaker = breaker;
  m.frameNo++;
  m.frame = newFrame(m.settings, breaker);
  m.up = [(m.frameNo - 1) % 2, (m.frameNo - 1) % 2];
  m.lastShot = null;
  m.seq++;
  return m;
}

/** The player who must choose after a foul answers. `putBack` makes the offender play again. */
export function decide(prev: MatchState, choice: 'play' | 'putBack'): MatchState {
  const m = cloneMatch(prev);
  const f = m.frame;
  const d = f.decision;
  if (!d) return m;
  f.decision = null;
  if (choice === 'putBack') {
    f.turn = d.offender;
    f.freeBall = false;
    // The same player who fouled goes back to the table.
    endVisit(m, d.offender);
  } else {
    f.turn = d.seat;
    f.freeBall = d.freeBall;
  }
  m.seq++;
  return m;
}

export function concede(prev: MatchState, seat: Seat): MatchState {
  const m = cloneMatch(prev);
  if (m.settings.mode === 'practice') return nextFrame(m);
  const f = m.frame;
  const winner = (1 - seat) as Seat;
  f.over = true;
  f.winner = winner;
  f.decision = null;
  m.frames[winner]++;
  if (m.frames[winner] > m.settings.bestOf / 2) { m.over = true; m.winner = winner; }
  m.lastShot = { seat, points: 0, potted: [], foul: null, text: 'Frame conceded.', freeBallUsed: false };
  m.seq++;
  return m;
}

/** Shot clock ran out: a foul worth the ball on, minimum four. */
export function timeOut(prev: MatchState): MatchState {
  if (prev.settings.game === 'pool8') {
    const m = cloneMatch(prev);
    const f = m.frame;
    const shooter = f.turn;
    m.stats[shooter].fouls++;
    endVisit(m, shooter);
    f.turn = (1 - shooter) as Seat;
    f.currentBreak = 0;
    f.ballInHand = true;
    f.hand = 'table';
    m.lastShot = { seat: shooter, points: 0, potted: [], foul: { penalty: 0, reason: 'shot clock' }, text: 'Out of time. Ball in hand.', freeBallUsed: false };
    m.seq++;
    return m;
  }
  const m = cloneMatch(prev);
  const f = m.frame;
  const shooter = f.turn;
  const other = (1 - shooter) as Seat;
  const target = sequenceTarget(f.balls);
  const onValue = f.phase === 'sequence' && target ? BALL_VALUE[target] : 4;
  const penalty = Math.max(4, onValue);
  f.scores[other] += penalty;
  m.stats[shooter].fouls++;
  f.turn = other;
  endVisit(m, shooter);
  f.currentBreak = 0;
  f.freeBall = false;
  f.decision = null;
  f.phase = redsLeft(f.balls) > 0 ? 'reds' : 'sequence';
  m.lastShot = { seat: shooter, points: 0, potted: [], foul: { penalty, reason: 'shot clock' }, text: `Out of time. ${penalty} points.`, freeBallUsed: false };
  m.seq++;
  return m;
}

function potText(potted: BallKind[], points: number, brk: number): string {
  const names = potted.map((k) => (k === 'red' ? 'red' : k));
  const what = names.length === 1 ? cap(names[0]) : `${names.length} balls`;
  const milestone = brk >= 147 ? ' Maximum!' : brk >= 100 && brk - points < 100 ? ' Century!' : brk >= 50 && brk - points < 50 ? ' Fifty up.' : '';
  return `${what}, ${points}. Break ${brk}.${milestone}`;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
