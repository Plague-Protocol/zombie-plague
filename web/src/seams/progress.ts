// Seam for progress saving. The slice keeps nothing; a real store (backend, per account) plugs in here.
import type { LossReason } from '../../../core/types';
import type { NightLog } from '../../../core/replay';
import type { AuthSession } from './session';

export interface RunResult {
  seed: number; // the night
  chapter: number; // reached (0-based)
  outcome: 'won' | 'lost';
  lossReason: LossReason | null;
  secondsLeft: number;
  timeLimit: number;
  optionalDone: number;
  /** The whole night, step by step: a store that pays out re-runs it (core/replay.ts) before believing the rest. */
  replay: NightLog;
}

export interface ProgressStore {
  saveRun(session: AuthSession, result: RunResult): Promise<void>;
}

export const noopProgress: ProgressStore = {
  async saveRun() {
    /* nothing persisted in this slice */
  },
};
