// The armoury on the server: the bank of cash a player earns from verified nights and rounds, what they buy with it,
// what they borrow for a night, and the two loadouts they keep. The prices and rules are core/armoury.ts, the same
// ones the site shows. A run's loadout is checked against what the account owns (or has borrowed) before the run is
// replayed, and a ranked night's against the budget everyone shares.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DAILY_CAP, DAILY_RATION, earnedFor, EMPTY_LOADOUT, KIT, kitDef, LATE_DAYS, lateFee, LEND_RATES, lendFee, lenderCut, loadoutProblem, loanFee,
  MAX_GRIT, MAX_LOANS, ROUND_PAY, SURVIVORS, svLevel, svPrice, upgradable, upgradePrice, weaponsOf,
  type KitId, type LendRate, type LoanDays, type Loadout, type Owned, type SurvivorId, type UpId,
} from '../../core/armoury.ts';
import { UPGRADE_LEVELS } from '../../core/config.ts';
import type { WeaponKind, UpgradeKind } from '../../core/types.ts';
import { nightOf } from './content.ts';
import type { Auth } from './auth.ts';
import type { Bank, Listing, Loadouts, Loan, Store } from './store.ts';
import { minUnits, verifyTopup, type ReceiptReader, type TopupConfig } from './topup.ts';

const DAY = 864e5;
/** The start of the (UTC) day a moment is in: the daily cap and ration reset then. */
export const dayStart = (now: Date): Date => new Date(Math.floor(now.getTime() / DAY) * DAY);
/** A daily night (tonight's, or one of the last sixty): ranked, so the loadout budget applies. Practice nights are random. */
export function isDailyNight(night: number, now: Date): boolean {
  for (let k = 0; k <= 60; k++) if (nightOf(new Date(now.getTime() - k * DAY)) === night) return true;
  return false;
}

/** What an account owns and can carry: not what it has put up for others to borrow. */
export const usable = (bank: Bank, listings: readonly Listing[]): Owned =>
  ({ ...bank.owned, kit: bank.owned.kit.filter((k) => !listings.some((l) => l.item === k && l.status !== 'withdrawn')) });

/** Take items out of an account's saved loadouts (and what went with them: the weapon in hand, its upgrades). */
async function dropFromLoadouts(store: Store, accountId: string, items: readonly string[]): Promise<void> {
  const bank = await store.bank(accountId);
  if (!bank.loadouts) return;
  const drop = (x: Loadout): Loadout => {
    const kit = x.kit.filter((k) => !items.includes(k)), out: Loadout = { ...x, kit };
    const brings = weaponsOf(out);
    if (out.hand && !brings.includes(out.hand)) delete out.hand;
    out.ups = Object.fromEntries(Object.entries(x.ups).filter(([k]) => brings.includes(k.split('.')[0] as WeaponKind)));
    return out;
  };
  await store.setLoadouts(accountId, { ranked: drop(bank.loadouts.ranked), open: drop(bank.loadouts.open) });
}

/** End a loan: the item leaves the borrower's loadouts and, if a player lent it, goes back on their rack. */
async function endLoan(store: Store, loan: Loan & { accountId: string }, status: 'returned' | 'expired'): Promise<void> {
  if (!(await store.closeLoan(loan.id, status))) return;
  if (loan.listingId) await store.reopenListing(loan.listingId);
  const bank = await store.bank(loan.accountId);
  if (!bank.owned.kit.includes(loan.item as KitId)) await dropFromLoadouts(store, loan.accountId, [loan.item]);
}

/** A loan past its due time: a late fee for each day started (each taken once), and back by itself after the late days. */
async function settleLoan(store: Store, loan: Loan & { accountId: string }, now: Date): Promise<boolean> {
  const over = now.getTime() - loan.dueAt.getTime();
  if (over <= 0) return true;
  const days = Math.min(LATE_DAYS, Math.ceil(over / DAY));
  for (let k = 1; k <= days; k++) await store.ledger(loan.accountId, -lateFee(loan.item as KitId), 'late', `${loan.id}:${k}`, true);
  if (over < LATE_DAYS * DAY) return true;
  await endLoan(store, loan, 'expired');
  return false;
}

/** Bring an account's loans up to date (its own, and those of what it lent out), and return what it holds now. */
export async function settleLoans(store: Store, accountId: string, now: Date): Promise<Loan[]> {
  const held: Loan[] = [];
  for (const l of await store.loansActive(accountId)) if (await settleLoan(store, { ...l, accountId }, now)) held.push(l);
  for (const x of await store.listingsOf(accountId)) {
    if (x.status !== 'lent' || !x.loanId) continue;
    const l = await store.loanById(x.loanId);
    if (l?.status === 'active') await settleLoan(store, l, now);
  }
  return held;
}

/** Why a run's loadout cannot be carried (checked before its replay), or null. */
export async function loadoutRefusal(store: Store, accountId: string, night: number, l: unknown, now: Date): Promise<string | null> {
  if (l === undefined) return null;
  const loans = await settleLoans(store, accountId, now);
  const [bank, listings] = await Promise.all([store.bank(accountId), store.listingsOf(accountId)]);
  return loadoutProblem(l, usable(bank, listings), isDailyNight(night, now), loans.map((x) => x.item as KitId));
}

/** Pay for a verified night: its share of the score (within the daily cap) and the day's ration. (Loan fees are paid
 * when an item is borrowed; `fees` stays for older clients.) */
export async function payForRun(store: Store, accountId: string, runId: string, score: number, night: number, _loadout: Loadout | undefined, now: Date) {
  const ranked = isDailyNight(night, now);
  const day = dayStart(now);
  const left = Math.max(0, DAILY_CAP - await store.earnedSince(accountId, day));
  const earned = Math.min(left, earnedFor(score, ranked));
  if (earned > 0) await store.ledger(accountId, earned, 'run', runId);
  const ration = (await store.ledger(accountId, DAILY_RATION, 'ration', day.toISOString().slice(0, 10))).ok ? DAILY_RATION : 0;
  const cash = (await store.bank(accountId)).cash;
  return { earned, ration, fees: 0, cash, capped: earned < earnedFor(score, ranked) };
}

/**
 * What an account carries into a multiplayer room: its ranked loadout (so a room shares the same budget), with only
 * what it owns (borrowed kit is for a night, not a room). Anything that no longer checks out leaves it on the standard kit.
 */
export async function roomLoadout(store: Store, accountId: string): Promise<Loadout | undefined> {
  const [bank, listings] = await Promise.all([store.bank(accountId), store.listingsOf(accountId)]);
  const l = bank.loadouts?.ranked;
  if (!l) return undefined;
  const owned = usable(bank, listings);
  const kept: Loadout = { ...l, kit: l.kit.filter((k) => owned.kit.includes(k)) };
  const brings = weaponsOf(kept);
  kept.ups = Object.fromEntries(Object.entries(l.ups).filter(([k]) => brings.includes(k.split('.')[0] as WeaponKind)));
  if (kept.hand && !brings.includes(kept.hand)) delete kept.hand;
  return loadoutProblem(kept, owned, true) ? undefined : kept;
}

/** Pay a signed-in seat for a multiplayer round (within the daily cap). */
export async function payForRound(store: Store, accountId: string, ref: string, escaped: boolean, now: Date): Promise<void> {
  const left = Math.max(0, DAILY_CAP - await store.earnedSince(accountId, dayStart(now)));
  const pay = Math.min(left, ROUND_PAY.played + (escaped ? ROUND_PAY.escaped : 0));
  if (pay > 0) await store.ledger(accountId, pay, 'round', ref);
}

const upId = z.string().regex(/^(pistol|shotgun|rifle|baton|bat|machete)\.(damage|mag|reload)$/);
const kitId = z.enum(KIT.map((k) => k.id) as [KitId, ...KitId[]]);
const loadoutSchema = z.object({
  kit: z.array(kitId).max(KIT.length),
  ups: z.record(upId, z.number().int().min(0).max(UPGRADE_LEVELS)),
  hand: z.enum(['pistol', 'shotgun', 'rifle', 'baton', 'bat', 'machete']).optional(),
  survivor: z.enum(Object.keys(SURVIVORS) as [SurvivorId, ...SurvivorId[]]).optional(),
  grit: z.number().int().min(0).max(MAX_GRIT).optional(),
});
const svId = z.string().regex(new RegExp(`^sv\\.(${Object.keys(SURVIVORS).join('|')})$`));

export function registerArmoury(app: FastifyInstance, d: { store: Store; auth: Auth; now?: () => Date; topup?: { config: TopupConfig; read: ReceiptReader } }): void {
  const now = d.now ?? (() => new Date());
  const who = async (req: FastifyRequest) => d.auth.accountOf((req.headers.authorization ?? '').replace(/^Bearer /, '') || null);

  const shown = (a: { name: string | null; address: string } | null) => (a ? a.name || `${a.address.slice(0, 6)}…${a.address.slice(-4)}` : 'someone');

  /** The best top-up deal running now (its bonus in percent, and when it ends), or null. */
  async function dealNow(): Promise<{ bonus: number; endsAt: string; title: string } | null> {
    const live = (await d.store.promos({ liveAt: now(), limit: 20 })).filter((p) => p.kind === 'deal' && p.topupBonus > 0);
    const best = live.sort((a, b) => b.topupBonus - a.topupBonus)[0];
    return best ? { bonus: best.topupBonus, endsAt: best.endsAt.toISOString(), title: best.title } : null;
  }

  async function view(accountId: string) {
    const t = now();
    const loans = await settleLoans(d.store, accountId, t);
    const [bank, today, mine, open] = await Promise.all([d.store.bank(accountId), d.store.earnedSince(accountId, dayStart(t)), d.store.listingsOf(accountId), d.store.openListings()]);
    // what the site needs to send one, and whether this account's first top-up (paid double) is still to come
    const deal = d.topup ? await dealNow() : null;
    const topup = d.topup ? { ...d.topup.config, min: String(minUnits(d.topup.config)), firstBonus: !(await d.store.hasLedger(accountId, 'firsttopup')), deal } : null;
    const lenders = new Map<string, string>();
    for (const l of loans) if (l.lenderId && !lenders.has(l.lenderId)) lenders.set(l.lenderId, shown(await d.store.accountById(l.lenderId)));
    // the cheapest open offer from another player, per item
    const offers: Record<string, { listing: string; rate: number; lender: string }> = {};
    for (const x of open) {
      if (x.ownerId === accountId) continue;
      const cur = offers[x.item];
      if (!cur || x.rate < cur.rate) offers[x.item] = { listing: x.id, rate: x.rate, lender: x.ownerName || `${x.ownerAddress.slice(0, 6)}…${x.ownerAddress.slice(-4)}` };
    }
    const listings = await Promise.all(mine.map(async (x) => {
      const loan = x.status === 'lent' && x.loanId ? await d.store.loanById(x.loanId) : null;
      return { id: x.id, item: x.item, rate: x.rate, status: x.status, dueAt: loan?.dueAt ?? null, borrower: loan ? shown(await d.store.accountById(loan.accountId)) : null };
    }));
    return {
      cash: bank.cash, owned: bank.owned, loadouts: bank.loadouts ?? { ranked: EMPTY_LOADOUT, open: EMPTY_LOADOUT },
      loans: loans.map((l) => ({ id: l.id, item: l.item, fee: l.fee, createdAt: l.createdAt, dueAt: l.dueAt, lender: l.lenderId ? lenders.get(l.lenderId) ?? 'someone' : null, lateFee: lateFee(l.item as KitId), overdue: l.dueAt.getTime() < t.getTime() })),
      listings, offers, earnedToday: today, dailyCap: DAILY_CAP, tonight: nightOf(t), topup, now: t,
    };
  }

  app.get('/armoury', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    return view(id);
  });

  // buy a piece of kit, or the next level of an upgrade
  app.post('/armoury/buy', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ item: z.union([kitId, upId, svId]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'unknown item' });
    const item = body.data.item, bank = await d.store.bank(id);
    let level = 1, price: number;
    if (item.startsWith('sv.')) { // a survivor: unlock, then each perk level
      const sv = item.slice(3) as SurvivorId;
      level = svLevel(bank.owned, sv) + 1;
      if (level > MAX_GRIT + 1) return reply.code(409).send({ error: 'already at the top level' });
      price = svPrice(sv, level);
    } else if (item.includes('.')) {
      const [w, u] = item.split('.') as [WeaponKind, UpgradeKind];
      if (!upgradable(w).includes(u)) return reply.code(400).send({ error: 'that weapon does not take that upgrade' });
      level = (bank.owned.ups[item as UpId] ?? 0) + 1;
      if (level > UPGRADE_LEVELS) return reply.code(409).send({ error: 'already at the top level' });
      price = upgradePrice(w, u, level);
    } else {
      if (bank.owned.kit.includes(item as KitId)) return reply.code(409).send({ error: 'already yours' });
      price = kitDef(item as KitId).price;
    }
    if (bank.cash < price) return reply.code(402).send({ error: 'not enough ZP' });
    const ok = await d.store.purchase(id, item, level, price, `${item}:${level}`);
    if (!ok) return reply.code(402).send({ error: 'not enough ZP' });
    return view(id);
  });

  // borrow a piece of kit for a term, from the armoury or from a player's listing; the fee is paid now
  app.post('/armoury/borrow', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ item: kitId, days: z.union([z.literal(1), z.literal(3), z.literal(7)]).default(1), listing: z.string().max(64).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'unknown item' });
    const { item, listing } = body.data, days = body.data.days as LoanDays;
    const t = now();
    const loans = await settleLoans(d.store, id, t);
    const bank = await d.store.bank(id);
    if (bank.cash < 0) return reply.code(402).send({ error: 'pay off what you owe first' });
    if (bank.owned.kit.includes(item)) return reply.code(409).send({ error: 'already yours' });
    if (loans.some((l) => l.item === item)) return reply.code(409).send({ error: 'already borrowed' });
    if (loans.length >= MAX_LOANS) return reply.code(409).send({ error: `${MAX_LOANS} loans at a time: return one first` });
    const loanId = globalThis.crypto.randomUUID(), dueAt = new Date(t.getTime() + days * DAY);
    if (listing) {
      // from another player: paid from cash in hand (no debt), most of it to them
      const x = await d.store.listingById(listing);
      if (!x || x.status !== 'open' || x.item !== item) return reply.code(409).send({ error: 'that offer is gone' });
      if (x.ownerId === id) return reply.code(409).send({ error: 'that is your own' });
      const fee = lendFee(item, days, x.rate as LendRate);
      if (!(await d.store.takeListing(x.id, loanId))) return reply.code(409).send({ error: 'someone borrowed it first' });
      if (!(await d.store.ledger(id, -fee, 'borrow', loanId)).ok) { await d.store.reopenListing(x.id); return reply.code(402).send({ error: 'not enough ZP for that offer' }); }
      await d.store.ledger(x.ownerId, lenderCut(fee), 'lend', loanId);
      await d.store.addLoan({ id: loanId, accountId: id, item, fee, dueAt, lenderId: x.ownerId, listingId: x.id });
    } else {
      // from the armoury: may run into debt, which later nights pay back
      const fee = loanFee(item, days);
      await d.store.ledger(id, -fee, 'borrow', loanId, true);
      await d.store.addLoan({ id: loanId, accountId: id, item, fee, dueAt });
    }
    return view(id);
  });

  // give a borrowed item back before (or after) it is due: frees a loan place and stops late fees
  app.post('/armoury/return', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ loan: z.string().max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'which loan?' });
    await settleLoans(d.store, id, now());
    const loan = await d.store.loanById(body.data.loan);
    if (!loan || loan.accountId !== id || loan.status !== 'active') return reply.code(409).send({ error: 'that loan is already back' });
    await endLoan(d.store, loan, 'returned');
    return view(id);
  });

  // put an owned item up for others to borrow (it is off your loadouts while it is listed)
  app.post('/armoury/lend', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ item: kitId, rate: z.union([z.literal(100), z.literal(75), z.literal(50)]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'unknown item or rate' });
    const [bank, mine] = await Promise.all([d.store.bank(id), d.store.listingsOf(id)]);
    if (!bank.owned.kit.includes(body.data.item)) return reply.code(409).send({ error: 'only what you own can be lent' });
    if (mine.some((l) => l.item === body.data.item)) return reply.code(409).send({ error: 'already up for loan' });
    if (!(LEND_RATES as readonly number[]).includes(body.data.rate)) return reply.code(400).send({ error: 'unknown rate' });
    await d.store.addListing(id, body.data.item, body.data.rate);
    await dropFromLoadouts(d.store, id, [body.data.item]);
    return view(id);
  });

  // take a listed item back (only while nobody has it)
  app.post('/armoury/unlist', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ listing: z.string().max(64) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'which listing?' });
    await settleLoans(d.store, id, now());
    const x = await d.store.listingById(body.data.listing);
    if (!x || x.ownerId !== id) return reply.code(404).send({ error: 'not yours' });
    if (!(await d.store.withdrawListing(x.id))) return reply.code(409).send({ error: 'it is out on loan: it comes back when it is returned or due' });
    return view(id);
  });

  // buy cash with the stablecoin: the transaction is read from the chain, and counts once
  app.post('/armoury/topup', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    if (!d.topup) return reply.code(404).send({ error: 'top-ups are not open' });
    const body = z.object({ tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'not a transaction hash' });
    const acc = await d.store.accountById(id);
    if (!acc) return reply.code(401).send({ error: 'sign in' });
    const tx = body.data.tx.toLowerCase() as `0x${string}`;
    const v = await verifyTopup(d.topup.read, d.topup.config, acc.address, tx);
    if ('error' in v) return reply.code(400).send({ error: v.error });
    const r = await d.store.ledger(id, v.cash, 'topup', tx);
    if (!r.ok) return reply.code(409).send({ error: 'That transaction has already been counted.' });
    // the first top-up an account ever makes is paid double (once: the ledger's key is the account and 'first')
    let bonus = (await d.store.ledger(id, v.cash, 'firsttopup', 'first')).ok ? v.cash : 0;
    // and a deal running now pays its share on top (once per transaction)
    const deal = await dealNow();
    if (deal) { const extra = Math.floor((v.cash * deal.bonus) / 100); if (extra > 0 && (await d.store.ledger(id, extra, 'dealbonus', tx)).ok) bonus += extra; }
    return { ...(await view(id)), credited: v.cash + bonus, bonus };
  });

  // keep the two loadouts (the ranked one must fit the budget)
  app.post('/armoury/loadout', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ ranked: loadoutSchema, open: loadoutSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'not a loadout' });
    const loans = await settleLoans(d.store, id, now());
    const [bank, listings] = await Promise.all([d.store.bank(id), d.store.listingsOf(id)]);
    const borrowed = loans.map((l) => l.item as KitId), owned = usable(bank, listings);
    const l = body.data as Loadouts;
    const why = loadoutProblem(l.ranked, owned, true, borrowed) ?? loadoutProblem(l.open, owned, false, borrowed);
    if (why) return reply.code(400).send({ error: why });
    await d.store.setLoadouts(id, l);
    return view(id);
  });
}
