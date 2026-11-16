/*
  Procedural sound. The design follows cktang88/tinwar's audio.ts/sfx.ts: every sound is a recipe of
  layers (a pitched tone sweep or a filtered noise sweep, each with its own envelope and delay),
  mixed into a bus with a glue compressor and a brick-wall limiter, panned and dulled by distance,
  with voice caps and per-cue rate limits so a barrage never clips or smears.
*/

type ToneLayer = { src: 'tone'; wave: OscillatorType; hz: [number, number]; ms: number; gain: number; delay?: number; attack?: number };
type NoiseLayer = { src: 'noise'; filter: BiquadFilterType; q: number; hz: [number, number]; ms: number; gain: number; delay?: number; attack?: number };
type Layer = ToneLayer | NoiseLayer;

const tone = (wave: OscillatorType, hz: [number, number], ms: number, gain: number, delay = 0, attack?: number): ToneLayer => ({ src: 'tone', wave, hz, ms, gain, delay, attack });
const noise = (filter: BiquadFilterType, hz: [number, number], ms: number, gain: number, q = 0.8, delay = 0, attack?: number): NoiseLayer => ({ src: 'noise', filter, q, hz, ms, gain, delay, attack });
/** a short transient that gives a sound its edge */
const snap = (hz = 4000, gain = 0.5) => noise('highpass', [hz, hz * 0.6], 6, gain, 0.7);
/** the body of a gunshot: band-passed noise falling in pitch */
const crack = (hz: number, ms: number, gain: number, delay = 0) => noise('bandpass', [hz, hz * 0.35], ms, gain, 1.1, delay);
/** a low falling triangle: weight */
const thump = (hz: number, ms: number, gain: number, delay = 0) => tone('triangle', [hz, hz * 0.4], ms, gain, delay);

export const SOUNDS = {
  cannon: [snap(5000, 0.6), crack(1800, 140, 0.7), thump(95, 380, 0.9), tone('sine', [60, 32], 700, 0.7), noise('lowpass', [1600, 120], 1300, 0.45, 0.7, 30)],
  enemyGun: [crack(1400, 120, 0.5), thump(80, 420, 0.7), noise('lowpass', [1000, 100], 1100, 0.3, 0.7, 20)],
  blastSmall: [snap(3500, 0.4), thump(120, 260, 0.7), noise('lowpass', [2400, 180], 700, 0.55), noise('bandpass', [900, 300], 300, 0.3, 1)],
  blast: [snap(3000, 0.6), tone('sine', [85, 30], 900, 0.95), thump(140, 400, 0.8), noise('lowpass', [3000, 120], 1600, 0.7), noise('bandpass', [700, 150], 900, 0.35, 0.9, 40)],
  blastBig: [snap(2500, 0.8), tone('sine', [70, 22], 1700, 1), thump(110, 700, 0.9), noise('lowpass', [2600, 80], 2800, 0.85), noise('lowpass', [500, 60], 3400, 0.6, 0.7, 120), crack(600, 900, 0.3, 200)],
  whistle: [tone('sine', [1500, 620], 1300, 0.12, 0, 900), tone('sine', [1520, 640], 1300, 0.06, 0, 900)],
  rifle: [snap(6000, 0.5), crack(2600, 70, 0.4), noise('lowpass', [3000, 400], 220, 0.15)],
  thud: [thump(160, 140, 0.5), noise('lowpass', [900, 200], 160, 0.35)],
  crumble: [noise('bandpass', [1200, 300], 420, 0.4, 0.7), noise('lowpass', [600, 120], 600, 0.35, 0.7, 60), thump(90, 200, 0.4, 30)],
  splinter: [noise('bandpass', [2600, 900], 180, 0.4, 1.4), crack(1800, 120, 0.3, 30), thump(200, 120, 0.3)],
  clang: [tone('triangle', [610, 590], 450, 0.22), tone('square', [1370, 1330], 300, 0.06), tone('triangle', [930, 900], 380, 0.12), snap(5000, 0.3)],
  reactive: [snap(4500, 0.7), crack(2200, 90, 0.7), thump(150, 260, 0.6), noise('highpass', [3000, 1200], 300, 0.3)],
  fire: [noise('bandpass', [2800, 1500], 60, 0.3, 2), noise('bandpass', [1800, 900], 40, 0.2, 2, 50)],
  plane: [tone('sawtooth', [78, 82], 3800, 0.09, 0, 900), tone('sawtooth', [118, 121], 3800, 0.05, 0, 900), noise('lowpass', [700, 600], 3800, 0.08, 0.8, 0, 900)],
  dive: [tone('sawtooth', [120, 260], 2200, 0.08, 0, 600), tone('sine', [900, 1700], 2200, 0.05, 0, 900)],
  drone: [tone('sawtooth', [220, 228], 2400, 0.035, 0, 300), tone('square', [440, 452], 2400, 0.015, 0, 300)],
  flak: [snap(3500, 0.4), crack(900, 260, 0.45), noise('lowpass', [1800, 300], 600, 0.25)],
  click: [tone('square', [1900, 1700], 18, 0.06), noise('highpass', [5000, 4000], 10, 0.08)],
  stamp: [thump(140, 120, 0.6), noise('lowpass', [1200, 300], 120, 0.4), snap(3000, 0.3)],
  coins: [tone('triangle', [1568, 1568], 160, 0.12), tone('triangle', [2093, 2093], 260, 0.1, 90)],
  star: [tone('triangle', [1046, 1046], 300, 0.15), tone('triangle', [1318, 1318], 300, 0.12, 120), tone('triangle', [1568, 1568], 600, 0.12, 240)],
  fail: [tone('triangle', [392, 392], 400, 0.14), tone('triangle', [349, 349], 400, 0.12, 300), tone('triangle', [294, 290], 900, 0.12, 600)],
  win: [tone('square', [523, 523], 160, 0.06), tone('square', [659, 659], 160, 0.06, 170), tone('square', [784, 784], 160, 0.06, 340), tone('square', [1046, 1046], 700, 0.07, 510)],
  shovel: [noise('bandpass', [1600, 1100], 120, 0.18, 1.5), noise('bandpass', [1300, 900], 100, 0.14, 1.5, 180)],
} satisfies Record<string, Layer[]>;

export type SoundId = keyof typeof SOUNDS;

const GAP_MS: Partial<Record<SoundId, number>> = { fire: 90, rifle: 40, thud: 50, crumble: 70, splinter: 60, clang: 80, blastSmall: 30, click: 20, shovel: 300 };
const VARY: Partial<Record<SoundId, number>> = { rifle: 0.12, thud: 0.15, crumble: 0.12, splinter: 0.15, clang: 0.05, blastSmall: 0.1, blast: 0.06, fire: 0.25 };
const CAP = 56;

class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  music!: GainNode;
  noiseBuf!: AudioBuffer;
  voices = 0;
  last = new Map<string, number>();
  muted = false;
  /** listener: camera centre x and half the view width, for pan and falloff */
  lx = 0;
  half = 30;

  constructor() {
    try { this.muted = localStorage.getItem('siege-muted') === '1'; } catch { /* storage unavailable */ }
  }

  /** browsers start audio suspended until a gesture */
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16; glue.knee.value = 10; glue.ratio.value = 4; glue.attack.value = 0.003; glue.release.value = 0.15;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.06;
    this.master.connect(glue).connect(limiter).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.gain.value = 1; this.sfx.connect(this.master);
    this.music = ctx.createGain(); this.music.gain.value = 0.32; this.music.connect(this.master);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  toggleMute() {
    this.muted = !this.muted;
    try { localStorage.setItem('siege-muted', this.muted ? '1' : '0'); } catch { /* storage unavailable */ }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  private voice(l: Layer, out: AudioNode, k: number, t: number) {
    const ctx = this.ctx!;
    const t0 = t + (l.delay ?? 0) / 1000, t1 = t0 + l.ms / 1000;
    const env = ctx.createGain();
    const atk = Math.min((l.attack ?? 1.5) / 1000, (t1 - t0) * 0.9);
    env.gain.value = 0.0001;
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.linearRampToValueAtTime(l.gain, t0 + atk);
    env.gain.exponentialRampToValueAtTime(0.0001, t1);
    env.connect(out);
    let src: AudioScheduledSourceNode;
    if (l.src === 'tone') {
      const o = ctx.createOscillator();
      o.type = l.wave;
      o.frequency.setValueAtTime(l.hz[0] * k, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(1, l.hz[1] * k), t1);
      o.connect(env); o.start(t0); src = o;
    } else {
      const b = ctx.createBufferSource();
      b.buffer = this.noiseBuf; b.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = l.filter; f.Q.value = l.q;
      f.frequency.setValueAtTime(l.hz[0] * k, t0);
      f.frequency.exponentialRampToValueAtTime(Math.max(10, l.hz[1] * k), t1);
      b.connect(f).connect(env); b.start(t0, Math.random()); src = b;
    }
    this.voices++;
    src.onended = () => { this.voices--; env.disconnect(); };
    src.stop(t1 + 0.02);
  }

  /** play a cue at world x (undefined = UI, centred); gain and pitch multipliers optional */
  play(id: SoundId, x?: number, gain = 1, pitch = 1, delayMs = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const recipe: Layer[] = SOUNDS[id];
    if (this.voices + recipe.length > CAP) return;
    const now = performance.now();
    const gap = GAP_MS[id];
    if (gap && now - (this.last.get(id) ?? -1e9) < gap) return;
    this.last.set(id, now);
    const v = VARY[id] ?? 0.03;
    const k = pitch * (1 + (Math.random() * 2 - 1) * v);
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    let falloff = 1, pan = 0, dull = 18000;
    if (x !== undefined) {
      const dx = x - this.lx;
      const dist = Math.abs(dx) / (this.half * 2.4);
      falloff = Math.max(0.08, 1 - dist) ** 1.5;
      pan = Math.max(-1, Math.min(1, dx / this.half)) * 0.7;
      dull = 18000 * (1200 / 18000) ** Math.min(1, dist);
    }
    g.gain.value = gain * falloff;
    p.pan.value = pan;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = dull;
    g.connect(lp).connect(p).connect(this.sfx);
    const t = ctx.currentTime + 0.005 + delayMs / 1000;
    for (const l of recipe) this.voice(l, g, k, t);
    const longest = Math.max(...recipe.map((l) => (l.delay ?? 0) + l.ms));
    setTimeout(() => { g.disconnect(); lp.disconnect(); p.disconnect(); }, longest + delayMs + 200);
  }

  // ───────────────────────── music ─────────────────────────
  /*
    A small adaptive march, written to tinwar's docs/music/CRAFT.md rules: one proven dark loop
    (i–VI–III–VII in D minor), a short singable bugle hook, layers that build (calm: pad + snare;
    battle: + bass drum, bass, hook), only bass and kick below middle C.
  */
  private musicTimer = 0;
  private step = 0;
  intensity: 0 | 1 | 2 = 0;

  startMusic() {
    if (!this.ctx || this.musicTimer) return;
    const bpm = 84;
    const stepS = 60 / bpm / 2; // eighth notes
    let next = this.ctx.currentTime + 0.1;
    const tick = () => {
      const ctx = this.ctx!;
      if (ctx.state !== 'running') return;
      // after a stall (background tab throttling the timer, a suspended context) rejoin on the beat:
      // without this every missed eighth was scheduled at once, in the past, as one loud smear
      if (next < ctx.currentTime) {
        const missed = Math.ceil((ctx.currentTime - next) / stepS);
        next += missed * stepS; this.step += missed;
      }
      while (next < ctx.currentTime + 0.25) {
        if (!this.muted) this.musicStep(next, stepS); // muted: keep time, build no nodes
        next += stepS; this.step++;
      }
    };
    this.musicTimer = window.setInterval(tick, 60);
  }

  private note(wave: OscillatorType, hz: number, t: number, dur: number, gain: number, lp = 2400, attack = 0.01) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = wave; o.frequency.value = hz;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp;
    const e = ctx.createGain(); e.gain.setValueAtTime(0.0001, t);
    e.gain.linearRampToValueAtTime(gain, t + attack);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(e).connect(this.music);
    o.start(t); o.stop(t + dur + 0.05);
  }

  private hit(t: number, kind: 'snare' | 'kick' | 'tap', gain: number) {
    const ctx = this.ctx!;
    if (kind === 'kick') { this.note('sine', 110, t, 0.25, gain, 400, 0.002); return; }
    const b = ctx.createBufferSource(); b.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = kind === 'snare' ? 1800 : 3200; f.Q.value = 0.9;
    const e = ctx.createGain(); e.gain.setValueAtTime(gain, t); e.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'snare' ? 0.16 : 0.05));
    b.connect(f).connect(e).connect(this.music);
    b.start(t, Math.random()); b.stop(t + 0.2);
  }

  private musicStep(t: number, s: number) {
    const st = this.step % 64; // 8 bars of 8 eighths
    const bar = Math.floor(st / 8);
    const beat = st % 8;
    const D = 146.83;
    // i–VI–III–VII: Dm, Bb, F, C (two bars each)
    const chords: number[][] = [[D, D * 1.1892, D * 1.4983], [116.54, 146.83, 174.61], [174.61, 220, 261.63], [130.81, 164.81, 196]];
    const ch = chords[Math.floor(bar / 2) % 4];
    const I = this.intensity;
    // pad: a held triad, swelling
    if (beat === 0 && bar % 2 === 0) for (const hz of ch) this.note('sawtooth', hz, t, s * 16, 0.035, 900, s * 3);
    // field snare: march figure
    const snarePat = [1, 0, 0.4, 0.5, 1, 0, 0.5, 0.6];
    if (snarePat[beat]) this.hit(t, beat % 4 === 0 ? 'snare' : 'tap', snarePat[beat] * (I ? 0.22 : 0.12));
    if (I >= 1) {
      if (beat === 0 || beat === 4) this.hit(t, 'kick', 0.5);
      if (beat % 2 === 0) this.note('triangle', ch[0] / 2, t, s * 1.6, 0.16, 700);
    }
    if (I >= 2 && bar % 4 >= 2) {
      // bugle hook (5 notes) over bars 3–4 of each phrase
      const hook = [[0, 587.33], [2, 698.46], [3, 659.25], [4, 587.33], [6, 440]];
      for (const [b, hz] of hook) if (beat === b && bar % 4 === 2) this.note('square', hz, t, s * (b === 6 ? 4 : 1.8), 0.035, 2200);
    }
  }
}

export const audio = new AudioEngine();
