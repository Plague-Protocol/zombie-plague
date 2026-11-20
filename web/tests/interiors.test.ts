// Walk-in buildings: walls with a doorway on the street side, a floor you can reach, things to search, and some of
// them lying in there.
import { describe, expect, it } from 'vitest';
import { createGame, interactionFor, step } from '../../core/state';
import { cellOf, distanceField, generateMap, UNREACHABLE } from '../../core/map';
import { INTERIOR_DEAD, INTERIORS } from '../../core/config';
import type { Interior, Vec2 } from '../../core/types';

const inside = (it: Interior, p: Vec2) => p.x > it.x && p.x < it.x + it.w && p.y > it.y && p.y < it.y + it.h;

describe('walk-in buildings', () => {
  it('each district has a few, walled all round but for a doorway on its street side, and reachable from the street', () => {
    for (const theme of ['downtown', 'docks', 'edge'] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const m = generateMap(seed, theme);
        expect(m.interiors.length).toBeGreaterThan(0);
        expect(m.interiors.length).toBeLessThanOrEqual(INTERIORS);
        for (const it of m.interiors) {
          const walls = m.buildings.filter((b) => b.kind === 'wall' && b.x >= it.x - 0.01 && b.y >= it.y - 0.01 && b.x + b.w <= it.x + it.w + 0.01 && b.y + b.h <= it.y + it.h + 0.01);
          expect(walls.length).toBe(5); // four sides, the door's side in two
          // nothing solid in the doorway
          const hit = m.buildings.some((b) => it.door.x > b.x && it.door.x < b.x + b.w && it.door.y > b.y && it.door.y < b.y + b.h);
          expect(hit).toBe(false);
          // from just outside the door, the floor inside is reachable
          expect(it.spots.length).toBeGreaterThan(10);
          const f = distanceField(m, { x: it.door.x + it.out.x * 2, y: it.door.y + it.out.y * 2 });
          expect(f[cellOf(m, it.spots[0]!)]).not.toBe(UNREACHABLE);
          for (const q of it.spots) expect(inside(it, q)).toBe(true);
        }
      }
    }
  });

  it('holds things to search and bodies that are not dead', () => {
    const g = createGame(5);
    for (const it of g.map.interiors) {
      expect(g.crates.filter((c) => inside(it, c.pos)).length).toBeGreaterThanOrEqual(2);
      expect(g.zombies.filter((z) => z.action === 'dormant' && inside(it, z.pos)).length).toBeGreaterThanOrEqual(INTERIOR_DEAD[0]);
    }
  });

  it('you walk in through the door and search what is in there', () => {
    const g = createGame(5);
    const it = g.map.interiors[0]!;
    for (const z of g.zombies) if (inside(it, z.pos)) z.pos = { x: 5, y: 5 }; // an empty one, for this
    const crate = g.crates.find((c) => inside(it, c.pos))!;
    g.player.pos = { x: it.door.x + it.out.x * 2, y: it.door.y + it.out.y * 2 };
    // walk straight in through the doorway
    for (let i = 0; i < 90; i++) step(g, { dx: -it.out.x, dy: -it.out.y }, 1 / 30);
    expect(inside(it, g.player.pos)).toBe(true);
    // and over to the crate
    g.player.pos = { x: crate.pos.x + 0.8, y: crate.pos.y };
    expect(interactionFor(g)).toMatchObject({ kind: 'crate', crateId: crate.id });
    step(g, { dx: 0, dy: 0, action: true }, 1 / 30);
    expect(crate.opened).toBe(true);
  });

  it('the walls stop you anywhere but the door', () => {
    const g = createGame(5);
    const it = g.map.interiors[0]!;
    // beside the door, outside, walking at the wall
    const along = it.out.y !== 0 ? { x: 1, y: 0 } : { x: 0, y: 1 };
    const side = { x: it.door.x + along.x * 3 + it.out.x * 1.2, y: it.door.y + along.y * 3 + it.out.y * 1.2 };
    const wallAt = it.door.x * Math.abs(it.out.x) + it.door.y * Math.abs(it.out.y);
    g.player.pos = { ...side };
    for (let i = 0; i < 60; i++) step(g, { dx: -it.out.x, dy: -it.out.y }, 1 / 30);
    const at = g.player.pos.x * Math.abs(it.out.x) + g.player.pos.y * Math.abs(it.out.y);
    expect((at - wallAt) * (it.out.x + it.out.y)).toBeGreaterThan(0); // still outside the wall line
  });
});
