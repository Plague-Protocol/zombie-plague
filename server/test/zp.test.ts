// ZP rooms: stakes in the game currency, held in the ledger. The pay-out maths, the ledger bank, the room's part, and
// the whole thing over a real socket (stake taken, not enough ZP, matched only at the same stake, refunded on leaving).
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { Hub, type Conn, type RoundResult } from '../src/rooms.ts';
import { attachWs } from '../src/ws.ts';
import { MemoryStore } from '../src/store.ts';
import { ContentRegistry } from '../src/content.ts';
import { ZpBank, zpPayout, ZP_FEE } from '../src/zp.ts';
import { CONTENT_DIR, makeServer, wallet } from './helpers.ts';
import type { ServerMsg } from '../../core/protocol.ts';

describe('the pay-out', () => {
  it('winners split the pot less the house share; nobody out is a full refund', () => {
    const seats = [{ accountId: 'a', ref: 'r1', escaped: true }, { accountId: 'b', ref: 'r2', escaped: false }, { accountId: 'c', ref: 'r3', escaped: true }];
    const p = zpPayout(100, seats);
    expect(p.winners).toEqual(['a', 'c']);
    expect(p.share).toBe(Math.floor((300 * (1 - ZP_FEE)) / 2)); // 142
    expect(p.share * 2 + p.fee).toBe(300);
    expect(zpPayout(100, seats.map((s) => ({ ...s, escaped: false })))).toMatchObject({ refund: true, fee: 0 });
  });
});

describe('the ledger bank', () => {
  const funded = async (n = 1000) => { const store = new MemoryStore(); const a = await store.upsertAccount('0x' + '1'.repeat(40)), b = await store.upsertAccount('0x' + '2'.repeat(40)); await store.ledger(a.id, n, 'grant', 'g'); await store.ledger(b.id, n, 'grant', 'g'); return { store, a: a.id, b: b.id, bank: new ZpBank(store, () => {}) }; };
  const cash = async (store: MemoryStore, id: string) => (await store.bank(id)).cash;

  it('takes a stake only from what you have, and pays a finished room out once', async () => {
    const { store, a, b, bank } = await funded(150);
    expect(await bank.stake(a, 'room1:x', 100)).toBe(true);
    expect(await bank.stake(a, 'room1:y', 100)).toBe(false); // 50 left
    expect(await bank.stake(b, 'room1:z', 100)).toBe(true);
    await bank.settle('room1', 100, [{ accountId: a, ref: 'room1:x', escaped: true }, { accountId: b, ref: 'room1:z', escaped: false }]);
    await bank.settle('room1', 100, [{ accountId: a, ref: 'room1:x', escaped: true }, { accountId: b, ref: 'room1:z', escaped: false }]); // again: nothing
    expect(await cash(store, a)).toBe(50 + 190);
    expect(await cash(store, b)).toBe(50);
    expect(await store.openZpStakes()).toEqual([]);
  });

  it('a stake neither refunded nor settled (a restart mid-round) goes back on recover, once', async () => {
    const { store, a, bank } = await funded(500);
    await bank.stake(a, 'room2:x', 250);
    expect(await store.openZpStakes()).toEqual([{ accountId: a, ref: 'room2:x', amount: 250 }]);
    expect(await bank.recover()).toBe(1);
    expect(await bank.recover()).toBe(0);
    expect(await cash(store, a)).toBe(500);
  });
});

describe('a ZP room', () => {
  function conn(name: string, accountId: string): Conn & { got: ServerMsg[] } {
    const got: ServerMsg[] = [];
    return { id: name, name, accountId, room: null, got, send: (m) => { got.push(m); } };
  }
  const setup = () => {
    ContentRegistry.fromDir(CONTENT_DIR);
    let t = 1_000_000;
    const timers: Array<{ at: number; f: () => void; id: number }> = [];
    let id = 0;
    const refunds: Array<[string, string, number]> = [], rounds: RoundResult[] = [];
    const hub = new Hub({
      contentVersion: () => 1, now: () => t, seed: () => 99,
      setTimer: (f, ms) => { timers.push({ at: t + ms, f, id: ++id }); return id; },
      clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
      onZpRefund: (a, r, n) => refunds.push([a, r, n]), onRound: (r) => rounds.push(r),
    });
    const tick = () => { timers.sort((a, b) => a.at - b.at); const x = timers.shift(); if (x) { t = Math.max(t, x.at); x.f(); } };
    return { hub, refunds, rounds, tick };
  };

  it('says its stake and pot, refunds whoever leaves the lobby, and refunds everyone if it is closed', () => {
    const { hub, refunds } = setup();
    const room = hub.open(false, 100);
    if (room === 'busy') throw new Error('busy');
    const a = conn('A', 'acc-a'), b = conn('B', 'acc-b');
    room.seat(a, `${room.uid}:1`); room.seat(b, `${room.uid}:2`);
    expect(b.got.at(-1)).toMatchObject({ t: 'room', zp: 100, pot: 200 });
    room.drop(b);
    expect(refunds).toEqual([['acc-b', `${room.uid}:2`, 100]]);
    expect(b.got.at(-1)).toEqual({ t: 'zp', stake: 100, got: 100 });
    hub.remove(room);
    expect(refunds.at(-1)).toEqual(['acc-a', `${room.uid}:1`, 100]);
    hub.close();
  });

  it('at the end, tells each seat what it won and hands the stakes to the pay-out', () => {
    const { hub, rounds, tick } = setup();
    const room = hub.open(false, 100);
    if (room === 'busy') throw new Error('busy');
    const a = conn('A', 'acc-a'), b = conn('B', 'acc-b');
    room.seat(a, `${room.uid}:1`); room.seat(b, `${room.uid}:2`);
    room.start(a);
    const g = room.game!;
    g.players[0]!.status = 'escaped';
    g.players[1]!.status = 'missed';
    g.phase = 'won';
    tick();
    expect(rounds[0]!.zp).toEqual({ uid: room.uid, stake: 100, seats: [{ accountId: 'acc-a', ref: `${room.uid}:1`, escaped: true }, { accountId: 'acc-b', ref: `${room.uid}:2`, escaped: false }] });
    expect(a.got.find((m) => m.t === 'zp')).toEqual({ t: 'zp', stake: 100, got: 190 });
    expect(b.got.find((m) => m.t === 'zp')).toEqual({ t: 'zp', stake: 100, got: 0 });
    hub.close();
  });
});

describe('ZP rooms over the socket', () => {
  let close: Array<() => unknown> = [];
  afterEach(async () => { for (const f of close.reverse()) await f(); close = []; });

  async function boot() {
    const s = await makeServer();
    const zp = new ZpBank(s.store, () => {});
    const hub = new Hub({ contentVersion: () => s.content.latest, onZpRefund: (a, r, n) => { void zp.refund(a, r, n); } });
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    const server = s.app.server as HttpServer;
    const closeWs = attachWs(server, { hub, auth: s.auth, store: s.store, origins: ['http://localhost:5173'], zp });
    close.push(() => { closeWs(); hub.close(); return s.app.close(); });
    return { ...s, hub, port: (server.address() as { port: number }).port };
  }
  async function player(b: Awaited<ReturnType<typeof boot>>, zp: number) {
    const signed = (await wallet().signIn(b.app)).body;
    if (zp) await b.store.ledger(signed.account.id, zp, 'grant', 'test');
    const ws = new WebSocket(`ws://127.0.0.1:${b.port}/play`, { origin: 'http://localhost:5173' });
    const got: ServerMsg[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString()) as ServerMsg));
    await new Promise((r) => ws.on('open', r));
    close.push(() => ws.close());
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    send({ t: 'hello', token: signed.token, name: '' });
    const until = async (f: () => boolean) => { const end = Date.now() + 5000; while (!f()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
    const last = <T extends ServerMsg['t']>(t: T) => [...got].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
    const balance = async () => (await b.store.bank(signed.account.id)).cash;
    return { send, until, last, got, balance, ws };
  }

  it('takes the stake to sit, refuses a player who cannot cover it, pairs only at the same stake, and refunds on leaving', async () => {
    const b = await boot();
    const a = await player(b, 300), c = await player(b, 300), poor = await player(b, 40), other = await player(b, 300);
    a.send({ t: 'quick', zp: 100 });
    await a.until(() => !!a.last('room'));
    expect(a.last('room')).toMatchObject({ public: true, zp: 100, pot: 100 });
    expect(await a.balance()).toBe(200);
    poor.send({ t: 'quick', zp: 100 });
    await poor.until(() => poor.last('err')?.code === 'no-zp');
    expect(await poor.balance()).toBe(40);
    other.send({ t: 'quick', zp: 250 }); // a different stake: its own room
    await other.until(() => !!other.last('room'));
    expect(other.last('room')!.code).not.toBe(a.last('room')!.code);
    const code = a.last('room')!.code;
    c.send({ t: 'join', code }); // by code: first only told what it stakes, nothing taken
    await c.until(() => !!c.last('confirm'));
    expect(c.last('confirm')).toEqual({ t: 'confirm', code, zp: 100, seats: 1, pot: 100 });
    expect(await c.balance()).toBe(300);
    c.send({ t: 'join', code, zp: 100 }); // agreed: the stake is taken the same way
    await c.until(() => c.last('room')?.seats.length === 2);
    expect(c.last('room')!.pot).toBe(200);
    expect(await c.balance()).toBe(200);
    c.send({ t: 'leave' });
    await c.until(() => !!c.last('zp'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await c.balance()).toBe(300);
    a.send({ t: 'quick', zp: 7 }); // not a stake on offer (and already seated)
    a.send({ t: 'leave' });
    await a.until(() => !!a.last('zp'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await a.balance()).toBe(300);
    expect(await b.store.openZpStakes()).toHaveLength(1); // only `other`, still waiting in its room
    expect(b.hub.live().byStake).toEqual({ '250': 1 });
  });
});
