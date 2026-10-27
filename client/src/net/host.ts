// The host is authoritative: it owns the room, runs every shot through the physics engine,
// scores it, and tells everyone what happened. The host's own UI talks to it over a loopback link.

import { makeWorld, simulate, type ShotParams } from '../core/physics';
import {
  activeChair, canPlaceCue, chairCount, concede, decide, nextFrame, newMatch, resolveShot, tableFor, timeOut,
  type MatchSettings, type MatchState, type Seat,
} from '../core/rules';
import { BOT_ID, BOT_PROFILES, planShot, type BotLevel } from '../core/ai';
import type { ClientMsg, HostMsg, Member, Profile, RoomState } from './protocol';
import type { Link } from './transport';

const MAX_MEMBERS = 12;

export class HostRoom {
  room: RoomState;
  match: MatchState | null = null;
  private links = new Map<Link, string | null>();
  private clockTimer: ReturnType<typeof setTimeout> | null = null;
  private clockDeadline = 0;
  private bot: { level: BotLevel } | null = null;
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(code: string, hostId: string, kind: RoomState['kind'], settings: MatchSettings) {
    this.room = {
      code, hostId, kind,
      members: [],
      seats: [null, null, null, null],
      settings,
      status: 'lobby',
      rematchVotes: [],
    };
  }

  addLink(link: Link) {
    this.links.set(link, null);
    link.onMessage = (m) => this.handle(link, m as ClientMsg);
    link.onClose = () => this.dropLink(link);
  }

  destroy() {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    if (this.botTimer) clearTimeout(this.botTimer);
    this.bot = null;
    for (const l of this.links.keys()) l.close();
    this.links.clear();
  }

  // -------------------------------------------------------------------------------------------

  private send(link: Link, msg: HostMsg) { link.send(msg); }

  private broadcast(msg: HostMsg, except?: Link) {
    for (const [l, id] of this.links) if (id && l !== except) l.send(msg);
  }

  private pushRoom() { this.broadcast({ t: 'room', room: this.room }); }

  private member(id: string) { return this.room.members.find((m) => m.id === id); }

  /** The chair this person sits in. On a local table this device plays whoever is up. */
  private chairOf(id: string): number | null {
    if (this.room.kind === 'local' && id === this.room.hostId) {
      // The computer's chair is never ours to play.
      if (this.match && this.room.seats[activeChair(this.match)] === BOT_ID) return this.room.seats.indexOf(id);
      return this.match ? activeChair(this.match) : 0;
    }
    const i = this.room.seats.indexOf(id);
    return i >= 0 && i < chairCount(this.room.settings) ? i : null;
  }

  /** The side (0 or 1) this person plays for. */
  private sideOf(id: string): Seat | null {
    const c = this.chairOf(id);
    return c === null ? null : ((c % 2) as Seat);
  }

  private clearSeat(id: string) {
    this.room.seats = this.room.seats.map((s) => (s === id ? null : s));
  }

  private isLocalHost(id: string) {
    return this.room.kind === 'local' && id === this.room.hostId;
  }

  private dropLink(link: Link) {
    const id = this.links.get(link);
    this.links.delete(link);
    if (!id) return;
    const stillLinked = [...this.links.values()].includes(id);
    const m = this.member(id);
    if (m && !stillLinked) {
      m.connected = false;
      if (this.room.status === 'lobby') {
        this.room.members = this.room.members.filter((x) => x.id !== id);
        this.clearSeat(id);
      }
      this.broadcast({ t: 'notice', text: `${m.name} left the table.` });
      this.pushRoom();
    }
  }

  private handle(link: Link, msg: ClientMsg) {
    if (!msg || typeof msg !== 'object') return;
    const id = this.links.get(link);
    if (msg.t === 'hello') return this.hello(link, msg.clientId, msg.profile);
    if (!id) return;
    const isHost = id === this.room.hostId;
    const chair = this.chairOf(id);
    const side = this.sideOf(id);

    switch (msg.t) {
      case 'profile': {
        const m = this.member(id);
        if (m) Object.assign(m, cleanProfile(msg.profile));
        this.pushRoom();
        break;
      }
      case 'chat': {
        const text = String(msg.text ?? '').slice(0, 240).trim();
        if (text) this.broadcast({ t: 'chat', from: id, name: this.member(id)?.name ?? '?', text });
        break;
      }
      case 'react':
        this.broadcast({ t: 'react', from: id, name: this.member(id)?.name ?? '?', emoji: String(msg.emoji).slice(0, 8) });
        break;
      case 'aim':
        if (chair !== null && this.match && chair === activeChair(this.match)) {
          this.broadcast({ t: 'aim', seat: chair, aim: msg.aim }, link);
        }
        break;
      case 'settings':
        if (isHost && this.room.status === 'lobby') {
          this.room.settings = msg.settings;
          // Going from doubles to singles sends the extra players to watch.
          const n = chairCount(msg.settings);
          this.room.seats = this.room.seats.map((s, i) => (i < n ? s : null));
          this.pushRoom();
        }
        break;
      case 'sit': {
        if (this.room.status !== 'lobby' || this.room.kind === 'local') break;
        const want = msg.seat;
        if (want !== null && (typeof want !== 'number' || want < 0 || want >= chairCount(this.room.settings) || this.room.seats[want] !== null)) break;
        this.clearSeat(id);
        if (want !== null) this.room.seats[want] = id;
        this.pushRoom();
        break;
      }
      case 'start':
        if (isHost) this.start();
        break;
      case 'shot':
        this.shot(id, msg.seq, msg.params, msg.cueX, msg.cueY);
        break;
      case 'decide': {
        const m = this.match;
        if (!m || m.seq !== msg.seq || !m.frame.decision) break;
        if (side !== m.frame.decision.seat && !this.isLocalHost(id)) break;
        this.setMatch(decide(m, msg.choice));
        break;
      }
      case 'concede': {
        const m = this.match;
        if (!m || m.seq !== msg.seq || m.frame.over) break;
        const s = this.isLocalHost(id) ? msg.seat : side;
        if (s === null) break;
        this.setMatch(concede(m, s));
        break;
      }
      case 'nextFrame': {
        const m = this.match;
        if (!m || m.seq !== msg.seq || !m.frame.over || m.over) break;
        if (chair === null && !isHost) break;
        this.setMatch(nextFrame(m));
        break;
      }
      case 'rematch': {
        if (!this.match?.over) break;
        if (chair === null && !isHost) break;
        if (!this.room.rematchVotes.includes(id)) this.room.rematchVotes.push(id);
        if (this.bot && !this.room.rematchVotes.includes(BOT_ID)) this.room.rematchVotes.push(BOT_ID);
        const seated = new Set(this.room.seats.slice(0, chairCount(this.room.settings)).filter(Boolean));
        const ready = [...seated].every((s) => this.room.rematchVotes.includes(s as string));
        if (ready) this.start();
        else this.pushRoom();
        break;
      }
      case 'toLobby':
        if (isHost) {
          this.room.status = 'lobby';
          this.match = null;
          this.stopClock();
          this.room.members = this.room.members.filter((m) => m.connected);
          this.room.seats = this.room.seats.map((s) => (s && this.member(s) ? s : null));
          this.pushRoom();
        }
        break;
    }
  }

  private hello(link: Link, clientId: string, profile: Profile) {
    const id = String(clientId).slice(0, 64);
    let m = this.member(id);
    if (!m) {
      if (this.room.members.length >= MAX_MEMBERS) {
        this.send(link, { t: 'notice', text: 'This table is full.' });
        link.close();
        return;
      }
      m = { id, ...cleanProfile(profile), connected: true } as Member;
      this.room.members.push(m);
      if (this.room.status === 'lobby' && this.room.kind === 'online') {
        const n = chairCount(this.room.settings);
        const free = this.room.seats.findIndex((s, i) => s === null && i < n);
        if (free !== -1) this.room.seats[free] = id;
      }
      if (id !== this.room.hostId) this.broadcast({ t: 'notice', text: `${m.name} joined the table.` });
    } else {
      Object.assign(m, cleanProfile(profile));
      m.connected = true;
      if (id !== this.room.hostId) this.broadcast({ t: 'notice', text: `${m.name} is back.` });
    }
    this.links.set(link, id);
    this.send(link, { t: 'welcome', you: id, room: this.room, match: this.match });
    if (this.match) this.send(link, { t: 'match', match: this.match, clockMs: this.clockLeft() });
    this.pushRoom();
  }

  /** Local rooms: seat the host, and for pass-and-play a second player on the same device. */
  seatLocal(seats: RoomState['seats'], second?: Profile) {
    if (second && seats[1]) this.room.members.push({ id: seats[1], ...cleanProfile(second), connected: true });
    this.room.seats = seats;
  }

  /** Seat the computer in a local room's second chair. */
  addBot(level: BotLevel) {
    this.bot = { level };
    this.room.members.push({ id: BOT_ID, ...BOT_PROFILES[level], connected: true });
    this.room.seats[1] = BOT_ID;
  }

  /** If it's the computer's turn (or its decision), play after `delayMs`. */
  private maybeBot(delayMs: number) {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
    const m = this.match;
    const bot = this.bot;
    if (!bot || !m || m.over || m.frame.over) return;
    const botChair = this.room.seats.indexOf(BOT_ID);
    const d = m.frame.decision;
    if (d) {
      if (d.seat === botChair % 2) {
        const seq = m.seq;
        this.botTimer = setTimeout(() => {
          if (this.match?.seq === seq && this.match.frame.decision) this.setMatch(decide(this.match, 'play'));
        }, delayMs + 900);
      }
      return;
    }
    if (activeChair(m) !== botChair) return;
    const seq = m.seq;
    this.botTimer = setTimeout(async () => {
      if (this.match?.seq !== seq || !this.bot) return;
      const plan = await planShot(this.match, bot.level);
      if (this.match?.seq !== seq || !this.bot) return;
      // Line it up where everyone can see, then play.
      const aim = { dx: plan.params.dx, dy: plan.params.dy, spinX: plan.params.spinX, spinY: plan.params.spinY, cueX: plan.cueX, cueY: plan.cueY };
      this.broadcast({ t: 'aim', seat: botChair, aim: { ...aim, pull: 0.1 } });
      setTimeout(() => this.broadcast({ t: 'aim', seat: botChair, aim: { ...aim, pull: Math.max(0.2, plan.params.power) } }), 650);
      setTimeout(() => this.shot(BOT_ID, seq, plan.params, plan.cueX, plan.cueY), 1300);
    }, delayMs + 500);
  }

  /** Bring a table back after the host reloads the page. */
  restore(room: RoomState, match: MatchState | null) {
    this.room = { ...room, members: room.members.map((m) => ({ ...m, connected: m.id === this.room.hostId })) };
    this.match = match;
    this.armClock();
  }

  start() {
    const s = this.room.settings;
    const need = chairCount(s);
    const seated = this.room.seats.slice(0, need).filter(Boolean).length;
    if (seated < need) {
      this.broadcast({ t: 'notice', text: `Every chair needs a player: ${seated} of ${need} are taken.` });
      return;
    }
    const breaker: Seat = s.mode === 'practice' ? 0 : Math.random() < 0.5 ? 0 : 1;
    this.room.status = 'playing';
    this.room.rematchVotes = [];
    this.match = newMatch(s, breaker);
    this.pushRoom();
    this.setMatch(this.match);
  }

  private setMatch(m: MatchState, extraMs = 0) {
    this.match = m;
    this.armClock(extraMs);
    this.broadcast({ t: 'match', match: m, clockMs: this.clockLeft() });
    this.maybeBot(extraMs + 400);
  }

  private shot(id: string, seq: number, params: ShotParams, cueX?: number, cueY?: number) {
    const m = this.match;
    if (!m || m.seq !== seq || m.frame.over || m.frame.decision) return;
    if (this.chairOf(id) !== activeChair(m)) return;
    if (!validParams(params)) return;

    const table = tableFor(m.settings);
    const start = m.frame.balls.map((b) => ({ ...b }));
    if (m.frame.ballInHand) {
      if (typeof cueX !== 'number' || typeof cueY !== 'number') return;
      if (!canPlaceCue(table, start, cueX, cueY, m.frame.hand ?? 'D')) return;
      start[0].x = cueX; start[0].y = cueY; start[0].on = true;
    }
    const world = makeWorld(table, start);
    const record = simulate(world, params);
    const result = resolveShot(m, record, world.balls);
    const animMs = world.time * 1000 + 600;
    this.match = result;
    this.armClock(animMs);
    this.broadcast({ t: 'shot', seq, start, params, result, clockMs: this.clockLeft() });
    this.maybeBot(animMs + 300);
  }

  // ----- shot clock -------------------------------------------------------------------------

  private stopClock() {
    if (this.clockTimer) clearTimeout(this.clockTimer);
    this.clockTimer = null;
    this.clockDeadline = 0;
  }

  private armClock(extraMs = 0) {
    this.stopClock();
    const m = this.match;
    const secs = m?.settings.shotClock ?? 0;
    if (!m || !secs || m.settings.mode === 'practice' || m.frame.over || m.over) return;
    const ms = secs * 1000 + extraMs;
    this.clockDeadline = Date.now() + ms;
    const seq = m.seq;
    this.clockTimer = setTimeout(() => {
      if (this.match && this.match.seq === seq && !this.match.frame.over) {
        const next = this.match.frame.decision ? decide(this.match, 'play') : timeOut(this.match);
        this.setMatch(next);
      }
    }, ms);
  }

  private clockLeft(): number | null {
    return this.clockDeadline ? Math.max(0, this.clockDeadline - Date.now()) : null;
  }
}

function cleanProfile(p: Profile): Profile {
  return {
    name: String(p?.name ?? 'Player').slice(0, 20).trim() || 'Player',
    avatar: String(p?.avatar ?? '🎱').slice(0, 8),
    cue: String(p?.cue ?? 'maple').slice(0, 24),
  };
}

function validParams(p: ShotParams): boolean {
  if (!p) return false;
  const nums = [p.dx, p.dy, p.power, p.spinX, p.spinY];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const len = Math.sqrt(p.dx * p.dx + p.dy * p.dy);
  return len > 0.99 && len < 1.01 && p.power >= 0 && p.power <= 1;
}
