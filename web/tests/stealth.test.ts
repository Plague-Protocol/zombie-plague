// Crouching, hiding and the roofs: the rules, played out on real districts.
import { describe, expect, it } from 'vitest';
import { createGame, interactionFor, step, type GameState } from '../../core/state';
import { cellOf } from '../../core/map';
import { quantize } from '../../core/replay';
import { CLIMB_SECONDS, HIDE_SEEN, PLAYER_HEALTH, ZOMBIE_CLIMB_SECONDS, ZOMBIE_HEALTH } from '../../core/config';
import type { Input, Vec2, Zombie, ZombieKind } from '../../core/types';

const DT = 1 / 30;
const IDLE: Input = { dx: 0, dy: 0 };
const run = (g: GameState, seconds: number, input: Input = IDLE) => { for (let i = 0; i < Math.ceil(seconds / DT); i++) step(g, input, DT); };
const press = (g: GameState, i: Input) => step(g, i, DT);

function calm(seed: number): GameState {
  const g = createGame(seed);
  g.zombies = [];
  g.remaining = g.timeLimit = 9999;
  return g;
}
function zombie(g: GameState, kind: ZombieKind, pos: Vec2): Zombie {
  const z: Zombie = { id: 900 + g.zombies.length, kind, pos: { ...pos }, heading: 0, speed: 0, action: 'idle', actionT: 0, cooldown: 0, health: ZOMBIE_HEALTH[kind], staggerT: 0, alertT: 0, wanderT: 99, wanderDir: { x: 0, y: 0 } };
  g.zombies.push(z);
  return z;
}
/** A street point with open ground for `r` all round. */
function openSpot(g: GameState, r = 9): Vec2 {
  return g.map.points.find((p) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (g.map.blocked[cellOf(g.map, { x: p.x + dx, y: p.y + dy })] === 1) return false;
    return true;
  })!;
}

describe('the roofs and the hiding places', () => {
  it('every district has ladders you can walk to, landing on their roofs, and places to hide', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const g = createGame(seed);
      expect(g.map.ladders.length, `seed ${seed}`).toBeGreaterThanOrEqual(4);
      for (const l of g.map.ladders) {
        expect(g.map.reach[cellOf(g.map, l.foot)], `seed ${seed} ladder ${l.id}`).toBe(1);
        expect(l.top.x).toBeGreaterThanOrEqual(l.roof.x0 - 1e-6); expect(l.top.x).toBeLessThanOrEqual(l.roof.x1 + 1e-6);
        expect(l.top.y).toBeGreaterThanOrEqual(l.roof.y0 - 1e-6); expect(l.top.y).toBeLessThanOrEqual(l.roof.y1 + 1e-6);
      }
      expect(g.map.hides.length, `seed ${seed}`).toBeGreaterThan(5);
      for (const h of g.map.hides) expect(g.map.reach[cellOf(g.map, h.pos)]).toBe(1);
    }
  });
});

describe('crouching', () => {
  it('halves your speed and lets you past one that would have seen you standing', () => {
    const walkFor = (crouch: boolean) => {
      const g = calm(3);
      g.player.pos = openSpot(g);
      if (crouch) press(g, { dx: 0, dy: 0, crouch: true });
      const x0 = g.player.pos.x;
      run(g, 0.6, { dx: 1, dy: 0 });
      return g.player.pos.x - x0;
    };
    const standing = walkFor(false), low = walkFor(true);
    expect(low).toBeLessThan(standing * 0.65);
    expect(low).toBeGreaterThan(standing * 0.3);

    const spotted = (crouch: boolean) => {
      const g = calm(3);
      g.player.pos = openSpot(g);
      if (crouch) press(g, { dx: 0, dy: 0, crouch: true });
      const z = zombie(g, 'walker', { x: g.player.pos.x + 7.5, y: g.player.pos.y });
      run(g, 0.5);
      return z.action === 'chase';
    };
    expect(spotted(false)).toBe(true);
    expect(spotted(true)).toBe(false);
  });
});

describe('hiding', () => {
  it('the ones that saw you go in keep coming; the rest lose you; a push on the stick brings you out', () => {
    const g = calm(4);
    const h = g.map.hides[0]!;
    g.player.pos = { x: h.pos.x + 0.3, y: h.pos.y };
    expect(interactionFor(g)?.kind).toBe('hide');
    const near = zombie(g, 'walker', { x: h.pos.x + HIDE_SEEN - 1.5, y: h.pos.y });
    const far = zombie(g, 'walker', { x: h.pos.x + HIDE_SEEN + 4, y: h.pos.y });
    for (const z of [near, far]) { z.action = 'chase'; z.alertT = 5; }
    press(g, { dx: 0, dy: 0, action: true });
    expect(g.player.hide).toBe(h.id);
    expect(far.alertT).toBe(0);
    expect(near.alertT).toBeGreaterThan(0);
    expect(interactionFor(g)?.kind).toBe('unhide');
    run(g, 0.2, { dx: 0.2, dy: 0 }); // a nudge is not enough
    expect(g.player.hide).toBe(h.id);
    press(g, { dx: 1, dy: 0 });
    expect(g.player.hide).toBeNull();
  });

  it('hidden, you cannot shoot', () => {
    const g = calm(4);
    const h = g.map.hides[0]!;
    g.player.pos = { ...h.pos };
    press(g, { dx: 0, dy: 0, action: true });
    const mag = g.arsenal.mag.pistol;
    run(g, 0.5, { dx: 0, dy: 0, fire: true });
    expect(g.arsenal.mag.pistol).toBe(mag);
  });
});

describe('climbing', () => {
  it('up the ladder onto the roof: walkers below cannot reach you; a runner climbs after you; down again at the foot', () => {
    const g = calm(5);
    const l = g.map.ladders[0]!;
    g.player.pos = { ...l.foot };
    const it = interactionFor(g);
    expect(it).toMatchObject({ kind: 'climb', up: true });
    press(g, { dx: 0, dy: 0, action: true });
    run(g, CLIMB_SECONDS + 0.1);
    expect(g.player.roof).toBe(l.id);
    expect(g.player.pos).toEqual(l.top);
    // a walker at the foot of the ladder: it waits below, and never lands a blow
    const w = zombie(g, 'walker', { ...l.foot });
    w.alertT = 30;
    run(g, 4);
    expect(g.player.health).toBe(PLAYER_HEALTH);
    expect(w.roof ?? null).toBeNull();
    // walking does not take you off the edge
    run(g, 2, { dx: 1, dy: 1 });
    expect(g.player.pos.x).toBeLessThanOrEqual(l.roof.x1 + 1e-6);
    expect(g.player.pos.y).toBeLessThanOrEqual(l.roof.y1 + 1e-6);
    // a runner comes up after you (it takes a while at the ladder)
    g.zombies = [];
    const r = zombie(g, 'runner', { ...l.foot });
    r.alertT = 30;
    run(g, ZOMBIE_CLIMB_SECONDS + 0.5);
    expect(r.roof).toBe(l.id);
    for (let i = 0; i < 120 && g.player.health === PLAYER_HEALTH; i++) step(g, IDLE, DT); // until it lands one
    expect(g.player.health).toBeLessThan(PLAYER_HEALTH);
    expect(g.phase).toBe('playing');
    // and down: back to the ladder's top, and climb
    g.zombies = [];
    g.player.pos = { ...l.top };
    expect(interactionFor(g)).toMatchObject({ kind: 'climb', up: false });
    press(g, { dx: 0, dy: 0, action: true });
    run(g, CLIMB_SECONDS + 0.1);
    expect(g.player.roof).toBeNull();
    expect(g.player.pos).toEqual(l.foot);
  });
});

describe('the crouch button in a recorded night', () => {
  it('survives the replay encoding', () => {
    expect(quantize({ dx: 0, dy: 0, crouch: true }).crouch).toBe(true);
    expect(quantize({ dx: 0, dy: 0 }).crouch).toBeUndefined();
  });
});

describe('in a room', () => {
  it('they go for the one on the street over the one up a roof, and a hidden player is not given away', async () => {
    const { createRoom } = await import('../../core/state');
    const { viewFor, HIDDEN_SEEN } = await import('../../core/view');
    const g = createRoom(7, 2);
    g.zombies = [];
    const l = g.map.ladders[0]!;
    const [a, b] = g.players as [typeof g.players[0], typeof g.players[0]];
    a.roof = l.id; a.pos = { ...l.top };
    b.pos = { x: l.foot.x + l.out.x * 6, y: l.foot.y + l.out.y * 6 };
    const z = zombie(g, 'walker', { x: l.foot.x + l.out.x * 2, y: l.foot.y + l.out.y * 2 }); // nearer the one up top
    z.alertT = 10;
    for (let i = 0; i < 10; i++) step(g, [IDLE, IDLE], DT);
    expect(z.targetId).toBe(b.id);
    // hidden: the other seat is told nothing of you from across the street
    a.roof = null;
    const h = g.map.hides.find((x) => Math.hypot(x.pos.x - b.pos.x, x.pos.y - b.pos.y) > HIDDEN_SEEN + 3)!;
    a.hide = h.id; a.pos = { ...h.pos };
    expect(viewFor(g, b.id).others.some((o) => o.id === a.id)).toBe(false);
  });
});
