// The armoury on the server: the bank of cash a player earns from verified nights and rounds, what they buy with it,
// what they borrow for a night, and the two loadouts they keep. The prices and rules are core/armoury.ts, the same
// ones the site shows. A run's loadout is checked against what the account owns (or has borrowed) before the run is
// replayed, and a ranked night's against the budget everyone shares.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DAILY_CAP, DAILY_RATION, earnedFor, EMPTY_LOADOUT, KIT, kitDef, loadoutProblem, loanFee, ROUND_PAY, upgradable, upgradePrice,
  type KitId, type Loadout, type UpId,
} from '../../core/armoury.ts';
import { UPGRADE_LEVELS } from '../../core/config.ts';
import type { WeaponKind, UpgradeKind } from '../../core/types.ts';
import { nightOf } from './content.ts';
import type { Auth } from './auth.ts';
import type { Loadouts, Store } from './store.ts';

const DAY = 864e5;
/** The start of the (UTC) day a moment is in: the daily cap and ration reset then. */
export const dayStart = (now: Date): Date => new Date(Math.floor(now.getTime() / DAY) * DAY);
/** A daily night (tonight's, or one of the last sixty): ranked, so the loadout budget applies. Practice nights are random. */
export function isDailyNight(night: number, now: Date): boolean {
  for (let k = 0; k <= 60; k++) if (nightOf(new Date(now.getTime() - k * DAY)) === night) return true;
  return false;
}

/** Why a run's loadout cannot be carried (checked before its replay), or null. */
export async function loadoutRefusal(store: Store, accountId: string, night: number, l: unknown, now: Date): Promise<string | null> {
  if (l === undefined) return null;
  const [bank, loans] = await Promise.all([store.bank(accountId), store.loansActive(accountId)]);
  return loadoutProblem(l, bank.owned, isDailyNight(night, now), loans.map((x) => x.item as KitId));
}

/** Pay for a verified night: its share of the score (within the daily cap), the day's ration, and any loan fees it owes. */
export async function payForRun(store: Store, accountId: string, runId: string, score: number, night: number, loadout: Loadout | undefined, now: Date) {
  const ranked = isDailyNight(night, now);
  const day = dayStart(now);
  const left = Math.max(0, DAILY_CAP - await store.earnedSince(accountId, day));
  const earned = Math.min(left, earnedFor(score, ranked));
  if (earned > 0) await store.ledger(accountId, earned, 'run', runId);
  const ration = (await store.ledger(accountId, DAILY_RATION, 'ration', day.toISOString().slice(0, 10))).ok ? DAILY_RATION : 0;
  // borrowed items this night carried: their fees are due now (a debt if the bank cannot cover them)
  let fees = 0;
  if (loadout) {
    const bank = await store.bank(accountId);
    for (const loan of await store.loansActive(accountId)) {
      if (!loadout.kit.includes(loan.item as KitId) || bank.owned.kit.includes(loan.item as KitId)) continue;
      await store.ledger(accountId, -loan.fee, 'loan', loan.id, true);
      await store.closeLoan(loan.id, 'used');
      fees += loan.fee;
      // the item goes back: take it out of the loadouts that held it
      if (bank.loadouts) {
        const drop = (x: Loadout): Loadout => ({ ...x, kit: x.kit.filter((k) => k !== loan.item), hand: x.hand === loan.item ? undefined : x.hand });
        await store.setLoadouts(accountId, { ranked: drop(bank.loadouts.ranked), open: drop(bank.loadouts.open) });
        bank.loadouts = { ranked: drop(bank.loadouts.ranked), open: drop(bank.loadouts.open) };
      }
    }
  }
  const cash = (await store.bank(accountId)).cash;
  return { earned, ration, fees, cash, capped: earned < earnedFor(score, ranked) };
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
});

export function registerArmoury(app: FastifyInstance, d: { store: Store; auth: Auth; now?: () => Date }): void {
  const now = d.now ?? (() => new Date());
  const who = async (req: FastifyRequest) => d.auth.accountOf((req.headers.authorization ?? '').replace(/^Bearer /, '') || null);

  async function view(accountId: string) {
    const t = now();
    const [bank, loans, today] = await Promise.all([d.store.bank(accountId), d.store.loansActive(accountId), d.store.earnedSince(accountId, dayStart(t))]);
    return { cash: bank.cash, owned: bank.owned, loadouts: bank.loadouts ?? { ranked: EMPTY_LOADOUT, open: EMPTY_LOADOUT }, loans, earnedToday: today, dailyCap: DAILY_CAP, tonight: nightOf(t) };
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
    const body = z.object({ item: z.union([kitId, upId]) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'unknown item' });
    const item = body.data.item, bank = await d.store.bank(id);
    let level = 1, price: number;
    if (item.includes('.')) {
      const [w, u] = item.split('.') as [WeaponKind, UpgradeKind];
      if (!upgradable(w).includes(u)) return reply.code(400).send({ error: 'that weapon does not take that upgrade' });
      level = (bank.owned.ups[item as UpId] ?? 0) + 1;
      if (level > UPGRADE_LEVELS) return reply.code(409).send({ error: 'already at the top level' });
      price = upgradePrice(w, u, level);
    } else {
      if (bank.owned.kit.includes(item as KitId)) return reply.code(409).send({ error: 'already yours' });
      price = kitDef(item as KitId).price;
    }
    if (bank.cash < price) return reply.code(402).send({ error: 'not enough cash' });
    const ok = await d.store.purchase(id, item, level, price, `${item}:${level}`);
    if (!ok) return reply.code(402).send({ error: 'not enough cash' });
    return view(id);
  });

  // borrow a piece of kit for one night: its fee is paid from what that night earns
  app.post('/armoury/borrow', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ item: kitId }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'unknown item' });
    const [bank, loans] = await Promise.all([d.store.bank(id), d.store.loansActive(id)]);
    if (bank.cash < 0) return reply.code(402).send({ error: 'pay off what you owe first' });
    if (bank.owned.kit.includes(body.data.item)) return reply.code(409).send({ error: 'already yours' });
    if (loans.some((l) => l.item === body.data.item)) return reply.code(409).send({ error: 'already borrowed' });
    if (loans.length >= 3) return reply.code(409).send({ error: 'three loans at a time' });
    await d.store.addLoan(id, body.data.item, loanFee(body.data.item));
    return view(id);
  });

  // keep the two loadouts (the ranked one must fit the budget)
  app.post('/armoury/loadout', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ ranked: loadoutSchema, open: loadoutSchema }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'not a loadout' });
    const [bank, loans] = await Promise.all([d.store.bank(id), d.store.loansActive(id)]);
    const borrowed = loans.map((l) => l.item as KitId);
    const l = body.data as Loadouts;
    const why = loadoutProblem(l.ranked, bank.owned, true, borrowed) ?? loadoutProblem(l.open, bank.owned, false, borrowed);
    if (why) return reply.code(400).send({ error: why });
    await d.store.setLoadouts(id, l);
    return view(id);
  });
}
