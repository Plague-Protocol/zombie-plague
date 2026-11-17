// Staked rooms: the bridge between the chain and the rooms. The chain says who staked and when the round starts; the
// rooms play it; this pays the winners. Nothing here trusts a client message: every seat is checked against the
// chain and against the server's own records, fresh, at the moment it is asked for.
import { createHash } from 'node:crypto';
import type { Chain } from './chain.ts';
import { Hub, type Conn, type RoundResult } from './rooms.ts';
import type { Store } from './store.ts';

export interface StakedOptions {
  /** One contract per stake token, by its symbol (USDm, USDT). */
  chains: Record<string, Chain>;
  store: Store;
  hub: Hub;
  /** An account must be at least this old (ms) ... */
  minAgeMs?: number;
  /** ... have this many replay-checked free runs ... */
  minOkRuns?: number;
  /** ... and no failed replay in this many days. */
  failedDays?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export type Refusal = 'not-eligible' | 'not-staked' | 'no-room' | 'started' | 'busy' | 'no-chain';

export const DEFAULTS = { minAgeMs: 24 * 3600 * 1000, minOkRuns: 3, failedDays: 7 };

/** The checks that slow a farm of wallets down (they do not stop one person running several: say so). */
export async function eligible(store: Store, accountId: string, o: { minAgeMs: number; minOkRuns: number; failedDays: number; now: () => number }): Promise<boolean> {
  const acc = await store.accountById(accountId);
  if (!acc || o.now() - acc.createdAt.getTime() < o.minAgeMs) return false;
  const st = await store.runStats(accountId);
  if (st.okRuns < o.minOkRuns) return false;
  return (await st.failedSince(o.failedDays)) === 0;
}

export class Staked {
  private o: Required<Omit<StakedOptions, 'chains' | 'store' | 'hub' | 'log'>> & Pick<StakedOptions, 'chains' | 'store' | 'hub' | 'log'>;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(o: StakedOptions) {
    this.o = { minAgeMs: DEFAULTS.minAgeMs, minOkRuns: DEFAULTS.minOkRuns, failedDays: DEFAULTS.failedDays, now: Date.now, ...o };
  }

  private say(m: string): void { (this.o.log ?? console.log)(`[staked] ${m}`); }

  /** Seat a connection in the room for an on-chain id, if the chain and the records both say it may sit. */
  async seat(conn: Conn, stack: string, roomIdText: string): Promise<Refusal | 'ok'> {
    if (!conn.accountId || !conn.address) return 'not-eligible';
    const chain = this.o.chains[stack];
    if (!chain) return 'no-room';
    let id: bigint;
    try { id = BigInt(roomIdText); } catch { return 'no-room'; }
    const hub = this.o.hub;
    const code = Hub.stakedCode(stack, String(id));
    if (hub.inStaked(conn.accountId) && !hub.rooms.get(code)?.seats.some((s) => s.accountId === conn.accountId)) return 'not-eligible';
    let cr;
    try { cr = await chain.room(id); } catch { return 'no-chain'; }
    if (cr.status === 'none') return 'no-room';
    if (cr.status !== 'waiting' && cr.status !== 'started') return 'started';
    let staked: bigint;
    try { staked = await chain.stakedIn(id, conn.address); } catch { return 'no-chain'; }
    if (staked <= 0n || !cr.players.includes(conn.address)) return 'not-staked';
    // a seat already held by this account (reconnecting mid-round) needs no eligibility check: it was made when sat
    const existing = hub.rooms.get(code);
    const held = existing?.seats.some((s) => s.accountId === conn.accountId);
    if (!held && !(await eligible(this.o.store, conn.accountId, this.o))) return 'not-eligible';
    const room = hub.stakedRoom(stack, String(id));
    if (room === 'busy') return 'busy';
    const s = room.seat(conn);
    if (s === 'full' || s === 'started') return 'started';
    // the chain may already have started it (a reconnect, or a start that landed first)
    await this.poll();
    return 'ok';
  }

  /** Look at every staked room still waiting: start the ones the chain started, drop the ones it cancelled. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const room of [...this.o.hub.rooms.values()]) {
        if (!room.staked || room.state !== 'lobby') continue;
        let cr;
        const chain = this.o.chains[room.staked.stack];
        if (!chain) continue;
        try { cr = await chain.room(BigInt(room.staked.roomId)); } catch { continue; }
        if (room.state !== 'lobby') continue; // changed while we waited
        if (cr.status === 'started') {
          const players = [];
          for (const address of cr.players) {
            const acc = await this.o.store.upsertAccount(address);
            const sat = room.seats.find((s) => s.address === address);
            players.push({ address, accountId: acc.id, name: sat?.name ?? acc.name ?? `${address.slice(0, 6)}…${address.slice(-4)}` });
          }
          if (room.state === 'lobby') room.startFromChain(players);
        } else if (cr.status === 'cancelled' || cr.status === 'settled' || cr.status === 'none') {
          for (const s of room.seats) s.conn?.send({ t: 'err', code: 'no-room' });
          this.o.hub.remove(room);
        }
      }
    } finally { this.busy = false; }
  }

  start(everyMs = 3000): void { if (!this.timer) { this.timer = setInterval(() => { void this.poll(); }, everyMs); this.timer.unref(); } }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** A staked round ended: write down what is owed, then pay it. */
  async onRound(r: RoundResult): Promise<void> {
    if (!r.staked) return;
    const logHash = `0x${createHash('sha256').update(r.log).digest('hex')}`;
    const ref = `${r.staked.stack}:${r.staked.roomId}`; // the settlement's key: a room number is only unique per contract
    const fresh = await this.o.store.addSettlement({ roomId: ref, winners: r.staked.winners, logHash, status: 'pending', tx: null, error: null });
    if (!fresh) { this.say(`room ${ref}: already recorded, not settling twice`); return; }
    this.say(`room ${ref}: ${r.staked.winners.length} out`);
    await this.pay(ref);
  }

  /** Send the settlement for a recorded room. Safe to call again: the chain refuses a room already settled. */
  async pay(roomId: string): Promise<void> {
    const s = await this.o.store.settlement(roomId);
    if (!s || s.status === 'done') return;
    const [stack, id] = roomId.split(':') as [string, string];
    const chain = this.o.chains[stack];
    if (!chain || !id) { await this.o.store.updateSettlement(roomId, { status: 'failed', error: `no contract for ${stack}` }); return; }
    try {
      const cr = await chain.room(BigInt(id));
      if (cr.status === 'settled') { await this.o.store.updateSettlement(roomId, { status: 'done' }); return; }
      if (cr.status !== 'started') { await this.o.store.updateSettlement(roomId, { status: 'failed', error: `room is ${cr.status}` }); return; }
      const tx = await chain.settle(BigInt(id), s.winners, s.logHash);
      await this.o.store.updateSettlement(roomId, { status: 'done', tx });
      this.say(`room ${roomId}: settled ${tx}`);
    } catch (e) {
      // left open: resume() retries it (and the players can reclaim if it never lands)
      await this.o.store.updateSettlement(roomId, { status: 'sent', error: String((e as Error).message ?? e).slice(0, 300) });
      this.say(`room ${roomId}: settle failed: ${(e as Error).message}`);
    }
  }

  /** After a restart (and on a timer): finish what was owed. */
  async resume(): Promise<number> {
    const open = await this.o.store.settlementsOpen();
    for (const s of open) await this.pay(s.roomId);
    return open.length;
  }
}
