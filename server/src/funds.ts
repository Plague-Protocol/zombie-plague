// The money in staked rooms, for the admin page: every stake in, every payout, refund, reclaim and fee out, room by
// room, read from the contracts' own events and kept in the store (so a restart does not read the chain again). From
// those it reconciles against what the contracts say they hold, and lists the rooms that need someone: a round that
// never settled, a waiting room past its expiry, a payout the token refused that the player must claim.
import type { ChainLog } from './chain.ts';
import type { FundEvent, Settlement, Store } from './store.ts';

export interface FundsOptions {
  logs: Record<string, ChainLog>;
  store: Store;
  /** Where each token's contract history starts (its deploy block). Without one, the first sync walks back from the
   * chain head until it finds room #1 being created. */
  fromBlock?: Record<string, number>;
  /** Blocks per log request (halved on a refusal). */
  chunk?: number;
  log?: (m: string) => void;
}

export class Funds {
  private running = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();
  constructor(private o: FundsOptions) {}

  private say(m: string): void { (this.o.log ?? console.log)(`[funds] ${m}`); }
  lastError(stack: string): string | null { return this.errors.get(stack) ?? null; }

  /** Read every token's new events. One sync per token at a time; a second call waits for the first. */
  syncAll(): Promise<void[]> { return Promise.all(Object.keys(this.o.logs).map((s) => this.sync(s))); }
  sync(stack: string): Promise<void> {
    const have = this.running.get(stack);
    if (have) return have;
    const p = this.run(stack).then(() => { this.errors.delete(stack); }, (e: unknown) => { const m = String((e as Error).message ?? e).slice(0, 200); this.errors.set(stack, m); this.say(`${stack}: ${m}`); })
      .finally(() => this.running.delete(stack));
    this.running.set(stack, p);
    return p;
  }

  private async logs(c: ChainLog, from: number, to: number, size: { n: number }): Promise<FundEvent[]> {
    for (;;) {
      try { return await c.fundEvents(from, to); } catch (e) {
        if (to - from < 200) throw e;
        size.n = Math.max(100, Math.floor(size.n / 2)); // the node said the range was too wide
        const mid = from + Math.floor((to - from) / 2);
        return [...await this.logs(c, from, mid, size), ...await this.logs(c, mid + 1, to, size)];
      }
    }
  }

  private async run(stack: string): Promise<void> {
    const c = this.o.logs[stack]!;
    const st = this.o.store;
    const head = await c.head();
    const size = { n: this.o.chunk ?? 5000 };
    let cursor = await st.fundCursor(stack);
    if (cursor === null) {
      const start = this.o.fromBlock?.[stack];
      if (start !== undefined) cursor = start - 1;
      else {
        // no start given: walk back to room #1's creation (or stop at once if no room was ever made)
        if ((await c.roomCount()) === 0) { await st.setFundCursor(stack, head); return; }
        let to = head, found = false;
        for (let k = 0; k < 4000 && to > 0 && !found; k++) {
          const from = Math.max(0, to - size.n + 1);
          const got = await this.logs(c, from, to, size);
          await st.addFundEvents(stack, got);
          found = got.some((e) => e.name === 'RoomCreated' && e.roomId === '1');
          to = from - 1;
        }
        if (!found) this.say(`${stack}: room #1 not found walking back; set STAKE_FROM_BLOCK to read the whole history`);
        await st.setFundCursor(stack, head);
        return;
      }
    }
    while (cursor < head) {
      const to = Math.min(head, cursor + size.n);
      await st.addFundEvents(stack, await this.logs(c, cursor + 1, to, size));
      cursor = to;
      await st.setFundCursor(stack, cursor);
    }
  }
}

// ------------------------------------------------------------------------------------------------ the accounts

export type RoomState = 'waiting' | 'started' | 'settled' | 'refunded';
export interface PlayerMoney { address: string; in: string; out: string; owed: string; how: string }
export interface RoomMoney {
  id: string;
  host: string;
  stake: string;
  maxPlayers: number;
  state: RoomState;
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** What was staked in all, and what is still in the room. */
  staked: string;
  pot: string;
  winners: string[];
  share: string;
  fee: string;
  refunded: string;
  reclaimed: string;
  /** Payouts the token refused, not yet claimed. */
  owed: string;
  why: string | null;
  txs: { created: string; started: string | null; ended: string | null };
  players: PlayerMoney[];
  /** The server's record of paying it, if it has one. */
  settlement: { status: string; error: string | null; tx: string | null } | null;
  issues: string[];
}
export interface Totals {
  rooms: number; started: number; settled: number; refundedRooms: number;
  staked: string; staked30d: string; paidToWinners: string; refunded: string; reclaimed: string; leftBeforeStart: string;
  fees: string; fees30d: string; feesWithdrawn: string; emergency: string; owed: string;
  /** What the escrow and the fee contract should hold, by these events. */
  expectHeld: string; expectFees: string;
}

const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);

/** Every room's money and the token's totals, from its events. `now` in unix seconds. */
export function accounts(events: FundEvent[], now: number, o: { reclaimAfter: number; settlements: Map<string, Settlement>; stack: string; stuckAfter?: number }): { rooms: RoomMoney[]; totals: Totals } {
  interface R {
    m: RoomMoney; stake: bigint; seated: Map<string, bigint>; in: Map<string, bigint>; out: Map<string, bigint>; owed: Map<string, bigint>; how: Map<string, string>;
    share: bigint; fee: bigint; refunded: bigint; reclaimed: bigint; left: bigint;
  }
  const rooms = new Map<string, R>();
  const t = { staked: 0n, staked30d: 0n, paid: 0n, refunded: 0n, reclaimed: 0n, left: 0n, fees: 0n, fees30d: 0n, withdrawn: 0n, emergency: 0n, owed: 0n, claimed: 0n };
  const month = now - 30 * 86400;
  const data = (e: FundEvent) => JSON.parse(e.data) as Record<string, unknown>;
  const pay = (r: R, who: string, v: bigint, how: string) => { add(r.out, who, v); r.how.set(who, how); };

  for (const e of events) {
    if (e.name === 'FeeWithdrawn') { t.withdrawn += BigInt(e.amount ?? 0); continue; }
    if (e.name === 'EmergencyWithdrawn') { t.emergency += BigInt(e.amount ?? 0); continue; }
    if (!e.roomId) continue;
    if (e.name === 'RoomCreated') {
      const d = data(e);
      const stake = BigInt(e.amount ?? 0);
      rooms.set(e.roomId, {
        m: { id: e.roomId, host: e.player ?? '', stake: String(stake), maxPlayers: Number(d.maxPlayers ?? 0), state: 'waiting', createdAt: e.at, expiresAt: Number(d.expiresAt ?? 0), startedAt: null, endedAt: null,
          staked: '0', pot: '0', winners: [], share: '0', fee: '0', refunded: '0', reclaimed: '0', owed: '0', why: null, txs: { created: e.tx, started: null, ended: null }, players: [], settlement: null, issues: [] },
        stake, seated: new Map(), in: new Map(), out: new Map(), owed: new Map(), how: new Map(), share: 0n, fee: 0n, refunded: 0n, reclaimed: 0n, left: 0n,
      });
      continue;
    }
    const r = rooms.get(e.roomId);
    if (!r) continue; // its creation is before the history read (see STAKE_FROM_BLOCK)
    const who = e.player ?? '';
    switch (e.name) {
      case 'PlayerJoined':
        r.seated.set(who, r.stake); add(r.in, who, r.stake); r.how.set(who, 'in');
        t.staked += r.stake; if (e.at >= month) t.staked30d += r.stake;
        break;
      case 'PlayerLeft': {
        const v = r.seated.get(who) ?? r.stake; r.seated.delete(who);
        pay(r, who, v, 'left'); r.left += v; t.left += v;
        break;
      }
      case 'GameStarted': r.m.state = 'started'; r.m.startedAt = e.at; r.m.txs.started = e.tx; break;
      case 'RoomSettled': {
        const d = data(e);
        const winners = ((d.winners as string[] | undefined) ?? []).map((x) => x.toLowerCase());
        r.m.endedAt = e.at; r.m.txs.ended = e.tx;
        if (!winners.length) break; // nobody got out: a RoomRefunded follows and hands every stake back
        const share = BigInt(String(d.share ?? 0)), fee = BigInt(String(d.fee ?? 0));
        r.m.state = 'settled'; r.m.winners = winners; r.share = share; r.fee = fee;
        for (const [p] of r.seated) r.how.set(p, 'lost');
        for (const w of winners) pay(r, w, share, 'got out');
        r.seated.clear();
        t.paid += share * BigInt(winners.length); t.fees += fee; if (e.at >= month) t.fees30d += fee;
        break;
      }
      case 'RoomRefunded': {
        const d = data(e);
        let sum = 0n;
        for (const [p, v] of r.seated) { pay(r, p, v, 'refunded'); sum += v; }
        r.seated.clear();
        r.refunded += sum; t.refunded += sum;
        r.m.state = 'refunded'; r.m.why = String(d.why ?? ''); r.m.endedAt ??= e.at; r.m.txs.ended ??= e.tx;
        break;
      }
      case 'Reclaimed': {
        const v = BigInt(e.amount ?? 0); r.seated.delete(who);
        pay(r, who, v, 'reclaimed'); r.reclaimed += v; t.reclaimed += v;
        if (!r.seated.size) { r.m.state = 'refunded'; r.m.why = 'reclaimed by players'; r.m.endedAt = e.at; r.m.txs.ended = e.tx; }
        break;
      }
      case 'PayoutOwed': add(r.owed, who, BigInt(e.amount ?? 0)); t.owed += BigInt(e.amount ?? 0); break;
      case 'Claimed': add(r.owed, who, -BigInt(e.amount ?? 0)); t.claimed += BigInt(e.amount ?? 0); break;
    }
  }

  const stuck = o.stuckAfter ?? 45 * 60;
  const out: RoomMoney[] = [];
  for (const r of rooms.values()) {
    const m = r.m;
    let staked = 0n; for (const v of r.in.values()) staked += v;
    let pot = 0n; for (const v of r.seated.values()) pot += v;
    let owed = 0n; for (const v of r.owed.values()) owed += v;
    m.staked = String(staked); m.pot = String(pot); m.share = String(r.share); m.fee = String(r.fee);
    m.refunded = String(r.refunded + r.left); m.reclaimed = String(r.reclaimed); m.owed = String(owed);
    m.players = [...r.in.keys()].map((p) => ({ address: p, in: String(r.in.get(p) ?? 0n), out: String(r.out.get(p) ?? 0n), owed: String(r.owed.get(p) ?? 0n), how: r.how.get(p) ?? 'in' }));
    const s = o.settlements.get(`${o.stack}:${m.id}`);
    m.settlement = s ? { status: s.status, error: s.error, tx: s.tx } : null;
    if (m.state === 'started' && m.startedAt !== null) {
      const age = now - m.startedAt;
      if (age >= o.reclaimAfter) m.issues.push(`Not settled after ${Math.round(age / 3600)} h. Players can take their own stake back now with reclaim(${m.id}) on the contract.`);
      else if (s && s.status !== 'done') m.issues.push(`The server's settlement is ${s.status}${s.error ? `: ${s.error}` : ''}. Retry it below.`);
      else if (!s && age >= stuck) m.issues.push(`Started ${Math.round(age / 60)} min ago and the server has no result for it (a restart mid-round?). Players can reclaim ${Math.max(0, Math.round((o.reclaimAfter - age) / 3600))} h from now.`);
    }
    if (m.state === 'waiting' && now >= m.expiresAt && pot > 0n) m.issues.push('Past its expiry with stakes still in it. Anyone can refund everyone with expireRoom; use the button.');
    for (const [p, v] of r.owed) if (v > 0n) m.issues.push(`A payout to ${p} was refused by the token and is held for them. They get it with claim(${m.id}) on the contract.`);
    out.push(m);
  }
  out.sort((a, b) => Number(b.id) - Number(a.id));

  const owedNow = t.owed - t.claimed;
  const outs = t.paid + t.refunded + t.reclaimed + t.left;
  return {
    rooms: out,
    totals: {
      rooms: out.length, started: out.filter((r) => r.startedAt !== null).length, settled: out.filter((r) => r.state === 'settled').length, refundedRooms: out.filter((r) => r.state === 'refunded').length,
      staked: String(t.staked), staked30d: String(t.staked30d), paidToWinners: String(t.paid), refunded: String(t.refunded), reclaimed: String(t.reclaimed), leftBeforeStart: String(t.left),
      fees: String(t.fees), fees30d: String(t.fees30d), feesWithdrawn: String(t.withdrawn), emergency: String(t.emergency), owed: String(owedNow),
      // a payout the token refused stays in the escrow until it is claimed
      expectHeld: String(t.staked - outs - t.fees - t.emergency + owedNow),
      expectFees: String(t.fees - t.withdrawn),
    },
  };
}
