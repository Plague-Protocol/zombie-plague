import { Auth, makeSignatureChecker } from './auth.ts';
import { loadConfig } from './config.ts';
import { ContentRegistry } from './content.ts';
import { buildApp } from './http.ts';
import { ViemChain } from './chain.ts';
import { Hub } from './rooms.ts';
import { Staked } from './staked.ts';
import type { Eligibility } from '../../core/protocol.ts';
import { registerAdmin } from './admin.ts';
import { Funds } from './funds.ts';
import { ZpBank } from './zp.ts';
import { payForRound } from './armoury.ts';
import { rpcReceipts } from './topup.ts';
import { MemoryStore, PgStore, type Store } from './store.ts';
import { attachWs } from './ws.ts';
import { Presence } from './presence.ts';

const cfg = loadConfig();
const content = ContentRegistry.fromDir(cfg.CONTENT_DIR);
const store: Store = cfg.DATABASE_URL ? await PgStore.connect(cfg.DATABASE_URL) : new MemoryStore();
if (!cfg.DATABASE_URL) console.warn('DATABASE_URL is not set: accounts and runs are kept in memory and lost on restart');
const auth = new Auth(cfg.JWT_SECRET, makeSignatureChecker(cfg.CELO_RPC));
const chains: Record<string, ViemChain> = {};
if (cfg.STAKED) for (const st of cfg.stacks) chains[st.symbol] = new ViemChain({ rpc: cfg.CELO_RPC!, chainId: cfg.CHAIN_ID, rooms: st.rooms, key: cfg.BACKEND_KEY! });
const chain = Object.values(chains)[0] ?? null; // the same backend key settles every contract: one balance to watch
const topup = cfg.TOPUP_TOKEN && cfg.TOPUP_TREASURY && cfg.CELO_RPC ? {
  config: { token: cfg.TOPUP_TOKEN, treasury: cfg.TOPUP_TREASURY, decimals: cfg.TOPUP_DECIMALS, rate: cfg.TOPUP_RATE, symbol: cfg.TOPUP_SYMBOL, chainId: cfg.CHAIN_ID },
  read: rpcReceipts(cfg.CELO_RPC),
} : undefined;
const presence = new Presence(store); // who is about: the API's calls and heartbeats, and the rooms' connections
const app = await buildApp({ store, auth, content, origins: cfg.origins, chain, stacks: Object.keys(chains), topup, presence });
let staked: Staked | undefined;
// ZP rooms: stakes in the game currency, held in the ledger; any cut short by the last restart go back first
const zp = new ZpBank(store);
await zp.recover();
const hub = new Hub({
  contentVersion: () => content.latest,
  onZpRefund: (accountId, ref, amount) => { zp.refund(accountId, ref, amount).catch((e) => console.error('zp refund failed', e)); },
  onRound: (r) => {
    void staked?.onRound(r);
    if (r.zp) zp.settle(r.zp.uid, r.zp.stake, r.zp.seats).catch((e) => console.error('zp settle failed (refunded on the next start)', e));
    // the rooms leaderboard: each signed-in seat's part in the round
    const rows = r.placements.flatMap((p) => { const id = r.seats[p.seat]?.accountId; return id ? [{ accountId: id, code: r.code, status: p.status, kills: p.kills, escaped: p.status === 'escaped' }] : []; });
    if (rows.length) store.addRoundSeats(rows).catch((e) => console.error('round not recorded', e));
    // and what they earned: a little for taking part, more for getting out (within the daily cap)
    for (const x of rows) payForRound(store, x.accountId, `${x.code}:${r.seats.findIndex((s) => s?.accountId === x.accountId)}:${Date.now()}`, x.escaped, new Date()).catch((e) => console.error('round not paid', e));
  },
});
if (chain) {
  staked = new Staked({ chains, store, hub, minAgeMs: cfg.STAKED_MIN_ACCOUNT_HOURS * 3600e3, minOkRuns: cfg.STAKED_MIN_OK_RUNS });
  const owed = await staked.resume();
  if (owed) console.log(`[staked] resumed ${owed} unsettled room(s)`);
  staked.start();
  setInterval(() => { void staked!.resume(); }, 60_000).unref();
}
app.get('/rooms/live', async () => hub.live()); // the Play page: is anyone about?
// before any money moves: may this player sit in a staked room, and if not, what is missing and when it clears
app.get('/staked/eligible', async (req): Promise<Eligibility> => {
  if (!staked) return { ok: false, why: 'off' };
  return staked.check(await auth.accountOf(req.headers.authorization?.replace(/^Bearer /, '')));
});
// the money in staked rooms, read from the contracts' events into the store (the admin page's Funds section)
const funds = Object.keys(chains).length ? new Funds({ logs: chains, store, fromBlock: cfg.fromBlock }) : undefined;
if (funds) { void funds.syncAll(); setInterval(() => { void funds.syncAll(); }, 120_000).unref(); }
registerAdmin(app, { store, auth, hub, staked, chains, funds, topup: topup && { symbol: topup.config.symbol, rate: topup.config.rate, treasury: topup.config.treasury, decimals: topup.config.decimals }, admins: cfg.admins, startedAt: Date.now(), db: cfg.DATABASE_URL ? 'postgres' : 'memory', content: () => content.latest });
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
const closeWs = attachWs(app.server, { hub, auth, store, origins: cfg.origins, staked, zp, presence });
console.log(`outbreak server on :${cfg.PORT} (content v${content.latest}, ${cfg.DATABASE_URL ? 'postgres' : 'memory'})`);

const stop = async () => { staked?.stop(); closeWs(); hub.close(); await app.close(); await store.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
