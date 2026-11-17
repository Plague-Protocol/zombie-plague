// The page's own staking code (src/net/stake.ts) against the real contracts, with a stand-in wallet that signs with a
// test key: proves the calldata the browser builds really creates, joins and starts a room, and that the server then
// seats the same wallets from the chain. Needs a stack with a MINTABLE token (see sepolia-acceptance.mts).
//
//   RPC=... PROXY=0x... TOKEN=0x... BACKEND_KEY=0x... npx tsx tools/sepolia-client-check.mts
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, parseUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ContentRegistry } from '../src/content.ts';
import { ViemChain } from '../src/chain.ts';
import { Hub } from '../src/rooms.ts';
import { Staked } from '../src/staked.ts';
import { MemoryStore } from '../src/store.ts';
import { createStaked, joinStaked, parseAmount, readRoom, startStaked, leaveStaked, cancelStaked, type StakeConfig } from '../../src/net/stake.ts';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const SYM = process.env.SYM ?? 'USDm';
const RPC = env('RPC'), PROXY = env('PROXY') as Hex, TOKEN = env('TOKEN') as Hex, KEY = env('BACKEND_KEY') as Hex;
const chain = defineChain({ id: 11142220, name: 'celo-sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const backend = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http(RPC) });
const DEC = Number(process.env.DEC ?? 18); // 6 for a USDT-like stack
const ONE = parseUnits('1', DEC);
const cfg: StakeConfig = { rooms: PROXY, token: TOKEN, chainId: 11142220, symbol: SYM, decimals: DEC };
const erc = parseAbi(['function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)']);
const assert = (c: boolean, m: string) => { if (!c) throw new Error('CHECK FAILED: ' + m); console.log('  ok:', m); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** window.ethereum, backed by a key. Only what the page asks for. */
function injected(key: Hex) {
  const w = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) });
  const address = w.account.address;
  const request = async ({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> => {
    switch (method) {
      case 'eth_requestAccounts': return [address];
      case 'eth_chainId': return '0xaa044c';
      case 'eth_call': { const [tx] = params as [{ to: Hex; data: Hex }]; return (await pub.call({ to: tx.to, data: tx.data })).data ?? '0x'; }
      case 'eth_sendTransaction': { const [tx] = params as [{ to: Hex; data: Hex }]; return w.sendTransaction({ to: tx.to, data: tx.data }); }
      case 'eth_getTransactionReceipt': {
        try { const r = await pub.getTransactionReceipt({ hash: params[0] as Hex }); return { status: r.status === 'success' ? '0x1' : '0x0', logs: r.logs.map((l) => ({ address: l.address, topics: l.topics })) }; }
        catch { return null; }
      }
      default: throw new Error('unsupported ' + method);
    }
  };
  (globalThis as unknown as { window: unknown }).window = { ethereum: { request } };
  return address;
}

const keys = [generatePrivateKey(), generatePrivateKey()];
const addrs = keys.map((k) => privateKeyToAccount(k).address);
for (const a of addrs) {
  await pub.waitForTransactionReceipt({ hash: await backend.sendTransaction({ to: a, value: parseEther('0.05') }) });
  await pub.waitForTransactionReceipt({ hash: await backend.writeContract({ address: TOKEN, abi: erc, functionName: 'mint', args: [a, ONE] }) });
}
const STAKE = '0.05';
console.log('\n== the page creates a room (approve + createRoom), a second wallet joins from the room number');
injected(keys[0]!);
const id = await createStaked(cfg, 3, parseAmount(STAKE, DEC));
console.log('  room', String(id));
let r = await readRoom(cfg, id);
for (let i = 0; i < 15 && r.players.length < 1; i++) { await sleep(1000); r = await readRoom(cfg, id); }
assert(r.status === 1 && r.maxPlayers === 3 && r.stake === parseAmount(STAKE, DEC) && r.host.toLowerCase() === addrs[0]!.toLowerCase(), 'room is waiting, 3 seats, the stake and host are as typed');
injected(keys[1]!);
await joinStaked(cfg, id);
for (let i = 0; i < 15 && r.players.length < 2; i++) { await sleep(1000); r = await readRoom(cfg, id); }
assert(r.players.length === 2, 'the second wallet staked the amount the ROOM asks (read from the chain), not one it typed');

console.log('\n== the server seats both from the chain, the host starts it on chain, the server plays it');
ContentRegistry.fromDir(new URL('../../public/content', import.meta.url).pathname);
const store = new MemoryStore();
const hub = new Hub({ contentVersion: () => 1 });
const staked = new Staked({ chains: { [SYM]: new ViemChain({ rpc: RPC, chainId: 11142220, rooms: PROXY, key: KEY }) }, store, hub, minAgeMs: 0, minOkRuns: 0, log: () => {} });
const seats = [];
for (const a of addrs) {
  const acc = await store.upsertAccount(a);
  const c = { id: a, name: a.slice(0, 6), accountId: acc.id, address: acc.address, room: null, send: () => {} };
  let res = await staked.seat(c, SYM, String(id));
  for (let i = 0; i < 10 && res !== 'ok'; i++) { await sleep(1000); res = await staked.seat(c, SYM, String(id)); }
  assert(res === 'ok', `${a.slice(0, 8)} is seated`);
  seats.push(c);
}
injected(keys[0]!);
await startStaked(cfg, id);
const room = hub.rooms.get(`S-${SYM}-${id}`)!;
for (let i = 0; i < 20 && room.state !== 'playing'; i++) { await staked.poll(); if (room.state !== 'playing') await sleep(1000); }
assert(room.state === 'playing', 'started by the host on chain; the server noticed and began');
hub.close(); staked.stop();

console.log('\n== leaving and cancelling hand the stake back');
injected(keys[0]!);
const id2 = await createStaked(cfg, 2, parseAmount(STAKE, DEC));
injected(keys[1]!);
await joinStaked(cfg, id2);
await leaveStaked(cfg, id2);
const bal = async (a: Hex) => (await pub.readContract({ address: TOKEN, abi: erc, functionName: 'balanceOf', args: [a] })) as bigint;
const waitBal = async (a: Hex, f: (b: bigint) => boolean) => { let b = await bal(a); for (let i = 0; i < 20 && !f(b); i++) { await sleep(1000); b = await bal(a); } return b; };
// keys[1] staked in room 1 (still on chain) so it holds 1 - 0.05; joining and leaving room 2 must net out
const b1 = await waitBal(addrs[1]!, (b) => b === ONE - parseAmount(STAKE, DEC));
assert(b1 === ONE - parseAmount(STAKE, DEC), 'a player who left a waiting room got the whole stake back');
injected(keys[0]!);
await cancelStaked(cfg, id2);
const b0 = await waitBal(addrs[0]!, (b) => b === ONE - 2n * parseAmount(STAKE, DEC) + parseAmount(STAKE, DEC));
assert(b0 === ONE - parseAmount(STAKE, DEC), 'a host who cancelled got the stake back');
console.log('\nALL CHECKS PASSED');
process.exit(0);
