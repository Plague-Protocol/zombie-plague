// Rooms: the server runs the game for everyone in one, at 30 ticks a second, and tells each seat only what that seat
// may know. Players send inputs; the rules (the same ones the browser runs) do the rest.
import { randomInt } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { command, hashState, quantize, RoomRecorder, type Command, type RoomLog } from '../../core/replay.ts';
import { createRoom, step, type GameState } from '../../core/state.ts';
import { ROOM_PLAYERS_MAX } from '../../core/config.ts';
import { viewFor } from '../../core/view.ts';
import { makeEncoder, type WireSnap } from '../../core/codec.ts';
import { RECONNECT_SECONDS, ROOM_DT, SNAPSHOT_EVERY, type SeatInfo, type ServerMsg } from '../../core/protocol.ts';
import type { Input } from '../../core/types.ts';

export const MAX_ROOMS = 40;
export const AUTO_START_AT = 4; // seats filled before the countdown starts
export const AUTO_START_SECONDS = 20;
export const RESULTS_KEPT_SECONDS = 60;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BUTTON_BITS = { action: 1, fire: 2, reload: 4, swap: 8, throw: 16, light: 32 } as const;
const EDGES = BUTTON_BITS.action | BUTTON_BITS.reload | BUTTON_BITS.swap | BUTTON_BITS.throw | BUTTON_BITS.light;

/** A connection as the rooms see it: somewhere to send, and who it is. */
export interface Conn {
  id: string;
  name: string;
  accountId: string | null;
  /** The wallet behind the sign-in (lower-case), if signed in. */
  address?: string | null;
  /** What this account carries into a free room (its ranked loadout), read when it signed in. */
  loadout?: import('../../core/loadout.ts').Loadout;
  send(m: ServerMsg): void;
  room: Room | null;
}

interface Seat {
  conn: Conn | null;
  name: string;
  accountId: string | null;
  address: string | null;
  /** When it dropped (room time), if it has. */
  droppedAt: number | null;
  /** What this connection has already been told (a new connection starts from nothing). */
  encode: (v: ReturnType<typeof viewFor>) => WireSnap;
  // what to simulate for it next tick
  dx: number; dy: number; held: number; edges: number; seq: number;
}

export interface RoundResult {
  code: string;
  seed: number;
  seats: Array<{ name: string; accountId: string | null }>;
  /** Set for a staked room: the on-chain room, and the wallets of the seats that got out (the settlement). */
  staked?: { stack: string; roomId: string; winners: string[] };
  placements: ServerMsgEnd['placements'];
  log: Buffer; // gzip of the RoomLog
  logHash: string;
}
type ServerMsgEnd = Extract<ServerMsg, { t: 'end' }>;

export interface HubOptions {
  contentVersion: () => number;
  onRound?: (r: RoundResult) => void;
  /** Time source and timers, replaceable so tests need not wait in real time. */
  now?: () => number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  seed?: () => number;
}

export class Room {
  state: 'lobby' | 'playing' | 'ended' = 'lobby';
  seats: Seat[] = [];
  host = 0;
  game: GameState | null = null;
  rec: RoomRecorder | null = null;
  seed = 0;
  private tick = 0;
  private startedAt = 0;
  private timer: unknown = null;
  private countdownEnds: number | null = null;
  private cmds: Array<[number, Command]> = [];

  /** A staked room is bound to an on-chain room: the chain decides when it starts, and the winners are paid from it. */
  /** A public room is found by Quick play; any other is joined only by its code (or an invite link holding it). */
  isPublic = false;
  constructor(readonly code: string, private hub: Hub, readonly staked: { stack: string; roomId: string } | null = null) {}

  get live(): number { return this.seats.filter((s) => s.conn).length; }

  info(forSeat: number): ServerMsg {
    const seats: SeatInfo[] = this.seats.map((s, i) => ({ seat: i, name: s.name, signedIn: s.accountId !== null, connected: s.conn !== null }));
    const startsIn = this.countdownEnds === null ? null : Math.max(0, Math.ceil((this.countdownEnds - this.hub.now()) / 1000));
    return { t: 'room', code: this.code, seats, you: forSeat, host: this.host, state: this.state, startsIn, public: this.isPublic, ...(this.staked ? { onChain: this.staked.roomId, stack: this.staked.stack } : {}) };
  }

  broadcastInfo(): void {
    this.seats.forEach((s, i) => s.conn?.send(this.info(i)));
  }

  /** A player sits down (or takes back the seat they dropped). Returns the seat, or an error. */
  seat(conn: Conn): number | 'full' | 'started' {
    const back = conn.accountId === null ? -1 : this.seats.findIndex((s) => s.accountId === conn.accountId && s.conn === null && s.droppedAt !== null);
    if (back >= 0) { const s = this.seats[back]!; s.conn = conn; s.droppedAt = null; s.encode = makeEncoder(); conn.room = this; this.broadcastInfo(); return back; }
    if (this.state !== 'lobby') return 'started';
    if (this.seats.length >= ROOM_PLAYERS_MAX) return 'full';
    this.seats.push({ conn, name: conn.name, accountId: conn.accountId, address: conn.address ?? null, droppedAt: null, encode: makeEncoder(), dx: 0, dy: 0, held: 0, edges: 0, seq: 0 });
    conn.room = this;
    if (this.staked) this.broadcastInfo(); // the chain starts a staked room, never the seats
    else if (this.seats.length >= ROOM_PLAYERS_MAX) this.begin();
    else {
      if (this.seats.length >= AUTO_START_AT && this.countdownEnds === null) {
        this.countdownEnds = this.hub.now() + AUTO_START_SECONDS * 1000;
        this.hub.later(() => { if (this.state === 'lobby') this.begin(); }, AUTO_START_SECONDS * 1000);
      }
      this.broadcastInfo();
    }
    return this.seats.length - 1;
  }

  /** Someone left or dropped. In the lobby their seat is freed; in a round it is held for a while. */
  drop(conn: Conn): void {
    const i = this.seats.findIndex((s) => s.conn === conn);
    if (i < 0) return;
    conn.room = null;
    const s = this.seats[i]!;
    s.conn = null;
    if (this.state === 'lobby') {
      this.seats.splice(i, 1);
      if (!this.seats.length) { this.hub.remove(this); return; }
      if (this.host >= this.seats.length || i === this.host) this.host = 0;
      this.seats.forEach((x, k) => { if (x.conn) x.conn.send(this.info(k)); });
      return;
    }
    s.droppedAt = this.elapsed();
    s.dx = 0; s.dy = 0; s.held = 0; s.edges = 0; // stands still
    if (this.state === 'ended' && !this.live) this.hub.remove(this);
    else this.broadcastInfo();
  }

  private elapsed(): number { return (this.hub.now() - this.startedAt) / 1000; }

  /** The host closes the doors. */
  start(conn: Conn): boolean {
    if (this.staked || this.state !== 'lobby' || this.seats[this.host]?.conn !== conn || this.seats.length < 2) return false;
    this.begin();
    return true;
  }

  /**
   * The chain says the staked room started. Everyone who staked plays, in the chain's order, whether or not they are
   * connected yet: a seat nobody has taken is held like a dropped one, so its owner can still walk in during the
   * reconnect window, and is given up on after it.
   */
  startFromChain(players: Array<{ address: string; accountId: string; name: string }>): void {
    if (this.state !== 'lobby' || !this.staked || players.length < 2) return;
    const next: Seat[] = players.map((p) => {
      const have = this.seats.find((s) => s.address === p.address);
      return have ?? { conn: null, name: p.name, accountId: p.accountId, address: p.address, droppedAt: 0, encode: makeEncoder(), dx: 0, dy: 0, held: 0, edges: 0, seq: 0 };
    });
    // a connected seat that did not stake is not in this round
    for (const s of this.seats) if (!next.includes(s) && s.conn) { s.conn.room = null; s.conn.send({ t: 'err', code: 'not-staked' }); }
    this.seats = next;
    this.begin();
  }

  private begin(): void {
    if (this.state !== 'lobby' || this.seats.length < 2) return;
    this.state = 'playing';
    this.seed = this.hub.seed();
    // a free room: each seat brings its ranked loadout (the same budget for everyone); a staked one: the standard kit
    const loadouts = this.staked ? undefined : this.seats.map((s) => s.conn?.loadout);
    const any = loadouts?.some(Boolean) ? loadouts.map((l) => l ?? null) : undefined;
    this.game = createRoom(this.seed, this.seats.length, any?.map((l) => l ?? undefined));
    this.rec = new RoomRecorder(this.seed, this.seats.length, this.hub.opts.contentVersion(), ROOM_DT, any);
    const sv = this.seats.map((_, i) => (any?.[i]?.survivor ?? null));
    this.startedAt = this.hub.now();
    this.tick = 0;
    this.seats.forEach((s, i) => s.conn?.send({ t: 'begin', seed: this.seed, players: this.seats.length, content: this.hub.opts.contentVersion(), seat: i, ...(any ? { sv } : {}) }));
    this.broadcastInfo();
    this.schedule();
  }

  /** Drift-corrected: each tick is timed from the start of the round, not from the last tick. */
  private schedule(): void {
    const due = this.startedAt + (this.tick + 1) * ROOM_DT * 1000;
    this.timer = this.hub.setTimer(() => this.runTick(), Math.max(0, due - this.hub.now()));
  }

  /** A seat's input. Edges (use, reload...) are kept until a tick uses them; the stick and fire are the latest. */
  input(conn: Conn, seq: number, i: [number, number, number]): void {
    const s = this.seats.find((x) => x.conn === conn);
    if (!s || this.state !== 'playing' || seq <= s.seq) return;
    s.seq = seq;
    s.dx = i[0] / 64; s.dy = i[1] / 64;
    s.held = i[2] & BUTTON_BITS.fire;
    s.edges |= i[2] & EDGES;
  }

  /** A purchase or weapon swap, done between ticks. */
  cmd(conn: Conn, c: Command): void {
    const seat = this.seats.findIndex((x) => x.conn === conn);
    if (seat < 0 || this.state !== 'playing') return;
    this.cmds.push([seat, c]);
  }

  private runTick(): void {
    const g = this.game!;
    for (const [seat, c] of this.cmds.splice(0)) { this.rec!.command(seat, c); command(g, c, seat); }
    const inputs: Input[] = this.seats.map((s) => {
      const bits = s.held | s.edges;
      s.edges = 0;
      const i: Input = { dx: s.dx, dy: s.dy };
      if (bits & BUTTON_BITS.action) i.action = true;
      if (bits & BUTTON_BITS.fire) i.fire = true;
      if (bits & BUTTON_BITS.reload) i.reload = true;
      if (bits & BUTTON_BITS.swap) i.swap = true;
      if (bits & BUTTON_BITS.throw) i.throw = true;
      if (bits & BUTTON_BITS.light) i.light = true;
      return quantize(i);
    });
    // a seat that dropped too long ago is given up on
    this.seats.forEach((s, i) => {
      if (s.droppedAt !== null && this.elapsed() - s.droppedAt > RECONNECT_SECONDS) {
        const p = g.players[i]!;
        if (p.status === 'alive' || p.status === 'down') p.status = 'missed';
        s.droppedAt = null; // (and it stays gone: nobody is there to take it back)
        s.accountId = null;
      }
    });
    step(g, inputs, ROOM_DT);
    this.rec!.tick(inputs);
    this.tick++;
    const over = g.phase !== 'playing';
    if (over || this.tick % SNAPSHOT_EVERY === 0) {
      this.seats.forEach((s, i) => s.conn?.send({ t: 'snap', tick: this.tick, ack: s.seq, w: s.encode(viewFor(g, i)) }));
    }
    if (over) this.finish(); else this.schedule();
  }

  private finish(): void {
    const g = this.game!;
    this.state = 'ended';
    const log: RoomLog = this.rec!.log();
    const logHash = hashState(g);
    this.seats.forEach((s) => s.conn?.send({ t: 'end', placements: g.placements ?? [], logHash }));
    this.hub.opts.onRound?.({
      code: this.code, seed: this.seed, seats: this.seats.map((s) => ({ name: s.name, accountId: s.accountId })),
      placements: g.placements ?? [], log: gzipSync(JSON.stringify(log)), logHash,
      ...(this.staked ? { staked: { stack: this.staked.stack, roomId: this.staked.roomId, winners: this.seats.filter((s, i) => s.address && g.players[i]!.status === 'escaped').map((s) => s.address!) } } : {}),
    });
    this.broadcastInfo();
    this.hub.later(() => this.hub.remove(this), RESULTS_KEPT_SECONDS * 1000);
  }

  destroy(): void {
    if (this.timer !== null) this.hub.clearTimer(this.timer);
    this.timer = null;
    for (const s of this.seats) if (s.conn) s.conn.room = null;
    this.seats = [];
  }
}

/** Every room on this server. */
export class Hub {
  rooms = new Map<string, Room>();
  readonly now: () => number;
  readonly seed: () => number;
  private timers = new Set<unknown>();
  private timerFn: (f: () => void, ms: number) => unknown;
  private clearFn: (t: unknown) => void;

  constructor(readonly opts: HubOptions) {
    this.now = opts.now ?? Date.now;
    this.seed = opts.seed ?? (() => randomInt(0, 2 ** 32));
    this.timerFn = opts.setTimer ?? ((f, ms) => setTimeout(f, ms));
    this.clearFn = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  setTimer(f: () => void, ms: number): unknown { const t = this.timerFn(f, ms); this.timers.add(t); return t; }
  clearTimer(t: unknown): void { this.clearFn(t); this.timers.delete(t); }
  /** A one-off timer that is forgotten when it fires. */
  later(f: () => void, ms: number): void { const t = this.setTimer(() => { this.timers.delete(t); f(); }, ms); }

  create(conn: Conn, isPublic = false): Room | 'busy' {
    if (this.rooms.size >= MAX_ROOMS) return 'busy';
    let code = '';
    do { code = Array.from({ length: 5 }, () => CODE_LETTERS[randomInt(0, CODE_LETTERS.length)]).join(''); } while (this.rooms.has(code));
    const room = new Room(code, this);
    room.isPublic = isPublic;
    this.rooms.set(code, room);
    room.seat(conn);
    return room;
  }

  find(code: string): Room | undefined { return this.rooms.get(code.toUpperCase()); }

  /** Quick play: the public lobby with the most players that still has a seat (so rounds fill and start), or a new public room. */
  quick(conn: Conn): Room | 'busy' {
    const open = [...this.rooms.values()].filter((r) => r.isPublic && !r.staked && r.state === 'lobby' && r.seats.length < ROOM_PLAYERS_MAX && r.live > 0);
    open.sort((a, b) => b.seats.length - a.seats.length);
    const room = open[0];
    if (room) { const s = room.seat(conn); if (typeof s === 'number') return room; }
    const made = this.create(conn, true);
    return made;
  }

  /** The room bound to an on-chain room, made on first use. */
  stakedRoom(stack: string, roomId: string): Room | 'busy' {
    const code = Hub.stakedCode(stack, roomId);
    const have = this.rooms.get(code);
    if (have) return have;
    if (this.rooms.size >= MAX_ROOMS) return 'busy';
    const room = new Room(code, this, { stack, roomId });
    this.rooms.set(code, room);
    return room;
  }

  /** A staked room's key in `rooms`: one contract per stake token, so the same number can be a room in each. */
  static stakedCode(stack: string, roomId: string): string { return `S-${stack}-${roomId}`; }

  /** Is this account sitting in a staked room that has not ended? */
  inStaked(accountId: string): boolean {
    for (const r of this.rooms.values()) if (r.staked && r.state !== 'ended' && r.seats.some((s) => s.accountId === accountId)) return true;
    return false;
  }

  remove(room: Room): void {
    room.destroy();
    this.rooms.delete(room.code);
  }

  /** Stop everything (a clean shutdown). */
  close(): void {
    for (const r of [...this.rooms.values()]) this.remove(r);
    for (const t of this.timers) this.clearFn(t);
    this.timers.clear();
  }
}
