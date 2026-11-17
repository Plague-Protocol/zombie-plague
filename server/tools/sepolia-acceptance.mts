// Staked-room acceptance on a real chain (Celo Sepolia), with the server's own code in the middle: real wallets stake
// through the contract, the server seats them from what the chain says, plays the round, and settles with the backend
// key. Prints every transaction hash. Needs a stack deployed with a MINTABLE token (the test MockUSD), because real
// cUSD cannot be minted.
//
//   RPC=... PROXY=0x... TOKEN=0x... BACKEND_KEY=0x... npx tsx tools/sepolia-acceptance.mts
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseEther, parseUnits, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ContentRegistry } from '../src/content.ts';
import { ViemChain } from '../src/chain.ts';
import { Hub, type Conn, type RoundResult } from '../src/rooms.ts';
import { Staked } from '../src/staked.ts';
import { MemoryStore } from '../src/store.ts';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const SYM = process.env.SYM ?? 'USDm';
const RPC = env('RPC'), PROXY = env('PROXY') as Hex, TOKEN = env('TOKEN') as Hex, KEY = env('BACKEND_KEY') as Hex;
const chain = defineChain({ id: 11142220, name: 'celo-sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) });
const abi = parseAbi([
  'function createRoom(uint8 maxPlayers, uint96 stake, uint40 expirySecs) returns (uint256)',
  'function joinRoom(uint256)', 'function startGame(uint256)', 'function roomCount() view returns (uint256)',
  'event RoomSettled(uint256 indexed roomId, address[] winners, uint256 share, uint256 fee, bytes32 logHash)',
  'event RoomRefunded(uint256 indexed roomId, string why)',
]);
const erc = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)']);
const hashes: Array<[string, string]> = [];
const send = async (label: string, w: ReturnType<typeof wallet>, address: Hex, a: typeof abi | typeof erc, fn: string, args: unknown[]) => {
  const h = await w.writeContract({ address, abi: a as never, functionName: fn as never, args: args as never });
  const rc = await pub.waitForTransactionReceipt({ hash: h });
  if (rc.status !== 'success') throw new Error(`${label} reverted ${h}`);
  hashes.push([label, h]);
  return rc;
};
const bal = (a: Hex) => pub.readContract({ address: TOKEN, abi: erc, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;
/** A pooled RPC may answer from a node a block behind: wait for the balance to reach what it must be, then report it. */
const settleTo = async (a: Hex, want: bigint) => { let b = await bal(a); for (let i = 0; i < 20 && b !== want; i++) { await new Promise((r) => setTimeout(r, 1000)); b = await bal(a); } return b; };
const assert = (c: boolean, m: string) => { if (!c) throw new Error('ACCEPTANCE FAILED: ' + m); console.log('  ok:', m); };

const DEC = Number(process.env.DEC ?? 18); // 6 for a USDT stack
const STAKE = parseUnits('0.05', DEC);
const backend = wallet(KEY);

async function round(name: string, winnersAt: number[]) {
  console.log(`\n== ${name}`);
  const keys = [0, 1, 2].map(() => generatePrivateKey());
  const ws = keys.map(wallet);
  for (const w of ws) {
    const h = await backend.sendTransaction({ to: w.account.address, value: parseEther('0.05') }); await pub.waitForTransactionReceipt({ hash: h }); hashes.push(['fund gas', h]);
    await send('mint', backend, TOKEN, erc, 'mint', [w.account.address, STAKE * 2n]);
    await send('approve', w, TOKEN, erc, 'approve', [PROXY, STAKE]);
  }
  const rc = await send('createRoom', ws[0]!, PROXY, abi, 'createRoom', [3, STAKE, 3600]);
  const id = BigInt(rc.logs.find((l) => l.address.toLowerCase() === PROXY.toLowerCase())!.topics[1]!); // from the receipt: a pooled RPC can answer a read from a node a block behind
  console.log('  room', String(id));
  await send('joinRoom', ws[1]!, PROXY, abi, 'joinRoom', [id]);
  await send('joinRoom', ws[2]!, PROXY, abi, 'joinRoom', [id]);
  const before = await Promise.all(ws.map((w) => settleTo(w.account.address, STAKE)));
  assert(before.every((b) => b === STAKE), 'each player is down exactly one stake, held by escrow');

  // the server's half
  ContentRegistry.fromDir(new URL('../../public/content', import.meta.url).pathname);
  const store = new MemoryStore();
  let staked!: Staked;
  const rounds: RoundResult[] = [];
  const hub = new Hub({ contentVersion: () => 1, onRound: (r) => { rounds.push(r); void staked.onRound(r); } });
  staked = new Staked({ chains: { [SYM]: new ViemChain({ rpc: RPC, chainId: 11142220, rooms: PROXY, key: KEY }) }, store, hub, minAgeMs: 0, minOkRuns: 0, log: (m) => console.log('  ' + m) });
  const conns: Conn[] = [];
  for (const w of ws) {
    const acc = await store.upsertAccount(w.account.address);
    const c: Conn = { id: acc.id, name: w.account.address.slice(0, 6), accountId: acc.id, address: acc.address, room: null, send: () => {} };
    conns.push(c);
    let r = await staked.seat(c, SYM, String(id));
    for (let k = 0; k < 10 && r !== 'ok'; k++) { await new Promise((z) => setTimeout(z, 1000)); r = await staked.seat(c, SYM, String(id)); }
    assert(r === 'ok', `server seats ${c.name} from the chain`);
  }
  const stranger = await store.upsertAccount(privateKeyToAccount(generatePrivateKey()).address);
  assert((await staked.seat({ id: 's', name: 's', accountId: stranger.id, address: stranger.address, room: null, send: () => {} }, SYM, String(id))) === 'not-staked', 'a wallet that did not stake is refused');
  const room = hub.rooms.get(`S-${SYM}-${id}`)!;
  assert(room.state === 'lobby', 'the round does not start until the chain says so');
  await send('startGame', ws[0]!, PROXY, abi, 'startGame', [id]);
  for (let k = 0; k < 20 && room.state !== 'playing'; k++) { await staked.poll(); if (room.state !== 'playing') await new Promise((z) => setTimeout(z, 1000)); }
  assert(room.state === 'playing', 'the chain started it, so the server plays it');
  for (const i of winnersAt) room.game!.players[i]!.status = 'escaped';
  room.game!.elapsed = room.game!.roomLimit - 0.1;
  for (let i = 0; i < 80 && !(await store.settlement(`${SYM}:${id}`))?.tx; i++) await new Promise((r) => setTimeout(r, 500));
  const s = await store.settlement(`${SYM}:${id}`);
  assert(s?.status === 'done' && !!s.tx, `settlement landed (${s?.tx})`);
  hashes.push(['settle', s!.tx!]);
  const pot = STAKE * 3n;
  const fee0 = winnersAt.length ? (pot * 150n) / 10000n : 0n;
  const share0 = winnersAt.length ? (pot - fee0) / BigInt(winnersAt.length) : STAKE;
  const after = await Promise.all(ws.map((w, i) => settleTo(w.account.address, before[i]! + (winnersAt.length === 0 || winnersAt.includes(i) ? share0 : 0n))));
  if (winnersAt.length) {
    const fee = (pot * 150n) / 10000n;
    const share = (pot - fee) / BigInt(winnersAt.length);
    ws.forEach((_, i) => assert(after[i]! === before[i]! + (winnersAt.includes(i) ? share : 0n), `player ${i} ${winnersAt.includes(i) ? `received exactly ${share} (pot ${pot} less 1.5% fee ${fee}, split ${winnersAt.length} ways)` : 'received nothing'}`));
  } else {
    ws.forEach((_, i) => assert(after[i]! === before[i]! + STAKE, `player ${i} refunded in full (${STAKE})`));
  }
  const rc2 = await pub.getTransactionReceipt({ hash: s!.tx as Hex });
  const topics = rc2.logs.filter((l) => l.address.toLowerCase() === PROXY.toLowerCase()).length;
  assert(topics > 0, 'the proxy emitted the settlement event');
  hub.close(); staked.stop();
}

await round('two of three escape: split with the fee', [0, 2]);
await round('nobody escapes: everyone refunded, no fee', []);
console.log('\nTRANSACTIONS');
for (const [l, h] of hashes) console.log(`${l.padEnd(11)} ${h}`);
process.exit(0);
