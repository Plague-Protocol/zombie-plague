// The survivors a player can be: one body, eight faces, each with one perk that grows with its level (0..3). A ranked
// loadout pays a point per level, so the budget everyone shares still holds. The game takes only this; names to show,
// prices and stories are in core/armoury.ts.
import type { Arsenal } from './types';

export type SurvivorId = 'sam' | 'ama' | 'kola' | 'zara' | 'rook' | 'vex' | 'tayo' | 'mimi';
/** What a perk changes (fractions, except funds and bottles, which are counts). */
export type PerkKind = 'reload' | 'search' | 'bite' | 'speed' | 'quiet' | 'melee' | 'funds' | 'bottles';
export interface Perks { reload?: number; search?: number; bite?: number; speed?: number; quiet?: number; melee?: number }

export const SURVIVORS: Record<SurvivorId, { name: string; skin: string; perk: PerkKind; at: readonly [number, number, number, number] }> = {
  sam: { name: 'Sam', skin: 'humanMaleA', perk: 'reload', at: [0, 0.08, 0.16, 0.24] }, // the classic hero: plain at level 0
  ama: { name: 'Ama', skin: 'humanFemaleA', perk: 'search', at: [0.1, 0.2, 0.3, 0.4] },
  kola: { name: 'Kola', skin: 'survivorMaleB', perk: 'bite', at: [0.08, 0.16, 0.24, 0.32] },
  zara: { name: 'Zara', skin: 'survivorFemaleA', perk: 'speed', at: [0.03, 0.06, 0.09, 0.12] },
  rook: { name: 'Rook', skin: 'criminalMaleA', perk: 'quiet', at: [0.1, 0.2, 0.3, 0.4] },
  vex: { name: 'Vex', skin: 'cyborgFemaleA', perk: 'melee', at: [0.08, 0.16, 0.24, 0.32] },
  tayo: { name: 'Tayo', skin: 'skaterMaleA', perk: 'funds', at: [15, 30, 45, 60] },
  mimi: { name: 'Mimi', skin: 'skaterFemaleA', perk: 'bottles', at: [1, 2, 3, 4] },
};
export const MAX_GRIT = 3;
export const isSurvivor = (id: unknown): id is SurvivorId => typeof id === 'string' && id in SURVIVORS;

/** Give a night's arsenal the survivor's perk at a level; returns the funds (a perk may add to them). */
export function applySurvivor(a: Arsenal, funds: number, id: SurvivorId, grit: number): number {
  const sv = SURVIVORS[id], v = sv.at[Math.max(0, Math.min(MAX_GRIT, grit))]!;
  if (sv.perk === 'funds') return funds + v;
  if (sv.perk === 'bottles') { a.bottles += v; return funds; }
  a.perks = { [sv.perk]: v };
  return funds;
}
