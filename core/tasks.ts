import { fork, int, shuffle, type Rng } from './rng';
import { cellOf, distanceField, UNREACHABLE } from './map';
import { content, type StepDef } from './content';
import type { MapData, Task, Vec2 } from './types';
import { dhypot } from './dmath';

/** Groups per chapter: every chapter of a night gets its own, none repeated. */
export const GROUPS_PER_CHAPTER = 2;

/** The step groups for one chapter of a night: the night's shuffled pool, dealt out in turn. */
export function chapterGroups(night: number, chapter: number, room = false): StepDef[][] {
  // a room has no one to escort: groups that hand you someone are left out of its pool
  const all = room ? content().groups.filter((g) => !g.some((d) => d.effect === 'escort-start' || d.needsEscort)) : content().groups;
  const pool = shuffle(fork(night, 'groups'), all);
  const out: StepDef[][] = [];
  for (let k = 0; k < GROUPS_PER_CHAPTER; k++) out.push(pool[(chapter * GROUPS_PER_CHAPTER + k) % pool.length]!);
  return out;
}

export const MIN_TASK_SEPARATION = 45;
export const MIN_SPAWN_DISTANCE = 25;

/** A puzzle's starting position: tiles turned (most of them), or the wires' order on the far side. */
function scramble(rng: Rng, kind: Task['puzzle']): number[] | undefined {
  if (kind === 'tiles') {
    for (;;) {
      const r = Array.from({ length: 9 }, () => int(rng, 0, 3));
      if (r.filter((x) => x !== 0).length >= 5) return r;
    }
  }
  if (kind === 'wires') {
    for (;;) {
      const p = shuffle(rng, [0, 1, 2, 3]);
      if (p.some((x, i) => x !== i)) return p;
    }
  }
  return undefined;
}

/**
 * Pick and place the task chain: the chapter's step groups in order (each step needs the one before
 * it in its group), then the map, which shows the way out; optional detours follow. Every position is
 * reachable from the spawn point.
 */
export function generateChain(rng: Rng, map: MapData, spawn: Vec2, safehouse: Vec2, groups: StepDef[][]): Task[] {
  const c = content();
  const optional = shuffle(rng, c.optional).slice(0, int(rng, 1, 2));

  const field = distanceField(map, spawn);
  const usable = map.points.filter(
    (p) =>
      (field[cellOf(map, p)] as number) !== UNREACHABLE &&
      dhypot(p.x - spawn.x, p.y - spawn.y) >= MIN_SPAWN_DISTANCE &&
      dhypot(p.x - safehouse.x, p.y - safehouse.y) >= MIN_SPAWN_DISTANCE,
  );

  const placed: Vec2[] = [];
  const place = (): Vec2 => {
    const order = shuffle(rng, usable);
    const spaced = order.find((p) => placed.every((q) => dhypot(p.x - q.x, p.y - q.y) >= MIN_TASK_SEPARATION));
    const p = spaced ?? (order[0] as Vec2);
    placed.push(p);
    return { x: p.x, y: p.y };
  };

  // Doors: the middle of a building's side that faces open, reachable street, with a spot to stand at.
  const blocked = (p: Vec2) => map.blocked[cellOf(map, p)] === 1 || (field[cellOf(map, p)] as number) === UNREACHABLE;
  const doors: Array<{ door: Vec2; pos: Vec2 }> = [];
  for (const b of map.buildings) {
    if (b.kind !== 'house' && b.kind !== 'shop' && b.kind !== 'tower' && b.kind !== 'warehouse' && b.kind !== 'hospital') continue;
    for (const [nx, ny] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const door = { x: b.x + b.w / 2 + (nx * b.w) / 2, y: b.y + b.h / 2 + (ny * b.h) / 2 };
      const pos = { x: door.x + nx * 1.8, y: door.y + ny * 1.8 };
      if ([1.8, 3.2].some((k) => blocked({ x: door.x + nx * k, y: door.y + ny * k }))) continue;
      if (dhypot(pos.x - spawn.x, pos.y - spawn.y) < MIN_SPAWN_DISTANCE || dhypot(pos.x - safehouse.x, pos.y - safehouse.y) < MIN_SPAWN_DISTANCE) continue;
      doors.push({ door, pos });
    }
  }
  const placeDoor = (): { door?: Vec2; pos: Vec2 } => {
    const order = shuffle(rng, doors);
    const d = order.find((o) => placed.every((q) => dhypot(o.pos.x - q.x, o.pos.y - q.y) >= MIN_TASK_SEPARATION)) ?? order[0];
    if (!d) return { pos: place() };
    placed.push(d.pos);
    return d;
  };

  const make = (d: StepDef, requires: string[], required: boolean, code: string): Task => {
    const at = d.door ? placeDoor() : { pos: place() };
    const t: Task = {
      id: d.id, kind: d.kind, required, requires, pos: at.pos, timeCost: d.timeCost ?? 0, reward: d.reward ?? null, done: false, code,
    };
    if (at.door) t.door = at.door;
    if (d.seconds) t.seconds = d.seconds;
    if (d.effect) t.effect = d.effect;
    if (d.needsEscort) t.needsEscort = true;
    if (d.escort) t.escort = { name: d.escort.name, skin: d.escort.skin, scale: d.escort.scale ?? 1, party: d.escort.party?.map((m) => ({ ...m, scale: m.scale ?? 1 })) };
    if (d.parts) {
      // pieces lie a block or two around it, apart from each other
      const parts: Vec2[] = [];
      for (const p of shuffle(rng, usable)) {
        if (parts.length >= d.parts.count) break;
        const d0 = dhypot(p.x - t.pos.x, p.y - t.pos.y);
        if (d0 < 14 || d0 > 38 || parts.some((q) => dhypot(p.x - q.x, p.y - q.y) < 10)) continue;
        parts.push({ x: p.x, y: p.y });
      }
      t.parts = parts;
      t.got = parts.map(() => false);
    }
    if (d.puzzle) { t.puzzle = d.puzzle; t.scramble = scramble(rng, d.puzzle); }
    if (d.kind === 'clear') t.clear = d.clear;
    return t;
  };

  const tasks: Task[] = [];
  for (const g of [...groups, [c.map]]) {
    const code = String(int(rng, 1000, 9999)); // a door code or a phone number, shared by the group's steps
    g.forEach((d, k) => tasks.push(make(d, k > 0 ? [g[k - 1]!.id] : [], true, code)));
  }
  for (const o of optional) tasks.push(make(o, [], false, ''));
  return tasks;
}

// ---------------------------------------------------------------- rooms: one pool of steps, open to everyone

/** The groups a room can deal from: single steps and pairs, never one you collect in pieces, anyone to escort, or a
 * clear (a fight at a spot is nobody's in particular when several players are in it). */
export function roomGroups(): StepDef[][] {
  return content().groups.filter((g) => !g.some((d) => d.parts || d.kind === 'clear' || d.effect === 'escort-start' || d.effect === 'escort-end' || d.needsEscort));
}

/** A room step's id: the step's own, and which copy of it (`radio@2`). The content knows it by the part before the @. */
export const roomStepId = (id: string, n: number): string => `${id}@${n}`;

/**
 * A room's steps: one pool, open to everyone, `count` of them (each player's share and a few spare), spread over the
 * district. Whoever finishes a step has it; a player's way out opens once they have done their share. Every step is a
 * single job (a pair is two, the second after the first, by anyone). Also returns, for the clock, the longest walk any
 * seat would have doing its share of the steps nearest it in turn and then going on to the exit (cells).
 */
export function roomPool(rng: Rng, map: MapData, spawns: Vec2[], safehouse: Vec2, count: number, share: number): { tasks: Task[]; route: number } {
  const field = distanceField(map, spawns[0]!);
  const away = (p: Vec2) => dhypot(p.x - safehouse.x, p.y - safehouse.y) >= MIN_SPAWN_DISTANCE && spawns.every((q) => dhypot(p.x - q.x, p.y - q.y) >= 12);
  const usable = map.points.filter((p) => (field[cellOf(map, p)] as number) !== UNREACHABLE && away(p));
  const blocked = (p: Vec2) => map.blocked[cellOf(map, p)] === 1 || (field[cellOf(map, p)] as number) === UNREACHABLE;
  const doors: Array<{ door: Vec2; pos: Vec2 }> = [];
  for (const b of map.buildings) {
    if (b.kind !== 'house' && b.kind !== 'shop' && b.kind !== 'tower' && b.kind !== 'warehouse' && b.kind !== 'hospital') continue;
    for (const [nx, ny] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const door = { x: b.x + b.w / 2 + (nx * b.w) / 2, y: b.y + b.h / 2 + (ny * b.h) / 2 };
      const pos = { x: door.x + nx * 1.8, y: door.y + ny * 1.8 };
      if ([1.8, 3.2].some((k) => blocked({ x: door.x + nx * k, y: door.y + ny * k }))) continue;
      if (!away(pos)) continue;
      doors.push({ door, pos });
    }
  }
  // the steps: groups dealt in turn (a pair counts as two, cut to its first if that is all that fits), every copy its own id
  const pool = roomGroups();
  const steps: Array<{ d: StepDef; id: string; prev: string | null; code: string }> = [];
  let order = shuffle(rng, pool), n = 0;
  while (steps.length < count) {
    if (!order.length) order = shuffle(rng, pool);
    const left = count - steps.length;
    const gi = order.findIndex((g) => g.length <= left);
    const g = gi >= 0 ? order.splice(gi, 1)[0]! : order.shift()!.slice(0, left);
    const code = String(int(rng, 1000, 9999));
    const ids = g.map((d) => roomStepId(d.id, n++));
    g.forEach((d, k) => steps.push({ d, id: ids[k]!, prev: k > 0 ? ids[k - 1]! : null, code }));
  }
  // spread them out: as far apart as the district allows, never two on one spot
  const placed: Vec2[] = [];
  const tasks: Task[] = [];
  for (const st of steps) {
    let spot: { pos: Vec2; door?: Vec2 } | undefined;
    for (const gap of [30, 22, 15, 9, 0]) {
      const fits = (p: Vec2) => placed.every((q) => dhypot(p.x - q.x, p.y - q.y) >= gap);
      const d = st.d.door ? shuffle(rng, doors).find((o) => fits(o.pos)) : undefined;
      const p = d ? null : shuffle(rng, usable).find(fits);
      spot = d ? { pos: { ...d.pos }, door: { ...d.door } } : p ? { pos: { x: p.x, y: p.y } } : undefined;
      if (spot) break;
    }
    spot ??= { pos: { ...usable[0]! } };
    placed.push(spot.pos);
    const d = st.d;
    const t: Task = {
      id: st.id, kind: d.kind, required: true, requires: st.prev ? [st.prev] : [], pos: spot.pos,
      timeCost: d.timeCost ?? 0, reward: d.reward ?? null, done: false, code: st.code,
    };
    if (spot.door) t.door = spot.door;
    if (d.seconds) t.seconds = d.seconds;
    if (d.effect && d.effect !== 'reveal-exit') t.effect = d.effect;
    if (d.puzzle) { t.puzzle = d.puzzle; t.scramble = scramble(rng, d.puzzle); }
    tasks.push(t);
  }
  // the clock: each seat doing its share, always the nearest step it can do next (as walked), then to the exit
  const toExit = distanceField(map, safehouse);
  const scratch = new Int16Array(map.cols * map.cols);
  let longest = 0;
  for (const spawn of spawns) {
    let at = spawn, cells = 0;
    const done = new Set<string>();
    for (let k = 0; k < share; k++) {
      const f = distanceField(map, at, scratch);
      let best: Task | null = null, bd = Infinity;
      for (const t of tasks) {
        if (done.has(t.id) || !t.requires.every((r) => done.has(r))) continue;
        const d = f[cellOf(map, t.pos)] as number;
        if (d !== UNREACHABLE && d < bd) { bd = d; best = t; }
      }
      if (!best) break;
      done.add(best.id); cells += bd; at = best.pos;
    }
    cells += toExit[cellOf(map, at)] as number;
    longest = Math.max(longest, cells);
  }
  return { tasks, route: longest };
}
