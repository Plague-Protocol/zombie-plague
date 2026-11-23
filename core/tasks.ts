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

// ---------------------------------------------------------------- rooms: every player's own steps

/** The groups a room can deal from: single steps and pairs, never one you collect in pieces, nor anyone to escort. */
export function roomGroups(): StepDef[][] {
  return content().groups.filter((g) => !g.some((d) => d.parts || d.effect === 'escort-start' || d.effect === 'escort-end' || d.needsEscort));
}

/** A room step's id: the step's own, and whose it is (`radio@2`). The content knows it by the part before the @. */
export const roomStepId = (id: string, seat: number): string => `${id}@${seat}`;

/** How far, as the crow flies, consecutive steps of one player's route lie apart. */
const LEG: readonly [number, number] = [34, 72];
/** Of each seat's tries, how many are walked in full to match the seats' routes (more: fairer, slower to set up). */
const ROUTES_WALKED = 5;

/**
 * Each seat's own steps in a room: `each` of them, dealt from the room groups (a pair counts as two, in order), placed
 * as a route from that seat's start. Every seat's route is picked, from several tries, to be as close as possible to the
 * same length (by the streets), so no one is dealt the short walk. Returns the steps (each `owner`d) and the longest
 * route as it is really walked (cells), which sets the room's clock.
 */
export function roomChains(rng: Rng, map: MapData, spawns: Vec2[], safehouse: Vec2, each: number): { tasks: Task[]; route: number } {
  const field = distanceField(map, spawns[0]!);
  const usable = map.points.filter((p) => (field[cellOf(map, p)] as number) !== UNREACHABLE && dhypot(p.x - safehouse.x, p.y - safehouse.y) >= MIN_SPAWN_DISTANCE);
  const blocked = (p: Vec2) => map.blocked[cellOf(map, p)] === 1 || (field[cellOf(map, p)] as number) === UNREACHABLE;
  const doors: Array<{ door: Vec2; pos: Vec2 }> = [];
  for (const b of map.buildings) {
    if (b.kind !== 'house' && b.kind !== 'shop' && b.kind !== 'tower' && b.kind !== 'warehouse' && b.kind !== 'hospital') continue;
    for (const [nx, ny] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const door = { x: b.x + b.w / 2 + (nx * b.w) / 2, y: b.y + b.h / 2 + (ny * b.h) / 2 };
      const pos = { x: door.x + nx * 1.8, y: door.y + ny * 1.8 };
      if ([1.8, 3.2].some((k) => blocked({ x: door.x + nx * k, y: door.y + ny * k }))) continue;
      if (dhypot(pos.x - safehouse.x, pos.y - safehouse.y) < MIN_SPAWN_DISTANCE) continue;
      doors.push({ door, pos });
    }
  }
  const pool = roomGroups();
  const target = (each * (LEG[0] + LEG[1]) / 2 + 80) * 1.2; // the length every route aims at, by the streets (steps, then on to the exit)
  const taken: Vec2[] = []; // every seat's steps so far: no two players' steps on the same spot
  const tasks: Task[] = [];
  let order = shuffle(rng, pool);
  const toExit = distanceField(map, safehouse); // the last leg, and the first (from each start), measured as walked
  const scratch = new Int16Array(map.cols * map.cols);
  let matchTo: number | null = null; // the walked length the first seat's route came to: the rest are matched to it
  spawns.forEach((spawn, seat) => {
    const fromStart = distanceField(map, spawn);
    let best: Array<{ pos: Vec2; door?: Vec2 }> | null = null;
    // the steps: groups in turn from a pool shared out so players get different ones while it lasts
    const steps: Array<{ d: StepDef; prev: string | null; code: string }> = [];
    while (steps.length < each) {
      if (!order.length) order = shuffle(rng, pool);
      const left = each - steps.length;
      const gi = order.findIndex((g) => g.length <= left);
      const g = gi >= 0 ? order.splice(gi, 1)[0]! : order.shift()!.slice(0, left); // a pair cut to its first step, if that is all that fits
      const code = String(int(rng, 1000, 9999));
      g.forEach((d, k) => steps.push({ d, prev: k > 0 ? roomStepId(g[k - 1]!.id, seat) : null, code }));
    }
    // the route: from the start, each step a fair walk on from the last. Two dozen tries are judged roughly (first and
    // last legs as walked, the rest by the streets' grid); the nearest few (ROUTES_WALKED) are then walked in full, and the
    // first seat's pick sets the length every other seat's route is matched to.
    type Spot = { pos: Vec2; door?: Vec2 };
    const tries: Array<{ route: Spot[]; est: number }> = [];
    for (let tryN = 0; tryN < 24; tryN++) {
      const route: Spot[] = [];
      let at = spawn, len = 0, ok = true;
      for (const st of steps) {
        const fits = (p: Vec2) => { const d = dhypot(p.x - at.x, p.y - at.y); return d >= LEG[0] && d <= LEG[1] && taken.every((q) => dhypot(p.x - q.x, p.y - q.y) >= 8) && route.every((q) => dhypot(p.x - q.pos.x, p.y - q.pos.y) >= 30); };
        const spot = st.d.door ? shuffle(rng, doors).find((o) => fits(o.pos)) : undefined;
        const p = spot?.pos ?? shuffle(rng, usable).find(fits);
        if (!p) { ok = false; break; }
        len += route.length === 0 ? (fromStart[cellOf(map, p)] as number) : Math.abs(p.x - at.x) + Math.abs(p.y - at.y);
        route.push(spot ? { pos: { ...spot.pos }, door: { ...spot.door } } : { pos: { x: p.x, y: p.y } });
        at = p;
      }
      if (ok) tries.push({ route, est: len + (toExit[cellOf(map, at)] as number) });
    }
    const walked = (r: Spot[]) => {
      let len = fromStart[cellOf(map, r[0]!.pos)] as number;
      for (let k = 1; k < r.length; k++) len += distanceField(map, r[k - 1]!.pos, scratch)[cellOf(map, r[k]!.pos)] as number;
      return len + (toExit[cellOf(map, r[r.length - 1]!.pos)] as number);
    };
    const near = tries.sort((a, b) => Math.abs(a.est - target) - Math.abs(b.est - target)).slice(0, ROUTES_WALKED).map((t) => ({ route: t.route, len: walked(t.route) }));
    if (near.length) {
      if (matchTo === null) matchTo = near.map((t) => t.len).sort((a, b) => a - b)[Math.floor(near.length / 2)]!;
      const pickN = near.reduce((a, b) => (Math.abs(b.len - matchTo!) < Math.abs(a.len - matchTo!) ? b : a));
      best = pickN.route;
    }
    // nothing fitted (a cramped district): anywhere reachable, apart from the rest
    best ??= steps.map(() => ({ pos: { ...(shuffle(rng, usable).find((p) => taken.every((q) => dhypot(p.x - q.x, p.y - q.y) >= 8)) ?? usable[0]!) } }));
    steps.forEach((st, k) => {
      const spot = best![k]!, d = st.d;
      const t: Task = {
        id: roomStepId(d.id, seat), kind: d.kind, required: true, requires: st.prev ? [st.prev] : [], pos: spot.pos,
        timeCost: d.timeCost ?? 0, reward: d.reward ?? null, done: false, code: st.code, owner: seat,
      };
      if (spot.door) t.door = spot.door;
      if (d.seconds) t.seconds = d.seconds;
      if (d.effect && d.effect !== 'reveal-exit') t.effect = d.effect;
      if (d.puzzle) { t.puzzle = d.puzzle; t.scramble = scramble(rng, d.puzzle); }
      if (d.kind === 'clear') t.clear = d.clear;
      tasks.push(t);
      taken.push(spot.pos);
    });
  });
  // the clock is set by the longest route as it is really walked (every seat gets the same clock)
  let longest = 0;
  spawns.forEach((spawn, seat) => {
    let at = spawn, cells = 0;
    for (const p of [...tasks.filter((t) => t.owner === seat).map((t) => t.pos), safehouse]) { cells += distanceField(map, at)[cellOf(map, p)] as number; at = p; }
    longest = Math.max(longest, cells);
  });
  return { tasks, route: longest };
}
