// Pure game state. No DOM, no three.js, no Date/Math.random: time comes from dt, randomness from state.rng.
import { applyLoadout, isWeapon as isWeaponKind, type Loadout } from './loadout';
import {
  ATTACK_COOLDOWN, ATTACK_DAMAGE, ATTACK_RANGE, ATTACK_REACH, ATTACK_WINDUP, CALM_FACTOR, CORPSE_SECONDS,
  HIT_INVULNERABLE, KNOCKBACK, MEDKIT_HEAL, PLAYER_ACCEL, PLAYER_HEALTH, PLAYER_RADIUS, PLAYER_SPEED, RISE_SECONDS,
  RUN_OVER_SPEED, RUNNER_SIGHT, RUNNER_SPEED, SAFEHOUSE_RADIUS, SPAWNS_BY_TIER, SPEED_BOOST, TASK_HOLD_SECONDS,
  TASK_RADIUS, TIER_THRESHOLDS, USE_RADIUS, VEHICLES, WALKER_SIGHT_BY_TIER, WALKER_SPEED_BY_TIER, WAVE_SPAWN_MAX_DIST,
  ZOMBIE_ACTIVE_RADIUS, ZOMBIE_CAP, ZOMBIE_RADIUS, ZOMBIE_SPAWN_MIN_DIST, ZOMBIES_PER_BLOCK,
  AIM_CONE, ALERT_SECONDS, BITE_SECONDS, BODY, BODY_SLOW, CLIMB_SECONDS, CORPSES_KEPT, CROUCH_SIGHT, CROUCH_SPEED, HIDE_FOUND, HIDE_LEAVE, HIDE_REACH, HIDE_SEEN,
  LADDER_REACH, ROOF_RANGE, STALKER_FINDS, ZOMBIE_CLIMB_SECONDS, SEATS, SWARM, SWARM_EVERY, SWARM_SPEED, BREACH_AT, CHASE, CHASE_ALERT, GUARD_CHANCE, GUARDS, BREACH_DAMAGE, ENGINE_NOISE, ENGINE_NOISE_EVERY, LATCH_DAMAGE, LATCH_DRAG, LATCH_EVERY, LATCH_GRIP,
  LATCH_MAX, LATCH_SHAKE_SPEED, AMMO_PRICES, GUNS, KILL_REWARD, MEDKIT_PRICE, MELEE, MELEE_KNOCKBACK, PICKUP_RADIUS,
  SAFE_AFTER, STAGGER_SECONDS, START_AMMO, START_FUNDS, STORE_DOOR_RADIUS, UPGRADE_BASE, UPGRADE_EFFECT, UPGRADE_FACTOR,
  UPGRADE_LEVELS, WEAPON_PRICES, ZOMBIE_HEALTH,
  ALARM_RADIUS, ALARM_SECONDS, ALARM_SHOT_RADIUS, BOTTLE_FLIGHT, BOTTLE_RANGE, BOTTLES_PRICE, CLEAR_COUNT, FUEL_SECONDS,
  JERRYCAN_FUEL, JERRYCAN_PRICE, LURE_RADIUS, LURE_SECONDS, PUMP_RATE, REFUEL_SECONDS, SEARCH_SECONDS, START_BOTTLES,
  SURVIVOR_FUNDS, TALK_SECONDS,
  CHAPTER_BONUS, CHAPTER_HEAL, CHAPTER_RUNNERS, CHAPTER_WAVES, CHAPTERS, GEAR,
  ESCORT_NEAR, ESCORT_SPEED, FLARE_RADIUS, FLARE_SECONDS,
  ANTIVIRAL_PRICE, ANTIVIRAL_SECONDS, BITE_COST, BITTEN_CHANCE, BITTEN_COUGH, BITTEN_TURNS, BODIES, BURST, BURST_ALERT, CHECK_RADIUS,
  CHECK_SECONDS, COUGH_EVERY, COUGH_FROM, COUGH_NOISE, DORMANT, DORMANT_HEAR, DORMANT_WAKE, DREAD_SECONDS, FALLEN, FALLEN_QUIET,
  FALLEN_SIGHT, HEALTHY_COUGH, HEALTHY_COUGH_CHANCE, HUSK_HEALTH, INFECTED_CAMO, LIGHT_HALF_ANGLE, LIGHT_OFF_SIGHT, LIGHT_RANGE,
  PANIC_SECONDS, QUIET_FIRST, QUIET_SECONDS, SCREAM_ALERT, SCREAM_EVERY, SCREAM_RADIUS, SCREAM_RUNNERS, SCREAM_WINDUP,
  SCREAMER_SIGHT, SCREAMERS, STALKER_SENSE, STALKER_SPEED, STALKERS,
  CRAWL_DAMAGE, CRAWLER_SIGHT, CRAWLER_SPEED, CRAWLERS, GRAB_SECONDS, GRAB_SLOW, HALVE_CHANCE, LASH_DAMAGE, LASH_PULL, LASH_RANGE,
  LASH_REACH, LASHERS,
  DOWN_SECONDS, EXIT_SEATS_SHARE, INTERIOR_DEAD, INTERIORS, LUNGE_ARC, LUNGE_COOLDOWN, PVP_KILL_REWARD, HORDE_PREY, HORDE_RADIUS, ROOM_PLAYERS_MAX, ROOM_SECONDS, SAFE_RADIUS,
  TARGET_HOLD, TARGET_SWITCH, TURNED_HEALTH, MERCY_DAMAGE, MERCY_HEALTH, MERCY_INVULN, MERCY_SPEED,
} from './config';
import { nearbyObstacles } from './collision';
import { lineClear, resolve } from './collision';
import { generateLevel, type Level } from './level';
import { cellOf, distanceField, onStreets, STREET, UNREACHABLE } from './map';
import { createRng, fork, next, pick, range, shuffle, type Rng } from './rng';
import type {
  Ladder,
  Abandoned, Alarm, Arsenal, Drop, Player, Work, House, Husk, Loot, PickupKind, Survivor, Thrown,
  Crate, Escort, GameEvent, Placement, GearKind, GunKind, Input, Interaction, LossReason, MapData, MeleeKind, Phase, Pickup, Store, StoreItem, Task,
  TaskId, Theme, Vec2, Vehicle, WeaponKind, Zombie, ZombieKind,
} from './types';
import { dsin, dcos, datan2, dhypot } from './dmath';
import { content } from './content';

export type { Arsenal, Work };

/** What you bring into a chapter (and start it again with, if you retry it). */
export interface Carry {
  arsenal: Arsenal;
  health: number;
  funds: number;
  kills: number;
}

const cloneArsenal = (a: Arsenal): Arsenal => ({
  ...a,
  owned: a.owned.slice(),
  mag: { ...a.mag },
  ammo: { ...a.ammo },
  upgrades: Object.fromEntries(Object.entries(a.upgrades).map(([k, v]) => [k, { ...v }])) as Arsenal['upgrades'],
  gear: { ...a.gear },
  fireCd: 0,
  reloadT: 0,
});

/** A night's first carry with what the player brought (the armoury's loadout; none is the standard kit). */
function withLoadout(c: Carry, l: Loadout | undefined): Carry {
  c.funds = applyLoadout(c.arsenal, c.funds, l);
  return c;
}

/** The level seed for a chapter of a night (chapter 0 is the night's own seed). */
export function chapterSeed(night: number, chapter: number): number {
  if (chapter === 0) return night >>> 0;
  let h = (night ^ Math.imul(chapter, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const isMelee = (w: WeaponKind): w is MeleeKind => w in MELEE;
export const isGun = (w: WeaponKind): w is GunKind => w in GUNS;

const noUpgrades = () => ({ damage: 0, mag: 0, reload: 0 });

/** A gun's numbers with its upgrades applied. */
export function gunStats(a: Arsenal, w: GunKind) {
  const base = GUNS[w], u = a.upgrades[w];
  return {
    ...base,
    damage: base.damage * (1 + UPGRADE_EFFECT.damage * u.damage),
    mag: Math.round(base.mag * (1 + UPGRADE_EFFECT.mag * u.mag)),
    reload: base.reload * (1 - UPGRADE_EFFECT.reload * u.reload) * (1 - (a.perks?.reload ?? 0)),
    noise: base.noise * (1 - (a.perks?.quiet ?? 0)), // a survivor's perk: quieter shooting
  };
}

/** A melee weapon's numbers with its upgrades applied. */
export function meleeStats(a: Arsenal, w: MeleeKind) {
  const base = MELEE[w];
  return { ...base, damage: base.damage * (1 + UPGRADE_EFFECT.damage * a.upgrades[w].damage) * (1 + (a.perks?.melee ?? 0)) };
}

/**
 * The fields of a Player that the rules read straight off the state. They belong to whoever `cur` is,
 * so a rule written for one player works unchanged for any: the step points `cur` at each player in
 * turn (and at each zombie's chosen target). In a solo run there is one player and `cur` never moves.
 */
const FORWARDED = [
  'arsenal', 'funds', 'kills', 'remaining', 'light', 'crouched', 'hide', 'roof', 'coughT', 'hold', 'work', 'safeT', 'speedMul', 'inFallen', 'storeLatch',
  'lockedNotice', 'killerId', 'flow', 'flowCell', 'escort', 'escortLost', 'pumping', 'dangerT', 'engineT', 'swarmT',
] as const;
type Forwarded = Pick<Player, (typeof FORWARDED)[number]>;

export interface GameState extends Forwarded {
  seed: number; // this chapter's level
  night: number; // the night's seed: every chapter's level comes from it
  chapter: number; // 0-based; the last one ends at the helicopter
  carry: Carry; // what you came into this chapter with
  /** `solo`: one player, one clock each. `room`: several at once, one room clock, nobody waits for anybody. */
  mode: 'solo' | 'room';
  phase: Phase;
  lossReason: LossReason | null;
  map: MapData;
  rng: Rng;
  elapsed: number;
  timeLimit: number;
  tier: number;
  players: Player[];
  /** The player the rules are acting for right now. */
  cur: Player;
  /** The same player (the body: position, health...). */
  readonly player: Player;
  /** Rooms: seats still free at the exit, the room's clock, and how it ended. */
  seatsLeft: number;
  roomLimit: number;
  placements: Placement[] | null;
  pickups: Pickup[];
  /** Rooms: the arsenals turned players left (what they had on them). */
  drops: Drop[];
  stores: Store[];
  houses: House[];
  survivors: Survivor[];
  alarms: Alarm[];
  alarmUsed: number[]; // parked cars (map.buildings indices) whose alarm has gone off
  thrown: Thrown[];
  /** Where the dead lie (bodies stay for the chapter). */
  corpses: Array<{ id: number; pos: Vec2; heading: number; half?: boolean }>;
  /** Objectives already looked at for guards (each gets its chance once, when it comes up). */
  guarded: TaskId[];
  zombies: Zombie[];
  vehicles: Vehicle[];
  crates: Crate[];
  tasks: Task[];
  safehouse: Vec2;
  safehouseKnown: boolean;
  /** A lit signal flare: everything near it goes to it while it burns. */
  flare: { pos: Vec2; t: number } | null;
  zombieMul: number;
  /** Pacing: a long quiet, one sound (`at`: where), then they come up around you. */
  director: { phase: 'quiet' | 'dread' | 'panic'; t: number; at: Vec2 | null };
  /** The order the district's blocks fall to the infection in (indices into map.blocks), and how many have. */
  fallOrder: number[];
  fallenN: number;
  /** People you found bitten and left. */
  abandoned: Abandoned[];
  /** What your last self drops when you put it down, and whether you have (a server reads this off a replay). */
  huskLoot: PickupKind | null;
  huskDown: boolean;
  events: GameEvent[];
  // internals
  /** A second stream for pacing, coughs and hidden bites, so they never shift the first. */
  rng2: Rng;
  nextZombieId: number;
}

/** Make the forwarded fields (and `player`) read and write whoever `cur` is. */
function bindPlayer(s: GameState): void {
  for (const k of FORWARDED) {
    Object.defineProperty(s, k, {
      get(this: GameState) { return this.cur[k]; },
      set(this: GameState, v: never) { this.cur[k] = v; },
      enumerable: true, configurable: true,
    });
  }
  Object.defineProperty(s, 'player', { get(this: GameState) { return this.cur; }, enumerable: true, configurable: true });
}

/** A fresh player: a seat, standing at a spot, carrying what is given. */
function newPlayer(id: number, at: Vec2, carry: Carry, cells: number, limit: number): Player {
  return {
    id, status: 'alive', pos: { ...at }, vel: { x: 0, y: 0 }, heading: 0, health: carry.health, invuln: 0, vehicleId: null, slowT: 0,
    arsenal: cloneArsenal(carry.arsenal), funds: carry.funds, kills: carry.kills, remaining: limit, light: true, crouched: false, hide: null, roof: null, coughT: 3,
    hold: { taskId: null, progress: 0 }, work: null, safeT: 0, speedMul: 1, inFallen: false, storeLatch: null, lockedNotice: null,
    killerId: null, flow: new Int16Array(cells), flowCell: -1, escort: null, escortLost: false, pumping: false, dangerT: 0, engineT: 0,
    swarmT: 0, downT: 0, lungeCd: 0, bitten: false, checks: {}, exposed: false, escapedAt: null, helped: 0,
  };
}

const dist = (a: Vec2, b: Vec2) => dhypot(a.x - b.x, a.y - b.y);
const wrap = (a: number) => datan2(dsin(a), dcos(a));
const approach = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

export function createGame(
  seed: number,
  lvl?: Level,
  opts: { night?: number; chapter?: number; carry?: Carry; husk?: Husk | null; spawns?: Vec2[]; loadout?: Loadout; loadouts?: ReadonlyArray<Loadout | undefined> } = {},
): GameState {
  const level = lvl ?? generateLevel(seed, { night: opts.night ?? seed, chapter: opts.chapter ?? 0 });
  // what each seat starts with: the carry given (a later chapter), or the standard kit plus that seat's loadout
  const carryFor = (seat: number): Carry => opts.carry ?? withLoadout({
    arsenal: {
      weapon: 'pistol', owned: ['pistol', 'baton'],
      mag: { pistol: GUNS.pistol.mag, shotgun: 0, rifle: 0 },
      ammo: { ...START_AMMO },
      upgrades: { pistol: noUpgrades(), shotgun: noUpgrades(), rifle: noUpgrades(), baton: noUpgrades(), bat: noUpgrades(), machete: noUpgrades() },
      fireCd: 0, reloadT: 0, swing: 0, bottles: START_BOTTLES, cans: 0, gear: { vest: 0, helmet: 0 },
    },
    health: PLAYER_HEALTH,
    funds: START_FUNDS,
    kills: 0,
  }, opts.loadouts ? opts.loadouts[seat] : opts.loadout);
  const carry = carryFor(0);
  const spawns = opts.spawns ?? [level.spawn];
  const cells = level.map.cols * level.map.cols;
  const roster = spawns.map((at, i) => newPlayer(i, at, i === 0 ? carry : carryFor(i), cells, level.timeLimit));
  const pl = roster[0]!;
  const state = {
    seed,
    night: opts.night ?? seed,
    chapter: opts.chapter ?? 0,
    carry: { ...carry, arsenal: cloneArsenal(carry.arsenal) },
    mode: (spawns.length > 1 ? 'room' : 'solo') as 'solo' | 'room',
    phase: 'playing' as const,
    lossReason: null,
    map: level.map,
    rng: createRng(seed ^ 0x9e3779b9),
    elapsed: 0,
    timeLimit: level.timeLimit,
    tier: 0,
    players: roster,
    cur: pl,
    seatsLeft: spawns.length > 1 ? Math.max(1, Math.ceil(spawns.length * EXIT_SEATS_SHARE)) : 0,
    roomLimit: spawns.length > 1 ? ROOM_SECONDS : 0,
    placements: null,
    guarded: [],
    corpses: [],
    pickups: level.pickups.map((p) => ({ ...p, pos: { ...p.pos } })),
    drops: [],
    stores: level.stores.map((st) => ({ ...st, pos: { ...st.pos } })),
    houses: level.houses.map((h) => ({ ...h, pos: { ...h.pos } })),
    survivors: level.survivors.map((v) => ({ ...v, pos: { ...v.pos }, fetchPos: { ...v.fetchPos }, targets: [] })),
    alarms: [],
    alarmUsed: [],
    thrown: [],
    zombies: [],
    vehicles: level.vehicles.map((v) => ({ ...v, pos: { ...v.pos } })),
    crates: level.crates.map((c) => ({ ...c, pos: { ...c.pos } })),
    tasks: level.tasks.map((t) => ({
      ...t, pos: { ...t.pos }, requires: t.requires.slice(),
      ...(t.parts ? { parts: t.parts.map((q) => ({ ...q })), got: t.got!.slice() } : {}),
    })),
    safehouse: { ...level.safehouse },
    flare: null,
    safehouseKnown: !level.tasks.some((t) => t.effect === 'reveal-exit'),
    zombieMul: 1,
    director: { phase: 'quiet' as const, t: 0, at: null },
    fallOrder: [],
    fallenN: 0,
    abandoned: [],
    huskLoot: null,
    huskDown: false,
    rng2: fork(seed, 'horror'),
    events: [],
    nextZombieId: 1,
  } as unknown as GameState;
  bindPlayer(state);
  populate(state);
  seedHorror(state, opts.husk ?? null);
  refreshFlow(state);
  return state;
}

/**
 * A room: `players` seats in one district at once (2 to ROOM_PLAYERS_MAX), a shared chain of steps, one
 * exit with seats for half of them. The level comes from the seed alone (no vehicles, nobody to escort),
 * so the server and every client build the same district.
 */
export function createRoom(seed: number, players: number, loadouts?: ReadonlyArray<Loadout | undefined>): GameState {
  const n = Math.max(2, Math.min(ROOM_PLAYERS_MAX, Math.floor(players)));
  const level = generateLevel(seed, { night: seed, chapter: 0, room: true, players: n, theme: roomCity(seed) });
  return createGame(seed, level, { night: seed, chapter: 0, spawns: level.spawns, loadouts });
}

/** Which city a room is in: any of the story's districts, rolled from its seed (more cities join as the content grows). */
export function roomCity(seed: number): Theme {
  const cities = [...new Set(content().story.chapters.map((c) => c.theme).filter((t): t is Theme => !!t))];
  return cities.length ? pick(fork(seed, 'room-city'), cities) : 'downtown';
}

/** The last chapter: its way out is the helicopter, not a door. */
export function finalChapter(s: GameState): boolean {
  return s.chapter >= CHAPTERS - 1;
}

/** Through the door: the next district, with everything you carry (and a bonus for time left). */
export function nextChapter(s: GameState, husk: Husk | null = null): GameState {
  const chapter = s.chapter + 1;
  const carry: Carry = {
    arsenal: s.arsenal,
    health: Math.min(PLAYER_HEALTH, s.player.health + CHAPTER_HEAL),
    funds: s.funds + chapterBonus(s),
    kills: s.kills,
  };
  return createGame(chapterSeed(s.night, chapter), undefined, { night: s.night, chapter, carry, husk });
}

/** Funds for the seconds left on the clock when you got out. */
export function chapterBonus(s: GameState): number {
  return Math.floor(s.remaining * CHAPTER_BONUS);
}

/** Start this chapter again, with what you came into it with. */
export function restartChapter(s: GameState, husk: Husk | null = null): GameState {
  return createGame(s.seed, undefined, { night: s.night, chapter: s.chapter, carry: s.carry, husk });
}

/** Where to go for a step right now: the nearest piece still to find, else the step itself. */
export function taskTarget(s: GameState, t: Task): Vec2 {
  if (t.parts && t.got) {
    let best: Vec2 | null = null, bd = Infinity;
    t.parts.forEach((q, i) => { if (!t.got![i]) { const d = dist(q, s.player.pos); if (d < bd) { bd = d; best = q; } } });
    if (best) return best;
  }
  return t.pos;
}

/** Pieces of a step found so far, and how many there are (null if it has none). */
export function partsOf(t: Task): { got: number; of: number } | null {
  return t.parts && t.got ? { got: t.got.filter(Boolean).length, of: t.parts.length } : null;
}

/** Objectives show up one at a time: done ones, optional ones, and the one you are on now. */
export function isRevealed(s: GameState, t: Task): boolean {
  return t.done || !t.required || t === currentTask(s);
}

/** Is this step one `cur` can do: anyone's (solo, optional ones), or, in a room, their own? */
export const mine = (s: GameState, t: Task): boolean => t.owner === undefined || t.owner === s.cur.id;

/** The required steps `cur` has to do (in a room, their own). */
export function myTasks(s: GameState): Task[] {
  return s.tasks.filter((t) => t.required && mine(s, t));
}

export function requiredDone(s: GameState): boolean {
  return s.tasks.every((t) => !t.required || t.done || !mine(s, t));
}

/** First incomplete required task whose dependencies are met (chain order). */
export function currentTask(s: GameState): Task | null {
  return s.tasks.find((t) => t.required && !t.done && mine(s, t) && depsMet(s, t)) ?? null;
}

function depsMet(s: GameState, t: Task): boolean {
  return t.requires.every((id) => s.tasks.some((x) => x.id === id && x.done));
}

/** Working an objective or talking to someone (or just finished): zombies hold back. */
export function isBusy(s: GameState): boolean { // rooms too: a step's circle is as safe as it is alone
  return covered(s.cur);
}
const covered = (p: Player) => p.hold.taskId !== null || (p.work !== null && p.work.kind !== 'climb') || p.safeT > 0; // climbing is not cover

export function playerVehicle(s: GameState): Vehicle | null {
  return s.player.vehicleId === null ? null : s.vehicles.find((v) => v.id === s.player.vehicleId) ?? null;
}

/** Current ground speed of the player (or their vehicle), units/s. */
export function playerSpeed(s: GameState): number {
  return dhypot(s.player.vel.x, s.player.vel.y);
}

function refreshFlow(s: GameState): void {
  const at = s.player.roof !== null ? s.map.ladders[s.player.roof]!.foot : s.player.pos; // up on a roof: the foot of your ladder
  const c = cellOf(s.map, at);
  if (c === s.flowCell) return;
  s.flowCell = c;
  withVehiclesBlocked(s, () => distanceField(s.map, at, s.flow));
}

// ---------------------------------------------------------------- crouching, hiding, the roofs

/** How high a player stands: on a roof, its height; on the ground, 0. */
export function heightOf(s: GameState, pl: Player = s.player): number {
  return pl.roof === null ? 0 : s.map.ladders[pl.roof]?.height ?? 0;
}

/** Keep a point on a ladder's roof. */
function onRoof(l: Ladder, p: Vec2): void {
  p.x = Math.max(l.roof.x0, Math.min(l.roof.x1, p.x));
  p.y = Math.max(l.roof.y0, Math.min(l.roof.y1, p.y));
}

/** The zombies that climb (the rest gather at the foot of the ladder). */
const climbs = (z: Zombie) => z.kind === 'runner' || z.kind === 'stalker';

function toggleCrouch(s: GameState): void {
  if (s.player.vehicleId !== null || s.player.hide !== null) return;
  s.player.crouched = !s.player.crouched;
  s.events.push({ type: 'crouch', on: s.player.crouched });
}

/** Into a hiding place: the ones already on you, close by, saw where you went; the rest lose you. */
function hideIn(s: GameState, spot: number): void {
  const h = s.map.hides[spot];
  if (!h) return;
  const pl = s.player;
  pl.hide = spot;
  pl.pos = { ...h.pos };
  pl.vel = { x: 0, y: 0 };
  pl.crouched = false;
  s.hold.taskId = null;
  s.hold.progress = 0;
  s.work = null;
  for (const z of s.zombies) {
    if (z.action === 'dead' || z.action === 'dormant') continue;
    const d = dist(z.pos, pl.pos), after = z.action === 'chase' || z.action === 'attack' || z.alertT > 0;
    if (after && d < HIDE_SEEN) { z.alertT = Math.max(z.alertT, 4); continue; }
    if (after) { z.alertT = 0; z.action = 'idle'; z.lureT = 0; }
  }
  s.events.push({ type: 'hide', on: true, spot });
}

function leaveHide(s: GameState): void {
  const spot = s.player.hide;
  if (spot === null) return;
  s.player.hide = null;
  s.events.push({ type: 'hide', on: false, spot });
}

/**
 * The roof rules for one zombie, when it or the player it is after is up on one. Returns true when it has had its
 * turn. One on the ground after a player up top: the climbers go up the ladder (it takes them a while at its foot);
 * the rest only crowd round below. One on a roof: after a player on the same roof it comes straight on and attacks as
 * on the ground; otherwise it goes back down.
 */
function roofTurn(s: GameState, z: Zombie, dt: number, d: number, aRange: number): { done: boolean; reach: boolean } {
  const up = s.player.roof, zr = z.roof ?? null;
  if (zr === null) {
    if (up === null) return { done: false, reach: true };
    const l = s.map.ladders[up]!;
    if (climbs(z) && dist(z.pos, l.foot) < 1.3) {
      z.climbT = (z.climbT ?? 0) + dt;
      z.speed = 0;
      z.heading = datan2(-l.out.y, -l.out.x);
      z.action = 'chase';
      if (z.climbT >= ZOMBIE_CLIMB_SECONDS) {
        z.climbT = 0;
        z.roof = up;
        z.pos = { ...l.top };
        s.events.push({ type: 'zombie-climbed', id: z.id, up: true });
      }
      return { done: true, reach: false };
    }
    z.climbT = 0;
    return { done: false, reach: false }; // it can come for you, but it cannot reach you
  }
  const l = s.map.ladders[zr]!;
  const before = { x: z.pos.x, y: z.pos.y };
  if (up === zr) { // on your roof: straight at you
    if (d < aRange && z.cooldown <= 0) {
      z.action = 'attack';
      z.actionT = ATTACK_WINDUP[z.kind];
      z.speed = 0;
      s.events.push({ type: 'zombie-attack', id: z.id });
      return { done: true, reach: true };
    }
    const own = (z.kind === 'runner' ? RUNNER_SPEED : STALKER_SPEED) * s.zombieMul;
    const dx = s.player.pos.x - z.pos.x, dy = s.player.pos.y - z.pos.y;
    if (d > 1e-6) { z.pos.x += (dx / d) * own * dt; z.pos.y += (dy / d) * own * dt; z.heading = datan2(dy, dx); }
    z.action = 'chase';
  } else { // you went down (or were never up here): back to the ladder, and down it
    const dx = l.top.x - z.pos.x, dy = l.top.y - z.pos.y, dl = dhypot(dx, dy);
    if (dl < 0.8) {
      z.roof = null;
      z.pos = { ...l.foot };
      s.events.push({ type: 'zombie-climbed', id: z.id, up: false });
      return { done: true, reach: false };
    }
    z.pos.x += (dx / dl) * WALKER_SPEED_BY_TIER[0] * dt; z.pos.y += (dy / dl) * WALKER_SPEED_BY_TIER[0] * dt;
    z.heading = datan2(dy, dx);
    z.action = 'wander';
  }
  onRoof(l, z.pos);
  z.speed = dt > 0 ? dhypot(z.pos.x - before.x, z.pos.y - before.y) / dt : 0;
  return { done: true, reach: up === zr };
}

/** Run a path search with the cells under vehicles treated as blocked, so paths go around cars. */
export function withVehiclesBlocked<T>(s: GameState, fn: () => T): T {
  const cols = s.map.cols, blocked = s.map.blocked, stamped: number[] = [];
  for (const v of s.vehicles) {
    for (const c of vehicleCircles(v)) {
      const r = c.r + 0.6;
      for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
        if (x < 0 || y < 0 || x >= cols || y >= cols) continue;
        const i = y * cols + x;
        if (blocked[i] === 0 && (x + 0.5 - c.x) ** 2 + (y + 0.5 - c.y) ** 2 < r * r) { blocked[i] = 1; stamped.push(i); }
      }
    }
  }
  try {
    return fn();
  } finally {
    for (const i of stamped) blocked[i] = 0;
  }
}

// ---------------------------------------------------------------- zombies: population and waves

function addZombie(s: GameState, kind: ZombieKind, pos0: Vec2, rising: boolean, rng: Rng = s.rng): Zombie {
  resolve(s.map, pos0, ZOMBIE_RADIUS);
  const pos = { ...onStreets(s.map, pos0) }; // never in a pocket you cannot reach (behind a bus, inside a wall)
  const z: Zombie = {
    id: s.nextZombieId++, kind, pos, heading: next(rng) * Math.PI * 2, speed: 0,
    action: rising ? 'rise' : 'idle', actionT: rising ? RISE_SECONDS : 0, cooldown: 0,
    health: ZOMBIE_HEALTH[kind], staggerT: 0, alertT: 0,
    wanderT: range(rng, 0, 3), wanderDir: { x: 0, y: 0 },
  };
  s.zombies.push(z);
  return z;
}

// ---------------------------------------------------------------- the plague: infection, light, pacing, the other infected

const byChapter = <T>(list: readonly T[], s: GameState): T => list[Math.min(s.chapter, list.length - 1)]!;

/** How far the infection has gone, 0 (the dose is fresh) to 1 (you turn). It is the clock. */
export function infection(s: GameState): number {
  return Math.max(0, Math.min(1, 1 - s.remaining / s.timeLimit));
}

/** How far the night has got, 0 to 1: your own infection when playing alone, the room's clock in a room. */
export function plagueProgress(s: GameState): number {
  return s.mode === 'room' ? Math.max(0, Math.min(1, s.elapsed / s.roomLimit)) : infection(s);
}

/** Your light is on (in a vehicle, the headlights always are). */
export function lightOn(s: GameState): boolean {
  return s.light || s.player.vehicleId !== null;
}

/** A point is in the beam of your flashlight (or headlights), with nothing in the way. */
export function inLight(s: GameState, pos: Vec2): boolean {
  if (!lightOn(s)) return false;
  const k = s.player.vehicleId !== null ? 'car' : 'foot';
  const p = s.player.pos, dx = pos.x - p.x, dy = pos.y - p.y, d = dhypot(dx, dy);
  if (d > LIGHT_RANGE[k]) return false;
  if (d > 1.2 && Math.abs(wrap(datan2(dy, dx) - s.player.heading)) > LIGHT_HALF_ANGLE[k]) return false;
  return s.player.roof !== null || lineClear(s.map, p, pos, 0.2); // from a roof the beam goes over the walls
}

/** How well they see you right now: worse with your light off and as you become one of them, better where the
 * district has fallen. */
export function sightScale(s: GameState): number {
  let k = (lightOn(s) ? 1 : LIGHT_OFF_SIGHT) * (s.player.crouched ? CROUCH_SIGHT : 1);
  const inf = infection(s);
  if (inf > 0.5) k *= 1 - INFECTED_CAMO * (inf - 0.5) * 2;
  if (s.inFallen) k *= FALLEN_SIGHT;
  return k;
}

/** The blocks that have fallen so far (indices into map.blocks). */
export function fallenBlocks(s: GameState): number[] {
  return s.fallOrder.slice(0, s.fallenN);
}

/** The block a point belongs to (with half the street around it), or -1. */
function blockAt(s: GameState, p: Vec2): number {
  const m = STREET / 2;
  return s.map.blocks.findIndex((b) => p.x >= b.x - m && p.x < b.x + b.size + m && p.y >= b.y - m && p.y < b.y + b.size + m);
}

function fallenWanted(s: GameState): number {
  const f = byChapter(FALLEN, s);
  return Math.floor(s.fallOrder.length * (f.from + (f.to - f.from) * plagueProgress(s)));
}

/** A dose: the infection is held back (never past a full clock). Returns the seconds gained. */
export function takeAntiviral(s: GameState): number {
  const gain = Math.max(0, Math.min(ANTIVIRAL_SECONDS, s.timeLimit - s.remaining));
  s.remaining += gain;
  s.events.push({ type: 'antiviral', seconds: gain });
  return gain;
}

/** What the plague adds to a district as it is made: the order its blocks fall in, bodies in the street
 * (some of them not dead), the ones that scream and the ones that stalk, and your last self. */
function seedHorror(s: GameState, husk: Husk | null): void {
  const rng = fork(s.seed, 'plague');
  const p = s.player.pos;
  const first = QUIET_FIRST;
  s.director.t = range(s.rng2, first[0], first[1]);

  // the spread: from one block outward, a neighbour at a time
  const land = s.map.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.district !== 'water');
  if (land.length) {
    const left = new Set(land.map((x) => x.i));
    const order: number[] = [];
    let edge = [pick(rng, land).i];
    while (left.size) {
      if (!edge.length) edge = [[...left][0]!];
      const i = edge.splice(Math.floor(next(rng) * edge.length), 1)[0]!;
      if (!left.delete(i)) continue;
      order.push(i);
      const a = s.map.blocks[i]!;
      for (const x of land) if (left.has(x.i) && Math.abs(x.b.i - a.i) + Math.abs(x.b.j - a.j) === 1) edge.push(x.i);
    }
    s.fallOrder = order;
    s.fallenN = fallenWanted(s);
  }

  // bodies in the street, clear of the start and of anything you have to stand at
  const keep = [...s.tasks.flatMap((t) => [t.pos, ...(t.parts ?? [])]), s.safehouse];
  const lying: Vec2[] = [];
  const spots = shuffle(rng, s.map.points);
  const body = (minFromYou: number): Vec2 | null => {
    while (spots.length) {
      const q = spots.pop()!;
      const at = { x: q.x + range(rng, -2.5, 2.5), y: q.y + range(rng, -2.5, 2.5) };
      if (s.map.blocked[cellOf(s.map, at)] === 1 || nearestPlayerDist(s, at) < minFromYou) continue;
      if (keep.some((k) => dist(k, at) < 7) || lying.some((k) => dist(k, at) < 9)) continue;
      lying.push(at);
      return at;
    }
    return null;
  };
  for (let k = 0; k < byChapter(DORMANT, s); k++) {
    const at = body(18);
    if (!at) break;
    const z = addZombie(s, next(rng) < 0.2 ? 'runner' : 'walker', at, false, rng);
    z.action = 'dormant';
  }
  for (let k = 0; k < BODIES; k++) {
    const at = body(8);
    if (!at) break;
    s.corpses.push({ id: s.nextZombieId++, pos: at, heading: next(rng) * Math.PI * 2 });
  }
  const far = (min: number): Vec2 | null => {
    for (let tries = 0; tries < 40; tries++) {
      const q = pick(rng, s.map.points);
      if (nearestPlayerDist(s, q) >= min) return { x: q.x + range(rng, -2, 2), y: q.y + range(rng, -2, 2) };
    }
    return null;
  };
  for (let k = 0; k < byChapter(SCREAMERS, s); k++) { const at = far(35); if (at) addZombie(s, 'screamer', at, false, rng); }
  for (let k = 0; k < byChapter(STALKERS, s); k++) { const at = far(55); if (at) addZombie(s, 'stalker', at, false, rng); }
  for (let k = 0; k < byChapter(CRAWLERS, s); k++) { const at = far(25); if (at) addZombie(s, 'crawler', at, false, rng); }
  for (let k = 0; k < byChapter(LASHERS, s); k++) { const at = far(45); if (at) addZombie(s, 'lasher', at, false, rng); }

  // whoever you were, the last time this district took you: near where it happened, with what you carried
  if (husk) {
    const at = s.map.points.filter((q) => dist(q, p) >= 22).sort((a, b) => dist(a, husk.pos) - dist(b, husk.pos))[0];
    if (at) {
      const z = addZombie(s, 'runner', { ...at }, false, rng);
      z.husk = true;
      z.health = HUSK_HEALTH;
      s.huskLoot = husk.weapon && husk.weapon !== 'pistol' && husk.weapon !== 'baton' ? husk.weapon : 'ammo';
    }
  }

  // the walk-in buildings: some of them lie in there among what you came to search, until you get close or loud
  const irng = fork(s.seed, 'interior-dead');
  for (const it of s.map.interiors) {
    const n = Math.round(range(irng, INTERIOR_DEAD[0], INTERIOR_DEAD[1] + (it.spots.length >= 40 ? 0.49 : -0.51)));
    const free = it.spots.filter((q) => dist(q, it.door) > 3);
    for (let k = 0; k < n && free.length; k++) {
      const at = free.splice(Math.floor(next(irng) * free.length), 1)[0]!;
      const z = addZombie(s, next(irng) < 0.25 ? 'runner' : 'walker', { ...at }, false, irng);
      z.action = 'dormant';
    }
  }
}

/** Another one down: the count, the reward, and what your last self was carrying. */
function killed(s: GameState, z: Zombie): void {
  s.kills++;
  s.funds += KILL_REWARD;
  s.events.push({ type: 'zombie-killed', id: z.id });
  if (!z.husk) return;
  s.funds += 40;
  s.huskDown = true;
  if (s.huskLoot) s.pickups.push({ id: s.pickups.reduce((m, q) => Math.max(m, q.id), 0) + 1, kind: s.huskLoot, pos: { ...z.pos }, taken: false });
  s.events.push({ type: 'husk-down', id: z.id });
}

/** A body that was not dead gets up. */
function wake(s: GameState, z: Zombie): void {
  z.action = 'rise';
  z.actionT = RISE_SECONDS * 0.8;
  z.alertT = ALERT_SECONDS + RISE_SECONDS;
  s.events.push({ type: 'dormant-wake', id: z.id });
}

/** The district falls block by block as the night goes on. */
function spread(s: GameState): void {
  const want = fallenWanted(s);
  while (s.fallenN < want) s.events.push({ type: 'block-fallen', block: s.fallOrder[s.fallenN++]! });
  const b = blockAt(s, s.player.pos);
  s.inFallen = b >= 0 && s.fallOrder.indexOf(b) >= 0 && s.fallOrder.indexOf(b) < s.fallenN;
}

/** Quiet, then one sound, then they come up out of the ground around you, then quiet again. */
/** A zombie walking along with a turned player (a few steps behind, not on top of them). */
function followLeader(s: GameState, z: Zombie, at: Vec2, dt: number): void {
  if (z.staggerT > 0) { z.staggerT -= dt; z.speed = 0; return; }
  const dx = at.x - z.pos.x, dy = at.y - z.pos.y, d = dhypot(dx, dy);
  const before = { x: z.pos.x, y: z.pos.y };
  if (d > 3) {
    const v = WALKER_SPEED_BY_TIER[s.tier]! * (z.kind === 'runner' ? 1.6 : 1.15) * s.zombieMul;
    z.pos.x += (dx / d) * v * dt;
    z.pos.y += (dy / d) * v * dt;
    z.heading = datan2(dy, dx);
    z.action = 'wander';
  } else z.action = 'idle';
  resolve(s.map, z.pos, ZOMBIE_RADIUS);
  z.speed = dt > 0 ? dhypot(z.pos.x - before.x, z.pos.y - before.y) / dt : 0;
}

/** Badly hurt: the night eases off a little (see MERCY_* in the config). */
const closeCall = (s: GameState): boolean => s.player.health < PLAYER_HEALTH * MERCY_HEALTH;

function updateDirector(s: GameState, dt: number): void {
  const d = s.director, p = s.player.pos;
  d.t -= dt * (d.phase === 'quiet' && s.inFallen ? 1 / FALLEN_QUIET : 1);
  if (d.t > 0) return;
  const near = (lo: number, hi: number) => {
    const ring = s.map.points.filter((q) => { const r = dist(q, p); return r >= lo && r <= hi; });
    return ring.length ? { ...pick(s.rng2, ring) } : null;
  };
  if (d.phase === 'quiet') {
    // not while you are busy, driving (the engine brings its own), or already being hunted by a pack
    const hunted = s.zombies.filter((z) => z.action === 'chase' && dist(z.pos, p) < 22).length;
    d.at = isBusy(s) || s.player.vehicleId !== null || hunted >= 4 || closeCall(s) ? null : near(11, 18); // nor when you are barely standing
    if (!d.at) { d.t = 8; return; }
    d.phase = 'dread';
    d.t = DREAD_SECONDS;
    s.events.push({ type: 'omen', pos: { ...d.at } });
  } else if (d.phase === 'dread') {
    const at = d.at && dist(d.at, p) < 26 ? d.at : near(10, 16);
    const b = byChapter(BURST, s);
    let n = 0;
    if (at) for (const kind of [...Array<ZombieKind>(b.runner).fill('runner'), ...Array<ZombieKind>(b.walker).fill('walker')]) {
      if (!roomFor(s)) break;
      const z = addZombie(s, kind, { x: at.x + range(s.rng2, -2.5, 2.5), y: at.y + range(s.rng2, -2.5, 2.5) }, true, s.rng2);
      z.alertT = BURST_ALERT;
      n++;
    }
    if (at && n) s.events.push({ type: 'burst', pos: { ...at }, count: n });
    d.phase = 'panic';
    d.t = PANIC_SECONDS;
  } else {
    d.phase = 'quiet';
    d.at = null;
    d.t = range(s.rng2, QUIET_SECONDS[0], QUIET_SECONDS[1]);
  }
}

/** Far enough along, you cough, and they hear it. */
function updateCough(s: GameState, dt: number): void {
  if (infection(s) < COUGH_FROM || s.player.vehicleId !== null) return;
  s.coughT -= dt;
  if (s.coughT > 0) return;
  s.coughT = range(s.rng2, COUGH_EVERY[0], COUGH_EVERY[1]);
  s.events.push({ type: 'cough', who: null, pos: { ...s.player.pos } });
  alertWithin(s, COUGH_NOISE);
}

/** Someone bitten turns: a runner where they stood (a moment before it moves). */
function turn(s: GameState, pos: Vec2): void {
  if (!roomFor(s)) return;
  const z = addZombie(s, 'runner', { ...pos }, false, s.rng2);
  z.staggerT = 1.5;
  z.alertT = 20;
}

function dropFromGroup(s: GameState, m: Escort): void {
  const rest = escortGroup(s).filter((x) => x !== m);
  const lead = rest.shift();
  if (!lead) { s.escort = null; s.escortLost = true; return; }
  lead.party = rest;
  s.escort = lead;
}

/** Leave someone behind (you found them bitten). They stay where they are, and turn in the end. */
export function leaveBehind(s: GameState, m: Escort): void {
  if (!escortGroup(s).includes(m)) return;
  dropFromGroup(s, m);
  s.abandoned.push({ name: m.name, skin: m.skin, scale: m.scale, pos: { ...m.pos }, turnT: m.turnT ?? 60 });
  s.events.push({ type: 'left-behind', name: m.name });
}

/** The people with you: who coughs, and who runs out of time. */
function updateBitten(s: GameState, dt: number): void {
  for (const m of escortGroup(s)) {
    if (m.coughEvery) {
      m.coughT = (m.coughT ?? m.coughEvery) - dt;
      if (m.coughT <= 0) { m.coughT = m.coughEvery * range(s.rng2, 0.8, 1.25); s.events.push({ type: 'cough', who: m.name, pos: { ...m.pos } }); }
    }
    if (m.bitten) m.turnT = (m.turnT ?? 0) - dt;
  }
  const gone = escortGroup(s).find((m) => m.bitten && (m.turnT ?? 0) <= 0);
  if (gone) {
    dropFromGroup(s, gone);
    turn(s, gone.pos);
    s.events.push({ type: 'escort-turned', name: gone.name, where: 'street' });
  }
  for (const a of s.abandoned) {
    a.turnT -= dt;
    if (a.turnT > 0) continue;
    turn(s, a.pos);
    s.events.push({ type: 'escort-turned', name: a.name, where: 'left' });
  }
  s.abandoned = s.abandoned.filter((a) => a.turnT > 0);
}

/** A screamer's call: everything in earshot knows where you are, and more come running from further off. */
function callOut(s: GameState, z: Zombie): void {
  let n = 0;
  for (const o of s.zombies) {
    if (o === z || o.action === 'dead' || o.action === 'rise' || o.latch != null || dist(o.pos, z.pos) > SCREAM_RADIUS) continue;
    if (o.action === 'dormant') { if (dist(o.pos, z.pos) < SCREAM_RADIUS * DORMANT_HEAR) { wake(s, o); n++; } continue; }
    if (o.alertT <= 0) n++;
    o.alertT = Math.max(o.alertT, SCREAM_ALERT);
    o.lureT = 0;
  }
  const p = s.player.pos;
  const ring = s.map.points.filter((q) => { const d = dist(q, p); return d >= 22 && d <= 38; });
  for (let k = 0; k < byChapter(SCREAM_RUNNERS, s) && ring.length && roomFor(s); k++) {
    const q = pick(s.rng2, ring);
    addZombie(s, 'runner', { x: q.x + range(s.rng2, -2, 2), y: q.y + range(s.rng2, -2, 2) }, true, s.rng2).alertT = SCREAM_ALERT + 6;
    n++;
  }
  s.events.push({ type: 'scream', id: z.id, pos: { ...z.pos }, count: n });
}

/** The city's resting population: denser downtown, thin in the outskirts, none near the start. */
function populate(s: GameState): void {
  const cap = ZOMBIE_CAP - 16 - INTERIORS * INTERIOR_DEAD[1]; // leave room for the waves, and the ones lying in the walk-ins
  const runners = CHAPTER_RUNNERS[Math.min(s.chapter, CHAPTER_RUNNERS.length - 1)]!; // deeper in, some of them run
  for (const b of s.map.blocks) {
    const rate = ZOMBIES_PER_BLOCK[b.district];
    const n = Math.floor(rate + next(s.rng));
    for (let k = 0; k < n && s.zombies.length < cap; k++) {
      for (let tries = 0; tries < 8; tries++) {
        // inside the block (yards, plazas, lots) or on its kerb
        const p = { x: b.x + range(s.rng, -3, b.size + 3), y: b.y + range(s.rng, -3, b.size + 3) };
        if (s.map.blocked[cellOf(s.map, p)] === 1 || nearestPlayerDist(s, p) < 28) continue;
        if (s.map.interiors.some((it) => p.x > it.x - 1 && p.x < it.x + it.w + 1 && p.y > it.y - 1 && p.y < it.y + it.h + 1)) continue; // the street's, not shut in a building
        addZombie(s, runners > 0 && next(s.rng) < runners ? 'runner' : 'walker', p, false);
        break;
      }
    }
  }
}

/** A wave arrives from just out of sight. Far-off zombies are recycled to make room. */
/** Make room under the cap by dropping the farthest one, if it is far enough not to be missed. */
function roomFor(s: GameState): boolean {
  if (s.zombies.length < ZOMBIE_CAP) return true;
  let far = -1, farD = 0;
  s.zombies.forEach((z, i) => { const d = nearestPlayerDist(s, z.pos); if (d > farD) { farD = d; far = i; } });
  if (far < 0 || farD < ZOMBIE_ACTIVE_RADIUS) return false;
  s.zombies.splice(far, 1);
  return true;
}

/**
 * When an objective comes up, it may be guarded: a pack milling about over the thing you need (or
 * over the pieces lying around). They stay put until they see or hear you.
 */
function guardCurrent(s: GameState): void {
  const t = currentTask(s);
  if (!t || s.guarded.includes(t.id)) return;
  s.guarded.push(t.id);
  if (t.kind === 'clear' || t.effect === 'escort-end' || t.needsEscort) return; // those bring their own trouble
  const ch = Math.min(s.chapter, GUARD_CHANCE.length - 1);
  if (next(s.rng) >= GUARD_CHANCE[ch]!) return;
  const spots = t.parts && t.got ? t.parts.filter((_, i) => !t.got![i]) : [t.pos];
  let n = 0;
  for (let k = 0; k < GUARDS[ch]!; k++) {
    const at = spots[k % spots.length]!;
    if (nearestPlayerDist(s, at) < 18 || !roomFor(s)) continue; // never drop them on top of you
    const a = next(s.rng) * Math.PI * 2, r = range(s.rng, 4, 7);
    addZombie(s, next(s.rng) < 0.25 + 0.15 * ch ? 'runner' : 'walker', { x: at.x + dcos(a) * r, y: at.y + dsin(a) * r }, false);
    const z = s.zombies[s.zombies.length - 1]!;
    z.lure = { ...at };
    z.lureT = 1e9; // they stay with it
    n++;
  }
  if (n) s.events.push({ type: 'guarded', id: t.id, count: n });
}

/** They heard the engine: runners come out of the side streets ahead of you and to the sides, to cut you off. */
function releaseSwarm(s: GameState, v: Vehicle): void {
  const n = SWARM[Math.min(s.chapter, SWARM.length - 1)]!;
  const ahead = { x: v.pos.x + dcos(v.heading) * 20, y: v.pos.y + dsin(v.heading) * 20 };
  const ring = s.map.points.filter((p) => { const d = dist(p, v.pos); return d >= 18 && d <= 40 && dist(p, ahead) < 30; });
  let k = 0;
  for (; k < n && roomFor(s); k++) {
    const p = pick(s.rng, ring.length > 0 ? ring : s.map.points);
    addZombie(s, 'runner', { x: p.x + range(s.rng, -2, 2), y: p.y + range(s.rng, -2, 2) }, false);
    s.zombies[s.zombies.length - 1]!.alertT = 20;
  }
  if (k) s.events.push({ type: 'swarm', count: k });
}

/** The way out is shown: a pack comes hunting from all round, and keeps coming for a while. */
function releaseChase(s: GameState): void {
  const c = CHASE[Math.min(s.chapter, CHASE.length - 1)]!;
  const kinds: ZombieKind[] = [...Array<ZombieKind>(c.runner).fill('runner'), ...Array<ZombieKind>(c.walker).fill('walker')];
  const ring = s.map.points.filter((p) => { const d = dist(p, s.player.pos); return d >= 24 && d <= 40; });
  let n = 0;
  for (const kind of kinds) {
    if (!roomFor(s)) break;
    const p = pick(s.rng, ring.length > 0 ? ring : s.map.points);
    addZombie(s, kind, { x: p.x + range(s.rng, -2, 2), y: p.y + range(s.rng, -2, 2) }, true);
    s.zombies[s.zombies.length - 1]!.alertT = CHASE_ALERT;
    n++;
  }
  s.events.push({ type: 'chase', count: n });
}

function spawnWave(s: GameState, tier: number): void {
  const wave = SPAWNS_BY_TIER[tier]!;
  const more = CHAPTER_WAVES[Math.min(s.chapter, CHAPTER_WAVES.length - 1)]!;
  const kinds: ZombieKind[] = [
    ...Array<ZombieKind>(Math.round(wave.runner * more)).fill('runner'), ...Array<ZombieKind>(Math.round(wave.walker * more)).fill('walker'),
  ];
  const ring = s.map.points.filter((p) => nearestPlayerDist(s, p) >= ZOMBIE_SPAWN_MIN_DIST && dist(p, s.player.pos) <= WAVE_SPAWN_MAX_DIST);
  for (const kind of kinds) {
    if (s.zombies.length >= ZOMBIE_CAP) {
      let far = -1, farD = 0;
      s.zombies.forEach((z, i) => { const d = nearestPlayerDist(s, z.pos); if (d > farD) { farD = d; far = i; } });
      if (far < 0 || farD < ZOMBIE_ACTIVE_RADIUS) break;
      s.zombies.splice(far, 1);
    }
    const p = pick(s.rng, ring.length > 0 ? ring : s.map.points);
    addZombie(s, kind, { x: p.x + range(s.rng, -2, 2), y: p.y + range(s.rng, -2, 2) }, true);
  }
}

function tierFor(fraction: number): number {
  return fraction > TIER_THRESHOLDS[0] ? 0 : fraction > TIER_THRESHOLDS[1] ? 1 : 2;
}

function lose(s: GameState, reason: LossReason): void {
  if (s.mode === 'room') { fall(s, s.cur, reason); return; } // in a room one player going down is not the end
  s.phase = 'lost';
  s.lossReason = reason;
  s.events.push({ type: 'lost', reason });
}

// ---------------------------------------------------------------- rooms: several players at once

/** Players still in the district (not out through the exit, not put down). */
const present = (p: Player) => p.status === 'alive' || p.status === 'down' || p.status === 'turned';

/** How far a point is from the nearest player still in the district. */
export function nearestPlayerDist(s: GameState, at: Vec2): number {
  let best = Infinity;
  for (const p of s.players) if (present(p)) { const d = dist(at, p.pos); if (d < best) best = d; }
  return best === Infinity ? dist(at, s.players[0]!.pos) : best;
}

/** Events that belong to one player (the rest are the district's and everyone may get them). */
const PERSONAL = new Set<GameEvent['type']>([
  'player-hit', 'gear-hit', 'gear-broken', 'bitten', 'grabbed', 'pickup', 'purchase', 'healed', 'equip', 'reload', 'empty', 'light', 'cough',
  'crate-opened', 'house-searched', 'checked', 'work-started', 'store-open', 'task-started', 'task-locked', 'safehouse-locked', 'puzzle-open', 'puzzle-wrong',
  'part-taken', 'seat-unearned', 'loot-taken', 'task-done', 'time-penalty', 'down', 'turned', 'escaped', 'lunge', 'antiviral', 'throw', 'survivor-asked', 'survivor-ready', 'survivor-done', 'fetched',
]);
function tagEvent(e: GameEvent, seat: number): void {
  if (PERSONAL.has(e.type) && (e as { seat?: number }).seat === undefined) (e as { seat?: number }).seat = seat;
  else if (e.type === 'shot' && e.shooter === undefined) e.shooter = seat; // not personal (the others hear it), but whose it is matters
}
/** Whose a personal event is (rooms), or undefined for the district's. */
export const eventSeat = (e: GameEvent): number | undefined => (e as { seat?: number }).seat;

/**
 * The living player a zombie goes for: the nearest it can reach, kept for a couple of seconds so it does not dither
 * between two at much the same distance. But not past someone standing right in front of it: when another is
 * clearly nearer (a player standing still that the crowd chasing you walks up to), it turns on them.
 */
function pickTarget(s: GameState, z: Zombie, dt: number): Player | null {
  z.targetT = (z.targetT ?? 0) - dt;
  const cost = (q: Player) => dist(z.pos, q.pos) + (q.roof !== null && !climbs(z) ? 15 : 0) + (q.hide !== null ? 10 : 0) + (covered(q) ? 12 : 0); // out of reach, out of sight, or working a step
  let held = z.targetId !== undefined && z.targetT > 0 ? s.players[z.targetId] : undefined;
  if (held && (held.status !== 'alive' || dist(z.pos, held.pos) > ZOMBIE_ACTIVE_RADIUS)) held = undefined;
  let t: Player | undefined, best = ZOMBIE_ACTIVE_RADIUS;
  for (const q of s.players) {
    if (q.status !== 'alive') continue;
    const d = cost(q);
    if (d < best) { best = d; t = q; }
  }
  if (held && (!t || cost(held) <= best + TARGET_SWITCH)) return held;
  if (t) { z.targetId = t.id; z.targetT = TARGET_HOLD; }
  return t ?? null;
}

/**
 * Can `a` hurt `b` right now? The living never hurt each other (they race for the seats, they do not fight for
 * them); the living can always put down the turned; the turned can bite the living anywhere but near the exit or in a step's circle.
 */
function canHurt(s: GameState, a: Player, b: Player): boolean {
  if (a === b || (b.status !== 'alive' && b.status !== 'turned')) return false;
  if (a.status !== 'alive' && a.status !== 'turned') return false;
  if (a.status === b.status) return false;
  if (b.status === 'turned') return true;
  if (covered(b)) return false; // working a step: its circle is safe from the turned too
  return dist(a.pos, s.safehouse) > SAFE_RADIUS && dist(b.pos, s.safehouse) > SAFE_RADIUS;
}

/** The first other player a shot passes through before `maxT`, if any. */
function playerOnRay(s: GameState, from: Vec2, dx: number, dy: number, maxT: number): { who: Player; t: number } | null {
  let best: { who: Player; t: number } | null = null;
  for (const o of s.players) {
    if (o === s.cur || !canHurt(s, s.cur, o)) continue;
    const ox = o.pos.x - from.x, oy = o.pos.y - from.y, t = ox * dx + oy * dy;
    if (t <= 0 || t >= (best?.t ?? maxT)) continue;
    if (Math.abs(ox * dy - oy * dx) > PLAYER_RADIUS + 0.2) continue;
    best = { who: o, t };
  }
  return best;
}

/** One player hurts another: a living one shooting a turned one, or a turned one's bite (gear takes its share first). */
function hurtOther(s: GameState, by: Player, victim: Player, amount: number): void {
  const was = s.cur;
  s.cur = victim;
  const took = hurtPlayer(s, amount);
  s.events.push({ type: 'player-hit', damage: took, by: -1 - by.id, seat: victim.id });
  if (victim.health <= 0) {
    victim.health = 0;
    victim.killerId = null;
    by.kills++;
    by.funds += PVP_KILL_REWARD;
    if (victim.status === 'alive') fall(s, victim, 'caught');
    else if (victim.status === 'turned') { victim.status = 'dead'; s.events.push({ type: 'down', seat: victim.id }); }
  }
  s.cur = was;
}

/** A player is out: lying still for a moment before they turn (health), or turning at once (the dose ran out). */
function fall(s: GameState, pl: Player, reason: LossReason): void {
  if (pl.status !== 'alive') return;
  pl.hold = { taskId: null, progress: 0 };
  pl.work = null;
  if (reason === 'time') { turnPlayer(s, pl); return; }
  pl.status = 'down';
  pl.downT = DOWN_SECONDS;
  pl.vel = { x: 0, y: 0 };
  s.events.push({ type: 'down', seat: pl.id });
}

/** Now one of them: fast, melee only, the zombies leave them alone. */
function turnPlayer(s: GameState, pl: Player): void {
  pl.status = 'turned';
  pl.health = TURNED_HEALTH;
  pl.speedMul = RUNNER_SPEED / PLAYER_SPEED;
  pl.light = false;
  pl.crouched = false; // up on its feet: they do not creep
  pl.hold = { taskId: null, progress: 0 };
  pl.work = null;
  pl.lungeCd = 0;
  dropKit(s, pl);
  s.events.push({ type: 'turned', seat: pl.id, pos: { ...pl.pos } });
}

/** What a player had on them is left where they turned, an arsenal for whoever takes it first; they keep none of it. */
function dropKit(s: GameState, pl: Player): void {
  const a = pl.arsenal;
  const ammo: Partial<Record<GunKind, number>> = {};
  for (const g of Object.keys(a.ammo) as GunKind[]) { const n = a.ammo[g] + (a.owned.includes(g) ? a.mag[g] : 0); if (n > 0) ammo[g] = n; a.ammo[g] = 0; a.mag[g] = 0; }
  const gear: Partial<Record<GearKind, number>> = {};
  for (const g of Object.keys(a.gear) as GearKind[]) { if (a.gear[g] > 0) gear[g] = a.gear[g]; a.gear[g] = 0; }
  const loot = { weapons: [...a.owned], ammo, bottles: a.bottles, cans: a.cans, gear, funds: pl.funds };
  a.owned = []; a.weapon = null; a.bottles = 0; a.cans = 0; a.reloadT = 0; pl.funds = 0;
  if (!loot.weapons.length && !Object.keys(ammo).length && !loot.bottles && !loot.cans && !Object.keys(gear).length && !loot.funds) return;
  s.drops.push({ id: s.drops.length, pos: { ...pl.pos }, from: pl.id, taken: false, loot });
}

/** Take the arsenal someone left when they turned (USE): everything in it is yours, and what is in your hand stays there. */
function takeDrop(s: GameState, d: Drop | undefined): void {
  if (!d || d.taken || !d.loot || d.from === s.cur.id) return;
  const a = s.arsenal;
  d.taken = true;
  const L = d.loot, items: string[] = [];
  for (const w of L.weapons) if (!a.owned.includes(w)) { a.owned.push(w); if (isGun(w)) a.mag[w] = 0; items.push(w); }
  for (const [g, n] of Object.entries(L.ammo) as Array<[GunKind, number]>) { a.ammo[g] += n; items.push(`${n} ${g} rounds`); }
  if (L.bottles) { a.bottles += L.bottles; items.push(`${L.bottles} bottles`); }
  if (L.cans) { a.cans += L.cans; items.push(`${L.cans} fuel`); }
  for (const [g, n] of Object.entries(L.gear) as Array<[GearKind, number]>) if (n > a.gear[g]) { a.gear[g] = n; items.push(g); }
  s.funds += L.funds;
  if (!a.weapon && a.owned.length) a.weapon = a.owned[0]!;
  s.events.push({ type: 'loot-taken', from: d.from, items, funds: L.funds });
}

/** A turned player's lunge: everything living in front of them, close, is hit at full strength. */
function lunge(s: GameState, pl: Player): void {
  pl.lungeCd = LUNGE_COOLDOWN;
  let hits = 0;
  for (const o of s.players) {
    if (o.status !== 'alive' || !canHurt(s, pl, o)) continue;
    const d = dist(o.pos, pl.pos);
    if (d > ATTACK_REACH || (d > 0.8 && Math.abs(wrap(datan2(o.pos.y - pl.pos.y, o.pos.x - pl.pos.x) - pl.heading)) > LUNGE_ARC)) continue;
    hurtOther(s, pl, o, ATTACK_DAMAGE);
    hits++;
  }
  s.events.push({ type: 'lunge', seat: pl.id, pos: { ...pl.pos }, hits });
}

/** Walking into the exit with the steps done: out, if there is still a seat. */
function updateExit(s: GameState): void {
  const pl = s.cur;
  if (pl.status !== 'alive') return;
  if (dist(s.safehouse, pl.pos) >= SAFEHOUSE_RADIUS) { pl.lockedNotice = null; return; }
  if (requiredDone(s)) { // every one of your own steps done: a seat, while there is one
    if (s.seatsLeft <= 0) return;
    pl.status = 'escaped';
    pl.escapedAt = s.elapsed;
    pl.vel = { x: 0, y: 0 };
    s.seatsLeft--;
    s.events.push({ type: 'escaped', seat: pl.id });
  } else if (pl.lockedNotice !== 'safehouse') {
    pl.lockedNotice = 'safehouse';
    s.events.push({ type: 'safehouse-locked' });
  }
}

/** How each seat finished: out through the exit first (earliest first), then the rest by what they did. */
export function placementsOf(s: GameState): Placement[] {
  return s.players
    .map((p) => ({ seat: p.id, status: p.status, escapedAt: p.escapedAt, kills: p.kills }))
    .sort((a, b) => (a.escapedAt === null ? 1 : 0) - (b.escapedAt === null ? 1 : 0) || (a.escapedAt ?? 0) - (b.escapedAt ?? 0) || b.kills - a.kills || a.seat - b.seat);
}

function finishRound(s: GameState): void {
  for (const p of s.players) if (p.status === 'alive' || p.status === 'down') p.status = 'missed';
  s.placements = placementsOf(s);
  s.phase = s.players.some((p) => p.status === 'escaped') ? 'won' : 'lost';
  s.events.push({ type: 'round-end', placements: s.placements });
}

/** One simulated step of a room: every seat acts, then the district does. Seats with no input stand still. */
function stepRoom(s: GameState, inputs: readonly Input[], dt: number): GameState {
  const idle: Input = { dx: 0, dy: 0 };
  const first = s.cur;
  const alive = s.players.filter((p) => p.status === 'alive');
  const turnOf = (): Player => alive[Math.floor(s.elapsed / 7) % Math.max(1, alive.length)] ?? s.players[0]!; // waves and the director take turns at who they look at

  const frac = 1 - s.elapsed / s.roomLimit;
  s.cur = turnOf();
  const tier = tierFor(frac);
  while (s.tier < tier) {
    s.tier++;
    s.events.push({ type: 'tier-up', tier: s.tier });
    spawnWave(s, s.tier);
  }
  const want = fallenWanted(s);
  while (s.fallenN < want) s.events.push({ type: 'block-fallen', block: s.fallOrder[s.fallenN++]! });

  for (const pl of s.players) {
    if (!present(pl)) continue;
    s.cur = pl;
    const mark = s.events.length;
    const input = inputs[pl.id] ?? idle;
    pl.invuln = Math.max(0, pl.invuln - dt);
    pl.lungeCd = Math.max(0, pl.lungeCd - dt);
    const b = blockAt(s, pl.pos);
    pl.inFallen = b >= 0 && s.fallOrder.indexOf(b) >= 0 && s.fallOrder.indexOf(b) < s.fallenN;
    if (pl.status === 'down') {
      pl.downT -= dt;
      if (pl.downT <= 0) turnPlayer(s, pl);
    } else if (pl.status === 'turned') {
      movePlayer(s, input, dt);
      if (input.fire && pl.lungeCd <= 0) lunge(s, pl);
    } else {
      pl.remaining -= dt;
      if (pl.remaining <= 0) { pl.remaining = 0; fall(s, pl, 'time'); }
      else playerTurn(s, pl, input, dt);
    }
    for (let i = mark; i < s.events.length; i++) tagEvent(s.events[i]!, pl.id);
  }

  s.cur = turnOf();
  updateThrown(s, dt);
  updateAlarms(s, dt);
  updateFlare(s, dt);
  updateDirector(s, dt);
  updateZombies(s, dt);
  s.cur = first;

  if (s.seatsLeft <= 0 || s.elapsed >= s.roomLimit || !s.players.some((p) => p.status === 'alive' || p.status === 'down')) finishRound(s);
  return s;
}

/** What a living player does in one step of a room (the single-player step, for one body, without vehicles or company). */
function playerTurn(s: GameState, pl: Player, input: Input, dt: number): void {
  if (input.light) { pl.light = !pl.light; s.events.push({ type: 'light', on: pl.light }); }
  if (input.crouch) toggleCrouch(s);
  if (input.action) interact(s);
  pl.slowT = Math.max(0, pl.slowT - dt);
  if (pl.hide === null) { // hidden: you keep still and keep quiet
    updateWeapons(s, input, dt);
    if (input.throw) throwBottle(s);
  }
  if (pl.roof === null && pl.hide === null) { takePickups(s); takeParts(s); }
  guardCurrent(s);
  movePlayer(s, input, dt);
  if (pl.roof === null) enterStores(s);
  updateWork(s, dt);
  updateSurvivors(s);
  updateClear(s);
  updateCough(s, dt);
  pl.safeT = Math.max(0, pl.safeT - dt);
  pl.dangerT = Math.max(0, pl.dangerT - dt);
  refreshFlow(s);
  updateTasks(s, dt);
  updateExit(s);
}

// ---------------------------------------------------------------- the step

/** Advance the game by dt seconds. Mutates and returns state. */
export function step(s: GameState, inputs: Input | readonly Input[], dt: number): GameState {
  s.events.length = 0;
  if (s.phase !== 'playing') return s;
  s.elapsed += dt;
  if (s.mode === 'room') return stepRoom(s, Array.isArray(inputs) ? inputs : [inputs as Input], dt);
  const input: Input = Array.isArray(inputs) ? (inputs[0] ?? { dx: 0, dy: 0 }) : (inputs as Input);
  s.remaining -= dt;
  if (s.remaining <= 0) {
    s.remaining = 0;
    lose(s, 'time');
    return s;
  }

  // escalation tied to the clock fraction
  const tier = tierFor(s.remaining / s.timeLimit);
  while (s.tier < tier) {
    s.tier++;
    s.events.push({ type: 'tier-up', tier: s.tier });
    spawnWave(s, s.tier);
  }
  spread(s);
  if (input.light && s.player.vehicleId === null) { s.light = !s.light; s.events.push({ type: 'light', on: s.light }); }
  if (input.crouch) toggleCrouch(s);

  if (input.action) interact(s);
  s.player.invuln = Math.max(0, s.player.invuln - dt);
  s.player.slowT = Math.max(0, s.player.slowT - dt);
  if (s.player.vehicleId === null && s.player.hide === null) { // hidden: you keep still and keep quiet
    updateWeapons(s, input, dt);
    if (input.throw) throwBottle(s);
    if (s.player.roof === null) takePickups(s);
  }
  if (s.player.roof === null && s.player.hide === null) takeParts(s);
  guardCurrent(s);

  const driving = playerVehicle(s);
  if (driving) {
    drive(driving, input, dt, 1 - LATCH_DRAG * latchedOn(s, driving.id));
    burnFuel(s, driving, dt);
    s.engineT -= dt;
    s.swarmT -= dt;
    if (s.swarmT <= 0) { s.swarmT = SWARM_EVERY; releaseSwarm(s, driving); }
    if (s.engineT <= 0) { s.engineT = ENGINE_NOISE_EVERY; alertWithin(s, driving.kind === 'bike' ? ENGINE_NOISE.bike : ENGINE_NOISE.car); }
  }
  else movePlayer(s, input, dt);
  pumpFuel(s, dt);
  for (const v of s.vehicles) moveVehicle(s, v, dt, v === driving);
  const still = playerVehicle(s); // a wreck may have thrown the player out
  if (still) {
    s.player.pos.x = still.pos.x;
    s.player.pos.y = still.pos.y;
    s.player.vel = { x: dcos(still.heading) * still.speed, y: dsin(still.heading) * still.speed };
    s.player.heading = still.heading;
  }

  if (s.player.roof === null) enterStores(s);
  updateWork(s, dt);
  updateThrown(s, dt);
  updateAlarms(s, dt);
  updateSurvivors(s);
  updateEscort(s, dt);
  updateFlare(s, dt);
  updateClear(s);
  updateDirector(s, dt);
  updateCough(s, dt);
  updateBitten(s, dt);
  s.safeT = Math.max(0, s.safeT - dt);
  s.dangerT = Math.max(0, s.dangerT - dt);
  refreshFlow(s);
  updateTasks(s, dt);
  if (s.phase !== 'playing') return s;
  updateSafehouse(s);
  if (s.phase !== 'playing') return s;
  updateZombies(s, dt);
  return s;
}

// ---------------------------------------------------------------- interactions

/** Distance from p to a vehicle's body (0 or less means touching). */
function vehicleReach(v: Vehicle, p: Vec2): number {
  const spec = VEHICLES[v.kind];
  const hx = dcos(v.heading), hy = dsin(v.heading);
  const t = Math.max(-spec.length / 2, Math.min(spec.length / 2, (p.x - v.pos.x) * hx + (p.y - v.pos.y) * hy));
  return dhypot(p.x - (v.pos.x + hx * t), p.y - (v.pos.y + hy * t)) - spec.width / 2;
}

/** What the Use button would do right now, if anything. */
export function interactionFor(s: GameState): Interaction | null {
  if (s.phase !== 'playing') return null;
  const v = playerVehicle(s);
  if (v) return { kind: 'exit', vehicleId: v.id };
  const p = s.player.pos;
  if (s.player.hide !== null) return { kind: 'unhide' };
  if (s.work?.kind === 'climb') return null;
  if (s.player.roof !== null) { // up top there is only the way down
    const l = s.map.ladders[s.player.roof]!;
    return dist(l.top, p) < LADDER_REACH ? { kind: 'climb', ladder: l.id, up: false } : null;
  }
  const task = s.tasks.find((t) => !t.done && isRevealed(s, t) && s.hold.taskId !== t.id && dist(t.pos, p) < TASK_RADIUS
    && (!t.got || t.got.every(Boolean)) && t.kind !== 'clear');
  if (task) return { kind: 'task', taskId: task.id };
  const store = s.stores.find((st) => dist(st.pos, p) < USE_RADIUS);
  if (store) return { kind: 'store', storeId: store.id };
  if (s.work) return null; // busy: one job at a time
  const drop = s.drops.find((d) => !d.taken && d.from !== s.cur.id && dist(d.pos, p) < PICKUP_RADIUS + 0.6);
  if (drop) return { kind: 'arsenal', dropId: drop.id };
  const arm = s.pickups.find((k) => !k.taken && isWeaponKind(k.kind) && dist(k.pos, p) < PICKUP_RADIUS + 0.4);
  if (arm) return { kind: 'weapon', pickupId: arm.id, weapon: arm.kind as WeaponKind };
  const sv = s.survivors.find((v) => v.status !== 'done' && dist(v.pos, p) < 2.6);
  if (sv) return { kind: 'talk', survivorId: sv.id };
  const house = s.houses.find((h) => !h.searched && dist(h.pos, p) < 1.8);
  if (house) return { kind: 'house', houseId: house.id };
  const crate = s.crates.find((c) => !c.opened && dist(c.pos, p) < USE_RADIUS * 0.75);
  if (crate) return { kind: 'crate', crateId: crate.id };
  const ladder = s.map.ladders.find((l) => dist(l.foot, p) < LADDER_REACH);
  if (ladder && s.player.slowT <= 0 && !s.escort) return { kind: 'climb', ladder: ladder.id, up: true }; // not with one on your leg, nor with people who cannot follow
  let best: Vehicle | null = null, bestD = 1.6;
  for (const c of s.vehicles) {
    if (c.wrecked) continue;
    const d = vehicleReach(c, p);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (best && s.arsenal.cans > 0 && best.fuel < 0.95) return { kind: 'refuel', vehicleId: best.id };
  if (best) return { kind: 'enter', vehicleId: best.id };
  const parked = parkedCarNear(s, p, 1.6);
  if (parked !== null) return { kind: 'alarm', car: parked };
  // standing with the people you are bringing in: look the nearest one over, or leave one you found bitten
  if (playerSpeed(s) < 1) {
    let who = -1, wd = CHECK_RADIUS;
    escortGroup(s).forEach((m, i) => { const d = dist(m.pos, p); if (m.checked !== 'clean' && !m.riding && d < wd) { wd = d; who = i; } });
    if (who >= 0) return { kind: escortGroup(s)[who]!.checked === 'bitten' ? 'leave' : 'check', who };
    // in a room: look another survivor over (who is the seat). They may be bitten and hiding it; so may you be, to them.
    if (s.mode === 'room') {
      let seat = -1, sd = CHECK_RADIUS;
      for (const o of s.players) { const d = dist(o.pos, p); if (o !== s.cur && o.status === 'alive' && d < sd) { sd = d; seat = o.id; } }
      if (seat >= 0) return { kind: 'check', who: seat };
    }
  }
  // last of all: somewhere to hide
  let hide = -1, hd = HIDE_REACH;
  for (const h of s.map.hides) { const d = dist(h.pos, p); if (d < hd) { hd = d; hide = h.id; } }
  if (hide >= 0 && !s.escort) return { kind: 'hide', spot: hide }; // not with people to look after
  return null;
}

/** A parked (undrivable) car within reach whose alarm has not gone off yet. */
function parkedCarNear(s: GameState, p: Vec2, reach: number): number | null {
  for (const idx of nearbyObstacles(s.map, p, reach, [])) {
    const b = s.map.buildings[idx]!;
    if (b.kind !== 'car' || s.alarmUsed.includes(idx)) continue;
    const nx = Math.max(b.x, Math.min(p.x, b.x + b.w)), ny = Math.max(b.y, Math.min(p.y, b.y + b.h));
    if (dhypot(p.x - nx, p.y - ny) < reach) return idx;
  }
  return null;
}

function interact(s: GameState): void {
  const it = interactionFor(s);
  if (!it) return;
  switch (it.kind) {
    case 'exit': exitVehicle(s); break;
    case 'enter': {
      const v = s.vehicles.find((x) => x.id === it.vehicleId)!;
      const need = escortGroup(s).length, seats = SEATS[v.kind];
      if (need > seats) { s.events.push({ type: 'no-room', need, seats }); return; } // a car, then
      s.player.vehicleId = it.vehicleId;
      s.swarmT = 0;
      s.hold.taskId = null;
      s.hold.progress = 0;
      s.events.push({ type: 'vehicle-enter', id: it.vehicleId });
      break;
    }
    case 'task': {
      const t = s.tasks.find((x) => x.id === it.taskId)!;
      if (!depsMet(s, t)) {
        s.events.push({ type: 'task-locked', id: t.id, needs: t.requires.filter((id) => !s.tasks.some((x) => x.id === id && x.done)) });
        return;
      }
      if (t.needsEscort && !(s.escortLost && !s.escort) && (!s.escort || escortGroup(s).some((m) => dist(m.pos, s.player.pos) > ESCORT_NEAR + 2.5))) {
        s.events.push({ type: 'escort-behind' }); // they have to be with you
        return;
      }
      if (t.kind === 'puzzle') { // the puzzle page: solved there, through solvePuzzle
        s.events.push({ type: 'puzzle-open', id: t.id });
        return;
      }
      s.work = null;
      s.hold.taskId = t.id;
      s.hold.progress = 0;
      s.events.push({ type: 'task-started', id: t.id });
      break;
    }
    case 'store':
      s.storeLatch = it.storeId;
      s.events.push({ type: 'store-open', id: it.storeId });
      break;
    case 'crate': {
      const c = s.crates.find((x) => x.id === it.crateId)!;
      c.opened = true;
      s.events.push({ type: 'crate-opened', id: c.id, loot: c.loot });
      giveLoot(s, c.loot);
      break;
    }
    case 'house': startWork(s, 'search', it.houseId, SEARCH_SECONDS * (1 - (s.arsenal.perks?.search ?? 0))); break;
    case 'talk': startWork(s, 'talk', it.survivorId, TALK_SECONDS); break;
    case 'refuel': startWork(s, 'refuel', it.vehicleId, REFUEL_SECONDS); break;
    case 'alarm': startAlarm(s, it.car); break;
    case 'check': startWork(s, 'check', it.who, CHECK_SECONDS); break;
    case 'leave': { const m = escortGroup(s)[it.who]; if (m) leaveBehind(s, m); break; }
    case 'climb': s.player.crouched = false; startWork(s, 'climb', it.ladder, CLIMB_SECONDS); break;
    case 'hide': hideIn(s, it.spot); break;
    case 'unhide': leaveHide(s); break;
    case 'weapon': {
      const pk = s.pickups.find((k) => k.id === it.pickupId)!;
      pk.taken = true;
      giveWeapon(s, it.weapon);
      s.events.push({ type: 'pickup', kind: it.weapon, amount: isGun(it.weapon) ? GUNS[it.weapon].mag : 0 });
      break;
    }
    case 'arsenal': takeDrop(s, s.drops.find((d) => d.id === it.dropId)!); break;
  }
}

function giveLoot(s: GameState, loot: Loot): void {
  if (loot === 'medkit') {
    const before = s.player.health;
    s.player.health = Math.min(PLAYER_HEALTH, s.player.health + MEDKIT_HEAL);
    s.events.push({ type: 'healed', amount: s.player.health - before });
  } else if (loot === 'antiviral') takeAntiviral(s);
  else if (loot === 'vest' || loot === 'helmet') wearGear(s, loot);
  else if (loot === 'supplies') s.funds += 25;
  else if (loot === 'ammo') {
    const w = ammoTarget(s);
    const n = Math.ceil(GUNS[w].ammoPack / 2);
    s.arsenal.ammo[w] += n;
    s.events.push({ type: 'pickup', kind: 'ammo', amount: n });
  } else if (loot === 'bottles') {
    s.arsenal.bottles += 2;
    s.events.push({ type: 'pickup', kind: 'bottles', amount: 2 });
  }
}

// ---------------------------------------------------------------- short jobs: search, talk, refuel

function startWork(s: GameState, kind: Work['kind'], id: number, seconds: number): void {
  s.work = { kind, id, progress: 0, seconds };
  s.hold.taskId = null;
  s.hold.progress = 0;
  s.events.push({ type: 'work-started', kind });
}

function workTarget(s: GameState, w: Work): Vec2 | null {
  if (w.kind === 'climb') { const l = s.map.ladders[w.id]; return l ? (s.player.roof === null ? l.foot : l.top) : null; }
  if (w.kind === 'search') return s.houses.find((h) => h.id === w.id)?.pos ?? null;
  if (w.kind === 'talk') return s.survivors.find((v) => v.id === w.id)?.pos ?? null;
  if (w.kind === 'check') return s.mode === 'room' ? (s.players[w.id]?.status === 'alive' ? s.players[w.id]!.pos : null) : escortGroup(s)[w.id]?.pos ?? null;
  return s.vehicles.find((v) => v.id === w.id)?.pos ?? null;
}

function updateWork(s: GameState, dt: number): void {
  const w = s.work;
  if (!w) return;
  const at = workTarget(s, w);
  const reach = w.kind === 'refuel' ? 5 : w.kind === 'check' ? CHECK_RADIUS + 1.5 : 3;
  if (!at || s.player.vehicleId !== null || dist(at, s.player.pos) > reach) { s.work = null; return; } // walked off
  w.progress += dt / w.seconds;
  if (w.progress < 1) return;
  s.work = null;
  if (w.kind === 'climb') { // at the top (or the bottom)
    const l = s.map.ladders[w.id]!, up = s.player.roof === null;
    s.player.roof = up ? l.id : null;
    s.player.pos = { ...(up ? l.top : l.foot) };
    s.player.vel = { x: 0, y: 0 };
    s.flowCell = -1;
    s.events.push({ type: 'climbed', ladder: l.id, up });
    return;
  }
  s.safeT = SAFE_AFTER;
  if (w.kind === 'search') {
    const h = s.houses.find((x) => x.id === w.id)!;
    h.searched = true;
    s.events.push({ type: 'house-searched', id: h.id, loot: h.loot, ambush: h.ambush });
    giveLoot(s, h.loot);
    if (h.ambush) {
      // one of them was inside: it comes through the door after you
      const before = s.zombies.length;
      addZombie(s, 'walker', { x: h.pos.x, y: h.pos.y - 1.6 }, false);
      const z = s.zombies[before];
      if (z) { z.alertT = ALERT_SECONDS; z.action = 'chase'; z.heading = Math.PI / 2; }
    }
  } else if (w.kind === 'talk') {
    talkTo(s, s.survivors.find((x) => x.id === w.id)!);
  } else if (w.kind === 'check' && s.mode === 'room') {
    const o = s.players[w.id];
    if (!o) return;
    s.cur.checks[o.id] = o.bitten;
    s.events.push({ type: 'checked', name: `Survivor ${o.id + 1}`, bitten: o.bitten });
  } else if (w.kind === 'check') {
    const m = escortGroup(s)[w.id];
    if (!m) return;
    m.checked = m.bitten ? 'bitten' : 'clean';
    s.events.push({ type: 'checked', name: m.name, bitten: !!m.bitten });
  } else {
    const v = s.vehicles.find((x) => x.id === w.id)!;
    v.fuel = Math.min(1, v.fuel + JERRYCAN_FUEL);
    s.arsenal.cans--;
    s.events.push({ type: 'refueled', id: v.id, from: 'can' });
  }
}

// ---------------------------------------------------------------- survivors

function talkTo(s: GameState, v: Survivor): void {
  if (v.status === 'waiting') {
    v.status = 'asked';
    if (v.request === 'clear') {
      // they were cornered: the infected around them come out of hiding
      for (let k = 0; k < CLEAR_COUNT; k++) {
        const a = (k / CLEAR_COUNT) * Math.PI * 2 + next(s.rng);
        const r = range(s.rng, 7, 10);
        const pos = { x: v.pos.x + dcos(a) * r, y: v.pos.y + dsin(a) * r };
        if (s.map.blocked[cellOf(s.map, pos)] === 1) continue;
        const id = s.nextZombieId;
        addZombie(s, 'walker', pos, true);
        v.targets.push(id);
      }
      if (v.targets.length === 0) v.status = 'ready';
    }
    s.events.push({ type: 'survivor-asked', id: v.id, first: true });
    return;
  }
  if (v.status === 'ready' || (v.status === 'asked' && v.request === 'fetch' && v.carrying)) {
    v.status = 'done';
    v.carrying = false;
    reward(s, v);
    return;
  }
  s.events.push({ type: 'survivor-asked', id: v.id, first: false }); // a reminder
}

function reward(s: GameState, v: Survivor): void {
  const a = s.arsenal;
  let what = v.reward;
  if (what === 'weapon') {
    const w = (['shotgun', 'machete', 'rifle'] as const).find((x) => !a.owned.includes(x));
    if (w) giveWeapon(s, w); else what = 'funds';
  }
  if (what === 'intel') {
    if (!s.safehouseKnown) s.safehouseKnown = true; else what = 'funds';
  }
  if (what === 'ammo') for (const g of a.owned) if (isGun(g)) a.ammo[g] += GUNS[g].ammoPack;
  if (what === 'funds') s.funds += SURVIVOR_FUNDS;
  s.events.push({ type: 'survivor-done', id: v.id, reward: what });
}

function updateSurvivors(s: GameState): void {
  for (const v of s.survivors) {
    if (v.status !== 'asked') continue;
    if (v.request === 'fetch' && !v.carrying && s.player.vehicleId === null && dist(v.fetchPos, s.player.pos) < PICKUP_RADIUS) {
      v.carrying = true;
      s.events.push({ type: 'fetched', id: v.id });
    }
    if (v.request === 'clear' && v.targets.every((id) => { const z = s.zombies.find((q) => q.id === id); return !z || z.action === 'dead'; })) {
      v.status = 'ready';
      s.events.push({ type: 'survivor-ready', id: v.id });
    }
  }
}

// ---------------------------------------------------------------- distractions: bottles, car alarms

/** Everything within `radius` of a noise stops hunting and walks over to it. */
function lure(s: GameState, pos: Vec2, radius: number, seconds: number): void {
  for (const z of s.zombies) {
    if (z.action === 'dead' || z.action === 'rise' || z.action === 'feed' || z.action === 'dormant' || z.action === 'scream') continue;
    if (dist(z.pos, pos) > radius) continue;
    z.lure = { ...pos };
    z.lureT = Math.max(z.lureT ?? 0, seconds);
    z.alertT = 0;
  }
}

function throwBottle(s: GameState): void {
  const a = s.arsenal;
  if (a.bottles <= 0) return;
  const p = s.player.pos;
  const hx = dcos(s.player.heading), hy = dsin(s.player.heading);
  // it flies over cars and fences, but lands on open ground: pull it back if it would land inside something
  let r = BOTTLE_RANGE;
  let to = { x: p.x + hx * r, y: p.y + hy * r };
  while (r > 2 && (to.x < 1 || to.y < 1 || to.x > s.map.size - 1 || to.y > s.map.size - 1 || s.map.blocked[cellOf(s.map, to)] === 1)) {
    r -= 0.5;
    to = { x: p.x + hx * r, y: p.y + hy * r };
  }
  a.bottles--;
  s.thrown.push({ from: { ...p }, to, t: 0, dur: BOTTLE_FLIGHT });
  s.events.push({ type: 'throw', to });
}

function updateThrown(s: GameState, dt: number): void {
  for (const b of s.thrown) {
    b.t += dt;
    if (b.t < b.dur) continue;
    s.events.push({ type: 'bottle-smash', pos: b.to });
    lure(s, b.to, LURE_RADIUS, LURE_SECONDS);
  }
  s.thrown = s.thrown.filter((b) => b.t < b.dur);
}

function startAlarm(s: GameState, idx: number): void {
  if (s.alarmUsed.includes(idx)) return;
  const b = s.map.buildings[idx]!;
  const pos = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  s.alarmUsed.push(idx);
  s.alarms.push({ car: idx, pos, t: ALARM_SECONDS });
  s.events.push({ type: 'alarm-start', car: idx, pos });
  lure(s, pos, ALARM_RADIUS, 2);
}

function updateAlarms(s: GameState, dt: number): void {
  for (const al of s.alarms) {
    al.t -= dt;
    if (al.t > 0) lure(s, al.pos, ALARM_RADIUS, 2); // keeps calling while it sounds
    else s.events.push({ type: 'alarm-stop', car: al.car });
  }
  s.alarms = s.alarms.filter((al) => al.t > 0);
}

// ---------------------------------------------------------------- fuel

function burnFuel(s: GameState, v: Vehicle, dt: number): void {
  if (v.fuel <= 0) return;
  v.fuel = Math.max(0, v.fuel - (Math.abs(v.speed) / VEHICLES[v.kind].maxSpeed) * (dt / FUEL_SECONDS));
  if (v.fuel === 0) s.events.push({ type: 'out-of-fuel', id: v.id });
}

/** Stopped at a gas pump in a car: the tank fills. */
function pumpFuel(s: GameState, dt: number): void {
  const v = playerVehicle(s);
  const at = v && Math.abs(v.speed) < 1 && v.fuel < 1 && nearbyObstacles(s.map, v.pos, 4.5, []).some((i) => s.map.buildings[i]!.kind === 'pump');
  if (!v || !at) { s.pumping = false; return; }
  if (!s.pumping) s.events.push({ type: 'refueled', id: v.id, from: 'pump' });
  s.pumping = true;
  v.fuel = Math.min(1, v.fuel + PUMP_RATE * dt);
}

// ---------------------------------------------------------------- weapons, pickups and the store

/** Which gun loose ammo goes to: the gun in hand, else the first gun you own. */
function ammoTarget(s: GameState): GunKind {
  const a = s.arsenal;
  if (a.weapon && isGun(a.weapon)) return a.weapon;
  return (a.owned.find(isGun) as GunKind | undefined) ?? 'pistol';
}

function takePickups(s: GameState): void {
  const a = s.arsenal;
  for (const pk of s.pickups) {
    if (pk.taken || isWeaponKind(pk.kind) || dist(pk.pos, s.player.pos) > PICKUP_RADIUS) continue; // a weapon is taken by hand
    pk.taken = true;
    if (pk.kind === 'ammo') {
      const w = ammoTarget(s);
      a.ammo[w] += GUNS[w].ammoPack;
      s.events.push({ type: 'pickup', kind: 'ammo', amount: GUNS[w].ammoPack });
    } else if (pk.kind === 'bottles') {
      a.bottles += 3;
      s.events.push({ type: 'pickup', kind: 'bottles', amount: 3 });
    } else if (pk.kind === 'jerrycan') {
      a.cans += 1;
      s.events.push({ type: 'pickup', kind: 'jerrycan', amount: 1 });
    } else if (pk.kind === 'antiviral') {
      s.events.push({ type: 'pickup', kind: 'antiviral', amount: Math.round(takeAntiviral(s)) });
    } else if (pk.kind === 'vest' || pk.kind === 'helmet') {
      wearGear(s, pk.kind);
      s.events.push({ type: 'pickup', kind: pk.kind, amount: GEAR[pk.kind].durability });
    }
  }
}

/** Put on (or replace) a piece of protective gear, good as new. */
function wearGear(s: GameState, g: GearKind): void {
  s.arsenal.gear[g] = GEAR[g].durability;
}

/** Hurt the player. Gear takes its share first, and wears down by what it took. Returns the damage
 * that got through. */
export function hurtPlayer(s: GameState, amount: number): number {
  let through = amount;
  for (const g of ['vest', 'helmet'] as const) {
    const left = s.arsenal.gear[g];
    if (left <= 0) continue;
    const took = Math.min(left, amount * GEAR[g].absorb);
    s.arsenal.gear[g] = left - took;
    through -= took;
    s.events.push({ type: 'gear-hit', gear: g, absorbed: took });
    if (s.arsenal.gear[g] <= 1e-6) { s.arsenal.gear[g] = 0; s.events.push({ type: 'gear-broken', gear: g }); }
  }
  s.player.health -= through;
  if (s.player.hide !== null) leaveHide(s); // found, and dragged out
  return through;
}

/** A weapon into your arsenal. In your hand only if your hands were empty, or `hold` (you paid for it): what you are
 * holding may well be better (your own, upgraded), so SWAP is how you change. */
function giveWeapon(s: GameState, w: WeaponKind, hold = false): void {
  const a = s.arsenal;
  if (isGun(w)) {
    if (!a.owned.includes(w)) a.mag[w] = gunStats(a, w).mag;
    a.ammo[w] += GUNS[w].ammoPack;
  }
  if (!a.owned.includes(w)) a.owned.push(w);
  if (hold || !a.weapon) { a.weapon = w; a.reloadT = 0; }
}

/** Walk through a store's doorway to go in. Leaving puts you back in the doorway, so the store
 * stays shut until you step out of it. */
function enterStores(s: GameState): void {
  if (s.player.vehicleId !== null) return;
  const p = s.player.pos;
  if (s.storeLatch !== null) {
    const st = s.stores.find((x) => x.id === s.storeLatch);
    if (!st || dist(st.pos, p) > STORE_DOOR_RADIUS + 1.5) s.storeLatch = null;
    return;
  }
  for (const st of s.stores) {
    if (dist(st.pos, p) > STORE_DOOR_RADIUS) continue;
    // only when heading in, not when walking past along the pavement
    const into = -(s.player.vel.x * st.front.facing.x + s.player.vel.y * st.front.facing.y);
    if (into < 0.5) continue;
    s.storeLatch = st.id;
    s.events.push({ type: 'store-open', id: st.id });
    return;
  }
}

/** Price of a store item right now, or null if it is not for sale to you (owned, maxed out). */
export function priceOf(s: GameState, item: StoreItem): number | null {
  const a = s.arsenal;
  switch (item.kind) {
    case 'weapon': return a.owned.includes(item.weapon) ? null : WEAPON_PRICES[item.weapon];
    case 'ammo': return a.owned.includes(item.weapon) ? AMMO_PRICES[item.weapon] : null;
    case 'medkit': return MEDKIT_PRICE;
    case 'antiviral': return s.timeLimit - s.remaining < 1 ? null : ANTIVIRAL_PRICE; // nothing to hold back yet
    case 'bottles': return BOTTLES_PRICE;
    case 'jerrycan': return JERRYCAN_PRICE;
    case 'gear': {
      // new, or a worn one swapped for new at the price of the wear
      const left = a.gear[item.gear] / GEAR[item.gear].durability;
      if (left >= 0.999) return null;
      return Math.max(10, Math.round(GEAR[item.gear].price * (1 - left)));
    }
    case 'upgrade': {
      if (!a.owned.includes(item.weapon)) return null;
      if (isMelee(item.weapon) && item.upgrade !== 'damage') return null;
      const level = a.upgrades[item.weapon][item.upgrade];
      if (level >= UPGRADE_LEVELS) return null;
      return Math.round(UPGRADE_BASE[item.weapon] * UPGRADE_FACTOR[item.upgrade] * (level + 1));
    }
  }
}

/** Buy from a weapon store. Pure: returns false (and changes nothing) if it is not for sale or you
 * cannot afford it. */
export function buy(s: GameState, item: StoreItem): boolean {
  const price = priceOf(s, item);
  if (price === null || s.funds < price) return false;
  s.funds -= price;
  const a = s.arsenal;
  switch (item.kind) {
    case 'weapon': giveWeapon(s, item.weapon, true); break;
    case 'ammo': a.ammo[item.weapon] += GUNS[item.weapon].ammoPack; break;
    case 'medkit': s.player.health = Math.min(PLAYER_HEALTH, s.player.health + MEDKIT_HEAL); break;
    case 'antiviral': takeAntiviral(s); break;
    case 'bottles': a.bottles += 3; break;
    case 'jerrycan': a.cans += 1; break;
    case 'gear': wearGear(s, item.gear); break;
    case 'upgrade': {
      a.upgrades[item.weapon][item.upgrade]++;
      // a bigger magazine comes loaded
      if (item.upgrade === 'mag' && isGun(item.weapon)) {
        const w = item.weapon;
        const take = Math.min(gunStats(a, w).mag - a.mag[w], a.ammo[w]);
        a.mag[w] += Math.max(0, take);
        a.ammo[w] -= Math.max(0, take);
      }
      break;
    }
  }
  s.events.push({ type: 'purchase', item });
  return true;
}

/** Take a weapon you own in hand (from the store's page or a weapon wheel). */
export function equip(s: GameState, w: WeaponKind): boolean {
  const a = s.arsenal;
  if (!a.owned.includes(w) || a.weapon === w) return false;
  a.weapon = w;
  a.reloadT = 0;
  a.fireCd = 0.25;
  s.events.push({ type: 'equip', weapon: w });
  return true;
}

/** Where the first obstacle blocks a ray, as a distance (Infinity if none within range). */
function rayToWall(s: GameState, from: Vec2, dx: number, dy: number, range: number, over = heightOf(s)): number {
  const near: number[] = [];
  for (let t = 0.5; t <= range; t += 0.5) {
    const x = from.x + dx * t, y = from.y + dy * t;
    if (x < 0 || y < 0 || x > s.map.size || y > s.map.size) return t;
    for (const idx of nearbyObstacles(s.map, { x, y }, 0.1, near)) {
      const b = s.map.buildings[idx]!;
      if (b.kind === 'water' || b.height < 1.2 || b.height <= over + 0.5) continue; // shoot over water, fences, barrels (and from a roof, anything lower)
      if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return t;
    }
  }
  return Infinity;
}

/** Aim assist: the best zombie in front of you within range and in the open, if any. */
export function aimTarget(s: GameState, w: WeaponKind): Zombie | null {
  const range = isGun(w) ? GUNS[w].range * (s.player.roof !== null ? ROOF_RANGE : 1) : MELEE[w].range + 1.5; // melee turns you to face one in reach
  const level = s.player.roof;
  const p = s.player.pos;
  let best: Zombie | null = null, bestScore = Infinity;
  for (const z of s.zombies) {
    if (z.action === 'dead' || z.action === 'dormant') continue; // it never picks out a body: you find out the hard way
    if (!isGun(w) && (z.roof ?? null) !== level) continue; // a swing only reaches the ones on your level
    const dx = z.pos.x - p.x, dy = z.pos.y - p.y, d = dhypot(dx, dy);
    if (d > range || d < 1e-3) continue;
    const off = Math.abs(wrap(datan2(dy, dx) - s.player.heading));
    if (off > AIM_CONE && d > 3) continue; // behind you, unless it is right on top of you
    if (rayToWall(s, p, dx / d, dy / d, d) < d) continue;
    const score = d + off * 6;
    if (score < bestScore) { bestScore = score; best = z; }
  }
  return best;
}

function hurtZombie(s: GameState, z: Zombie, damage: number, dirX: number, dirY: number, stagger = STAGGER_SECONDS, knock = 0.25, gun = false): void {
  z.health -= damage;
  z.alertT = ALERT_SECONDS;
  // gunfire does not always finish a walker: sometimes it only takes the legs, and the rest keeps coming
  if (z.health <= 0 && gun && z.kind === 'walker' && !z.husk && next(s.rng2) < HALVE_CHANCE) {
    z.kind = 'crawler';
    z.health = ZOMBIE_HEALTH.crawler;
    z.action = 'idle';
    z.speed = 0;
    z.staggerT = 2.2; // it lies there a moment first
    z.alertT = ALERT_SECONDS + 4;
    z.cooldown = 0;
    s.events.push({ type: 'halved', id: z.id });
    return;
  }
  if (z.health <= 0) {
    z.action = 'dead';
    z.actionT = CORPSE_SECONDS;
    z.speed = 0;
    z.heading = datan2(-dirY, -dirX); // falls away from the shot
    killed(s, z);
    return;
  }
  if (z.action === 'dormant') { wake(s, z); return; } // you hit a body, and it was not dead
  // a hit makes it flinch, and spoils a lunge (or chokes off a scream)
  z.staggerT = stagger;
  if (z.action === 'attack') { z.action = 'chase'; z.cooldown = ATTACK_COOLDOWN * 0.5; }
  if (z.action === 'scream') { z.action = 'chase'; z.screamCd = 2.5; }
  z.pos.x += dirX * knock;
  z.pos.y += dirY * knock;
  s.events.push({ type: 'zombie-hurt', id: z.id });
}

function startReload(s: GameState, w: GunKind): void {
  const a = s.arsenal;
  if (a.reloadT > 0 || a.ammo[w] <= 0 || a.mag[w] >= gunStats(a, w).mag) return;
  a.reloadT = gunStats(a, w).reload;
  s.events.push({ type: 'reload', weapon: w });
}

function updateWeapons(s: GameState, input: Input, dt: number): void {
  const a = s.arsenal;
  a.fireCd = Math.max(0, a.fireCd - dt);
  if (input.swap && a.owned.length > 1) {
    const i = a.weapon ? a.owned.indexOf(a.weapon) : -1;
    a.weapon = a.owned[(i + 1) % a.owned.length]!;
    a.reloadT = 0;
    a.fireCd = 0.25;
  }
  const w = a.weapon;
  if (!w) return;
  if (isMelee(w)) { swingMelee(s, w, input); return; }
  const spec = gunStats(a, w);
  if (a.reloadT > 0) {
    a.reloadT -= dt;
    if (a.reloadT <= 0) {
      a.reloadT = 0;
      const take = Math.min(spec.mag - a.mag[w], a.ammo[w]);
      a.mag[w] += take;
      a.ammo[w] -= take;
    }
    return;
  }
  if (input.reload) { startReload(s, w); return; }
  if (!input.fire || a.fireCd > 0) return;
  if (a.mag[w] <= 0) {
    if (a.ammo[w] > 0) startReload(s, w);
    else { s.events.push({ type: 'empty', weapon: w }); a.fireCd = 0.4; }
    return;
  }

  // aim: snap to the best target in front, otherwise fire where you face
  const p = s.player.pos;
  const target = aimTarget(s, w);
  const aim = target ? datan2(target.pos.y - p.y, target.pos.x - p.x) : s.player.heading;
  s.player.heading = aim;
  a.mag[w]--;
  a.fireCd = spec.interval;

  for (let k = 0; k < spec.pellets; k++) {
    const ang = aim + (next(s.rng) - 0.5) * spec.spread;
    const dx = dcos(ang), dy = dsin(ang);
    const far = spec.range * (s.player.roof !== null ? ROOF_RANGE : 1);
    const wall = rayToWall(s, p, dx, dy, far);
    const reach = Math.min(far, wall);
    // first zombie the ray passes through
    let hit: Zombie | null = null, hitT = reach;
    for (const z of s.zombies) {
      if (z.action === 'dead' || z.action === 'dormant') continue; // shots pass over the ones lying down
      const ox = z.pos.x - p.x, oy = z.pos.y - p.y;
      const t = ox * dx + oy * dy;
      if (t <= 0 || t >= hitT) continue;
      if (Math.abs(ox * dy - oy * dx) > ZOMBIE_RADIUS + 0.2) continue;
      hit = z; hitT = t;
    }
    const vic = s.mode === 'room' ? playerOnRay(s, p, dx, dy, hitT) : null; // in a room the first thing on the line may be a person
    if (vic) { hit = null; hitT = vic.t; }
    const dmg = spec.damage * (hitT > far * 0.6 ? 0.7 : 1);
    if (vic) hurtOther(s, s.cur, vic.who, dmg);
    else if (hit) hurtZombie(s, hit, dmg, dx, dy, STAGGER_SECONDS, 0.25, true);
    if (k === 0) s.events.push({ type: 'shot', weapon: w, from: { ...p }, to: { x: p.x + dx * hitT, y: p.y + dy * hitT }, hit: hit?.id ?? null });
  }

  alertWithin(s, spec.noise);
  const car = parkedCarNear(s, p, ALARM_SHOT_RADIUS); // shooting next to a parked car sets it off
  if (car !== null) startAlarm(s, car);
}

/** Noise carries: everything within earshot comes looking. */
function alertWithin(s: GameState, radius: number): void {
  const p = s.player.pos;
  for (const z of s.zombies) {
    if (z.action === 'dormant') { if (dist(z.pos, p) < radius * DORMANT_HEAR) wake(s, z); continue; } // noise wakes the ones lying close
    if (z.action !== 'dead' && z.action !== 'rise' && dist(z.pos, p) < radius) { z.alertT = Math.max(z.alertT, ALERT_SECONDS); z.lureT = 0; }
  }
}

/** A melee swing: turn to the nearest one in reach, hit whatever is in the arc (a bat can hit
 * several), shove them back. Quiet, no ammo, but you have to be close. */
function swingMelee(s: GameState, w: MeleeKind, input: Input): void {
  const a = s.arsenal;
  if (!input.fire || a.fireCd > 0) return;
  const spec = meleeStats(a, w);
  const p = s.player.pos;
  const target = aimTarget(s, w);
  if (target) s.player.heading = datan2(target.pos.y - p.y, target.pos.x - p.x);
  a.fireCd = spec.interval;
  a.swing++;
  const inArc = s.zombies
    .filter((z) => z.action !== 'dead' && (z.roof ?? null) === s.player.roof) // only the ones on your level
    .map((z) => ({ z, d: dist(z.pos, p) }))
    .filter(({ z, d }) => d < spec.range + ZOMBIE_RADIUS && (d < 0.8 || Math.abs(wrap(datan2(z.pos.y - p.y, z.pos.x - p.x) - s.player.heading)) < spec.arc / 2))
    .sort((x, y) => x.d - y.d)
    .slice(0, spec.cleave);
  for (const { z, d } of inArc) {
    const dx = d > 1e-6 ? (z.pos.x - p.x) / d : dcos(s.player.heading);
    const dy = d > 1e-6 ? (z.pos.y - p.y) / d : dsin(s.player.heading);
    hurtZombie(s, z, spec.damage, dx, dy, spec.stagger, MELEE_KNOCKBACK);
  }
  let hits = inArc.length;
  if (s.mode === 'room') {
    for (const o of s.players) {
      if (o === s.cur || !canHurt(s, s.cur, o)) continue;
      const d = dist(o.pos, p);
      if (d < spec.range + PLAYER_RADIUS && (d < 0.8 || Math.abs(wrap(datan2(o.pos.y - p.y, o.pos.x - p.x) - s.player.heading)) < spec.arc / 2)) { hurtOther(s, s.cur, o, spec.damage); hits++; }
    }
  }
  s.events.push({ type: 'swing', weapon: w, hits });
  alertWithin(s, spec.noise);
}

function exitVehicle(s: GameState): void {
  const v = playerVehicle(s);
  if (!v) return;
  const spec = VEHICLES[v.kind];
  // step out on the driver's side, or the other side if that is blocked; both blocked, whichever has more room
  let best: Vec2 | null = null, pushed = Infinity;
  for (const side of [1, -1]) {
    const nx = -dsin(v.heading) * side, ny = dcos(v.heading) * side;
    const p = { x: v.pos.x + nx * (spec.width / 2 + 0.9), y: v.pos.y + ny * (spec.width / 2 + 0.9) };
    const before = { ...p };
    resolve(s.map, p, PLAYER_RADIUS);
    const d = dist(p, before);
    if (d < pushed) { best = p; pushed = d; }
    if (d < 0.3) break;
  }
  s.player.pos = best!;
  s.player.vel = { x: 0, y: 0 };
  s.player.vehicleId = null;
  s.events.push({ type: 'vehicle-exit', id: v.id });
}

// ---------------------------------------------------------------- movement

/** Whether a point is over one of the bodies on the ground (you are stepping over it). */
export function onBody(s: GameState, p: Vec2): boolean {
  for (const c of s.corpses) {
    if (c.half) continue;
    const ox = p.x - c.pos.x, oy = p.y - c.pos.y;
    if (ox * ox + oy * oy > 9) continue; // nowhere near
    const fx = dcos(c.heading), fy = dsin(c.heading);
    // the body runs from a (past the feet) back to b (past the head): the nearest point of it to you
    const ax = c.pos.x + fx * BODY.feet, ay = c.pos.y + fy * BODY.feet;
    const along = Math.max(0, Math.min(BODY.feet + BODY.head, (ax - p.x) * fx + (ay - p.y) * fy));
    if (dhypot(p.x - (ax - fx * along), p.y - (ay - fy * along)) < BODY.radius) return true;
  }
  return false;
}

/** One step of a body walking (also what a browser re-runs to predict its own movement in a room). */
export function movePlayer(s: GameState, input: Input, dt: number): void {
  let dx = input.dx, dy = input.dy;
  const len = dhypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  if (s.player.hide !== null) { // hidden: a firm push on the stick steps you out
    if (len < HIDE_LEAVE) { s.player.vel = { x: 0, y: 0 }; return; }
    leaveHide(s);
  }
  if (s.work?.kind === 'climb') { s.player.vel = { x: 0, y: 0 }; return; } // on the ladder
  const top = PLAYER_SPEED * s.speedMul * (1 + (s.arsenal.perks?.speed ?? 0)) * (s.player.slowT > 0 ? GRAB_SLOW : 1) // a crawler on your leg
    * (s.player.roof === null && onBody(s, s.player.pos) ? BODY_SLOW : 1) // stepping over the dead
    * (s.player.crouched ? CROUCH_SPEED : 1);
  const tx = dx * top, ty = dy * top; // analog: a light push walks, a full push runs
  const v = s.player.vel;
  const ex = tx - v.x, ey = ty - v.y;
  const e = dhypot(ex, ey);
  const stepV = PLAYER_ACCEL * dt;
  if (e <= stepV) { v.x = tx; v.y = ty; } else { v.x += (ex / e) * stepV; v.y += (ey / e) * stepV; }
  const sp = dhypot(v.x, v.y);
  if (sp < 1e-4) { v.x = 0; v.y = 0; return; }
  const before = { x: s.player.pos.x, y: s.player.pos.y };
  s.player.pos.x += v.x * dt;
  s.player.pos.y += v.y * dt;
  if (s.player.roof !== null) onRoof(s.map.ladders[s.player.roof]!, s.player.pos); // the roof's edge is your wall
  else {
    resolve(s.map, s.player.pos, PLAYER_RADIUS);
    for (const c of s.vehicles) pushOutOfVehicle(c, s.player.pos, PLAYER_RADIUS);
  }
  // sliding along a wall: keep only the velocity that actually happened
  if (dt > 0) { v.x = (s.player.pos.x - before.x) / dt; v.y = (s.player.pos.y - before.y) / dt; }
  if (len > 0.05) s.player.heading = datan2(dy, dx);
  else if (sp > 0.2) s.player.heading = datan2(v.y, v.x);
}

/** Vehicles collide as three circles along their length. */
export function vehicleCircles(v: Vehicle): Array<{ x: number; y: number; r: number }> {
  const spec = VEHICLES[v.kind];
  const half = spec.length / 2 - spec.width / 2;
  const hx = dcos(v.heading), hy = dsin(v.heading);
  return [-half, 0, half].map((o) => ({ x: v.pos.x + hx * o, y: v.pos.y + hy * o, r: spec.width / 2 }));
}

function pushOutOfVehicle(v: Vehicle, p: Vec2, r: number): boolean {
  let hit = false;
  for (const c of vehicleCircles(v)) {
    const dx = p.x - c.x, dy = p.y - c.y, d = dhypot(dx, dy), min = c.r + r;
    if (d >= min) continue;
    hit = true;
    if (d < 1e-6) { p.x += min; continue; }
    p.x = c.x + (dx / d) * min;
    p.y = c.y + (dy / d) * min;
  }
  return hit;
}

/**
 * Arcade driving for touch: push the stick where you want to go and the car steers toward it.
 * Pushing back against the nose when slow reverses.
 */
function drive(v: Vehicle, input: Input, dt: number, load = 1): void {
  if (v.wrecked) return;
  const base = VEHICLES[v.kind];
  const spec = { ...base, maxSpeed: base.maxSpeed * load };
  const mag = v.fuel > 0 ? Math.min(1, dhypot(input.dx, input.dy)) : 0; // an empty tank coasts
  let target = 0;
  let steerTo: number | null = null;
  if (mag > 0.1) {
    const want = datan2(input.dy, input.dx);
    const diff = wrap(want - v.heading);
    if (Math.abs(diff) > 2.0 && v.speed < 2) {
      target = -spec.reverse * mag;
      steerTo = wrap(want + Math.PI);
    } else {
      target = spec.maxSpeed * mag * Math.max(0.35, dcos(diff));
      steerTo = want;
    }
  }
  const braking = target === 0 || (Math.sign(target) !== Math.sign(v.speed) && Math.abs(v.speed) > 0.5);
  v.speed = approach(v.speed, target, (target === 0 ? 6 : braking ? 22 : spec.accel) * dt);
  if (steerTo !== null) {
    const d = wrap(steerTo - v.heading);
    const rate = spec.steer * Math.min(1, Math.abs(v.speed) / 4) * dt;
    v.heading = wrap(v.heading + Math.max(-rate, Math.min(rate, d)));
  }
}

function moveVehicle(s: GameState, v: Vehicle, dt: number, driven: boolean): void {
  if (v.wrecked) { v.speed = 0; return; }
  if (!driven) v.speed = approach(v.speed, 0, 6 * dt);
  if (Math.abs(v.speed) < 1e-3) return;
  const spec = VEHICLES[v.kind];
  v.pos.x += dcos(v.heading) * v.speed * dt;
  v.pos.y += dsin(v.heading) * v.speed * dt;

  // collide each circle with the city and with other vehicles; apply the average push
  let px = 0, py = 0, hits = 0;
  for (const c of vehicleCircles(v)) {
    const p = { x: c.x, y: c.y };
    let hit = resolve(s.map, p, c.r);
    for (const o of s.vehicles) if (o !== v) hit = pushOutOfVehicle(o, p, c.r) || hit;
    if (hit) { px += p.x - c.x; py += p.y - c.y; hits++; }
  }
  if (hits > 0) {
    v.pos.x += px / hits;
    v.pos.y += py / hits;
    const force = Math.abs(v.speed);
    if (force > 5) {
      s.events.push({ type: 'vehicle-crash', id: v.id, force });
      for (const z of s.zombies) if (z.latch === v.id) shakeOff(s, z, v, 0.6);
      v.speed *= -0.2;
      damageVehicle(s, v, (force - 5) * 3);
    } else {
      v.speed *= 0.6;
    }
  }

  // zombies: knocked down at speed, shoved aside when slow
  for (const z of s.zombies) {
    if (z.action === 'dead' || z.latch != null) continue;
    for (const c of vehicleCircles(v)) {
      if (dhypot(z.pos.x - c.x, z.pos.y - c.y) >= c.r + ZOMBIE_RADIUS) continue;
      if (Math.abs(v.speed) > RUN_OVER_SPEED) {
        z.action = 'dead';
        z.actionT = CORPSE_SECONDS;
        z.speed = 0;
        z.heading = v.heading + Math.PI; // falls back from the bumper
        v.speed *= 0.82;
        killed(s, z);
        damageVehicle(s, v, spec.health * 0.03);
      } else {
        pushOutOfVehicle(v, z.pos, ZOMBIE_RADIUS);
      }
      break;
    }
  }
}

/** How many are hanging on to a vehicle. */
export function latchedOn(s: GameState, id: number): number {
  let n = 0;
  for (const z of s.zombies) if (z.latch === id && z.action !== 'dead') n++;
  return n;
}

/** Off it goes: thrown clear of the body, dazed, hurt by the fall. */
function shakeOff(s: GameState, z: Zombie, v: Vehicle, hurt: number): void {
  z.latch = null;
  z.latchT = 0;
  z.action = 'chase';
  z.staggerT = 1.2;
  const dx = z.pos.x - v.pos.x, dy = z.pos.y - v.pos.y, d = dhypot(dx, dy) || 1;
  z.pos.x += (dx / d) * 1.2;
  z.pos.y += (dy / d) * 1.2;
  resolve(s.map, z.pos, ZOMBIE_RADIUS);
  z.health -= hurt * 100;
  if (z.health <= 0) {
    z.action = 'dead';
    z.actionT = CORPSE_SECONDS;
    z.speed = 0;
    killed(s, z);
  }
  s.events.push({ type: 'shaken', id: z.id });
}

/** Grab on to the vehicle at the point of the body nearest to it. */
function latchOn(s: GameState, z: Zombie, v: Vehicle): boolean {
  if (latchedOn(s, v.id) >= LATCH_MAX) return false;
  const spec = VEHICLES[v.kind];
  const c = dcos(v.heading), sn = dsin(v.heading);
  const rx = z.pos.x - v.pos.x, ry = z.pos.y - v.pos.y;
  const along = Math.max(-spec.length / 2, Math.min(spec.length / 2, rx * c + ry * sn));
  const across = rx * -sn + ry * c;
  // on the sides it holds the door frame; at the ends, the bonnet or the boot
  const side = Math.abs(along) < spec.length / 2 - 0.4;
  z.latch = v.id;
  z.latchT = 0;
  z.latchAt = side
    ? { x: along, y: Math.sign(across || 1) * (spec.width / 2 + ZOMBIE_RADIUS * 0.6) }
    : { x: Math.sign(along) * (spec.length / 2 + ZOMBIE_RADIUS * 0.6), y: Math.max(-spec.width / 3, Math.min(spec.width / 3, across)) };
  z.action = 'cling';
  z.cooldown = LATCH_EVERY * 0.5;
  s.events.push({ type: 'latched', id: z.id, count: latchedOn(s, v.id) });
  return true;
}

/** Hanging on: rides along, claws at the car, reaches in once it is beaten enough; lets go at speed. */
function updateLatched(s: GameState, z: Zombie, dt: number): void {
  const v = s.vehicles.find((x) => x.id === z.latch);
  if (!v || v.wrecked || s.player.vehicleId !== v.id) { // the car is dead or you got out: after you
    z.latch = null;
    z.action = 'chase';
    z.alertT = Math.max(z.alertT, ALERT_SECONDS);
    return;
  }
  const c = dcos(v.heading), sn = dsin(v.heading), at = z.latchAt!;
  z.pos.x = v.pos.x + at.x * c - at.y * sn;
  z.pos.y = v.pos.y + at.x * sn + at.y * c;
  z.heading = datan2(v.pos.y - z.pos.y, v.pos.x - z.pos.x);
  z.speed = 0;
  if (Math.abs(v.speed) > LATCH_SHAKE_SPEED) {
    z.latchT = (z.latchT ?? 0) + dt;
    if (z.latchT > LATCH_GRIP) { shakeOff(s, z, v, Math.abs(v.speed) > 15 ? 0.8 : 0.3); return; }
  } else z.latchT = Math.max(0, (z.latchT ?? 0) - dt * 0.5);
  z.cooldown = Math.max(0, z.cooldown - dt);
  if (z.cooldown > 0) return;
  z.cooldown = LATCH_EVERY;
  const spec = VEHICLES[v.kind];
  const wasWhole = v.health > spec.health * BREACH_AT;
  s.events.push({ type: 'vehicle-crash', id: v.id, force: 2 });
  damageVehicle(s, v, LATCH_DAMAGE);
  if (s.player.vehicleId !== v.id) return; // wrecked: you were thrown out
  if (v.health > spec.health * BREACH_AT) return;
  if (wasWhole) s.events.push({ type: 'vehicle-breached', id: v.id });
  // the glass is gone: it reaches in
  const took = hurtPlayer(s, BREACH_DAMAGE);
  s.events.push({ type: 'player-hit', damage: took, by: z.id });
  if (s.player.health <= 0) {
    s.player.health = 0;
    s.killerId = z.id;
    exitVehicle(s);
    z.latch = null;
    z.action = 'feed';
    lose(s, 'caught');
  }
}

function damageVehicle(s: GameState, v: Vehicle, amount: number): void {
  if (v.wrecked) return;
  v.health -= amount;
  if (v.health > 0) return;
  v.health = 0;
  v.wrecked = true;
  v.speed = 0;
  s.events.push({ type: 'vehicle-wrecked', id: v.id });
  if (s.player.vehicleId === v.id) exitVehicle(s);
}

// ---------------------------------------------------------------- tasks and the safehouse

function updateTasks(s: GameState, dt: number): void {
  if (!s.hold.taskId) return;
  const t = s.tasks.find((x) => x.id === s.hold.taskId)!;
  if (t.done) { s.hold.taskId = null; s.hold.progress = 0; return; } // someone else finished it first
  // walking away (or driving off) cancels the job
  if (s.player.vehicleId !== null || dist(t.pos, s.player.pos) > TASK_RADIUS + 0.3) {
    s.hold.taskId = null;
    s.hold.progress = 0;
    return;
  }
  s.hold.progress += dt / (t.seconds ?? TASK_HOLD_SECONDS);
  if (s.hold.progress < 1) return;
  s.hold.taskId = null;
  s.hold.progress = 0;
  completeTask(s, t);
}

/** A step is done: the grace moment, its effect, its cost and reward. */
function completeTask(s: GameState, t: Task): void {
  t.done = true;
  s.safeT = SAFE_AFTER;
  if (t.required) s.cur.helped++;
  s.events.push({ type: 'task-done', id: t.id });
  stepDone(s, t);
  if (t.timeCost > 0) {
    s.remaining -= t.timeCost;
    s.events.push({ type: 'time-penalty', seconds: t.timeCost });
    if (s.remaining <= 0) { s.remaining = 0; lose(s, 'time'); return; }
  }
  if (t.reward === 'speed') s.speedMul = SPEED_BOOST;
  else if (t.reward === 'calm') s.zombieMul = CALM_FACTOR;
  else if (t.reward === 'funds') s.funds += 50;
}

/** What finishing a step does to the night (its effect, from the task content). */
function stepDone(s: GameState, t: Task): void {
  switch (t.effect) {
    case 'reveal-exit': s.safehouseKnown = true; releaseChase(s); break;
    case 'escort-start': { // they come out of hiding and follow you, the rest of a group in a line behind
      const { party, ...lead } = t.escort!;
      const at = (k: number) => ({ pos: { x: t.pos.x + 1 + k * 0.8, y: t.pos.y + 1 }, heading: 0, speed: 0, riding: false });
      s.escort = { ...at(0), ...lead, party: party?.map((m, k) => ({ ...at(k + 1), ...m })) };
      s.escortLost = false;
      // one of them may be bitten and hiding it. The bitten cough often; now and then someone healthy does too.
      const group = escortGroup(s);
      if (next(s.rng2) < byChapter(BITTEN_CHANCE, s)) {
        const m = pick(s.rng2, group);
        m.bitten = true;
        m.turnT = range(s.rng2, BITTEN_TURNS[0], BITTEN_TURNS[1]);
        m.coughEvery = range(s.rng2, BITTEN_COUGH[0], BITTEN_COUGH[1]);
      }
      const well = group.filter((m) => !m.bitten);
      if (well.length && next(s.rng2) < HEALTHY_COUGH_CHANCE) pick(s.rng2, well).coughEvery = range(s.rng2, HEALTHY_COUGH[0], HEALTHY_COUGH[1]);
      for (const m of group) if (m.coughEvery) m.coughT = m.coughEvery * range(s.rng2, 0.5, 1);
      break;
    }
    case 'escort-end': { // safe inside, unless you brought the infection in with them
      const carrier = escortGroup(s).find((m) => m.bitten);
      s.escort = null;
      if (carrier) { s.events.push({ type: 'escort-turned', name: carrier.name, where: 'inside' }); lose(s, 'carrier'); }
      break;
    }
    case 'lure': // a flare, bait: everything near it goes to it for a while
      s.flare = { pos: { ...t.pos }, t: FLARE_SECONDS };
      s.events.push({ type: 'flare-lit', pos: { ...t.pos } });
      lure(s, t.pos, FLARE_RADIUS, 3);
      break;
    case 'horde': // the noise brings them
      s.events.push({ type: 'horde', pos: { ...t.pos } });
      spawnWave(s, Math.max(1, s.tier));
      break;
    default: break;
  }
}

/** The puzzle page's answer. Checked here (so a replay checks it too); right completes the step.
 * tiles: turns made on each tile; keypad: the digits; wires: for each left wire, the right end it
 * was joined to. */
export function solvePuzzle(s: GameState, id: TaskId, answer: number[] | string): boolean {
  const t = s.tasks.find((x) => x.id === id);
  if (!t || t.done || t.kind !== 'puzzle' || !isRevealed(s, t) || s.phase !== 'playing') return false;
  let right = false;
  if (t.puzzle === 'keypad') right = typeof answer === 'string' && answer === t.code;
  else if (t.puzzle === 'tiles') right = Array.isArray(answer) && answer.length === 9 && t.scramble!.every((r, i) => (r + answer[i]!) % 4 === 0);
  else if (t.puzzle === 'wires') right = Array.isArray(answer) && answer.length === 4 && answer.every((j, i) => t.scramble![j] === i);
  if (!right) { s.events.push({ type: 'puzzle-wrong', id }); return false; }
  completeTask(s, t);
  return true;
}

/** A clear step: they come for you once you get close; it is done when they are all down. */
function updateClear(s: GameState): void {
  const t = currentTask(s);
  if (!t || t.kind !== 'clear') return;
  if (!t.targets) {
    if (dist(t.pos, s.player.pos) > 26) return;
    t.targets = [];
    for (let k = 0; k < (t.clear ?? 4); k++) {
      const a = (k / (t.clear ?? 4)) * Math.PI * 2 + next(s.rng);
      t.targets.push(s.nextZombieId);
      addZombie(s, k % 3 === 2 ? 'runner' : 'walker', { x: t.pos.x + dcos(a) * range(s.rng, 4, 8), y: t.pos.y + dsin(a) * range(s.rng, 4, 8) }, true);
      s.zombies[s.zombies.length - 1]!.alertT = 30; // they know you are there
    }
    s.events.push({ type: 'clear-start', id: t.id, count: t.targets.length });
    return;
  }
  const left = s.zombies.filter((z) => t.targets!.includes(z.id) && z.action !== 'dead').length;
  if (left === 0) completeTask(s, t);
}

/** How many are left to clear at a clear step (null if they have not come yet). */
export function clearLeft(s: GameState, t: Task): number | null {
  if (!t.targets) return null;
  return s.zombies.filter((z) => t.targets!.includes(z.id) && z.action !== 'dead').length;
}

/** Walk over a piece of the current step (a fuse) to take it. */
function takeParts(s: GameState): void {
  const t = currentTask(s);
  if (!t?.parts || !t.got) return;
  t.parts.forEach((q, i) => {
    const v = playerVehicle(s);
    const reach = PICKUP_RADIUS + 0.4 + (v ? VEHICLES[v.kind].length / 2 : 0); // lean out and grab it
    if (t.got![i] || dist(q, s.player.pos) > reach) return;
    t.got![i] = true;
    if (t.required) s.cur.helped++;
    const n = partsOf(t)!;
    s.events.push({ type: 'part-taken', id: t.id, got: n.got, of: n.of });
  });
}

/** Nora follows you through the streets (the same way they do), and rides along in a car. */
/** Everyone you are bringing in: the one you found first, then the rest of the group. */
export function escortGroup(s: GameState): Escort[] {
  return s.escort ? [s.escort, ...(s.escort.party ?? [])] : [];
}

/** Your group follows you through the streets in a line (the same way they do), and rides along in a car. */
function updateEscort(s: GameState, dt: number): void {
  let ahead = s.player.pos;
  for (const e of escortGroup(s)) { follow(s, e, ahead, dt); ahead = e.pos; }
}

function follow(s: GameState, e: Escort, p: Vec2, dt: number): void {
  const car = playerVehicle(s);
  if (car) { e.riding = true; e.pos = { ...car.pos }; e.speed = 0; return; }
  if (e.riding) { e.riding = false; e.pos = { x: s.player.pos.x + 1, y: s.player.pos.y }; resolve(s.map, e.pos, PLAYER_RADIUS); }
  const dx = p.x - e.pos.x, dy = p.y - e.pos.y, d = dhypot(dx, dy);
  let vx = 0, vy = 0;
  if (d > (p === s.player.pos ? 2.2 : 1.5)) {
    if (d < 3 || lineClear(s.map, e.pos, p, PLAYER_RADIUS)) { vx = dx / d; vy = dy / d; }
    else {
      const cols = s.map.cols, c = cellOf(s.map, e.pos);
      let best = s.flow[c] as number, bc = -1;
      for (const n of [c - 1, c + 1, c - cols, c + cols]) {
        if (n < 0 || n >= s.flow.length) continue;
        if ((s.flow[n] as number) < best) { best = s.flow[n] as number; bc = n; }
      }
      if (bc >= 0 && best !== UNREACHABLE) {
        const tx = (bc % cols) + 0.5 - e.pos.x, ty = Math.floor(bc / cols) + 0.5 - e.pos.y, tl = dhypot(tx, ty) || 1;
        vx = tx / tl; vy = ty / tl;
      }
    }
  }
  // left far behind (you drove off and got out somewhere else): she catches up the back way
  if (d > 45) { e.pos = { x: p.x - dcos(s.player.heading) * 2, y: p.y - dsin(s.player.heading) * 2 }; resolve(s.map, e.pos, PLAYER_RADIUS); }
  if (d > 45) return;
  const before = { ...e.pos };
  const v = ESCORT_SPEED * (d > 8 ? 1.15 : 1);
  e.pos.x += vx * v * dt;
  e.pos.y += vy * v * dt;
  resolve(s.map, e.pos, PLAYER_RADIUS);
  for (const c of s.vehicles) pushOutOfVehicle(c, e.pos, PLAYER_RADIUS);
  e.speed = dt > 0 ? dhypot(e.pos.x - before.x, e.pos.y - before.y) / dt : 0;
  if (vx !== 0 || vy !== 0) e.heading = datan2(vy, vx);
}

/** A burning flare keeps pulling everything near it. */
function updateFlare(s: GameState, dt: number): void {
  const f = s.flare;
  if (!f) return;
  f.t -= dt;
  if (f.t <= 0) { s.flare = null; return; }
  lure(s, f.pos, FLARE_RADIUS, 1);
}

function updateSafehouse(s: GameState): void {
  if (s.mode === 'room') { updateExit(s); return; }
  const inside = dist(s.safehouse, s.player.pos) < SAFEHOUSE_RADIUS + (s.player.vehicleId !== null ? 2 : 0);
  if (!inside) {
    s.lockedNotice = null;
    return;
  }
  if (requiredDone(s) && !finalChapter(s)) {
    s.phase = 'cleared'; // through the door into the next district
    s.events.push({ type: 'chapter-cleared', chapter: s.chapter });
  } else if (requiredDone(s)) {
    s.phase = 'won';
    s.events.push({ type: 'won' });
  } else if (s.lockedNotice !== 'safehouse') {
    s.lockedNotice = 'safehouse';
    s.events.push({ type: 'safehouse-locked' });
  }
}

// ---------------------------------------------------------------- zombies

function updateZombies(s: GameState, dt: number): void {
  const cols = s.map.cols;
  const walk = WALKER_SPEED_BY_TIER[s.tier]!;
  const room = s.mode === 'room';
  const first = s.cur;
  let tagFrom = s.events.length, tagSeat = first.id; // rooms: which player each event of this pass belongs to
  const tag = () => { for (let i = tagFrom; i < s.events.length; i++) tagEvent(s.events[i]!, tagSeat); tagFrom = s.events.length; };

  // rooms: the turned lead the dead. Each turned player's prey, if they are on someone (the nearest living player close by)
  const leaders = room ? s.players.filter((p) => p.status === 'turned').map((p) => {
    let prey: Player | null = null, best = HORDE_PREY;
    for (const q of s.players) if (q.status === 'alive' && q.hide === null) { const d = dist(p.pos, q.pos); if (d < best) { best = d; prey = q; } }
    return { p, prey };
  }) : [];

  for (const z of s.zombies) {
    if (z.action === 'dead') { z.actionT -= dt; continue; }
    if (z.latch != null) { updateLatched(s, z, dt); if (s.phase !== 'playing') return; continue; }
    if (room) { // each one goes for the nearest living player it can reach; their rules are those of whoever it chose
      // ...unless one of the turned is close and on someone: then it goes for them too, knowing just where they are
      let lead: (typeof leaders)[number] | null = null, ld = HORDE_RADIUS;
      if (z.action !== 'dormant' && z.action !== 'rise' && (z.lureT ?? 0) < 1e8) for (const L of leaders) { const d = dist(z.pos, L.p.pos); if (d < ld) { ld = d; lead = L; } }
      if (lead?.prey) { z.targetId = lead.prey.id; z.targetT = TARGET_HOLD; z.alertT = Math.max(z.alertT, 1); }
      const t = pickTarget(s, z, dt);
      tag();
      if (lead && !lead.prey && (!t || dist(z.pos, t.pos) > HORDE_RADIUS)) { followLeader(s, z, lead.p.pos, dt); continue; } // nobody near: it walks with them
      if (!t) continue;
      s.cur = t;
      tagSeat = t.id;
    }
    const p = s.player.pos;
    const ride = playerVehicle(s);
    const car = ride && ride.kind !== 'bike' ? ride : null; // on a bike they go for you, not the bike
    const reachBonus = car ? VEHICLES[car.kind].length / 2 - 0.4 : ride ? 0.3 : 0; // a car is a bigger target
    const busy = isBusy(s);
    const seen = sightScale(s);
    if (z.action === 'dormant') { // lying among the dead until you walk (or drive) close
      if (!busy && dist(z.pos, p) < DORMANT_WAKE + reachBonus) wake(s, z);
      continue;
    }
    // someone you are protecting: it takes hold (a second to shoot it or shove it off), then a bite is the end
    if (s.escort && z.action !== 'rise' && z.staggerT <= 0 && !busy) {
      let held = false;
      for (const m of escortGroup(s)) {
        if (m.riding) continue;
        const dm = dist(z.pos, m.pos);
        if (dm < 4 && s.dangerT <= 0) { s.dangerT = 4; s.events.push({ type: 'escort-danger', name: m.name }); }
        if (dm > ZOMBIE_RADIUS + PLAYER_RADIUS + 0.3) continue;
        held = true;
        z.biteT = (z.biteT ?? 0) + dt;
        if (z.biteT < BITE_SECONDS) break;
        z.action = 'feed';
        z.heading = datan2(m.pos.y - z.pos.y, m.pos.x - z.pos.x);
        s.killerId = z.id;
        lose(s, 'infected');
        return;
      }
      if (!held) z.biteT = 0;
    }
    const dx = p.x - z.pos.x, dy = p.y - z.pos.y;
    const d = dhypot(dx, dy);
    if (d > ZOMBIE_ACTIVE_RADIUS) continue; // dormant
    const lash = z.kind === 'lasher'; // strikes from well out of arm's reach
    const aRange = (lash ? LASH_RANGE : ATTACK_RANGE) + reachBonus, aReach = (lash ? LASH_REACH : ATTACK_REACH) + reachBonus;
    z.cooldown = Math.max(0, z.cooldown - dt);

    if (z.action === 'rise') {
      z.speed = 0;
      z.actionT -= dt;
      if (z.actionT <= 0) z.action = 'idle';
      continue;
    }
    z.alertT = Math.max(0, z.alertT - dt);
    if (z.staggerT > 0) {
      z.staggerT -= dt;
      z.speed = 0;
      continue;
    }

    z.screamCd = Math.max(0, (z.screamCd ?? 0) - dt);
    // a stalker caught in your light does not move a muscle; look away and it comes on
    if (z.kind === 'stalker') {
      z.frozen = inLight(s, z.pos);
      if (z.frozen) {
        if (z.action === 'attack') z.cooldown = ATTACK_COOLDOWN * 0.5;
        z.action = 'idle';
        z.speed = 0;
        if (d > 1e-6) z.heading = datan2(dy, dx);
        continue;
      }
    }

    // working an objective or talking to someone: the ones that were after you hold back and wait
    if (busy && (z.action === 'chase' || z.action === 'attack' || z.action === 'scream' || d < 12)) {
      if (z.action === 'attack') z.cooldown = ATTACK_COOLDOWN;
      z.action = 'idle';
      z.speed = 0;
      if (d > 1e-6) z.heading = datan2(dy, dx);
      continue;
    }

    if (z.action === 'scream') { // drawing breath: put it down (or hit it) before it lets go
      z.speed = 0;
      if (d > 1e-6) z.heading = datan2(dy, dx);
      z.actionT -= dt;
      if (z.actionT > 0) continue;
      z.action = 'chase';
      z.screamCd = SCREAM_EVERY;
      callOut(s, z);
      continue;
    }

    if (z.action === 'attack') {
      z.speed = 0;
      if (d > 1e-6) z.heading = datan2(dy, dx); // track the target during the wind-up
      z.actionT -= dt;
      if (z.actionT > 0) continue;
      z.action = 'chase';
      z.cooldown = ATTACK_COOLDOWN;
      if (d >= aReach || (z.roof ?? null) !== s.player.roof) continue; // missed (or you went up out of reach)
      if (car) {
        if (Math.abs(car.speed) < 8.5 && !latchOn(s, z, car)) { // no room left on it: it beats on the body
          s.events.push({ type: 'vehicle-crash', id: car.id, force: 2 });
          damageVehicle(s, car, LATCH_DAMAGE);
        }
        continue;
      }
      if (s.player.invuln > 0) continue;
      const mercy = closeCall(s);
      const took = hurtPlayer(s, (lash ? LASH_DAMAGE : z.kind === 'crawler' ? CRAWL_DAMAGE : ATTACK_DAMAGE) * (mercy ? MERCY_DAMAGE : 1));
      // every bite feeds the infection: the clock jumps ahead (less through gear)
      const lost = Math.min(s.remaining, BITE_COST * (took / ATTACK_DAMAGE) * (1 - (s.arsenal.perks?.bite ?? 0)));
      s.remaining -= lost;
      s.events.push({ type: 'bitten', seconds: lost });
      s.player.bitten = true;
      s.player.invuln = HIT_INVULNERABLE * (mercy ? MERCY_INVULN : 1);
      if (z.kind === 'crawler') { // it does not knock you back: it holds on
        s.player.slowT = GRAB_SECONDS;
        s.events.push({ type: 'grabbed', seconds: GRAB_SECONDS });
      } else if (d > 1e-6) { // a lasher drags you in; the rest knock you away
        const k = lash ? -LASH_PULL : KNOCKBACK;
        s.player.vel.x += (dx / d) * k;
        s.player.vel.y += (dy / d) * k;
      }
      s.events.push({ type: 'player-hit', damage: took, by: z.id });
      if (s.player.health <= 0) {
        s.player.health = 0;
        z.action = 'feed';
        s.killerId = z.id;
        lose(s, 'caught');
        if (room) continue;
        return;
      }
      continue;
    }

    // the roofs: up after you, crowding the ladder's foot, or back down
    const rt = roofTurn(s, z, dt, d, aRange);
    if (rt.done) continue;

    // drawn to a noise: walk to it and mill about, unless you are right there
    if ((z.lureT ?? 0) > 0 && z.lure && d > 4.5) {
      z.lureT = (z.lureT ?? 0) - dt;
      const lx = z.lure.x - z.pos.x, ly = z.lure.y - z.pos.y, ld = dhypot(lx, ly);
      const before = { x: z.pos.x, y: z.pos.y };
      const v = ld > 1.5 ? (z.kind === 'runner' ? RUNNER_SPEED * 0.7 : WALKER_SPEED_BY_TIER[s.tier]!) * s.zombieMul : 0;
      z.action = v > 0 ? 'wander' : 'idle';
      if (ld > 1e-6) {
        z.pos.x += (lx / ld) * v * dt;
        z.pos.y += (ly / ld) * v * dt;
        if (v > 0) z.heading = datan2(ly, lx);
      }
      resolve(s.map, z.pos, ZOMBIE_RADIUS);
      for (const c of s.vehicles) pushOutOfVehicle(c, z.pos, ZOMBIE_RADIUS);
      z.speed = dt > 0 ? dhypot(z.pos.x - before.x, z.pos.y - before.y) / dt : 0;
      continue;
    }

    // a stalker knows where you are whatever you do; the rest see less of you in the dark, or once you are nearly one of them
    const hidden = s.player.hide !== null; // hidden: only the ones that saw you go in, or come right up to you, know
    const sight = z.alertT > 0 ? Infinity
      : hidden ? (d < HIDE_FOUND || (z.kind === 'stalker' && d < STALKER_FINDS) ? Infinity : 0)
      : z.kind === 'stalker' ? STALKER_SENSE
        : (z.kind === 'runner' ? RUNNER_SIGHT : z.kind === 'screamer' ? SCREAMER_SIGHT : z.kind === 'crawler' ? CRAWLER_SIGHT : WALKER_SIGHT_BY_TIER[s.tier]!) * seen;
    const own = z.kind === 'runner' ? RUNNER_SPEED : z.kind === 'stalker' ? STALKER_SPEED : z.kind === 'crawler' ? CRAWLER_SPEED : walk;
    const chaseSpeed = (ride && z.alertT > 0 && z.kind !== 'crawler' ? (z.kind === 'runner' ? SWARM_SPEED : Math.max(own, walk * 1.5)) : own) * s.zombieMul * (closeCall(s) ? MERCY_SPEED : 1);

    if (rt.reach && d < aRange && z.cooldown <= 0 && !(ride && Math.abs(ride.speed) > (car ? 8 : 3))) {
      z.action = 'attack';
      z.actionT = ATTACK_WINDUP[z.kind];
      z.speed = 0;
      s.events.push({ type: 'zombie-attack', id: z.id });
      continue;
    }
    // a screamer that has you in plain view stops and fills its lungs
    if (z.kind === 'screamer' && z.screamCd <= 0 && d < Math.min(sight, SCREAM_RADIUS) && lineClear(s.map, z.pos, p, ZOMBIE_RADIUS)) {
      z.action = 'scream';
      z.actionT = SCREAM_WINDUP;
      z.speed = 0;
      s.events.push({ type: 'zombie-alert', id: z.id });
      continue;
    }

    let vx = 0, vy = 0, v = 0;
    if (d < sight) {
      if (z.action !== 'chase') {
        z.action = 'chase';
        s.events.push({ type: 'zombie-alert', id: z.id });
      }
      v = chaseSpeed;
      if (d < 3 || lineClear(s.map, z.pos, p, ZOMBIE_RADIUS)) {
        // after a vehicle, they run for where it will be, to get in front of it
        const lead = ride ? Math.min(1.2, d / 12) : 0;
        const tx = dx + s.player.vel.x * lead, ty = dy + s.player.vel.y * lead, tl = dhypot(tx, ty);
        if (tl > 1e-6) { vx = tx / tl; vy = ty / tl; }
      } else {
        // follow the BFS gradient toward the player through the streets
        const c = cellOf(s.map, z.pos);
        let best = s.flow[c] as number, bc = -1;
        for (const n of [c - 1, c + 1, c - cols, c + cols]) {
          if (n < 0 || n >= s.flow.length) continue;
          const fv = s.flow[n] as number;
          if (fv < best) { best = fv; bc = n; }
        }
        if (bc >= 0 && best !== UNREACHABLE) {
          const tx = (bc % cols) + 0.5 - z.pos.x;
          const ty = Math.floor(bc / cols) + 0.5 - z.pos.y;
          const tl = dhypot(tx, ty) || 1;
          vx = tx / tl; vy = ty / tl;
        }
      }
    } else {
      // lost interest: stand, or shuffle about
      z.wanderT -= dt;
      if (z.wanderT <= 0) {
        z.wanderT = range(s.rng, 2, 5);
        if (next(s.rng) < 0.45) z.wanderDir = { x: 0, y: 0 };
        else {
          const a = next(s.rng) * Math.PI * 2;
          z.wanderDir = { x: dcos(a), y: dsin(a) };
        }
      }
      vx = z.wanderDir.x; vy = z.wanderDir.y;
      const moving = vx !== 0 || vy !== 0;
      z.action = moving ? 'wander' : 'idle';
      v = moving ? Math.min(own, WALKER_SPEED_BY_TIER[0] * 0.7) : 0;
    }

    const before = { x: z.pos.x, y: z.pos.y };
    z.pos.x += vx * v * dt;
    z.pos.y += vy * v * dt;
    resolve(s.map, z.pos, ZOMBIE_RADIUS);
    for (const c of s.vehicles) pushOutOfVehicle(c, z.pos, ZOMBIE_RADIUS);
    z.speed = dt > 0 ? dhypot(z.pos.x - before.x, z.pos.y - before.y) / dt : 0;
    if (vx !== 0 || vy !== 0) z.heading = datan2(vy, vx);
    if (z.action === 'wander' && z.speed < v * 0.3) z.wanderT = 0; // hit a wall: turn next time
  }
  if (room) { tag(); s.cur = first; }
  for (const z of s.zombies) if (z.action === 'dead' && z.actionT <= 0) s.corpses.push({ id: z.id, pos: { ...z.pos }, heading: z.heading, ...(z.kind === 'crawler' ? { half: true } : {}) });
  if (s.corpses.length > CORPSES_KEPT) s.corpses.splice(0, s.corpses.length - CORPSES_KEPT);
  s.zombies = s.zombies.filter((z) => z.action !== 'dead' || z.actionT > 0);
  separate(s);
}

/** Push overlapping zombies apart so a crowd spreads out instead of stacking. */
function separate(s: GameState): void {
  const zs = s.zombies.filter((z) => z.action !== 'dead' && z.action !== 'dormant' && z.latch == null && nearestPlayerDist(s, z.pos) < ZOMBIE_ACTIVE_RADIUS);
  const level = (z: Zombie) => z.roof ?? -1;
  const min = ZOMBIE_RADIUS * 2;
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      if (level(zs[i]!) !== level(zs[j]!)) continue; // one up a roof, one below: no shoving
      const a = zs[i]!.pos, b = zs[j]!.pos;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = dhypot(dx, dy);
      if (d >= min || d < 1e-6) continue;
      const push = (min - d) / 2;
      a.x -= (dx / d) * push; a.y -= (dy / d) * push;
      b.x += (dx / d) * push; b.y += (dy / d) * push;
    }
  }
  // and out of the living: a zombie stands against you, not inside you (its lunge reaches past this, so bites still land).
  // Only the zombie gives way, so a crowd cannot shove you about; one feeding, latched on or a turned player is let be.
  const touch = (PLAYER_RADIUS + ZOMBIE_RADIUS) * 0.8; // the bodies drawn are slimmer than their circles: shoulder to shoulder, not inside
  for (const pl of s.players) {
    if (pl.status !== 'alive' || pl.vehicleId !== null || pl.hide !== null) continue;
    for (const z of zs) {
      if (z.action === 'feed' || level(z) !== (pl.roof ?? -1)) continue;
      const dx = z.pos.x - pl.pos.x, dy = z.pos.y - pl.pos.y, d = dhypot(dx, dy);
      if (d >= touch) continue;
      let ux = d > 1e-6 ? dx / d : -dcos(z.heading), uy = d > 1e-6 ? dy / d : -dsin(z.heading); // right on top: back off the way it faces
      // walking into one, you brush past it: it is put to the side of your path, not shoved along in front of you
      const sp = dhypot(pl.vel.x, pl.vel.y);
      if (sp > 0.5) {
        const mx = pl.vel.x / sp, my = pl.vel.y / sp, ahead = ux * mx + uy * my;
        if (ahead > 0) {
          let sx = ux - mx * ahead, sy = uy - my * ahead; // the part of its offset that is across your path
          const sl = dhypot(sx, sy);
          if (sl > 1e-3) { sx /= sl; sy /= sl; } else { sx = -my; sy = mx; } // dead ahead: step it to your left
          // half across, half along: it gives way, but you still have to shoulder through (it is not swept clear)
          const bx = ux + sx, by = uy + sy, bl = dhypot(bx, by);
          if (bl > 1e-6) { ux = bx / bl; uy = by / bl; } else { ux = sx; uy = sy; }
        }
      }
      z.pos.x = pl.pos.x + ux * touch; z.pos.y = pl.pos.y + uy * touch;
      // you are up against the edge of the district: it goes beside you along it, not back inside you
      const lo = ZOMBIE_RADIUS, hi = s.map.size - ZOMBIE_RADIUS;
      if (z.pos.x < lo || z.pos.x > hi) {
        z.pos.x = z.pos.x < lo ? lo : hi;
        z.pos.y = pl.pos.y + (uy < 0 ? -1 : 1) * Math.sqrt(Math.max(0, touch * touch - (z.pos.x - pl.pos.x) ** 2));
      }
      if (z.pos.y < lo || z.pos.y > hi) {
        z.pos.y = z.pos.y < lo ? lo : hi;
        z.pos.x = pl.pos.x + (ux < 0 ? -1 : 1) * Math.sqrt(Math.max(0, touch * touch - (z.pos.y - pl.pos.y) ** 2));
      }
    }
  }
  for (const z of zs) { if (z.roof != null) onRoof(s.map.ladders[z.roof]!, z.pos); else resolve(s.map, z.pos, ZOMBIE_RADIUS); }
}
