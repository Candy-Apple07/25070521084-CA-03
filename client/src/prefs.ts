// Per-browser preferences. Everything here is a convenience: the game works if storage is blocked.

import { AVATARS } from './render/themes';
import type { Profile } from './net/protocol';
import { DEFAULT_SETTINGS, type MatchSettings } from './core/rules';

export interface Prefs {
  profile: Profile;
  sound: number;
  ballLabels: boolean;
  leftHanded: boolean;
  seenHowTo: boolean;
  lastBot: string;
  lastSettings: MatchSettings;
  /** Chose "Play as a guest" on the sign-in page, so don't ask again. */
  guest: boolean;
}

const KEY = 'baize.prefs.v1';

function defaults(): Prefs {
  return {
    profile: {
      name: '',
      avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)],
      cue: 'maple',
    },
    sound: 0.8,
    ballLabels: false,
    leftHanded: false,
    seenHowTo: false,
    lastBot: 'medium',
    lastSettings: DEFAULT_SETTINGS,
    guest: false,
  };
}

let cache: Prefs | null = null;

export function prefs(): Prefs {
  if (cache) return cache;
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      cache = {
        ...d, ...p,
        profile: { ...d.profile, ...p.profile },
        lastSettings: { ...DEFAULT_SETTINGS, ...p.lastSettings, mutators: { ...DEFAULT_SETTINGS.mutators, ...p.lastSettings?.mutators } },
      };
      return cache;
    }
  } catch { /* storage blocked or corrupt */ }
  cache = d;
  return cache;
}

export function savePrefs(patch: Partial<Prefs>) {
  cache = { ...prefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage blocked */ }
}

export function displayName(): string {
  return prefs().profile.name.trim() || 'Guest';
}

export function profileForWire(): Profile {
  const p = prefs().profile;
  return { ...p, name: p.name.trim() || 'Guest' };
}
