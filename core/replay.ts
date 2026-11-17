// A night, written down so it can be played again: every input of every step, and everything done
// outside a step (a purchase, a weapon taken in hand, a puzzle answer, the moment's grace after a story
// panel). Re-running the log through the same rules gives the same night, which is how a server can
// check a result it did not watch. Pure: no DOM, no clock.
//
// The rules use their own sin, cos, atan2 and hypot (dmath.ts), built from operations the language
// specifies exactly, so a log recorded in one engine (Safari on an iPhone) replays to the same bits in
// another (Node on the server). `hashState` is the fingerprint two replays are compared by.
import { SAFE_AFTER } from './config';
import { buy, createGame, createRoom, equip, nextChapter, solvePuzzle, step, type GameState } from './state';
import type { Husk, Input, StoreItem, TaskId, WeaponKind } from './types';
import type { Loadout } from './loadout';

/** A fingerprint of where a night stands (FNV-1a over the numbers that matter, hashed from their exact bits). */
export function hashState(s: GameState): string {
  let h = 0x811c9dc5;
  const f64 = new Float64Array(1), bytes = new Uint8Array(f64.buffer);
  const byte = (b: number) => { h = Math.imul(h ^ b, 0x01000193) >>> 0; };
  const num = (v: number) => { f64[0] = v; for (let i = 0; i < 8; i++) byte(bytes[i]!); };
  const str = (t: string) => { for (let i = 0; i < t.length; i++) byte(t.charCodeAt(i) & 255); byte(0); };
  str(s.phase);
  num(s.chapter);
  for (const p of s.players) {
    num(p.pos.x); num(p.pos.y); num(p.health); num(p.remaining); num(p.funds); num(p.kills);
  }
  num(s.rng.s); num(s.rng2.s);
  for (const z of s.zombies) { num(z.id); num(z.pos.x); num(z.pos.y); num(z.health); }
  return h.toString(16).padStart(8, '0');
}

/** The fixed step every night is simulated at. */
export const STEP = 1 / 60;
/** Longest chapter a log may hold, in steps (twenty minutes). */
export const MAX_CHAPTER_STEPS = 20 * 60 * 60;

export type Command =
  | { t: 'buy'; item: StoreItem }
  | { t: 'equip'; weapon: WeaponKind }
  | { t: 'solve'; id: TaskId; answer: number[] | string }
  /** A story panel was closed: a moment to get moving before they come on again. */
  | { t: 'grace' };

/** Do something that happens between steps. The only way the game changes state outside `step`. */
export function command(s: GameState, c: Command, seat = 0): boolean {
  s.cur = s.players[seat] ?? s.players[0]!; // whose it is (the seat in a room; the only player in a solo night)
  switch (c.t) {
    case 'buy': return buy(s, c.item);
    case 'equip': return equip(s, c.weapon);
    case 'solve': return solvePuzzle(s, c.id, c.answer);
    case 'grace': s.safeT = Math.max(s.safeT, SAFE_AFTER); return true;
  }
}

export interface ChapterLog {
  /** Your last self, if it was waiting in this chapter. */
  husk: Husk | null;
  /** Inputs, run-length encoded and flat: [count, dx, dy, buttons, count, dx, dy, buttons, ...]. */
  runs: number[];
  /** [steps simulated before it, what was done]. */
  commands: Array<[number, Command]>;
}

export interface NightLog {
  v: 1;
  /** The task content's version: a replay must use the same content. */
  content: number;
  night: number;
  /** One per chapter reached, the attempt that counted (a retry starts its chapter's log again). */
  chapters: ChapterLog[];
  /** What the player brought from the armoury (absent: the standard kit). The server checks it is theirs. */
  loadout?: Loadout;
}

const Q = 64; // the stick is recorded in 64ths: what is simulated is exactly what is written down
const BUTTONS = ['action', 'fire', 'reload', 'swap', 'throw', 'light'] as const;

/** Round an input to what the log can hold. Simulate with the result, not the original. */
export function quantize(i: Input): Input {
  const q = (v: number) => Math.round(Math.max(-1.5, Math.min(1.5, v)) * Q) / Q;
  const out: Input = { dx: q(i.dx), dy: q(i.dy) };
  for (const b of BUTTONS) if (i[b]) out[b] = true;
  return out;
}

const pack = (i: Input) => BUTTONS.reduce((m, b, k) => (i[b] ? m | (1 << k) : m), 0);
function unpack(dx: number, dy: number, m: number): Input {
  const out: Input = { dx, dy };
  BUTTONS.forEach((b, k) => { if (m & (1 << k)) out[b] = true; });
  return out;
}

/** Writes a night down as it is played. */
export class Recorder {
  private chapters: ChapterLog[] = [];
  private cur: ChapterLog | null = null;
  private steps = 0;

  constructor(readonly night: number, readonly content: number, readonly loadout?: Loadout) {}

  /** A chapter begins (or begins again: a retry throws away the attempt before it, and anything after). */
  begin(chapter: number, husk: Husk | null): void {
    this.chapters.length = chapter;
    this.cur = { husk, runs: [], commands: [] };
    this.chapters[chapter] = this.cur;
    this.steps = 0;
  }

  /** One step was simulated with this (quantized) input. */
  step(i: Input): void {
    const c = this.cur;
    if (!c) return;
    const r = c.runs, n = r.length, m = pack(i);
    if (n && r[n - 3] === i.dx && r[n - 2] === i.dy && r[n - 1] === m) r[n - 4]!++;
    else r.push(1, i.dx, i.dy, m);
    this.steps++;
  }

  command(c: Command): void {
    this.cur?.commands.push([this.steps, c]);
  }

  log(): NightLog {
    return { v: 1, content: this.content, night: this.night, chapters: this.chapters, ...(this.loadout ? { loadout: this.loadout } : {}) };
  }
}

/** How one chapter of a replayed night ended (what a server needs to keep track of someone's last self). */
export interface ChapterEnd {
  chapter: number;
  phase: GameState['phase'];
  lossReason: GameState['lossReason'];
  remaining: number;
  kills: number;
  /** Where the player was when the chapter ended, and what they held. */
  pos: { x: number; y: number };
  weapon: WeaponKind | null;
  /** They put their last self down in this chapter. */
  huskDown: boolean;
  /** The chapter's time limit in steps, and how many steps the log spent in it. */
  stepsAllowed: number;
  steps: number;
}

/**
 * Play a written-down night again and return where it ended. Throws if the log cannot be what
 * happened (a chapter follows one that was never cleared).
 */
export function replay(log: NightLog): GameState {
  return replayChapters(log).final;
}

/** The same, with how each chapter ended. */
/** What a night held, counted from the replay itself (never from the client): the leaderboard's raw material. */
export interface RunStats {
  /** Chapters cleared (a won night cleared all three). */
  cleared: number;
  kills: number;
  bites: number;
  shots: number;
  hits: number;
  /** People helped (a survivor's request done). */
  rescues: number;
  /** Optional steps done (each costs clock). */
  optional: number;
  doses: number;
  /** People brought in who turned. */
  lostEscorts: number;
  /** Last selves put down. */
  husks: number;
}

export function replayChapters(log: NightLog): { final: GameState; ends: ChapterEnd[]; stats: RunStats } {
  const ends: ChapterEnd[] = [];
  const stats: RunStats = { cleared: 0, kills: 0, bites: 0, shots: 0, hits: 0, rescues: 0, optional: 0, doses: 0, lostEscorts: 0, husks: 0 };
  const tally = (g: GameState) => {
    for (const e of g.events) {
      if (e.type === 'bitten') stats.bites++;
      else if (e.type === 'shot') { stats.shots++; if (e.hit !== null) stats.hits++; }
      else if (e.type === 'survivor-done') stats.rescues++;
      else if (e.type === 'antiviral') stats.doses++;
      else if (e.type === 'escort-turned') stats.lostEscorts++;
      else if (e.type === 'husk-down') stats.husks++;
    }
  };
  let s: GameState | null = null;
  for (const ch of log.chapters) {
    if (!s) s = createGame(log.night, undefined, { husk: ch.husk, loadout: log.loadout });
    else if (s.phase !== 'cleared') throw new Error('replay: a chapter follows one that was not cleared');
    else s = nextChapter(s, ch.husk);
    let n = 0, ci = 0;
    const due = () => { while (ci < ch.commands.length && ch.commands[ci]![0] <= n) command(s!, ch.commands[ci++]![1]); };
    // the clock can be topped up (a dose, bought or found), so it does not bound the steps by itself; a chapter
    // is never longer than MAX_CHAPTER_STEPS (twenty minutes), which bounds the work of replaying a log
    const allowed = Math.ceil(s.timeLimit / STEP) + 2;
    let total = 0;
    for (let k = 0; k + 3 < ch.runs.length; k += 4) total += ch.runs[k]!;
    if (total > MAX_CHAPTER_STEPS) throw new Error('replay: a chapter is longer than any chapter can be');
    for (let k = 0; k + 3 < ch.runs.length; k += 4) {
      const input = unpack(ch.runs[k + 1]!, ch.runs[k + 2]!, ch.runs[k + 3]!);
      for (let j = ch.runs[k]!; j > 0; j--) { due(); step(s, input, STEP); tally(s); n++; }
    }
    due();
    stats.optional += s.tasks.filter((t) => t.timeCost > 0 && t.done).length;
    if (s.phase === 'cleared' || s.phase === 'won') stats.cleared++;
    ends.push({
      chapter: s.chapter, phase: s.phase, lossReason: s.lossReason, remaining: s.remaining, kills: s.kills,
      pos: { x: s.player.pos.x, y: s.player.pos.y }, weapon: s.arsenal.weapon, huskDown: s.huskDown, stepsAllowed: allowed, steps: total,
    });
  }
  if (!s) throw new Error('replay: empty log');
  stats.kills = s.kills;
  return { final: s, ends, stats };
}

// ---------------------------------------------------------------- rooms

/** A room's round, written down: every seat's input at every tick, and what each did between ticks. */
export interface RoomLog {
  v: 1;
  content: number;
  seed: number;
  players: number;
  /** Seconds per tick (rooms run at 30 a second). */
  dt: number;
  /** Per seat, its inputs run-length encoded like a night's: [count, dx, dy, buttons, ...]. */
  seats: number[][];
  /** [tick it came before, seat, what]. */
  commands: Array<[number, number, Command]>;
  ticks: number;
  /** What each seat brought from the armoury (absent: everyone had the standard kit). */
  loadouts?: Array<Loadout | null>;
}

/** Writes a room's round down as the server plays it. */
export class RoomRecorder {
  private seats: number[][];
  private commands: Array<[number, number, Command]> = [];
  private ticks = 0;

  constructor(readonly seed: number, readonly players: number, readonly content: number, readonly dt: number, readonly loadouts?: Array<Loadout | null>) {
    this.seats = Array.from({ length: players }, () => []);
  }

  /** One tick was simulated with these (quantized) inputs, one per seat. */
  tick(inputs: readonly Input[]): void {
    for (let seat = 0; seat < this.players; seat++) {
      const i = inputs[seat] ?? { dx: 0, dy: 0 }, r = this.seats[seat]!, n = r.length, m = pack(i);
      if (n && r[n - 3] === i.dx && r[n - 2] === i.dy && r[n - 1] === m) r[n - 4]!++;
      else r.push(1, i.dx, i.dy, m);
    }
    this.ticks++;
  }

  command(seat: number, c: Command): void {
    this.commands.push([this.ticks, seat, c]);
  }

  log(): RoomLog {
    return { v: 1, content: this.content, seed: this.seed, players: this.players, dt: this.dt, seats: this.seats, commands: this.commands, ticks: this.ticks, ...(this.loadouts ? { loadouts: this.loadouts } : {}) };
  }
}

/** Play a written-down room round again and return where it ended. */
export function replayRoom(log: RoomLog): GameState {
  const s = createRoom(log.seed, log.players, log.loadouts?.map((l) => l ?? undefined));
  // per seat: the run it is in and how much of it is left
  const at = log.seats.map(() => ({ k: 0, left: 0 }));
  let ci = 0;
  for (let tick = 0; tick < log.ticks && s.phase === 'playing'; tick++) {
    while (ci < log.commands.length && log.commands[ci]![0] <= tick) { const [, seat, c] = log.commands[ci++]!; command(s, c, seat); }
    const inputs: Input[] = log.seats.map((runs, seat) => {
      const c = at[seat]!;
      if (c.left === 0 && c.k + 3 < runs.length) { c.left = runs[c.k]!; }
      const i = unpack(runs[c.k + 1] ?? 0, runs[c.k + 2] ?? 0, runs[c.k + 3] ?? 0);
      if (--c.left === 0) c.k += 4;
      return i;
    });
    step(s, inputs, log.dt);
  }
  return s;
}
