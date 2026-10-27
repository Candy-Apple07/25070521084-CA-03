// Sound design, all synthesised: no audio files to load.
//
// Each kind of contact is modelled the way real objects ring: a very short noise transient for
// the moment of impact, plus a handful of decaying resonances ("modes") at the frequencies that
// material rings at. Resin balls ring high and die in a few milliseconds; the leather tip is
// duller; cushions are low rubber thumps; the pocket is a soft knock then a deep landing.
// Several slightly different takes of each sound are rendered once, then picked at random and
// pitched a touch per hit so repeats never sound identical. Sounds are panned by where on the
// table they happen.

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let dry: GainNode | null = null;
let wet: GainNode | null = null;
let rollGain: GainNode | null = null;
let rollFilter: BiquadFilterNode | null = null;
let volume = 0.8;
const bank: Record<string, AudioBuffer[]> = {};

interface Mode { f: number; decay: number; amp: number }

/** Render a struck object: a noise click plus decaying sine modes, with slight random detune. */
function render(c: AudioContext, o: { modes: Mode[]; click: number; clickDecay: number; length: number; clickTone?: number }, seed: number): AudioBuffer {
  const sr = c.sampleRate;
  const n = Math.floor(sr * o.length);
  const buf = c.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const modes = o.modes.map((m) => ({ ...m, f: m.f * (0.96 + rnd() * 0.08), phase: rnd() * Math.PI * 2 }));
  // One-pole filter on the click so it isn't pure white noise.
  const tone = o.clickTone ?? 0.5;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0;
    for (const m of modes) s += m.amp * Math.exp(-t / m.decay) * Math.sin(2 * Math.PI * m.f * t + m.phase);
    lp += (rnd() * 2 - 1 - lp) * tone;
    s += o.click * Math.exp(-t / o.clickDecay) * lp;
    // Soft attack over 0.3 ms to avoid a digital tick.
    d[i] = s * Math.min(1, t / 0.0003);
  }
  // Normalise.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
  return buf;
}

function build(c: AudioContext) {
  const takes = (name: string, o: Parameters<typeof render>[1]) => {
    bank[name] = [0, 1, 2, 3].map((k) => render(c, o, k + name.length * 7));
  };
  // Resin on resin: bright, glassy, gone in a few milliseconds.
  takes('clack', {
    modes: [
      { f: 2950, decay: 0.0075, amp: 1 },
      { f: 4380, decay: 0.0052, amp: 0.65 },
      { f: 6150, decay: 0.0034, amp: 0.4 },
      { f: 8650, decay: 0.0022, amp: 0.22 },
      { f: 1180, decay: 0.006, amp: 0.25 },
    ],
    click: 0.9, clickDecay: 0.0007, length: 0.06, clickTone: 0.85,
  });
  // A soft touch between balls is duller and quieter.
  takes('kiss', {
    modes: [
      { f: 2650, decay: 0.005, amp: 1 },
      { f: 3900, decay: 0.0035, amp: 0.4 },
      { f: 1050, decay: 0.005, amp: 0.3 },
    ],
    click: 0.4, clickDecay: 0.0005, length: 0.04, clickTone: 0.5,
  });
  // Leather tip on the cue ball: a woody "tock".
  takes('tip', {
    modes: [
      { f: 1150, decay: 0.009, amp: 1 },
      { f: 2080, decay: 0.006, amp: 0.55 },
      { f: 3350, decay: 0.0035, amp: 0.3 },
      { f: 190, decay: 0.03, amp: 0.45 },
    ],
    click: 0.7, clickDecay: 0.0012, length: 0.12, clickTone: 0.35,
  });
  // Ball into rubber cushion: a low, padded thump with a little wood from the rail.
  takes('cushion', {
    modes: [
      { f: 105, decay: 0.045, amp: 1 },
      { f: 185, decay: 0.03, amp: 0.7 },
      { f: 320, decay: 0.018, amp: 0.4 },
      { f: 640, decay: 0.008, amp: 0.18 },
    ],
    click: 0.5, clickDecay: 0.004, length: 0.18, clickTone: 0.12,
  });
  // Ball against the leather jaw as it goes in.
  takes('jaw', {
    modes: [
      { f: 240, decay: 0.03, amp: 1 },
      { f: 470, decay: 0.016, amp: 0.5 },
      { f: 900, decay: 0.006, amp: 0.2 },
    ],
    click: 0.5, clickDecay: 0.003, length: 0.14, clickTone: 0.2,
  });
  // Landing in the pocket: deep and muffled.
  takes('drop', {
    modes: [
      { f: 82, decay: 0.09, amp: 1 },
      { f: 135, decay: 0.06, amp: 0.7 },
      { f: 230, decay: 0.035, amp: 0.4 },
      { f: 410, decay: 0.015, amp: 0.15 },
    ],
    click: 0.45, clickDecay: 0.008, length: 0.35, clickTone: 0.08,
  });
}

function ac(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = volume;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 8;
  comp.ratio.value = 3;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  master.connect(comp).connect(ctx.destination);

  dry = ctx.createGain();
  dry.connect(master);
  // A small, warm room: short early reflections and a quick tail.
  wet = ctx.createGain();
  wet.gain.value = 0.14;
  const verb = ctx.createConvolver();
  verb.buffer = room(ctx, 0.9);
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  wet.connect(tone).connect(verb).connect(master);

  build(ctx);

  // Cloth noise under rolling balls: brown noise through a band, level follows table speed.
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  let last = 0;
  for (let i = 0; i < nd.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; nd[i] = last * 3.5; }
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  rollFilter = ctx.createBiquadFilter();
  rollFilter.type = 'bandpass';
  rollFilter.frequency.value = 260;
  rollFilter.Q.value = 0.7;
  rollGain = ctx.createGain();
  rollGain.gain.value = 0;
  src.connect(rollFilter).connect(rollGain).connect(dry);
  src.start();
  return ctx;
}

function room(c: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // A few discrete early reflections, then a diffuse decaying tail.
    for (const [ms, g] of [[11, 0.5], [19, 0.35], [27, 0.28], [41, 0.2]] as const) {
      const i = Math.floor((ms / 1000) * c.sampleRate) + ch * 3;
      if (i < len) d[i] += g;
    }
    for (let i = Math.floor(0.03 * c.sampleRate); i < len; i++) d[i] += (Math.random() * 2 - 1) * 0.35 * Math.pow(1 - i / len, 4);
  }
  return buf;
}

/** Browsers only allow audio after a user gesture. Call from any click. */
export function unlockAudio() {
  const c = ac();
  if (c && c.state === 'suspended') void c.resume();
}

export function setVolume(v: number) {
  volume = v;
  if (master) master.gain.value = v;
}

function play(name: string, o: { gain: number; rate?: number; pan?: number; delay?: number; reverb?: number; lowpass?: number }) {
  const c = ac();
  if (!c || !dry || !wet || volume === 0 || o.gain <= 0.001) return;
  const takes = bank[name];
  if (!takes) return;
  const src = c.createBufferSource();
  src.buffer = takes[Math.floor(Math.random() * takes.length)];
  src.playbackRate.value = (o.rate ?? 1) * (0.97 + Math.random() * 0.06);
  let node: AudioNode = src;
  if (o.lowpass) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = o.lowpass;
    node = node.connect(f);
  }
  const g = c.createGain();
  g.gain.value = o.gain;
  node = node.connect(g);
  if (o.pan && c.createStereoPanner) {
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    node = node.connect(p);
  }
  node.connect(dry);
  const send = c.createGain();
  send.gain.value = o.reverb ?? 1;
  node.connect(send).connect(wet);
  src.start(c.currentTime + (o.delay ?? 0));
}

function tone(freq: number, gain: number, decay: number, delay = 0, type: OscillatorType = 'sine') {
  const c = ac();
  if (!c || !dry || volume === 0) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  o.connect(g).connect(dry);
  if (wet) g.connect(wet);
  o.start(t);
  o.stop(t + decay + 0.02);
}

function buzz(ms: number) {
  try { navigator.vibrate?.(ms); } catch { /* not supported */ }
}

let lastClack = 0;

export const sfx = {
  /** Two balls meet. `speed` is the closing speed in mm/s; `pan` is -1 (left) .. 1 (right). */
  ball(speed: number, pan = 0) {
    const now = performance.now();
    if (now - lastClack < 8) return;
    lastClack = now;
    const v = Math.min(1, speed / 3200);
    if (v < 0.006) return;
    const loud = Math.pow(v, 0.65);
    // Hard hits ring brighter and slightly higher; feathered touches are dull kisses.
    if (v < 0.08) play('kiss', { gain: 0.15 + loud * 0.6, pan, rate: 0.95 + v, lowpass: 3800 });
    else play('clack', { gain: 0.25 + loud * 0.85, pan, rate: 0.96 + v * 0.1, lowpass: 5000 + v * 9000 });
    if (v > 0.6) buzz(10);
  },
  cushion(speed: number, pan = 0) {
    const v = Math.min(1, speed / 3200);
    if (v < 0.015) return;
    play('cushion', { gain: 0.25 + Math.pow(v, 0.7) * 0.8, pan, rate: 0.92 + v * 0.16, reverb: 0.6 });
  },
  pot(speed: number, pan = 0) {
    const v = Math.min(1, speed / 2400);
    // A knock on the leather as it goes in, then the landing a beat later.
    play('jaw', { gain: 0.2 + v * 0.45, pan, rate: 0.95 + v * 0.1 });
    play('drop', { gain: 0.65, pan, delay: 0.09 + (1 - v) * 0.05, rate: 0.95 + Math.random() * 0.1, reverb: 0.5 });
    buzz(18);
  },
  strike(power: number) {
    const p = Math.min(1, Math.max(0, power));
    // Soft shots: a gentle tock. Power shots: brighter and with weight underneath.
    play('tip', { gain: 0.3 + Math.pow(p, 0.7) * 0.75, rate: 0.9 + p * 0.25, lowpass: 2500 + p * 7000 });
    if (p > 0.5) play('cushion', { gain: (p - 0.5) * 0.9, rate: 0.8, reverb: 0.3 });
    buzz(Math.round(6 + p * 30));
  },
  /** Total rolling speed of everything on the table (mm/s). */
  roll(total: number) {
    if (!rollGain || !ctx || !rollFilter) return;
    const v = Math.min(1, total / 9000);
    rollGain.gain.setTargetAtTime(v * 0.16, ctx.currentTime, 0.06);
    rollFilter.frequency.setTargetAtTime(180 + v * 260, ctx.currentTime, 0.1);
  },
  turn() {
    tone(660, 0.07, 0.22);
    tone(990, 0.06, 0.3, 0.08);
  },
  foul() {
    tone(220, 0.08, 0.35, 0, 'triangle');
    tone(175, 0.08, 0.45, 0.12, 'triangle');
  },
  pop() {
    tone(880, 0.05, 0.1, 0, 'triangle');
  },
};
