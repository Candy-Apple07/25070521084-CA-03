// The lobby sits over the live table, so the host sees cloth and party rules change behind it.

import QRCode from 'qrcode';
import { chairCount, type MatchSettings, type Mutators, type Seat } from '../core/rules';
import type { Session } from '../net/session';
import { profileForWire, savePrefs } from '../prefs';
import { TABLE_THEMES } from '../render/themes';
import { chipGroup, copyText, h, toast } from './dom';
import { icon } from './icons';
import { openProfile, switchRow } from './profile';

const MUTATORS: Array<{ key: keyof Mutators; name: string; text: string }> = [
  { key: 'bigPockets', name: 'Bucket pockets', text: 'Pockets almost half as wide again. Good for beginners and long pots.' },
  { key: 'iceCloth', name: 'Ice cloth', text: 'Less than half the friction. Balls run and run.' },
  { key: 'rubberCushions', name: 'Rubber cushions', text: 'Cushions give back nearly everything you put in.' },
  { key: 'miniBalls', name: 'Marbles', text: 'Balls shrink by a fifth. The pockets suddenly look huge.' },
];

export function inviteUrl(code: string) {
  return `${location.origin}/t/${code}`;
}

export function buildLobby(session: Session, hooks: { leave(): void; preview(s: MatchSettings): void }): HTMLElement {
  const room = session.room!;
  const me = session.you;
  const isHost = room.hostId === me;
  const s = room.settings;
  const url = inviteUrl(room.code);

  const update = (patch: Partial<MatchSettings>) => {
    const next: MatchSettings = { ...s, ...patch, mutators: { ...s.mutators, ...(patch.mutators ?? {}) } };
    savePrefs({ lastSettings: next });
    hooks.preview(next);
    session.send({ t: 'settings', settings: next });
  };

  // ---- invite
  const qr = h('div.qr', { title: 'Scan to join from a phone' });
  const qrImg = h('img', { alt: 'QR code for the invite link', width: 84, height: 84 }) as HTMLImageElement;
  qr.append(qrImg);
  QRCode.toDataURL(url, { margin: 0, width: 168, color: { dark: '#0b110f', light: '#f1f5f2' } })
    .then((d) => { qrImg.src = d; })
    .catch(() => qr.remove());

  const shareText = `Pull up a chair, I've opened a ${s.game === 'pool8' ? 'pool' : 'snooker'} table on Obsidian: ${url}`;
  const invite = h('section.invite', { 'aria-label': 'Invite' },
    h('div', { style: 'display:grid; gap:10px; min-width:0' },
      h('div', {}, h('div.label', {}, 'Table code'), h('div.code', {}, room.code)),
      h('div.link-box', {}, url.replace(/^https?:\/\//, '')),
      h('div.row', {},
        h('button.btn.btn-sm', { type: 'button', onclick: async () => toast((await copyText(url)) ? 'Invite link copied.' : 'Copy failed. Select the link instead.') }, icon('copy', 16), 'Copy link'),
        'share' in navigator
          ? h('button.btn.btn-sm', { type: 'button', onclick: () => navigator.share({ title: 'Obsidian', text: shareText, url }).catch(() => {}) }, icon('share', 16), 'Share')
          : null,
      ),
    ),
    qr,
  );

  // ---- chairs, grouped by side: chairs are [A1, B1, A2, B2]
  const memberById = (id: string | null) => room.members.find((m) => m.id === id);
  const n = chairCount(s);
  const mine = room.seats.slice(0, n).indexOf(me);
  const chairEl = (chair: number) => {
    const mem = memberById(room.seats[chair]);
    if (mem) {
      const tags = [mem.id === me ? 'You' : '', mem.id === room.hostId ? 'Host' : '', mem.connected ? '' : 'Away'].filter(Boolean).join(' · ');
      return h('div.seat.taken', {},
        h('span.avatar', {}, mem.avatar),
        h('span.nm', {}, mem.name),
        h('small', {}, tags || 'Ready'),
        mem.id === me ? h('button.link', { type: 'button', onclick: () => session.send({ t: 'sit', seat: null }) }, 'Stand up') : null,
      );
    }
    return h('div.seat', {},
      h('span.empty-ring', { 'aria-hidden': 'true' }, icon('user', 18)),
      h('small', {}, 'Empty chair'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => session.send({ t: 'sit', seat: chair }) }, mine === -1 ? 'Sit here' : 'Move here'),
    );
  };
  const seats = s.mode === 'practice'
    ? h('div.seats.one', {}, chairEl(0))
    : h('div.sides', {},
      ...([0, 1] as Seat[]).map((side) => h('div.side', {},
        h('div.side-name', {}, n === 4 ? `Side ${side === 0 ? 'A' : 'B'}` : `Player ${side + 1}`),
        chairEl(side),
        n === 4 ? chairEl(side + 2) : null,
      )),
    );
  const watchers = room.members.filter((m) => !room.seats.slice(0, n).includes(m.id) && m.connected);
  const seated = room.seats.slice(0, n).filter(Boolean).length;

  // ---- settings
  const ro = !isHost;
  const pool = s.game === 'pool8';
  const settings = h('section.settings', {},
    h('h2.section-title', {}, isHost ? 'House rules' : 'House rules, set by the host'),
    fieldset('Game', chipGroup([
      { value: 'snooker', label: 'Snooker' }, { value: 'pool8', label: '8-ball pool' },
    ] as const, s.game ?? 'snooker', (v) => update({ game: v, tableTheme: defaultCloth(v, s.tableTheme) }), ro)),
    fieldset('Players', chipGroup([
      { value: 1, label: 'Singles, 1 v 1' }, { value: 2, label: 'Doubles, 2 v 2' },
    ], s.teamSize ?? 1, (v) => update({ teamSize: v }), ro)),
    fieldset('Match length', chipGroup([1, 3, 5, 7].map((k) => ({ value: k, label: k === 1 ? 'One frame' : `Best of ${k}` })), s.bestOf, (v) => update({ bestOf: v }), ro)),
    pool ? null : fieldset('Reds', chipGroup([15, 10, 6, 3].map((k) => ({ value: k, label: String(k) })), s.reds, (v) => update({ reds: v }), ro)),
    fieldset('Shot clock', chipGroup([0, 20, 30, 60].map((k) => ({ value: k, label: k ? `${k}s` : 'Off' })), s.shotClock, (v) => update({ shotClock: v }), ro)),
    fieldset('Aiming guide', chipGroup([
      { value: 'full', label: 'Full paths' }, { value: 'ghost', label: 'Ghost ball' }, { value: 'line', label: 'Line only' }, { value: 'off', label: 'None' },
    ] as const, s.aimGuide, (v) => update({ aimGuide: v }), ro)),
    fieldset('Cloth', swatches(s.tableTheme, (id) => update({ tableTheme: id }), ro)),
    pool ? null : fieldset('Rules',
      switchRow('Free ball', 'After a foul leaves you snookered, any ball counts as the ball on.', s.freeBall, (v) => update({ freeBall: v }), ro),
      switchRow('Put them back in', 'After a foul you can make the offender play again.', s.playAgain, (v) => update({ playAgain: v }), ro),
    ),
    fieldset('Party rules',
      ...MUTATORS.map((m) => switchRow(m.name, m.text, s.mutators[m.key], (v) => update({ mutators: { ...s.mutators, [m.key]: v } }), ro)),
    ),
  );

  const startBtn = isHost
    ? h('button.btn.btn-gold.btn-lg.btn-block', { type: 'button', disabled: seated < n, onclick: () => session.send({ t: 'start' }) },
      seated < n ? `Waiting for players: ${seated} of ${n}` : h('span', { style: 'display:inline-flex;gap:8px;align-items:center' }, icon('play', 18), 'Start the match'))
    : h('p.status-line', {}, `Waiting for ${memberById(room.hostId)?.name ?? 'the host'} to start.`);

  return h('aside.lobby.panel', { 'aria-label': 'Table lobby' },
    h('div.lobby-head', {},
      h('div', {},
        h('h1', {}, isHost ? 'Your table is open' : `${memberById(room.hostId)?.name ?? 'A friend'}'s table`),
        isHost ? h('p.lede-sm', {}, n === 4 ? 'Send the link to three friends. Each takes an empty chair; anyone after that watches.' : 'Send the link to a friend. Whoever opens it sits opposite you; anyone after that watches.') : null,
      ),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Leave the table', title: 'Leave', onclick: () => hooks.leave() }, icon('logout', 18)),
    ),
    invite,
    seats,
    watchers.length ? h('div.watchers', {}, h('span', { style: 'display:inline-flex;gap:6px;align-items:center' }, icon('eye', 16), `Watching: ${watchers.map((w) => w.name).join(', ')}`)) : null,
    startBtn,
    h('button.btn.btn-ghost.btn-sm', { type: 'button', style: 'justify-self:start', onclick: () => openProfile({ onChange: () => session.send({ t: 'profile', profile: profileForWire() }) }) }, icon('edit', 16), 'Change your name, picture or cue'),
    settings,
  );
}

/** Pool tables are traditionally blue and snooker green; follow that unless a custom cloth was picked. */
export function defaultCloth(game: 'snooker' | 'pool8', current: string): string {
  if (game === 'pool8' && current === 'championship') return 'tournament';
  if (game === 'snooker' && current === 'tournament') return 'championship';
  return current;
}

function fieldset(legend: string, ...children: HTMLElement[]) {
  return h('fieldset', {}, h('legend', {}, legend), ...children);
}

function swatches(current: string, onPick: (id: string) => void, disabled: boolean) {
  const wrap = h('div.swatches', { role: 'group', 'aria-label': 'Cloth colour' });
  for (const t of TABLE_THEMES) {
    wrap.append(h('button.swatch', {
      type: 'button',
      title: t.name,
      'aria-label': t.name,
      'aria-pressed': String(t.id === current),
      disabled,
      style: `background: radial-gradient(circle at 40% 35%, ${t.clothLight}, ${t.cloth} 70%); box-shadow: inset 0 0 0 4px ${t.rail}, inset 0 0 0 5px ${t.trim}`,
      onclick: () => onPick(t.id),
    }));
  }
  return wrap;
}
