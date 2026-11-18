import { describe, expect, it } from 'vitest';
import { accounts, Funds } from '../src/funds.ts';
import type { ChainLog } from '../src/chain.ts';
import { MemoryStore, type FundEvent, type Settlement } from '../src/store.ts';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
let n = 0;
const ev = (name: string, roomId: string | null, at: number, f: Partial<FundEvent> & { d?: Record<string, unknown> } = {}): FundEvent => {
  n++;
  return { block: n, logIndex: 0, tx: `0x${n.toString(16).padStart(64, '0')}`, at, name, roomId, player: f.player ?? null, amount: f.amount ?? null, data: JSON.stringify(f.d ?? {}) };
};
const created = (id: string, at: number, stake = 100n, expiresAt = at + 3600) => ev('RoomCreated', id, at, { player: A, amount: String(stake), d: { maxPlayers: 4, expiresAt } });
const joined = (id: string, p: string, at: number) => ev('PlayerJoined', id, at, { player: p });
const base = { reclaimAfter: 6 * 3600, settlements: new Map<string, Settlement>(), stack: 'USDm' };

describe('the money in staked rooms', () => {
  it('a settled room: the pot less the fee goes to the winners, the losers get nothing, and the totals reconcile', () => {
    const now = 10_000;
    const evs = [
      created('1', 100), joined('1', A, 100), joined('1', B, 110), joined('1', C, 120),
      ev('GameStarted', '1', 200, { d: { players: 3 } }),
      ev('RoomSettled', '1', 900, { d: { winners: [A], share: '296', fee: '4' } }),
    ];
    const { rooms, totals } = accounts(evs, now, base);
    const r = rooms[0]!;
    expect(r.state).toBe('settled');
    expect(r.staked).toBe('300');
    expect(r.pot).toBe('0');
    expect(r.players.find((p) => p.address === A)).toMatchObject({ in: '100', out: '296', how: 'got out' });
    expect(r.players.find((p) => p.address === B)).toMatchObject({ in: '100', out: '0', how: 'lost' });
    expect(totals).toMatchObject({ staked: '300', paidToWinners: '296', fees: '4', expectHeld: '0', expectFees: '4' });
    expect(r.issues).toEqual([]);
  });

  it('nobody out, a cancelled room and a player who left: every stake comes back, no fee', () => {
    const evs = [
      created('1', 100), joined('1', A, 100), joined('1', B, 100), ev('GameStarted', '1', 200),
      ev('RoomSettled', '1', 900, { d: { winners: [], share: '0', fee: '0' } }), ev('RoomRefunded', '1', 900, { d: { why: 'nobody got out' } }),
      created('2', 1000), joined('2', A, 1000), joined('2', B, 1000), ev('PlayerLeft', '2', 1100, { player: B }), ev('RoomRefunded', '2', 1200, { d: { why: 'cancelled by host' } }),
    ];
    const { rooms, totals } = accounts(evs, 5000, base);
    expect(rooms.map((r) => [r.id, r.state, r.refunded, r.why])).toEqual([['2', 'refunded', '200', 'cancelled by host'], ['1', 'refunded', '200', 'nobody got out']]);
    expect(totals).toMatchObject({ staked: '400', refunded: '300', leftBeforeStart: '100', fees: '0', expectHeld: '0' });
  });

  it('flags a round that never settled, a waiting room past expiry, and a payout the token refused', () => {
    const now = 100_000;
    const evs = [
      created('1', 100), joined('1', A, 100), joined('1', B, 100), ev('GameStarted', '1', 200),
      created('2', 50_000, 100n, 60_000), joined('2', A, 50_000),
      created('3', 70_000), joined('3', A, 70_000), joined('3', C, 70_000), ev('GameStarted', '3', 70_100),
      ev('RoomSettled', '3', 70_900, { d: { winners: [C], share: '197', fee: '3' } }), ev('PayoutOwed', '3', 70_900, { player: C, amount: '197' }),
    ];
    const { rooms, totals } = accounts(evs, now, base);
    const by = (id: string) => rooms.find((r) => r.id === id)!;
    expect(by('1').issues[0]).toMatch(/reclaim\(1\)/);
    expect(by('2').issues[0]).toMatch(/expireRoom/);
    expect(by('3').issues[0]).toMatch(/claim\(3\)/);
    expect(by('3').owed).toBe('197');
    // the refused payout is still in the escrow, as are the stakes of the two unfinished rooms
    expect(totals.expectHeld).toBe(String(200n + 100n + 197n));
  });

  it('a claim clears what is owed, and reclaims empty a stuck room', () => {
    const evs = [
      created('1', 100), joined('1', A, 100), joined('1', B, 100), ev('GameStarted', '1', 200),
      ev('Reclaimed', '1', 30_000, { player: A, amount: '100' }), ev('Reclaimed', '1', 30_001, { player: B, amount: '100' }),
      created('2', 100), joined('2', C, 100), joined('2', A, 100), ev('GameStarted', '2', 200),
      ev('RoomSettled', '2', 900, { d: { winners: [C], share: '197', fee: '3' } }), ev('PayoutOwed', '2', 900, { player: C, amount: '197' }), ev('Claimed', '2', 2000, { player: C, amount: '197' }),
    ];
    const { rooms, totals } = accounts(evs, 40_000, base);
    expect(rooms.find((r) => r.id === '1')).toMatchObject({ state: 'refunded', reclaimed: '200', why: 'reclaimed by players', issues: [] });
    expect(rooms.find((r) => r.id === '2')).toMatchObject({ owed: '0', issues: [] });
    expect(totals).toMatchObject({ owed: '0', expectHeld: '0' });
  });

  it('a started room the server holds a failed settlement for says so', () => {
    const settlements = new Map<string, Settlement>([['USDm:1', { roomId: 'USDm:1', winners: [A], logHash: '0x', status: 'sent', tx: null, error: 'gas' }]]);
    const evs = [created('1', 100), joined('1', A, 100), joined('1', B, 100), ev('GameStarted', '1', 200)];
    const { rooms } = accounts(evs, 1000, { ...base, settlements });
    expect(rooms[0]!.settlement).toMatchObject({ status: 'sent', error: 'gas' });
    expect(rooms[0]!.issues[0]).toMatch(/sent: gas/);
  });
});

describe('reading the events', () => {
  class FakeLog implements ChainLog {
    calls: Array<[number, number]> = [];
    constructor(public tip: number, public evs: FundEvent[], public rooms = 1, public maxRange = Infinity) {}
    async head() { return this.tip; }
    async roomCount() { return this.rooms; }
    async reclaimAfter() { return 6 * 3600; }
    async fundEvents(from: number, to: number) {
      this.calls.push([from, to]);
      if (to - from + 1 > this.maxRange) throw new Error('range too wide');
      return this.evs.filter((e) => e.block >= from && e.block <= to);
    }
  }
  const at = (block: number, name: string, roomId: string): FundEvent => ({ block, logIndex: 0, tx: `0x${block}`, at: block, name, roomId, player: A, amount: '1', data: '{}' });

  it('walks back to room #1 the first time, then reads only new blocks', async () => {
    const store = new MemoryStore();
    const log = new FakeLog(20_000, [at(3000, 'RoomCreated', '1'), at(12_000, 'RoomCreated', '2')], 2);
    const f = new Funds({ logs: { USDm: log }, store, chunk: 5000, log: () => {} });
    await f.sync('USDm');
    expect((await store.fundEvents('USDm')).map((e) => e.roomId)).toEqual(['1', '2']);
    expect(await store.fundCursor('USDm')).toBe(20_000);
    log.tip = 21_000; log.evs.push(at(20_500, 'PlayerJoined', '2')); log.calls = [];
    await f.sync('USDm');
    expect(log.calls).toEqual([[20_001, 21_000]]);
    expect((await store.fundEvents('USDm')).length).toBe(3);
  });

  it('starts at the configured block, and splits a range the node refuses', async () => {
    const store = new MemoryStore();
    const log = new FakeLog(10_000, [at(9000, 'RoomCreated', '1')], 1, 1000);
    const f = new Funds({ logs: { USDm: log }, store, fromBlock: { USDm: 8000 }, chunk: 5000, log: () => {} });
    await f.sync('USDm');
    expect(f.lastError('USDm')).toBeNull();
    expect((await store.fundEvents('USDm')).length).toBe(1);
    expect(await store.fundCursor('USDm')).toBe(10_000);
  });
});
