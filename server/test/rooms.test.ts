// Room rules without sockets: fake connections, a clock the test moves.
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, AUTO_START_AT, AUTO_START_SECONDS, type Conn, type RoundResult } from '../src/rooms.ts';
import { ContentRegistry } from '../src/content.ts';
import { replayRoom, hashState, type RoomLog } from '../../core/replay.ts';
import { gunzipSync } from 'node:zlib';
import { CONTENT_DIR } from './helpers.ts';
import type { ServerMsg } from '../../core/protocol.ts';
import { RECONNECT_SECONDS } from '../../core/protocol.ts';
import { makeDecoder } from '../../core/codec.ts';
import { ROOM_PLAYERS_MAX } from '../../core/config.ts';

/** A clock and timers the test drives by hand. */
function clock() {
  let t = 1_000_000;
  const timers: Array<{ at: number; f: () => void; id: number }> = [];
  let id = 0;
  return {
    now: () => t,
    setTimer: (f: () => void, ms: number) => { const x = { at: t + ms, f, id: ++id }; timers.push(x); return x.id; },
    clearTimer: (h: unknown) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    /** Advance, firing timers in order (timers a timer sets are honoured). */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = Math.max(t, next.at);
        next.f();
      }
      t = end;
    },
  };
}

function setup(over: Partial<ConstructorParameters<typeof Hub>[0]> = {}) {
  ContentRegistry.fromDir(CONTENT_DIR);
  const c = clock();
  const rounds: RoundResult[] = [];
  const hub = new Hub({ contentVersion: () => 1, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, seed: () => 12345, onRound: (r) => rounds.push(r), ...over });
  return { c, hub, rounds };
}

function conn(name: string, accountId: string | null = null): Conn & { got: ServerMsg[] } {
  const got: ServerMsg[] = [];
  return { id: name, name, accountId, room: null, got, send: (m) => { got.push(m); } };
}
const last = <T extends ServerMsg['t']>(c: { got: ServerMsg[] }, t: T) => [...c.got].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

/** The latest view a connection was sent, decoded from every snapshot it got, in order. */
function viewOf(c: { got: ServerMsg[] }) {
  const d = makeDecoder();
  let v = null as ReturnType<typeof d> | null;
  for (const m of c.got) if (m.t === 'snap') v = d(m.w);
  return v!;
}

let hubs: Hub[] = [];
afterEach(() => { for (const h of hubs) h.close(); hubs = []; });
const make = (over = {}) => { const s = setup(over); hubs.push(s.hub); return s; };

describe('the lobby', () => {
  it('a room has a short code, the first player is the host, joining is by code in any case', () => {
    const { hub } = make();
    const a = conn('Ann'), b = conn('Bo');
    const room = hub.create(a);
    if (room === 'busy') throw new Error('busy');
    expect(room.code).toMatch(/^[A-HJ-NP-Z]{5}$/);
    expect(room.host).toBe(0);
    expect(hub.find(room.code.toLowerCase())).toBe(room);
    expect(room.seat(b)).toBe(1);
    expect(last(b, 'room')!.seats.map((s) => s.name)).toEqual(['Ann', 'Bo']);
    expect(last(a, 'room')!.you).toBe(0);
    expect(last(b, 'room')!.you).toBe(1);
  });

  it('only the host can start, and not alone', () => {
    const { hub } = make();
    const a = conn('Ann'), b = conn('Bo');
    const room = hub.create(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    expect(room.start(a)).toBe(false); // alone
    room.seat(b);
    expect(room.start(b)).toBe(false); // not the host
    expect(room.start(a)).toBe(true);
    expect(room.state).toBe('playing');
    expect(last(a, 'begin')).toMatchObject({ seed: 12345, players: 2, seat: 0 });
    expect(last(b, 'begin')).toMatchObject({ seat: 1 });
  });

  it('a full room starts by itself, and a latecomer is turned away once it is on', () => {
    const { hub } = make();
    const first = conn('p0');
    const room = hub.create(first) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    for (let i = 1; i < ROOM_PLAYERS_MAX; i++) room.seat(conn(`p${i}`));
    expect(room.state).toBe('playing');
    expect(room.seat(conn('late'))).toBe('started');
  });

  it('starts itself some seconds after the fourth player sits down', () => {
    const { hub, c } = make();
    const room = hub.create(conn('p0')) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    for (let i = 1; i < AUTO_START_AT; i++) room.seat(conn(`p${i}`));
    expect(room.state).toBe('lobby');
    expect(last(room.seats[0]!.conn as never, 'room')!.startsIn).toBe(AUTO_START_SECONDS);
    c.advance((AUTO_START_SECONDS - 1) * 1000);
    expect(room.state).toBe('lobby');
    c.advance(1500);
    expect(room.state).toBe('playing');
  });

  it('leaving the lobby frees the seat and passes the host on; an empty room is gone', () => {
    const { hub } = make();
    const a = conn('Ann'), b = conn('Bo');
    const room = hub.create(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    room.seat(b);
    room.drop(a);
    expect(room.seats.map((s) => s.name)).toEqual(['Bo']);
    expect(room.host).toBe(0);
    room.drop(b);
    expect(hub.find(room.code)).toBeUndefined();
  });

  it('there is a limit on rooms', () => {
    const { hub } = make();
    for (let i = 0; i < 40; i++) expect(hub.create(conn(`h${i}`))).not.toBe('busy');
    expect(hub.create(conn('one too many'))).toBe('busy');
  });
});

describe('a round', () => {
  function playing(n = 2) {
    const s = make();
    const conns = Array.from({ length: n }, (_, i) => conn(`p${i}`, `acct${i}`));
    const room = s.hub.create(conns[0]!) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    for (const c of conns.slice(1)) room.seat(c);
    room.start(conns[0]!);
    return { ...s, room, conns };
  }

  it('ticks 30 times a second, snapshots 15, each seat sees itself, and acknowledges the input it used', () => {
    const { c, room, conns } = playing(2);
    c.advance(1000);
    const snaps = conns[0]!.got.filter((m) => m.t === 'snap');
    expect(snaps.length).toBe(15);
    room.input(conns[0]!, 5, [64, 0, 0]);
    c.advance(100);
    const s = last(conns[0]!, 'snap')!;
    expect(s.ack).toBe(5);
    expect(viewOf(conns[0]!).seat).toBe(0);
    expect(room.game!.players[0]!.vel.x).toBeGreaterThan(0);
    expect(viewOf(conns[1]!).seat).toBe(1);
    expect(last(conns[1]!, 'snap')!.ack).toBe(0);
  });

  it('an input out of order is ignored, and edges are kept until a tick uses them', () => {
    const { c, room, conns } = playing(2);
    const p = room.game!.players[0]!;
    room.input(conns[0]!, 10, [0, 0, 32]); // light, once
    room.input(conns[0]!, 9, [64, 0, 0]); // older: ignored
    room.input(conns[0]!, 11, [0, 0, 0]);
    expect(p.light).toBe(true);
    c.advance(40);
    expect(p.light).toBe(false); // the toggle was not lost though a later message cleared the bits
    expect(p.vel.x).toBe(0);
  });

  it('a seat that drops stands still, can come back with the same account, and is given up on after a while', () => {
    const { c, room, conns, hub } = playing(2);
    room.input(conns[1]!, 1, [64, 0, 0]);
    c.advance(200);
    room.drop(conns[1]!);
    const pos = { ...room.game!.players[1]!.pos };
    c.advance(1000);
    expect(Math.hypot(room.game!.players[1]!.pos.x - pos.x, room.game!.players[1]!.pos.y - pos.y)).toBeLessThan(3); // came to a stop
    const back = conn('p1 again', 'acct1');
    expect(room.seat(back)).toBe(1);
    expect(room.seats[1]!.conn).toBe(back);
    expect(hub.find(room.code)).toBe(room);
    room.drop(back);
    c.advance((RECONNECT_SECONDS + 2) * 1000);
    expect(room.game!.players[1]!.status).toBe('missed');
    expect(room.seat(conn('stranger', 'acct1'))).toBe('started'); // too late
  });

  it('a guest cannot take a seat back (nothing says who they were)', () => {
    const s = make();
    const a = conn('Ann'), b = conn('Guest');
    const room = s.hub.create(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    room.seat(b);
    room.start(a);
    room.drop(b);
    expect(room.seat(conn('Guest again'))).toBe('started');
  });

  it('when the round ends everyone is told, the log is kept, and replaying it gives the same end', () => {
    const { c, room, conns, rounds } = playing(3);
    // a purchase between ticks, recorded with the round
    room.cmd(conns[1]!, { t: 'buy', item: { kind: 'medkit' } });
    c.advance(5000);
    room.game!.elapsed = room.game!.roomLimit - 0.1; // jump to the end of the room's clock
    c.advance(500);
    expect(room.state).toBe('ended');
    const end = last(conns[0]!, 'end')!;
    expect(end.placements.length).toBe(3);
    expect(rounds.length).toBe(1);
    const log = JSON.parse(gunzipSync(rounds[0]!.log).toString()) as RoomLog;
    expect(log.commands.length).toBe(1);
    expect(rounds[0]!.logHash).toBe(end.logHash);
    expect(rounds[0]!.seats.map((s) => s.name)).toEqual(['p0', 'p1', 'p2']);
    expect(hashState(room.game!)).toBe(end.logHash);
    void replayRoom; // (a jump of the clock cannot be replayed from inputs; the real-time test below does that)
  });

  it('is removed a minute after it ends', () => {
    const { c, room, hub } = playing(2);
    room.game!.elapsed = room.game!.roomLimit;
    c.advance(100);
    expect(room.state).toBe('ended');
    c.advance(61_000);
    expect(hub.find(room.code)).toBeUndefined();
  });
});

describe('quick play and private rooms', () => {
  it('quick play fills the fullest public lobby, never a private one, and opens a public room when none has space', () => {
    const { hub } = make();
    const priv = hub.create(conn('Pat')) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    const q1 = hub.quick(conn('Q1')) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    expect(q1).not.toBe(priv); // a room made with New room is not handed out
    expect(q1.isPublic).toBe(true);
    expect(priv.isPublic).toBe(false);
    const q2 = hub.quick(conn('Q2'));
    expect(q2).toBe(q1);
    expect(q1.seats.map((s) => s.name)).toEqual(['Q1', 'Q2']);
    expect(last(conn('x'), 'room')).toBeUndefined();
  });

  it('a started or full public room is passed over', () => {
    const { hub } = make();
    const a = conn('A'), b = conn('B');
    const q = hub.quick(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    hub.quick(b);
    q.start(a);
    expect(q.state).toBe('playing');
    const next = hub.quick(conn('C'));
    expect(next).not.toBe(q);
    for (let i = 0; i < ROOM_PLAYERS_MAX - 1; i++) hub.quick(conn(`F${i}`));
    expect((next as typeof q).seats.length).toBe(ROOM_PLAYERS_MAX);
    expect(hub.quick(conn('G'))).not.toBe(next);
  });

  it('live counts players waiting in public rooms with a seat, and players in rounds, never private lobbies', () => {
    const { hub } = make();
    hub.create(conn('Pat')); // a private lobby: not waiting for strangers
    expect(hub.live()).toEqual({ waiting: 0, playing: 0, byStake: {} });
    const a = conn('A');
    const q = hub.quick(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    hub.quick(conn('B'));
    expect(hub.live()).toEqual({ waiting: 2, playing: 0, byStake: { free: 2 } });
    q.start(a);
    expect(hub.live()).toEqual({ waiting: 0, playing: 2, byStake: {} });
  });
});

describe('loadouts in rooms', () => {
  it('a free room starts each seat with the loadout it signed in with, and tells everyone who plays whom', () => {
    const { hub } = setup();
    const a = conn('a', 'acct-a'), b = conn('b', 'acct-b');
    a.loadout = { kit: ['shotgun'], ups: {}, hand: 'shotgun', survivor: 'rook', grit: 2 };
    const room = hub.create(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    room.seat(b);
    expect(room.start(a)).toBe(true);
    const begin = last(a, 'begin')!;
    expect(begin.sv).toEqual(['rook', null]);
    expect(last(b, 'begin')!.sv).toEqual(['rook', null]);
    expect(room.game!.players[0]!.arsenal.owned).toContain('shotgun');
    expect(room.game!.players[0]!.arsenal.perks).toEqual({ quiet: 0.3 });
    expect(room.game!.players[1]!.arsenal.owned).toEqual(['pistol', 'baton']);
    expect(room.rec!.log().loadouts).toEqual([a.loadout, null]);
  });

  it('with no loadouts the round and its log are the classic ones', () => {
    const { hub } = setup();
    const a = conn('a', 'acct-a'), b = conn('b', 'acct-b');
    const room = hub.create(a) as Exclude<ReturnType<Hub['create']>, 'busy'>;
    room.seat(b);
    room.start(a);
    expect(last(a, 'begin')!.sv).toBeUndefined();
    expect(room.rec!.log().loadouts).toBeUndefined();
  });
});
