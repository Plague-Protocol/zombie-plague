// The chain, as the server sees it. Two jobs: say what the staked room on chain looks like (who staked, whether it
// started), and, as the backend key, settle a finished round. Reads are always made fresh: a client's word, or an
// event seen earlier, never decides who is seated.
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
]);
const PLUMBING_ABI = parseAbi(['function balance() view returns (uint256)', 'function totalHeld() view returns (uint256)']);
const STATUS: ChainStatus[] = ['none', 'waiting', 'started', 'settled', 'cancelled'];

export class ViemChain implements Chain {
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
