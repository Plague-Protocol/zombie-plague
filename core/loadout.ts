// What a player brings into a night from the armoury, and how a night's arsenal starts from it. The game imports only
// this (it is small); the catalogue, prices and rules are core/armoury.ts, which the site and server load.
import { GEAR, GUNS, UPGRADE_EFFECT } from './config';
import type { Arsenal, GunKind, UpgradeKind, WeaponKind } from './types';

/** Things you own outright and may bring: weapons beyond the pistol and baton, gear, and supplies. */
export type KitId = 'shotgun' | 'rifle' | 'bat' | 'machete' | 'vest' | 'helmet' | 'ammo' | 'bottles' | 'cash';
/** A permanent upgrade of a weapon, owned by level (1..UPGRADE_LEVELS). */
export type UpId = `${WeaponKind}.${UpgradeKind}`;

export interface Loadout {
  kit: KitId[];
  /** Upgrade levels brought (at most the level owned). */
  ups: Partial<Record<UpId, number>>;
  /** The weapon in hand at the start (one you are bringing). */
  hand?: WeaponKind;
}

/** The two weapons everyone starts with. */
export const STANDARD: readonly WeaponKind[] = ['pistol', 'baton'];
export const ALL_WEAPONS: readonly WeaponKind[] = ['pistol', 'baton', 'bat', 'machete', 'shotgun', 'rifle'];
export const isWeapon = (w: unknown): w is WeaponKind => typeof w === 'string' && (ALL_WEAPONS as readonly string[]).includes(w);
const kitWeapon = (k: KitId): k is KitId & WeaponKind => isWeapon(k);
/** The weapons a loadout puts in your hands. */
export const weaponsOf = (l: Loadout): WeaponKind[] => [...STANDARD, ...l.kit.filter(kitWeapon)];

/** Start a night's arsenal (and funds) from a loadout. Assumes it was checked. */
export function applyLoadout(a: Arsenal, funds: number, l: Loadout | undefined): number {
  if (!l) return funds;
  for (const w of l.kit.filter(kitWeapon)) if (!a.owned.includes(w)) a.owned.push(w);
  for (const [key, n] of Object.entries(l.ups)) {
    const [w, u] = key.split('.') as [WeaponKind, UpgradeKind];
    if (n) a.upgrades[w][u] = n;
  }
  for (const g of ['pistol', 'shotgun', 'rifle'] as GunKind[]) {
    if (!a.owned.includes(g)) continue;
    a.mag[g] = Math.round(GUNS[g].mag * (1 + UPGRADE_EFFECT.mag * a.upgrades[g].mag)); // a full magazine
    if (g !== 'pistol') a.ammo[g] += GUNS[g].ammoPack;
    if (l.kit.includes('ammo')) a.ammo[g] += GUNS[g].ammoPack;
  }
  if (l.kit.includes('vest')) a.gear.vest = GEAR.vest.durability;
  if (l.kit.includes('helmet')) a.gear.helmet = GEAR.helmet.durability;
  if (l.kit.includes('bottles')) a.bottles += 2;
  if (l.hand) a.weapon = l.hand;
  return funds + (l.kit.includes('cash') ? 50 : 0);
}
