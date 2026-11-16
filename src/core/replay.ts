// A night, written down so it can be played again: every input of every step, and everything done
// outside a step (a purchase, a weapon taken in hand, a puzzle answer, the moment's grace after a story
// panel). Re-running the log through the same rules gives the same night, which is how a server can
// check a result it did not watch. Pure: no DOM, no clock.
//
// One caveat for whoever builds that server: the rules use Math.sin/cos/atan2/hypot, which are not
// guaranteed bit-identical between JavaScript engines. A log recorded in one engine replays exactly in
// the same engine; across engines (Safari to Node) it can drift. See docs/PHASE2-BUILD-PLAN.md, W0.
import { SAFE_AFTER } from './config';
import { buy, createGame, equip, nextChapter, solvePuzzle, step, type GameState } from './state';
import type { Husk, Input, StoreItem, TaskId, WeaponKind } from './types';

/** The fixed step every night is simulated at. */
export const STEP = 1 / 60;

export type Command =
  | { t: 'buy'; item: StoreItem }
  | { t: 'equip'; weapon: WeaponKind }
  | { t: 'solve'; id: TaskId; answer: number[] | string }
  /** A story panel was closed: a moment to get moving before they come on again. */
  | { t: 'grace' };

/** Do something that happens between steps. The only way the game changes state outside `step`. */
export function command(s: GameState, c: Command): boolean {
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

  constructor(readonly night: number, readonly content: number) {}

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
    return { v: 1, content: this.content, night: this.night, chapters: this.chapters };
  }
}

/**
 * Play a written-down night again and return where it ended. Throws if the log cannot be what
 * happened (a chapter follows one that was never cleared).
 */
export function replay(log: NightLog): GameState {
  let s: GameState | null = null;
  for (const ch of log.chapters) {
    if (!s) s = createGame(log.night, undefined, { husk: ch.husk });
    else if (s.phase !== 'cleared') throw new Error('replay: a chapter follows one that was not cleared');
    else s = nextChapter(s, ch.husk);
    let n = 0, ci = 0;
    const due = () => { while (ci < ch.commands.length && ch.commands[ci]![0] <= n) command(s!, ch.commands[ci++]![1]); };
    for (let k = 0; k + 3 < ch.runs.length; k += 4) {
      const input = unpack(ch.runs[k + 1]!, ch.runs[k + 2]!, ch.runs[k + 3]!);
      for (let j = ch.runs[k]!; j > 0; j--) { due(); step(s, input, STEP); n++; }
    }
    due();
  }
  if (!s) throw new Error('replay: empty log');
  return s;
}
