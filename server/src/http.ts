import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from './auth.ts';
import { nightOf, type ContentRegistry } from './content.ts';
import { BOARD_KINDS, buildBoard, type BoardKind } from './boards.ts';
import { Limiter } from './limiter.ts';
import { submit, type Claim } from './runs.ts';
import { RULES } from './rules.ts';
import { registerArmoury } from './armoury.ts';
import type { Store } from './store.ts';

export interface Deps {
  /** Set when staked rooms are on: /health then says whether the backend key can still pay for gas. */
  chain?: import('./chain.ts').Chain | null;
  /** The stake tokens with a contract (USDm, USDT): the page offers only these. */
  stacks?: string[];
  store: Store;
  auth: Auth;
  content: ContentRegistry;
  origins: string[];
  now?: () => Date;
  /** Set when armoury top-ups in a stablecoin are on: the token and treasury, and how receipts are read. */
  topup?: { config: import('./topup.ts').TopupConfig; read: import('./topup.ts').ReceiptReader };
}

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const claim = z.object({
  seed: z.number().int(),
  chapter: z.number().int().min(0).max(2),
  outcome: z.enum(['won', 'lost']),
  lossReason: z.enum(['time', 'caught', 'infected', 'carrier']).nullable(),
  secondsLeft: z.number().finite(),
  replay: z.any(), // checked by the replay itself: its shape is the game's, not ours
});

/** The API: sign-in, who you are, your last selves, runs, the leaderboard. */
export async function buildApp(d: Deps): Promise<FastifyInstance> {
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024, logger: false });
  await app.register(cors, { origin: d.origins, methods: ['GET', 'POST'] });
  const now = d.now ?? (() => new Date());
  const authLimit = new Limiter(10, 20), runLimit = new Limiter(6, 12);
  let queue: Promise<unknown> = Promise.resolve(); // replays run one at a time: each is a few hundred ms of CPU
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const r = queue.then(f, f); queue = r.catch(() => undefined); return r; };

  const who = async (req: FastifyRequest): Promise<string | null> => d.auth.accountOf(req.headers.authorization?.replace(/^Bearer /, ''));
  const ip = (req: FastifyRequest) => req.ip;

  app.get('/health', async (_req, reply) => {
    if (!d.chain) return { ok: true, staked: false, rules: RULES };
    // the backend key holds only gas: under 0.5 CELO it cannot be trusted to settle, so say so loudly
    try {
      const wei = await d.chain.gas();
      const low = wei < 5n * 10n ** 17n;
      if (low) reply.code(503);
      return { ok: !low, staked: true, stacks: d.stacks ?? [], gasCelo: Number(wei / 10n ** 14n) / 1e4, low, rules: RULES };
    } catch { reply.code(503); return { ok: false, staked: true, error: 'chain' }; }
  });

  // the promotions running now (bounties, prizes, deals, news), for the banner across the site
  app.get('/promos', async () => {
    const live = await d.store.promos({ liveAt: now(), limit: 5 });
    return live.map((p) => ({ id: p.id, kind: p.kind, title: p.title, body: p.body, cta: p.cta, endsAt: p.endsAt.toISOString(), topupBonus: p.topupBonus, discount: p.discount, scope: p.scope }));
  });

  app.get('/night/today', async () => ({ night: nightOf(now()), content: d.content.latest }));

  app.post('/auth/nonce', async (req, reply) => {
    const body = z.object({ address }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad address' });
    if (!authLimit.take(ip(req))) return reply.code(429).send({ error: 'slow down' });
    return { nonce: d.auth.nonce(body.data.address) };
  });

  app.post('/auth/verify', async (req, reply) => {
    const body = z.object({ address, signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(8192) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad request' });
    if (!authLimit.take(ip(req))) return reply.code(429).send({ error: 'slow down' });
    const token = await d.auth.verify(body.data.address, body.data.signature, async (a) => (await d.store.upsertAccount(a)).id);
    if (!token) return reply.code(401).send({ error: 'signature does not match' });
    const acc = await d.store.upsertAccount(body.data.address);
    return { token, account: { id: acc.id, address: acc.address, name: acc.name } };
  });

  app.get('/me', async (req, reply) => {
    const id = await who(req);
    const acc = id ? await d.store.accountById(id) : null;
    if (!acc) return reply.code(401).send({ error: 'sign in' });
    const stats = await d.store.runStats(acc.id);
    return { account: { id: acc.id, address: acc.address, name: acc.name, createdAt: acc.createdAt }, okRuns: stats.okRuns, runs: await d.store.recentRuns(acc.id, 10) };
  });

  app.post('/me', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const body = z.object({ name: z.string().trim().min(1).max(20).regex(/^[\p{L}\p{N} _.'-]+$/u) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad name' });
    const name = body.data.name.replace(/\s+/g, ' ');
    if (!(await d.store.setName(id, name))) return reply.code(409).send({ error: 'taken' });
    return { ok: true, name };
  });

  app.get('/last-self', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    const q = z.object({ chapter: z.coerce.number().int().min(0).max(2) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad chapter' });
    const s = await d.store.lastSelf(id, q.data.chapter);
    return { husk: s ? { pos: { x: s.x, y: s.y }, weapon: s.weapon } : null };
  });

  app.post('/runs', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'sign in' });
    if (!runLimit.take(id)) return reply.code(429).send({ error: 'slow down' });
    const body = z.object({ result: claim }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad run' });
    const res = await serial(() => submit(d.store, d.content, id, body.data.result as Claim));
    return res;
  });

  // ?board=night|week|streak|rooms (default night), ?night= to look at another night. Signed in, the answer also says
  // where you stand and how far it is to the next place.
  app.get('/leaderboard', async (req, reply) => {
    const q = z.object({ board: z.enum(BOARD_KINDS as [BoardKind, ...BoardKind[]]).default('night'), night: z.coerce.number().int().min(0).max(2 ** 32 - 1).optional() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad query' });
    return buildBoard(d.store, q.data.board, now(), await who(req), q.data.night);
  });

  registerArmoury(app, { store: d.store, auth: d.auth, topup: d.topup, now });
  return app;
}
