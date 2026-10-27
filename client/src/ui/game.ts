// The table screen: draws the match, turns pointer input into shots, plays shots back, and shows
// the scoreboard, controls, chat, reactions and end-of-frame cards.

import { predictAim } from '../core/aim';
import { BOT_ID } from '../core/ai';
import type { Ball, ShotParams } from '../core/physics';
import {
  activeChair, ballOn, canPlaceCue, isDoubles, onLabel, pointsRemaining, rack, sequenceTarget, tableFor,
  type MatchState, type Seat,
} from '../core/rules';
import { groupOf } from '../core/pool8';
import { clampToZone, type HandZone, type TableGeometry } from '../core/table';
import { sfx, setVolume, unlockAudio } from '../audio/sound';
import { Orientations, ShotAnimator } from '../game/animator';
import type { AimState, HostMsg, Member } from '../net/protocol';
import type { Session } from '../net/session';
import { prefs, savePrefs } from '../prefs';
import { MAX_PULL_MM, Renderer3D, type CueDraw, type Frame, type PotAnim } from '../render/renderer3d';
import { BALL_COLORS, poolColor } from '../render/themes';
import { h, toast } from './dom';
import { icon, type IconName } from './icons';
import { buildLobby } from './lobby';
import { maybeShowHowTo, openProfile } from './profile';
import { REPO_URL, shareResult } from './sharecard';

const REACTIONS = ['👏', '🔥', '😮', '😂', '😬', '🫡'];

interface PendingResult { match: MatchState; clockMs: number | null }

export interface GameHooks {
  leave(): void;
  reconnect?(): void;
}

export class GameView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: Renderer3D;
  private table: TableGeometry;
  private tableKey = '';
  match: MatchState | null = null;

  private queue: HostMsg[] = [];
  private anim: ShotAnimator | null = null;
  private animDelayUntil = 0;
  private pending: PendingResult | null = null;
  private replay: ShotAnimator | null = null;
  private replayEndAt = 0;
  private replayOrients = new Orientations();
  private lastShot: { start: Ball[]; params: ShotParams } | null = null;
  private orients = new Orientations();
  private pots: PotAnim[] = [];

  // Local aim.
  private dx = 1;
  private dy = 0;
  private pull = 0;
  private spinX = 0;
  private spinY = 0;
  private place: { x: number; y: number } | null = null;
  private drag: 'place' | 'power-table' | 'aim-touch' | 'power-bar' | null = null;
  private dragStart = { x: 0, y: 0 };
  private awaitingEcho = 0;
  private strike: { t0: number; cue: CueDraw; power: number; hit: boolean } | null = null;
  private lastAimSent = 0;
  private aimDirty = false;
  private myTurnKey = '';

  // Someone else's live cue (an online opponent or the computer).
  private remote: { seat: number; aim: AimState; shown: { dx: number; dy: number; pull: number } } | null = null;

  private clockDeadline: number | null = null;
  private raf = 0;
  private lastT = 0;
  private unsub: Array<() => void> = [];
  private unread = 0;

  // DOM
  private topbar!: HTMLElement;
  private boardEl!: HTMLElement;
  private sides!: [HTMLElement, HTMLElement];
  private midEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private commentaryEl!: HTMLElement;
  private powerRail!: HTMLElement;
  private aimRail!: HTMLElement;
  private powerEl!: HTMLElement;
  private wheelEl!: HTMLElement;
  private spinEl!: HTMLElement;
  private scrimEl!: HTMLElement;
  private lobbyEl: HTMLElement | null = null;
  private chatEl!: HTMLElement;
  private chatLog!: HTMLElement;
  private chatBtn!: HTMLButtonElement;
  private menuEl!: HTMLElement;
  private reactEl!: HTMLElement;
  private hudEls: HTMLElement[] = [];
  private inLobby = false;
  private commentaryTimer: ReturnType<typeof setTimeout> | null = null;
  private overlayKind = '';
  private wheelOffset = 0;

  constructor(private session: Session, private hooks: GameHooks) {
    const settings = session.room?.settings ?? prefs().lastSettings;
    this.table = tableFor(settings);
    this.root = h('div.game');
    this.canvas = h('canvas.table', { 'aria-label': 'Snooker table' }) as HTMLCanvasElement;
    this.root.append(this.canvas);
    this.renderer = new Renderer3D(this.canvas, this.table, settings.tableTheme);
    this.buildHud();
    setVolume(prefs().sound);

    this.unsub.push(session.on((m) => this.onMessage(m)));
    this.unsub.push(session.onClose(() => this.lost()));
    this.bindInput();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey);
  }

  mount(parent: HTMLElement) {
    parent.append(this.root);
    this.onResize();
    if (this.session.room) this.onRoom();
    if (this.session.match) this.applyMatch(this.session.match, null);
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.unsub.forEach((u) => u());
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    this.renderer.dispose();
    this.root.remove();
  }

  // ===========================================================================================
  // Messages

  private onMessage(m: HostMsg) {
    switch (m.t) {
      case 'welcome':
      case 'room':
        this.onRoom();
        if (m.t === 'welcome' && m.match) this.queue.push({ t: 'match', match: m.match, clockMs: null });
        break;
      case 'match':
      case 'shot':
        this.queue.push(m);
        break;
      case 'aim': {
        if (this.myChairs().includes(m.seat)) break;
        const shown = this.remote?.seat === m.seat ? this.remote.shown : { dx: m.aim.dx, dy: m.aim.dy, pull: 0 };
        this.remote = { seat: m.seat, aim: m.aim, shown };
        break;
      }
      case 'chat':
        this.addChat(m.name, m.text);
        if (this.chatEl.hidden && m.from !== this.session.you) {
          this.unread++;
          this.updateChatBadge();
          toast(`${m.name}: ${m.text}`, 3200);
        }
        break;
      case 'react':
        this.floatReaction(m.from, m.name, m.emoji);
        break;
      case 'notice':
        toast(m.text);
        this.addChat('', m.text);
        break;
    }
    this.saveHosting();
  }

  private saveHosting() {
    const s = this.session;
    if (!s.isHost || s.room?.kind !== 'online') return;
    try {
      sessionStorage.setItem('baize.hosting', JSON.stringify({ code: s.room.code, room: s.host!.room, match: s.host!.match }));
    } catch { /* storage full or blocked */ }
  }

  private onRoom() {
    const room = this.session.room!;
    const key = JSON.stringify([room.settings.tableTheme, room.settings.mutators]);
    if (room.status === 'lobby') {
      this.match = null;
      this.closeOverlay();
      if (key !== this.tableKey) this.setTable(tableFor(room.settings), room.settings.tableTheme, key);
      this.showLobby();
    } else {
      this.lobbyEl?.remove();
      this.lobbyEl = null;
    }
    const lobby = room.status === 'lobby';
    for (const el of this.hudEls) el.hidden = lobby;
    if (this.inLobby !== lobby) {
      this.inLobby = lobby;
      this.onResize();
      if (!lobby) maybeShowHowTo();
    } else if (!lobby && !this.hudShown) {
      this.hudShown = true;
      maybeShowHowTo();
    }
    this.updateHud();
    if (this.overlayKind === 'match') this.showEndCard();
  }
  private hudShown = false;

  private showLobby() {
    const fresh = buildLobby(this.session, {
      leave: () => this.hooks.leave(),
      preview: (s) => {
        const key = JSON.stringify([s.tableTheme, s.mutators]);
        if (key !== this.tableKey) this.setTable(tableFor(s), s.tableTheme, key);
      },
    });
    if (this.lobbyEl) this.lobbyEl.replaceWith(fresh);
    else this.root.append(fresh);
    // Keep the scroll position when the lobby re-renders.
    if (this.lobbyEl) fresh.scrollTop = this.lobbyEl.scrollTop;
    this.lobbyEl = fresh;
  }

  private setTable(t: TableGeometry, theme: string, key: string) {
    this.table = t;
    this.tableKey = key;
    this.renderer.setTable(t, theme);
  }

  private processQueue(now: number) {
    while (!this.anim && !this.replay && this.queue.length) {
      const m = this.queue.shift()!;
      if (m.t === 'match') this.applyMatch(m.match, m.clockMs);
      else if (m.t === 'shot') this.startShot(m, now);
    }
  }

  private startShot(m: Extract<HostMsg, { t: 'shot' }>, now: number) {
    this.awaitingEcho = 0;
    const local = this.strike && !this.strike.hit && now - this.strike.t0 < 1500;
    if (!local) {
      // Show the other player's cue going through.
      const cue = m.start[0];
      const pull = this.remote?.shown.pull ?? 0.4;
      this.strike = {
        t0: now, power: m.params.power, hit: false,
        cue: { x: cue.x, y: cue.y, dx: m.params.dx, dy: m.params.dy, pull: Math.max(pull, 0.2), skin: this.skinFor(this.match ? activeChair(this.match) : 0), alpha: 1, spinX: m.params.spinX, spinY: m.params.spinY },
      };
    }
    // The balls start moving the instant the tip arrives.
    this.animDelayUntil = Math.max(now, this.strike!.t0 + strokeTimes(this.strike!.power).contact);
    this.anim = new ShotAnimator(this.table, m.start, m.params, this.orients, {
      onImpact: (i) => this.renderer.impact(i.kind, i.x, i.y, i.speed),
    });
    this.pots = this.anim.pots;
    this.pending = { match: m.result, clockMs: m.clockMs };
    this.lastShot = { start: m.start, params: m.params };
    this.remote = null;
    this.place = null;
    this.updateHud();
  }

  private applyMatch(m: MatchState, clockMs: number | null) {
    const prev = this.match;
    this.match = m;
    const key = JSON.stringify([m.settings.tableTheme, m.settings.mutators]);
    if (key !== this.tableKey) this.setTable(tableFor(m.settings), m.settings.tableTheme, key);
    this.clockDeadline = clockMs !== null ? performance.now() + clockMs : null;

    const newShot = !prev || prev.seq !== m.seq;
    if (newShot && m.lastShot && (!prev || prev.lastShot !== m.lastShot)) {
      const ls = m.lastShot;
      if (ls.text) this.say(ls.text, !!ls.foul);
      if (ls.foul) sfx.foul();
    }
    if (prev && prev.frameNo !== m.frameNo) {
      this.closeOverlay();
      this.orients = new Orientations();
      this.say(`Frame ${m.frameNo}. ${this.nameOf(m.frame.turn)} to break.`, false);
    }

    if (m.frame.over || m.over) this.showEndCard();
    else if (this.overlayKind === 'frame' || this.overlayKind === 'match') this.closeOverlay();

    const d = m.frame.decision;
    if (d && this.controls(d.seat)) this.showDecision();
    else if (this.overlayKind === 'decision') this.closeOverlay();

    // Prepare a fresh turn.
    const turnKey = `${m.frameNo}:${m.seq}:${m.frame.turn}`;
    if (this.canShoot() && turnKey !== this.myTurnKey) {
      this.myTurnKey = turnKey;
      const prevTurn = prev?.frame.turn;
      this.pull = 0;
      this.spinX = 0;
      this.spinY = 0;
      this.place = m.frame.ballInHand ? { x: m.frame.balls[0].x, y: m.frame.balls[0].y } : null;
      if (!prev || prevTurn !== m.frame.turn || this.session.room?.kind === 'local') this.aimAtBallOn();
      if (prev && prevTurn !== m.frame.turn) sfx.turn();
      this.renderSpin();
    }
    this.updateHud();
  }

  // ===========================================================================================
  // Turn helpers

  private myChairs(): number[] { return this.session.myChairs(); }

  /** True if this browser plays for the given side. */
  private controls(side: Seat) { return this.session.mySides().includes(side); }

  canShoot(): boolean {
    const m = this.match;
    return !!m && this.session.room?.status === 'playing' && !this.anim && !this.replay && !m.frame.over && !m.over &&
      !m.frame.decision && this.myChairs().includes(activeChair(m)) && !this.awaitingEcho && this.queue.length === 0;
  }

  /** Where the cue ball may go when in hand. */
  private zone(): HandZone {
    return this.match?.frame.hand ?? 'D';
  }

  private cuePos(): { x: number; y: number } {
    if (this.place) return this.place;
    const c = this.match!.frame.balls[0];
    return { x: c.x, y: c.y };
  }

  private aimAtBallOn() {
    const m = this.match!;
    const c = this.cuePos();
    let best: Ball | null = null;
    let bd = Infinity;
    for (const b of m.frame.balls) {
      if (!ballOn(m, b)) continue;
      const d = (b.x - c.x) ** 2 + (b.y - c.y) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    if (best) this.setAimTo(best.x, best.y);
  }

  private setAimTo(x: number, y: number) {
    const c = this.cuePos();
    const dx = x - c.x, dy = y - c.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 5) return;
    this.dx = dx / d;
    this.dy = dy / d;
    this.aimDirty = true;
  }

  private rotateAim(rad: number) {
    const c = Math.cos(rad), s = Math.sin(rad);
    const dx = this.dx * c - this.dy * s;
    const dy = this.dx * s + this.dy * c;
    const l = Math.sqrt(dx * dx + dy * dy);
    this.dx = dx / l;
    this.dy = dy / l;
    this.aimDirty = true;
  }

  private shoot() {
    const m = this.match;
    if (!m || !this.canShoot()) return;
    if (this.pull < 0.03) return;
    let cueX: number | undefined, cueY: number | undefined;
    if (m.frame.ballInHand) {
      const p = this.cuePos();
      if (!canPlaceCue(this.table, m.frame.balls, p.x, p.y, this.zone())) {
        toast(this.zone() === 'D' ? 'Put the cue ball inside the D, clear of the other balls.' : this.zone() === 'kitchen' ? 'Put the cue ball behind the line, clear of the other balls.' : 'Put the cue ball clear of the other balls.');
        this.pull = 0;
        this.renderPower();
        return;
      }
      cueX = p.x; cueY = p.y;
    }
    const params: ShotParams = { dx: this.dx, dy: this.dy, power: this.pull, spinX: this.spinX, spinY: this.spinY };
    const c = this.cuePos();
    this.strike = { t0: performance.now(), power: this.pull, hit: false, cue: { x: c.x, y: c.y, dx: this.dx, dy: this.dy, pull: this.pull, skin: this.skinFor(activeChair(m)), alpha: 1, spinX: this.spinX, spinY: this.spinY } };
    this.session.send({ t: 'shot', seq: m.seq, params, cueX, cueY });
    this.awaitingEcho = performance.now();
    this.pull = 0;
    this.renderPower();
  }

  private skinFor(chair: number): string {
    return this.memberAt(chair)?.cue ?? 'maple';
  }

  private memberAt(chair: number): Member | undefined {
    const r = this.session.room;
    const id = r?.seats[chair];
    return r?.members.find((x) => x.id === id);
  }

  /** Chairs that make up a side: one in singles, two in doubles. */
  private chairsOf(side: Seat): number[] {
    const s = this.match?.settings ?? this.session.room?.settings;
    return s && isDoubles(s) ? [side, side + 2] : [side];
  }

  /** "Ann" in singles, "Ann & Bob" in doubles. */
  private nameOf(side: Seat): string {
    return this.chairsOf(side).map((c) => this.memberAt(c)?.name ?? `Player ${c + 1}`).join(' & ');
  }

  private playerName(chair: number): string {
    return this.memberAt(chair)?.name ?? `Player ${chair + 1}`;
  }

  // ===========================================================================================
  // Loop

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;

    this.processQueue(now);
    if (this.awaitingEcho && now - this.awaitingEcho > 6000) {
      this.awaitingEcho = 0;
      toast('That shot did not reach the table. Try again.');
    }

    let balls: Ball[];
    let pots = this.pots;
    if (this.replay) {
      if (now > this.animDelayUntil) this.replay.advance(dt, now);
      balls = this.replay.world.balls;
      pots = this.replay.pots;
      if (this.replay.done) {
        if (!this.replayEndAt) this.replayEndAt = now + 900;
        else if (now > this.replayEndAt) { this.replay = null; this.replayEndAt = 0; this.updateHud(); }
      }
    } else if (this.anim) {
      if (now > this.animDelayUntil && this.anim.advance(dt, now)) {
        this.anim = null;
        const p = this.pending;
        this.pending = null;
        if (p) this.applyMatch(p.match, p.clockMs);
      }
      balls = this.anim ? this.anim.world.balls : this.match?.frame.balls ?? [];
    } else if (this.match) {
      balls = this.match.frame.balls;
    } else {
      balls = this.lobbyBalls();
    }

    // Cue ball in hand: show it where it is being placed.
    if (this.place && this.canShoot()) {
      balls = balls.map((b) => (b.id === 0 ? { ...b, x: this.place!.x, y: this.place!.y, on: true } : b));
    } else if (this.remote?.aim.cueX !== undefined && this.match?.frame.ballInHand && !this.anim) {
      const a = this.remote.aim;
      balls = balls.map((b) => (b.id === 0 ? { ...b, x: a.cueX!, y: a.cueY!, on: true } : b));
    }

    let cue: CueDraw | null = null;
    let guide: Frame['guide'] = null;
    const mode = this.match?.settings.aimGuide ?? 'full';
    const stroke = this.strike ? strokeAt(this.strike.cue.pull, this.strike.power, now - this.strike.t0) : null;
    if (this.strike && stroke) {
      cue = { ...this.strike.cue, offsetMm: stroke.offset, alpha: stroke.alpha };
      if (stroke.hit && !this.strike.hit) {
        this.strike.hit = true;
        const c0 = this.strike.cue;
        this.renderer.strikeFx(c0.x, c0.y, c0.dx, c0.dy, this.strike.power);
      }
    } else if (this.canShoot()) {
      const c = this.cuePos();
      cue = { x: c.x, y: c.y, dx: this.dx, dy: this.dy, pull: this.pull, skin: this.skinFor(activeChair(this.match!)), alpha: 1, spinX: this.spinX, spinY: this.spinY };
      guide = { mode, from: c, dx: this.dx, dy: this.dy, pred: predictAim(this.table, balls, c.x, c.y, this.dx, this.dy) };
      this.sendAim(now);
    } else if (this.remote && this.match && !this.anim && !this.replay && this.remote.seat === activeChair(this.match)) {
      const r = this.remote;
      const k = 1 - Math.pow(0.0005, dt);
      r.shown.dx += (r.aim.dx - r.shown.dx) * k;
      r.shown.dy += (r.aim.dy - r.shown.dy) * k;
      r.shown.pull += (r.aim.pull - r.shown.pull) * k;
      const l = Math.sqrt(r.shown.dx ** 2 + r.shown.dy ** 2) || 1;
      const c = balls[0];
      cue = { x: c.x, y: c.y, dx: r.shown.dx / l, dy: r.shown.dy / l, pull: r.shown.pull, skin: this.skinFor(r.seat), alpha: 1, spinX: r.aim.spinX, spinY: r.aim.spinY };
      if (mode !== 'off') guide = { mode: mode === 'full' ? 'ghost' : mode, from: c, dx: cue.dx, dy: cue.dy, pred: predictAim(this.table, balls, c.x, c.y, cue.dx, cue.dy) };
    }

    const placing = this.place && this.canShoot() ? { valid: canPlaceCue(this.table, this.match!.frame.balls, this.place.x, this.place.y, this.zone()), zone: this.zone() } : null;
    const orients = this.replay ? this.replayOrients : this.orients;
    this.renderer.setMode(this.inLobby ? 'orbit' : 'overview');
    this.renderer.draw({ balls, pots, now, cue, guide, placing, labels: prefs().ballLabels, orient: (id) => orients.get(id), moving: (!!this.anim && now > this.animDelayUntil + 280) || !!this.replay });
    this.updateClock(now);
    const can = this.canShoot();
    if (can !== this.lastCan) { this.lastCan = can; this.updateHud(); }
  };
  private lastCan = false;

  private lobbyBalls(): Ball[] {
    const s = this.session.room?.settings;
    if (!s) return [];
    const key = JSON.stringify([s.reds, s.mutators.miniBalls, this.tableKey]);
    if (this.lobbyCache?.key !== key) this.lobbyCache = { key, balls: rack(s, this.table) };
    return this.lobbyCache.balls;
  }
  private lobbyCache: { key: string; balls: Ball[] } | null = null;

  private sendAim(now: number) {
    if (!this.aimDirty || now - this.lastAimSent < 70 || this.session.room?.kind !== 'online') return;
    this.aimDirty = false;
    this.lastAimSent = now;
    const p = this.place;
    this.session.send({ t: 'aim', aim: { dx: this.dx, dy: this.dy, pull: this.pull, spinX: this.spinX, spinY: this.spinY, cueX: p?.x, cueY: p?.y } });
  }

  // ===========================================================================================
  // Input on the table

  private bindInput() {
    const c = this.canvas;
    const local = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    c.addEventListener('pointerdown', (e) => {
      unlockAudio();
      this.closeMenus();
      if (!this.canShoot()) return;
      const { px, py } = local(e);
      const w = this.renderer.toWorld(px, py);
      const m = this.match!;
      if (m.frame.ballInHand) {
        const p = this.cuePos();
        const near = Math.hypot(w.x - p.x, w.y - p.y) < this.table.R * 3.2;
        const inBaulk = this.zone() !== 'table' && w.x < this.table.baulkX + 40;
        if (near || inBaulk) {
          this.drag = 'place';
          this.movePlace(w.x, w.y);
          c.setPointerCapture(e.pointerId);
          return;
        }
      }
      if (e.pointerType === 'mouse') {
        if (e.button !== 0) return;
        this.drag = 'power-table';
        this.dragStart = { x: px, y: py };
      } else {
        // Touch: the cue points where your finger is.
        this.drag = 'aim-touch';
        this.setAimTo(w.x, w.y);
      }
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.canShoot()) return;
      const { px, py } = local(e);
      const w = this.renderer.toWorld(px, py);
      if (this.drag === 'place') this.movePlace(w.x, w.y);
      else if (this.drag === 'aim-touch') this.setAimTo(w.x, w.y);
      else if (this.drag === 'power-table') {
        const cpos = this.cuePos();
        const a = this.renderer.toScreen(cpos.x, cpos.y);
        const b = this.renderer.toScreen(cpos.x + this.dx * 100, cpos.y + this.dy * 100);
        const sl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const along = ((px - this.dragStart.x) * (b.x - a.x) + (py - this.dragStart.y) * (b.y - a.y)) / sl;
        this.pull = Math.max(0, Math.min(1, -along / 240));
        this.aimDirty = true;
        this.renderPower();
      } else if (e.pointerType === 'mouse') {
        if (e.shiftKey) {
          // Fine aim: rotate by a fraction of the pointer's angular movement.
          const cpos = this.cuePos();
          const target = Math.atan2(w.y - cpos.y, w.x - cpos.x);
          const cur = Math.atan2(this.dy, this.dx);
          let d = target - cur;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          this.rotateAim(d * 0.08);
        } else this.setAimTo(w.x, w.y);
      }
    });
    const end = () => {
      if (this.drag === 'power-table') {
        if (this.pull >= 0.03) this.shoot();
        else { this.pull = 0; this.renderPower(); }
      }
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => { this.drag = null; this.pull = 0; this.renderPower(); });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      if (!this.canShoot()) return;
      e.preventDefault();
      this.rotateAim(Math.sign(e.deltaY) * (e.shiftKey ? 0.01 : 0.0025));
      this.spinWheelVisual(Math.sign(e.deltaY) * 6);
    }, { passive: false });
  }

  private movePlace(x: number, y: number) {
    this.place = clampToZone(this.table, this.zone(), x, y);
    this.aimDirty = true;
  }

  private onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (e.key === 'Escape') { this.closeMenus(); if (this.drag) { this.drag = null; this.pull = 0; this.renderPower(); } return; }
    if (!this.canShoot()) return;
    const big = e.shiftKey ? 6 : 1;
    switch (e.key) {
      case 'ArrowLeft': this.rotateAim(-0.0025 * big); this.spinWheelVisual(-6); break;
      case 'ArrowRight': this.rotateAim(0.0025 * big); this.spinWheelVisual(6); break;
      case 'ArrowUp': this.pull = Math.min(1, this.pull + 0.05); this.aimDirty = true; this.renderPower(); break;
      case 'ArrowDown': this.pull = Math.max(0, this.pull - 0.05); this.aimDirty = true; this.renderPower(); break;
      case ' ':
      case 'Enter': this.shoot(); break;
      default: return;
    }
    e.preventDefault();
  };

  private onResize = () => {
    const w = window.innerWidth, hgt = window.innerHeight;
    const portrait = hgt > w * 1.05;
    const short = hgt < 520;
    let pad = portrait
      ? { top: 160, right: 66, bottom: 64, left: 66 }
      : { top: short ? 72 : 104, right: 96, bottom: 56, left: 96 };
    // In the lobby, slide the table out from under the panel when there is room.
    if (this.inLobby) pad = w > 900 ? { top: 40, right: 32, bottom: 40, left: Math.min(520, w * 0.4) } : { top: 16, right: 8, bottom: 16, left: 8 };
    this.renderer.setPadding(pad);
    this.placeRails();
  };

  // ===========================================================================================
  // HUD

  private buildHud() {
    this.sides = [h('div.side-card'), h('div.side-card.right')];
    this.midEl = h('div.mid');
    this.boardEl = h('div.board', { role: 'region', 'aria-label': 'Scoreboard' }, this.sides[0], this.midEl, this.sides[1]);
    this.statusEl = h('div.status', { 'aria-live': 'polite' });
    this.commentaryEl = h('div.commentary', { role: 'status' });

    this.menuEl = h('div.menu.panel', { hidden: true, role: 'menu' });
    const menuBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Menu', onclick: () => this.toggleMenu() }, icon('menu'));
    this.chatBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Chat', onclick: () => this.toggleChat() }, icon('chat')) as HTMLButtonElement;
    const reactBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Send a reaction', onclick: () => { this.reactEl.hidden = !this.reactEl.hidden; this.menuEl.hidden = true; } }, icon('smile'));

    this.chatLog = h('div.chat-log');
    const input = h('input.input', { placeholder: 'Say something nice', maxlength: 240, 'aria-label': 'Chat message' }) as HTMLInputElement;
    const form = h('form.row', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        this.session.send({ t: 'chat', text });
        input.value = '';
      },
    }, input, h('button.btn.btn-sm', { type: 'submit' }, 'Send'));
    this.chatEl = h('div.drawer.panel', { hidden: true },
      h('div.card-head', {}, h('h2', {}, 'Table talk'), h('button.icon-btn', { type: 'button', 'aria-label': 'Close chat', onclick: () => this.toggleChat() }, icon('x', 18))),
      this.chatLog, form);

    this.reactEl = h('div.react-bar', { hidden: true, style: 'right: 12px; top: 64px' });
    for (const e of REACTIONS) {
      this.reactEl.append(h('button', { type: 'button', 'aria-label': `React ${e}`, onclick: () => { this.session.send({ t: 'react', emoji: e }); this.reactEl.hidden = true; } }, e));
    }

    this.scrimEl = h('div.scrim', { hidden: true });
    this.topbar = h('div.topbar', {},
      h('div.group.menu-group', {}, menuBtn),
      h('div.board-slot', {}, this.boardEl),
      h('div.group', {}, reactBtn, this.chatBtn),
    );
    this.buildRails();
    this.root.append(this.topbar, this.statusEl, this.commentaryEl, this.powerRail, this.aimRail, this.menuEl, this.chatEl, this.reactEl, this.scrimEl);
    this.hudEls = [this.boardEl, this.statusEl, this.commentaryEl, this.powerRail, this.aimRail, this.topbar.querySelector('.menu-group') as HTMLElement];
  }

  /** Power bar on one edge; spin and the fine-aim wheel on the other. */
  private buildRails() {
    // ---- power
    this.powerEl = h('div.power', {
      role: 'slider', tabindex: 0,
      'aria-label': 'Power. Drag down to pull the cue back, let go to strike.',
      'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0,
    }, h('div.ticks'), h('div.fill'), h('div.stick'), h('div.pct.num'));
    const setPower = (e: PointerEvent) => {
      const r = this.powerEl.getBoundingClientRect();
      this.pull = Math.max(0, Math.min(1, (e.clientY - r.top - 8) / (r.height - 16)));
      this.aimDirty = true;
      this.renderPower();
    };
    this.powerEl.addEventListener('pointerdown', (e) => {
      unlockAudio();
      if (!this.canShoot()) return;
      this.drag = 'power-bar';
      this.powerEl.setPointerCapture(e.pointerId);
      setPower(e);
    });
    this.powerEl.addEventListener('pointermove', (e) => { if (this.drag === 'power-bar') setPower(e); });
    this.powerEl.addEventListener('pointerup', () => {
      if (this.drag !== 'power-bar') return;
      this.drag = null;
      if (this.pull >= 0.03) this.shoot();
      else { this.pull = 0; this.renderPower(); }
    });
    this.powerEl.addEventListener('pointercancel', () => { this.drag = null; this.pull = 0; this.renderPower(); });
    this.powerRail = h('div.rail', {}, h('span.cap', { 'aria-hidden': 'true' }, 'POWER'), this.powerEl);

    // ---- spin
    this.spinEl = h('div.spin', { role: 'slider', tabindex: 0, 'aria-label': 'Spin: where the cue tip strikes the cue ball. W A S D to adjust.' }, h('div.tip'));
    const setSpin = (e: PointerEvent) => {
      const r = this.spinEl.getBoundingClientRect();
      let x = ((e.clientX - r.left) / r.width) * 2 - 1;
      let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const l = Math.hypot(x, y);
      if (l > 1) { x /= l; y /= l; }
      if (l < 0.14) { x = 0; y = 0; }
      this.spinX = x;
      this.spinY = y;
      this.aimDirty = true;
      this.renderSpin();
    };
    this.spinEl.addEventListener('pointerdown', (e) => { this.spinEl.setPointerCapture(e.pointerId); setSpin(e); });
    this.spinEl.addEventListener('pointermove', (e) => { if (this.spinEl.hasPointerCapture(e.pointerId)) setSpin(e); });
    this.spinEl.addEventListener('dblclick', () => { this.spinX = 0; this.spinY = 0; this.renderSpin(); });
    this.spinEl.addEventListener('keydown', (e) => {
      const step = 0.1;
      if (e.key === 'w') this.spinY = Math.min(1, this.spinY + step);
      else if (e.key === 's') this.spinY = Math.max(-1, this.spinY - step);
      else if (e.key === 'a') this.spinX = Math.max(-1, this.spinX - step);
      else if (e.key === 'd') this.spinX = Math.min(1, this.spinX + step);
      else return;
      this.renderSpin();
    });

    // ---- fine-aim wheel: drag up and down to turn the cue a hair at a time
    this.wheelEl = h('div.wheel', { role: 'slider', tabindex: 0, 'aria-label': 'Fine aim. Drag up or down, or use the arrow keys.' }, h('div.ridges'));
    let lastY = 0;
    this.wheelEl.addEventListener('pointerdown', (e) => {
      if (!this.canShoot()) return;
      lastY = e.clientY;
      this.wheelEl.setPointerCapture(e.pointerId);
    });
    this.wheelEl.addEventListener('pointermove', (e) => {
      if (!this.wheelEl.hasPointerCapture(e.pointerId) || !this.canShoot()) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      this.rotateAim(dy * 0.0006);
      this.spinWheelVisual(dy);
    });

    this.aimRail = h('div.rail', {}, h('span.cap', { 'aria-hidden': 'true' }, 'SPIN'), this.spinEl, h('span.cap', { 'aria-hidden': 'true', style: 'margin-top:6px' }, 'AIM'), this.wheelEl);
    this.renderSpin();
    this.renderPower();
  }

  private placeRails() {
    const lefty = prefs().leftHanded;
    this.powerRail.className = `rail ${lefty ? 'right' : 'left'}`;
    this.aimRail.className = `rail ${lefty ? 'left' : 'right'}`;
  }

  private spinWheelVisual(dy: number) {
    this.wheelOffset = (this.wheelOffset + dy) % 12;
    (this.wheelEl.firstChild as HTMLElement).style.transform = `translateY(${this.wheelOffset}px)`;
  }

  private renderSpin() {
    const tip = this.spinEl?.querySelector('.tip') as HTMLElement | null;
    if (!tip) return;
    tip.style.left = `${50 + this.spinX * 38}%`;
    tip.style.top = `${50 - this.spinY * 38}%`;
    this.spinEl.setAttribute('aria-valuetext', spinWords(this.spinX, this.spinY));
  }

  private renderPower() {
    if (!this.powerEl) return;
    const p = this.pull;
    const fill = this.powerEl.querySelector('.fill') as HTMLElement;
    const stick = this.powerEl.querySelector('.stick') as HTMLElement;
    const pct = this.powerEl.querySelector('.pct') as HTMLElement;
    fill.style.height = `${p * 100}%`;
    stick.style.transform = `translateY(${p * (this.powerEl.clientHeight - 40)}px)`;
    pct.textContent = p > 0 ? `${Math.round(p * 100)}` : '';
    this.powerEl.setAttribute('aria-valuenow', String(Math.round(p * 100)));
    const can = this.canShoot();
    this.powerEl.classList.toggle('disabled', !can);
    this.wheelEl?.classList.toggle('disabled', !can);
  }

  private updateHud() {
    const room = this.session.room;
    const m = this.match;
    if (!room) return;
    const practice = (m?.settings ?? room.settings).mode === 'practice';

    for (const seat of [0, 1] as Seat[]) {
      const card = this.sides[seat];
      card.innerHTML = '';
      if (practice && seat === 1) {
        card.classList.remove('active');
        card.append(
          h('div.faces', {}, h('span.avatar', {}, icon('target', 18))),
          h('div.who', {}, h('div.name', {}, m?.settings.game === 'pool8' ? 'Best run' : 'Best break'), h('div.sub', {}, plural(m?.stats[0].pots ?? 0, 'pot'))),
          h('span.score', {}, String(m?.stats[0].highBreak ?? 0)),
        );
        continue;
      }
      const active = !!m && m.frame.turn === seat && !m.frame.over;
      const upChair = m && isDoubles(m.settings) ? seat + 2 * (m.up?.[seat] ?? 0) : seat;
      const mem = this.memberAt(upChair);
      const doubles = this.chairsOf(seat).length > 1;
      card.classList.toggle('active', active);
      card.classList.toggle('away', !!mem && !mem.connected);
      let sub = '';
      const pool = m?.settings.game === 'pool8';
      const group = pool ? m!.frame.pool?.groups[seat] ?? null : null;
      if (m) {
        if (pool) sub = group ? `${group === 'solid' ? 'Solids' : 'Stripes'}` : m.frame.pool?.broken ? 'Open table' : '';
        if (active && m.frame.currentBreak > 0) sub = pool ? `${sub ? sub + ', ' : ''}run of ${m.frame.currentBreak}` : `Break ${m.frame.currentBreak}`;
        else if (doubles) sub = active ? `${this.playerName(upChair)} at the table` : `${this.playerName(upChair)} up next`;
        else if (active && mem?.id === BOT_ID && !this.anim) sub = 'Thinking…';
        else if (!pool && m.stats[seat].highBreak > 0) sub = `High break ${m.stats[seat].highBreak}`;
        if (mem && !mem.connected) sub = `${mem.name} reconnecting`;
      }
      const faces = h('div.faces', {}, ...this.chairsOf(seat).map((c) => h('span.avatar', { class: doubles && c !== upChair ? 'dim' : '' }, this.memberAt(c)?.avatar ?? '·')));
      // Pool: the group's balls still on the table, as little balls.
      const groupRack = group && m ? h('div.mini-rack', { 'aria-label': `${group}s left` },
        ...m.frame.balls.filter((b) => b.on && groupOf(b.n) === group).map((b) => miniBall(b.n!))) : null;
      card.append(
        faces,
        h('div.who', {}, h('div.name', {}, this.nameOf(seat)), groupRack ?? h('div.sub', {}, sub)),
        h('span.score', {}, String(m?.frame.scores[seat] ?? 0)),
      );
    }
    this.midEl.innerHTML = '';
    if (m && !practice) {
      this.midEl.append(h('div.fs', {}, `${m.frames[0]} – ${m.frames[1]}`), h('div.bo', {}, m.settings.bestOf > 1 ? `Best of ${m.settings.bestOf}` : `Frame ${m.frameNo}`));
    } else {
      this.midEl.append(h('div.fs', {}, practice ? `${m?.frameNo ?? 1}` : '0 – 0'), h('div.bo', {}, practice ? 'Rack' : 'Frames'));
    }

    // Status tags under the board.
    this.statusEl.innerHTML = '';
    if (!m || m.frame.over) { this.renderPower(); return; }
    const f = m.frame;
    if (this.canShoot() && !practice) this.statusEl.append(h('span.tag.go', {}, 'Your shot'));
    const pool = m.settings.game === 'pool8';
    const dot = h('span.ball-dot');
    if (pool) {
      const g = f.pool?.groups[f.turn];
      const left = g ? f.balls.some((b) => b.on && groupOf(b.n) === g) : true;
      dot.style.background = !g ? 'conic-gradient(#f2c014 0 50%, #f6f1e6 0)' : !left ? '#121212' : g === 'solid' ? '#d42a2a' : 'linear-gradient(#f6f1e6 30%, #1d4fc0 30% 70%, #f6f1e6 70%)';
    } else {
      dot.style.background = f.freeBall ? '#ffffff' : f.phase === 'reds' ? BALL_COLORS.red.base : f.phase === 'color'
        ? 'conic-gradient(#e9c21b 0 16%, #0f7a3c 0 33%, #6b3a1c 0 50%, #1347b5 0 66%, #ee7fa6 0 83%, #17161a 0)'
        : BALL_COLORS[sequenceTarget(f.balls) ?? 'black'].base;
    }
    this.statusEl.append(h('span.tag', {}, dot, `On: ${onLabel(m)}`));
    if (!practice && !pool) {
      const rem = pointsRemaining(f);
      this.statusEl.append(h('span.tag', {}, `${rem} left`));
      const lead = f.scores[f.turn] - f.scores[1 - f.turn];
      if (-lead > rem) this.statusEl.append(h('span.tag.hot', {}, 'Needs snookers'));
    }
    if (f.respottedBlack) this.statusEl.append(h('span.tag.warn', {}, 'Re-spotted black'));
    if (f.ballInHand && this.controls(f.turn)) {
      const where = f.hand === 'table' ? 'anywhere' : f.hand === 'kitchen' ? 'behind the line' : 'in the D';
      this.statusEl.append(h('span.tag', {}, `Ball in hand: place it ${where}`));
    }
    if (f.decision && !this.controls(f.decision.seat)) this.statusEl.append(h('span.tag.warn', {}, `${this.nameOf(f.decision.seat)} is choosing`));
    if (this.replay) this.statusEl.append(h('span.tag.warn', {}, icon('replay', 14), 'Replay'));
    this.statusEl.append(h('span.tag', { 'data-clock': '1', hidden: true }));
    this.renderPower();
  }

  private lastClockText = '';
  private updateClock(now: number) {
    const el = this.statusEl.querySelector('[data-clock]') as HTMLElement | null;
    if (!el) return;
    if (this.clockDeadline === null || this.anim || this.match?.frame.over) { el.hidden = true; return; }
    const left = Math.max(0, Math.ceil((this.clockDeadline - now) / 1000));
    const text = `${left}s`;
    if (text !== this.lastClockText) {
      this.lastClockText = text;
      el.textContent = `Shot clock ${text}`;
      el.className = left <= 5 ? 'tag hot' : 'tag';
    }
    el.hidden = false;
  }

  private say(text: string, foul: boolean) {
    this.commentaryEl.textContent = text;
    this.commentaryEl.classList.toggle('foul', foul);
    if (this.commentaryTimer) clearTimeout(this.commentaryTimer);
    this.commentaryTimer = setTimeout(() => { this.commentaryEl.textContent = ''; }, 5200);
  }

  // ===========================================================================================
  // Overlays

  private openOverlay(kind: string, card: HTMLElement) {
    this.overlayKind = kind;
    this.scrimEl.innerHTML = '';
    this.scrimEl.append(card);
    this.scrimEl.hidden = false;
  }

  private closeOverlay() {
    this.overlayKind = '';
    this.scrimEl.hidden = true;
    this.scrimEl.innerHTML = '';
  }

  private card(ic: IconName | null, title: string, ...body: Array<HTMLElement | string | null>) {
    return h('div.card.panel', { role: 'dialog', 'aria-label': title },
      ic ? h('div.eyebrow-icon', { class: ic === 'flag' ? 'red' : '' }, icon(ic, 24)) : null,
      h('h2', {}, title),
      ...body,
    );
  }

  private showDecision() {
    const m = this.match!;
    const d = m.frame.decision!;
    const foul = m.lastShot?.foul;
    const offender = this.nameOf(d.offender);
    const local = this.session.room?.kind === 'local';
    const who = local ? this.nameOf(d.seat) : 'you';
    this.openOverlay('decision', this.card('flag', foul ? `Foul by ${offender}` : 'Your call',
      h('p', {}, foul ? `${cap(foul.reason)}. ${foul.penalty} points to ${who}.` : ''),
      d.freeBall ? h('p', {}, `${local ? cap(who) + ' is' : "You're"} snookered, so it's a free ball: any ball can be played as the ball on.`) : null,
      h('div.actions', {},
        h('button.btn.btn-gold', { type: 'button', onclick: () => { this.session.send({ t: 'decide', seq: m.seq, choice: 'play' }); this.closeOverlay(); } }, d.freeBall ? 'Take the free ball' : 'Play from here'),
        m.settings.playAgain ? h('button.btn', { type: 'button', onclick: () => { this.session.send({ t: 'decide', seq: m.seq, choice: 'putBack' }); this.closeOverlay(); } }, `Make ${offender} play again`) : null,
      ),
    ));
  }

  private showEndCard() {
    const m = this.match;
    if (!m) return;
    const practice = m.settings.mode === 'practice';
    const seated = this.myChairs().length > 0 || this.session.isHost;
    const f = m.frame;
    if (practice) {
      this.openOverlay('frame', this.card('trophy', 'Table cleared',
        h('p', {}, `Best break so far: ${m.stats[0].highBreak}. ${m.stats[0].pots} pots from ${m.stats[0].shots} shots.`),
        h('div.actions', {}, h('button.btn.btn-gold', { type: 'button', onclick: () => this.session.send({ t: 'nextFrame', seq: m.seq }) }, 'Rack them up again')),
      ));
      return;
    }
    const w = f.winner ?? 0;
    const statRows: Array<[string, (s: Seat) => string]> = [
      ['Frame score', (s) => String(f.scores[s])],
      ['Highest break', (s) => String(m.stats[s].highBreak)],
      ['Balls potted', (s) => String(m.stats[s].pots)],
      ['Fouls', (s) => String(m.stats[s].fouls)],
    ];
    const table = h('table.stats', {},
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, this.nameOf(0)), h('th', {}, this.nameOf(1)))),
      h('tbody', {}, ...statRows.map(([label, fn]) => h('tr', {}, h('td', {}, label), h('td.big', {}, fn(0)), h('td.big', {}, fn(1))))),
    );
    if (!m.over) {
      this.openOverlay('frame', this.card('trophy', `${this.nameOf(w)} takes frame ${m.frameNo}`,
        h('p', {}, `Frames ${m.frames[0]}–${m.frames[1]}. First to ${Math.floor(m.settings.bestOf / 2) + 1} wins.`),
        table,
        h('div.actions', {}, seated
          ? h('button.btn.btn-gold', { type: 'button', onclick: () => this.session.send({ t: 'nextFrame', seq: m.seq }) }, 'Next frame')
          : h('p', {}, 'Waiting for the players to start the next frame.')),
      ));
      return;
    }
    this.showMatchEnd(table);
  }

  private showMatchEnd(table: HTMLElement) {
    const m = this.match!;
    const room = this.session.room!;
    const w = m.winner ?? 0;
    const local = room.kind === 'local';
    const voted = room.rematchVotes.includes(this.session.you);
    const waitingOn = room.seats.filter((s) => s && !room.rematchVotes.includes(s)).map((s) => room.members.find((x) => x.id === s)?.name).filter(Boolean);
    const seated = this.myChairs().length > 0;
    const sideMember = (side: Seat): Member => ({ ...(this.memberAt(side) ?? { id: '', cue: 'maple', connected: true, avatar: '🎱', name: '' }), name: this.nameOf(side) });
    const players: [Member | undefined, Member | undefined] = [sideMember(0), sideMember(1)];
    this.openOverlay('match', this.card('trophy', `${this.nameOf(w)} wins ${m.frames[w]}–${m.frames[1 - w]}`,
      table,
      h('div.actions', {},
        seated ? h('button.btn.btn-gold', { type: 'button', disabled: voted && !local, onclick: () => this.session.send({ t: 'rematch' }) }, voted && !local ? `Waiting for ${waitingOn.join(', ') || 'opponent'}` : 'Rematch') : null,
        h('button.btn', { type: 'button', onclick: () => shareResult(m, players) }, icon('share', 18), 'Share result'),
      ),
      h('div.actions', {},
        this.session.isHost && !local ? h('button.btn.btn-ghost', { type: 'button', onclick: () => this.session.send({ t: 'toLobby' }) }, 'Change settings') : null,
        h('button.btn.btn-ghost', { type: 'button', onclick: () => this.hooks.leave() }, 'Leave table'),
      ),
    ));
  }

  private confirmCard(title: string, body: string, ok: string, run: () => void) {
    this.openOverlay('confirm', h('div.card.panel', { role: 'alertdialog', 'aria-label': title },
      h('h2', {}, title),
      h('p', {}, body),
      h('div.actions', {},
        h('button.btn.btn-gold', { type: 'button', onclick: () => { this.closeOverlay(); run(); } }, ok),
        h('button.btn', { type: 'button', onclick: () => this.closeOverlay() }, 'Keep playing'),
      ),
    ));
  }

  private lost() {
    const guest = !this.session.isHost && this.session.room?.kind === 'online';
    this.openOverlay('lost', this.card('link', guest ? 'Lost the table' : 'Disconnected',
      h('p', {}, guest ? 'The connection to the host dropped. If they are still at the table, you can rejoin and pick up where you left off.' : 'This table has closed.'),
      h('div.actions', {},
        guest && this.hooks.reconnect ? h('button.btn.btn-gold', { type: 'button', onclick: () => this.hooks.reconnect!() }, 'Rejoin') : null,
        h('button.btn', { type: 'button', onclick: () => this.hooks.leave() }, 'Back to the club'),
      ),
    ));
  }

  // ===========================================================================================
  // Menu, chat, reactions

  private closeMenus() {
    this.menuEl.hidden = true;
    this.reactEl.hidden = true;
  }

  private toggleMenu() {
    if (!this.menuEl.hidden) { this.menuEl.hidden = true; return; }
    const p = prefs();
    const m = this.match;
    const room = this.session.room;
    const playing = room?.status === 'playing' && m && !m.frame.over && !m.over;
    const item = (ic: IconName, label: string, run: () => void, val = '', danger = false) =>
      h('button.item', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', onclick: () => { this.menuEl.hidden = true; run(); } }, icon(ic, 18), h('span', {}, label), val ? h('span.val', {}, val) : null);
    this.menuEl.innerHTML = '';
    this.menuEl.append(
      this.lastShot ? item('replay', 'Instant replay', () => this.startReplay(), 'half speed') : '',
      item('help', 'How to play', () => maybeShowHowTo(true)),
      item('user', 'Profile and settings', () => openProfile({ onChange: () => { this.placeRails(); this.updateHud(); } })),
      item(p.sound > 0 ? 'volume' : 'mute', 'Sound', () => {
        const v = p.sound > 0 ? 0 : 0.8;
        savePrefs({ sound: v });
        setVolume(v);
      }, p.sound > 0 ? 'On' : 'Off'),
      item('swap', 'Left-handed controls', () => { savePrefs({ leftHanded: !p.leftHanded }); this.placeRails(); }, p.leftHanded ? 'On' : 'Off'),
      item('hash', 'Numbers on balls', () => savePrefs({ ballLabels: !p.ballLabels }), p.ballLabels ? 'On' : 'Off'),
      h('div.sep'),
      playing && this.myChairs().length ? item('flag', 'Concede frame', () => {
        const seat = this.session.room?.kind === 'local' ? m!.frame.turn : this.session.mySides()[0];
        this.confirmCard('Concede this frame?', `${this.nameOf((1 - seat) as Seat)} will take it.`, 'Concede', () => this.session.send({ t: 'concede', seq: m!.seq, seat }));
      }) : '',
      this.session.isHost && room?.kind === 'online' && room.status === 'playing'
        ? item('sliders', 'Back to the lobby', () => this.confirmCard('End this match?', 'Everyone goes back to the lobby, where you can change the settings.', 'End match', () => this.session.send({ t: 'toLobby' })))
        : '',
      item('logout', 'Leave table', () => this.confirmCard('Leave the table?', this.session.isHost && room?.kind === 'online' ? 'You are hosting, so the table closes for everyone.' : 'You can rejoin with the same link.', 'Leave', () => this.hooks.leave()), '', true),
      h('div.credit', {}, 'Made by ', h('a', { href: 'https://github.com/AtharvaLakhe', target: '_blank', rel: 'noopener' }, 'Atharva Lakhe'), ' · ', h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Star on GitHub')),
    );
    this.menuEl.hidden = false;
    this.chatEl.hidden = true;
    this.reactEl.hidden = true;
  }

  private startReplay() {
    if (!this.lastShot || this.anim) return;
    this.replayOrients = new Orientations();
    this.replay = new ShotAnimator(this.table, this.lastShot.start, this.lastShot.params, this.replayOrients, {
      speed: 0.5,
      onImpact: (i) => this.renderer.impact(i.kind, i.x, i.y, i.speed),
    });
    this.animDelayUntil = performance.now() + 200;
    this.replayEndAt = 0;
    this.updateHud();
  }

  private toggleChat() {
    this.chatEl.hidden = !this.chatEl.hidden;
    this.menuEl.hidden = true;
    this.reactEl.hidden = true;
    if (!this.chatEl.hidden) {
      this.unread = 0;
      this.updateChatBadge();
      (this.chatEl.querySelector('input') as HTMLInputElement)?.focus();
      this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }
  }

  private updateChatBadge() {
    this.chatBtn.querySelector('.badge')?.remove();
    if (this.unread > 0) this.chatBtn.append(h('span.badge', {}, String(Math.min(9, this.unread))));
  }

  private addChat(name: string, text: string) {
    this.chatLog.append(name ? h('div.m', {}, h('b', {}, name), text) : h('div.sys', {}, text));
    while (this.chatLog.children.length > 80) this.chatLog.firstChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  private floatReaction(from: string, name: string, emoji: string) {
    const room = this.session.room;
    const chair = room?.seats.indexOf(from) ?? -1;
    const card = chair >= 0 ? this.sides[chair % 2] : null;
    const rect = card && !this.boardEl.hidden ? card.getBoundingClientRect() : null;
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const y = rect ? rect.bottom + 40 : window.innerHeight * 0.4;
    const el = h('div.float-emoji', { style: `left:${x - 20 + (Math.random() * 40 - 20)}px; top:${y}px` }, emoji, h('small', {}, name));
    this.root.append(el);
    sfx.pop();
    setTimeout(() => el.remove(), 2300);
  }
}

/** Stroke timeline in ms: a short wind-up, an accelerating push, contact, then follow-through. */
function strokeTimes(power: number) {
  const wind = 110;
  const push = 170 - 90 * power;
  const contact = wind + push;
  const follow = 160;
  const hold = 420;
  const fade = 260;
  return { wind, push, contact, follow, end: contact + follow + hold + fade, fadeAt: contact + follow + hold, fade };
}

/** Where the cue tip is (mm behind the ball, negative once through it) at time t into the stroke. */
function strokeAt(pull: number, power: number, t: number): { offset: number; alpha: number; hit: boolean } | null {
  const T = strokeTimes(power);
  if (t > T.end) return null;
  const start = 8 + pull * MAX_PULL_MM;
  const wound = start + 18 + 30 * power;
  const through = -(30 + 170 * power);
  if (t < T.wind) {
    const k = t / T.wind;
    return { offset: start + (wound - start) * (1 - (1 - k) * (1 - k)), alpha: 1, hit: false };
  }
  if (t < T.contact) {
    const k = (t - T.wind) / T.push;
    return { offset: wound * (1 - k * k * k), alpha: 1, hit: false };
  }
  const k = Math.min(1, (t - T.contact) / T.follow);
  const alpha = t > T.fadeAt ? Math.max(0, 1 - (t - T.fadeAt) / T.fade) : 1;
  return { offset: through * (1 - (1 - k) * (1 - k)), alpha, hit: true };
}

function miniBall(n: number): HTMLElement {
  const c = poolColor(n);
  const el = h('span.mini-ball', { title: String(n) });
  el.style.background = n > 8 ? `linear-gradient(#f6f1e6 28%, ${c} 28% 72%, #f6f1e6 72%)` : c;
  return el;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function spinWords(x: number, y: number): string {
  if (Math.abs(x) < 0.05 && Math.abs(y) < 0.05) return 'Centre ball';
  const v = y > 0.15 ? 'top' : y < -0.15 ? 'screw' : '';
  const s = x > 0.15 ? 'right side' : x < -0.15 ? 'left side' : '';
  return [v, s].filter(Boolean).join(' and ') || 'Centre ball';
}
