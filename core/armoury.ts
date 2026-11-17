// The armoury: what a player owns between nights, and the loadout they carry into one. Shared by the game (which
// starts a night with it), the server (which checks a run's loadout against what the account owns before it replays
// it) and the site (which sells it). Pure: no DOM, no clock, no randomness.
//
// Fairness: tonight's city is ranked and the same for everyone, so a ranked loadout has a budget of points every player
// gets alike. Owning more gives you choice of what to bring, not more of it. Practice nights (and later rooms) take the
// open loadout, which has no limit.
import { GUNS, UPGRADE_LEVELS, GEAR } from './config';
import type { UpgradeKind, WeaponKind } from './types';
import { isWeapon, weaponsOf, type KitId, type Loadout, type UpId } from './loadout';

export { applyLoadout, ALL_WEAPONS, STANDARD, weaponsOf, type KitId, type Loadout, type UpId } from './loadout';

export interface KitDef { id: KitId; name: string; group: 'weapon' | 'gear' | 'supply'; price: number; points: number; blurb: string }
export const KIT: readonly KitDef[] = [
  { id: 'bat', name: 'Baseball bat', group: 'weapon', price: 300, points: 1, blurb: 'Wide swings that hit up to three at once.' },
  { id: 'machete', name: 'Machete', group: 'weapon', price: 700, points: 2, blurb: 'Quiet and brutal: the hardest-hitting blade.' },
  { id: 'shotgun', name: 'Shotgun', group: 'weapon', price: 900, points: 4, blurb: 'Six pellets a shot. Clears a doorway, wakes the street.' },
  { id: 'rifle', name: 'Assault rifle', group: 'weapon', price: 1800, points: 6, blurb: 'Thirty rounds, long reach, very loud.' },
  { id: 'helmet', name: 'Riot helmet', group: 'gear', price: 450, points: 2, blurb: `Takes ${GEAR.helmet.absorb * 100}% of every hit until it is worn through.` },
  { id: 'vest', name: 'Kevlar vest', group: 'gear', price: 800, points: 3, blurb: `Takes ${GEAR.vest.absorb * 100}% of every hit until it is worn through.` },
  { id: 'ammo', name: 'Ammo belt', group: 'supply', price: 250, points: 1, blurb: 'A spare pack of rounds for every gun you bring.' },
  { id: 'bottles', name: 'Bottle bag', group: 'supply', price: 150, points: 1, blurb: 'Two more bottles to throw.' },
  { id: 'cash', name: 'Emergency cash', group: 'supply', price: 400, points: 1, blurb: '$50 more to spend at the stores.' },
];
export const kitDef = (id: KitId): KitDef => KIT.find((k) => k.id === id)!;

export const UPGRADE_NAMES: Record<UpgradeKind, string> = { damage: 'Damage', mag: 'Magazine', reload: 'Reload' };
/** What an upgrade level costs to own, by weapon (level 2 costs twice level 1). Melee only takes damage. */
const UP_BASE: Record<WeaponKind, number> = { pistol: 250, baton: 150, bat: 200, machete: 300, shotgun: 350, rifle: 450 };
const UP_FACTOR: Record<UpgradeKind, number> = { damage: 1.2, mag: 1, reload: 0.8 };
export const upgradePrice = (w: WeaponKind, u: UpgradeKind, level: number): number => Math.round(UP_BASE[w] * UP_FACTOR[u] * level / 10) * 10;
export const UPGRADE_POINTS = 1; // per level brought
export const upgradable = (w: WeaponKind): UpgradeKind[] => (w in GUNS ? ['damage', 'mag', 'reload'] : ['damage']);

/** Points a ranked loadout may spend. */
export const RANKED_POINTS = 8;

export const EMPTY_LOADOUT: Loadout = { kit: [], ups: {} };

/** What an account owns: kit by id, upgrades by level. */
export interface Owned { kit: KitId[]; ups: Partial<Record<UpId, number>> }

export function loadoutPoints(l: Loadout): number {
  let p = 0;
  for (const id of l.kit) p += kitDef(id).points;
  for (const n of Object.values(l.ups)) p += (n ?? 0) * UPGRADE_POINTS;
  return p;
}

const KIT_IDS = new Set(KIT.map((k) => k.id));

/**
 * Why a loadout cannot be carried, or null. Checks its shape (it may come from a client), that everything in it is
 * owned (or `borrowed` for this night), that upgrades are for weapons it brings, and the ranked budget.
 */
export function loadoutProblem(l: unknown, owned: Owned, ranked: boolean, borrowed: readonly KitId[] = []): string | null {
  if (!l || typeof l !== 'object') return 'not a loadout';
  const x = l as Loadout;
  if (!Array.isArray(x.kit) || x.kit.length > KIT.length || !x.ups || typeof x.ups !== 'object') return 'not a loadout';
  if (new Set(x.kit).size !== x.kit.length) return 'an item is listed twice';
  for (const id of x.kit) {
    if (!KIT_IDS.has(id)) return `unknown item ${String(id)}`;
    if (!owned.kit.includes(id) && !borrowed.includes(id)) return `${kitDef(id).name} is not yours`;
  }
  const brings = weaponsOf(x);
  for (const [key, n] of Object.entries(x.ups)) {
    const [w, u] = key.split('.') as [WeaponKind, UpgradeKind];
    if (!isWeapon(w) || !upgradable(w).includes(u)) return `unknown upgrade ${key}`;
    if (!Number.isInteger(n) || n! < 0 || n! > UPGRADE_LEVELS) return `bad level for ${key}`;
    if (n! > (owned.ups[key as UpId] ?? 0)) return `${UPGRADE_NAMES[u]} ${n} on the ${w} is not yours`;
    if (n! > 0 && !brings.includes(w)) return `an upgrade for a ${w} you are not bringing`;
  }
  if (x.hand !== undefined && !brings.includes(x.hand)) return 'the weapon in hand is not one you are bringing';
  if (ranked && loadoutPoints(x) > RANKED_POINTS) return `over the ranked budget (${loadoutPoints(x)} of ${RANKED_POINTS} points)`;
  return null;
}

// ---------------------------------------------------------------- earning and borrowing

/** Cash banked for a verified night: a share of its score. Practice nights pay half. */
export const earnedFor = (score: number, ranked: boolean): number => Math.floor(score / (ranked ? 25 : 50));
/** The first verified night of the day pays this on top. */
export const DAILY_RATION = 100;
/** At most this much is banked from nights and rounds in one day (so it cannot be farmed without end). */
export const DAILY_CAP = 1500;
/** A multiplayer round: for taking part, and for getting out. */
export const ROUND_PAY = { played: 20, escaped: 80 } as const;
/** Borrowing an item for one night costs this share of its price, paid from what the night earns. */
export const LOAN_SHARE = 0.15;
export const loanFee = (id: KitId): number => Math.max(20, Math.round(kitDef(id).price * LOAN_SHARE / 10) * 10);
