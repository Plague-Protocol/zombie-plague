// The admin page's API. Who is an admin: a signed-in account (wallet-signed, see auth.ts) whose address is in
// ADMIN_ADDRESSES, or holds the admin role on any stake contract. Reads are cheap; the two actions are the ones an
// operator needs when something sticks (a room, a settlement). Pausing a contract and taking fees out are NOT here:
// those are on-chain admin acts, sent from the admin's own wallet straight to the contracts.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Auth } from './auth.ts';
import type { Chain, ChainLog } from './chain.ts';
import { accounts, type Funds } from './funds.ts';
import { SALE_SCOPES, type SaleScope } from '../../core/armoury.ts';
import type { Hub } from './rooms.ts';
import type { Staked } from './staked.ts';
import type { Store } from './store.ts';
import { RULES } from './rules.ts';

export interface AdminDeps {
  store: Store;
  auth: Auth;
  hub: Hub;
  staked?: Staked;
  chains: Record<string, Chain & Partial<ChainLog>>;
  /** The staked rooms' money, read from the chain (absent: staked rooms are off). */
  funds?: Funds;
  /** Armoury top-ups, if on: what they are paid in and how much cash a whole token buys. */
  topup?: { symbol: string; rate: number; treasury: string; decimals: number };
  /** Lower-case addresses always let in (works without any contract). */
  admins: string[];
  startedAt: number;
  db: 'postgres' | 'memory';
  content: () => number;
}

export function registerAdmin(app: FastifyInstance, d: AdminDeps): void {
  const cache = new Map<string, { ok: boolean; at: number }>();
  /** The asking account's address if it is an admin, else null. On-chain answers are kept a minute. */
  async function admin(req: FastifyRequest): Promise<string | null> {
    const id = await d.auth.accountOf(req.headers.authorization?.replace(/^Bearer /, ''));
    const acc = id ? await d.store.accountById(id) : null;
    if (!acc) return null;
    if (d.admins.includes(acc.address)) return acc.address;
    const hit = cache.get(acc.address);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok ? acc.address : null;
    let ok = false;
    for (const c of Object.values(d.chains)) { try { if (await c.isAdmin(acc.address)) { ok = true; break; } } catch { /* chain down: not proven */ } }
    cache.set(acc.address, { ok, at: Date.now() });
    return ok ? acc.address : null;
  }
  const big = (v: bigint) => v.toString();

  app.get('/admin/overview', async (req, reply) => {
    const who = await admin(req);
    if (!who) return reply.code(403).send({ error: 'not_admin' });
    const rooms = [...d.hub.rooms.values()];
    const stacks = await Promise.all(Object.entries(d.chains).map(async ([symbol, c]) => {
      try {
        const [st, gas] = await Promise.all([c.status(), c.gas()]);
        return { symbol, rooms: st.rooms, paused: st.paused, feeManager: st.feeManager, fees: big(st.fees), held: big(st.held), roomCount: big(st.roomCount), gas: big(gas) };
      } catch (e) { return { symbol, error: String((e as Error).message ?? e).slice(0, 200) }; }
    }));
    return {
      you: who,
      server: { uptimeS: Math.round((Date.now() - d.startedAt) / 1000), rssMb: Math.round(process.memoryUsage().rss / 1048576), db: d.db, content: d.content(), rules: RULES, node: process.version },
      players: await d.store.adminCounts(),
      rooms: rooms.map((r) => ({
        code: r.code, state: r.state, seats: r.seats.length, connected: r.live, stack: r.staked?.stack ?? null, onChain: r.staked?.roomId ?? null,
        elapsedS: r.game ? Math.round(r.game.elapsed) : 0,
      })),
      stacks,
      settlements: await d.store.settlementsAll(50),
      suspicious: await d.store.failedAccounts(7, 20),
    };
  });

  // The money: every staked room's stakes, payouts, refunds and fees, the totals, a check against what the contracts
  // hold, and the rooms that need someone. ?sync=1 reads the chain first (waiting up to 15 s).
  app.get('/admin/funds', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    const topups = { ...(await d.store.topups(30)), config: d.topup ?? null };
    if (!d.funds) return { on: false, stacks: [], topups };
    let syncing = false;
    if ((req.query as { sync?: string }).sync === '1') {
      syncing = await Promise.race([d.funds.syncAll().then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 15_000))]);
    }
    const settlements = new Map((await d.store.settlementsAll(100_000)).map((s) => [s.roomId, s]));
    const now = Math.floor(Date.now() / 1000);
    const stacks = await Promise.all(Object.entries(d.chains).map(async ([symbol, c]) => {
      const [events, cursor, reclaimAfter, onChain] = await Promise.all([
        d.store.fundEvents(symbol),
        d.store.fundCursor(symbol),
        c.reclaimAfter ? c.reclaimAfter().catch(() => 6 * 3600) : 6 * 3600,
        c.status().then((s) => ({ held: big(s.held), fees: big(s.fees) }), () => null),
      ]);
      const a = accounts(events, now, { reclaimAfter, settlements, stack: symbol });
      return {
        symbol, cursor, error: d.funds!.lastError(symbol), reclaimAfter, onChain, totals: a.totals,
        attention: a.rooms.filter((r) => r.issues.length),
        rooms: a.rooms.slice(0, 300),
      };
    }));
    return { on: true, syncing, stacks, topups };
  });

  // Promotions: bounties, prizes, deals and news across the site. A deal may pay extra ZP on top-ups while it runs.
  const cta = z.object({ label: z.string().trim().min(1).max(24), href: z.string().trim().regex(/^(\/[\w\-./?=&#%]*|https:\/\/[^\s"'<>]+)$/) }).nullable();
  const promoBody = z.object({
    kind: z.enum(['bounty', 'prize', 'deal', 'news', 'sale']),
    title: z.string().trim().min(3).max(80),
    body: z.string().trim().max(280).default(''),
    cta: cta.default(null),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date(),
    topupBonus: z.number().int().min(0).max(200).default(0),
    discount: z.number().int().min(0).max(90).default(0),
    scope: z.enum(SALE_SCOPES as [SaleScope, ...SaleScope[]]).default('all'),
  });
  /** What can be changed on one that exists (not its kind). */
  const promoPatch = z.object({
    title: z.string().trim().min(3).max(80).optional(),
    body: z.string().trim().max(280).optional(),
    cta: cta.optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    topupBonus: z.number().int().min(0).max(200).optional(),
    discount: z.number().int().min(0).max(90).optional(),
    scope: z.enum(SALE_SCOPES as [SaleScope, ...SaleScope[]]).optional(),
  });
  /** A promotion's money parts belong to its kind: a deal's top-up bonus, a sale's discount. */
  const misfit = (kind: string, p: { topupBonus?: number; discount?: number }): string | null =>
    p.topupBonus && kind !== 'deal' ? 'only a deal pays a top-up bonus'
      : p.discount && kind !== 'sale' ? 'only a sale takes money off'
      : kind === 'sale' && p.discount === 0 ? 'a sale needs a discount' : null;
  app.get('/admin/promos', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    return d.store.promos({ limit: 50 });
  });
  app.post('/admin/promos', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    const b = promoBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'bad promotion' });
    const startsAt = b.data.startsAt ?? new Date();
    if (b.data.endsAt.getTime() <= Math.max(startsAt.getTime(), Date.now())) return reply.code(400).send({ error: 'it has to end in the future, after it starts' });
    const bad = misfit(b.data.kind, b.data);
    if (bad) return reply.code(400).send({ error: bad });
    return d.store.addPromo({ ...b.data, startsAt });
  });
  app.post('/admin/promos/:id', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    const id = String((req.params as { id: string }).id);
    const b = promoPatch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'bad change' });
    const have = (await d.store.promos({ limit: 500 })).find((p) => p.id === id);
    if (!have) return reply.code(404).send({ error: 'no such promotion' });
    const next = { ...have, ...Object.fromEntries(Object.entries(b.data).filter(([, v]) => v !== undefined)) } as typeof have;
    if (next.endsAt.getTime() <= next.startsAt.getTime()) return reply.code(400).send({ error: 'it has to end after it starts' });
    const bad = misfit(have.kind, next);
    if (bad) return reply.code(400).send({ error: bad });
    return d.store.updatePromo(id, b.data);
  });
  app.post('/admin/promos/:id/end', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    return { ended: await d.store.endPromo(String((req.params as { id: string }).id)) };
  });

  // Give ZP to a player (testers, a bounty paid, a prize): by wallet address or name, written in the ledger once per `ref`.
  app.post('/admin/grant', async (req, reply) => {
    const who = await admin(req);
    if (!who) return reply.code(403).send({ error: 'not_admin' });
    const b = z.object({ to: z.string().trim().min(2).max(64), amount: z.number().int().min(1).max(100_000), note: z.string().trim().min(2).max(60) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'to, amount (1 to 100,000) and a note' });
    const acc = await d.store.accountByHandle(b.data.to);
    if (!acc) return reply.code(404).send({ error: 'no account with that address or name' });
    const ref = `${b.data.note} · by ${who.slice(0, 8)} · ${new Date().toISOString()}`;
    const r = await d.store.ledger(acc.id, b.data.amount, 'grant', ref.slice(0, 200));
    return { to: acc.name ?? acc.address, amount: b.data.amount, balance: r.cash };
  });

  // A room that is stuck (nobody left in it, a round that will not end): close it. Everyone in it is told.
  app.post('/admin/rooms/:code/close', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    const code = String((req.params as { code: string }).code);
    const room = d.hub.rooms.get(code) ?? d.hub.rooms.get(code.toUpperCase());
    if (!room) return reply.code(404).send({ error: 'no_room' });
    for (const s of room.seats) s.conn?.send({ t: 'err', code: 'no-room' });
    d.hub.remove(room);
    return { closed: room.code, note: room.staked ? 'A staked room that started is not settled by closing it: its players can reclaim after the window, or retry its settlement once it is recorded.' : undefined };
  });

  // Try a settlement again (one that failed, or is stuck as sent). The contract refuses a room already settled.
  app.post('/admin/settlements/:ref/retry', async (req, reply) => {
    if (!(await admin(req))) return reply.code(403).send({ error: 'not_admin' });
    if (!d.staked) return reply.code(409).send({ error: 'staked_off' });
    const ref = z.string().regex(/^[A-Za-z0-9]{1,8}:\d{1,18}$/).safeParse((req.params as { ref: string }).ref);
    if (!ref.success) return reply.code(400).send({ error: 'bad_ref' });
    const s = await d.store.settlement(ref.data);
    if (!s) return reply.code(404).send({ error: 'no_settlement' });
    if (s.status === 'done') return { status: 'done', tx: s.tx };
    await d.store.updateSettlement(ref.data, { status: 'sent', error: null });
    await d.staked.pay(ref.data);
    return await d.store.settlement(ref.data);
  });
}
