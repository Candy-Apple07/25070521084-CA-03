// "You" in one place: name, picture, cue and the display and control preferences.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { setVolume } from '../audio/sound';
import { account, saveProfile } from '../auth';
import { prefs, savePrefs } from '../prefs';
import { AVATARS } from '../render/themes';
import { cuePicker } from './cuepreview';
import { toast } from './dom';
import { Icon } from './Icon';

export interface ProfileOptions {
  /** The card won't close until there is a name. */
  requireName?: boolean;
  title?: string;
  /** Runs after saving: used before opening or joining a table. */
  done?: () => void;
  onChange?: () => void;
  /** Offer a sign-out button (signed-in players only). */
  signOut?: () => void;
}

/**
 * Open the profile card over whatever is on screen. When signed in, changes are saved to the
 * account as the card closes.
 */
export function openProfile(opts: ProfileOptions = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // Unmount after the click that closed it has finished, not in the middle of it.
  const unmount = () => queueMicrotask(() => { root.unmount(); host.remove(); });
  root.render(<ProfileDialog opts={opts} unmount={unmount} />);
}

function Switch({ name, text, value, onChange }: { name: string; text: string; value: boolean; onChange(v: boolean): void }) {
  return (
    <label className="switch">
      <span><b>{name}</b><small>{text}</small></span>
      <input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** The canvas cue previews are plain DOM; host them in a div. */
function CuePicker({ value, onPick }: { value: string; onPick(id: string): void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => { el.current!.replaceChildren(cuePicker(value, onPick)); }, [value, onPick]);
  return <div ref={el} />;
}

function ProfileDialog({ opts, unmount }: { opts: ProfileOptions; unmount(): void }) {
  const start = prefs();
  const [name, setName] = useState(start.profile.name);
  const [avatar, setAvatar] = useState(start.profile.avatar);
  const [cue, setCue] = useState(start.profile.cue);
  const [tab, setTab] = useState<'look' | 'settings'>('look');
  const [sound, setSound] = useState(start.sound > 0);
  const [leftHanded, setLeftHanded] = useState(start.leftHanded);
  const [ballLabels, setBallLabels] = useState(start.ballLabels);
  const [nameError, setNameError] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const acc = account();

  const close = () => {
    unmount();
    saveProfile(prefs().profile).catch(() => toast('Could not save your profile to your account. It is still saved on this device.', 4000));
  };
  const closeIfAllowed = () => { if (!opts.requireName) close(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeIfAllowed(); };
    document.addEventListener('keydown', onKey);
    if (!start.profile.name) setTimeout(() => nameInput.current?.focus(), 30);
    return () => document.removeEventListener('keydown', onKey);
    // Runs once: the card is mounted fresh each time it opens.
  }, []);

  const pickAvatar = (a: string) => {
    savePrefs({ profile: { ...prefs().profile, avatar: a } });
    setAvatar(a);
    opts.onChange?.();
  };
  const pickCue = useCallback((id: string) => {
    savePrefs({ profile: { ...prefs().profile, cue: id } });
    setCue(id);
    opts.onChange?.();
  }, [opts]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n && opts.requireName) { setNameError(true); nameInput.current?.focus(); return; }
    savePrefs({ profile: { ...prefs().profile, name: n } });
    opts.onChange?.();
    close();
    opts.done?.();
  };

  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) closeIfAllowed(); }}>
      <form className="card panel" role="dialog" aria-labelledby="profile-title" onSubmit={save}>
        <div className="card-head">
          <h2 id="profile-title">{opts.title ?? 'Your profile'}</h2>
          {opts.requireName ? null : <button type="button" className="icon-btn" aria-label="Close" onClick={close}><Icon name="x" /></button>}
        </div>

        <div className="profile-top">
          <div className="avatar lg">{avatar}</div>
          <label className="field" htmlFor="profile-name">
            <span>Name</span>
            <input ref={nameInput} className="input" id="profile-name" maxLength={20} value={name} placeholder="What should friends call you?" autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        {nameError ? <small style={{ color: '#fca5a5' }}>Add a name so friends know who they are playing.</small> : null}

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'look'} onClick={() => setTab('look')}>Picture and cue</button>
          <button type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Settings</button>
        </div>

        {tab === 'look' ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <div className="avatar-grid" role="group" aria-label="Picture">
              {AVATARS.map((a) => <button key={a} type="button" aria-label={a} aria-pressed={avatar === a} onClick={() => pickAvatar(a)}>{a}</button>)}
            </div>
            <CuePicker value={cue} onPick={pickCue} />
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            <Switch name="Sound" text="Cue strikes, clacks and pockets." value={sound} onChange={(v) => { setSound(v); savePrefs({ sound: v ? 0.8 : 0 }); setVolume(v ? 0.8 : 0); }} />
            <Switch name="Left-handed controls" text="Power bar on the right, fine aim on the left." value={leftHanded} onChange={(v) => { setLeftHanded(v); savePrefs({ leftHanded: v }); opts.onChange?.(); }} />
            <Switch name="Numbers on balls" text="Prints each ball’s value on it, for anyone who finds the colours hard to tell apart." value={ballLabels} onChange={(v) => { setBallLabels(v); savePrefs({ ballLabels: v }); }} />
          </div>
        )}

        {acc ? (
          <div className="account-row">
            <span>Signed in as <b>@{acc.username}</b></span>
            {opts.signOut ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { unmount(); opts.signOut!(); }}><Icon name="logout" size={16} />Sign out</button> : null}
          </div>
        ) : null}

        <button type="submit" className="btn btn-gold btn-lg btn-block">{opts.done ? 'Continue' : 'Save'}</button>
      </form>
    </div>
  );
}
