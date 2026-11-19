import { clearLeft, currentTask, escortGroup, finalChapter, infection, interactionFor, isGun, latchedOn, playerVehicle, requiredDone, taskTarget, type GameState } from '../../../core/state';
import { ending, exitLabel, objectiveFor, shortName, verbFor } from '../../../core/story';
import { CHAPTERS, GEAR, PLAYER_HEALTH, VEHICLES, WEAPON_NAMES } from '../../../core/config';
import type { Interaction } from '../../../core/types';
import type { GameView } from '../render/view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fmt = (s: number) => {
  const t = Math.ceil(Math.max(0, s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function useLabel(s: GameState, it: Interaction | null): string | null {
  if (!it) return null;
  switch (it.kind) {
    case 'exit': return 'GET OUT';
    case 'enter': return 'GET IN';
    case 'crate': return 'SEARCH';
    case 'store': return 'ENTER';
    case 'house': return 'ENTER'; // only if you choose to: walking past does nothing
    case 'talk': return 'TALK';
    case 'refuel': return 'REFUEL';
    case 'alarm': return 'ALARM';
    case 'check': return `CHECK ${escortGroup(s)[it.who]?.name ?? ''}`.trim().toUpperCase();
    case 'leave': return `LEAVE ${escortGroup(s)[it.who]?.name ?? ''}`.trim().toUpperCase();
    case 'task': { const t = s.tasks.find((x) => x.id === it.taskId); return t ? verbFor(t) : 'USE'; }
    case 'climb': return it.up ? 'CLIMB' : 'CLIMB DOWN';
    case 'hide': return 'HIDE';
    case 'unhide': return 'COME OUT';
  }
}

/** Veins growing in from the edges of the screen (drawn once; the infection sets how much of them shows). */
function veinSvg(): string {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out: string[] = [];
  const grow = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    for (let k = 0; k < 5; k++) {
      a += (rnd() - 0.5) * 1.1;
      x += Math.cos(a) * len;
      y += Math.sin(a) * len;
      d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
      if (depth < 2 && rnd() < 0.5) grow(x, y, a + (rnd() < 0.5 ? 0.8 : -0.8), len * 0.72, w * 0.6, depth + 1);
    }
    out.push(`<path d="${d}" stroke-width="${w.toFixed(1)}"/>`);
  };
  for (let i = 0; i < 18; i++) {
    const t = rnd() * 100, edge = i % 4;
    const x = edge === 0 ? 0 : edge === 1 ? 100 : t, y = edge === 2 ? 0 : edge === 3 ? 100 : t;
    grow(x, y, Math.atan2(50 - y, 50 - x), 2.8 + rnd() * 2, 1.5 + rnd() * 1.3, 0);
  }
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none">${out.join('')}</svg>`;
}

export class Hud {
  private timer = $('timer');
  private task = $('task');
  private toastEl = $('toast');
  private arrow = $('arrow');
  private arrowIcon = $('arrow-icon');
  private arrowDist = $('arrow-dist');
  private hold = $('hold');
  private holdBar = $('hold-bar');
  private hurtEl = $('hurt');
  private card = $('card');
  private endScreen = $('ending');
  private film = $('film');
  private filmVideo = $('film-video') as HTMLVideoElement;
  private healthBar = $('health-bar');
  private funds = $('funds');
  private carHealth = $('car-health');
  private useBtn = $('btn-use');
  private ammo = $('ammo');
  private weaponName = $('weapon-name');
  private fireBtn = $('btn-fire');
  private throwBtn = $('btn-throw');
  private bottles = $('bottles');
  private reloadBtn = $('btn-reload');
  private clockLabel = document.querySelector('#clock small') as HTMLElement;
  private gear = $('gear');
  private veins = $('veins');
  private infBar = $('infection-bar');
  private lightBtn = $('btn-light');
  private lightState = $('light-state');
  private crouchBtn = $('btn-crouch');
  private lastInf = -1;
  private lastClock = '';
  private toastTimer = 0;
  private hurtTimer = 0;
  private lastTimer = '';
  private lastTask = '';

  constructor(handlers: { retry: () => void; newNight: () => void }) {
    this.veins.innerHTML = veinSvg();
    $('retry').addEventListener('click', handlers.retry);
    $('new-night').addEventListener('click', handlers.newNight);
    window.addEventListener('keydown', (e) => {
      if (this.endScreen.style.display !== 'flex') return;
      if (e.code === 'Enter' || e.code === 'Space') handlers.retry();
      if (e.code === 'KeyN') handlers.newNight();
    });
  }

  reset(): void {
    this.endScreen.style.display = 'none';
    this.endScreen.classList.remove('turned');
    this.stopFilm();
    this.lastTimer = this.lastTask = '';
  }

  cinema(on: boolean): void {
    document.body.classList.toggle('cinema', on);
  }

  /** Chapter title card, faded in and out. */
  showCard(title: string, sub: string, seconds: number): void {
    $('card-title').textContent = title;
    $('card-sub').textContent = sub;
    this.card.classList.add('on');
    window.setTimeout(() => this.card.classList.remove('on'), seconds * 1000);
  }

  /** A bite: the clock jumps, and you see it jump. */
  surge(): void {
    this.timer.classList.remove('surge');
    void this.timer.offsetWidth;
    this.timer.classList.add('surge');
  }

  hurt(): void {
    this.hurtEl.style.opacity = '1';
    clearTimeout(this.hurtTimer);
    this.hurtTimer = window.setTimeout(() => { this.hurtEl.style.opacity = '0'; }, 350);
  }

  toast(text: string, ms = 1800): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('on'), ms);
  }

  update(s: GameState, view: GameView): void {
    const t = fmt(s.remaining);
    if (t !== this.lastTimer) {
      this.lastTimer = t;
      this.timer.textContent = t;
      this.timer.classList.toggle('low', s.remaining <= 20);
    }

    const final = finalChapter(s);
    const clock = `CHAPTER ${s.chapter + 1}/${CHAPTERS} · YOU TURN IN`;
    // the infection: a bar that fills and reddens, and veins in the corners of your eyes
    const inf = Math.round(infection(s) * 50) / 50;
    if (inf !== this.lastInf) {
      this.lastInf = inf;
      this.infBar.style.width = `${inf * 100}%`;
      this.infBar.style.background = inf < 0.34 ? '#7fd38a' : inf < 0.67 ? '#d8c13a' : '#d9443a';
      this.veins.style.opacity = String(Math.max(0, Math.min(0.8, (inf - 0.3) / 0.7)));
    }
    if (clock !== this.lastClock) { this.lastClock = clock; this.clockLabel.textContent = clock; }
    const cur = currentTask(s);
    const ready = requiredDone(s);
    const label = ready ? exitLabel(final) : cur ? objectiveFor(cur, final, cur.kind === 'clear' ? clearLeft(s, cur) : null) : 'Find another way through';
    const optional = s.tasks.filter((x) => !x.required && !x.done);
    const html = `${label}${!ready && optional.length ? `<small>Optional, costs time: ${optional.map((o) => shortName(o)).join(', ')}</small>` : ''}`;
    if (html !== this.lastTask) {
      this.lastTask = html;
      this.task.innerHTML = html;
    }

    // vitals
    this.healthBar.style.width = `${(s.player.health / PLAYER_HEALTH) * 100}%`;
    this.funds.textContent = `Scrap ${s.funds}${s.arsenal.cans ? `  ·  Fuel can x${s.arsenal.cans}` : ''}`;
    // protective gear, as what is left of each piece
    const worn = (['vest', 'helmet'] as const).filter((g) => s.arsenal.gear[g] > 0);
    this.gear.style.display = worn.length ? 'block' : 'none';
    if (worn.length) this.gear.textContent = worn.map((g) => `${g === 'vest' ? 'Vest' : 'Helmet'} ${Math.ceil((s.arsenal.gear[g] / GEAR[g].durability) * 100)}%`).join('  ·  ');
    const car = playerVehicle(s);
    this.carHealth.style.display = car ? 'block' : 'none';
    if (car) {
      const fuel = Math.round(car.fuel * 100);
      const on = latchedOn(s, car.id);
      const hp = Math.round((car.health / VEHICLES[car.kind].health) * 100);
      this.carHealth.textContent = `${car.kind === 'bike' ? 'Bike' : 'Car'} ${hp}%  ·  Fuel ${fuel}%${s.pumping ? ' (filling)' : fuel === 0 ? ' (empty)' : ''}${on ? `  ·  ${on} on it!` : ''}`;
      this.carHealth.style.color = fuel < 15 || on > 0 || hp < 40 ? '#ff8a6a' : '';
    }
    this.lightBtn.style.display = car ? 'none' : 'flex';
    this.crouchBtn.style.display = car || s.player.hide !== null ? 'none' : 'flex';
    if (this.crouchBtn.classList.contains('on') !== s.player.crouched) this.crouchBtn.classList.toggle('on', s.player.crouched);
    if (this.lightBtn.classList.contains('off') === s.light) {
      this.lightBtn.classList.toggle('off', !s.light);
      this.lightState.textContent = s.light ? 'ON' : 'OFF';
    }
    const throwable = !car && s.arsenal.bottles > 0;
    this.throwBtn.style.display = throwable ? 'flex' : 'none';
    if (throwable) this.bottles.textContent = String(s.arsenal.bottles);

    // weapon and contextual Use button
    const a = s.arsenal;
    if (a.weapon) {
      const gun = isGun(a.weapon) ? a.weapon : null;
      this.ammo.textContent = !gun ? 'MELEE' : a.reloadT > 0 ? '...' : `${a.mag[gun]}/${a.ammo[gun]}`;
      this.weaponName.textContent = WEAPON_NAMES[a.weapon];
      const fire = gun ? 'FIRE' : 'SWING';
      if (this.fireBtn.textContent !== fire) this.fireBtn.textContent = fire;
      this.reloadBtn.style.visibility = gun ? 'visible' : 'hidden';
    }
    const use = useLabel(s, interactionFor(s));
    this.useBtn.style.display = use ? 'flex' : 'none';
    if (use && this.useBtn.textContent !== use) this.useBtn.textContent = use;

    // turned (rooms): one of them now. No gun, no light, nothing to use: one button, BITE, dim while you gather for the next
    const turned = s.mode === 'room' && s.player.status === 'turned';
    if (document.body.classList.contains('zombie-hud') !== turned) document.body.classList.toggle('zombie-hud', turned);
    if (turned) {
      if (this.fireBtn.textContent !== 'BITE') this.fireBtn.textContent = 'BITE';
      this.fireBtn.classList.toggle('cool', s.player.lungeCd > 0);
      this.ammo.textContent = 'HUNT';
      this.weaponName.textContent = 'Teeth and nails';
    }

    // compass arrow to the current objective when it is off screen
    const target = ready ? (s.safehouseKnown ? s.safehouse : null) : cur ? taskTarget(s, cur) : null;
    if (target && s.phase === 'playing' && !view.onScreen(target)) {
      const ang = view.screenAngle(s.player.pos, target);
      this.arrow.style.display = 'block';
      this.arrowIcon.style.transform = `rotate(${ang + Math.PI / 2}rad)`;
      this.arrowDist.textContent = `${Math.round(Math.hypot(target.x - s.player.pos.x, target.y - s.player.pos.y) * 0.63)} m`;
    } else {
      this.arrow.style.display = 'none';
    }

    const progress = s.hold.taskId ? s.hold.progress : s.work ? s.work.progress : -1;
    this.hold.style.display = progress >= 0 ? 'block' : 'none';
    this.holdBar.style.width = `${Math.min(1, Math.max(0, progress)) * 100}%`;
  }

  /** Fetch the film and the ending's picture while you are going down, so neither waits when it is wanted. */
  preloadFilm(): void {
    if (this.filmVideo.preload !== 'auto') { this.filmVideo.preload = 'auto'; this.filmVideo.load(); }
    new Image().src = '/ending/end.webp';
  }

  /**
   * You turning, on film, full screen; then the ending. A tap skips it; if it cannot play, straight on.
   * `onStart` is told when it starts rolling (for its sound).
   */
  playFilm(then: () => void, onStart?: () => void): void {
    const v = this.filmVideo;
    let left = false;
    const done = () => {
      if (left) return;
      left = true;
      clearTimeout(cap);
      this.film.classList.add('out'); // fades out over the ending behind it
      then();
      setTimeout(() => this.stopFilm(), 700);
    };
    const cap = setTimeout(done, 6000); // never stuck on it
    this.film.classList.remove('out');
    this.film.style.display = 'block';
    v.currentTime = 0;
    v.playbackRate = 0.8;
    v.onended = done;
    v.onerror = done;
    this.film.onclick = done;
    v.play().then(() => onStart?.(), done);
  }

  private stopFilm(): void {
    this.filmVideo.pause();
    this.film.style.display = 'none';
    this.film.classList.remove('out');
  }

  showEnd(s: GameState): void {
    this.endScreen.classList.toggle('turned', s.phase === 'lost');
    const outcome = s.phase === 'won' ? 'won' : s.lossReason ?? 'caught';
    const e = ending(outcome, finalChapter(s));
    const title = $('end-title');
    title.textContent = e.title;
    title.className = s.phase === 'won' ? 'won' : 'lost';
    $('end-text').textContent = s.phase === 'won'
      ? `${e.text} (${fmt(s.remaining)} to spare, ${s.kills} infected down.)`
      : `${e.text} (Chapter ${s.chapter + 1} of ${CHAPTERS}.)`;
    $('retry').textContent = s.chapter > 0 && s.phase !== 'won' ? 'Retry chapter' : 'Try again';
    $('end-seed').textContent = `Night ${s.night}${s.chapter > 0 ? ` · chapter ${s.chapter + 1}` : ''}`;
    this.arrow.style.display = 'none';
    this.hold.style.display = 'none';
    this.endScreen.style.display = 'flex';
  }
}
