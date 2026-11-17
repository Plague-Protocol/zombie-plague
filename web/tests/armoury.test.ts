import { describe, expect, it } from 'vitest';
import { applyLoadout, earnedFor, loadoutPoints, loadoutProblem, RANKED_POINTS, type Loadout, type Owned } from '../../core/armoury';
import { createGame, step } from '../../core/state';
import { GEAR, GUNS, START_FUNDS } from '../../core/config';
import { hashState, quantize, Recorder, replay, STEP } from '../../core/replay';
import { createRng, next } from '../../core/rng';

const OWNS: Owned = { kit: ['shotgun', 'rifle', 'vest', 'helmet', 'ammo', 'bottles', 'cash', 'bat'], ups: { 'shotgun.damage': 2, 'pistol.mag': 1 } };

describe('the armoury', () => {
  it('starts a night with what you brought', () => {
    const l: Loadout = { kit: ['shotgun', 'vest', 'ammo', 'cash'], ups: { 'shotgun.damage': 2 }, hand: 'shotgun' };
    const g = createGame(5, undefined, { loadout: l });
    const a = g.arsenal;
    expect(a.owned).toEqual(['pistol', 'baton', 'shotgun']);
    expect(a.weapon).toBe('shotgun');
    expect(a.mag.shotgun).toBe(GUNS.shotgun.mag);
    expect(a.ammo.shotgun).toBe(GUNS.shotgun.ammoPack * 2); // its own pack and the belt's
    expect(a.upgrades.shotgun.damage).toBe(2);
    expect(a.gear.vest).toBe(GEAR.vest.durability);
    expect(g.player.funds).toBe(START_FUNDS + 50);
    const plain = createGame(5);
    expect(plain.arsenal.owned).toEqual(['pistol', 'baton']);
    expect(plain.player.funds).toBe(START_FUNDS);
  });

  it('a magazine upgrade starts the magazine full to its new size', () => {
    const a = createGame(5, undefined, { loadout: { kit: [], ups: { 'pistol.mag': 1 } } }).arsenal;
    expect(a.mag.pistol).toBe(Math.round(GUNS.pistol.mag * 1.4));
  });

  it('refuses what is not yours, what is malformed, and a ranked loadout over budget', () => {
    expect(loadoutProblem({ kit: ['machete'], ups: {} }, OWNS, false)).toMatch(/not yours/);
    expect(loadoutProblem({ kit: ['machete'], ups: {} }, OWNS, false, ['machete'])).toBeNull(); // borrowed for the night
    expect(loadoutProblem({ kit: ['shotgun', 'shotgun'], ups: {} }, OWNS, false)).toMatch(/twice/);
    expect(loadoutProblem({ kit: ['laser'], ups: {} }, OWNS, false)).toMatch(/unknown/);
    expect(loadoutProblem({ kit: [], ups: { 'shotgun.damage': 1 } }, OWNS, false)).toMatch(/not bringing/);
    expect(loadoutProblem({ kit: ['shotgun'], ups: { 'shotgun.damage': 3 } }, OWNS, false)).toMatch(/bad level/);
    expect(loadoutProblem({ kit: [], ups: { 'pistol.mag': 2 } }, OWNS, false)).toMatch(/not yours/);
    expect(loadoutProblem({ kit: [], ups: { 'baton.mag': 1 } }, OWNS, false)).toMatch(/unknown upgrade/);
    expect(loadoutProblem({ kit: [], ups: {}, hand: 'rifle' }, OWNS, false)).toMatch(/in hand/);
    expect(loadoutProblem('rifle', OWNS, false)).toMatch(/not a loadout/);
    const big: Loadout = { kit: ['rifle', 'vest'], ups: {} };
    expect(loadoutPoints(big)).toBeGreaterThan(RANKED_POINTS);
    expect(loadoutProblem(big, OWNS, false)).toBeNull();
    expect(loadoutProblem(big, OWNS, true)).toMatch(/budget/);
    expect(loadoutProblem({ kit: ['shotgun', 'helmet', 'ammo'], ups: { 'pistol.mag': 1 } }, OWNS, true)).toBeNull(); // 4+2+1+1 = 8
  });

  it('a night played with a loadout replays to the same end', () => {
    const l: Loadout = { kit: ['rifle', 'vest', 'bottles'], ups: {}, hand: 'rifle' };
    const g = createGame(9, undefined, { loadout: l });
    const rec = new Recorder(9, 1, l);
    rec.begin(0, null);
    const r = createRng(99);
    let dx = 0, dy = 0;
    for (let i = 0; i < 30 / STEP && g.phase === 'playing'; i++) {
      if (i % 40 === 0) { const a = next(r) * Math.PI * 2; dx = Math.cos(a); dy = Math.sin(a); }
      const input = quantize({ dx, dy, fire: next(r) < 0.4, throw: next(r) < 0.01 });
      step(g, input, STEP);
      rec.step(input);
    }
    const log = JSON.parse(JSON.stringify(rec.log())) as ReturnType<Recorder['log']>;
    expect(log.loadout).toEqual(l);
    expect(hashState(replay(log))).toBe(hashState(g));
    // the same inputs without the loadout are a different night
    expect(hashState(replay({ ...log, loadout: undefined }))).not.toBe(hashState(g));
  });

  it('pays a share of the score, half on a practice night', () => {
    expect(earnedFor(5000, true)).toBe(200);
    expect(earnedFor(5000, false)).toBe(100);
    expect(applyLoadout(createGame(1).arsenal, 10, undefined)).toBe(10);
  });
});
