import {
  chapterBonus, clearLeft, createGame, currentTask, finalChapter, nextChapter, requiredDone, restartChapter, step,
  taskTarget, type GameState,
} from '../../core/state';
import { command, quantize, Recorder, STEP, type Command } from '../../core/replay';
import type { Driver, Host } from './net/room';
import {
  briefFor, chapterCard, chapterLines, doneFor, escortBehind, exitLabel, exitLocked, exitOpen, hero, hint, intro, setHero, lockedTask, objectiveFor,
  paLine, partsReady, shortName, survivorLines, tierLines, vehicleLines, type Line,
} from '../../core/story';
import type { GameEvent, Husk, Task, TaskId } from '../../core/types';
import type { Loadout } from '../../core/loadout';
import { SURVIVORS, type SurvivorId } from '../../core/survivors';
import type { SkinName } from './render/characters';
import { chapterInfo, content, setChapter, setContent, stepDef, type Content } from '../../core/content';
import { GameView } from './render/view';
import { loadCharacterAssets } from './render/characters';
import { loadModels } from './render/models';
import { Controls } from './input/controls';
import { Hud } from './ui/hud';
import { Dialogue } from './ui/dialogue';
import { Talk, type NextUp } from './ui/talk';
import type { Sound } from './audio/sound';
import { CityMap } from './ui/map';
import { GEAR, WEAPON_NAMES } from '../../core/config';
import type { StorePage } from './ui/store';
import { anonymousSession } from './seams/session';
import { noopProgress, type RunResult } from './seams/progress';

const SIM_DT = STEP; // fixed timestep (the same one a replay uses)
const MAX_STEPS_PER_FRAME = 5;
// The game itself. The site (app.ts: home, play, ranks, profile...) loads first and imports this in the background;
// the import resolves once the city's assets are in, and the site then calls playSolo() or openRooms().
const params = new URLSearchParams(location.search);
/** The cold open (run by the site) is still on screen: nothing to draw under it. */
const splashOn = () => !!document.getElementById('splash') && !document.documentElement.classList.contains('intro-seen');
/** Into play: the site hides, and from here a phone held upright is asked to turn (the site and lobby read fine upright). */
const playing = () => document.documentElement.classList.add('playing');
const debug = params.has('debug');

type Mode = 'title' | 'intro' | 'play' | 'ending' | 'room';

const newSeed = () => (Math.random() * 0xffffffff) >>> 0; // randomness lives here, not in core/
/** Tonight's city, the same for everyone today (the server's word), once it is known; a random night until then or offline. */
let tonight: number | null = null;
/** The server answered: sign-in is possible, so the guest allowance applies. Offline, the game is simply free to play. */
let serverUp = false;
const nightSeed = () => tonight ?? newSeed();
/** Be the survivor a loadout names (Sam if none): their skin, and their name in every line. */
function wear(l: Loadout | undefined): void {
  const sv = SURVIVORS[l?.survivor ?? 'sam'];
  setHero(sv.name);
  view.setKit(l?.kit ?? []); // what shows on the body all night (the ammo belt)
  void view.setHeroSkin(sv.skin as SkinName);
}
/** What the player chose in the armoury for this night (signed in only): the ranked loadout for tonight's city, the open one
 * for any other. The site keeps the server's copy on this device. Nothing chosen is the standard kit. */
/** What the night just started carries, by name (the site keeps the names with the loadouts), to say so at the start. */
let carried: string[] | null = null;
function loadoutFor(night: number): Loadout | undefined {
  carried = null;
  try {
    const me = JSON.parse(localStorage.getItem('zp.account') ?? 'null') as { address: string } | null;
    const a = JSON.parse(localStorage.getItem('zp.armoury') ?? 'null') as { address: string; loadouts: { ranked: Loadout; open: Loadout }; carry?: { ranked: string[]; open: string[] } } | null;
    if (!me || !a || a.address !== me.address) return undefined;
    carried = (night === tonight ? a.carry?.ranked : a.carry?.open) ?? null;
    const l = night === tonight ? a.loadouts.ranked : a.loadouts.open;
    return l.kit.length || l.hand || l.survivor || Object.values(l.ups).some(Boolean) ? l : undefined;
  } catch { return undefined; }
}
// the task content (what each step is, says and looks like) comes as data, before the first night
setContent(await fetch('/content/tasks.json').then((r) => r.json() as Promise<Content>));
// Your last self: where a district took you, and what you had in hand. It is waiting there the next time
// you come through that chapter (kept on this device until you put it down).
const HUSK_KEY = 'zp.husk';
/** What the server says of your last selves, when you are signed in (it, not this device, is believed). */
const serverSelves = new Map<number, Husk | null>();
function lastSelf(chapter: number): Husk | null {
  if (serverSelves.has(chapter)) return serverSelves.get(chapter)!;
  try {
    const h = JSON.parse(localStorage.getItem(HUSK_KEY) ?? 'null') as (Husk & { chapter: number }) | null;
    return h && h.chapter === chapter && h.pos ? { pos: h.pos, weapon: h.weapon } : null;
  } catch { return null; }
}
function rememberSelf(s: GameState | null): void {
  try {
    if (s) localStorage.setItem(HUSK_KEY, JSON.stringify({ chapter: s.chapter, pos: s.player.pos, weapon: s.arsenal.weapon }));
    else localStorage.removeItem(HUSK_KEY);
  } catch { /* no storage here: it just will not be waiting */ }
}
// The night is written down as it is played (every step's input, and everything done between steps),
// so it can be re-run and checked. It goes out with the run's result.
let rec!: Recorder;
let roomDriver: Driver | null = null;
/** Make a chapter's state (with your last self, if it is waiting there) and start its page of the log. */
function fresh(make: (husk: Husk | null) => GameState, chapter: number, loadout?: Loadout): GameState {
  const husk = lastSelf(chapter);
  const g = make(husk);
  if (chapter === 0) rec = new Recorder(g.night, content().version, loadout);
  rec.begin(chapter, husk);
  return g;
}
/** The one door for changes made outside a step (a purchase, a puzzle answer): done, and written down. */
function act(c: Command): boolean {
  if (roomDriver) return roomDriver.act(c); // in a room the server does it
  rec.command(c);
  return command(state, c);
}
let state: GameState = fresh((husk) => createGame(params.has('seed') ? Number(params.get('seed')) >>> 0 : newSeed(), undefined, { husk }), 0);
let mode: Mode = 'title';
let endTimer = -1;
let lastTaskId: TaskId | null = null;
let wasReady = false;

const $ = (id: string) => document.getElementById(id)!;
const [assets] = await Promise.all([loadCharacterAssets(), loadModels()]); // a failure rejects the site's import: it says so

const view = new GameView($('game'), assets);
const controls = new Controls($('game'), $('stick'), $('knob'));
const dialogue = new Dialogue();
const talk = new Talk();
/** Story lines to show in the Talk panel at the end of this frame (the game waits while it is open). */
const convo: Line[] = [];
/** The engine warnings already given this night (once for a car, once for a bike). */
const warned = new Set<string>();
let swarmTold = false;
/** Things explained already this night (each once: the first cough, the first red X, the light...). */
const told = new Set<string>();
/** Say a first-time line, as a subtitle over play, or (blocking) in the panel you read. */
function once(key: string, blocking = false): void {
  if (told.has(key)) return;
  told.add(key);
  if (blocking) convo.push(...hint(key)); else dialogue.say(hint(key));
}
let paT = 25, paN = 0; // the quarantine loudspeakers: when the next announcement is, and which
// The sound engine is its own chunk, fetched as soon as the game is (nothing makes a sound before a night starts):
// until it is in, a tap's wish to start or mute it is remembered and carried out when it arrives.
let sound: Sound | null = null, soundOn = false, soundMuted = false;
void import('./audio/sound').then((m) => { sound = new m.Sound(); if (soundMuted) sound.setMuted(true); if (soundOn) sound.start(); });
const startSound = () => { soundOn = true; sound?.start(); };
const hud = new Hud({
  retry: () => begin(fresh((husk) => restartChapter(state, husk), state.chapter, rec.loadout), false),
  newNight: () => { const n = nightSeed(), l = loadoutFor(n); wear(l); begin(fresh((husk) => createGame(n, undefined, { husk, loadout: l }), 0, l), false); },
});
view.cinematic = 0;
let paused = false; // store or full map open
// Guests get a taste: this many seconds of play on this device, then the game waits for a sign-in.
const GUEST_SECONDS = 180;
const signedIn = () => { try { return !!localStorage.getItem('zp.account'); } catch { return false; } };
let guestT = 0;
try { guestT = Number(localStorage.getItem('zp.guest')) || 0; } catch { /* private mode: the taste is per page */ }
let gated = false;
function guestTick(dt: number): void {
  if (gated || !serverUp || signedIn()) return;
  const before = Math.floor(guestT);
  guestT += dt;
  if (Math.floor(guestT) !== before) try { localStorage.setItem('zp.guest', String(Math.floor(guestT))); } catch { /* kept for this page */ }
  if (guestT < GUEST_SECONDS || mode !== 'play') return; // a room round is never cut off: the lobby asks next time
  gated = true; paused = true; controls.enabled = false;
  void import('./net/gate').then((m) => m.showGate(() => { gated = false; paused = cityMap.open || storeOpen(); controls.reset(); controls.enabled = !paused && !talk.open; }));
}
/** The weapon store's page, loaded the first time you walk into one (it is not in the main bundle). */
let storePage: StorePage | null = null;
const storeOpen = () => storePage?.open ?? false;
const cityMap = new CityMap((open) => { paused = open || storeOpen(); controls.enabled = !paused; }, () => document.documentElement.classList.contains('playing') && (mode === 'play' || mode === 'room') && !gated && !storeOpen() && !document.getElementById('gate'));

$('mute').addEventListener('click', () => {
  soundMuted = !soundMuted;
  sound?.setMuted(soundMuted);
  $('mute').textContent = `Sound: ${soundMuted ? 'off' : 'on'}`;
});
// Frame rate: 30 a second on phones (half the drawing, and plenty for this game), 60 on a computer.
// Nothing to set: `?fps=30|60` overrides, for testing.
const phone = window.matchMedia?.('(pointer: coarse)').matches ?? false;
const fps30 = (params.get('fps') ?? (phone ? '30' : '60')) === '30';

// Quality steps itself down if the device cannot keep up: phones start a step lighter, and a device
// that once had to step down starts where it ended up. `?quality=0..2` fixes it.
const quality = (() => {
  const fixed = params.has('quality') ? Number(params.get('quality')) : null;
  let level = fixed ?? Number(localStorage.getItem('outbreak.quality') ?? (phone ? 1 : 0));
  let frames = 0, span = 0;
  view.setQuality(level);
  return {
    /** A frame was drawn during play `dt` after the last one. */
    tick(dt: number): void {
      if (fixed !== null || level >= 2) return;
      frames++;
      span += dt;
      if (span < 4) return;
      const got = frames / span, want = fps30 ? 30 : 60;
      frames = 0; span = 0;
      if (got < want * 0.85) { level++; localStorage.setItem('outbreak.quality', String(level)); view.setQuality(level); }
    },
    reset(): void { frames = 0; span = 0; },
  };
})();

const roomHost: Host = {
  view, controls,
  toast: (t) => hud.toast(t),
  enter(shadow, driver, survivor) {
    state = shadow; roomDriver = driver; mode = 'room';
    playing(); wear(survivor ? { kit: [], ups: {}, survivor: survivor as SurvivorId } : undefined); // who you brought into the room
    hud.reset(); setChapter(0); paused = false; controls.enabled = true; hud.cinema(false); convo.length = 0;
  },
  refreshStore: () => storePage?.refresh(),
};
/** The multiplayer lobby, over the site (it reads fine upright): straight into quick play or a new room if asked, or a room by its code. */
export function openRooms(opts: { join?: string; act?: 'quick' | 'create' } = {}): void {
  startSound();
  void import('./net/room').then((m) => m.openLobby(roomHost, opts));
}
// an invite link (?join=CODE, or ?staked=USDT:5 for a staked room) opens the lobby straight away
if (params.has('join') || params.has('staked')) void import('./net/room').then((m) => { document.addEventListener('pointerdown', startSound, { once: true }); m.openLobby(roomHost, { join: params.get('join') ?? undefined, staked: params.get('staked') ?? undefined }); });
// signed in on this device: ask the server where your last selves are waiting
if (localStorage.getItem('zp.account')) void import('./net/account').then(async (m) => { for (let c = 0; c < 3; c++) serverSelves.set(c, await m.lastSelfFromServer(c)); });
// Phones play in landscape. Where the browser allows it (Android, from a tap), go full screen and
// lock the orientation; everywhere else a "turn your phone" screen covers portrait and the game waits.
const touch = document.documentElement.classList.contains('mobile'); // set in index.html
const portrait = matchMedia('(orientation: portrait)');
const upright = () => touch && (portrait.matches || window.innerHeight > window.innerWidth);
async function goLandscape(): Promise<void> {
  if (!touch) return;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.('landscape');
  } catch { /* not allowed here (iPhone, desktop): the rotate screen covers it */ }
}
// no zooming: no pinch (iOS gesture events), no double-tap zoom, no long-press menu
for (const ev of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick', 'contextmenu']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

/** Start a night from the site (called from a tap, so full screen and the sideways lock are allowed). Tonight's city,
 * the same for everyone and on the board; or, for practice, a city nobody else has. */
export function playSolo(practice = false): void {
  void goLandscape();
  startSound();
  playing();
  // tonight's city (once the server has said which it is) with the ranked loadout; a practice night with the open one
  const seed = practice || tonight === null ? newSeed() : tonight, l = loadoutFor(seed);
  wear(l);
  begin(fresh((husk) => createGame(seed, undefined, { husk, loadout: l }), 0, l), !params.has('skipintro'));
}
void import('./net/account').then((m) => m.tonight(content().version)).then((r) => { serverUp = r !== null; if (!params.has('seed')) tonight = r?.night ?? null; });
if (debug) Object.defineProperty(window, '__outbreak', { get: () => ({ state, mode, view, sound, log: rec.log() }) }); // test hook

/** Start a chapter (or a night). The full intro plays once; retries and new chapters go straight
 * to the street. */
function begin(fresh: GameState, withIntro: boolean): void {
  state = fresh;
  hud.reset();
  storePage?.hide();
  if (talk.open) talk.close();
  convo.length = 0;
  document.body.classList.remove('fade');
  setChapter(fresh.chapter);
  if (fresh.chapter === 0) { warned.clear(); told.clear(); }
  paT = 25;
  paused = false;
  controls.enabled = true;
  if (cityMap.open) cityMap.toggle();
  dialogue.clear();
  endTimer = -1;
  lastTaskId = null;
  wasReady = false;
  if (withIntro) {
    mode = 'intro';
    hud.cinema(true);
    view.cinematic = 0;
    hud.showCard(intro().card, intro().sub, 3.2);
    window.setTimeout(() => dialogue.playCutscene(intro().lines, startPlay), 3400);
  } else {
    const c = chapterCard(state.chapter);
    hud.showCard(c.card, c.sub, 2.2);
    startPlay();
    if (state.chapter > 0) convo.push(...chapterLines(finalChapter(state)));
  }
}

/** The next thing to do, in full, with how far it is. */
function nextUp(): NextUp | null {
  const final = finalChapter(state);
  const cur = currentTask(state);
  const ready = requiredDone(state);
  const target = ready ? (state.safehouseKnown ? state.safehouse : null) : cur ? taskTarget(state, cur) : null;
  const title = ready ? exitLabel(final) : cur ? objectiveFor(cur, final, cur.kind === 'clear' ? clearLeft(state, cur) : null) : null;
  if (!title) return null;
  const m = target ? Math.round(Math.hypot(target.x - state.player.pos.x, target.y - state.player.pos.y) * 0.63) : null;
  return { title, detail: m !== null ? `${m} m away. Follow the yellow arrow and the ring on your map.` : 'Look around.' };
}

/** Open the Talk panel with what this frame had to say; the game holds until it is read. */
function openTalk(objectiveChanged: boolean): void {
  if (mode === 'room') { dialogue.say(convo.splice(0)); return; } // nothing waits for anyone in a room
  if (convo.length === 0 && !objectiveChanged) return;
  if (state.phase !== 'playing') { convo.length = 0; return; }
  const lines = convo.splice(0);
  dialogue.clear();
  controls.enabled = false;
  controls.reset();
  talk.show(lines, objectiveChanged ? nextUp() : null, () => {
    controls.reset();
    controls.enabled = !paused;
    act({ t: 'grace' }); // a moment to get moving before they come on again
  });
}

/** Down the subway stairs and up into the next district. */
function advance(): void {
  const bonus = chapterBonus(state);
  begin(fresh((husk) => nextChapter(state, husk), state.chapter + 1), false);
  if (bonus > 0) hud.toast(`+$${bonus} for time to spare`);
}

function startPlay(): void {
  mode = 'play';
  hud.cinema(false);
  if (state.chapter === 0 && carried?.length) hud.toast(`You carry: ${carried.join(', ')}`, 4500); // what the armoury sent you in with
}

function finish(): void {
  mode = 'ending';
  hud.cinema(true);
  dialogue.clear();
  const result: RunResult = {
    seed: state.night,
    chapter: state.chapter,
    outcome: state.phase === 'won' ? 'won' : 'lost',
    lossReason: state.lossReason,
    secondsLeft: state.remaining,
    timeLimit: state.timeLimit,
    optionalDone: state.tasks.filter((t) => !t.required && t.done).length,
    replay: rec.log(),
  };
  void noopProgress.saveRun(anonymousSession, result);
  if (localStorage.getItem('zp.account')) void import('./net/account').then(async (m) => { const up = await m.uploadRun(result); if (up?.score !== undefined) hud.toast(`Score ${up.score.toLocaleString()}${up.bank ? ` · +${up.bank.earned + up.bank.ration} banked${up.bank.fees ? `, ${up.bank.fees} loan fee` : ''}` : ''}`); else if (up && !up.replayOk && up.reason) hud.toast(`Not counted: ${up.reason}`); for (let c = 0; c < 3; c++) serverSelves.set(c, await m.lastSelfFromServer(c)); });
  hud.showEnd(state);
}

const task = (id: TaskId): Task | undefined => state.tasks.find((t) => t.id === id);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A puzzle page (loaded the first time one is needed). The game waits while it is open; the answer is
 * checked by the core, and whatever that sets off is told like any other moment. */
async function openPuzzle(t: Task): Promise<void> {
  paused = true;
  controls.enabled = false;
  const { showPuzzle } = await import('./ui/puzzle');
  showPuzzle(t, {
    solve: (answer) => {
      const ok = act({ t: 'solve', id: t.id, answer });
      const happened = state.events.splice(0); // outside step(): pass them on by hand
      pending.push(...happened);
      if (ok) narrate(happened);
      else hud.toast('That is not it.');
      return ok;
    },
    close: () => { paused = cityMap.open || storeOpen(); controls.reset(); controls.enabled = !paused && !talk.open; },
  });
}

/** Story beats driven by what happened this frame. */
function narrate(events: readonly GameEvent[]): void {
  let forceNext = false;
  for (const e of events) {
    switch (e.type) {
      case 'part-taken':
        hud.toast(`${cap(stepDef(e.id).parts?.name ?? 'piece')} ${e.got} of ${e.of}`);
        if (e.got === e.of) { const t = task(e.id); if (t) convo.push(...partsReady(t)); forceNext = true; }
        break;
      case 'escort-behind': dialogue.say(escortBehind(currentTask(state))); break;
      case 'puzzle-open': { const t = task(e.id); if (t) openPuzzle(t); break; }
      case 'puzzle-wrong': hud.toast('That is not it.'); break;
      case 'clear-start': hud.toast(`${e.count} of them, and they've seen you. Fight!`); view.shake(0.4); break;
      case 'flare-lit': hud.toast('The flare is pulling them in. Keep away from it.'); break;
      case 'horde': hud.toast('They heard that. Here they come!'); view.shake(0.6); break;
      case 'task-done': { const t = task(e.id); if (t) convo.push(...doneFor(t, finalChapter(state))); break; }
      case 'tier-up': dialogue.say(tierLines(e.tier)); view.shake(0.5); break;
      case 'safehouse-locked':
        dialogue.say(exitLocked(state.tasks.filter((t) => t.required && !t.done).map((t) => shortName(t)), finalChapter(state)));
        break;
      case 'task-locked':
        dialogue.say(lockedTask(e.needs.flatMap((id) => { const t = task(id); return t ? [shortName(t)] : []; })));
        break;
      case 'zombie-attack': {
        const z = state.zombies.find((q) => q.id === e.id);
        if (z && Math.hypot(z.pos.x - state.player.pos.x, z.pos.y - state.player.pos.y) < 3) { view.shake(0.35); hud.hurt(); }
        break;
      }
      case 'lost':
        if (e.reason === 'caught') { view.shake(1.2); hud.hurt(); }
        if (e.reason === 'caught' || e.reason === 'time') rememberSelf(state); // you will be here next time
        break;
      case 'player-hit': hud.hurt(); view.shake(0.4); break;
      case 'bitten': if (e.seconds > 0.5) { hud.surge(); hud.toast(`Bitten. The infection jumps ${Math.round(e.seconds)} seconds.`); } break;
      case 'light': hud.toast(e.on ? 'Light on' : 'Light off: they see less of you'); if (!e.on) once('light'); break;
      case 'omen': once('omen'); break;
      case 'halved': once('halved'); break;
      case 'grabbed': hud.toast('It has your leg! Kill it or drag it with you.'); view.shake(0.3); break;
      case 'burst': hud.toast('They are coming up out of the ground!'); view.shake(0.5); break;
      case 'dormant-wake': view.shake(0.35); once('dormant'); break;
      case 'scream': hud.toast(e.count > 0 ? `A screamer! ${e.count} more know where you are.` : 'A screamer!'); view.shake(0.5); once('scream'); break;
      case 'cough':
        if (e.who) { hud.toast(`${e.who} is coughing.`); once('cough', true); }
        else if (!told.has('own-cough')) { told.add('own-cough'); hud.toast('You cough. Anything close heard that.'); }
        break;
      case 'checked': hud.toast(e.bitten ? `${e.name} is bitten. Leave them here (LEAVE), or they turn beside you.` : `${e.name} is clean.`); if (e.bitten) view.shake(0.3); break;
      case 'left-behind': dialogue.say([{ who: e.name, text: 'Please. Not here. Don\'t leave me here.' }, { who: hero(), text: 'I\'m sorry.' }]); break;
      case 'escort-turned':
        if (e.where === 'street') { hud.toast(`${e.name} has turned! Put them down before they reach the others.`); view.shake(0.8); }
        else if (e.where === 'left') hud.toast(`Somewhere behind you, ${e.name} has turned.`);
        break;
      case 'husk-down': rememberSelf(null); hud.toast('It was carrying what you carried. Take it back.'); break;
      case 'block-fallen': if (!told.has('spread')) { told.add('spread'); hud.toast('Another block has fallen. Your map shows them in red.'); } break;
      case 'pickup':
        hud.toast(e.kind === 'ammo' ? `+${e.amount} ammo`
          : e.kind === 'bottles' ? `+${e.amount} bottles: throw one (G) to draw them away`
            : e.kind === 'jerrycan' ? 'Jerrycan: fill up a car (stand by it, REFUEL)'
              : e.kind === 'antiviral' ? (e.amount > 0 ? `Antiviral dose: the infection held back ${e.amount} s` : 'Antiviral dose: nothing to hold back yet')
              : e.kind === 'vest' || e.kind === 'helmet' ? `${GEAR[e.kind].name}: takes part of every hit`
                : `Picked up: ${WEAPON_NAMES[e.kind]}`);
        break;
      case 'crate-opened':
        hud.toast(e.loot === 'medkit' ? 'Medkit: +health' : e.loot === 'supplies' ? 'Supplies: +$25' : e.loot === 'ammo' ? 'Ammo' : 'Empty');
        break;
      case 'vehicle-enter': {
        swarmTold = false;
        const v = state.vehicles.find((x) => x.id === e.id);
        const bike = v?.kind === 'bike';
        if (v && !warned.has(bike ? 'bike' : 'car')) { warned.add(bike ? 'bike' : 'car'); convo.push(...vehicleLines(bike)); }
        hud.toast(v && v.fuel < 0.15 ? 'Almost no fuel. Find a jerrycan or the gas station.' : 'Drive with the stick. The engine draws them in.');
        break;
      }
      case 'latched': hud.toast(e.count > 1 ? `${e.count} hanging on! Speed up to shake them off.` : 'One grabbed hold! Speed up to shake it off.'); view.shake(0.3); break;
      case 'guarded': hud.toast(`${e.count} of them are standing over it. Thin them out or slip past.`); break;
      case 'no-room': hud.toast(`${e.need} of them and room for ${e.seats}. Find a bigger car.`); break;
      case 'swarm': if (!swarmTold) { swarmTold = true; hud.toast('The engine! They are pouring out of the side streets.'); } break;
      case 'escort-danger': hud.toast(`They're on ${e.name}! Get between them.`); break;
      case 'chase': hud.toast(`They have your scent. Run for ${finalChapter(state) ? 'the helicopter' : chapterInfo().way}!`); view.shake(0.5); break;
      case 'vehicle-breached': hud.toast('The glass is gone. They can reach you! Shake them off or get out.'); view.shake(0.6); break;
      case 'out-of-fuel': hud.toast('Out of fuel. It rolls to a stop.'); break;
      case 'refueled': hud.toast(e.from === 'pump' ? 'Filling up at the pump...' : 'Refuelled.'); break;
      case 'house-searched':
        hud.toast(`${e.loot === 'antiviral' ? 'An antiviral dose: the infection held back' : e.loot === 'medkit' ? 'First aid: +health' : e.loot === 'supplies' ? 'Cash in a drawer: +$25' : e.loot === 'ammo' ? 'A box of rounds' : e.loot === 'bottles' ? 'Empty bottles' : e.loot === 'vest' || e.loot === 'helmet' ? `A ${GEAR[e.loot].name.toLowerCase()}, still good` : 'Nothing worth taking'}${e.ambush ? '. Something moves inside!' : ''}`);
        if (e.ambush) view.shake(0.4);
        break;
      case 'alarm-start': hud.toast('Car alarm! Everything nearby is heading for it.'); break;
      case 'survivor-asked': {
        const v = state.survivors.find((x) => x.id === e.id);
        if (v) { if (e.first) convo.push(...survivorLines(v, 'asked')); else dialogue.say(survivorLines(v, 'reminder')); }
        break;
      }
      case 'survivor-ready': { const v = state.survivors.find((x) => x.id === e.id); if (v) dialogue.say(survivorLines(v, 'ready')); break; }
      case 'fetched': { const v = state.survivors.find((x) => x.id === e.id); if (v) dialogue.say(survivorLines(v, 'fetched')); break; }
      case 'survivor-done': { const v = state.survivors.find((x) => x.id === e.id); if (v) convo.push(...survivorLines(v, 'done', e.reward)); break; }
      case 'gear-broken': hud.toast(`Your ${e.gear} is torn apart. Buy another at a weapon store.`); break;
      case 'chapter-cleared': hud.toast(chapterInfo().exit === 'gate' ? 'Through the barricade and out of the docks...' : 'Down the stairs, into the dark...'); break;
      case 'vehicle-wrecked': hud.toast('The engine dies. Get out!'); view.shake(0.8); break;
      case 'empty': hud.toast('Out of ammo. Swap to your baton (Q), or buy rounds at a weapon store.'); break;
      case 'store-open': {
        const st = state.stores.find((x) => x.id === e.id);
        if (!st) break;
        paused = true;
        controls.enabled = false;
        const shown = state;
        void (async () => {
          if (!storePage) { const { StorePage: Page } = await import('./ui/store'); storePage = new Page((t) => hud.toast(t), act); }
          if (state !== shown || state.phase !== 'playing') { paused = cityMap.open; controls.enabled = !paused; return; }
          storePage.show(state, st, () => { paused = cityMap.open; controls.enabled = !paused; });
        })();
        break;
      }
      default: break;
    }
  }
  // first sight of the things worth a word: a red X, a fallen block, a stalker in your light, your last self
  if (state.phase === 'playing') {
    const p = state.player.pos, close = (q: { x: number; y: number }, r: number) => Math.hypot(q.x - p.x, q.y - p.y) < r;
    if (!told.has('mark') && state.houses.some((h) => h.mark === 'infected' && !h.searched && close(h.pos, 6))) once('mark');
    if (!told.has('fallen') && state.inFallen) { hud.toast('This block has fallen.'); once('fallen'); }
    if (!told.has('stalker') && state.zombies.some((z) => z.frozen && close(z.pos, 13))) once('stalker');
    for (const k of ['crawler', 'lasher'] as const) if (!told.has(k) && state.zombies.some((z) => z.kind === k && z.action !== 'dead' && close(z.pos, 9))) once(k);
    if (!told.has('husk') && state.zombies.some((z) => z.husk && z.action !== 'dead' && close(z.pos, 14))) once('husk');
  }
  let changed = forceNext;
  const curTask = currentTask(state);
  const cur = curTask?.id ?? null;
  if (cur !== lastTaskId) {
    lastTaskId = cur;
    changed = true;
    if (curTask) convo.push(...briefFor(curTask, finalChapter(state)));
  }
  const ready = requiredDone(state);
  if (ready && !wasReady) { convo.push(...exitOpen(finalChapter(state))); changed = true; }
  wasReady = ready;
  openTalk(changed);
}

let last = performance.now();
let acc = 0;
const pending: GameEvent[] = [];
let frames = 0, fpsT = 0, fps = 0, stepMs = 0, renderMs = 0;
const debugEl = $('debug');

let miniTick = 0;

function frame(now: number): void {
  if (splashOn()) { last = now; requestAnimationFrame(frame); return; } // nothing to draw under the cold open
  // Draw only as often as it is worth: under the site (which covers it) twice a second, a held
  // story moment or the store is still (20/s), phones run at 30/s; a computer plays at the screen's
  // rate. The sim's fixed step does not care: it catches up on the time between frames.
  const still = (paused && !cityMap.open) || talk.open;
  const gap = mode === 'title' ? 500 : still ? 48 : fps30 ? 31 : 0;
  if (gap && now - last < gap) { requestAnimationFrame(frame); return; }
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  const t0 = performance.now();
  if (mode === 'play' && !paused && !talk.open && !upright()) {
    acc += dt;
    let n = 0;
    while (acc >= SIM_DT && n < MAX_STEPS_PER_FRAME) {
      const input = quantize(controls.read());
      step(state, input, SIM_DT);
      rec.step(input);
      pending.push(...state.events); // step() clears events, so collect them across sub-steps
      acc -= SIM_DT;
      n++;
    }
    if (n === MAX_STEPS_PER_FRAME) acc = 0;
    guestTick(dt);
    narrate(pending);
    paT -= dt;
    if (paT <= 0 && state.phase === 'playing') { paT = 55 + Math.random() * 35; sound?.pa(); dialogue.say(paLine(paN++)); }
    if (state.phase !== 'playing' && endTimer < 0) {
      // let the moment play out before the ending card
      // won and cleared play out a scene first: met and checked by the soldiers, aboard, lifting off;
      // or walking down into the subway
      // a lost night on foot plays the turning: you go down, and get up as one of them
      endTimer = state.phase === 'won' || state.phase === 'cleared' || GameView.turns(state) ? 30 : state.lossReason !== 'time' ? 2.6 : 1.2; // a scene ends when it has played
      if (state.phase === 'cleared' || state.phase === 'won') hud.cinema(true);
    }
  } else if (mode === 'room') {
    acc = 0;
    pending.push(...roomDriver!.frame(dt)); // the server runs the room: this draws it, walks you, and passes on what happened
    guestTick(dt);
    narrate(pending);
  } else {
    acc = 0;
  }
  if (endTimer >= 0 && mode === 'play') {
    // the scene has played out: fade to black into the next district, or straight to the ending
    if (endTimer > 1 && view.outroDone()) { endTimer = state.phase === 'cleared' ? 0.6 : state.phase === 'lost' ? 0.5 : 0.3; if (state.phase === 'cleared') document.body.classList.add('fade'); }
    endTimer -= dt;
    if (endTimer < 0) { if (state.phase === 'cleared') advance(); else finish(); }
  }
  stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;

  // the camera eases from the wide establishing shot to gameplay
  const wantCine = mode === 'title' ? 0 : mode === 'intro' ? 0.35 : 1;
  view.cinematic += (wantCine - view.cinematic) * (1 - Math.exp(-(mode === 'intro' ? 0.25 : 1.2) * dt));

  dialogue.update(dt);
  talk.update(dt);
  hud.update(state, view);
  sound?.update(state, pending, dt, (x, y) => view.screenX({ x, y }), mode === 'play' && (paused || talk.open || upright()));
  view.react(state, pending);
  pending.length = 0;
  if ((mode === 'play' || mode === 'room') && (still || miniTick++ % 3 === 0)) cityMap.drawMini(state);
  if (mode === 'play' && !still && !paused) quality.tick(dt); else quality.reset(); // the minimap at 20/s is plenty
  cityMap.drawFull(state);

  const t1 = performance.now();
  view.render(state, dt);
  renderMs = renderMs * 0.9 + (performance.now() - t1) * 0.1;

  if (debug) {
    frames++;
    fpsT += dt;
    if (fpsT >= 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
    const i = view.renderer.info;
    debugEl.textContent =
      `fps ${fps.toFixed(0)}  sim ${stepMs.toFixed(2)}ms  render(cpu) ${renderMs.toFixed(2)}ms\n` +
      `calls ${i.render.calls}  tris ${i.render.triangles}  geoms ${i.memory.geometries}  tex ${i.memory.textures}\n` +
      `seed ${state.seed}  tier ${state.tier}  zombies ${state.zombies.length}  mode ${mode}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
