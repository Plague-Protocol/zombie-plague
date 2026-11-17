// Staked rooms, against a fake chain: who may sit, when a round starts, who is paid, and that a payment is never
// sent twice and is not lost across a restart.
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, type Conn, type RoundResult } from '../src/rooms.ts';
import { ContentRegistry } from '../src/content.ts';
import { eligible, Staked } from '../src/staked.ts';
import { MemoryStore } from '../src/store.ts';
import type { Chain, ChainRoom } from '../src/chain.ts';
import type { ServerMsg } from '../../src/net/protocol.ts';
import { CONTENT_DIR } from './helpers.ts';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40), D = '0x' + 'd'.repeat(40);

export class FakeChain implements Chain {
  rooms = new Map<string, ChainRoom>();
  settled: Array<{ id: bigint; winners: string[]; logHash: string }> = [];
  failNext = 0;
  async room(id: bigint) { return this.rooms.get(String(id)) ?? { status: 'none' as const, host: '', players: [], stake: 0n, maxPlayers: 0, startedAt: 0 }; }
  async stakedIn(id: bigint, a: string) { return this.rooms.get(String(id))?.players.includes(a) ? 10n ** 16n : 0n; }
  async settle(id: bigint, winners: string[], logHash: string) {
    if (this.failNext > 0) { this.failNext--; throw new Error('rpc down'); }
    this.settled.push({ id, winners, logHash });
    this.rooms.get(String(id))!.status = 'settled';
    return '0xtx' + this.settled.length;
  }
  async gas() { return 10n ** 18n; }
  admins = new Set<string>();
  paused = false;
  async isAdmin(a: string) { return this.admins.has(a.toLowerCase()); }
  async status() { return { rooms: '0xrooms', paused: this.paused, feeManager: '0xfees', fees: 2250n, held: 0n, roomCount: BigInt(this.rooms.size) }; }
}

const DAY = 24 * 3600 * 1000;
const opts = { minAgeMs: DAY, minOkRuns: 3, failedDays: 7 };

function world() {
  ContentRegistry.fromDir(CONTENT_DIR);
  let t = 1_000_000;
  const store = new MemoryStore();
  const chain = new FakeChain();
  const rounds: RoundResult[] = [];
  let staked: Staked;
  const timers: Array<{ at: number; f: () => void; id: number }> = [];
  let id = 0;
  const hub = new Hub({
    contentVersion: () => 1, now: () => t, seed: () => 7, onRound: (r) => { rounds.push(r); void staked.onRound(r); },
    setTimer: (f, ms) => { const x = { at: t + ms, f, id: ++id }; timers.push(x); return x.id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  staked = new Staked({ chains: { USDm: chain }, store, hub, ...opts, now: () => store.now().getTime(), log: () => {} });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) { timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = Math.max(t, n.at); n.f(); }
    t = end;
  };
  return { store, chain, hub, staked: () => staked, rounds, advance, remake: () => { staked = new Staked({ chains: { USDm: chain }, store, hub, ...opts, now: () => store.now().getTime(), log: () => {} }); return staked; } };
}
type W = ReturnType<typeof world>;

/** An account with the history staked play asks for (old enough, three replay-checked runs), and a connection for it. */
async function player(w: W, address: string, o: { old?: boolean; runs?: number } = {}) {
  const acc = await w.store.upsertAccount(address);
  if (o.old !== false) acc.createdAt = new Date(w.store.now().getTime() - 2 * DAY);
  for (let i = 0; i < (o.runs ?? 3); i++) await w.store.addRun({ accountId: acc.id, night: 1, content: 1, chapter: 0, outcome: 'lost', lossReason: 'time', secondsLeft: 0, kills: 0, hash: 'x', replayOk: true, score: 0, stats: null, log: Buffer.alloc(0) });
  const got: ServerMsg[] = [];
  const c: Conn & { got: ServerMsg[] } = { id: address, name: address.slice(0, 4), accountId: acc.id, address, room: null, got, send: (m) => { got.push(m); } };
  return c;
}
const open = (w: W, id: string, players: string[], status: ChainRoom['status'] = 'waiting') =>
  w.chain.rooms.set(id, { status, host: players[0]!, players, stake: 10n ** 16n, maxPlayers: 8, startedAt: 0 });

let worlds: W[] = [];
afterEach(() => { for (const w of worlds) w.hub.close(); worlds = []; });
const mk = () => { const w = world(); worlds.push(w); return w; };

describe('who may sit', () => {
  it('only an account whose wallet staked in that room, checked on the chain', async () => {
    const w = mk();
    open(w, '1', [A, B]);
    const a = await player(w, A), c = await player(w, C);
    expect(await w.staked().seat(c, 'USDm', '1')).toBe('not-staked');
    expect(await w.staked().seat(a, 'USDm', '1')).toBe('ok');
    expect(await w.staked().seat(await player(w, B), 'USDm', '99')).toBe('no-room');
  });

  it('refuses a guest and a room that is not waiting or started', async () => {
    const w = mk();
    open(w, '1', [A, B]); open(w, '2', [A, B], 'cancelled');
    const guest: Conn = { id: 'g', name: 'g', accountId: null, address: null, room: null, send: () => {} };
    expect(await w.staked().seat(guest, 'USDm', '1')).toBe('not-eligible');
    expect(await w.staked().seat(await player(w, A), 'USDm', '2')).toBe('started');
  });

  it('is eligible only when old enough, with enough checked runs, and no recent failed replay', async () => {
    const w = mk();
    const ok = (c: Conn) => eligible(w.store, c.accountId!, { ...opts, now: () => w.store.now().getTime() });
    expect(await ok(await player(w, A))).toBe(true);
    expect(await ok(await player(w, B, { old: false }))).toBe(false);
    expect(await ok(await player(w, C, { runs: 2 }))).toBe(false);
    const d = await player(w, D);
    await w.store.addRun({ accountId: d.accountId!, night: 1, content: 1, chapter: 0, outcome: 'won', lossReason: null, secondsLeft: 9, kills: 0, hash: 'x', replayOk: false, score: 0, stats: null, log: Buffer.alloc(0) });
    expect(await ok(d)).toBe(false);
  });

  it('one account cannot sit in two staked rooms at once', async () => {
    const w = mk();
    open(w, '1', [A, B]); open(w, '2', [A, C]);
    const a = await player(w, A);
    expect(await w.staked().seat(a, 'USDm', '1')).toBe('ok');
    const a2 = { ...a, room: null, got: [] as ServerMsg[] };
    expect(await w.staked().seat(a2, 'USDm', '2')).toBe('not-eligible');
  });
});

describe('the round', () => {
  async function started(w: W, conns: string[], onChain: string[]) {
    open(w, '5', onChain);
    const cs = [];
    for (const a of conns) { const c = await player(w, a); expect(await w.staked().seat(c, 'USDm', '5')).toBe('ok'); cs.push(c); }
    w.chain.rooms.get('5')!.status = 'started';
    await w.staked().poll();
    return cs;
  }

  it('waits for the chain to start it, then plays everyone who staked, connected or not', async () => {
    const w = mk();
    open(w, '5', [A, B, C]);
    const a = await player(w, A), b = await player(w, B);
    await w.staked().seat(a, 'USDm', '5'); await w.staked().seat(b, 'USDm', '5');
    const room = w.hub.rooms.get('S-USDm-5')!;
    w.advance(60_000);
    expect(room.state).toBe('lobby'); // seats alone never start it, and neither does the host
    expect(room.start(a)).toBe(false);
    w.chain.rooms.get('5')!.status = 'started';
    await w.staked().poll();
    expect(room.state).toBe('playing');
    expect(room.seats.map((s) => s.address)).toEqual([A, B, C]); // C staked and has not arrived: held
    expect(a.got.some((m) => m.t === 'begin')).toBe(true);
  });

  it('pays the players who escaped, once, with a hash of the stored log', async () => {
    const w = mk();
    const cs = await started(w, [A, B, C], [A, B, C]);
    const room = w.hub.rooms.get('S-USDm-5')!;
    room.game!.players[0]!.status = 'escaped';
    room.game!.players[2]!.status = 'escaped';
    room.game!.elapsed = room.game!.roomLimit - 0.1;
    w.advance(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(room.state).toBe('ended');
    expect(w.chain.settled.length).toBe(1);
    expect(w.chain.settled[0]!.winners).toEqual([A, C]);
    expect(w.chain.settled[0]!.logHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await w.store.settlement('USDm:5'))?.status).toBe('done');
    // the same round reported again changes nothing
    await w.staked().onRound(w.rounds[0]!);
    expect(w.chain.settled.length).toBe(1);
    void cs;
  });

  it('a round where nobody got out is settled with no winners (the contract refunds in full)', async () => {
    const w = mk();
    await started(w, [A, B], [A, B]);
    const room = w.hub.rooms.get('S-USDm-5')!;
    room.game!.elapsed = room.game!.roomLimit - 0.1;
    w.advance(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.chain.settled.map((s) => s.winners)).toEqual([[]]);
  });

  it('a payment that failed is retried after a restart, and still paid only once', async () => {
    const w = mk();
    await started(w, [A, B], [A, B]);
    const room = w.hub.rooms.get('S-USDm-5')!;
    room.game!.players[1]!.status = 'escaped';
    w.chain.failNext = 1;
    room.game!.elapsed = room.game!.roomLimit - 0.1;
    w.advance(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.chain.settled.length).toBe(0);
    expect((await w.store.settlement('USDm:5'))?.status).toBe('sent'); // written down, not lost
    const again = w.remake(); // "restart": a new Staked over the same store
    expect(await again.resume()).toBe(1);
    expect(w.chain.settled.map((s) => s.winners)).toEqual([[B]]);
    expect(await again.resume()).toBe(0);
    expect(w.chain.settled.length).toBe(1);
  });

  it('a room the chain cancelled closes its lobby', async () => {
    const w = mk();
    open(w, '6', [A, B]);
    const a = await player(w, A);
    await w.staked().seat(a, 'USDm', '6');
    w.chain.rooms.get('6')!.status = 'cancelled';
    await w.staked().poll();
    expect(w.hub.rooms.has('S-USDm-6')).toBe(false);
    expect(a.got.some((m) => m.t === 'err' && m.code === 'no-room')).toBe(true);
  });

  it('one contract per token: the same room number on two tokens is two rooms, settled on its own contract', async () => {
    const w = mk();
    const usdt = new FakeChain();
    const two = new Staked({ chains: { USDm: w.chain, USDT: usdt }, store: w.store, hub: w.hub, ...opts, now: () => w.store.now().getTime(), log: () => {} });
    open(w, '5', [A, B]);
    usdt.rooms.set('5', { status: 'waiting', host: C, players: [C, D], stake: 10n ** 6n, maxPlayers: 8, startedAt: 0 });
    const a = await player(w, A), c = await player(w, C);
    expect(await two.seat(a, 'USDT', '5')).toBe('not-staked'); // A staked on the USDm contract, not this one
    expect(await two.seat(a, 'USDm', '5')).toBe('ok');
    expect(await two.seat(c, 'USDT', '5')).toBe('ok');
    expect(await two.seat(await player(w, D), 'XYZ', '5')).toBe('no-room');
    expect(w.hub.rooms.get('S-USDm-5')).not.toBe(w.hub.rooms.get('S-USDT-5'));
    await player(w, D);
    usdt.rooms.get('5')!.status = 'started';
    await two.poll();
    const room = w.hub.rooms.get('S-USDT-5')!;
    expect(room.state).toBe('playing');
    expect(w.hub.rooms.get('S-USDm-5')!.state).toBe('lobby');
    room.game!.players[0]!.status = 'escaped';
    await two.onRound({ code: room.code, seed: 1, seats: [], placements: [], log: Buffer.from('x'), logHash: 'h', staked: { stack: 'USDT', roomId: '5', winners: [C] } });
    expect(usdt.settled.map((x) => x.winners)).toEqual([[C]]);
    expect(w.chain.settled).toEqual([]);
    expect((await w.store.settlement('USDT:5'))?.status).toBe('done');
  });
});

describe('the admin API', () => {
  async function adminWorld() {
    const { makeServer, wallet } = await import('./helpers.ts');
    const { registerAdmin } = await import('../src/admin.ts');
    const s = await makeServer();
    const hub = new Hub({ contentVersion: () => 1 });
    const chain = new FakeChain();
    const boss = wallet(), other = wallet(), onchain = wallet();
    chain.admins.add(onchain.account.address.toLowerCase());
    registerAdmin(s.app, { store: s.store, auth: s.auth, hub, chains: { USDm: chain }, admins: [boss.account.address.toLowerCase()], startedAt: Date.now(), db: 'memory', content: () => 1 });
    const tok = async (w: ReturnType<typeof wallet>) => (await w.signIn(s.app)).body.token;
    return { s, hub, chain, tok, boss, other, onchain };
  }
  it('lets in the listed wallets and the contract\'s admins, and no one else', async () => {
    const w = await adminWorld();
    const get = async (t?: string) => w.s.app.inject({ method: 'GET', url: '/admin/overview', headers: t ? { authorization: `Bearer ${t}` } : {} });
    expect((await get()).statusCode).toBe(403);
    expect((await get(await w.tok(w.other))).statusCode).toBe(403);
    const ok = await get(await w.tok(w.boss));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ players: { accounts: 2 }, stacks: [{ symbol: 'USDm', fees: '2250', paused: false }] });
    expect((await get(await w.tok(w.onchain))).statusCode).toBe(200);
    w.hub.close();
  });
  it('closes a stuck room and tells whoever is in it', async () => {
    const w = await adminWorld();
    const got: unknown[] = [];
    const room = w.hub.create({ id: 'c', name: 'Ann', accountId: null, room: null, send: (m) => got.push(m) });
    if (room === 'busy') throw new Error('busy');
    const t = await w.tok(w.boss);
    const r = await w.s.app.inject({ method: 'POST', url: `/admin/rooms/${room.code}/close`, headers: { authorization: `Bearer ${t}` } });
    expect(r.statusCode).toBe(200);
    expect(w.hub.rooms.size).toBe(0);
    expect(got).toContainEqual({ t: 'err', code: 'no-room' });
    expect((await w.s.app.inject({ method: 'POST', url: '/admin/rooms/NOPE/close', headers: { authorization: `Bearer ${await w.tok(w.other)}` } })).statusCode).toBe(403);
    w.hub.close();
  });
});
