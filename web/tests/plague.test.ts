// The plague's own rules: the infection clock, the flashlight, pacing, the other infected, hidden bites,
// door marks, the spread and your last self.
import { describe, expect, it } from 'vitest';
import {
  aimTarget, createGame, escortGroup, fallenBlocks, infection, inLight, interactionFor, leaveBehind, priceOf, buy, restartChapter, sightScale,
  step, takeAntiviral, type GameState,
} from '../../core/state';
import { cellOf } from '../../core/map';
import {
  ANTIVIRAL_SECONDS, ATTACK_REACH, BITE_COST, CHECK_SECONDS, CRAWL_DAMAGE, CRAWLERS, DORMANT, DREAD_SECONDS, GRAB_SLOW, HUSK_HEALTH, LASH_DAMAGE,
  LASHERS, LIGHT_OFF_SIGHT, PLAYER_HEALTH, PLAYER_SPEED, SCREAM_WINDUP, SCREAMERS, STALKERS, ZOMBIE_HEALTH,
} from '../../core/config';
import { command, quantize, Recorder, replay, STEP } from '../../core/replay';
import { createRng, next } from '../../core/rng';
import { generateLevel } from '../../core/level';
import { content } from '../../core/content';
import { ending } from '../../core/story';
import type { Escort, Input, Vec2, Zombie, ZombieKind } from '../../core/types';

const IDLE: Input = { dx: 0, dy: 0 };
const USE: Input = { dx: 0, dy: 0, action: true };
const DT = 1 / 30;

/** A night with the street to yourself, on open ground, facing +x, and the director asleep. */
function quiet(seed = 3): GameState {
  const g = createGame(seed);
  g.zombies = [];
  g.guarded = g.tasks.map((t) => t.id);
  g.director.t = 1e9;
  g.inFallen = false;
  g.fallOrder = [];
  const r = 14;
  g.player.pos = { ...g.map.points.find((p) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (g.map.blocked[cellOf(g.map, { x: p.x + dx, y: p.y + dy })] === 1) return false;
    return true;
  })! };
  g.player.heading = 0;
  return g;
}

function zombie(g: GameState, kind: ZombieKind, dx: number, dy = 0, id = 500): Zombie {
  const z: Zombie = {
    id, kind, pos: { x: g.player.pos.x + dx, y: g.player.pos.y + dy }, heading: 0, speed: 0, action: 'idle', actionT: 0, cooldown: 0,
    health: ZOMBIE_HEALTH[kind], staggerT: 0, alertT: 0, wanderT: 99, wanderDir: { x: 0, y: 0 },
  };
  g.zombies.push(z);
  return z;
}

const run = (g: GameState, seconds: number, input: Input = IDLE) => { for (let i = 0; i < seconds / DT && g.phase === 'playing'; i++) step(g, input, DT); };
const member = (name: string, at: Vec2): Escort => ({ pos: { ...at }, heading: 0, speed: 0, riding: false, name, skin: 'humanFemaleA', scale: 1 });

describe('the infection is the clock', () => {
  it('runs from 0 to 1 as the dose wears off, and running out is turning', () => {
    const g = quiet();
    expect(infection(g)).toBe(0);
    g.remaining = g.timeLimit / 4;
    expect(infection(g)).toBeCloseTo(0.75, 5);
    g.remaining = 0.01;
    step(g, IDLE, DT);
    expect(g.lossReason).toBe('time');
    expect(ending('time').title).toBe('TURNED');
    expect(ending('time', false).title).toBe('TURNED');
  });

  it('a bite jumps it ahead as well as hurting', () => {
    const g = quiet();
    zombie(g, 'walker', 1);
    const before = g.remaining;
    let bite = 0;
    for (let i = 0; i < 90 && !bite; i++) { step(g, IDLE, DT); for (const e of g.events) if (e.type === 'bitten') bite = e.seconds; }
    expect(bite).toBeCloseTo(BITE_COST, 5);
    expect(before - g.remaining).toBeGreaterThan(BITE_COST);
  });

  it('a dose holds it back, but never past a full clock', () => {
    const g = quiet();
    expect(takeAntiviral(g)).toBe(0);
    expect(priceOf(g, { kind: 'antiviral' })).toBeNull(); // nothing to hold back yet
    g.remaining = g.timeLimit - 100;
    g.funds = 1000;
    expect(buy(g, { kind: 'antiviral' })).toBe(true);
    expect(g.remaining).toBeCloseTo(g.timeLimit - 100 + ANTIVIRAL_SECONDS, 5);
    g.remaining = g.timeLimit - 5;
    expect(takeAntiviral(g)).toBeCloseTo(5, 5);
  });

  it('doses lie in every district, and walking over one takes it', () => {
    const g = quiet();
    const dose = g.pickups.find((p) => p.kind === 'antiviral')!;
    expect(g.pickups.filter((p) => p.kind === 'antiviral').length).toBeGreaterThan(0);
    g.remaining = g.timeLimit / 2;
    g.player.pos = { ...dose.pos };
    step(g, IDLE, DT);
    expect(dose.taken).toBe(true);
    expect(g.remaining).toBeGreaterThan(g.timeLimit / 2 + ANTIVIRAL_SECONDS - 1);
  });

  it('nearly turned, they see less of you, and you cough loud enough to be heard', () => {
    const g = quiet();
    const fresh = sightScale(g);
    g.remaining = g.timeLimit * 0.1;
    expect(sightScale(g)).toBeLessThan(fresh);
    const near = zombie(g, 'walker', 6, 0, 1), far = zombie(g, 'walker', 40, 0, 2);
    g.coughT = 0;
    step(g, IDLE, DT);
    expect(g.events).toContainEqual({ type: 'cough', who: null, pos: g.player.pos });
    expect(near.alertT).toBeGreaterThan(0);
    expect(far.alertT).toBe(0);
  });
});

describe('the flashlight', () => {
  it('off, they have to be much closer to notice you', () => {
    const seen = (light: boolean) => {
      const g = quiet();
      g.light = light;
      const z = zombie(g, 'walker', 8);
      run(g, 0.5);
      return z.action === 'chase';
    };
    expect(seen(true)).toBe(true);
    expect(seen(false)).toBe(false);
    const g = quiet();
    step(g, { dx: 0, dy: 0, light: true }, DT);
    expect(g.light).toBe(false);
    expect(g.events).toContainEqual({ type: 'light', on: false });
    expect(sightScale(g)).toBeCloseTo(LIGHT_OFF_SIGHT, 5);
  });

  it('the beam is a cone in front of you', () => {
    const g = quiet();
    const p = g.player.pos;
    expect(inLight(g, { x: p.x + 8, y: p.y })).toBe(true);
    expect(inLight(g, { x: p.x - 8, y: p.y })).toBe(false); // behind you
    expect(inLight(g, { x: p.x + 30, y: p.y })).toBe(false); // too far
    g.light = false;
    expect(inLight(g, { x: p.x + 8, y: p.y })).toBe(false);
  });
});

describe('the other infected', () => {
  it('every district has screamers, stalkers and bodies that are not dead', () => {
    const g = createGame(11);
    expect(g.zombies.filter((z) => z.kind === 'screamer').length).toBe(SCREAMERS[0]);
    expect(g.zombies.filter((z) => z.kind === 'stalker').length).toBe(STALKERS[0]);
    expect(g.zombies.filter((z) => z.action === 'dormant').length).toBe(DORMANT[0]);
    expect(g.corpses.length).toBeGreaterThan(0); // and bodies that are
  });

  it('a body that is not dead gets up when you walk close; aim assist never picks it out', () => {
    const g = quiet();
    const z = zombie(g, 'walker', 6);
    z.action = 'dormant';
    run(g, 2);
    expect(z.action).toBe('dormant');
    expect(aimTarget(g, 'pistol')).toBeNull();
    z.pos = { x: g.player.pos.x + 2.5, y: g.player.pos.y };
    step(g, IDLE, DT);
    expect(z.action).toBe('rise');
    expect(g.events).toContainEqual({ type: 'dormant-wake', id: z.id });
  });

  it('gunfire wakes the ones lying close', () => {
    const g = quiet();
    const z = zombie(g, 'walker', 0, 7);
    z.action = 'dormant';
    step(g, { dx: 0, dy: 0, fire: true }, DT);
    expect(z.action).toBe('rise');
  });

  it('a screamer that sees you calls the rest, unless you hit it first', () => {
    const g = quiet();
    zombie(g, 'screamer', 12, 0, 1);
    const other = zombie(g, 'walker', 12, 20, 2);
    step(g, IDLE, DT);
    expect(g.zombies[0]!.action).toBe('scream');
    let called = false;
    for (let i = 0; i < (SCREAM_WINDUP + 0.3) / DT; i++) { step(g, IDLE, DT); if (g.events.some((e) => e.type === 'scream')) called = true; }
    expect(called).toBe(true);
    expect(other.alertT).toBeGreaterThan(0);

    const h = quiet();
    zombie(h, 'screamer', 6, 0, 1);
    step(h, IDLE, DT);
    expect(h.zombies[0]!.action).toBe('scream');
    let heard = false;
    for (let i = 0; i < (SCREAM_WINDUP + 0.3) / DT; i++) { step(h, { dx: 0, dy: 0, fire: true }, DT); if (h.events.some((e) => e.type === 'scream')) heard = true; }
    expect(heard).toBe(false);
  });

  it('a stalker stands still in your light and comes on when you look away', () => {
    const g = quiet();
    const z = zombie(g, 'stalker', 9);
    run(g, 1.5);
    expect(z.frozen).toBe(true);
    expect(z.pos.x - g.player.pos.x).toBeCloseTo(9, 3);
    g.player.heading = Math.PI; // turn your back
    run(g, 1.5);
    expect(z.frozen).toBe(false);
    expect(z.pos.x - g.player.pos.x).toBeLessThan(6);
  });
});

describe('half bodies and tentacles', () => {
  it('every district has crawlers and lashers', () => {
    const g = createGame(11);
    expect(g.zombies.filter((z) => z.kind === 'crawler').length).toBe(CRAWLERS[0]);
    expect(g.zombies.filter((z) => z.kind === 'lasher').length).toBe(LASHERS[0]);
  });

  it('a crawler does not bite deep: it gets hold of your leg and slows you', () => {
    const g = quiet();
    zombie(g, 'crawler', 1);
    let grabbed = false;
    for (let i = 0; i < 90 && !grabbed; i++) { step(g, IDLE, DT); grabbed = g.events.some((e) => e.type === 'grabbed'); }
    expect(grabbed).toBe(true);
    expect(g.player.health).toBeCloseTo(PLAYER_HEALTH - CRAWL_DAMAGE, 5);
    g.zombies = [];
    g.player.vel = { x: 0, y: 0 };
    run(g, 1, { dx: 1, dy: 0 });
    expect(Math.hypot(g.player.vel.x, g.player.vel.y)).toBeCloseTo(PLAYER_SPEED * GRAB_SLOW, 3);
    run(g, 2.5, { dx: 1, dy: 0 });
    expect(Math.hypot(g.player.vel.x, g.player.vel.y)).toBeCloseTo(PLAYER_SPEED, 3);
  });

  it('a lasher strikes from out of arm\'s reach and drags you toward it', () => {
    const g = quiet();
    const far = ATTACK_REACH + 1.2;
    const z = zombie(g, 'lasher', far);
    let hit = false;
    for (let i = 0; i < 60 && !hit; i++) { step(g, IDLE, DT); hit = g.events.some((e) => e.type === 'player-hit'); }
    expect(hit).toBe(true);
    expect(g.player.health).toBeCloseTo(PLAYER_HEALTH - LASH_DAMAGE, 5);
    expect(g.player.vel.x).toBeGreaterThan(0); // pulled toward it (it is at +x)
    expect(z.pos.x - g.player.pos.x).toBeGreaterThan(ATTACK_REACH); // and it never had to come close
  });

  it('a walker shot down is sometimes only cut in half, and the top half keeps coming', () => {
    let halved = 0, killed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const g = quiet(seed);
      g.arsenal.mag.pistol = 12;
      for (let k = 0; k < 4; k++) zombie(g, 'walker', 6 + k * 1.5, 0, 600 + k).health = 1;
      g.safeT = 1e6; // they hold still
      for (let i = 0; i < 150; i++) {
        step(g, { dx: 0, dy: 0, fire: true }, DT);
        for (const e of g.events) { if (e.type === 'halved') halved++; if (e.type === 'zombie-killed') killed++; }
      }
      for (const z of g.zombies) if (z.kind === 'crawler') expect(z.health).toBeGreaterThan(0);
    }
    expect(halved).toBeGreaterThan(0);
    expect(killed).toBeGreaterThan(halved);
  });
});

describe('a night can be written down and played again', () => {
  const snap = (g: GameState) => JSON.stringify({
    p: g.player, z: g.zombies, c: g.corpses.length, r: g.remaining, ph: g.phase, f: g.funds, a: g.arsenal, k: g.kills, rng: g.rng, rng2: g.rng2,
    d: g.director, fallen: g.fallenN, light: g.light, pick: g.pickups.map((q) => q.taken),
  });

  /** Play a scrappy 40 seconds (wandering, shooting, the light, a bottle, a purchase, a swap of weapon) and write it down. */
  function play(seed: number): { g: GameState; rec: Recorder } {
    const g = createGame(seed);
    const rec = new Recorder(seed, 1);
    rec.begin(0, null);
    const r = createRng(seed * 31 + 7);
    let dx = 0, dy = 0;
    for (let i = 0; i < 40 / STEP && g.phase === 'playing'; i++) {
      if (i % 45 === 0) { const a = next(r) * Math.PI * 2, m = next(r); dx = Math.cos(a) * m; dy = Math.sin(a) * m; }
      const input = quantize({ dx, dy, fire: next(r) < 0.3, action: next(r) < 0.02, reload: next(r) < 0.01, swap: next(r) < 0.005, throw: next(r) < 0.004, light: next(r) < 0.004 });
      if (i === 300) for (const c of [{ t: 'buy', item: { kind: 'medkit' } }, { t: 'equip', weapon: 'baton' }, { t: 'grace' }] as const) { rec.command(c); command(g, c); }
      step(g, input, STEP);
      rec.step(input);
    }
    return { g, rec };
  }

  it('the replay ends exactly where the night did', () => {
    for (const seed of [4, 17]) {
      const { g, rec } = play(seed);
      const log = JSON.parse(JSON.stringify(rec.log())) as ReturnType<Recorder['log']>; // as it would arrive at a server
      expect(snap(replay(log))).toBe(snap(g));
      expect(log.chapters[0]!.runs.length / 4).toBeLessThan(40 / STEP); // runs of the same input are folded together
    }
  });

  it('a changed log gives a different night, and a retry replaces its chapter', () => {
    const { g, rec } = play(4);
    const log = JSON.parse(JSON.stringify(rec.log())) as ReturnType<Recorder['log']>;
    log.chapters[0]!.commands = [];
    expect(snap(replay(log))).not.toBe(snap(g));
    rec.begin(0, null);
    expect(rec.log().chapters.length).toBe(1);
    expect(rec.log().chapters[0]!.runs.length).toBe(0);
    const two = rec.log();
    two.chapters.push({ husk: null, runs: [1, 0, 0, 0], commands: [] });
    expect(() => replay(two)).toThrow(); // a second chapter cannot follow one that was never cleared
  });
});

describe('quiet, then one sound, then they come', () => {
  it('the director warns, then they come up out of the ground near you', () => {
    const g = quiet();
    g.director.t = 0.01;
    step(g, IDLE, DT);
    step(g, IDLE, DT);
    expect(g.director.phase).toBe('dread');
    const omen = g.director.at!;
    expect(Math.hypot(omen.x - g.player.pos.x, omen.y - g.player.pos.y)).toBeLessThan(20);
    let burst = 0;
    for (let i = 0; i < (DREAD_SECONDS + 0.5) / DT; i++) { step(g, IDLE, DT); for (const e of g.events) if (e.type === 'burst') burst = e.count; }
    expect(burst).toBeGreaterThan(0);
    expect(g.zombies.length).toBe(burst);
    expect(g.director.phase).toBe('panic');
  });
});

describe('hidden bites', () => {
  function withGroup(bitten: number | null): GameState {
    const g = quiet();
    const p = g.player.pos;
    const lead = member('Ada', { x: p.x + 1.5, y: p.y });
    lead.party = [member('Ben', { x: p.x + 8, y: p.y }), member('Cal', { x: p.x + 11, y: p.y })];
    g.escort = lead;
    if (bitten !== null) { const m = escortGroup(g)[bitten]!; m.bitten = true; m.turnT = 60; }
    return g;
  }

  it('looking someone over takes a moment and tells you; the bitten can be left', () => {
    const g = withGroup(0);
    expect(interactionFor(g)).toEqual({ kind: 'check', who: 0 });
    step(g, USE, DT);
    let found: boolean | null = null;
    for (let i = 0; i < (CHECK_SECONDS + 0.3) / DT; i++) { step(g, IDLE, DT); for (const e of g.events) if (e.type === 'checked') found = e.bitten; }
    expect(found).toBe(true);
    expect(interactionFor(g)).toEqual({ kind: 'leave', who: 0 });
    step(g, USE, DT);
    expect(g.events).toContainEqual({ type: 'left-behind', name: 'Ada' });
    expect(escortGroup(g).map((m) => m.name)).toEqual(['Ben', 'Cal']);
    expect(g.abandoned.map((a) => a.name)).toEqual(['Ada']);
  });

  it('someone clean is not asked again: the next one who has caught up is', () => {
    const g = withGroup(null);
    step(g, USE, DT);
    run(g, CHECK_SECONDS + 0.3);
    expect(escortGroup(g)[0]!.checked).toBe('clean');
    expect(interactionFor(g)).toEqual({ kind: 'check', who: 1 });
    for (const m of escortGroup(g)) m.checked = 'clean';
    expect(interactionFor(g)).toBeNull();
  });

  it('unnoticed, they turn beside you; left behind, they turn where you left them', () => {
    const g = withGroup(1);
    escortGroup(g)[1]!.turnT = 0.2;
    let where = '';
    for (let i = 0; i < 20; i++) { step(g, IDLE, DT); for (const e of g.events) if (e.type === 'escort-turned') where = e.where; }
    expect(where).toBe('street');
    expect(escortGroup(g).map((m) => m.name)).toEqual(['Ada', 'Cal']);
    expect(g.zombies.some((z) => z.kind === 'runner')).toBe(true);

    const h = withGroup(2);
    leaveBehind(h, escortGroup(h)[2]!);
    h.abandoned[0]!.turnT = 0.1;
    step(h, IDLE, DT);
    step(h, IDLE, DT);
    step(h, IDLE, DT);
    step(h, IDLE, DT);
    expect(h.abandoned.length).toBe(0);
    expect(h.zombies.length).toBe(1);
  });

  it('bringing someone bitten inside ends the night', () => {
    for (let night = 1; night < 400; night++) {
      const g = createGame(night);
      const end = g.tasks.find((t) => t.effect === 'escort-end');
      if (!end) continue;
      g.zombies = [];
      g.guarded = g.tasks.map((t) => t.id);
      for (const t of g.tasks) if (t !== end && t.required && g.tasks.indexOf(t) < g.tasks.indexOf(end)) t.done = true;
      const lead = member('Ada', { x: end.pos.x + 1, y: end.pos.y });
      lead.bitten = true;
      lead.turnT = 999;
      g.escort = lead;
      g.player.pos = { ...end.pos };
      step(g, USE, DT);
      run(g, (end.seconds ?? 1.2) + 0.5);
      expect(g.phase).toBe('lost');
      expect(g.lossReason).toBe('carrier');
      expect(ending('carrier').title).toBe('CARRIER');
      return;
    }
    throw new Error('no night with an escort');
  });
});

describe('the quarantine marks on doors', () => {
  it('a red X always means one inside; a white ring never does', () => {
    let red = 0, white = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const h of generateLevel(seed).houses) {
        if (h.mark === 'infected') { red++; expect(h.ambush).toBe(true); }
        if (h.mark === 'clear') { white++; expect(h.ambush).toBe(false); }
      }
    }
    expect(red).toBeGreaterThan(0);
    expect(white).toBeGreaterThan(0);
  });
});

describe('the outbreak spreads', () => {
  it('more of the district has fallen the further the infection has gone', () => {
    const g = createGame(9);
    const start = fallenBlocks(g).length;
    expect(start).toBeGreaterThan(0);
    g.remaining = g.timeLimit * 0.2;
    g.zombies = [];
    step(g, IDLE, DT);
    expect(fallenBlocks(g).length).toBeGreaterThan(start);
    expect(g.events.some((e) => e.type === 'block-fallen')).toBe(true);
    expect(fallenBlocks(g).every((i) => g.map.blocks[i]!.district !== 'water')).toBe(true);
  });
});

describe('your last self', () => {
  it('waits where the district took you, and drops what you carried', () => {
    const first = createGame(21);
    const fell = { ...first.map.points[first.map.points.length >> 1]! };
    const g = restartChapter(first, { pos: fell, weapon: 'shotgun' });
    const husk = g.zombies.find((z) => z.husk)!;
    expect(husk.health).toBe(HUSK_HEALTH);
    expect(Math.hypot(husk.pos.x - fell.x, husk.pos.y - fell.y)).toBeLessThan(40);
    g.zombies = [husk];
    g.director.t = 1e9;
    g.player.pos = { x: husk.pos.x - 3, y: husk.pos.y };
    g.player.heading = 0;
    husk.health = 1;
    for (let i = 0; i < 30 && !g.events.some((e) => e.type === 'husk-down'); i++) step(g, { dx: 0, dy: 0, fire: true }, DT);
    expect(g.events.some((e) => e.type === 'husk-down')).toBe(true);
    expect(g.pickups.at(-1)!.kind).toBe('shotgun');
    expect(createGame(21).zombies.some((z) => z.husk)).toBe(false);
  });
});

describe('the story knows about the plague', () => {
  it('has the loudspeaker lines and the first-time hints', () => {
    const st = content().story;
    expect(st.pa!.length).toBeGreaterThan(2);
    for (const k of ['light', 'cough', 'dormant', 'scream', 'stalker', 'mark', 'fallen', 'husk', 'omen']) expect(st.hints![k]!.length).toBeGreaterThan(0);
  });
});
