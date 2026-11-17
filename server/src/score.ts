// A night's score, from what the server's own replay counted. Built to reward getting further first, then doing it
// well, and to be hard to farm: kills are capped, time left only counts on a night you survived, and every bite, dose
// and person you let turn costs you. The numbers are published on the leaderboard page so players can see why.
import type { RunStats } from '../../src/core/replay.ts';

export const SCORE = {
  perChapter: 1000, // each district cleared
  win: 2000, // out of the city
  perSecondLeft: 8, // only on a win: how much of the infection you had left
  perKill: 4, killCap: 250, // at most 1,000 from killing: walking past them is often the better play
  perRescue: 150, perOptional: 200, perHusk: 150,
  accuracyMax: 400, accuracyMinShots: 20, // up to 400 for a steady hand, once you have fired enough to mean it
  clean: 500, // a won night without a single bite
  perBite: -50, perDose: -30, perLostEscort: -150,
} as const;

export interface Scored { score: number; parts: Record<string, number> }

export function scoreRun(st: RunStats, won: boolean, secondsLeft: number): Scored {
  const S = SCORE;
  const parts: Record<string, number> = {
    progress: st.cleared * S.perChapter,
    escape: won ? S.win + Math.round(Math.max(0, secondsLeft) * S.perSecondLeft) : 0,
    kills: Math.min(st.kills, S.killCap) * S.perKill,
    rescues: st.rescues * S.perRescue,
    optional: st.optional * S.perOptional,
    husks: st.husks * S.perHusk,
    accuracy: st.shots >= S.accuracyMinShots ? Math.round(S.accuracyMax * (st.hits / st.shots)) : 0,
    clean: won && st.bites === 0 ? S.clean : 0,
    bites: st.bites * S.perBite,
    doses: st.doses * S.perDose,
    lost: st.lostEscorts * S.perLostEscort,
  };
  for (const k of Object.keys(parts)) if (parts[k] === 0) delete parts[k];
  const score = Math.max(0, Object.values(parts).reduce((a, b) => a + b, 0));
  return { score, parts };
}

/** A title for where you stand on a board, by percentile (rank 1 is always the top title). */
export function titleFor(rank: number, of: number): string {
  if (rank === 1) return 'Last Light';
  const p = rank / Math.max(1, of);
  return p <= 0.01 ? 'Untouched' : p <= 0.1 ? 'Hunter' : p <= 0.25 ? 'Survivor' : p <= 0.5 ? 'Runner' : 'Still Breathing';
}
