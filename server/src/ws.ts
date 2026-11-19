// The WebSocket door at /play: checks every frame, turns sockets into connections, hands them to the rooms.
import { roomLoadout } from './armoury.ts';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type { Auth } from './auth.ts';
import { Limiter } from './limiter.ts';
import type { Conn, Hub, Room } from './rooms.ts';
import type { ServerMsg } from '../../core/protocol.ts';
import type { Store } from './store.ts';
import type { Staked } from './staked.ts';
import { isZpStake, type ZpBank } from './zp.ts';

export const MAX_FRAME_BYTES = 2048;
const INPUTS_PER_SECOND = 60;

const int = (lo: number, hi: number) => z.number().int().min(lo).max(hi);
const cmd = z.discriminatedUnion('t', [
  z.object({ t: z.literal('buy'), item: z.any() }),
  z.object({ t: z.literal('equip'), weapon: z.enum(['pistol', 'shotgun', 'rifle', 'baton', 'bat', 'machete']) }),
  z.object({ t: z.literal('solve'), id: z.string().max(64), answer: z.union([z.string().max(16), z.array(z.number().int().min(0).max(8)).max(9)]) }),
]);
const frame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), token: z.string().max(4096).nullable(), name: z.string().trim().max(20) }),
  z.object({ t: z.literal('create'), zp: z.number().int().optional() }),
  z.object({ t: z.literal('quick'), zp: z.number().int().optional() }),
  z.object({ t: z.literal('join'), code: z.string().length(5).regex(/^[A-Za-z]+$/) }),
  z.object({ t: z.literal('staked'), stack: z.string().regex(/^[A-Za-z0-9]{1,8}$/), roomId: z.string().regex(/^\d{1,18}$/) }),
  z.object({ t: z.literal('start') }),
  z.object({ t: z.literal('in'), seq: int(0, 2 ** 31), i: z.tuple([int(-96, 96), int(-96, 96), int(0, 127)]) }),
  z.object({ t: z.literal('cmd'), c: cmd }),
  z.object({ t: z.literal('leave') }),
]);

export interface WsOptions {
  hub: Hub;
  auth: Auth;
  store: Store;
  /** Rooms are for signed-in players only (true unless a test says otherwise). */
  requireSignIn?: boolean;
  /** Present only when staked rooms are switched on. */
  staked?: Staked;
  /** ZP rooms (stakes in the game currency, held in the ledger). Absent: ZP rooms are off. */
  zp?: ZpBank;
  origins: string[];
  /** Sockets that have not answered a ping in this long are cut. */
  keepAliveMs?: number;
}

/** Attach the socket door to an HTTP server. Returns a function that closes it. */
export function attachWs(server: Server, o: WsOptions): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const beats = new Set<WebSocket>();
  const pulse = setInterval(() => {
    for (const ws of beats) {
      if ((ws as WebSocket & { dead?: boolean }).dead) { ws.terminate(); continue; }
      (ws as WebSocket & { dead?: boolean }).dead = true;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, o.keepAliveMs ?? 15_000);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (url.pathname !== '/play' || (origin && !o.origins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws));
  });

  function accept(ws: WebSocket): void {
    beats.add(ws);
    ws.on('pong', () => { (ws as WebSocket & { dead?: boolean }).dead = false; });
    const limit = new Limiter(INPUTS_PER_SECOND, INPUTS_PER_SECOND * 60);
    const conn: Conn = {
      id: globalThis.crypto.randomUUID(), name: 'Guest', accountId: null, room: null,
      send: (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); },
    };
    let hello = false;
    // Frames are handled one after another: hello looks the account up, and a create sent right behind it must
    // see the name that gave (a browser sends both in the same breath).
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      if (!limit.take('in')) { conn.send({ t: 'err', code: 'rate' }); return; }
      let m: z.infer<typeof frame>;
      try { m = frame.parse(JSON.parse(raw.toString())); } catch { conn.send({ t: 'err', code: 'bad' }); return; }
      queue = queue.then(() => handle(m)).catch(() => ws.terminate());
    });
    ws.on('close', () => { beats.delete(ws); conn.room?.drop(conn); });
    ws.on('error', () => ws.terminate());

    /** Into a ZP room: take the stake, then the seat (opening a room for it if `target` is null); undone if the seat is gone. */
    async function zpEnter(target: Room | null, zp: number | undefined, isPublic: boolean): Promise<void> {
      if (!o.zp) { conn.send({ t: 'err', code: 'zp-off' }); return; }
      if (!isZpStake(zp) || !conn.accountId) { conn.send({ t: 'err', code: 'bad' }); return; }
      const room = target ?? o.hub.open(isPublic, zp);
      if (room === 'busy') { conn.send({ t: 'err', code: 'busy' }); return; }
      const ref = `${room.uid}:${globalThis.crypto.randomUUID().slice(0, 8)}`;
      const dropEmpty = () => { if (!room.seats.length && o.hub.rooms.get(room.code) === room) o.hub.remove(room); };
      if (!(await o.zp.stake(conn.accountId, ref, zp))) { dropEmpty(); conn.send({ t: 'err', code: 'no-zp' }); return; }
      const gone = o.hub.rooms.get(room.code) !== room || conn.room || ws.readyState !== ws.OPEN;
      const s = gone ? 'started' : room.seat(conn, ref);
      if (s === 'full' || s === 'started') {
        await o.zp.refund(conn.accountId, ref, zp);
        dropEmpty();
        if (ws.readyState === ws.OPEN) conn.send({ t: 'err', code: gone && o.hub.rooms.get(room.code) !== room ? 'no-room' : s });
      }
    }

    async function handle(m: z.infer<typeof frame>): Promise<void> {
      if (m.t === 'hello') {
        if (hello) return;
        hello = true;
        const id = await o.auth.accountOf(m.token);
        const acc = id ? await o.store.accountById(id) : null;
        conn.accountId = acc?.id ?? null;
        conn.address = acc?.address ?? null;
        conn.name = (acc?.name ?? m.name) || (acc ? `${acc.address.slice(0, 6)}…${acc.address.slice(-4)}` : 'Guest');
        if (acc) conn.loadout = await roomLoadout(o.store, acc.id).catch(() => undefined);
        return;
      }
      if (!hello) { conn.send({ t: 'err', code: 'hello' }); return; }
      // every seat in a room is a signed-in account: names on the board, a seat to come back to, someone to answer for it
      if ((m.t === 'create' || m.t === 'join' || m.t === 'quick' || m.t === 'staked') && o.requireSignIn !== false && !conn.accountId) { conn.send({ t: 'err', code: 'signin' }); return; }
      switch (m.t) {
        case 'create': {
          if (conn.room) return;
          if (m.zp !== undefined) { await zpEnter(null, m.zp, false); return; }
          const r = o.hub.create(conn);
          if (r === 'busy') conn.send({ t: 'err', code: 'busy' });
          return;
        }
        case 'quick': {
          if (conn.room) return;
          if (m.zp !== undefined) { await zpEnter(o.hub.findQuick(m.zp) ?? null, m.zp, true); return; }
          if (o.hub.quick(conn) === 'busy') conn.send({ t: 'err', code: 'busy' });
          return;
        }
        case 'join': {
          if (conn.room) return;
          const room = o.hub.find(m.code);
          if (!room) { conn.send({ t: 'err', code: 'no-room' }); return; }
          if (room.zp && !room.heldFor(conn)) { await zpEnter(room, room.zp, room.isPublic); return; }
          const s = room.seat(conn);
          if (s === 'full' || s === 'started') conn.send({ t: 'err', code: s });
          else if (room.state === 'playing') { // taking back a seat mid-round: say where things stand
            conn.send({ t: 'begin', seed: room.seed, players: room.seats.length, content: o.hub.opts.contentVersion(), seat: s });
          }
          return;
        }
        case 'staked': {
          if (conn.room) return;
          if (!o.staked) { conn.send({ t: 'err', code: 'staked-off' }); return; }
          const r = await o.staked.seat(conn, m.stack, m.roomId);
          if (r !== 'ok') conn.send({ t: 'err', code: r });
          else { const room = conn.room as Room | null; if (room?.state === 'playing') { const i = room.seats.findIndex((x) => x.conn === conn); conn.send({ t: 'begin', seed: room.seed, players: room.seats.length, content: o.hub.opts.contentVersion(), seat: i }); } }
          return;
        }
        case 'start': conn.room?.start(conn); return;
        case 'in': conn.room?.input(conn, m.seq, m.i); return;
        case 'cmd': conn.room?.cmd(conn, m.c as never); return;
        case 'leave': { const r = conn.room; if (r) { r.drop(conn); } return; }
      }
    }
  }

  return () => { clearInterval(pulse); for (const ws of beats) ws.terminate(); wss.close(); };
}
