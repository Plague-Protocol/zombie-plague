import { describe, expect, it } from 'vitest';
import { makeServer, wallet } from './helpers.ts';
import { createGame, step } from '../../core/state.ts';
import { quantize, Recorder, STEP, type NightLog } from '../../core/replay.ts';
import { DAILY_CAP, DAILY_RATION, kitDef, lateFee, lendFee, lenderCut, loanFee, svPrice, upgradePrice, type Loadout } from '../../core/armoury.ts';
import { nightOf } from '../src/content.ts';
import { dayStart, payForRound, roomLoadout } from '../src/armoury.ts';
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

async function setup(clock?: { t: number }) {
  const s = await makeServer(clock ? { now: () => new Date(clock.t) } : {});
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

  it('borrows for a term: the fee is paid then (into debt from the armoury), it can be returned early, and it leaves the loadouts', async () => {
    const t = await setup();
    const b = await t.post('/armoury/borrow', { item: 'rifle', days: 3 });
    expect(b.statusCode).toBe(200);
    const v = b.json();
    expect(v.loans).toHaveLength(1);
    expect(v.loans[0].fee).toBe(loanFee('rifle', 3));
    expect(new Date(v.loans[0].dueAt).getTime() - Date.now()).toBeGreaterThan(3 * 864e5 - 60_000);
    expect(v.cash).toBe(-loanFee('rifle', 3)); // a new player borrows on credit; later nights pay it back
    expect((await t.post('/armoury/borrow', { item: 'vest' })).json().error).toMatch(/owe/);
    await t.store.ledger(t.id, 1000, 'grant', 'test');
    expect((await t.post('/armoury/borrow', { item: 'rifle' })).statusCode).toBe(409); // already borrowed
    await t.post('/armoury/borrow', { item: 'vest', days: 1 });
    await t.post('/armoury/borrow', { item: 'bat', days: 7 });
    expect((await t.post('/armoury/borrow', { item: 'helmet' })).json().error).toMatch(/3 loans/);
    await t.post('/armoury/loadout', { ranked: { kit: [], ups: {} }, open: { kit: ['rifle', 'vest'], ups: {}, hand: 'rifle' } });
    const back = await t.post('/armoury/return', { loan: v.loans[0].id });
    expect(back.json().loans.map((l: { item: string }) => l.item)).toEqual(['vest', 'bat']);
    expect(back.json().loadouts.open).toEqual({ kit: ['vest'], ups: {} }); // the rifle, and having it in hand, went back
    expect((await t.post('/armoury/return', { loan: v.loans[0].id })).statusCode).toBe(409);
    expect((await t.post('/armoury/borrow', { item: 'helmet' })).statusCode).toBe(200); // the place it freed
  });

  it('kept past due: a late fee for each day started, then it goes back by itself', async () => {
    const clock = { t: Date.UTC(2026, 10, 18, 12) };
    const t = await setup(clock);
    await t.store.ledger(t.id, 1000, 'grant', 'test');
    const id = (await t.post('/armoury/borrow', { item: 'shotgun', days: 1 })).json().loans[0].id;
    const paid = 1000 - loanFee('shotgun', 1);
    clock.t += 864e5 - 60_000; // not yet due
    expect((await t.get()).cash).toBe(paid);
    clock.t += 2 * 60_000; // a minute late: one day started
    let v = await t.get();
    expect(v.cash).toBe(paid - lateFee('shotgun'));
    expect(v.loans[0]).toMatchObject({ id, overdue: true });
    expect((await t.get()).cash).toBe(paid - lateFee('shotgun')); // taken once
    clock.t += 2 * 864e5; // past the late days: two fees in all, and it is back
    v = await t.get();
    expect(v.cash).toBe(paid - 2 * lateFee('shotgun'));
    expect(v.loans).toEqual([]);
  });

  it('players lend what they own: off their loadouts while listed, most of the fee to them, back on the rack when returned', async () => {
    const lender = await setup();
    const app = lender.app;
    await lender.store.ledger(lender.id, 2000, 'grant', 'test');
    await lender.post('/armoury/buy', { item: 'shotgun' });
    await lender.post('/armoury/loadout', { ranked: { kit: ['shotgun'], ups: {}, hand: 'shotgun' }, open: { kit: [], ups: {} } });
    const listed = (await lender.post('/armoury/lend', { item: 'shotgun', rate: 50 })).json();
    expect(listed.listings).toMatchObject([{ item: 'shotgun', rate: 50, status: 'open' }]);
    expect(listed.loadouts.ranked).toEqual({ kit: [], ups: {} });
    expect((await lender.post('/armoury/loadout', { ranked: { kit: ['shotgun'], ups: {} }, open: { kit: [], ups: {} } })).json().error).toMatch(/not yours/);
    expect((await lender.post('/armoury/lend', { item: 'shotgun', rate: 75 })).statusCode).toBe(409);
    expect((await lender.post('/armoury/lend', { item: 'rifle', rate: 75 })).statusCode).toBe(409); // not owned
    // a borrower sees the offer; borrowing it needs the cash in hand
    const w = wallet();
    const tok = (await w.signIn(app)).body;
    const auth = { authorization: `Bearer ${tok.token}` };
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: auth, payload });
    const offer = (await app.inject({ method: 'GET', url: '/armoury', headers: auth })).json().offers.shotgun;
    expect(offer).toMatchObject({ listing: listed.listings[0].id, rate: 50 });
    expect((await post('/armoury/borrow', { item: 'shotgun', days: 3, listing: offer.listing })).statusCode).toBe(402);
    await lender.store.ledger(tok.account.id, 500, 'grant', 'test');
    const fee = lendFee('shotgun', 3, 50);
    expect(fee).toBeLessThan(loanFee('shotgun', 3));
    const got = (await post('/armoury/borrow', { item: 'shotgun', days: 3, listing: offer.listing })).json();
    expect(got.cash).toBe(500 - fee);
    expect(got.loans[0]).toMatchObject({ item: 'shotgun', fee, lender: expect.any(String) });
    const mine = await lender.get();
    expect(mine.cash).toBe(2000 - kitDef('shotgun').price + lenderCut(fee));
    expect(mine.listings[0]).toMatchObject({ status: 'lent' });
    expect(mine.offers.shotgun).toBeUndefined();
    expect((await lender.post('/armoury/unlist', { listing: offer.listing })).json().error).toMatch(/out on loan/);
    // returned: back on the lender's rack, and they can take it back
    await post('/armoury/return', { loan: got.loans[0].id });
    expect((await lender.get()).listings[0].status).toBe('open');
    const off = (await lender.post('/armoury/unlist', { listing: offer.listing })).json();
    expect(off.listings).toEqual([]);
    expect((await lender.post('/armoury/loadout', { ranked: { kit: ['shotgun'], ups: {} }, open: { kit: [], ups: {} } })).statusCode).toBe(200);
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

  it('a room takes the ranked loadout, without borrowed kit', async () => {
    const t = await setup();
    await t.store.ledger(t.id, 3000, 'grant', 'test');
    await t.post('/armoury/buy', { item: 'shotgun' });
    await t.post('/armoury/borrow', { item: 'vest' });
    await t.post('/armoury/loadout', { ranked: { kit: ['shotgun', 'vest'], ups: {}, hand: 'shotgun' }, open: { kit: [], ups: {} } });
    expect(await roomLoadout(t.store, t.id)).toEqual({ kit: ['shotgun'], ups: {}, hand: 'shotgun' });
    expect(await roomLoadout(t.store, 'nobody')).toBeUndefined();
  });

  it('caps what a day can earn', async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) await payForRound(t.store, t.id, `room${i}`, true, new Date());
    expect(await t.store.earnedSince(t.id, dayStart(new Date()))).toBe(DAILY_CAP);
  });
});
