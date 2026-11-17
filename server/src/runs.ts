// A run is a claim ("I won night 7 with 41 seconds left"); the replay is the proof. The server believes the
// claim only if replaying the log through the same rules ends where the claim says.
import { gzipSync } from 'node:zlib';
import { replayChapters, type ChapterEnd, type NightLog, type RunStats } from '../../core/replay.ts';
import { scoreRun, type Scored } from './score.ts';
import { hashState } from '../../core/replay.ts';
import type { Husk, LossReason, WeaponKind } from '../../core/types.ts';
import type { ContentRegistry } from './content.ts';
import type { RunRecord, Store } from './store.ts';

export const MAX_GZ_BYTES = 400 * 1024;
export const MAX_CHAPTERS = 3;

/** What a client says happened (the same shape the game saves: see src/seams/progress.ts). */
export interface Claim {
  seed: number;
  chapter: number;
  outcome: 'won' | 'lost';
  lossReason: LossReason | null;
  secondsLeft: number;
  replay: NightLog;
}

export type Verdict =
  | { replayOk: true; hash: string; kills: number; ends: ChapterEnd[]; stats: RunStats; scored: Scored }
  | { replayOk: false; reason: string; hash: string; kills: number };

/** Why a log is refused before any of it is replayed, or null. */
export function refuseBeforeReplay(c: Claim, content: ContentRegistry): string | null {
  const log = c.replay;
  if (!log || log.v !== 1 || !Array.isArray(log.chapters)) return 'not a night log';
  if (log.chapters.length < 1 || log.chapters.length > MAX_CHAPTERS) return 'wrong number of chapters';
  if (log.night !== c.seed) return 'the log is for a different night';
  if (!content.has(log.content)) return `unknown content version ${log.content}`;
  if (c.chapter !== log.chapters.length - 1) return 'the claimed chapter is not the last one in the log';
  return null;
}

/**
 * Replay a claim. `selves` is what the SERVER knows of this account's last selves, by chapter: whatever the
 * client put in its log is thrown away, or a made-up last self could drop a weapon it never had.
 */
export function check(c: Claim, content: ContentRegistry, selves: Map<number, Husk>): Verdict {
  const log: NightLog = { ...c.replay, chapters: c.replay.chapters.map((ch, i) => ({ ...ch, husk: selves.get(i) ?? null })) };
  let out;
  try {
    out = content.with(log.content, () => replayChapters(log));
  } catch (e) {
    return { replayOk: false, reason: e instanceof Error ? e.message : 'replay failed', hash: '', kills: 0 };
  }
  const { final, ends, stats } = out;
  const hash = hashState(final);
  const won = final.phase === 'won';
  const same = (c.outcome === 'won') === won
    && (won || (final.phase === 'lost' && c.lossReason === final.lossReason))
    && c.chapter === final.chapter
    && Math.abs(c.secondsLeft - final.remaining) < 1e-6;
  if (!same) return { replayOk: false, reason: 'the log does not end the way the claim says', hash, kills: final.kills };
  return { replayOk: true, hash, kills: final.kills, ends, stats, scored: scoreRun(stats, won, final.remaining) };
}

/** Check a claim, keep it, and update the account's last selves from what the replay showed. */
export async function submit(store: Store, content: ContentRegistry, accountId: string, c: Claim): Promise<{ replayOk: boolean; reason?: string; hash: string; score?: number; parts?: Record<string, number> }> {
  const early = refuseBeforeReplay(c, content);
  if (early) return { replayOk: false, reason: early, hash: '' };
  const selves = new Map<number, Husk>();
  for (let ch = 0; ch < c.replay.chapters.length; ch++) {
    const s = await store.lastSelf(accountId, ch);
    if (s) selves.set(ch, { pos: { x: s.x, y: s.y }, weapon: (s.weapon as WeaponKind | null) });
  }
  const v = check(c, content, selves);
  const gz = gzipSync(JSON.stringify(c.replay));
  if (gz.length > MAX_GZ_BYTES) return { replayOk: false, reason: 'log too large', hash: v.hash };
  const rec: Omit<RunRecord, 'id' | 'createdAt'> = {
    accountId, night: c.seed, content: c.replay.content, chapter: c.chapter, outcome: c.outcome, lossReason: c.lossReason,
    secondsLeft: c.secondsLeft, kills: v.kills, hash: v.hash, replayOk: v.replayOk, log: gz,
    score: v.replayOk ? v.scored.score : 0, stats: v.replayOk ? v.stats : null,
  };
  await store.addRun(rec);
  if (!v.replayOk) return { replayOk: false, reason: v.reason, hash: v.hash };
  // your last self: left where a chapter took you (caught, or the dose ran out); gone once you put it down
  for (const e of v.ends) {
    if (e.huskDown) await store.setLastSelf(accountId, null, e.chapter);
    if (e.phase === 'lost' && (e.lossReason === 'caught' || e.lossReason === 'time')) await store.setLastSelf(accountId, { chapter: e.chapter, x: e.pos.x, y: e.pos.y, weapon: e.weapon }, e.chapter);
  }
  return { replayOk: true, hash: v.hash, score: v.scored.score, parts: v.scored.parts };
}
