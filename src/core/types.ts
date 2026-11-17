export interface Vec2 {
  x: number;
  y: number;
}

export type ObstacleKind =
  | 'building' | 'tower' | 'house' | 'warehouse' | 'shop' | 'container'
  | 'car' | 'wreck' | 'dumpster' | 'barrel' | 'barricade' | 'lamp' | 'tree' | 'deadtree' | 'fence' | 'pump' | 'bench'
  | 'water' | 'store'
  | 'bus' | 'truck' | 'sandbag' | 'ambulance' | 'hospital';

export type District = 'downtown' | 'residential' | 'park' | 'industrial' | 'outskirts' | 'water';
/** What part of the city a chapter is in: the centre, the docks and rail yard, or the edge of town. */
export type Theme = 'downtown' | 'docks' | 'edge';

export interface Block {
  i: number;
  j: number;
  x: number; // min corner
  y: number;
  size: number;
  district: District;
  /** Landmark name shown on the map, if any. */
  landmark?: string;
}

/** Ground and overhead dressing with no collision (grass, dirt, a gas station canopy, pier planks). */
export interface Decor {
  kind: 'grass' | 'dirt' | 'canopy' | 'pier' | 'plaza' | 'lot'
    | 'rubble' | 'litter' | 'luggage' | 'weeds' | 'fallenlamp' | 'scorch' | 'checkpoint' | 'rails';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParkingSpot {
  x: number;
  y: number;
  heading: number; // radians, along the street
}

/** Any solid axis-aligned box: buildings and street props. All of them block movement and pathing. */
export interface Building {
  kind: ObstacleKind;
  x: number; // min corner
  y: number;
  w: number;
  h: number;
  height: number; // visual only
  tone: number; // visual only, 0..1
}

/** A weapon store building with its door on the street. */
export interface Storefront {
  x: number; // the building's footprint (also an obstacle in `buildings`)
  y: number;
  w: number;
  h: number;
  door: Vec2; // just outside the entrance, on the street
  facing: Vec2; // unit vector out of the front of the building
}

export interface MapData {
  size: number;
  cols: number; // nav grid is cols x cols, 1 unit per cell
  buildings: Building[]; // every solid obstacle
  blocked: Uint8Array; // 1 = not walkable for pathing
  points: Vec2[]; // candidate street points (all walkable)
  blocks: Block[];
  decor: Decor[];
  parking: ParkingSpot[]; // kerbside spots where drivable vehicles start
  storefronts: Storefront[];
  /** Named places on the street (the checkpoint), for the map. Block landmarks live on blocks. */
  labels: Array<{ name: string; x: number; y: number }>;
  /** Spatial hash of obstacle indices, `gridCell` units per cell, `gridN` x `gridN` cells. */
  grid: number[][];
  gridCell: number;
  gridN: number;
}

import type { Archetype, Effect, PuzzleKind, Skin } from './content';

/** A step's id, from the task content (public/content/tasks.json). */
export type TaskId = string;

export type Reward = 'speed' | 'calm' | 'funds';

export interface Task {
  id: TaskId;
  kind: Archetype;
  required: boolean;
  requires: TaskId[];
  pos: Vec2;
  /** A step at someone's door: the point on the building's wall where the door is (pos is just outside). */
  door?: Vec2;
  timeCost: number; // seconds removed from the clock on completion (optional tasks)
  reward: Reward | null;
  done: boolean;
  /** Pieces to find first, scattered nearby (fuses, batteries, map pieces); then you fit them at `pos`. */
  parts?: Vec2[];
  got?: boolean[];
  /** How long it takes, standing at it (default TASK_HOLD_SECONDS). */
  seconds?: number;
  effect?: Effect;
  /** Whoever you are escorting has to be with you. */
  needsEscort?: boolean;
  /** Who comes with you once this is done (escort-start). */
  escort?: { name: string; skin: Skin; scale: number; party?: Array<{ name: string; skin: Skin; scale: number }> };
  /** A door code or phone number for the step's group ({code} in its text). */
  code: string;
  puzzle?: PuzzleKind;
  /** The puzzle's starting position (tile turns, or the far ends of the wires). */
  scramble?: number[];
  /** Infected to clear (a clear step), and the ones that came once you got close. */
  clear?: number;
  targets?: number[];
}

/** Someone you are taking somewhere: they follow you (and ride along in a car). */
export interface Escort {
  pos: Vec2;
  heading: number;
  speed: number;
  riding: boolean;
  name: string;
  skin: Skin;
  scale: number;
  /** The rest of a group you are bringing in, each following the one in front. */
  party?: Escort[];
  /** Bitten and hiding it: they turn when `turnT` runs out, in the street or behind the door you took them to. */
  bitten?: boolean;
  turnT?: number;
  /** Seconds to their next cough (the bitten cough often; now and then someone healthy does too). */
  coughT?: number;
  coughEvery?: number;
  /** What looking them over found, once you have. */
  checked?: 'clean' | 'bitten';
}

/** Someone you found bitten and left where they stood. They turn in the end. */
export interface Abandoned {
  name: string;
  skin: Skin;
  scale: number;
  pos: Vec2;
  turnT: number;
}

/** Who you were the last time this district took you: they are still here, with what you carried. */
export interface Husk {
  pos: Vec2;
  weapon: WeaponKind | null;
}

/** `screamer`: calls everything in earshot when it sees you. `stalker`: comes at you through the dark and
 * stands still in your light. `crawler`: the top half of one, dragging itself; it gets hold of your leg.
 * `lasher`: what the plague grows where the head was; it strikes from well out of arm's reach and pulls you in. */
export type ZombieKind = 'walker' | 'runner' | 'screamer' | 'stalker' | 'crawler' | 'lasher';
/** What a zombie is doing; the renderer picks its animation from this, not from guessing. */
/** `dormant`: lying among the dead until you come close. `scream`: drawing breath to call the rest. */
export type ZombieAction = 'rise' | 'idle' | 'wander' | 'chase' | 'attack' | 'feed' | 'cling' | 'dead' | 'dormant' | 'scream';

export interface Zombie {
  id: number;
  kind: ZombieKind;
  pos: Vec2;
  heading: number; // radians
  speed: number; // current ground speed, units/s (drives animation playback rate)
  action: ZombieAction;
  actionT: number; // seconds left in a timed action (rise, attack wind-up)
  cooldown: number; // seconds before it can attack again
  health: number;
  staggerT: number; // flinching from a hit: no moving, no lunging
  alertT: number; // heard gunfire: hunts the player regardless of sight
  wanderT: number;
  wanderDir: Vec2;
  /** Drawn to a noise (a smashed bottle, a car alarm): walks there instead of hunting you. */
  lure?: Vec2 | null;
  lureT?: number;
  /** Hanging on to a vehicle (its id), at a spot on its body (along, across, in its own frame). */
  latch?: number | null;
  latchAt?: Vec2;
  /** How long it has been shaken at speed; it lets go after LATCH_GRIP seconds. */
  latchT?: number;
  /** How long it has had hold of someone you are protecting. */
  biteT?: number;
  /** Rooms: which player it is after, and for how many more seconds it keeps to that one. */
  targetId?: number;
  targetT?: number;
  /** Seconds before a screamer can call again. */
  screamCd?: number;
  /** A stalker caught in your light this step (it does not move). */
  frozen?: boolean;
  /** Your last self in this district. */
  husk?: boolean;
}

export type VehicleKind = 'sedan' | 'pickup' | 'van' | 'bike';

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  pos: Vec2;
  heading: number; // radians, direction the nose points
  speed: number; // signed, units/s (negative = reversing)
  health: number;
  wrecked: boolean;
  tone: number; // paint, visual only
  fuel: number; // 0..1; an empty tank coasts to a stop
}

export type GearKind = 'vest' | 'helmet';

export type Loot = 'medkit' | 'supplies' | 'ammo' | 'bottles' | 'antiviral' | GearKind | 'empty';

/** A house you can search: loot inside, and sometimes one of them. */
export interface House {
  id: number;
  pos: Vec2; // outside the front door
  loot: Loot;
  ambush: boolean;
  searched: boolean;
  /** What the quarantine teams painted on the door: a red X (infected inside), a white ring (cleared),
   * or nothing (they never got this far). */
  mark: 'infected' | 'clear' | null;
}

export type SurvivorRequest = 'clear' | 'fetch';
export type SurvivorReward = 'funds' | 'ammo' | 'weapon' | 'intel';

/** Someone holed up who wants help, and pays for it. */
export interface Survivor {
  id: number;
  name: string;
  pos: Vec2;
  request: SurvivorRequest;
  reward: SurvivorReward;
  status: 'waiting' | 'asked' | 'ready' | 'done';
  fetchPos: Vec2; // where the thing they need is (fetch)
  carrying: boolean; // you have picked it up (fetch)
  targets: number[]; // the zombies to clear (clear)
  skin: number; // visual only
}

/** A car alarm going off: a noise everything nearby walks to. */
export interface Alarm {
  car: number; // index into map.buildings
  pos: Vec2;
  t: number; // seconds left
}

/** A bottle in the air. */
export interface Thrown {
  from: Vec2;
  to: Vec2;
  t: number; // seconds in flight so far
  dur: number;
}

export type GunKind = 'pistol' | 'shotgun' | 'rifle';
export type MeleeKind = 'baton' | 'bat' | 'machete';
export type WeaponKind = GunKind | MeleeKind;
export type UpgradeKind = 'damage' | 'mag' | 'reload';

export type PickupKind = WeaponKind | GearKind | 'ammo' | 'bottles' | 'jerrycan' | 'antiviral';

/** Lying in the street: walk over it to take it. */
export interface Pickup {
  id: number;
  kind: PickupKind;
  pos: Vec2;
  taken: boolean;
}

/** Something on sale at a weapon store. */
export type StoreItem =
  | { kind: 'weapon'; weapon: WeaponKind }
  | { kind: 'ammo'; weapon: GunKind }
  | { kind: 'upgrade'; weapon: WeaponKind; upgrade: UpgradeKind }
  | { kind: 'gear'; gear: GearKind }
  | { kind: 'medkit' }
  | { kind: 'antiviral' }
  | { kind: 'bottles' }
  | { kind: 'jerrycan' };

export interface Store {
  id: number;
  name: string;
  pos: Vec2; // the door, on the street: walk in here
  front: Storefront;
}

export interface Crate {
  id: number;
  pos: Vec2;
  loot: Loot;
  opened: boolean;
}

/** What the Use button would do right now (for the contextual button label). */
export type Interaction =
  | { kind: 'exit'; vehicleId: number }
  | { kind: 'enter'; vehicleId: number }
  | { kind: 'task'; taskId: TaskId }
  | { kind: 'crate'; crateId: number }
  | { kind: 'store'; storeId: number }
  | { kind: 'house'; houseId: number }
  | { kind: 'talk'; survivorId: number }
  | { kind: 'refuel'; vehicleId: number }
  | { kind: 'alarm'; car: number }
  /** Look someone you are bringing in over for a bite (`who`: their place in the group). */
  | { kind: 'check'; who: number }
  /** Leave someone you found bitten. */
  | { kind: 'leave'; who: number };

/** `cleared`: through the door at the end of a chapter; the next district is loading. */
export type Phase = 'playing' | 'cleared' | 'won' | 'lost';
/** `time`: the infection ran its course and you turned. `caught`: they got you first. `infected`: someone
 * you were protecting was bitten. `carrier`: you brought someone bitten inside. */
export type LossReason = 'time' | 'caught' | 'infected' | 'carrier';

export type GameEvent =
  | { type: 'task-done'; id: TaskId }
  | { type: 'task-locked'; id: TaskId; needs: TaskId[] }
  | { type: 'safehouse-locked' }
  | { type: 'tier-up'; tier: number }
  | { type: 'time-penalty'; seconds: number }
  | { type: 'zombie-alert'; id: number }
  | { type: 'zombie-killed'; id: number }
  /** `by`: a zombie's id, or -1 - seat for another player. `seat`: whose it was (rooms). */
  | { type: 'player-hit'; damage: number; by: number; seat?: number }
  | { type: 'shot'; weapon: GunKind; from: Vec2; to: Vec2; hit: number | null }
  | { type: 'zombie-hurt'; id: number }
  | { type: 'swing'; weapon: MeleeKind; hits: number }
  | { type: 'reload'; weapon: GunKind }
  | { type: 'empty'; weapon: GunKind }
  | { type: 'pickup'; kind: PickupKind; amount: number }
  | { type: 'purchase'; item: StoreItem }
  | { type: 'store-open'; id: number }
  | { type: 'equip'; weapon: WeaponKind }
  | { type: 'healed'; amount: number }
  | { type: 'task-started'; id: TaskId }
  | { type: 'crate-opened'; id: number; loot: Loot }
  | { type: 'vehicle-enter'; id: number }
  | { type: 'vehicle-exit'; id: number }
  | { type: 'vehicle-crash'; id: number; force: number }
  | { type: 'vehicle-wrecked'; id: number }
  /** One grabbed hold of the vehicle you are in (count: how many are on it now). */
  | { type: 'latched'; id: number; count: number }
  /** Shaken off at speed or thrown by a crash. */
  | { type: 'shaken'; id: number }
  /** Not enough seats for everyone you are bringing in. */
  | { type: 'no-room'; need: number; seats: number }
  /** They heard you start it: a swarm comes out of the side streets. */
  | { type: 'swarm'; count: number }
  /** The vehicle is so beaten that the ones on it can reach you inside. */
  | { type: 'vehicle-breached'; id: number }
  | { type: 'zombie-attack'; id: number }
  | { type: 'house-searched'; id: number; loot: Loot; ambush: boolean }
  | { type: 'survivor-asked'; id: number; first: boolean }
  | { type: 'survivor-ready'; id: number }
  | { type: 'survivor-done'; id: number; reward: SurvivorReward }
  | { type: 'fetched'; id: number }
  | { type: 'refueled'; id: number; from: 'can' | 'pump' }
  | { type: 'out-of-fuel'; id: number }
  | { type: 'throw'; to: Vec2 }
  | { type: 'bottle-smash'; pos: Vec2 }
  | { type: 'alarm-start'; car: number; pos: Vec2 }
  | { type: 'alarm-stop'; car: number }
  | { type: 'work-started'; kind: 'search' | 'talk' | 'refuel' | 'check' }
  | { type: 'gear-hit'; gear: GearKind; absorbed: number }
  | { type: 'gear-broken'; gear: GearKind }
  | { type: 'chapter-cleared'; chapter: number }
  | { type: 'part-taken'; id: TaskId; got: number; of: number }
  | { type: 'escort-behind' }
  | { type: 'puzzle-open'; id: TaskId }
  | { type: 'puzzle-wrong'; id: TaskId }
  | { type: 'clear-start'; id: TaskId; count: number }
  | { type: 'flare-lit'; pos: Vec2 }
  | { type: 'horde'; pos: Vec2 }
  /** A pack is standing over the current objective. */
  | { type: 'guarded'; id: TaskId; count: number }
  /** The way out is shown and they are coming for you. */
  | { type: 'chase'; count: number }
  /** One of the infected is right on someone you are bringing in (once every few seconds). */
  | { type: 'escort-danger'; name: string }
  /** You shot one in half and the top half is still coming. */
  | { type: 'halved'; id: number }
  /** A crawler has your leg: you are slowed for this long. */
  | { type: 'grabbed'; seconds: number }
  /** A bite: the infection jumps ahead by this many seconds. */
  | { type: 'bitten'; seconds: number }
  /** A dose: the infection is held back by this many seconds. */
  | { type: 'antiviral'; seconds: number }
  /** The flashlight went on or off. */
  | { type: 'light'; on: boolean }
  /** The quiet breaks: one sound, somewhere close. Something is about to happen there. */
  | { type: 'omen'; pos: Vec2 }
  /** And then it does: they come up out of the ground around you. */
  | { type: 'burst'; pos: Vec2; count: number }
  /** A body that was not dead. */
  | { type: 'dormant-wake'; id: number }
  /** A screamer has seen you and called: `count` more are coming. */
  | { type: 'scream'; id: number; pos: Vec2; count: number }
  /** A cough: yours (the infection, and they hear it), or someone you are bringing in. */
  | { type: 'cough'; who: string | null; pos: Vec2 }
  | { type: 'checked'; name: string; bitten: boolean }
  | { type: 'left-behind'; name: string }
  /** Someone bitten turned: beside you in the street, where you left them, or behind the door. */
  | { type: 'escort-turned'; name: string; where: 'street' | 'left' | 'inside' }
  /** Your last self is down, and what it carried is on the ground. */
  | { type: 'husk-down'; id: number }
  /** Another block has fallen to the infection (the map shows it). */
  | { type: 'block-fallen'; block: number }
  /** Rooms: a player lay down, turned, got out, or a turned one was put down. */
  | { type: 'down'; seat: number }
  | { type: 'turned'; seat: number; pos: Vec2 }
  | { type: 'escaped'; seat: number }
  | { type: 'lunge'; seat: number; pos: Vec2; hits: number }
  | { type: 'round-end'; placements: Placement[] }
  | { type: 'won' }
  | { type: 'lost'; reason: LossReason };

/** How a seat finished a room round. */
export interface Placement {
  seat: number;
  status: PlayerStatus;
  escapedAt: number | null;
  kills: number;
}

export interface Arsenal {
  weapon: WeaponKind | null; // in hand
  owned: WeaponKind[];
  mag: Record<GunKind, number>; // rounds in the magazine
  ammo: Record<GunKind, number>; // spare rounds
  /** Upgrade level bought for each weapon (0..UPGRADE_LEVELS). Melee weapons only take damage. */
  upgrades: Record<WeaponKind, Record<UpgradeKind, number>>;
  fireCd: number;
  reloadT: number; // seconds left on a reload (0 = not reloading)
  swing: number; // counts swings, so the renderer can alternate them
  bottles: number; // to throw as a distraction
  cans: number; // jerrycans of fuel
  /** Protective gear worn, as durability left (0 = not wearing it). */
  gear: Record<GearKind, number>;
}

/** A short job you stand still for: searching a house, talking to a survivor, refuelling a car, looking someone over. */
export interface Work {
  kind: 'search' | 'talk' | 'refuel' | 'check';
  id: number;
  progress: number; // 0..1
  seconds: number;
}

/**
 * `alive`: playing. `down`: out of health, lying still for a few seconds before turning. `turned`: now one
 * of them and still playing (rooms only). `escaped`: through the exit. `dead`: a turned player put down.
 * `missed`: still alive when the round ended without them.
 */
export type PlayerStatus = 'alive' | 'down' | 'turned' | 'escaped' | 'dead' | 'missed';

/** Everyone in a night: you in a solo run, each seat in a room. The rules act on the state's `cur` player. */
export interface Player {
  id: number; // seat, 0-based
  status: PlayerStatus;
  // the body
  pos: Vec2;
  vel: Vec2;
  heading: number;
  health: number;
  invuln: number;
  vehicleId: number | null;
  /** Seconds a crawler still has hold of your leg. */
  slowT: number;
  // what they carry and where they stand in the night
  arsenal: Arsenal;
  funds: number;
  kills: number;
  /** The infection clock: seconds of the dose left. */
  remaining: number;
  /** The flashlight. On, you see and are seen; off, they have to be much closer to notice you. */
  light: boolean;
  /** Seconds to your next cough, once the infection is far enough along. */
  coughT: number;
  hold: { taskId: TaskId | null; progress: number };
  work: Work | null;
  /** Grace after finishing an objective: zombies keep holding back while you step away. */
  safeT: number;
  speedMul: number;
  /** In a block that has fallen. */
  inFallen: boolean;
  /** The store whose doorway you are standing in after leaving it (no re-entry until you step out). */
  storeLatch: number | null;
  lockedNotice: 'safehouse' | null;
  /** Zombie that caught the player, if any (the renderer stages the ending around it). */
  killerId: number | null;
  /** The path field to this player, and the cell it was made for. */
  flow: Int16Array;
  flowCell: number;
  /** Someone following this player to safety, once found. */
  escort: Escort | null;
  escortLost: boolean;
  pumping: boolean;
  /** Seconds until the next "they are on someone" warning. */
  dangerT: number;
  /** Seconds to the engine's next call to every zombie in earshot. */
  engineT: number;
  /** Seconds to the next swarm while driving. */
  swarmT: number;
  // rooms only
  /** Seconds lying still before turning (status `down`). */
  downT: number;
  /** Seconds before a turned player can lunge again. */
  lungeCd: number;
  /** Bitten at least once this round (what another player's CHECK looks for). */
  bitten: boolean;
  /** What this player learned from CHECKing others, by seat: was that one bitten when they looked? (They may be since.) */
  checks: Record<number, boolean>;
  /** On the client's copy of someone else: this player's CHECK of them says bitten. (The server never sets it on the real state.) */
  exposed: boolean;
  /** When (room time) they went through the exit, if they did. */
  escapedAt: number | null;
}

export interface Input {
  dx: number; // -1..1, world space
  dy: number;
  /** The Use button was pressed this step (edge, not held). */
  action?: boolean;
  /** Fire is held. */
  fire?: boolean;
  /** Reload / switch weapon were pressed this step (edges). */
  reload?: boolean;
  swap?: boolean;
  /** Throw a bottle was pressed this step (edge). */
  throw?: boolean;
  /** Flashlight on/off was pressed this step (edge). */
  light?: boolean;
}
