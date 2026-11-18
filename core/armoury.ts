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
import { isSurvivor, MAX_GRIT, SURVIVORS, type SurvivorId } from './survivors';

export { MAX_GRIT, SURVIVORS, type SurvivorId } from './survivors';

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
export interface Owned { kit: KitId[]; ups: Partial<Record<UpId | SvId, number>> }
/** A survivor owned, kept with the upgrades: the level is 1 + the perk level owned (1 = unlocked, perk at 0). */
export type SvId = `sv.${SurvivorId}`;

/** The roster as the shop shows it. Sam and Ama come free. */
export const ROSTER: Record<SurvivorId, { price: number; role: string; blurb: string; perk: string }> = {
  sam: { price: 0, role: 'The night porter', blurb: 'Bitten on the clinic stairs. Knows the doses are in the fridge.', perk: 'Reloads faster' },
  ama: { price: 0, role: 'The nurse', blurb: 'Knows where people hide what matters.', perk: 'Searches houses faster' },
  kola: { price: 700, role: 'The dock worker', blurb: 'Thick-skinned in every sense.', perk: 'A bite costs less of the clock' },
  zara: { price: 700, role: 'The courier', blurb: 'Ten years of red lights and back alleys.', perk: 'Moves faster' },
  rook: { price: 1000, role: 'The fence', blurb: 'Never fired a shot anyone heard.', perk: 'Quieter gunfire' },
  vex: { price: 1000, role: 'The mechanic', blurb: 'Half the arm is hers. The other half is steel.', perk: 'Harder melee hits' },
  tayo: { price: 500, role: 'The street seller', blurb: 'Always has a little put away.', perk: 'Starts with more money' },
  mimi: { price: 500, role: 'The skater', blurb: 'Can land a bottle in a bin from forty metres.', perk: 'Starts with more bottles' },
};
const PERK_WORDS: Record<string, string> = { reload: 'faster reloads', search: 'faster searching', bite: 'less lost to a bite', speed: 'faster on foot', quiet: 'quieter shots', melee: 'more melee damage' };
/** What a survivor's perk does at a level, in words. */
export function perkAt(id: SurvivorId, level: number): string {
  const sv = SURVIVORS[id], v = sv.at[level]!;
  if (sv.perk === 'funds') return '+$' + v + ' at the start';
  if (sv.perk === 'bottles') return '+' + v + (v === 1 ? ' bottle' : ' bottles');
  return v ? Math.round(v * 100) + '% ' + PERK_WORDS[sv.perk] : 'no perk yet';
}
/** A survivor's owned level (1 + perk level; 0 = not owned). Sam and Ama are everyone's. */
export const svLevel = (owned: Owned, id: SurvivorId): number => Math.max(owned.ups[('sv.' + id) as SvId] ?? 0, ROSTER[id].price === 0 ? 1 : 0);
/** The price of the next step for a survivor: unlocking, then each perk level. */
export const svPrice = (id: SurvivorId, nextLevel: number): number => (nextLevel === 1 ? ROSTER[id].price : 400 * (nextLevel - 1));

export function loadoutPoints(l: Loadout): number {
  let p = 0;
  for (const id of l.kit) p += kitDef(id).points;
  for (const n of Object.values(l.ups)) p += (n ?? 0) * UPGRADE_POINTS;
  return p + (l.grit ?? 0); // a point per perk level
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
  if (x.survivor !== undefined || x.grit !== undefined) {
    if (!isSurvivor(x.survivor)) return 'unknown survivor';
    const g = x.grit ?? 0;
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRIT) return 'bad perk level';
    if (svLevel(owned, x.survivor) < 1 + g) return SURVIVORS[x.survivor].name + (g ? ' at perk level ' + g : '') + ' is not yours';
  }
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
// Loans: an item borrowed for a term, from the armoury or from another player who put theirs up for loan. The fee is
// paid when it is borrowed. Return it any time (it frees one of the three loan places); keep it past the due time and
// a late fee is taken for each day started, until it goes back on its own.

/** The terms an item can be borrowed for, in days, and the share of its price each costs (longer is cheaper a day). */
export const LOAN_TERMS = { 1: 0.06, 3: 0.12, 7: 0.2 } as const;
export type LoanDays = keyof typeof LOAN_TERMS;
export const LOAN_DAYS = [1, 3, 7] as const satisfies readonly LoanDays[];
const tens = (x: number) => Math.max(10, Math.round(x / 10) * 10);
/** The armoury's fee to borrow an item for a term. */
export const loanFee = (id: KitId, days: LoanDays = 1): number => tens(kitDef(id).price * LOAN_TERMS[days]);
/** Past the due time: this for each day started (the armoury's one-day fee). */
export const lateFee = (id: KitId): number => loanFee(id, 1);
/** Days past due before a loan goes back by itself (the late fees stop there). */
export const LATE_DAYS = 2;
/** Loans one account may hold at once. */
export const MAX_LOANS = 3;
/** What a player lending an item may ask, as a share of the armoury's fee: never more than the armoury. */
export const LEND_RATES = [100, 75, 50] as const;
export type LendRate = (typeof LEND_RATES)[number];
/** A player's fee to borrow their item for a term. */
export const lendFee = (id: KitId, days: LoanDays, rate: LendRate): number => tens((loanFee(id, days) * rate) / 100);
/** What the lender banks of a fee (the armoury keeps the rest). */
export const LENDER_SHARE = 0.9;
export const lenderCut = (fee: number): number => Math.floor(fee * LENDER_SHARE);
