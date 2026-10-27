// The front door: a landing page over a live 3D table where a ghost player knocks balls in.

import { DEFAULT_SETTINGS, rack, type MatchSettings } from '../core/rules';
import { buildTable, DEFAULT_TUNING, type Game } from '../core/table';
import type { Ball, ShotParams } from '../core/physics';
import type { BotLevel } from '../core/ai';
import { Orientations, ShotAnimator } from '../game/animator';
import { Renderer3D } from '../render/renderer3d';
import { AVATARS } from '../render/themes';
import { normalizeCode } from '../net/protocol';
import { prefs, savePrefs } from '../prefs';
import { unlockAudio } from '../audio/sound';
import { account } from '../auth';
import { h } from './dom';
import { icon, type IconName } from './icons';
import { openProfile } from './profile';
import { defaultCloth } from './lobby';
import { REPO_URL } from './sharecard';

export interface HomeActions {
  host(): void;
  join(code: string): void;
  practice(): void;
  bot(level: BotLevel): void;
  passAndPlay(second: { name: string; avatar: string }): void;
  signIn(): void;
  signOut(): void;
}

export class Attract {
  private renderer: Renderer3D;
  private settings: MatchSettings = { ...DEFAULT_SETTINGS, game: (prefs().lastSettings.game ?? 'snooker') as Game };
  private table = buildTable(DEFAULT_TUNING, this.settings.game);
  private balls: Ball[] = rack(this.settings, this.table);
  private anim: ShotAnimator | null = null;
  private waitUntil = 0;
  private shots = 0;
  private raf = 0;
  private last = 0;
  private orients = new Orientations();
  private cue: { dx: number; dy: number; t0: number; params: ShotParams; start: { x: number; y: number } } | null = null;
  private cueGone: { dx: number; dy: number; t0: number; params: ShotParams; start: { x: number; y: number } } | null = null;

  constructor(readonly canvas: HTMLCanvasElement, private padding: () => { top: number; right: number; bottom: number; left: number }) {
    this.renderer = new Renderer3D(canvas, this.table, defaultCloth(this.settings.game, 'championship'));
    this.renderer.setMode('orbit');
    this.renderer.setPadding(padding());
    this.waitUntil = performance.now() + 900;
  }

  start() {
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
    window.addEventListener('resize', this.onResize);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
  }

  private onResize = () => this.renderer.setPadding(this.padding());

  paused = false;

  /** Switch the demo table between snooker and pool. */
  setGame(game: Game) {
    this.settings = { ...DEFAULT_SETTINGS, game };
    this.table = buildTable(DEFAULT_TUNING, game);
    this.balls = rack(this.settings, this.table);
    this.renderer.setTable(this.table, defaultCloth(game, 'championship'));
    this.anim = null;
    this.cue = null;
    this.cueGone = null;
    this.shots = 0;
    this.orients = new Orientations();
    this.waitUntil = performance.now() + 700;
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.paused) return;
    if (this.anim) {
      if (this.anim.advance(dt, now)) {
        this.balls = this.anim.world.balls.map((b) => ({ ...b }));
        this.anim = null;
        this.waitUntil = now + 1100;
      }
    } else if (this.cue) {
      if (now - this.cue.t0 > 860) {
        // The home page is silent, but the hit still shows.
        this.anim = new ShotAnimator(this.table, this.balls, this.cue.params, this.orients, {
          sound: false,
          onImpact: (i) => this.renderer.impact(i.kind, i.x, i.y, i.speed),
        });
        const c = this.balls[0];
        this.renderer.strikeFx(c.x, c.y, this.cue.dx, this.cue.dy, this.cue.params.power * 0.5);
        this.cueGone = { ...this.cue, t0: now };
        this.cue = null;
      }
    } else if (now > this.waitUntil) {
      this.planShot(now);
    }

    const balls = this.anim ? this.anim.world.balls : this.balls;
    let cueDraw = null;
    if (this.cue) {
      // Slow pull back, then an accelerating push into the ball.
      const t = now - this.cue.t0;
      const c = this.balls[0];
      const back = 8 + this.cue.params.power * 260;
      const offsetMm = t < 640 ? 8 + (back - 8) * Math.sin((t / 640) * Math.PI * 0.5) : back * (1 - Math.pow(Math.min(1, (t - 640) / 220), 3));
      cueDraw = { x: c.x, y: c.y, dx: this.cue.dx, dy: this.cue.dy, pull: 0, offsetMm, skin: 'maple', alpha: 1 };
    } else if (this.cueGone && now - this.cueGone.t0 < 700) {
      const t = now - this.cueGone.t0;
      const c = this.cueGone.start;
      const through = -(30 + 150 * this.cueGone.params.power);
      cueDraw = { x: c.x, y: c.y, dx: this.cueGone.dx, dy: this.cueGone.dy, pull: 0, offsetMm: through * Math.min(1, t / 160), skin: 'maple', alpha: t > 450 ? 1 - (t - 450) / 250 : 1 };
    }
    this.renderer.draw({ balls, pots: this.anim?.pots ?? [], now, cue: cueDraw, guide: null, placing: null, labels: false, orient: (id) => this.orients.get(id), moving: !!this.anim });
  };

  private planShot(now: number) {
    const t = this.table;
    const reds = this.balls.filter((b) => b.on && b.id !== 0).length;
    if (this.shots >= 7 || reds < 4 || !this.balls[0].on) {
      this.balls = rack(this.settings, t);
      this.shots = 0;
    }
    const cue = this.balls[0];
    let params: ShotParams;
    if (this.shots === 0) {
      // Break off: thin the outside red with side.
      if (t.game === 'pool8') {
        // Pool: smash the apex.
        params = { ...dir(cue, { x: t.footSpot.x, y: t.footSpot.y + (Math.random() - 0.5) * 10 }), power: 0.95, spinX: 0, spinY: -0.2 };
      } else {
        const target = { x: t.spots.pink.x + 2 * t.R + 60, y: t.dCenter.y + 52 + Math.random() * 30 };
        params = { ...dir(cue, target), power: 0.85 + Math.random() * 0.12, spinX: 0.4, spinY: -0.1 };
      }
    } else {
      params = this.findPot(cue) ?? { ...dir(cue, this.balls.find((b) => b.on && b.id !== 0)!), power: 0.5, spinX: 0, spinY: 0 };
    }
    this.shots++;
    this.cue = { dx: params.dx, dy: params.dy, t0: now, params, start: { x: cue.x, y: cue.y } };
  }

  /** Look for a straight pot with a clear path; good enough to look like someone is playing. */
  private findPot(cue: Ball): ShotParams | null {
    const t = this.table;
    const R = t.R;
    let best: { score: number; p: ShotParams } | null = null;
    for (const ob of this.balls) {
      if (!ob.on || ob.id === 0) continue;
      for (const pk of t.pockets) {
        const px = pk.mx - pk.nx * R * 0.4, py = pk.my - pk.ny * R * 0.4;
        const ex = px - ob.x, ey = py - ob.y;
        const el = Math.hypot(ex, ey);
        const gx = ob.x - (ex / el) * 2 * R, gy = ob.y - (ey / el) * 2 * R;
        const cx = gx - cue.x, cy = gy - cue.y;
        const cl = Math.hypot(cx, cy);
        const cut = (cx * ex + cy * ey) / (cl * el);
        if (cut < 0.45 || cl < 3 * R) continue;
        if (!this.clear(cue.x, cue.y, gx, gy, [0, ob.id]) || !this.clear(ob.x, ob.y, px, py, [0, ob.id])) continue;
        const score = cut * 2 - (cl + el) / 4000 + Math.random() * 0.2;
        if (!best || score > best.score) {
          const power = Math.min(0.75, 0.22 + (cl + el / Math.max(cut, 0.5)) / 6500);
          best = { score, p: { dx: cx / cl, dy: cy / cl, power, spinX: 0, spinY: Math.random() * 0.6 - 0.4 } };
        }
      }
    }
    return best?.p ?? null;
  }

  private clear(x0: number, y0: number, x1: number, y1: number, ignore: number[]) {
    const R = this.table.R;
    const ex = x1 - x0, ey = y1 - y0;
    const l2 = ex * ex + ey * ey;
    for (const b of this.balls) {
      if (!b.on || ignore.includes(b.id)) continue;
      let k = ((b.x - x0) * ex + (b.y - y0) * ey) / l2;
      k = Math.max(0, Math.min(1, k));
      if (Math.hypot(b.x - (x0 + ex * k), b.y - (y0 + ey * k)) < 2 * R + 2) return false;
    }
    return true;
  }
}

function dir(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  return { dx: dx / l, dy: dy / l };
}

// ---------------------------------------------------------------------------------------------

/** Run `go` once the player has a name; otherwise ask for one first. */
function withName(go: () => void, refresh: () => void) {
  if (prefs().profile.name.trim()) return go();
  openProfile({ requireName: true, title: 'Pick a name first', done: go, onChange: refresh });
}

export function renderHome(root: HTMLElement, actions: HomeActions, notice?: string): () => void {
  const site = h('div.site');
  let attract: Attract | null = null;
  let botLevel: BotLevel = (prefs().lastBot as BotLevel) ?? 'medium';

  // ---- nav
  const meChip = h('button.me-chip', { type: 'button', 'aria-label': 'Edit your profile' });
  const paintMe = () => {
    const p = prefs().profile;
    meChip.replaceChildren(h('span.avatar.sm', {}, p.avatar), h('span.nm', {}, p.name.trim() || 'Set your name'));
  };
  paintMe();
  meChip.addEventListener('click', () => openProfile({ onChange: paintMe, signOut: actions.signOut }));

  const nav = h('header.nav', {}, h('div.wrap', {},
    h('a.logo', { href: '/', 'aria-label': 'Obsidian home' }, h('span.logo-ball', { 'aria-hidden': 'true' }), 'Obsidian'),
    h('nav.nav-links', { 'aria-label': 'Sections' },
      h('a', { href: '#modes' }, 'Play'),
      h('a', { href: '#how' }, 'How it works'),
      h('a', { href: '#features' }, 'Features'),
    ),
    h('div.nav-right', {},
      h('a.btn.btn-ghost.btn-sm', { href: REPO_URL, target: '_blank', rel: 'noopener' }, icon('github', 18), h('span', {}, 'Star')),
      account() ? null : h('button.btn.btn-sm.nav-signin', { type: 'button', onclick: actions.signIn }, 'Sign in'),
      meChip,
    ),
  ));

  // ---- which game
  const gameSeg = h('div.seg.game-seg', { role: 'group', 'aria-label': 'Game' });
  const paintGame = () => {
    const current = prefs().lastSettings.game ?? 'snooker';
    gameSeg.replaceChildren(...([['snooker', 'Snooker'], ['pool8', '8-ball pool']] as const).map(([g, label]) => h('button', {
      type: 'button', 'aria-pressed': String(current === g),
      onclick: () => {
        const ls = prefs().lastSettings;
        savePrefs({ lastSettings: { ...ls, game: g, tableTheme: defaultCloth(g, ls.tableTheme) } });
        paintGame();
        attract?.setGame(g);
      },
    }, label)));
  };
  paintGame();

  // ---- hero
  const canvas = h('canvas.attract', { 'aria-hidden': 'true' }) as HTMLCanvasElement;
  const code = h('input.input.code-input', { placeholder: 'Table code', maxlength: 8, 'aria-label': 'Table code', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const join = (e: Event) => {
    e.preventDefault();
    const c = normalizeCode(code.value);
    if (c.length === 6) withName(() => actions.join(c), paintMe);
    else code.focus();
  };
  const hero = h('section.hero', { 'aria-labelledby': 'hero-title' },
    canvas,
    h('div.wrap', {}, h('div.hero-copy', {},
      h('span.pill-tag', {}, h('span.dot'), 'Free. No sign-up. Plays in your browser.'),
      h('h1', { id: 'hero-title' }, 'Snooker and pool with friends, ', h('em', {}, 'one link'), ' away.'),
      h('p.sub', {}, 'Open a private table, send the link, and play: full snooker or 8-ball pool, real spin, 1 v 1 or 2 v 2. Or take on the computer.'),
      notice ? h('div.notice-bar', { role: 'alert' }, notice) : null,
      gameSeg,
      h('div.hero-ctas', {},
        h('button.btn.btn-gold.btn-lg', { type: 'button', onclick: () => { unlockAudio(); withName(actions.host, paintMe); } }, icon('users', 20), 'Open a private table'),
        h('button.btn.btn-lg', { type: 'button', onclick: () => { unlockAudio(); withName(() => actions.bot(botLevel), paintMe); } }, icon('bot', 20), 'Play the computer'),
      ),
      h('form.join-row', { onsubmit: join, 'aria-label': 'Join a table' }, code, h('button.btn', { type: 'submit' }, 'Join', icon('arrow', 18))),
      h('div.trust', {},
        h('span', {}, icon('check', 16), 'Full snooker rules'),
        h('span', {}, icon('check', 16), 'Phone and desktop'),
        h('span', {}, icon('check', 16), 'Open source'),
      ),
    )),
  );

  // ---- modes
  const levelSeg = h('div.seg', { role: 'group', 'aria-label': 'Computer difficulty' });
  const paintLevels = () => {
    levelSeg.replaceChildren(...(['easy', 'medium', 'hard'] as BotLevel[]).map((l) => h('button', {
      type: 'button', 'aria-pressed': String(l === botLevel),
      onclick: () => { botLevel = l; savePrefs({ lastBot: l }); paintLevels(); },
    }, l[0].toUpperCase() + l.slice(1))));
  };
  paintLevels();

  const mode = (o: { icon: IconName; title: string; text: string; cta: string; run: () => void; featured?: boolean; extra?: HTMLElement }) =>
    h('article.mode', { class: o.featured ? 'featured' : '' },
      h('div.mode-icon', {}, icon(o.icon, 22)),
      h('h3', {}, o.title),
      h('p', {}, o.text),
      o.extra ?? null,
      h('button.btn', { class: o.featured ? 'btn-gold' : '', type: 'button', onclick: () => { unlockAudio(); o.run(); } }, o.cta, icon('arrow', 16)),
    );

  const passAndPlay = () => {
    const card = h('div.scrim', {});
    const n2 = h('input.input', { placeholder: 'Their name', maxlength: 20, value: 'Player 2', 'aria-label': 'Opponent name' }) as HTMLInputElement;
    card.append(h('form.card.panel', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        card.remove();
        const avatar = AVATARS.filter((a) => a !== prefs().profile.avatar)[Math.floor(Math.random() * (AVATARS.length - 1))];
        actions.passAndPlay({ name: n2.value.trim() || 'Player 2', avatar });
      },
    },
    h('div.card-head', {}, h('h2', {}, 'Who are you playing?'), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => card.remove() }, icon('x'))),
    h('p', {}, 'You share this screen and take turns at the table.'),
    h('label.field', {}, h('span', {}, 'Opponent'), n2),
    h('button.btn.btn-gold.btn-lg.btn-block', { type: 'submit' }, 'Rack them up'),
    ));
    site.append(card);
    n2.select();
  };

  const modes = h('section.section', { id: 'modes', 'aria-labelledby': 'modes-title' }, h('div.wrap', {},
    h('div.section-head', {},
      h('span.kicker', {}, 'Four ways to play'),
      h('h2', { id: 'modes-title' }, 'Pick your table'),
    ),
    h('div.modes', {},
      mode({ icon: 'users', title: 'Friends online', text: 'A private table on its own link. Singles or doubles, and anyone extra can watch and chat.', cta: 'Open a table', featured: true, run: () => withName(actions.host, paintMe) }),
      mode({ icon: 'bot', title: 'Against the computer', text: 'It plans every shot with the same physics you play with. Choose how hard it tries.', cta: 'Play', extra: levelSeg, run: () => withName(() => actions.bot(botLevel), paintMe) }),
      mode({ icon: 'target', title: 'Practice', text: 'Just you and the balls. Work on your long pots and chase your highest break.', cta: 'Practise', run: actions.practice }),
      mode({ icon: 'phone', title: 'Pass and play', text: 'Two players on one phone or laptop, taking turns at the same table.', cta: 'Set up', run: () => withName(passAndPlay, paintMe) }),
    ),
  ));

  // ---- how it works (a real sequence, so numbered)
  const how = h('section.section', { id: 'how', 'aria-labelledby': 'how-title', style: 'padding-top:0' }, h('div.wrap', {},
    h('div.section-head', {},
      h('span.kicker', {}, 'Ready in seconds'),
      h('h2', { id: 'how-title' }, 'How a game starts'),
    ),
    h('div.how', {},
      ...[
        ['Open a table', 'You get a six-letter code and a link. Pick the cloth, the number of reds and the house rules while you wait.'],
        ['Send the link', 'Paste it in your group chat, or let a friend scan the QR code. Whoever opens it sits down opposite you.'],
        ['Break off', 'Your browser hosts the game and talks straight to theirs. No accounts, no lobby full of strangers.'],
      ].map(([t, d], i) => h('div.how-step', {}, h('span.n', {}, String(i + 1)), h('h3', {}, t), h('p', {}, d))),
    ),
  ));

  // ---- features
  const tile = (ic: IconName, t: string, d: string, wide = false) =>
    h('div.tile', { class: wide ? 'wide' : '' }, h('span.ti', {}, icon(ic, 20)), h('h3', {}, t), h('p', {}, d));
  const features = h('section.section', { id: 'features', 'aria-labelledby': 'features-title', style: 'padding-top:0' }, h('div.wrap', {},
    h('div.section-head', {},
      h('span.kicker', {}, 'Built like the real thing'),
      h('h2', { id: 'features-title' }, 'Everything a proper frame needs'),
    ),
    h('div.bento', {},
      h('div.tile.img.wide', {}, h('img', { src: '/table.png', alt: 'An 8-ball pool table mid-frame, with numbered solids and stripes', loading: 'lazy' })),
      tile('zap', 'Spin that behaves', 'Balls slide, then roll. Screw back, follow through, stun, and side that bends off the cushions.', true),
      tile('scale', 'Snooker and 8-ball', 'Full snooker rules with free ball and the re-spotted black, or 8-ball with numbered solids and stripes, open tables and ball in hand.'),
      tile('users', 'Singles or doubles', '1 v 1 or 2 v 2 with proper doubles rotation. Extra friends spectate and chat.'),
      tile('bot', 'A computer that thinks', 'Three levels, from a beginner to a player who rarely misses and plays safe when nothing is on.'),
      tile('palette', 'Make it yours', 'Seven cloths, seven cues, shot clock and aiming-guide options.'),
      tile('sparkles', 'Party rules', 'Bucket pockets, ice cloth, rubber cushions and marbles, for when the frame needs chaos.'),
      tile('replay', 'Replay and share', 'Watch the last shot again at half speed, then post the result card after the match.'),
    ),
  ));

  const cta = h('div.wrap', {}, h('section.cta-band', { 'aria-labelledby': 'cta-title' },
    h('h2', { id: 'cta-title' }, 'Rack them up'),
    h('p', {}, 'Open a table and send the link. Your friend is one tap from the break.'),
    h('button.btn.btn-gold.btn-lg', { type: 'button', onclick: () => withName(actions.host, paintMe) }, icon('users', 20), 'Open a private table'),
  ));

  const footer = h('footer.footer', {}, h('div.wrap', {},
    h('span', {}, 'Made by ', h('a', { href: 'https://github.com/AtharvaLakhe', target: '_blank', rel: 'noopener' }, 'Atharva Lakhe'), '. Free and open source under the MIT licence.'),
    h('div.links', {},
      h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'GitHub'),
      h('a', { href: `${REPO_URL}/issues`, target: '_blank', rel: 'noopener' }, 'Report a bug'),
      h('a', { href: '#modes' }, 'Play'),
    ),
  ));

  site.append(nav, hero, modes, how, features, cta, footer);
  root.append(site);

  attract = new Attract(canvas, () => {
    const wide = window.innerWidth > 900;
    return wide ? { top: 40, right: 40, bottom: 40, left: Math.min(560, window.innerWidth * 0.42) } : { top: 10, right: 10, bottom: window.innerHeight * 0.45, left: 10 };
  });
  attract.start();
  // Only animate while the hero is on screen.
  const io = new IntersectionObserver(([e]) => { if (attract) attract.paused = !e.isIntersecting; });
  io.observe(hero);

  return () => {
    io.disconnect();
    attract?.stop();
    site.remove();
  };
}
