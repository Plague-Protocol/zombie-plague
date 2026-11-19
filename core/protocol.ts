// What the browser and the room server say to each other (WebSocket at /play, one JSON object per frame).
// Types only: the server checks every incoming frame against its own schema, and this file adds nothing to the
// game's download. Inputs are the replay's own: the stick in 64ths, the buttons as bits (replay.ts BUTTONS order).
import type { Command } from './replay';
import type { Placement } from './types';
import type { WireSnap } from './codec';

/** Seconds per tick of a room (it runs at 30 a second; snapshots go out at 15). */
export const ROOM_DT = 1 / 30;
export const SNAPSHOT_EVERY = 2;
/** How long a seat is held for a player who dropped, before it is given up. */
export const RECONNECT_SECONDS = 20;

export type ClientMsg =
  /** First message. `token` is the sign-in token, or null to play as a guest (free rooms only). */
  | { t: 'hello'; token: string | null; name: string }
  /** `zp`: a ZP room, each seat staking that much ZP (one of the server's stakes). */
  | { t: 'create'; zp?: number }
  /** Quick play: a seat in any public lobby with room (at the same ZP stake), or a new public room. */
  | { t: 'quick'; zp?: number }
  | { t: 'join'; code: string }
  /** Take a seat in a staked room by its on-chain id; the server checks the chain and the account, never this message. */
  | { t: 'staked'; stack: string; roomId: string }
  | { t: 'start' }
  /** `i`: [dx in 64ths, dy in 64ths, buttons]. `seq` counts up; the server answers with the last one it used. */
  | { t: 'in'; seq: number; i: [number, number, number] }
  | { t: 'cmd'; c: Command }
  | { t: 'leave' };

export interface SeatInfo { seat: number; name: string; signedIn: boolean; connected: boolean }

export type ServerMsg =
  | { t: 'room'; code: string; seats: SeatInfo[]; you: number; host: number; state: 'lobby' | 'playing' | 'ended'; startsIn: number | null; public?: boolean; onChain?: string; stack?: string; /** a ZP room: each seat's stake, and the pot */ zp?: number; pot?: number }
  /** The round begins: build the district from the seed (createRoom(seed, players)) and play. */
  | { t: 'begin'; seed: number; players: number; content: number; seat: number; /** who each seat plays (null: Sam) */ sv?: Array<string | null> }
  /** `w`: the view in its wire form (see codec.ts). `ack`: the last input of yours the server used. */
  | { t: 'snap'; tick: number; ack: number; w: WireSnap }
  | { t: 'end'; placements: Placement[]; logHash: string }
  /** What a ZP room paid you: `got` back of your `stake` (0: lost; the stake: nobody got out, or the room closed). */
  | { t: 'zp'; stake: number; got: number }
  | { t: 'err'; code: 'full' | 'no-room' | 'started' | 'rate' | 'bad' | 'busy' | 'hello' | 'staked-off' | 'not-staked' | 'not-eligible' | 'no-chain' | 'signin' | 'no-zp' | 'zp-off' };
