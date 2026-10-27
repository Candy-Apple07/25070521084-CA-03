// Talks to the accounts API in /server. The session is an httpOnly cookie the browser sends on
// its own; this module only remembers who came back from the last call.

import type { Profile } from './net/protocol';

export interface Account {
  id: string;
  username: string;
  email: string;
  profile: Profile;
  createdAt: string;
}

/** A failed API call. `fields` maps form field names to what is wrong with each. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly fields: Record<string, string> = {}) {
    super(message);
  }
}

// Empty in development (Vite proxies /api to the server); set VITE_API_URL when the API lives elsewhere.
const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';

let current: Account | null = null;

export function account(): Account | null {
  return current;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/api${path}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError('Could not reach the Obsidian server. Check your connection and try again.', 0);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({})) as { error?: string; fields?: Record<string, string> };
  if (!res.ok) throw new ApiError(data.error ?? 'Something went wrong. Try again.', res.status, data.fields);
  return data as T;
}

/** On page load: pick up an existing sign-in, if there is one. Never throws. */
export async function restore(): Promise<Account | null> {
  try {
    current = (await api<{ user: Account }>('GET', '/auth/me')).user;
  } catch {
    current = null;
  }
  return current;
}

export async function signIn(identifier: string, password: string): Promise<Account> {
  current = (await api<{ user: Account }>('POST', '/auth/login', { identifier, password })).user;
  return current;
}

export async function signUp(fields: { username: string; email: string; password: string; avatar: string }): Promise<Account> {
  current = (await api<{ user: Account }>('POST', '/auth/register', fields)).user;
  return current;
}

export async function signOut(): Promise<void> {
  try {
    await api('POST', '/auth/logout');
  } finally {
    current = null;
  }
}

/** Save name, picture and cue to the account. Only sends what changed. */
export async function saveProfile(p: Profile): Promise<void> {
  if (!current) return;
  const was = current.profile;
  const patch: Partial<Profile> = {};
  if (p.name.trim() && p.name.trim() !== was.name) patch.name = p.name.trim();
  if (p.avatar !== was.avatar) patch.avatar = p.avatar;
  if (p.cue !== was.cue) patch.cue = p.cue;
  if (!Object.keys(patch).length) return;
  current = (await api<{ user: Account }>('PATCH', '/users/me', patch)).user;
}
