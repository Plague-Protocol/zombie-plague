// The whole thing over real sockets: HTTP and WebSocket on a real port, real clients, the game's rules in the
// middle. Time is virtual (a timer queue stepped between I/O turns) so a seven-minute round takes seconds.
import type { Server as HttpServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Hub, type RoundResult } from '../src/rooms.ts';
import { attachWs, MAX_FRAME_BYTES } from '../src/ws.ts';
import { makeServer, wallet, type Server } from './helpers.ts';
import { replayRoom, hashState, type RoomLog } from '../../core/replay.ts';
import { viewFor } from '../../core/view.ts';
import { ROOM_DT, type ClientMsg, type ServerMsg } from '../../core/protocol.ts';
import { makeDecoder } from '../../core/codec.ts';
import type { PlayerView } from '../../core/view.ts';
import type { GameState } from '../../core/state.ts';

/** A clock that only moves when the next timer is due, one timer per turn of the event loop. */
function virtualTime() {
  let now = 5_000_000;
  const q: Array<{ at: number; f: () => void; id: number }> = [];
  let id = 0, running = false;
  const pump = () => {
    q.sort((a, b) => a.at - b.at);
    const n = q.shift();
    if (!n) { running = false; return; }
    now = Math.max(now, n.at);
    n.f();
    setImmediate(pump);
  };
  return {
    now: () => now,
    setTimer: (f: () => void, ms: number) => { const x = { at: now + ms, f, id: ++id }; q.push(x); if (!running) { running = true; setImmediate(pump); } return x.id; },
    clearTimer: (h: unknown) => { const i = q.findIndex((x) => x.id === h); if (i >= 0) q.splice(i, 1); },
  };
}

class Client {
  ws!: WebSocket;
  got: ServerMsg[] = [];
  bytes = 0;
  closed: number | null = null;
  seq = 0;
  /** The latest snapshot, decoded as a browser would. */
  view: PlayerView | null = null;
  private decode = makeDecoder();
  static async open(port: number, origin?: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/play`, origin ? { origin } : undefined);
    c.ws.on('message', (d) => {
      c.bytes += (d as Buffer).length;
      const m = JSON.parse(d.toString()) as ServerMsg;
      c.got.push(m);
      if (m.t === 'snap') c.view = c.decode(m.w);
    });
    c.ws.on('close', (code) => { c.closed = code; });
    await new Promise<void>((res, rej) => { c.ws.on('open', res); c.ws.on('error', rej); c.ws.on('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
    return c;
  }
  send(m: ClientMsg | object) { this.ws.send(JSON.stringify(m)); }
  /** Send a movement input (stick in 64ths) with a rising sequence number. */
  move(dx: number, dy: number, buttons = 0) { this.send({ t: 'in', seq: ++this.seq, i: [Math.round(dx * 64), Math.round(dy * 64), buttons] }); }
  last<T extends ServerMsg['t']>(t: T) { return [...this.got].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined; }
  async until(pred: () => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 5)); }
  }
}

let toClose: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const f of toClose.reverse()) await f(); toClose = []; });

async function boot(opts: { origins?: string[]; onRound?: (r: RoundResult) => void; requireSignIn?: boolean } = {}) {
  const s: Server = await makeServer();
  const vt = virtualTime();
  const hub = new Hub({ contentVersion: () => s.content.latest, now: vt.now, setTimer: vt.setTimer, clearTimer: vt.clearTimer, onRound: opts.onRound, seed: () => 777 });
  await s.app.listen({ port: 0, host: '127.0.0.1' });
  const server = s.app.server as HttpServer;
  const port = (server.address() as { port: number }).port;
  const closeWs = attachWs(server, { hub, auth: s.auth, store: s.store, origins: opts.origins ?? ['http://localhost:5173'], requireSignIn: opts.requireSignIn ?? false });
  toClose.push(() => { closeWs(); hub.close(); return s.app.close(); });
  return { ...s, hub, port, server };
}

const hello = (c: Client, name: string, token: string | null = null) => c.send({ t: 'hello', token, name });
async function lobby(port: number, n: number, token: (i: number) => string | null = () => null) {
  const cs: Client[] = [];
  for (let i = 0; i < n; i++) { const c = await Client.open(port); hello(c, `P${i}`, token(i)); cs.push(c); }
  cs[0]!.send({ t: 'create' });
  await cs[0]!.until(() => !!cs[0]!.last('room'));
  const code = cs[0]!.last('room')!.code;
  for (const c of cs.slice(1)) c.send({ t: 'join', code });
  await Promise.all(cs.map((c) => c.until(() => c.last('room')?.seats.length === n)));
  return { cs, code };
}
const gameOf = (b: Awaited<ReturnType<typeof boot>>, code: string): GameState => b.hub.find(code)!.game!;

describe('sockets', () => {
  it('lets in only the right path and the right origins, and cuts off what is not a frame', async () => {
    const b = await boot();
    await expect(Client.open(b.port, 'https://evil.example')).rejects.toThrow(/403/);
    const noPath = new WebSocket(`ws://127.0.0.1:${b.port}/elsewhere`);
    await new Promise<void>((res) => { noPath.on('error', () => res()); noPath.on('unexpected-response', () => res()); });
    const ok = await Client.open(b.port, 'http://localhost:5173');
    ok.send({ t: 'create' }); // before hello
    await ok.until(() => ok.got.length > 0);
    expect(ok.got[0]).toEqual({ t: 'err', code: 'hello' });
    hello(ok, 'Ann');
    ok.ws.send('this is not json');
    await ok.until(() => ok.got.length > 1);
    expect(ok.got[1]).toEqual({ t: 'err', code: 'bad' });
    ok.send({ t: 'in', seq: 1, i: [9999, 0, 0] }); // out of range
    ok.send({ t: 'join', code: 'ZZZZZ' });
    await ok.until(() => ok.got.some((m) => m.t === 'err' && m.code === 'no-room'));
    expect(ok.got.filter((m) => m.t === 'err' && m.code === 'bad').length).toBe(2);
    ok.ws.send('x'.repeat(MAX_FRAME_BYTES + 10)); // too large: the socket is closed
    await ok.until(() => ok.closed !== null);
    expect(ok.closed).toBe(1009);
  });

  it('a guest cannot make, join or quick-join a room; a signed-in player can', async () => {
    const b = await boot({ requireSignIn: true });
    const g = await Client.open(b.port);
    hello(g, 'Guest');
    for (const m of [{ t: 'create' }, { t: 'quick' }, { t: 'join', code: 'ABCDE' }] as const) g.send(m);
    await g.until(() => g.got.filter((m) => m.t === 'err' && m.code === 'signin').length === 3);
    expect(g.last('room')).toBeUndefined();
    const { token } = (await wallet().signIn(b.app)).body;
    const c = await Client.open(b.port);
    hello(c, 'Sam', token);
    c.send({ t: 'quick' });
    await c.until(() => !!c.last('room'));
    expect(c.last('room')!.public).toBe(true);
  });

  it('frames sent back to back are handled in order: a create right behind a hello has the name', async () => {
    const b = await boot();
    const w = wallet();
    const { token, account } = (await w.signIn(b.app)).body;
    await b.store.setName(account.id, 'Sam');
    const c = await Client.open(b.port);
    c.send({ t: 'hello', token, name: 'ignored' });
    c.send({ t: 'create' }); // no waiting in between
    await c.until(() => !!c.last('room'));
    expect(c.last('room')!.seats[0]!.name).toBe('Sam');
    expect(c.last('room')!.seats[0]!.signedIn).toBe(true);
  });

  it('a signed-in player is known by name; a guest is a guest', async () => {
    const b = await boot();
    const w = wallet();
    const { token, account } = (await w.signIn(b.app)).body;
    await b.store.setName(account.id, 'Sam');
    const { cs } = await lobby(b.port, 2, (i) => (i === 0 ? token : null));
    const seats = cs[1]!.last('room')!.seats;
    expect(seats[0]).toMatchObject({ name: 'Sam', signedIn: true });
    expect(seats[1]).toMatchObject({ name: 'P1', signedIn: false });
  });

  it('three players: same seed, input moves you, the server and your snapshot agree, and nobody gets what the view would hide', async () => {
    const b = await boot();
    const { cs, code } = await lobby(b.port, 3);
    cs[0]!.send({ t: 'start' });
    await Promise.all(cs.map((c) => c.until(() => !!c.last('begin'))));
    const begins = cs.map((c) => c.last('begin')!);
    expect(new Set(begins.map((x) => x.seed)).size).toBe(1);
    expect(begins.map((x) => x.seat)).toEqual([0, 1, 2]);
    expect(begins[0]).toMatchObject({ seed: 777, players: 3 });
    const g = gameOf(b, code);
    const before = { ...g.players[0]!.pos };
    for (let i = 0; i < 30; i++) { cs[0]!.move(1, 0); await cs[0]!.until(() => (cs[0]!.last('snap')?.ack ?? 0) >= i + 1, 5000); }
    const snap = cs[0]!.last('snap')!;
    expect(cs[0]!.view!.you.pos.x).toBeGreaterThan(before.x + 1);
    expect(snap.ack).toBe(30);
    // the snapshot is exactly the server's view of that seat at that tick; and nothing the view hides ever arrived
    for (const c of cs) {
      const v = c.view!;
      for (const z of v.zombies) expect(Math.hypot(z.pos.x - v.you.pos.x, z.pos.y - v.you.pos.y)).toBeLessThanOrEqual(34 + 1e-6);
      const raw = JSON.stringify(v);
      expect(raw).not.toContain('"flow"');
    }
    const live = viewFor(g, 0);
    expect(Object.keys(cs[0]!.view!).sort()).toEqual(Object.keys(live).sort());
    expect(Math.abs(cs[0]!.view!.you.pos.x - live.you.pos.x)).toBeLessThan(0.1); // (positions go in 1/16 units)
    cs.forEach((c) => c.ws.close());
  });

  it('a whole round: it ends, everyone is told, and replaying the stored log gives the same end', async () => {
    let round: RoundResult | undefined;
    const b = await boot({ onRound: (r) => { round = r; } });
    const { cs, code } = await lobby(b.port, 3);
    cs[0]!.send({ t: 'start' });
    await Promise.all(cs.map((c) => c.until(() => !!c.last('begin'))));
    const g = gameOf(b, code);
    // each player wanders about, and the one who is first to the exit... nobody is: the room clock ends it
    let n = 0;
    const walk = setInterval(() => { n++; cs.forEach((c, i) => c.move(Math.cos(n / 40 + i * 2), Math.sin(n / 40 + i * 2), n % 17 === 0 ? 1 : n % 9 === 0 ? 2 : 0)); }, 4);
    await Promise.all(cs.map((c) => c.until(() => !!c.last('end'), 180_000)));
    clearInterval(walk);
    const end = cs[0]!.last('end')!;
    expect(end.placements.length).toBe(3);
    expect(round).toBeDefined();
    const log = JSON.parse(gunzipSync(round!.log).toString()) as RoomLog;
    expect(log.ticks).toBeGreaterThan(1000);
    expect(log.players).toBe(3);
    // the stored log replays, on its own, to the very state the live server ended in
    expect(hashState(replayRoom(log))).toBe(end.logHash);
    expect(hashState(g)).toBe(end.logHash);
    cs.forEach((c) => c.ws.close());
  }, 240_000);

  it('how much each player is sent: a busy room', async () => {
    const b = await boot();
    const { cs, code } = await lobby(b.port, 4);
    cs[0]!.send({ t: 'start' });
    await Promise.all(cs.map((c) => c.until(() => !!c.last('begin'))));
    const g = gameOf(b, code);
    // put everyone in the thick of it: where the most infected are, and wake them
    const dense = g.zombies.filter((z) => z.action !== 'dormant').map((z) => ({ z, n: g.zombies.filter((o) => Math.hypot(o.pos.x - z.pos.x, o.pos.y - z.pos.y) < 20).length })).sort((a, c) => c.n - a.n)[0]!.z;
    g.players.forEach((p, i) => { p.pos = { x: dense.pos.x + (i - 1.5) * 3, y: dense.pos.y + 3 }; });
    g.zombies.forEach((z) => { if (Math.hypot(z.pos.x - dense.pos.x, z.pos.y - dense.pos.y) < 40) z.alertT = 60; });
    await cs[0]!.until(() => (cs[0]!.last('snap')?.tick ?? 0) > 30, 20_000);
    const t0 = cs[0]!.last('snap')!.tick;
    const bytes0 = cs.map((c) => c.bytes);
    await cs[0]!.until(() => (cs[0]!.last('snap')?.tick ?? 0) >= t0 + 300, 60_000); // ten seconds of the round
    const seconds = (cs[0]!.last('snap')!.tick - t0) * ROOM_DT;
    const kbps = cs.map((c, i) => (c.bytes - bytes0[i]!) / 1024 / seconds);
    const zs = cs.map((c) => c.view!.zombies.length);
    process.stdout.write(`room traffic: ${kbps.map((k) => k.toFixed(1)).join(', ')} KB/s per player (zombies in view: ${zs.join(', ')})\n`);
    expect(Math.max(...kbps)).toBeLessThan(6); // the budget in the build plan
    cs.forEach((c) => c.ws.close());
  }, 120_000);
});
