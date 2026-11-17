// Rooms: several players in one district at once.
import { describe, expect, it } from 'vitest';
import { createRoom, eventSeat, step, type GameState } from '../../core/state';
import { command, hashState, quantize, replayRoom, RoomRecorder } from '../../core/replay';
import { viewFor } from '../../core/view';
import { lineClear } from '../../core/collision';
import { createRng, next } from '../../core/rng';
import { ATTACK_DAMAGE, EXIT_SEATS_SHARE, PLAYER_HEALTH, PVP_DAMAGE, PVP_GRACE, ROOM_SECONDS, SAFE_RADIUS, TURNED_HEALTH } from '../../core/config';
import type { Input, Vec2 } from '../../core/types';
import { addZ, DT, IDLE, openSpot, put, quietRoom, runRoom } from './helpers-room';

const fire: Input = { dx: 0, dy: 0, fire: true };

/** Two seats on open ground `gap` apart along +x, away from the exit. */
function duel(gap = 5, seed = 5): GameState {
  const g = quietRoom(2, seed);
  const a = openSpot(g, { x: 160, y: 160 });
  put(g, 0, a, 0);
  put(g, 1, { x: a.x + gap, y: a.y }, Math.PI);
  g.elapsed = PVP_GRACE + 5;
  return g;
}

describe('a room', () => {
  it('has a seat each, spread out and far from the exit, a shared chain, and no vehicles or escorts', () => {
    for (const n of [2, 4, 8]) {
      const g = createRoom(7, n);
      expect(g.mode).toBe('room');
      expect(g.players.length).toBe(n);
      expect(g.seatsLeft).toBe(Math.max(1, Math.ceil(n * EXIT_SEATS_SHARE)));
      expect(g.vehicles.length).toBe(0);
      expect(g.tasks.some((t) => t.effect === 'escort-start' || t.needsEscort)).toBe(false);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(Math.hypot(g.players[i]!.pos.x - g.players[j]!.pos.x, g.players[i]!.pos.y - g.players[j]!.pos.y)).toBeGreaterThan(8);
      for (const p of g.players) expect(Math.hypot(p.pos.x - g.safehouse.x, p.pos.y - g.safehouse.y)).toBeGreaterThan(40);
    }
  });

  it('builds the same district from the same seed, and every seat has its own clock', () => {
    const a = createRoom(11, 3), b = createRoom(11, 3);
    expect(hashState(a)).toBe(hashState(b));
    expect(a.tasks.map((t) => t.id)).toEqual(b.tasks.map((t) => t.id));
    const g = quietRoom(2);
    const before = g.players[1]!.remaining;
    g.players[0]!.remaining = 5;
    runRoom(g, 1);
    expect(g.players[1]!.remaining).toBeCloseTo(before - 1, 3);
    expect(g.players[0]!.remaining).toBeCloseTo(4, 3);
  });
});

describe('zombies in a room', () => {
  it('go for the nearer player, and switch when that one is gone', () => {
    const g = quietRoom(2);
    const mid = openSpot(g, { x: 160, y: 160 });
    put(g, 0, { x: mid.x - 8, y: mid.y });
    put(g, 1, { x: mid.x + 14, y: mid.y });
    const z = addZ(g, 'walker', mid);
    z.alertT = 30;
    step(g, [IDLE, IDLE], DT);
    expect(z.targetId).toBe(0);
    put(g, 0, { x: mid.x - 200, y: mid.y - 200 }); // gone
    runRoom(g, 3);
    expect(z.targetId).toBe(1);
  });

  it('bite whoever they catch, and only that seat hears about it', () => {
    const g = quietRoom(2);
    const a = openSpot(g, { x: 160, y: 160 });
    put(g, 0, a);
    put(g, 1, { x: a.x + 30, y: a.y });
    addZ(g, 'walker', { x: a.x + 1, y: a.y });
    const evs: Array<{ type: string; seat?: number }> = [];
    for (let i = 0; i < 90; i++) { step(g, [IDLE, IDLE], DT); for (const e of g.events) if (e.type === 'bitten') evs.push({ type: e.type, seat: eventSeat(e) }); }
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.seat === 0)).toBe(true);
    expect(g.players[0]!.health).toBeLessThan(PLAYER_HEALTH);
    expect(g.players[1]!.health).toBe(PLAYER_HEALTH);
  });
});

describe('players hurting each other', () => {
  it('a bullet does half damage to a living player', () => {
    const g = duel();
    step(g, [fire, IDLE], DT);
    expect(g.players[1]!.health).toBeCloseTo(PLAYER_HEALTH - 34 * PVP_DAMAGE, 5);
    expect(g.events.some((e) => e.type === 'player-hit' && eventSeat(e) === 1)).toBe(true);
  });

  it('none in the first seconds, and none near the exit', () => {
    const early = duel();
    early.elapsed = 1;
    step(early, [fire, IDLE], DT);
    expect(early.players[1]!.health).toBe(PLAYER_HEALTH);
    const near = duel();
    const e = openSpot(near, near.safehouse, 3);
    put(near, 0, { x: near.safehouse.x - 4, y: near.safehouse.y }, 0);
    put(near, 1, { x: near.safehouse.x + 1, y: near.safehouse.y }, Math.PI);
    void e;
    expect(Math.hypot(near.players[0]!.pos.x - near.safehouse.x, near.players[0]!.pos.y - near.safehouse.y)).toBeLessThan(SAFE_RADIUS);
    step(near, [fire, IDLE], DT);
    expect(near.players[1]!.health).toBe(PLAYER_HEALTH);
  });

  it('a living player who is shot down lies still, then turns; a turned one is put down for good', () => {
    const g = duel(3);
    g.players[1]!.health = 10;
    step(g, [fire, IDLE], DT);
    expect(g.players[1]!.status).toBe('down');
    expect(g.players[0]!.kills).toBe(1);
    runRoom(g, 3.2);
    expect(g.players[1]!.status).toBe('turned');
    expect(g.players[1]!.health).toBe(TURNED_HEALTH);
    g.players[1]!.health = 5;
    g.players[0]!.arsenal.fireCd = 0;
    step(g, [fire, IDLE], DT);
    expect(g.players[1]!.status).toBe('dead');
  });
});

describe('checking another survivor', () => {
  const check: Input = { dx: 0, dy: 0, action: true };

  /** Seat 0 stands by seat 1 and looks them over for as long as it takes. */
  function look(g: GameState): void {
    step(g, [check, IDLE], DT);
    for (let i = 0; i < 3 * 30; i++) step(g, [IDLE, IDLE], DT);
  }

  it('shows the one who looked, and only them, that the other is bitten', () => {
    const g = duel(2);
    g.players[1]!.bitten = true;
    expect(viewFor(g, 0).others[0]!.exposed).toBe(false); // nothing is known until you look
    look(g);
    expect(viewFor(g, 0).others[0]!.exposed).toBe(true);
    expect(viewFor(g, 1).others[0]!.exposed).toBe(false); // the one looked at learns nothing about the one who looked
  });

  it('says clean when they are not, and is only what it was when you looked', () => {
    const g = duel(2);
    look(g);
    expect(viewFor(g, 0).others[0]!.exposed).toBe(false);
    expect(g.players[0]!.checks[1]).toBe(false);
    g.players[1]!.bitten = true; // bitten after: you do not know yet
    expect(viewFor(g, 0).others[0]!.exposed).toBe(false);
  });

  it('gets interrupted by walking away, and tells only the one who looked', () => {
    const g = duel(2);
    step(g, [check, IDLE], DT);
    expect(g.players[0]!.work?.kind).toBe('check');
    for (let i = 0; i < 20; i++) step(g, [{ dx: -1, dy: 0 }, IDLE], DT);
    expect(g.players[0]!.work).toBeNull();
    expect(g.players[0]!.checks[1]).toBeUndefined();
  });

  it('a bite marks a player bitten', () => {
    const g = quietRoom(2);
    const a = openSpot(g, { x: 160, y: 160 });
    put(g, 0, a); put(g, 1, { x: a.x + 30, y: a.y });
    addZ(g, 'walker', { x: a.x + 1, y: a.y });
    for (let i = 0; i < 90; i++) step(g, [IDLE, IDLE], DT);
    expect(g.players[0]!.bitten).toBe(true);
    expect(g.players[1]!.bitten).toBe(false);
  });
});

describe('turning', () => {
  it('when the dose runs out you turn at once, the zombies ignore you, and you can lunge', () => {
    const g = duel(1.4);
    const z = addZ(g, 'walker', { x: g.players[1]!.pos.x + 1.2, y: g.players[1]!.pos.y });
    z.alertT = 30;
    g.players[1]!.remaining = 0.01;
    step(g, [IDLE, IDLE], DT);
    expect(g.players[1]!.status).toBe('turned');
    expect(g.events.some((e) => e.type === 'turned' && e.seat === 1)).toBe(true);
    // the walker next to them does not go for them; the living one is not hurt by walkers that ignore the turned
    expect(z.targetId === undefined || z.targetId === 0).toBe(true);
    g.players[0]!.invuln = 0;
    const before = g.players[0]!.health;
    step(g, [IDLE, fire], DT);
    expect(g.events.some((e) => e.type === 'lunge')).toBe(true);
    expect(g.players[0]!.health).toBe(before - ATTACK_DAMAGE); // a lunge is full strength
  });
});

describe('the exit', () => {
  function atExit(n: number): GameState {
    const g = quietRoom(n);
    for (const t of g.tasks) if (t.required) t.done = true;
    g.safehouseKnown = true;
    g.players.forEach((_p, i) => put(g, i, { x: g.safehouse.x + (i - n / 2) * 0.4, y: g.safehouse.y }));
    return g;
  }

  it('holds seats for half the players: the rest are left, and the round ends', () => {
    const g = atExit(4);
    step(g, [IDLE, IDLE, IDLE, IDLE], DT);
    expect(g.players.filter((p) => p.status === 'escaped').length).toBe(2);
    expect(g.seatsLeft).toBe(0);
    expect(g.phase).toBe('won');
    expect(g.players.filter((p) => p.status === 'missed').length).toBe(2);
    expect(g.placements!.slice(0, 2).map((p) => p.status)).toEqual(['escaped', 'escaped']);
  });

  it('stays shut until the steps are done', () => {
    const g = atExit(2);
    g.tasks.find((t) => t.required)!.done = false;
    step(g, [IDLE, IDLE], DT);
    expect(g.players.every((p) => p.status === 'alive')).toBe(true);
    expect(g.events.some((e) => e.type === 'safehouse-locked')).toBe(true);
  });

  it('the round ends when the room clock does, and nobody out means a loss', () => {
    const g = quietRoom(2);
    g.elapsed = ROOM_SECONDS - 0.01;
    step(g, [IDLE, IDLE], DT);
    expect(g.phase).toBe('lost');
    expect(g.placements!.every((p) => p.status === 'missed')).toBe(true);
  });
});

describe('what each seat is told', () => {
  it('never includes another player\'s clock or health', () => {
    const g = duel(8);
    g.players[1]!.remaining = 123.456;
    g.players[1]!.health = 61;
    const v = viewFor(g, 0);
    expect(v.others.length).toBe(1);
    expect(Object.keys(v.others[0]!).sort()).toEqual(['exposed', 'heading', 'id', 'light', 'pos', 'status', 'vehicleId', 'weapon']);
    expect(JSON.stringify(v.others)).not.toContain('123.456');
    expect(v.you.health).toBe(PLAYER_HEALTH);
    expect('flow' in v.you).toBe(false);
  });

  /** Two street points 15 to 25 apart with a wall between them. */
  function walled(g: GameState): [Vec2, Vec2] {
    for (const a of g.map.points) for (const b of g.map.points) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d > 15 && d < 24 && !lineClear(g.map, a, b, 0.3)) return [a, b];
    }
    throw new Error('no walled pair');
  }

  it('leaves out a zombie behind a wall and keeps one in the open', () => {
    const g = quietRoom(2);
    const [a, b] = walled(g);
    put(g, 0, a);
    put(g, 1, { x: 10, y: 10 });
    const hidden = addZ(g, 'walker', b, 1001);
    const open = addZ(g, 'walker', { x: a.x + 2, y: a.y + 3 }, 1002);
    const ids = viewFor(g, 0).zombies.map((z) => z.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(hidden.id);
  });

  it('a stalker you are not lighting is not sent unless it is close', () => {
    const g = quietRoom(2);
    const a = openSpot(g, { x: 160, y: 160 });
    put(g, 0, a, 0);
    put(g, 1, { x: 10, y: 10 });
    g.players[0]!.light = false;
    const s = addZ(g, 'stalker', { x: a.x + 12, y: a.y }, 1003);
    expect(viewFor(g, 0).zombies.map((z) => z.id)).not.toContain(s.id);
    g.players[0]!.light = true;
    expect(viewFor(g, 0).zombies.map((z) => z.id)).toContain(s.id); // lit: you can see it
    s.pos = { x: a.x + 8, y: a.y };
    g.players[0]!.light = false;
    expect(viewFor(g, 0).zombies.map((z) => z.id)).toContain(s.id); // close enough to be seen anyway
  });

  it('a gunshot is heard from out of sight if it carries that far, and not beyond', () => {
    const g = quietRoom(2);
    const [a, b] = walled(g);
    put(g, 0, a);
    put(g, 1, { x: 10, y: 10 });
    g.events.push({ type: 'shot', weapon: 'pistol', from: b, to: b, hit: null });
    expect(viewFor(g, 0).events.some((e) => e.type === 'shot')).toBe(true);
    g.events.length = 0;
    g.events.push({ type: 'shot', weapon: 'pistol', from: { x: a.x + 60, y: a.y + 60 }, to: { x: a.x, y: a.y }, hit: null });
    expect(viewFor(g, 0).events.some((e) => e.type === 'shot')).toBe(false);
  });

  it('personal events go only to their own seat', () => {
    const g = duel(30);
    g.events.push({ type: 'pickup', kind: 'ammo', amount: 5, seat: 1 } as never);
    expect(viewFor(g, 1).events.some((e) => e.type === 'pickup')).toBe(true);
    expect(viewFor(g, 0).events.some((e) => e.type === 'pickup')).toBe(false);
  });
});

describe('a round can be written down and played again', () => {
  const play = (seed: number, n: number) => {
    const g = createRoom(seed, n);
    const rec = new RoomRecorder(seed, n, 1, DT);
    const r = createRng(seed * 7 + n);
    const moves = Array.from({ length: n }, () => ({ dx: 0, dy: 0 }));
    for (let i = 0; i < 60 / DT && g.phase === 'playing'; i++) {
      const inputs = moves.map((m, k) => {
        if (i % 40 === k * 7) { const a = next(r) * Math.PI * 2; m.dx = Math.cos(a); m.dy = Math.sin(a); }
        return quantize({ dx: m.dx, dy: m.dy, fire: next(r) < 0.25, action: next(r) < 0.03, light: next(r) < 0.004, throw: next(r) < 0.004 });
      });
      if (i === 100) { rec.command(1, { t: 'buy', item: { kind: 'medkit' } }); command(g, { t: 'buy', item: { kind: 'medkit' } }, 1); }
      step(g, inputs, DT);
      rec.tick(inputs);
    }
    return { g, rec };
  };

  it('ends exactly where it did, for different seeds and sizes', () => {
    for (const [seed, n] of [[3, 2], [9, 4]] as const) {
      const { g, rec } = play(seed, n);
      const log = JSON.parse(JSON.stringify(rec.log())) as ReturnType<RoomRecorder['log']>;
      expect(hashState(replayRoom(log))).toBe(hashState(g));
    }
  });

  it('is the same every time it is played', () => {
    expect(hashState(play(5, 3).g)).toBe(hashState(play(5, 3).g));
  });
});
