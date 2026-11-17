import { describe, expect, it } from 'vitest';
import { makeServer, wallet } from './helpers.ts';
import { createGame, step } from '../../core/state.ts';
import { quantize, Recorder, STEP, type NightLog } from '../../core/replay.ts';
import { DAILY_CAP, DAILY_RATION, kitDef, loanFee, svPrice, upgradePrice, type Loadout } from '../../core/armoury.ts';
import { nightOf } from '../src/content.ts';
import { dayStart, payForRound } from '../src/armoury.ts';
import type { Claim } from '../src/runs.ts';

/** A night stood still until it ends, carrying a loadout. */
function idleWith(seed: number, loadout: Loadout | undefined): Claim {
  const g = createGame(seed, undefined, { loadout });
  const rec = new Recorder(seed, 1, loadout);
  rec.begin(0, null);
  const input = quantize({ dx: 0, dy: 0 });
  for (let i = 0; i < 20 * 60 * 60 && g.phase === 'playing'; i++) { step(g, input, STEP); rec.step(input); }
  const replay = JSON.parse(JSON.stringify(rec.log())) as NightLog;
  return { seed, chapter: 0, outcome: g.phase === 'won' ? 'won' : 'lost', lossReason: g.lossReason, secondsLeft: g.remaining, replay };
}

async function setup() {
  const s = await makeServer();
  const w = wallet();
  const { body } = await w.signIn(s.app);
  const auth = { authorization: `Bearer ${body.token}` };
  const get = async () => (await s.app.inject({ method: 'GET', url: '/armoury', headers: auth })).json();
  const post = (url: string, payload: unknown) => s.app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
  return { ...s, id: body.account.id, auth, get, post };
}

describe('the armoury', () => {
  it('buys kit and upgrades with banked cash, once each, and never into debt', async () => {
    const t = await setup();
    expect((await t.get()).cash).toBe(0);
    expect((await t.post('/armoury/buy', { item: 'shotgun' })).statusCode).toBe(402);
    await t.store.ledger(t.id, 2000, 'grant', 'test');
    const r = await t.post('/armoury/buy', { item: 'shotgun' });
    expect(r.statusCode).toBe(200);
    expect(r.json().owned.kit).toEqual(['shotgun']);
    expect(r.json().cash).toBe(2000 - kitDef('shotgun').price);
    expect((await t.post('/armoury/buy', { item: 'shotgun' })).statusCode).toBe(409);
    const u = await t.post('/armoury/buy', { item: 'shotgun.damage' });
    expect(u.json().owned.ups['shotgun.damage']).toBe(1);
    expect(u.json().cash).toBe(2000 - kitDef('shotgun').price - upgradePrice('shotgun', 'damage', 1));
    expect((await t.post('/armoury/buy', { item: 'baton.mag' })).statusCode).toBe(400);
    expect((await t.post('/armoury/buy', { item: 'rifle' })).statusCode).toBe(402);
    expect((await t.post('/armoury/buy', { item: 'laser' })).statusCode).toBe(400);
    expect((await t.app.inject({ method: 'GET', url: '/armoury' })).statusCode).toBe(401);
  });

  it('keeps two loadouts: the ranked one inside the budget, both only with what is yours', async () => {
    const t = await setup();
    await t.store.ledger(t.id, 5000, 'grant', 'test');
    for (const item of ['shotgun', 'rifle']) await t.post('/armoury/buy', { item });
    const ok = await t.post('/armoury/loadout', { ranked: { kit: ['shotgun'], ups: {}, hand: 'shotgun' }, open: { kit: ['shotgun', 'rifle'], ups: {} } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().loadouts.open.kit).toEqual(['shotgun', 'rifle']);
    const over = await t.post('/armoury/loadout', { ranked: { kit: ['shotgun', 'rifle'], ups: {} }, open: { kit: [], ups: {} } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toMatch(/budget/);
    expect((await t.post('/armoury/loadout', { ranked: { kit: [], ups: {} }, open: { kit: ['vest'], ups: {} } })).json().error).toMatch(/not yours/);
  });

  it('a run is refused if it carries what the account does not own, or more than the ranked budget on a daily night', async () => {
    const t = await setup();
    await t.store.ledger(t.id, 5000, 'grant', 'test');
    for (const item of ['shotgun', 'rifle']) await t.post('/armoury/buy', { item });
    const send = (c: Claim) => t.app.inject({ method: 'POST', url: '/runs', headers: t.auth, payload: { result: c } });
    const notMine = (await send(idleWith(4242, { kit: ['machete'], ups: {} }))).json();
    expect(notMine.replayOk).toBe(false);
    expect(notMine.reason).toMatch(/not yours/);
    const tonight = nightOf(new Date());
    const heavy = (await send(idleWith(tonight, { kit: ['shotgun', 'rifle'], ups: {} }))).json();
    expect(heavy.reason).toMatch(/budget/);
    // the same loadout on a practice night is fine
    const practice = (await send(idleWith(4242, { kit: ['shotgun', 'rifle'], ups: {} }))).json();
    expect(practice.replayOk).toBe(true);
    expect(practice.bank.ration).toBe(DAILY_RATION);
    // and the ration is once a day
    expect((await send(idleWith(4243, undefined))).json().bank.ration).toBe(0);
  });

  it('borrows for one night: the fee comes out when a run carries it, the item goes back, and debt stops more borrowing', async () => {
    const t = await setup();
    const b = await t.post('/armoury/borrow', { item: 'rifle' });
    expect(b.statusCode).toBe(200);
    expect(b.json().loans).toHaveLength(1);
    expect((await t.post('/armoury/borrow', { item: 'rifle' })).statusCode).toBe(409);
    await t.post('/armoury/loadout', { ranked: { kit: [], ups: {} }, open: { kit: ['rifle'], ups: {}, hand: 'rifle' } });
    const run = (await t.app.inject({ method: 'POST', url: '/runs', headers: t.auth, payload: { result: idleWith(777, { kit: ['rifle'], ups: {}, hand: 'rifle' }) } })).json();
    expect(run.replayOk).toBe(true);
    expect(run.bank.fees).toBe(loanFee('rifle'));
    const after = await t.get();
    expect(after.cash).toBe(run.bank.earned + DAILY_RATION - loanFee('rifle'));
    expect(after.loans).toHaveLength(0);
    expect(after.loadouts.open.kit).toEqual([]); // it went back
    expect(after.loadouts.open.hand).toBeUndefined();
    // the fee was more than the night paid: the bank is below zero, and nothing more is lent until it is paid
    expect(after.cash).toBeLessThan(0);
    expect((await t.post('/armoury/borrow', { item: 'vest' })).json().error).toMatch(/owe/);
  });

  it('unlocks a survivor, then their perk a level at a time; a loadout may only bring what is owned', async () => {
    const t = await setup();
    await t.store.ledger(t.id, 3000, 'grant', 'test');
    expect((await t.post('/armoury/loadout', { ranked: { kit: [], ups: {}, survivor: 'zara' }, open: { kit: [], ups: {} } })).statusCode).toBe(400);
    const u = await t.post('/armoury/buy', { item: 'sv.zara' });
    expect(u.json().owned.ups['sv.zara']).toBe(1);
    expect(u.json().cash).toBe(3000 - svPrice('zara', 1));
    expect((await t.post('/armoury/buy', { item: 'sv.zara' })).json().owned.ups['sv.zara']).toBe(2); // perk level 1
    expect((await t.post('/armoury/loadout', { ranked: { kit: [], ups: {}, survivor: 'zara', grit: 1 }, open: { kit: [], ups: {}, survivor: 'ama' } })).statusCode).toBe(200);
    expect((await t.post('/armoury/loadout', { ranked: { kit: [], ups: {}, survivor: 'zara', grit: 2 }, open: { kit: [], ups: {} } })).statusCode).toBe(400);
    // a free survivor's first purchase is their first perk level
    expect((await t.post('/armoury/buy', { item: 'sv.ama' })).json().owned.ups['sv.ama']).toBe(2);
    expect((await t.post('/armoury/buy', { item: 'sv.nobody' })).statusCode).toBe(400);
  });

  it('caps what a day can earn', async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) await payForRound(t.store, t.id, `room${i}`, true, new Date());
    expect(await t.store.earnedSince(t.id, dayStart(new Date()))).toBe(DAILY_CAP);
  });
});
