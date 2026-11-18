// The chain, as the server sees it. Two jobs: say what the staked room on chain looks like (who staked, whether it
// started), and, as the backend key, settle a finished round. Reads are always made fresh: a client's word, or an
// event seen earlier, never decides who is seated.
import type { FundEvent } from './store.ts';
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export type ChainStatus = 'none' | 'waiting' | 'started' | 'settled' | 'cancelled';
export interface ChainRoom { status: ChainStatus; host: string; players: string[]; stake: bigint; maxPlayers: number; startedAt: number }

export interface Chain {
  room(id: bigint): Promise<ChainRoom>;
  stakedIn(id: bigint, address: string): Promise<bigint>;
  /** Pays the winners out. Resolves with the transaction hash once it is mined and succeeded; throws otherwise. */
  settle(id: bigint, winners: string[], logHash: string): Promise<string>;
  /** The backend key's balance in wei, for /health. */
  gas(): Promise<bigint>;
  /** Does this address hold the contract's admin role? (The admin page lets those in.) */
  isAdmin(address: string): Promise<boolean>;
  /** The contract's own state for the admin page: paused, the fee contract and what it holds, the stake held, its address. */
  status(): Promise<{ rooms: string; paused: boolean; feeManager: string; fees: bigint; held: bigint; roomCount: bigint }>;
}

export const ROOMS_ABI = parseAbi([
  'function getRoom(uint256) view returns (address host, uint8 status, uint8 maxPlayers, uint96 stake, uint96 pot, uint40 createdAt, uint40 expiresAt, uint40 startedAt, address[] players)',
  'function stakedIn(uint256, address) view returns (uint96)',
  'function settle(uint256 roomId, address[] winners, bytes32 logHash)',
  'function hasRole(bytes32, address) view returns (bool)',
  'function paused() view returns (bool)',
  'function feeManager() view returns (address)',
  'function potEscrow() view returns (address)',
  'function roomCount() view returns (uint256)',
  'function reclaimAfter() view returns (uint40)',
]);
/** The money events: the rooms contract's, the fee contract's withdrawals and the escrow's emergency withdrawals. */
export const FUND_EVENTS = parseAbi([
  'event RoomCreated(uint256 indexed roomId, address indexed host, uint8 maxPlayers, uint96 stake, uint40 expiresAt)',
  'event PlayerJoined(uint256 indexed roomId, address indexed player)',
  'event PlayerLeft(uint256 indexed roomId, address indexed player)',
  'event GameStarted(uint256 indexed roomId, uint8 players)',
  'event RoomSettled(uint256 indexed roomId, address[] winners, uint256 share, uint256 fee, bytes32 logHash)',
  'event RoomRefunded(uint256 indexed roomId, string why)',
  'event Reclaimed(uint256 indexed roomId, address indexed player, uint96 amount)',
  'event PayoutOwed(uint256 indexed roomId, address indexed player, uint256 amount)',
  'event Claimed(uint256 indexed roomId, address indexed player, uint256 amount)',
  'event FeeWithdrawn(address indexed to, uint256 amount)',
  'event EmergencyWithdrawn(uint256 indexed roomId, address indexed to, uint256 amount)',
]);
/** Reading a stake contract's history (the admin page's money view). */
export interface ChainLog {
  head(): Promise<number>;
  roomCount(): Promise<number>;
  /** Seconds after a round starts before a player may take their own stake back. */
  reclaimAfter(): Promise<number>;
  /** The money events between two blocks, inclusive, with their block times. */
  fundEvents(from: number, to: number): Promise<FundEvent[]>;
}

const PLUMBING_ABI = parseAbi(['function balance() view returns (uint256)', 'function totalHeld() view returns (uint256)']);
const STATUS: ChainStatus[] = ['none', 'waiting', 'started', 'settled', 'cancelled'];

export class ViemChain implements Chain, ChainLog {
  private pub;
  private wallet;
  private account;
  private proxy: Hex;

  constructor(o: { rpc: string; chainId: number; rooms: string; key: string }) {
    const chain = defineChain({ id: o.chainId, name: `celo-${o.chainId}`, nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [o.rpc] } } });
    this.pub = createPublicClient({ chain, transport: http(o.rpc, { retryCount: 2, timeout: 15_000 }) });
    this.account = privateKeyToAccount(o.key as Hex);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(o.rpc, { timeout: 30_000 }) });
    this.proxy = o.rooms as Hex;
  }

  async room(id: bigint): Promise<ChainRoom> {
    const r = await this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: 'getRoom', args: [id] });
    return { host: r[0].toLowerCase(), status: STATUS[r[1]] ?? 'none', maxPlayers: r[2], stake: BigInt(r[3]), startedAt: Number(r[7]), players: r[8].map((a) => a.toLowerCase()) };
  }
  async stakedIn(id: bigint, address: string): Promise<bigint> {
    return BigInt(await this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: 'stakedIn', args: [id, address as Hex] }));
  }
  async settle(id: bigint, winners: string[], logHash: string): Promise<string> {
    const hash = await this.wallet.writeContract({ address: this.proxy, abi: ROOMS_ABI, functionName: 'settle', args: [id, winners as Hex[], logHash as Hex] });
    const rc = await this.pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== 'success') throw new Error(`settle reverted (${hash})`);
    return hash;
  }
  private plumbing: Hex[] | null = null;
  async head(): Promise<number> { return Number(await this.pub.getBlockNumber()); }
  async roomCount(): Promise<number> { return Number(await this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: 'roomCount' })); }
  async reclaimAfter(): Promise<number> { return Number(await this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: 'reclaimAfter' })); }
  async fundEvents(from: number, to: number): Promise<FundEvent[]> {
    if (!this.plumbing) {
      const r = (fn: 'feeManager' | 'potEscrow') => this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: fn }) as Promise<Hex>;
      this.plumbing = await Promise.all([r('feeManager'), r('potEscrow')]);
    }
    const logs = await this.pub.getLogs({ address: [this.proxy, ...this.plumbing], events: FUND_EVENTS, fromBlock: BigInt(from), toBlock: BigInt(to) });
    // block times: most nodes put them on the log; an old block cannot be fetched from a node that is not an archive
    // (Forno keeps ~10k blocks), so without one the time is reckoned back from the head at Celo's one block a second
    const times = new Map<bigint, number>();
    let tip: { n: bigint; t: number } | null = null;
    for (const l of logs) {
      if (l.blockNumber === null || times.has(l.blockNumber)) continue;
      const own = (l as { blockTimestamp?: bigint | string | number }).blockTimestamp;
      if (own !== undefined && own !== null) { times.set(l.blockNumber, Number(BigInt(own))); continue; }
      try { times.set(l.blockNumber, Number((await this.pub.getBlock({ blockNumber: l.blockNumber })).timestamp)); } catch {
        if (!tip) { const h = await this.pub.getBlock(); tip = { n: h.number, t: Number(h.timestamp) }; }
        times.set(l.blockNumber, tip.t - Number(tip.n - l.blockNumber));
      }
    }
    const out: FundEvent[] = [];
    for (const l of logs) {
      if (!l.eventName || l.blockNumber === null || l.logIndex === null || !l.transactionHash) continue;
      const a = (l.args ?? {}) as Record<string, unknown>;
      const addr = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null);
      out.push({
        block: Number(l.blockNumber), logIndex: l.logIndex, tx: l.transactionHash, at: times.get(l.blockNumber) ?? 0, name: l.eventName,
        roomId: a.roomId !== undefined ? String(a.roomId) : null,
        player: addr(a.player) ?? addr(a.host) ?? addr(a.to),
        amount: a.amount !== undefined ? String(a.amount) : a.stake !== undefined ? String(a.stake) : null,
        data: JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v)),
      });
    }
    return out;
  }
  async gas(): Promise<bigint> { return this.pub.getBalance({ address: this.account.address }); }
  async isAdmin(address: string): Promise<boolean> {
    return this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: 'hasRole', args: [`0x${'0'.repeat(64)}`, address as Hex] });
  }
  async status() {
    const r = (fn: 'paused' | 'feeManager' | 'potEscrow' | 'roomCount') => this.pub.readContract({ address: this.proxy, abi: ROOMS_ABI, functionName: fn });
    const [paused, feeManager, escrow, roomCount] = await Promise.all([r('paused'), r('feeManager'), r('potEscrow'), r('roomCount')]) as [boolean, Hex, Hex, bigint];
    const [fees, held] = await Promise.all([
      this.pub.readContract({ address: feeManager, abi: PLUMBING_ABI, functionName: 'balance' }),
      this.pub.readContract({ address: escrow, abi: PLUMBING_ABI, functionName: 'totalHeld' }),
    ]);
    return { rooms: this.proxy, paused, feeManager, fees, held, roomCount };
  }
}
