// The wire form of a PlayerView. A view as plain JSON is about 2 KB, sent fifteen times a second; this is a tenth of
// that. Two ideas:
//   - what moves every snapshot (you, the other players, the zombies you can see) goes as short arrays of whole
//     numbers (positions in 1/16 units, angles in 1/100 radian);
//   - everything else (what you carry, the steps, what has been taken) is sent only when it changes, key by key.
// The channel is a WebSocket, so frames arrive whole and in order and a delta can never be missed. A new connection
// gets a new encoder, so its first snapshot carries everything.
import type { GameEvent, PlayerStatus, WeaponKind, ZombieAction, ZombieKind } from './types';
import type { OtherView, PlayerView, YouView, ZombieView } from './view';

const STATUS: PlayerStatus[] = ['alive', 'down', 'turned', 'escaped', 'dead', 'missed'];
const KIND: ZombieKind[] = ['walker', 'runner', 'screamer', 'stalker', 'crawler', 'lasher'];
const ACTION: ZombieAction[] = ['rise', 'idle', 'wander', 'chase', 'attack', 'feed', 'cling', 'dead', 'dormant', 'scream'];
const WEAPON: Array<WeaponKind | null> = [null, 'pistol', 'shotgun', 'rifle', 'baton', 'bat', 'machete'];
const PHASE: PlayerView['phase'][] = ['playing', 'cleared', 'won', 'lost'];
const P = 16; // position units per world unit
const A = 100; // angle units per radian
const S = 10; // speed units per unit/s

/** Keys of `you` that move every snapshot and travel in the compact array instead of as deltas. */
const HOT_YOU = ['pos', 'vel', 'heading', 'health', 'status'] as const;

export interface WireSnap {
  /** tick */ k: number;
  /** seat */ s: number;
  /** you: x, y, vx, vy, heading, health, status */ y: number[];
  /** others: id, x, y, heading, status, bits (1 light, 2 exposed, 4 crouched, 8 hidden), weapon, vehicle+1, roof+1 */ o: number[][];
  /** zombies: id, kind, x, y, heading, speed, action, flags (1 staggered, 2 frozen), roof+1 */ z: number[][];
  /** events, if any */ e?: GameEvent[];
  /** the parts that changed since the last snapshot, by key ("y.arsenal" for something of yours) */ c?: Record<string, unknown>;
}

const q = (v: number, k: number) => Math.round(v * k);

/** Round every number in `x` to two decimals (events carry positions and amounts). */
function round2<T>(x: T): T {
  if (typeof x === 'number') return (Math.round(x * 100) / 100) as T;
  if (Array.isArray(x)) return x.map(round2) as T;
  if (x && typeof x === 'object') { const o: Record<string, unknown> = {}; for (const [k, v] of Object.entries(x)) o[k] = round2(v); return o as T; }
  return x;
}

/** Slow things are sent in coarse numbers so they do not change every tick: the infection clock in whole seconds. */
function coarse(key: string, v: unknown): unknown {
  if (key === 'y.remaining' || key === 'roomRemaining') return Math.floor(v as number);
  return round2(v);
}

/** A per-connection encoder: remembers what it has already told this player. */
export function makeEncoder(): (v: PlayerView) => WireSnap {
  const sent = new Map<string, string>();
  return (v) => {
    const c: Record<string, unknown> = {};
    const put = (key: string, value: unknown) => {
      const x = coarse(key, value), j = JSON.stringify(x);
      if (sent.get(key) !== j) { sent.set(key, j); c[key] = x; }
    };
    for (const [k, val] of Object.entries(v.you)) if (!(HOT_YOU as readonly string[]).includes(k)) put(`y.${k}`, val);
    put('phase', v.phase);
    put('taken', v.taken); put('opened', v.opened); put('searched', v.searched); put('tasks', v.tasks);
    put('safehouseKnown', v.safehouseKnown); put('flare', v.flare); put('fallen', v.fallen); put('tier', v.tier);
    put('roomRemaining', v.roomRemaining); put('seatsLeft', v.seatsLeft); put('placements', v.placements); put('corpses', v.corpses);
    const w: WireSnap = {
      k: v.tick, s: v.seat,
      y: [q(v.you.pos.x, P), q(v.you.pos.y, P), q(v.you.vel.x, P), q(v.you.vel.y, P), q(v.you.heading, A), Math.round(v.you.health), STATUS.indexOf(v.you.status)],
      o: v.others.map((o) => [o.id, q(o.pos.x, P), q(o.pos.y, P), q(o.heading, A), STATUS.indexOf(o.status), (o.light ? 1 : 0) | (o.exposed ? 2 : 0) | (o.crouched ? 4 : 0) | (o.hidden ? 8 : 0), WEAPON.indexOf(o.weapon), (o.vehicleId ?? -1) + 1, (o.roof ?? -1) + 1]),
      z: v.zombies.map((z) => [z.id, KIND.indexOf(z.kind), q(z.pos.x, P), q(z.pos.y, P), q(z.heading, A), q(z.speed, S), ACTION.indexOf(z.action), (z.staggerT > 0 ? 1 : 0) | (z.frozen ? 2 : 0), (z.roof ?? -1) + 1]),
    };
    if (v.events.length) w.e = round2(v.events);
    if (Object.keys(c).length) w.c = c;
    return w;
  };
}

/** A per-connection decoder: keeps what the server has said so far and rebuilds the whole view each time. */
export function makeDecoder(): (w: WireSnap) => PlayerView {
  const cold = new Map<string, unknown>();
  return (w) => {
    if (w.c) for (const [k, val] of Object.entries(w.c)) cold.set(k, val);
    const you: Record<string, unknown> = {};
    for (const [k, val] of cold) if (k.startsWith('y.')) you[k.slice(2)] = val;
    you.pos = { x: w.y[0]! / P, y: w.y[1]! / P };
    you.vel = { x: w.y[2]! / P, y: w.y[3]! / P };
    you.heading = w.y[4]! / A;
    you.health = w.y[5]!;
    you.status = STATUS[w.y[6]!];
    const others: OtherView[] = w.o.map((o) => ({
      id: o[0]!, pos: { x: o[1]! / P, y: o[2]! / P }, heading: o[3]! / A, status: STATUS[o[4]!]!, light: (o[5]! & 1) !== 0, exposed: (o[5]! & 2) !== 0,
      weapon: WEAPON[o[6]!] ?? null, vehicleId: o[7]! - 1 || null,
      crouched: (o[5]! & 4) !== 0, hidden: (o[5]! & 8) !== 0, roof: (o[8] ?? 0) > 0 ? o[8]! - 1 : null,
    }));
    const zombies: ZombieView[] = w.z.map((z) => ({
      id: z[0]!, kind: KIND[z[1]!]!, pos: { x: z[2]! / P, y: z[3]! / P }, heading: z[4]! / A, speed: z[5]! / S, action: ACTION[z[6]!]!,
      actionT: 0, staggerT: (z[7]! & 1) !== 0 ? 0.3 : 0, frozen: (z[7]! & 2) !== 0, roof: (z[8] ?? 0) > 0 ? z[8]! - 1 : null,
    }));
    const get = <T>(k: string, d: T) => (cold.has(k) ? (cold.get(k) as T) : d);
    return {
      seat: w.s, tick: w.k, phase: PHASE.includes(get('phase', 'playing')) ? get('phase', 'playing') : 'playing', you: you as unknown as YouView, others, zombies,
      corpses: get('corpses', []), taken: get('taken', []), opened: get('opened', []), searched: get('searched', []), tasks: get('tasks', []),
      safehouseKnown: get('safehouseKnown', false), flare: get('flare', null), fallen: get('fallen', 0), tier: get('tier', 0), events: w.e ?? [],
      roomRemaining: get('roomRemaining', 0), seatsLeft: get('seatsLeft', 0), placements: get('placements', null),
    };
  };
}
