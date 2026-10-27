// The client side of a room: what the UI talks to, whether the host is this browser or a friend's.

import { makeCode, type ClientMsg, type HostMsg, type Profile, type RoomState } from './protocol';
import { HostRoom } from './host';
import { hostOnline, joinOnline, type OnlineHost } from './peer';
import { loopbackPair, type Link } from './transport';
import { chairCount, type MatchSettings, type MatchState, type Seat } from '../core/rules';
import { BOT_ID, type BotLevel } from '../core/ai';

type Handler = (msg: HostMsg) => void;

export class Session {
  you = '';
  room: RoomState | null = null;
  match: MatchState | null = null;
  private handlers = new Set<Handler>();
  private closeHandlers = new Set<() => void>();
  private closedByUs = false;

  constructor(private link: Link, readonly host: HostRoom | null, private cleanup: () => void) {
    link.onMessage = (raw) => {
      const msg = raw as HostMsg;
      if (msg.t === 'welcome') { this.you = msg.you; this.room = msg.room; this.match = msg.match; }
      if (msg.t === 'room') this.room = msg.room;
      if (msg.t === 'match') this.match = msg.match;
      if (msg.t === 'shot') this.match = msg.result;
      for (const h of this.handlers) h(msg);
    };
    link.onClose = () => {
      if (!this.closedByUs) for (const h of this.closeHandlers) h();
    };
  }

  get isHost() { return !!this.host; }

  on(h: Handler) { this.handlers.add(h); return () => { this.handlers.delete(h); }; }
  onClose(h: () => void) { this.closeHandlers.add(h); return () => { this.closeHandlers.delete(h); }; }

  send(msg: ClientMsg) { this.link.send(msg); }

  /** Chairs this browser controls. Pass-and-play controls every chair. */
  myChairs(): number[] {
    const r = this.room;
    if (!r) return [];
    const n = chairCount(r.settings);
    if (r.kind === 'local') return r.seats.slice(0, n).flatMap((s, i) => (s === BOT_ID ? [] : [i]));
    return r.seats.slice(0, n).flatMap((s, i) => (s === this.you ? [i] : []));
  }

  /** Sides (0 or 1) this browser plays for. */
  mySides(): Seat[] {
    return [...new Set(this.myChairs().map((c) => (c % 2) as Seat))];
  }

  leave() {
    this.closedByUs = true;
    this.link.close();
    this.host?.destroy();
    this.cleanup();
  }
}

export function clientId(): string {
  // Per tab, so two tabs in one browser count as two people; survives reloads of that tab.
  let id = '';
  try { id = sessionStorage.getItem('baize.clientId') ?? ''; } catch { /* storage blocked */ }
  if (!id) {
    id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { sessionStorage.setItem('baize.clientId', id); } catch { /* storage blocked */ }
  }
  return id;
}

function attachLocal(host: HostRoom, profile: Profile, cleanup: () => void): Session {
  const [hostEnd, clientEnd] = loopbackPair();
  host.addLink(hostEnd);
  const s = new Session(clientEnd, host, cleanup);
  s.send({ t: 'hello', clientId: host.room.hostId, profile });
  return s;
}

/** Practice, pass-and-play or a game against the computer, on this device only. */
export function createLocal(profile: Profile, settings: MatchSettings, second?: Profile, bot?: BotLevel): Session {
  const id = clientId();
  const host = new HostRoom('LOCAL', id, 'local', settings);
  if (settings.mode === 'practice') host.seatLocal([id, null, null, null]);
  else if (bot) {
    host.seatLocal([id, null, null, null]);
    host.addBot(bot);
  } else host.seatLocal([id, 'local-2', null, null], second ?? { name: 'Player 2', avatar: '🐼', cue: 'ebony' });
  const s = attachLocal(host, profile, () => {});
  queueMicrotask(() => host.start());
  return s;
}

export interface SavedTable { code: string; room: RoomState; match: MatchState | null }

/**
 * Open a private online table. Retries with a fresh code if one is taken. With `saved`, reopens
 * the same code (after a reload) so friends can reconnect with the link they already have.
 */
export async function createOnline(profile: Profile, settings: MatchSettings, saved?: SavedTable): Promise<Session> {
  const id = clientId();
  let lastErr: unknown;
  for (let attempt = 0; attempt < (saved ? 6 : 4); attempt++) {
    const code = saved ? saved.code : makeCode();
    const host = new HostRoom(code, id, 'online', settings);
    if (saved) host.restore(saved.room, saved.match);
    let online: OnlineHost;
    try {
      online = await hostOnline(code, (l) => host.addLink(l));
    } catch (e) {
      lastErr = e;
      // The broker can hold a reloaded host's old id for a few seconds.
      if (saved) await new Promise((r) => setTimeout(r, 2500));
      continue;
    }
    return attachLocal(host, profile, () => online.close());
  }
  throw lastErr ?? new Error('Could not open a table');
}

export async function joinRoom(code: string, profile: Profile): Promise<Session> {
  const c = await joinOnline(code);
  const s = new Session(c.link, null, () => {});
  s.send({ t: 'hello', clientId: clientId(), profile });
  return s;
}
