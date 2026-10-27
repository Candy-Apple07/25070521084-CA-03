// The sign-in page: sign in, create an account, or carry on as a guest, over the live demo table.

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InputHTMLAttributes, type Ref, type RefObject } from 'react';
import { ApiError, signIn, signUp, type Account } from '../auth';
import { prefs } from '../prefs';
import { Attract } from './home';
import { Icon } from './Icon';

type Mode = 'signin' | 'signup';
type FieldName = 'identifier' | 'username' | 'email' | 'password';
type Values = Record<FieldName, string>;
type Errors = Partial<Record<FieldName, string>>;

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS: Record<Mode, FieldName[]> = { signin: ['identifier', 'password'], signup: ['username', 'email', 'password'] };

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: FieldName;
  label: string;
  hint?: string;
  error?: string;
  inputRef: Ref<HTMLInputElement>;
}

function Field({ id, label, hint, error, inputRef, type, ...input }: FieldProps) {
  const [shown, setShown] = useState(false);
  const message = error ?? hint;
  const control = (
    <input
      ref={inputRef}
      id={id}
      name={id}
      className="input"
      spellCheck={false}
      required
      aria-invalid={!!error}
      aria-describedby={message ? `${id}-msg` : undefined}
      type={type === 'password' && shown ? 'text' : type}
      {...input}
    />
  );
  return (
    <div className={`field${error ? ' invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {type === 'password' ? (
        <div className="pw">
          {control}
          <button type="button" className="pw-toggle" aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown} onClick={() => setShown(!shown)}>
            <Icon name="eye" size={18} />
          </button>
        </div>
      ) : control}
      {message ? <small className="field-msg" id={`${id}-msg`}>{message}</small> : null}
    </div>
  );
}

export function LoginPage({ onSignedIn, onGuest }: { onSignedIn(account: Account): void; onGuest(): void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [values, setValues] = useState<Values>({ identifier: '', username: '', email: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const canvas = useRef<HTMLCanvasElement>(null);
  const inputs: Record<FieldName, RefObject<HTMLInputElement | null>> = {
    identifier: useRef(null), username: useRef(null), email: useRef(null), password: useRef(null),
  };
  const focus = (f: FieldName) => inputs[f].current?.focus();

  // The demo table behind the card.
  useEffect(() => {
    const attract = new Attract(canvas.current!, () => window.innerWidth > 900
      ? { top: 40, right: 40, bottom: 40, left: Math.min(600, window.innerWidth * 0.46) }
      : { top: 10, right: 10, bottom: window.innerHeight * 0.55, left: 10 });
    attract.start();
    return () => attract.stop();
  }, []);

  useEffect(() => { focus(mode === 'signin' ? 'identifier' : 'username'); }, [mode]);

  const set = (f: FieldName) => (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [f]: e.target.value }));

  function switchMode(m: Mode) {
    if (busy || m === mode) return;
    // Carry what they typed across, so switching tabs never loses it.
    setValues((v) => {
      const id = v.identifier.trim();
      if (m === 'signup') return id.includes('@') ? { ...v, email: v.email || id } : { ...v, username: v.username || id };
      return { ...v, identifier: v.identifier || v.username.trim() || v.email.trim() };
    });
    setErrors({});
    setNotice('');
    setMode(m);
  }

  /** Check in the browser first, so obvious mistakes don't need a round trip. */
  function validate(): Errors {
    const e: Errors = {};
    if (mode === 'signin') {
      if (!values.identifier.trim()) e.identifier = 'Enter your username or email.';
      if (!values.password) e.password = 'Enter your password.';
    } else {
      if (!USERNAME.test(values.username.trim())) e.username = 'Use 3 to 20 letters, numbers or underscores.';
      if (!EMAIL.test(values.email.trim())) e.email = 'Enter a valid email address.';
      if (values.password.length < 8) e.password = 'Use at least 8 characters.';
    }
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (busy) return;
    const bad = validate();
    setErrors(bad);
    setNotice('');
    const first = FIELDS[mode].find((f) => bad[f]);
    if (first) return focus(first);

    setBusy(true);
    try {
      const acc = mode === 'signin'
        ? await signIn(values.identifier.trim(), values.password)
        : await signUp({ username: values.username.trim(), email: values.email.trim(), password: values.password, avatar: prefs().profile.avatar });
      onSignedIn(acc);
    } catch (err) {
      setBusy(false);
      const ae = err instanceof ApiError ? err : new ApiError('Something went wrong. Try again.', 0);
      const named = FIELDS[mode].filter((f) => ae.fields[f]);
      if (named.length) {
        setErrors(Object.fromEntries(named.map((f) => [f, ae.fields[f]])));
        focus(named[0]);
      } else {
        setNotice(ae.message);
        if (ae.status === 401) {
          setValues((v) => ({ ...v, password: '' }));
          focus('password');
        }
      }
    }
  }

  const signin = mode === 'signin';
  return (
    <main className="auth" aria-labelledby="auth-title">
      <canvas ref={canvas} className="attract" aria-hidden="true" />
      <div className="wrap auth-wrap">
        <a className="logo" href="/" aria-label="Obsidian"><span className="logo-ball" aria-hidden="true" />Obsidian</a>
        <section className="card panel auth-card">
          <div className="auth-head">
            <h1 id="auth-title">{signin ? 'Welcome back' : 'Join the club'}</h1>
            <p className="auth-sub">{signin ? 'Sign in to pick up with your name, picture and cue.' : 'One account keeps your name, picture and cue on every device.'}</p>
          </div>

          <div className="tabs auth-tabs" role="tablist" aria-label="Sign in or create an account">
            <button type="button" role="tab" id="tab-signin" aria-controls="auth-form" aria-selected={signin} onClick={() => switchMode('signin')}>Sign in</button>
            <button type="button" role="tab" id="tab-signup" aria-controls="auth-form" aria-selected={!signin} onClick={() => switchMode('signup')}>Create account</button>
          </div>

          <form className="auth-form" id="auth-form" role="tabpanel" aria-labelledby={`tab-${mode}`} noValidate onSubmit={submit}>
            {notice ? <div className="notice-bar" role="alert">{notice}</div> : null}
            <div className="auth-fields">
              {signin ? (
                <Field id="identifier" label="Username or email" inputRef={inputs.identifier} value={values.identifier} onChange={set('identifier')} error={errors.identifier} autoComplete="username" autoCapitalize="off" maxLength={254} />
              ) : (
                <>
                  <Field id="username" label="Username" inputRef={inputs.username} value={values.username} onChange={set('username')} error={errors.username} hint="3 to 20 letters, numbers or underscores. Friends see this at the table." autoComplete="username" autoCapitalize="off" maxLength={20} />
                  <Field id="email" label="Email" type="email" inputRef={inputs.email} value={values.email} onChange={set('email')} error={errors.email} autoComplete="email" maxLength={254} />
                </>
              )}
              <Field id="password" label="Password" type="password" inputRef={inputs.password} value={values.password} onChange={set('password')} error={errors.password} hint={signin ? undefined : 'At least 8 characters.'} autoComplete={signin ? 'current-password' : 'new-password'} maxLength={72} />
            </div>
            <button type="submit" className="btn btn-gold btn-lg btn-block" disabled={busy} aria-busy={busy}>
              {busy ? <span className="spinner sm" aria-hidden="true" /> : null}
              {busy ? (signin ? 'Signing in…' : 'Creating your account…') : (signin ? 'Sign in' : 'Create account')}
            </button>
          </form>

          <div className="auth-or" aria-hidden="true"><span>or</span></div>
          <button type="button" className="btn btn-block" disabled={busy} onClick={onGuest}><Icon name="user" size={18} />Play as a guest</button>
          <p className="auth-fine">Guests can play every mode. Your name and settings just stay on this device.</p>
        </section>
      </div>
    </main>
  );
}
