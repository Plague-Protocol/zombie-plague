// Staking from the page: approve, then create or join an on-chain room, with whatever wallet the page has (MiniPay, or
// any wallet that injects window.ethereum). Nothing here needs a library: the calls are four selectors and a few
// 32-byte words, and the wallet does the signing, the gas estimate and (in MiniPay) the choice of fee currency. Loaded
// only from the staked lobby.
import { account } from './account';

interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown>; isMiniPay?: boolean }
const eth = () => (window as unknown as { ethereum?: Eth }).ethereum;
const env = () => (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

/** One stake token and the PlagueRooms contract for it. USDm has 18 decimals, USDT 6. */
export interface StakeConfig { rooms: string; token: string; chainId: number; symbol: string; decimals: number }

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * The stake tokens this build knows, in the order offered. VITE_STAKE_STACKS is "SYMBOL:rooms:token:decimals,..."
 * (e.g. "USDm:0x..:0x..:18,USDT:0x..:0x..:6"); a build with only VITE_ROOMS_ADDRESS / VITE_STAKE_TOKEN has one.
 */
export function stakeConfigs(): StakeConfig[] {
  const e = env();
  const chainId = Number(e.VITE_CHAIN_ID ?? 42220);
  if (e.VITE_STAKE_STACKS) {
    return e.VITE_STAKE_STACKS.split(',').flatMap((x) => {
      const [symbol, rooms, token, dec] = x.trim().split(':');
      const decimals = Number(dec);
      return symbol && /^[A-Za-z0-9]{1,8}$/.test(symbol) && rooms && ADDR.test(rooms) && token && ADDR.test(token) && decimals >= 0 && decimals <= 18 ? [{ symbol, rooms, token, decimals, chainId }] : [];
    });
  }
  const rooms = e.VITE_ROOMS_ADDRESS, token = e.VITE_STAKE_TOKEN;
  if (!rooms || !token || !ADDR.test(rooms) || !ADDR.test(token)) return [];
  return [{ rooms, token, chainId, symbol: e.VITE_STAKE_SYMBOL ?? 'USDm', decimals: Number(e.VITE_STAKE_DECIMALS ?? 18) }];
}

/** Function selectors and the RoomCreated topic. Checked against the real ABI by server/test/stake.test.ts: a wrong one here would send a real transaction to the wrong function. */
export const SEL = {
  createRoom: '0x097f1288', joinRoom: '0x9cfc4b45', startGame: '0xe5ed1d59', cancelRoom: '0x2d172edf', leaveRoom: '0x779db573', getRoom: '0x6d8a74cb', approve: '0x095ea7b3', allowance: '0xdd62ed3e',
  pause: '0x8456cb59', unpause: '0x3f4ba83a', withdrawAll: '0xfa09e630',
} as const;
export const ROOM_CREATED = '0xcff39d5f5e68c5ec23a0132dffcc54cd414ff88b613bb83083ca99da9e14fcc5';

const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '').toLowerCase()).padStart(64, '0');

/** "0.05" in a token with `decimals` decimals, as a bigint; throws on anything that is not a plain positive amount it can hold exactly. */
export function parseAmount(text: string, decimals = 18): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,18}))?$/.exec(text.trim());
  if (!m) throw new Error('Enter an amount like 0.05.');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places.`);
  const v = BigInt(m[1]!) * 10n ** BigInt(decimals) + (decimals ? BigInt(frac.padEnd(decimals, '0')) : 0n);
  if (v <= 0n) throw new Error('Enter an amount above zero.');
  return v;
}
export const formatAmount = (v: bigint, decimals = 18): string => {
  if (!decimals) return v.toString();
  const s = v.toString().padStart(decimals + 1, '0');
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`.replace(/0+$/, '').replace(/\.$/, '');
};

async function from(): Promise<string> {
  const e = eth();
  if (!e) throw new Error('No wallet found.');
  const acc = account();
  const [a] = (await e.request({ method: 'eth_requestAccounts' })) as string[];
  if (!a) throw new Error('The wallet gave no address.');
  if (acc && acc.address.toLowerCase() !== a.toLowerCase()) throw new Error('The wallet is not the account you signed in with.');
  return a;
}

async function ensureChain(cfg: StakeConfig): Promise<void> {
  const e = eth()!;
  const now = Number(BigInt((await e.request({ method: 'eth_chainId' })) as string));
  if (now === cfg.chainId) return;
  if (e.isMiniPay) throw new Error('MiniPay is on a different network than this build.');
  try { await e.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${cfg.chainId.toString(16)}` }] }); }
  catch { throw new Error(`Switch your wallet to chain ${cfg.chainId}.`); }
}

/** Send a transaction and wait for it to be mined; resolves with the receipt, throws if it failed. */
async function send(to: string, data: string, who: string): Promise<{ logs: Array<{ address: string; topics: string[] }> }> {
  const e = eth()!;
  // no gas and no fee currency: the wallet estimates, and MiniPay picks the stablecoin it charges the fee in
  const hash = (await e.request({ method: 'eth_sendTransaction', params: [{ from: who, to, data }] })) as string;
  for (let i = 0; i < 80; i++) {
    const rc = (await e.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as { status: string; logs: Array<{ address: string; topics: string[] }> } | null;
    if (rc) { if (rc.status !== '0x1') throw new Error('The transaction failed.'); return rc; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('The transaction is taking too long. Check your wallet.');
}

const call = async (to: string, data: string): Promise<string> => (await eth()!.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as string;

/** Make sure the contract may take `amount` of the stake token, approving exactly that if it may not. */
async function allow(cfg: StakeConfig, who: string, amount: bigint): Promise<void> {
  const have = BigInt(await call(cfg.token, SEL.allowance + word(who) + word(cfg.rooms)));
  if (have >= amount) return;
  await send(cfg.token, SEL.approve + word(cfg.rooms) + word(amount), who);
}

export interface Waiting { host: string; status: number; maxPlayers: number; stake: bigint; players: string[] }
/** The chain's view of a room. */
export async function readRoom(cfg: StakeConfig, id: bigint): Promise<Waiting> {
  const hex = (await call(cfg.rooms, SEL.getRoom + word(id))).slice(2);
  const w = (i: number) => hex.slice(i * 64, i * 64 + 64);
  const off = Number(BigInt('0x' + w(8))) / 32;
  const n = Number(BigInt('0x' + w(off)));
  const players = Array.from({ length: n }, (_, i) => '0x' + w(off + 1 + i).slice(24));
  return { host: '0x' + w(0).slice(24), status: Number(BigInt('0x' + w(1))), maxPlayers: Number(BigInt('0x' + w(2))), stake: BigInt('0x' + w(3)), players };
}

/** Open a room and stake in it as its first player. Resolves with the on-chain room id. */
export async function createStaked(cfg: StakeConfig, maxPlayers: number, stake: bigint): Promise<bigint> {
  const who = await from();
  await ensureChain(cfg);
  await allow(cfg, who, stake);
  const rc = await send(cfg.rooms, SEL.createRoom + word(BigInt(maxPlayers)) + word(stake) + word(BigInt(15 * 60)), who);
  const log = rc.logs.find((l) => l.address.toLowerCase() === cfg.rooms.toLowerCase() && l.topics[0] === ROOM_CREATED);
  if (!log?.topics[1]) throw new Error('The room was made but its number was not found. Check your wallet.');
  return BigInt(log.topics[1]);
}

/** Stake in a waiting room. The amount is whatever the room asks: it is read from the chain, never typed. */
export async function joinStaked(cfg: StakeConfig, id: bigint): Promise<Waiting> {
  const who = await from();
  await ensureChain(cfg);
  let r = await readRoom(cfg, id);
  // a node a block behind has not heard of a room made a moment ago: look again for a few seconds before saying it is not there
  for (let i = 0; i < 8 && r.status === 0; i++) { await new Promise((z) => setTimeout(z, 1000)); r = await readRoom(cfg, id); }
  if (r.status !== 1) throw new Error('That room is not waiting for players.');
  if (r.players.includes(who.toLowerCase())) return r;
  await allow(cfg, who, r.stake);
  await send(cfg.rooms, SEL.joinRoom + word(id), who);
  return r;
}

/** The host closes the doors. The server sees it on the chain and starts the round. */
export async function startStaked(cfg: StakeConfig, id: bigint): Promise<void> {
  const who = await from();
  await ensureChain(cfg);
  await send(cfg.rooms, SEL.startGame + word(id), who);
}

/** Take your stake back from a room that has not started. */
export async function leaveStaked(cfg: StakeConfig, id: bigint): Promise<void> {
  const who = await from();
  await ensureChain(cfg);
  await send(cfg.rooms, SEL.leaveRoom + word(id), who);
}

/** The host closes a room that has not started; everyone is refunded. */
export async function cancelStaked(cfg: StakeConfig, id: bigint): Promise<void> {
  const who = await from();
  await ensureChain(cfg);
  await send(cfg.rooms, SEL.cancelRoom + word(id), who);
}

/** An admin act on a contract (pause, unpause, take the fees): sent from the connected wallet, which must hold the role. */
export async function adminTx(cfg: Pick<StakeConfig, 'chainId'>, to: string, call: 'pause' | 'unpause' | 'withdrawAll', arg?: string): Promise<void> {
  const who = await from();
  await ensureChain(cfg as StakeConfig);
  await send(to, SEL[call] + (arg ? word(arg) : ''), who);
}
