// What one player is allowed to know. In a room the server is the only one who runs the rules, and it sends
// each seat this and nothing more: darkness and fog are drawn by the client, but what is not sent cannot be
// read out of a modified client. Positions of people and zombies out of sight, other players' health and
// infection clocks, and noises too far to hear never leave the server.
import {
  ALARM_RADIUS, COUGH_NOISE, GUNS, LIGHT_HALF_ANGLE, LIGHT_RANGE, LURE_RADIUS, SCREAM_RADIUS, TURNED_SIGHT,
} from './config';
import { lineClear } from './collision';
import { dhypot, datan2, dsin, dcos } from './dmath';
import { eventSeat, type GameState } from './state';
import type { GameEvent, Placement, Player, PlayerStatus, Vec2, WeaponKind, ZombieAction, ZombieKind } from './types';

/** How far you can see something that is in the open (the camera shows about this much). */
export const VIEW_RANGE = 34;
/** Anyone this close is seen whatever is in the way (you hear and feel them). */
export const NEAR = 6;
/** Someone with their light on can be seen this far, across open ground. */
export const LIT_RANGE = 50;
/** Someone hidden is only shown to a player this close. */
export const HIDDEN_SEEN = 2.5;
/** A stalker you are not lighting is only sent this close. */
export const STALKER_NEAR = 10;

/** The viewer's own player: everything but the path field. */
export type YouView = Omit<Player, 'flow' | 'flowCell' | 'escort'>;

export interface OtherView {
  id: number;
  pos: Vec2;
  heading: number;
  weapon: WeaponKind | null;
  status: PlayerStatus;
  light: boolean;
  exposed: boolean;
  vehicleId: number | null;
  crouched: boolean;
  /** Hidden in a hiding place: only shown to those right next to it. */
  hidden: boolean;
  roof: number | null;
}

export interface ZombieView {
  id: number;
  kind: ZombieKind;
  pos: Vec2;
  heading: number;
  speed: number;
  action: ZombieAction;
  actionT: number;
  staggerT: number;
  frozen: boolean;
  roof: number | null;
}

export interface PlayerView {
  seat: number;
  tick: number;
  phase: GameState['phase'];
  you: YouView;
  others: OtherView[];
  zombies: ZombieView[];
  corpses: GameState['corpses'];
  /** The district's changing parts, by index into what the level gives: a client that has built the level from
   * the seed knows where everything is, and is told only what has been taken, opened, done. */
  taken: boolean[];
  opened: boolean[];
  searched: boolean[];
  tasks: Array<{ id: string; done: boolean; got?: boolean[]; targets?: number[] }>;
  safehouseKnown: boolean;
  flare: GameState['flare'];
  fallen: number;
  tier: number;
  events: GameEvent[];
  roomRemaining: number;
  seatsLeft: number;
  placements: Placement[] | null;
}

/** Is `at` in the beam of this player's torch (with nothing in the way)? */
function lit(s: GameState, p: Player, at: Vec2): boolean {
  if (!p.light) return false;
  const dx = at.x - p.pos.x, dy = at.y - p.pos.y, d = dhypot(dx, dy);
  if (d > LIGHT_RANGE.foot) return false;
  if (d > 1.2) {
    let a = datan2(dy, dx) - p.heading;
    a = datan2(dsin(a), dcos(a));
    if (Math.abs(a) > LIGHT_HALF_ANGLE.foot) return false;
  }
  return lineClear(s.map, p.pos, at, 0.2);
}

/** Can the viewer see a point? Close by, or in the open within range. */
export function sees(s: GameState, viewer: Player, at: Vec2): boolean {
  const d = dhypot(at.x - viewer.pos.x, at.y - viewer.pos.y);
  if (d <= NEAR) return true;
  return d <= VIEW_RANGE && lineClear(s.map, viewer.pos, at, 0.3);
}

/** How far a noise carries, for the events that make one (0 if it is not a noise). */
function noiseRadius(e: GameEvent): number {
  switch (e.type) {
    case 'shot': return GUNS[e.weapon].noise;
    case 'scream': return SCREAM_RADIUS;
    case 'alarm-start': return ALARM_RADIUS;
    case 'bottle-smash': return LURE_RADIUS;
    case 'cough': return COUGH_NOISE;
    default: return 0;
  }
}

/** Where an event happened, if it happened somewhere. */
function eventPos(s: GameState, e: GameEvent): Vec2 | null {
  switch (e.type) {
    case 'shot': return e.from;
    case 'scream': case 'cough': case 'alarm-start': case 'bottle-smash': case 'horde': case 'flare-lit': case 'omen': case 'burst': case 'turned': case 'lunge':
      return e.pos;
    case 'zombie-attack': case 'zombie-alert': case 'zombie-hurt': case 'zombie-killed': case 'halved': case 'dormant-wake':
      return s.zombies.find((z) => z.id === e.id)?.pos ?? null;
    default: return null;
  }
}

/** What this seat may know right now. The only thing a server may send them. */
export function viewFor(s: GameState, seat: number): PlayerView {
  const me = s.players[seat]!;
  const { flow: _flow, flowCell: _cell, escort: _escort, ...you } = me;
  void _flow; void _cell; void _escort;
  const turned = me.status === 'turned';

  const others: OtherView[] = [];
  for (const o of s.players) {
    if (o === me || (o.status !== 'alive' && o.status !== 'down' && o.status !== 'turned')) continue;
    const d = dhypot(o.pos.x - me.pos.x, o.pos.y - me.pos.y);
    const seen = sees(s, me, o.pos)
      || (o.light && d <= LIT_RANGE && lineClear(s.map, me.pos, o.pos, 0.3)) // a torch shows across a street
      || (turned && o.status !== 'turned' && d <= TURNED_SIGHT); // the turned see the living by something that is not sight
    if (!seen || (o.hide !== null && d > HIDDEN_SEEN)) continue; // hidden: only someone right there knows
    others.push({ id: o.id, pos: o.pos, heading: o.heading, weapon: o.arsenal.weapon, status: o.status, light: o.light, exposed: me.checks[o.id] === true && o.status === 'alive', vehicleId: o.vehicleId, crouched: o.crouched, hidden: o.hide !== null, roof: o.roof });
  }

  const zombies: ZombieView[] = [];
  const shown = new Set<number>();
  for (const z of s.zombies) {
    if (!sees(s, me, z.pos)) continue;
    if (z.kind === 'stalker') { // out of your light and not close, it is only dark
      const d = dhypot(z.pos.x - me.pos.x, z.pos.y - me.pos.y);
      if (d > STALKER_NEAR && !lit(s, me, z.pos)) continue;
    }
    shown.add(z.id);
    zombies.push({ id: z.id, kind: z.kind, pos: z.pos, heading: z.heading, speed: z.speed, action: z.action, actionT: z.actionT, staggerT: z.staggerT, frozen: !!z.frozen, roof: z.roof ?? null });
  }

  const events: GameEvent[] = [];
  for (const e of s.events) {
    const owner = eventSeat(e);
    if (owner !== undefined) { if (owner === seat) events.push(e); continue; } // personal: its owner only
    const at = eventPos(s, e);
    if (!at) { if (e.type === 'zombie-attack' || e.type === 'zombie-alert' || e.type === 'zombie-hurt' || e.type === 'zombie-killed') continue; events.push(e); continue; }
    const d = dhypot(at.x - me.pos.x, at.y - me.pos.y), r = noiseRadius(e);
    if (sees(s, me, at) || (r > 0 && d <= r)) events.push(e);
  }

  return {
    seat,
    tick: Math.round(s.elapsed * 60),
    phase: s.phase,
    you,
    others,
    zombies,
    corpses: s.corpses.filter((c) => sees(s, me, c.pos)),
    taken: s.pickups.map((p) => p.taken),
    opened: s.crates.map((c) => c.opened),
    searched: s.houses.map((h) => h.searched),
    tasks: s.tasks.map((t) => ({ id: t.id, done: t.done, ...(t.got ? { got: t.got.slice() } : {}), ...(t.targets ? { targets: t.targets.slice() } : {}) })),
    safehouseKnown: s.safehouseKnown,
    flare: s.flare,
    fallen: s.fallenN,
    tier: s.tier,
    events,
    roomRemaining: Math.max(0, s.roomLimit - s.elapsed),
    seatsLeft: s.seatsLeft,
    placements: s.placements,
  };
}
