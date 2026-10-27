// The screens that are still plain DOM: home, the connecting card and the table. React mounts
// them into one element and owns sign-in; this module routes between the rest by itself.

import { normalizeCode } from './net/protocol';
import { createLocal, createOnline, joinRoom, type SavedTable, type Session } from './net/session';
import { prefs, profileForWire } from './prefs';
import { GameView } from './ui/game';
import { renderHome } from './ui/home';
import { h } from './ui/dom';
import { openProfile } from './ui/profile';

export interface ScreenHooks {
  signIn(): void;
  signOut(): void;
}

/** Start routing inside `app`. Returns a function that tears every screen down again. */
export function startScreens(app: HTMLElement, hooks: ScreenHooks): () => void {
  let teardown: (() => void) | null = null;
  let disposed = false;

  function clear() {
    teardown?.();
    teardown = null;
    app.innerHTML = '';
  }

  function go(path: string) {
    if (location.pathname !== path) history.pushState(null, '', path);
    route();
  }

  function home(notice?: string) {
    clear();
    if (location.pathname !== '/') history.replaceState(null, '', '/');
    teardown = renderHome(app, {
      host: () => void hostTable(),
      join: (code) => go(`/t/${code}`),
      practice: () => play(createLocal(profileForWire(), { ...prefs().lastSettings, mode: 'practice', teamSize: 1 })),
      bot: (level) => play(createLocal(profileForWire(), { ...prefs().lastSettings, mode: 'match', teamSize: 1 }, undefined, level)),
      passAndPlay: (second) => play(createLocal(profileForWire(), { ...prefs().lastSettings, mode: 'match', teamSize: 1 }, { ...second, cue: 'ebony' })),
      signIn: hooks.signIn,
      signOut: hooks.signOut,
    }, notice);
  }

  function play(session: Session, code?: string) {
    clear();
    const view = new GameView(session, {
      leave: () => {
        if (session.isHost) {
          try { sessionStorage.removeItem('baize.hosting'); } catch { /* storage blocked */ }
        }
        session.leave();
        go('/');
      },
      reconnect: code ? () => { session.leave(); void joinTable(code); } : undefined,
    });
    view.mount(app);
    teardown = () => view.destroy();
  }

  function connecting(text: string) {
    clear();
    const el = h('div.connect', {}, h('div.card.panel', { role: 'status', style: 'justify-items:center;text-align:center' }, h('div.spinner'), h('h2', {}, text), h('p', {}, 'This usually takes a second or two.')));
    app.append(el);
  }

  async function hostTable(saved?: SavedTable) {
    connecting(saved ? 'Reopening your table…' : 'Opening your table…');
    try {
      const settings = { ...(saved?.room.settings ?? prefs().lastSettings), mode: 'match' as const };
      const s = await createOnline(profileForWire(), settings, saved);
      if (disposed) return s.leave();
      history.replaceState(null, '', `/t/${s.host!.room.code}`);
      play(s);
    } catch {
      if (disposed) return;
      try { sessionStorage.removeItem('baize.hosting'); } catch { /* storage blocked */ }
      home('Could not open a table. Check your connection and try again.');
    }
  }

  async function joinTable(code: string) {
    connecting(`Finding table ${code}…`);
    try {
      const s = await joinRoom(code, profileForWire());
      if (disposed) return s.leave();
      play(s, code);
    } catch (e) {
      if (disposed) return;
      const msg = (e as Error).message === 'not-found'
        ? `No table with the code ${code} is open. Check the code, or ask your friend to send the link again.`
        : `Could not reach table ${code}. Check your connection and try again.`;
      home(msg);
    }
  }

  function askName(then: () => void) {
    clear();
    openProfile({ requireName: true, title: 'Pull up a chair', done: then });
  }

  function route() {
    // React shows the sign-in page; leave the URL alone so it can.
    if (location.pathname === '/login') return;
    const m = location.pathname.match(/^\/t\/([A-Za-z0-9]{4,8})\/?$/);
    if (!m) return home();
    const code = normalizeCode(m[1]);
    let saved: SavedTable | null = null;
    try {
      const raw = sessionStorage.getItem('baize.hosting');
      if (raw) saved = JSON.parse(raw) as SavedTable;
    } catch { /* storage blocked */ }
    if (saved && saved.code === code) return void hostTable(saved);
    if (!prefs().profile.name.trim()) return askName(() => void joinTable(code));
    void joinTable(code);
  }

  window.addEventListener('popstate', route);
  route();

  return () => {
    disposed = true;
    window.removeEventListener('popstate', route);
    clear();
  };
}
