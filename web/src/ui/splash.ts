// The cold open, shared with Zombie Plague's first game: a logo gate over a looping clip, then a
// transmission from the commander who signed the containment order, typed out in three acts over
// ambient sound, then the title slams in. Ported from plague-celo's splash (React) to plain DOM; the
// markup is in index.html so the gate paints in the first frame, before any script runs.
//
// The words are Port Halden's. Keep the shape: nine lines, three acts of three. The scream is keyed
// to the third line (the end of Act I) and the act changes drive the fades. The commander is
// infected and has not turned yet; the tell is the last fragment of the last line, after the "…".
//
// Captions carry the story on their own (most phones are muted). Nothing heavy loads before it is
// needed: the gate clip only after the page has loaded, and never on a slow or data-saving link.
import { isMuted, setMuted } from '../seams/mute';

type Act = 1 | 2 | 3;
const STORY: Array<{ text: string; act: Act }> = [
  { text: 'Port Halden Command. If you hear this, you are still inside.', act: 1 },
  { text: 'Day 1 — we closed the harbour. Two sailors. High fever.', act: 1 },
  { text: 'Day 3 — the hospitals stopped counting.', act: 1 },
  { text: 'We told you the city was contained. I signed that order myself.', act: 2 },
  { text: 'We lied.', act: 2 },
  { text: 'It was already in the streets. And now they run.', act: 2 },
  { text: 'We are sealing the city, district by district.', act: 3 },
  { text: 'One last helicopter leaves tonight, from the far side.', act: 3 },
  { text: 'Get to it. Do not stop for anyone. …it is so cold in here.', act: 3 },
];
const TELL = '…';
const BG = ['bg-horror', 'bg-zombie-portrait', 'bg-patient-zero', 'bg-game'].map((n) => `/intro/${n}.webp`);
const MS_PER_CHAR = 44, BETWEEN = 720, ACT_FADE = 1300, ACT_PAUSE = 2000;
export const SEEN_KEY = 'zp_intro_seen';

/** Runs the splash if it is showing; resolves when it is gone (at once if it never showed). */
export function runSplash(): Promise<void> {
  const el = document.getElementById('splash');
  if (!el || getComputedStyle(el).display === 'none') return Promise.resolve();
  const root: HTMLElement = el;
  return new Promise((resolve) => {
    const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    const gate = $('.gate'), story = $('.story'), lines = $('.lines'), enter = $<HTMLButtonElement>('.enter');
    const bgs = $('.bgs'), finale = $<HTMLVideoElement>('.finale'), muteBtn = $<HTMLButtonElement>('.mute');
    let muted = isMuted(), ended = false, act3 = false;
    muteBtn.textContent = muted ? '🔇 MUTED' : '🔊 SOUND ON';
    const audios: HTMLAudioElement[] = [];
    let ambient: HTMLAudioElement | null = null;
    const timers: number[] = [];
    const later = (ms: number, f: () => void) => { timers.push(window.setTimeout(f, ms)); };
    const sleep = (ms: number) => new Promise<void>((r) => later(ms, r));
    const play = (src: string, volume: number) => {
      const a = new Audio(src);
      a.volume = volume;
      audios.push(a);
      if (!muted) a.play().catch(() => {});
      return a;
    };

    // drifting embers
    const motes = $('.motes');
    for (let i = 0; i < 24; i++) {
      const p = document.createElement('span');
      const size = 3 + Math.random() * 5;
      p.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;animation-duration:${6 + Math.random() * 8}s;animation-delay:${Math.random() * 8}s`;
      motes.appendChild(p);
    }

    // the gate clip, once the page has settled, unless the connection says not to
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    const slow = !!conn && (conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType ?? ''));
    if (!slow) {
      const arm = () => later(600, () => {
        if (ended || !gate.isConnected || story.classList.contains('on')) return;
        const v = document.createElement('video');
        Object.assign(v, { src: '/intro/zombie-clip-1.mp4', poster: '/intro/gate-poster.webp', autoplay: true, muted: true, loop: true, playsInline: true, preload: 'metadata' });
        v.className = 'clip gateclip';
        $('.poster').after(v);
      });
      if (document.readyState === 'complete') arm(); else window.addEventListener('load', arm, { once: true });
    }

    const finish = (instant: boolean) => {
      if (ended) return;
      ended = true;
      sessionStorage.setItem(SEEN_KEY, '1');
      const close = () => {
        for (const t of timers) clearTimeout(t);
        ambient?.pause();
        for (const a of audios) a.pause();
        root.remove();
        document.removeEventListener('keydown', onKey);
        resolve();
      };
      if (instant) { close(); return; }
      root.classList.add('static', 'slam');
      play('/intro/reveal-sting.mp3', 0.35);
      ambient?.pause();
      window.setTimeout(() => root.classList.add('exit'), 260);
      window.setTimeout(close, 900);
    };
    const onKey = (e: KeyboardEvent) => {
      if (story.classList.contains('on') && (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape')) finish(false);
    };
    document.addEventListener('keydown', onKey);
    $('.skip').addEventListener('click', () => finish(true));
    enter.addEventListener('click', () => finish(false));
    muteBtn.addEventListener('click', () => {
      muted = !muted;
      setMuted(muted);
      muteBtn.textContent = muted ? '🔇 MUTED' : '🔊 SOUND ON';
      if (muted) { ambient?.pause(); for (const a of audios) a.pause(); } else ambient?.play().catch(() => {});
    });

    // the gate: a tap starts the sound inside the gesture (phones only allow it there), then the story
    $('.begin').addEventListener('click', () => {
      ambient = new Audio('/intro/ambient-lobby.mp3');
      ambient.loop = true;
      ambient.volume = 0.28;
      if (!muted) ambient.play().catch(() => {});
      gate.classList.add('gone');
      root.querySelector('.gateclip')?.remove();
      $('.poster').remove();
      story.classList.add('on');
      muteBtn.hidden = false;
      // backgrounds crossfade every 4.5 s, each loaded only just before it is needed
      let k = 0;
      const show = () => {
        if (k < BG.length && !bgs.children[k]) { const d = document.createElement('div'); d.style.backgroundImage = `url(${BG[k]})`; bgs.appendChild(d); }
        if (k + 1 < BG.length) { const n = new Image(); n.src = BG[k + 1]!; }
        [...bgs.children].forEach((d, i) => (d as HTMLElement).classList.toggle('on', i === k));
      };
      show();
      const step = () => { if (ended || k >= BG.length - 1) return; k++; show(); later(4500, step); };
      later(4500, step);
      void type();
    }, { once: true });

    let lastBeat = 0;
    async function type(): Promise<void> {
      const rows: HTMLElement[] = [];
      let prev: Act | null = null;
      for (let i = 0; i < STORY.length; i++) {
        const { text, act } = STORY[i]!;
        if (ended) return;
        if (prev !== null && act !== prev) { // the act before fades and folds away
          const old = rows.filter((r) => r.dataset.act === String(prev));
          for (const r of old) r.classList.add('fade');
          later(ACT_FADE + 100, () => { for (const r of old) r.classList.add('folded'); });
          await sleep(ACT_PAUSE);
        }
        if (act === 3 && !act3) { act3 = true; finale.src = '/intro/zombie-clip-2.mp4'; finale.play().catch(() => {}); finale.classList.add('on'); }
        const row = document.createElement('div');
        row.className = `line act${act}${i === STORY.length - 1 ? ' last' : ''}`;
        row.dataset.act = String(act);
        const p = document.createElement('p');
        p.className = 'typing';
        row.appendChild(p);
        lines.appendChild(row);
        rows.push(row);
        if (Date.now() - lastBeat > 1400) { lastBeat = Date.now(); play('/intro/heartbeat.mp3', 0.18); }
        if (i === 2) later(500, () => { // the scream at the end of Act I, echoing away
          const s = play('/intro/infected-win.mp3', 0.24);
          for (let k = 1; k <= 20; k++) later(k * 200, () => { s.volume = Math.max(0, 0.24 * (1 - k / 20)); if (k === 20) s.pause(); });
        });
        const cut = text.indexOf(TELL);
        for (let c = 1; c <= text.length; c++) {
          if (ended) return;
          const shown = text.slice(0, c);
          if (i === STORY.length - 1 && cut >= 0 && c > cut) { // the transmission coming apart
            p.textContent = text.slice(0, cut);
            const tell = document.createElement('span');
            tell.className = 'tell';
            tell.textContent = shown.slice(cut);
            p.appendChild(tell);
          } else p.textContent = shown;
          await sleep(MS_PER_CHAR);
        }
        p.classList.remove('typing');
        await sleep(BETWEEN);
        prev = act;
      }
      root.classList.add('done');
      enter.focus();
    }
  });
}
