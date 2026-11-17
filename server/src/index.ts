import { Auth, makeSignatureChecker } from './auth.ts';
import { loadConfig } from './config.ts';
import { ContentRegistry } from './content.ts';
import { buildApp } from './http.ts';
import { ViemChain } from './chain.ts';
import { Hub } from './rooms.ts';
import { Staked } from './staked.ts';
import { registerAdmin } from './admin.ts';
import { payForRound } from './armoury.ts';
import { rpcReceipts } from './topup.ts';
import { MemoryStore, PgStore, type Store } from './store.ts';
import { attachWs } from './ws.ts';

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
const app = await buildApp({ store, auth, content, origins: cfg.origins, chain, stacks: Object.keys(chains), topup });
let staked: Staked | undefined;
const hub = new Hub({
  contentVersion: () => content.latest,
  onRound: (r) => {
    void staked?.onRound(r);
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
registerAdmin(app, { store, auth, hub, staked, chains, admins: cfg.admins, startedAt: Date.now(), db: cfg.DATABASE_URL ? 'postgres' : 'memory', content: () => content.latest });
await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
const closeWs = attachWs(app.server, { hub, auth, store, origins: cfg.origins, staked });
console.log(`outbreak server on :${cfg.PORT} (content v${content.latest}, ${cfg.DATABASE_URL ? 'postgres' : 'memory'})`);

const stop = async () => { staked?.stop(); closeWs(); hub.close(); await app.close(); await store.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
