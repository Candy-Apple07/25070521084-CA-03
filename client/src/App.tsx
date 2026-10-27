// The app shell: picks up an existing sign-in, decides between the sign-in page and the game, and
// keeps the URL in step. The game screens themselves are plain DOM, mounted by <GameScreens>.

import { useCallback, useEffect, useRef, useState } from 'react';
import { restore, signOut, type Account } from './auth';
import { prefs, savePrefs } from './prefs';
import { startScreens, type ScreenHooks } from './screens';
import { LoginPage } from './ui/LoginPage';

/** The account's saved name, picture and cue win over whatever this browser had. */
function applyAccount(acc: Account) {
  savePrefs({ profile: { ...acc.profile }, guest: false });
}

export function App() {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [guest, setGuest] = useState(() => prefs().guest);
  const [path, setPath] = useState(() => location.pathname);

  useEffect(() => {
    let live = true;
    void restore().then((acc) => {
      if (!live) return;
      if (acc) applyAccount(acc);
      setAccount(acc);
      setReady(true);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string, replace = false) => {
    if (location.pathname !== to) history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setPath(to);
  }, []);

  const signedIn = (acc: Account) => {
    applyAccount(acc);
    setAccount(acc);
    // Invite links keep their URL through sign-in, then carry on to the table.
    if (location.pathname === '/login') navigate('/', true);
  };

  const playAsGuest = () => {
    savePrefs({ guest: true });
    setGuest(true);
    if (location.pathname === '/login') navigate('/', true);
  };

  const hooks: ScreenHooks = {
    signIn: () => navigate('/login'),
    signOut: async () => {
      try { await signOut(); } catch { /* the cookie is cleared server-side; nothing more to do here */ }
      savePrefs({ guest: false, profile: { ...prefs().profile, name: '' } });
      setGuest(false);
      setAccount(null);
      navigate('/login');
    },
  };

  // Already signed in and sent to /login: go home instead.
  useEffect(() => {
    if (ready && account && path === '/login') navigate('/', true);
  }, [ready, account, path, navigate]);

  if (!ready) return null;
  const showLogin = path === '/login' ? !account : !account && !guest;
  if (showLogin) return <LoginPage onSignedIn={signedIn} onGuest={playAsGuest} />;
  if (path === '/login') return null;
  return <GameScreens hooks={hooks} />;
}

/** Hosts the plain-DOM screens (home, lobby, table) for as long as it is mounted. */
function GameScreens({ hooks }: { hooks: ScreenHooks }) {
  const el = useRef<HTMLDivElement>(null);
  const latest = useRef(hooks);
  latest.current = hooks;

  useEffect(() => startScreens(el.current!, {
    signIn: () => latest.current.signIn(),
    signOut: () => latest.current.signOut(),
  }), []);

  return <div ref={el} className="screens" />;
}
