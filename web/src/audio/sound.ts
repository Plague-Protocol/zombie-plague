// Zombie Plague's sound. The voices of the dead and the living, guns, flesh and feet are real recordings
// (public/sfx, CC0 and CC-BY: see public/sfx/CREDITS.md), fetched in the background after the first tap; until
// they arrive, and for everything else, the sound is synthesised in code in the spirit of Eko Lockdown's Sounds.cs.
// Wind and a low drone under everything, distant sirens, zombie groans placed in stereo, a scream
// when one lunges, footsteps paced to the player's speed, a heartbeat when time or distance is short,
// and stingers. Starts on the first tap (browsers require a user gesture).
// The plague is heard as well as seen: as the infection climbs the world goes dull (a lowpass closes over
// everything but your own heart), the groans start to sound like whispering, and you cough. The quiet
// before they come is real quiet: the wind drops, one sound, then the hit.
import { infection, playerSpeed, playerVehicle, type GameState } from '../../../core/state';
import type { GameEvent, GunKind } from '../../../core/types';
import { ATTACK_WINDUP, SCREAM_WINDUP } from '../../../core/config';

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  /** Everything outside your own body passes through this: it closes as the infection climbs. */
  private dull!: BiquadFilterNode;
  /** The wind and the drone: they drop away in the moment before something happens. */
  private amb!: GainNode;
  private noise!: AudioBuffer;
  private nextSiren = 20;
  private nextStep = 0;
  private nextBeat = 0;
  private groanAt = new Map<number, number>();
  private t = 0;
  private engine: { osc: OscillatorNode; osc2: OscillatorNode; gain: GainNode; lp: BiquadFilterNode } | null = null;
  muted = false;
  /** Recorded takes by bank (groan, shriek, pistol...), filled in as they decode. */
  private bank = new Map<string, AudioBuffer[]>();
  private lastTake = new Map<string, number>();

  /** Call from a user gesture. Safe to call more than once. */
  start(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(comp);
    this.dull = ctx.createBiquadFilter();
    this.dull.type = 'lowpass';
    this.dull.frequency.value = 18000;
    this.dull.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.dull);
    this.amb = ctx.createGain();
    this.amb.connect(this.dull);

    // 2 s of white noise, reused by every noisy sound
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    this.ambience();
    void this.loadSamples();
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend(); else void this.ctx.resume();
    });
  }

  /** Fetch the recordings. Each bank becomes playable as soon as its first take decodes; a failure only means the synth plays. */
  private async loadSamples(): Promise<void> {
    const base = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}sfx/`;
    let manifest: Record<string, number>;
    try { manifest = (await (await fetch(`${base}manifest.json`)).json()) as Record<string, number>; } catch { return; }
    // the sounds heard first go first
    const order = ['groan', 'step', 'pistol', 'growl', 'scream', 'shriek', 'cough', 'punch', 'crack', 'hurt', 'shotgun', 'rifle', 'breath', 'male', 'eat'];
    const names = Object.keys(manifest).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
    for (const name of names) {
      await Promise.all(Array.from({ length: manifest[name]! }, async (_, i) => {
        try {
          const buf = await this.ctx!.decodeAudioData(await (await fetch(`${base}${name}-${i + 1}.mp3`)).arrayBuffer());
          const list = this.bank.get(name) ?? [];
          list.push(buf);
          this.bank.set(name, list);
        } catch { /* that take is missing: the others (or the synth) cover it */ }
      }));
    }
  }

  /**
   * Play a recorded take from a bank into `out`, never the same take twice running, a little higher or lower each
   * time. Returns false if the bank has not loaded, so the caller can synthesise instead.
   */
  private sample(name: string, out: AudioNode, vol: number, rate = 1, at = this.ctx!.currentTime, spread = 0.06): AudioBufferSourceNode | null {
    const list = this.bank.get(name);
    if (!list?.length || vol <= 0) return null;
    let k = Math.floor(Math.random() * list.length);
    if (list.length > 1 && k === this.lastTake.get(name)) k = (k + 1) % list.length;
    this.lastTake.set(name, k);
    const src = this.ctx!.createBufferSource();
    src.buffer = list[k]!;
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * spread);
    const g = this.ctx!.createGain();
    g.gain.value = vol;
    src.connect(g).connect(out);
    src.start(at);
    return src;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  private ambience(): void {
    const ctx = this.ctx!;
    // wind: looping noise through a lowpass whose cutoff drifts
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise;
    wind.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(lp.frequency);
    const wg = ctx.createGain();
    wg.gain.value = 0.16;
    wind.connect(lp).connect(wg).connect(this.amb);
    wind.start();
    lfo.start();
    // drone: two detuned low saws, heavily filtered
    const dg = ctx.createGain();
    dg.gain.value = 0.05;
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 160;
    dlp.connect(dg).connect(this.amb);
    for (const f of [55, 55.6, 82.4]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(dlp);
      o.start();
    }
  }

  private env(g: GainNode, at: number, peak: number, attack: number, release: number): void {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + release);
  }

  private noiseSrc(at: number, dur: number): AudioBufferSourceNode {
    const n = this.ctx!.createBufferSource();
    n.buffer = this.noise;
    n.start(at, Math.random() * 1.5, dur);
    return n;
  }

  private panner(pan: number): StereoPannerNode {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.sfx);
    return p;
  }

  siren(): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    o.frequency.setValueAtTime(620, at);
    for (let k = 0; k < 4; k++) {
      o.frequency.linearRampToValueAtTime(900, at + k * 1.6 + 0.8);
      o.frequency.linearRampToValueAtTime(620, at + k * 1.6 + 1.6);
    }
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.025, at + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 6.5);
    o.connect(lp).connect(g).connect(this.panner(Math.random() * 1.6 - 0.8));
    o.start(at);
    o.stop(at + 6.6);
  }

  groan(pan: number, vol: number, angry: boolean): void {
    // the walkers' voices vary: deeper and slower for most, the angry ones pushed up
    if (this.sample(angry ? 'growl' : 'groan', this.panner(pan), vol * 1.6, angry ? 1 : 0.88, undefined, 0.1)) return;
    const ctx = this.ctx!, at = ctx.currentTime;
    const dur = angry ? 0.7 : 1.1 + Math.random() * 0.5;
    const base = (angry ? 120 : 85) + Math.random() * 30;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(base, at);
    o.frequency.linearRampToValueAtTime(base * (angry ? 1.25 : 0.8), at + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 6 + Math.random() * 4;
    const vg = ctx.createGain();
    vg.gain.value = base * 0.05;
    vib.connect(vg).connect(o.frequency);
    const out = this.panner(pan);
    const g = ctx.createGain();
    this.env(g, at, vol, 0.12, dur);
    g.connect(out);
    for (const [f, q] of [[520, 6], [1150, 8]] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * (0.9 + Math.random() * 0.2);
      bp.Q.value = q;
      o.connect(bp).connect(g);
    }
    // breath
    const n = this.noiseSrc(at, dur + 0.2);
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass';
    nb.frequency.value = 900;
    const ng = ctx.createGain();
    this.env(ng, at, vol * 0.5, 0.1, dur);
    n.connect(nb).connect(ng).connect(out);
    o.start(at);
    vib.start(at);
    o.stop(at + dur + 0.2);
    vib.stop(at + dur + 0.2);
  }

  scream(pan: number, vol: number): void {
    if (this.sample('scream', this.panner(pan), vol * 1.5, 0.95, undefined, 0.08)) return;
    const ctx = this.ctx!, at = ctx.currentTime;
    const n = this.noiseSrc(at, 0.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1800, at);
    bp.frequency.exponentialRampToValueAtTime(700, at + 0.5);
    bp.Q.value = 3;
    const g = ctx.createGain();
    this.env(g, at, vol, 0.03, 0.5);
    n.connect(bp).connect(g).connect(this.panner(pan));
    this.groan(pan, vol * 0.8, true);
  }

  footstep(vol: number): void {
    if (this.sample('step', this.sfx, vol * 2.2, 1, undefined, 0.1)) return;
    const ctx = this.ctx!, at = ctx.currentTime;
    const n = this.noiseSrc(at, 0.08);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700 + Math.random() * 300;
    const g = ctx.createGain();
    this.env(g, at, vol, 0.004, 0.07);
    n.connect(lp).connect(g).connect(this.sfx);
  }

  heartbeat(vol: number): void {
    const ctx = this.ctx!;
    for (const [off, v] of [[0, 1], [0.18, 0.7]] as const) {
      const at = ctx.currentTime + off;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(70, at);
      o.frequency.exponentialRampToValueAtTime(40, at + 0.12);
      const g = ctx.createGain();
      this.env(g, at, vol * v, 0.01, 0.16);
      o.connect(g).connect(this.master); // your own heart: nothing dulls it
      o.start(at);
      o.stop(at + 0.2);
    }
  }

  /** A cough: two or three barks of breath. Yours is close and dry; someone else's is placed where they are. */
  cough(pan: number, vol: number, own: boolean): void {
    const ctx = this.ctx!, t0 = ctx.currentTime;
    const out = own ? this.master : this.panner(pan);
    if (this.sample('cough', out, vol * 1.8, own ? 0.95 : 1.05)) return;
    const n = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const at = t0 + k * (0.2 + Math.random() * 0.06);
      const src = this.noiseSrc(at, 0.16);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime((own ? 850 : 1100) + Math.random() * 200, at);
      bp.frequency.exponentialRampToValueAtTime(380, at + 0.14);
      bp.Q.value = 1.6;
      const g = ctx.createGain();
      this.env(g, at, vol * (1 - k * 0.2), 0.008, 0.13);
      src.connect(bp).connect(g).connect(out);
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, at);
      o.frequency.exponentialRampToValueAtTime(70, at + 0.1);
      const og = ctx.createGain();
      this.env(og, at, vol * 0.5, 0.005, 0.1);
      o.connect(og).connect(out);
      o.start(at);
      o.stop(at + 0.15);
    }
  }

  /** A soft-clipping curve: pushes a voice until it tears. */
  private rasp(amount: number): WaveShaperNode {
    const sh = this.ctx!.createWaveShaper();
    const c = new Float32Array(257);
    for (let i = 0; i < 257; i++) { const x = i / 128 - 1; c[i] = Math.tanh(x * amount); }
    sh.curve = c;
    return sh;
  }

  /**
   * A voice: a buzzing source at `f0` following a pitch contour, roughened (its pitch shaken by noise, the way
   * a throat tears when it is forced), pushed through the mouth shape of an open "AAH" (three vowel formants)
   * and overdriven. This is what makes a scream sound like something that was a person.
   * `contour`: [seconds, multiple of f0] points.
   */
  private voice(out: AudioNode, at: number, dur: number, f0: number, contour: Array<readonly [number, number]>, vol: number, rough: number, formants = [950, 1550, 2900]): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.06);
    g.gain.setValueAtTime(vol, at + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    g.connect(out);
    const drive = this.rasp(2.5 + rough * 6);
    drive.connect(g);
    const mouth = ctx.createGain();
    mouth.gain.value = 1.4;
    mouth.connect(drive);
    const src = ctx.createGain(); // the source (built below): everything it makes goes through the mouth
    formants.forEach((f, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f * (0.94 + Math.random() * 0.12);
      bp.Q.value = 4 + i * 2;
      const fg = ctx.createGain();
      fg.gain.value = [1, 0.7, 0.45][i] ?? 0.4;
      src.connect(bp).connect(fg).connect(mouth);
    });
    // the source: two saws a few cents apart and one an octave down, all following the contour
    const shake = this.noiseSrc(at, dur + 0.1); // roughness: noise shaking the pitch
    const shakeLp = ctx.createBiquadFilter();
    shakeLp.type = 'lowpass';
    shakeLp.frequency.value = 90;
    const shakeG = ctx.createGain();
    shakeG.gain.value = f0 * rough * 0.9;
    shake.connect(shakeLp).connect(shakeG);
    for (const [mul, level] of [[1, 1], [1.011, 0.8], [0.5, 0.5 * rough + 0.15]] as const) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * mul * contour[0]![1], at);
      for (const [t, m] of contour) o.frequency.linearRampToValueAtTime(f0 * mul * m, at + t);
      shakeG.connect(o.frequency);
      const og = ctx.createGain();
      og.gain.value = level;
      o.connect(og).connect(src);
      o.start(at);
      o.stop(at + dur + 0.1);
    }
    // breath through the same mouth
    const air = this.noiseSrc(at, dur);
    const ag = ctx.createGain();
    ag.gain.value = 0.25;
    air.connect(ag).connect(src);
  }

  /**
   * A screamer's call: a full human scream, forced past where a throat should give out. It climbs, holds,
   * cracks upward and breaks. Loud, long, and it comes with its own echo off the buildings: you know at once
   * what made it and that everything else heard it too.
   */
  shriek(pan: number, vol: number): void {
    const ctx = this.ctx!, at = ctx.currentTime, dur = 2.1;
    const out = this.panner(pan);
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.27;
    const fb = ctx.createGain();
    fb.gain.value = 0.3;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    const bus = ctx.createGain();
    bus.connect(out);
    bus.connect(echo);
    echo.connect(fb).connect(echo);
    echo.connect(wet).connect(out);
    // a woman's scream, and under it the same scream an octave and more down: what is screaming is not a person now
    if (this.sample('shriek', bus, vol * 1.6, 0.94, at, 0.04)) {
      this.sample('shriek', bus, vol * 0.7, 0.6, at + 0.02, 0.02);
      return;
    }
    this.voice(bus, at, dur, 520, [[0, 0.8], [0.18, 1.25], [0.9, 1.4], [1.25, 1.95], [1.6, 1.7], [dur, 1.1]], vol, 0.55);
    this.voice(bus, at + 0.04, dur - 0.1, 392, [[0, 0.9], [0.3, 1.2], [1.3, 1.5], [dur, 0.9]], vol * 0.5, 0.9, [800, 1300, 2600]);
  }

  /** The breath a screamer draws first: a long rising gasp. Hearing it is your one warning. */
  inhale(pan: number, vol: number, dur: number): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    if (this.sample('breath', this.panner(pan), vol * 2.2, 0.8)) {
      this.voice(this.panner(pan), at, dur, 160, [[0, 0.8], [dur, 1.7]], vol * 0.15, 1, [600, 1100, 2400]);
      return;
    }
    const n = this.noiseSrc(at, dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 2.5;
    bp.frequency.setValueAtTime(420, at);
    bp.frequency.exponentialRampToValueAtTime(2800, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + dur * 0.85);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    n.connect(bp).connect(g).connect(this.panner(pan));
    this.voice(this.panner(pan), at, dur, 160, [[0, 0.8], [dur, 1.7]], vol * 0.25, 1, [600, 1100, 2400]); // the rattle under it
  }

  /** A person's scream cut short: someone turning, something that was lying still getting up beside you. */
  cry(pan: number, vol: number): void {
    if (this.sample('male', this.panner(pan), vol * 1.4)) return;
    this.voice(this.panner(pan), this.ctx!.currentTime, 0.75, 330, [[0, 1], [0.12, 1.5], [0.5, 1.2], [0.75, 0.7]], vol, 0.8);
  }

  /** A crawler: what is left of it dragged over the road, and the wet rattle of something with no lungs to speak of. */
  drag(pan: number, vol: number): void {
    const ctx = this.ctx!, t0 = ctx.currentTime, out = this.panner(pan);
    for (let k = 0; k < 2; k++) {
      const at = t0 + k * 0.55, dur = 0.38;
      const n = this.noiseSrc(at, dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'bandpass';
      lp.frequency.setValueAtTime(260 + Math.random() * 120, at);
      lp.frequency.linearRampToValueAtTime(700, at + dur);
      lp.Q.value = 0.8;
      const g = ctx.createGain();
      this.env(g, at, vol, dur * 0.6, dur * 0.4);
      n.connect(lp).connect(g).connect(out);
    }
    this.voice(out, t0 + 0.2, 0.7, 95, [[0, 1], [0.7, 0.75]], vol * 0.5, 1, [500, 900, 2100]);
  }

  /** A lasher at rest: wet clicking, like knuckles cracking in mud, and something sliding over itself. */
  slither(pan: number, vol: number): void {
    const ctx = this.ctx!, t0 = ctx.currentTime, out = this.panner(pan);
    let at = t0;
    for (let k = 0, n = 5 + Math.floor(Math.random() * 6); k < n; k++) {
      const src = this.noiseSrc(at, 0.03);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1300 + Math.random() * 2400;
      bp.Q.value = 14;
      const g = ctx.createGain();
      this.env(g, at, vol * 1.6, 0.002, 0.025);
      src.connect(bp).connect(g).connect(out);
      at += 0.04 + Math.random() * 0.11;
    }
    const n = this.noiseSrc(t0, 0.9);
    const lp = ctx.createBiquadFilter();
    lp.type = 'bandpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(300, t0);
    lp.frequency.linearRampToValueAtTime(900, t0 + 0.45);
    lp.frequency.linearRampToValueAtTime(350, t0 + 0.9);
    const g = ctx.createGain();
    this.env(g, t0, vol * 0.7, 0.3, 0.6);
    n.connect(lp).connect(g).connect(out);
  }

  /** A lasher's strike: the whistle of it coming, and the crack. */
  whip(pan: number, vol: number, windup: number): void {
    const ctx = this.ctx!, t0 = ctx.currentTime, out = this.panner(pan);
    const n = this.noiseSrc(t0, windup + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 5;
    bp.frequency.setValueAtTime(350, t0);
    bp.frequency.exponentialRampToValueAtTime(5200, t0 + windup);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + windup);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + windup + 0.04);
    n.connect(bp).connect(g).connect(out);
    const crack = this.noiseSrc(t0 + windup, 0.07);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2200;
    const cg = ctx.createGain();
    this.env(cg, t0 + windup, vol * 2, 0.001, 0.06);
    crack.connect(hp).connect(cg).connect(out);
  }

  /** A stalker coming through the dark: a quick dry chitter, quieter than anything else out there. */
  chitter(pan: number, vol: number): void {
    const ctx = this.ctx!, t0 = ctx.currentTime, out = this.panner(pan);
    for (let k = 0; k < 9; k++) {
      const at = t0 + k * (0.035 + k * 0.006);
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 2600 - k * 150;
      const g = ctx.createGain();
      this.env(g, at, vol, 0.001, 0.014);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + 0.03);
    }
  }

  /** Something soft torn in two. */
  tear(pan: number, vol: number): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    if (this.sample(Math.random() < 0.5 ? 'eat' : 'crack', this.panner(pan), vol * 1.6)) { this.thud(vol * 0.5); return; }
    const n = this.noiseSrc(at, 0.4);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.5;
    bp.frequency.setValueAtTime(1800, at);
    bp.frequency.exponentialRampToValueAtTime(240, at + 0.35);
    const g = ctx.createGain();
    this.env(g, at, vol, 0.005, 0.35);
    n.connect(bp).connect(g).connect(this.panner(pan));
    this.thud(vol * 0.8);
  }

  /** The one sound that breaks the quiet: something heavy knocked over, somewhere close, and its ring dying away. */
  omen(pan: number): void {
    const ctx = this.ctx!, at = ctx.currentTime + 0.5;
    const out = this.panner(pan);
    for (const [f, v, d] of [[190, 0.3, 1.8], [287, 0.16, 1.3], [431, 0.1, 0.9], [72, 0.4, 0.5]] as const) {
      const o = ctx.createOscillator();
      o.type = f < 100 ? 'sine' : 'triangle';
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(f * 0.97, at + d);
      const g = ctx.createGain();
      this.env(g, at, v, 0.004, d);
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + d + 0.1);
    }
    const n = this.noiseSrc(at, 0.25);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    const ng = ctx.createGain();
    this.env(ng, at, 0.2, 0.003, 0.2);
    n.connect(bp).connect(ng).connect(out);
  }

  /** What the groaning turns into, late on: breath shaped like syllables, close to your ear, never quite words. */
  whisper(pan: number, vol: number): void {
    const ctx = this.ctx!, t0 = ctx.currentTime;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master); // inside your head: not dulled with the rest
    let at = t0;
    for (let k = 0, n = 3 + Math.floor(Math.random() * 4); k < n; k++) {
      const dur = 0.09 + Math.random() * 0.16;
      const src = this.noiseSrc(at, dur + 0.05);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(1200 + Math.random() * 2600, at);
      bp.frequency.linearRampToValueAtTime(1200 + Math.random() * 2600, at + dur);
      bp.Q.value = 5 + Math.random() * 5;
      const g = ctx.createGain();
      this.env(g, at, vol * (0.6 + Math.random() * 0.4), dur * 0.3, dur * 0.7);
      src.connect(bp).connect(g).connect(p);
      at += dur + 0.03 + Math.random() * 0.09;
    }
  }

  /** The quarantine loudspeakers: the three-note call for attention, then a voice too far off and too broken to follow. */
  pa(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const out = this.panner(Math.random() * 1.4 - 0.7);
    const echo = ctx.createDelay(1);
    echo.delayTime.value = 0.31;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = 'bandpass';
    tone.frequency.value = 1300;
    tone.Q.value = 0.9;
    tone.connect(out);
    tone.connect(echo);
    echo.connect(fb).connect(echo);
    echo.connect(out);
    [523, 659, 440].forEach((f, i) => {
      const at = t0 + i * 0.5;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      this.env(g, at, 0.05, 0.02, 0.6);
      o.connect(g).connect(tone);
      o.start(at);
      o.stop(at + 0.7);
    });
    let at = t0 + 1.9;
    for (let k = 0; k < 16; k++) { // the voice: a buzz through moving vowels, in the rhythm of an announcement
      const dur = 0.1 + Math.random() * 0.2;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(105 + Math.random() * 25, at);
      o.frequency.linearRampToValueAtTime(95 + Math.random() * 20, at + dur);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(500 + Math.random() * 1300, at);
      f.frequency.linearRampToValueAtTime(500 + Math.random() * 1300, at + dur);
      f.Q.value = 5;
      const g = ctx.createGain();
      this.env(g, at, 0.045, 0.02, dur);
      o.connect(f).connect(g).connect(tone);
      o.start(at);
      o.stop(at + dur + 0.05);
      at += dur + (k % 5 === 4 ? 0.35 : 0.04);
    }
  }

  stinger(): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    const g = ctx.createGain();
    this.env(g, at, 0.12, 0.05, 2.8);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, at);
    lp.frequency.exponentialRampToValueAtTime(200, at + 2.8);
    lp.connect(g).connect(this.sfx);
    for (const f of [65.4, 69.3, 98, 138.6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(lp);
      o.start(at);
      o.stop(at + 3);
    }
    const n = this.noiseSrc(at, 1.5);
    const ng = ctx.createGain();
    this.env(ng, at, 0.06, 0.6, 0.8);
    n.connect(ng).connect(this.sfx);
  }

  chime(): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    [660, 990].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      this.env(g, at + i * 0.09, 0.07, 0.01, 0.6);
      o.connect(g).connect(this.sfx);
      o.start(at + i * 0.09);
      o.stop(at + i * 0.09 + 0.7);
    });
  }

  /** A melee swing: a band-passed whoosh, and a dull impact if it connected. */
  swing(hits: number, heavy: boolean): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    const n = this.noiseSrc(at, 0.25);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(heavy ? 500 : 800, at);
    bp.frequency.exponentialRampToValueAtTime(heavy ? 1400 : 2200, at + 0.14);
    const g = ctx.createGain();
    this.env(g, at, 0.22, 0.04, 0.12);
    n.connect(bp).connect(g).connect(this.sfx);
    if (hits > 0 && this.sample('punch', this.sfx, heavy ? 0.75 : 0.6, heavy ? 0.85 : 1, at + 0.06)) {
      if (heavy) this.sample('crack', this.sfx, 0.4, 1, at + 0.08);
    } else if (hits > 0) {
      const t = at + 0.08;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(heavy ? 140 : 180, t);
      o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
      const og = ctx.createGain();
      this.env(og, t, 0.4, 0.002, 0.12);
      o.connect(og).connect(this.sfx);
      o.start(t);
      o.stop(t + 0.18);
    }
  }

  /** Breaking glass: a bright noise burst with a few tinkling partials. */
  smash(pan: number): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    const n = this.noiseSrc(at, 0.35);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    const g = ctx.createGain();
    this.env(g, at, 0.35, 0.002, 0.3);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    n.connect(hp).connect(g).connect(p).connect(this.sfx);
    for (let k = 0; k < 4; k++) {
      const o = ctx.createOscillator();
      o.frequency.value = 3000 + Math.random() * 3000;
      const og = ctx.createGain();
      const t = at + 0.03 + k * 0.05;
      this.env(og, t, 0.05, 0.001, 0.08);
      o.connect(og).connect(p);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  /** A car alarm: the classic two-tone whoop, for as long as it sounds. */
  private alarmOsc = new Map<number, { o: OscillatorNode; g: GainNode; p: StereoPannerNode }>();
  alarm(car: number, on: boolean): void {
    const ctx = this.ctx!;
    if (on && !this.alarmOsc.has(car)) {
      const o = ctx.createOscillator();
      o.type = 'square';
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2.2;
      const depth = ctx.createGain();
      depth.gain.value = 350;
      lfo.connect(depth).connect(o.frequency);
      o.frequency.value = 900;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      const g = ctx.createGain();
      g.gain.value = 0;
      const p = ctx.createStereoPanner();
      o.connect(lp).connect(g).connect(p).connect(this.sfx);
      o.start();
      lfo.start();
      this.alarmOsc.set(car, { o, g, p });
    } else if (!on) {
      const a = this.alarmOsc.get(car);
      if (!a) return;
      a.g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      a.o.stop(ctx.currentTime + 0.3);
      this.alarmOsc.delete(car);
    }
  }

  gunshot(kind: GunKind): void {
    if (this.sample(kind, this.sfx, kind === 'shotgun' ? 0.85 : kind === 'rifle' ? 0.7 : 0.6, 1, undefined, 0.03)) return;
    const ctx = this.ctx!, at = ctx.currentTime;
    const big = kind === 'shotgun', sharp = kind === 'rifle';
    const n = this.noiseSrc(at, big ? 0.5 : 0.25);
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.setValueAtTime(big ? 2600 : sharp ? 5200 : 3800, at);
    bp.frequency.exponentialRampToValueAtTime(300, at + (big ? 0.4 : 0.18));
    const g = ctx.createGain();
    this.env(g, at, big ? 0.55 : sharp ? 0.3 : 0.38, 0.002, big ? 0.45 : 0.16);
    n.connect(bp).connect(g).connect(this.sfx);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(big ? 90 : 130, at);
    o.frequency.exponentialRampToValueAtTime(40, at + 0.15);
    const og = ctx.createGain();
    this.env(og, at, big ? 0.5 : 0.3, 0.002, 0.15);
    o.connect(og).connect(this.sfx);
    o.start(at);
    o.stop(at + 0.2);
  }

  click(high = false): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = high ? 2400 : 1500;
    const g = ctx.createGain();
    this.env(g, at, 0.05, 0.001, 0.03);
    o.connect(g).connect(this.sfx);
    o.start(at);
    o.stop(at + 0.05);
  }

  thud(vol: number): void {
    const ctx = this.ctx!, at = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, at);
    o.frequency.exponentialRampToValueAtTime(35, at + 0.25);
    const g = ctx.createGain();
    this.env(g, at, vol, 0.004, 0.3);
    o.connect(g).connect(this.sfx);
    o.start(at);
    o.stop(at + 0.35);
    const n = this.noiseSrc(at, 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const ng = ctx.createGain();
    this.env(ng, at, vol * 0.6, 0.003, 0.25);
    n.connect(lp).connect(ng).connect(this.sfx);
  }

  private engineOn(): void {
    if (this.engine || !this.ctx) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc2.type = 'square';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.07, ctx.currentTime, 0.2);
    osc.connect(lp);
    osc2.connect(lp);
    lp.connect(gain).connect(this.master);
    osc.start();
    osc2.start();
    this.engine = { osc, osc2, gain, lp };
  }

  private engineOff(): void {
    if (!this.engine || !this.ctx) return;
    const e = this.engine;
    e.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    e.osc.stop(this.ctx.currentTime + 0.6);
    e.osc2.stop(this.ctx.currentTime + 0.6);
    this.engine = null;
  }

  /**
   * Per frame: react to events, pace footsteps and heartbeat, let nearby zombies groan. `held`: the game is
   * stopped behind something (sign-in, the store, a conversation): the world keeps its wind, but you are not walking.
   */
  update(s: GameState, events: readonly GameEvent[], dt: number, panOf: (x: number, y: number) => number, held = false): void {
    if (!this.ctx || this.muted) return;
    this.t += dt;
    const p = s.player.pos;
    const car = s.phase === 'playing' && !held ? playerVehicle(s) : null;
    if (car) {
      this.engineOn();
      const f = 32 + Math.abs(car.speed) * 4.5;
      this.engine!.osc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.08);
      this.engine!.osc2.frequency.setTargetAtTime(f * 0.5, this.ctx.currentTime, 0.08);
      this.engine!.lp.frequency.setTargetAtTime(300 + Math.abs(car.speed) * 60, this.ctx.currentTime, 0.1);
    } else this.engineOff();
    // car alarms: louder the closer you are, panned to where the car is; silenced on a new night
    for (const [car, a] of this.alarmOsc) {
      const al = s.alarms.find((x) => x.car === car);
      if (!al || s.phase !== 'playing') { this.alarm(car, false); continue; }
      const d = Math.hypot(al.pos.x - p.x, al.pos.y - p.y);
      a.g.gain.setTargetAtTime(0.09 / (1 + d / 12), this.ctx.currentTime, 0.1);
      a.p.pan.setTargetAtTime(panOf(al.pos.x, al.pos.y), this.ctx.currentTime, 0.1);
    }
    for (const e of events) {
      if (e.type === 'shot') this.gunshot(e.weapon);
      else if (e.type === 'swing') this.swing(e.hits, e.weapon === 'bat');
      else if (e.type === 'throw') this.swing(0, false);
      else if (e.type === 'bottle-smash') this.smash(panOf(e.pos.x, e.pos.y));
      else if (e.type === 'alarm-start') this.alarm(e.car, true);
      else if (e.type === 'alarm-stop') this.alarm(e.car, false);
      else if (e.type === 'house-searched' || e.type === 'survivor-done' || e.type === 'refueled') this.chime();
      else if (e.type === 'equip') this.click();
      else if (e.type === 'reload') this.click();
      else if (e.type === 'empty') this.click(true);
      else if (e.type === 'pickup' || e.type === 'purchase') this.chime();
      else if (e.type === 'vehicle-crash') this.thud(Math.min(0.5, e.force / 25));
      else if (e.type === 'zombie-killed' && car) this.thud(0.3);
      else if (e.type === 'zombie-killed') this.sample('hurt', this.panner(0), 0.32, 0.85, undefined, 0.12); // its last sound
      else if (e.type === 'down') this.cry(0, 0.35); // a player falls (rooms)
      else if (e.type === 'lost' && e.reason !== 'carrier' && !car) {
        // the turning: a last heartbeat as you go down, and what gets up makes their sound
        this.heartbeat(0.45);
        this.sample('growl', this.panner(0), 0.6, 0.72, this.ctx.currentTime + 2.35, 0);
      } else if (e.type === 'turned') this.sample('growl', this.panner(panOf(e.pos.x, e.pos.y)), 0.5, 0.8);
      else if (e.type === 'tier-up' || e.type === 'burst') this.stinger();
      else if (e.type === 'omen') this.omen(panOf(e.pos.x, e.pos.y));
      else if (e.type === 'light') this.click(e.on);
      else if (e.type === 'antiviral' || e.type === 'husk-down') this.chime();
      else if (e.type === 'bitten') { this.thud(0.35); this.heartbeat(0.4); this.nextBeat = this.t + 0.5; }
      else if (e.type === 'checked') { if (e.bitten) this.thud(0.4); else this.chime(); }
      else if (e.type === 'cough') {
        const d = Math.hypot(e.pos.x - p.x, e.pos.y - p.y);
        this.cough(panOf(e.pos.x, e.pos.y), e.who === null ? 0.3 : Math.min(0.26, 1.2 / (d + 3)), e.who === null);
      } else if (e.type === 'scream') {
        const d = Math.hypot(e.pos.x - p.x, e.pos.y - p.y);
        this.shriek(panOf(e.pos.x, e.pos.y), Math.min(0.3, 3 / (d + 6)));
      } else if (e.type === 'dormant-wake') {
        const z = s.zombies.find((q) => q.id === e.id);
        if (z) { this.cry(panOf(z.pos.x, z.pos.y), 0.28); this.thud(0.3); }
      } else if (e.type === 'escort-turned' && e.where !== 'inside') this.cry(0, e.where === 'street' ? 0.4 : 0.12);
      else if (e.type === 'halved') {
        const z = s.zombies.find((q) => q.id === e.id);
        if (z) this.tear(panOf(z.pos.x, z.pos.y), 0.3);
      } else if (e.type === 'grabbed') this.thud(0.4);
      else if (e.type === 'task-done') this.chime();
      else if (e.type === 'zombie-attack' || e.type === 'zombie-alert') {
        const z = s.zombies.find((q) => q.id === e.id);
        if (!z) continue;
        const d = Math.hypot(z.pos.x - p.x, z.pos.y - p.y);
        const vol = Math.min(0.35, 2.2 / (d + 2));
        const pan = panOf(z.pos.x, z.pos.y);
        if (z.action === 'scream') this.inhale(pan, Math.min(0.3, 3 / (d + 5)), SCREAM_WINDUP); // a screamer filling its lungs: your warning
        else if (e.type === 'zombie-alert') this.groan(pan, vol, true);
        else if (z.kind === 'lasher') this.whip(pan, Math.min(0.3, vol * 1.6), ATTACK_WINDUP.lasher);
        else if (z.kind === 'crawler') this.drag(pan, vol * 1.5);
        else this.scream(pan, vol * 1.4);
      }
    }
    if (s.phase !== 'playing' || held) return;

    // the infection in your ears: the world goes dull; the moment before they come, the wind drops away
    const inf = infection(s), now = this.ctx.currentTime;
    this.dull.frequency.setTargetAtTime(18000 * Math.pow(0.11, Math.max(0, inf - 0.35) / 0.65), now, 0.5);
    this.amb.gain.setTargetAtTime(s.director.phase === 'dread' ? 0.04 : 1, now, s.director.phase === 'dread' ? 0.25 : 1.2);

    if (this.t > this.nextSiren) { this.siren(); this.nextSiren = this.t + 25 + Math.random() * 30; }

    const sp = playerSpeed(s);
    if (!car && sp > 0.3 && this.t > this.nextStep) {
      this.footstep(Math.min(0.12, 0.04 + sp * 0.015));
      this.nextStep = this.t + Math.max(0.24, 0.62 - sp * 0.07);
    }

    let nearest = Infinity;
    for (const z of s.zombies) {
      const d = Math.hypot(z.pos.x - p.x, z.pos.y - p.y);
      nearest = Math.min(nearest, d);
      if (d > 22 || z.action === 'rise' || z.frozen) continue; // a stalker in your light makes no sound at all
      if (z.action === 'dormant' && d > 7) continue; // the ones lying still: a breath, if you are close and listening
      const due = this.groanAt.get(z.id) ?? this.t + Math.random() * 4;
      if (this.t >= due) {
        const pan = panOf(z.pos.x, z.pos.y), vol = Math.min(0.22, 1.6 / (d + 3));
        if (z.action === 'dormant') this.groan(pan, 0.035, false);
        else if (z.kind === 'crawler') this.drag(pan, vol * 2);
        else if (z.kind === 'lasher') this.slither(pan, vol * 2.4);
        else if (z.kind === 'stalker') this.chitter(pan, vol * 0.35);
        else if (z.kind === 'screamer') this.voice(this.panner(pan), this.ctx.currentTime, 0.9, 300, [[0, 1], [0.5, 1.15], [0.9, 0.95]], vol * 0.5, 0.7); // a thin keening
        else if (inf > 0.66 && Math.random() < (inf - 0.5) * 1.4) this.whisper(pan, vol * 0.8); // you start to understand them
        else this.groan(pan, vol, z.action === 'chase');
        this.groanAt.set(z.id, this.t + (z.action === 'dormant' ? 7 : z.action === 'chase' ? 2 : 4.5) + Math.random() * 4);
      } else if (!this.groanAt.has(z.id)) this.groanAt.set(z.id, due);
    }

    // your heart: louder and faster the further gone you are, the closer they are, and in the breath before they come
    const sickBeat = inf > 0.5 ? 0.3 + (inf - 0.5) * 1.4 : 0;
    if ((sickBeat > 0 || nearest < 6 || s.director.phase === 'dread') && this.t > this.nextBeat) {
      const urgency = Math.min(1, Math.max(sickBeat, nearest < 6 ? 1 - nearest / 6 : 0, s.director.phase === 'dread' ? 0.6 : 0));
      this.heartbeat(0.18 + urgency * 0.2);
      this.nextBeat = this.t + 60 / (75 + urgency * 70);
    }
  }
}
