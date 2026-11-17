// Room test moves: a room with the district to itself, seats put where a test wants them.
import { createRoom, step, type GameState } from '../../core/state';
import { cellOf } from '../../core/map';
import type { Input, Vec2, Zombie, ZombieKind } from '../../core/types';
import { ZOMBIE_HEALTH } from '../../core/config';

export const IDLE: Input = { dx: 0, dy: 0 };
export const DT = 1 / 30;

/** A street point with open ground all round (`r` cells each way). */
export function openSpot(g: GameState, near: Vec2, r = 8): Vec2 {
  const ok = (p: Vec2) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (g.map.blocked[cellOf(g.map, { x: p.x + dx, y: p.y + dy })] === 1) return false;
    return true;
  };
  return { ...g.map.points.filter(ok).sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y) - Math.hypot(b.x - near.x, b.y - near.y))[0]! };
}

/** A room with nothing in it but the players, the director asleep, nobody guarding anything. */
export function quietRoom(n = 2, seed = 5): GameState {
  const g = createRoom(seed, n);
  g.zombies = [];
  g.corpses = [];
  g.guarded = g.tasks.map((t) => t.id);
  g.director.t = 1e9;
  return g;
}

export function put(g: GameState, seat: number, at: Vec2, heading = 0): void {
  const p = g.players[seat]!;
  p.pos = { ...at };
  p.heading = heading;
  p.vel = { x: 0, y: 0 };
}

export function addZ(g: GameState, kind: ZombieKind, at: Vec2, id = 900 + g.zombies.length): Zombie {
  const z: Zombie = { id, kind, pos: { ...at }, heading: 0, speed: 0, action: 'idle', actionT: 0, cooldown: 0, health: ZOMBIE_HEALTH[kind], staggerT: 0, alertT: 0, wanderT: 99, wanderDir: { x: 0, y: 0 } };
  g.zombies.push(z);
  return z;
}

export function runRoom(g: GameState, seconds: number, inputs: Input[] = []): void {
  for (let i = 0; i < seconds / DT && g.phase === 'playing'; i++) step(g, inputs, DT);
}
