// Bodies: a zombie stands against you, never inside you, and its bites still land; walking into one, you brush past.
import { describe, expect, it } from 'vitest';
import { createGame, step, type GameState } from '../../core/state';
import { cellOf } from '../../core/map';
import { PLAYER_RADIUS, ZOMBIE_HEALTH, ZOMBIE_RADIUS } from '../../core/config';
import type { Vec2, Zombie, ZombieKind } from '../../core/types';

const DT = 1 / 30;
function openSpot(g: GameState, r = 9): Vec2 {
  return g.map.points.find((p) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (g.map.blocked[cellOf(g.map, { x: p.x + dx, y: p.y + dy })] === 1) return false; return true; })!;
}
function setup(kind: ZombieKind, offset: Vec2): { g: GameState; z: Zombie } {
  const g = createGame(4242);
  g.zombies = []; g.remaining = g.timeLimit = 9999;
  const at = openSpot(g); g.player.pos = { ...at };
  const z: Zombie = { id: 900, kind, pos: { x: at.x + offset.x, y: at.y + offset.y }, heading: 0, speed: 0, action: 'idle', actionT: 0, cooldown: 0, health: ZOMBIE_HEALTH[kind], staggerT: 0, alertT: 0, wanderT: 99, wanderDir: { x: 0, y: 0 } };
  g.zombies.push(z);
  return { g, z };
}
const gap = (g: GameState, z: Zombie) => Math.hypot(z.pos.x - g.player.pos.x, z.pos.y - g.player.pos.y);

describe('bodies', () => {
  it('a walker on a player standing still keeps a body apart, and still bites them down', () => {
    const { g, z } = setup('walker', { x: 1.2, y: 0 });
    let closest = Infinity, hits = 0;
    for (let i = 0; i < 12 / DT && g.phase === 'playing'; i++) {
      step(g, { dx: 0, dy: 0 }, DT);
      closest = Math.min(closest, gap(g, z));
      hits += g.events.filter((e) => e.type === 'player-hit').length;
      g.events.length = 0;
    }
    expect(closest).toBeGreaterThan((PLAYER_RADIUS + ZOMBIE_RADIUS) * 0.8 - 0.01);
    expect(hits).toBeGreaterThanOrEqual(3);
    expect(g.phase).toBe('lost');
  });

  it('walking straight into one, you get past it rather than shoving it along in front of you', () => {
    const { g, z } = setup('walker', { x: 1.0, y: 0 });
    z.staggerT = 99; // stunned where it stands: only the bodies matter here
    let closest = Infinity;
    for (let i = 0; i < 1.5 / DT; i++) { step(g, { dx: 1, dy: 0 }, DT); closest = Math.min(closest, gap(g, z)); g.events.length = 0; }
    expect(g.player.pos.x).toBeGreaterThan(z.pos.x + 0.5); // walked past it
    expect(closest).toBeGreaterThan((PLAYER_RADIUS + ZOMBIE_RADIUS) * 0.8 - 0.01); // and never through it
  });
});
