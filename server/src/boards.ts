// The leaderboards. Each is built from what the server replayed or ran itself, never from a client's word:
//   night   tonight's city (everyone plays the same one), best score per player
//   week    the last seven nights, each player's best score per night added up: coming back beats one lucky run
//   streak  nights in a row survived (a won night), up to tonight; ties go to the higher total over the streak
//   rooms   the last 30 days of rooms: escapes, then escape rate, then kills (three rounds to be listed)
//   all     every player's best score ever (the home page's numbers open this one)
// Each row says whether the player is online now or was about today (presence.ts), and nothing finer.
import { nightOf } from './content.ts';
import { SCORE, titleFor } from './score.ts';
import type { BestRun, RoomRow, Store } from './store.ts';

export type BoardKind = 'night' | 'week' | 'streak' | 'rooms' | 'all';
export const BOARD_KINDS: BoardKind[] = ['night', 'week', 'streak', 'rooms', 'all'];
/** Whether a player is about: online now, or active today (and nothing said otherwise). */
export type Seen = 'online' | 'today';
export const TOP = 50;
export const ROOMS_MIN_ROUNDS = 3;

export interface BoardRow { rank: number; accountId: string; name: string; value: number; title: string; detail: Record<string, number | string>; on?: Seen }
export interface Board {
  kind: BoardKind;
  /** What `value` is, for the page to label. */
  unit: 'points' | 'nights' | 'escapes';
  night: number;
  of: number;
  rows: Omit<BoardRow, 'accountId'>[];
  /** The asker's own place, and what it takes to climb one. */
  me: { rank: number; value: number; title: string; toNext: { gap: number; name: string } | null; detail: Record<string, number | string> } | null;
  rules: string[];
}

const DAY = 864e5;
const shown = (r: { name: string | null; address: string }) => r.name ?? `${r.address.slice(0, 6)}…${r.address.slice(-4)}`;
const nightsBack = (today: Date, n: number) => Array.from({ length: n }, (_, k) => nightOf(new Date(today.getTime() - k * DAY)));
const acc = (st: BestRun['stats']) => (st && st.shots > 0 ? Math.round((100 * st.hits) / st.shots) : 0);

type Ranked = { accountId: string; name: string; value: number; tie: number; detail: Record<string, number | string> };

function finish(kind: BoardKind, unit: Board['unit'], night: number, list: Ranked[], me: string | null, rules: string[]): Board {
  list.sort((a, b) => b.value - a.value || b.tie - a.tie || a.name.localeCompare(b.name));
  const ranked: BoardRow[] = [];
  list.forEach((r, i) => {
    // equal value and tie-break share a rank
    const prev = ranked[i - 1];
    const rank = prev && prev.value === r.value && list[i - 1]!.tie === r.tie ? prev.rank : i + 1;
    ranked.push({ rank, accountId: r.accountId, name: r.name, value: r.value, title: titleFor(rank, list.length), detail: r.detail });
  });
  let mine: Board['me'] = null;
  const i = me ? ranked.findIndex((r) => r.accountId === me) : -1;
  if (i >= 0) {
    const r = ranked[i]!;
    const above = ranked.slice(0, i).reverse().find((x) => x.rank < r.rank);
    mine = { rank: r.rank, value: r.value, title: r.title, detail: r.detail, toNext: above ? { gap: above.value - r.value + (above.value === r.value ? 0 : 1), name: above.name } : null };
  }
  return { kind, unit, night, of: ranked.length, rows: ranked.slice(0, TOP) as Board['rows'], me: mine, rules };
}

/** A board, each row marked online or active today when `seen` is given, and with no account ids in it. */
export async function buildBoard(store: Store, kind: BoardKind, today: Date, me: string | null, nightOverride?: number, seen?: (ids: string[]) => Promise<Map<string, Seen>>): Promise<Board> {
  const b = await rawBoard(store, kind, today, me, nightOverride);
  const rows = b.rows as BoardRow[];
  const on = seen ? await seen(rows.map((r) => r.accountId)) : new Map<string, Seen>();
  b.rows = rows.map(({ accountId, ...x }) => { const o = on.get(accountId); return o ? { ...x, on: o } : x; });
  return b;
}

async function rawBoard(store: Store, kind: BoardKind, today: Date, me: string | null, nightOverride?: number): Promise<Board> {
  const tonight = nightOverride ?? nightOf(today);
  if (kind === 'night') {
    const runs = await store.bestRuns([tonight]);
    return finish('night', 'points', tonight, runs.map((r) => ({
      accountId: r.accountId, name: shown(r), value: r.score, tie: -r.createdAt.getTime(),
      detail: { outcome: r.outcome, reached: r.chapter + 1, secondsLeft: Math.round(r.secondsLeft), kills: r.kills, bites: r.stats?.bites ?? 0, accuracy: acc(r.stats), rescues: r.stats?.rescues ?? 0 },
    })), me, [
      `Each district cleared ${SCORE.perChapter}. Getting out ${SCORE.win}, plus ${SCORE.perSecondLeft} for every second of infection you had left.`,
      `Kills ${SCORE.perKill} each (up to ${SCORE.killCap}), people helped ${SCORE.perRescue}, optional steps ${SCORE.perOptional}, a last self put down ${SCORE.perHusk}.`,
      `A steady hand: up to ${SCORE.accuracyMax} for accuracy once you have fired ${SCORE.accuracyMinShots} shots. A night out with no bites: ${SCORE.clean}.`,
      `Each bite ${SCORE.perBite}, each dose ${SCORE.perDose}, each person you brought in who turned ${SCORE.perLostEscort}.`,
      'Only your best run of the night counts, and only once the server has replayed it.',
    ]);
  }
  if (kind === 'all') {
    const runs = await store.bestEver();
    return finish('all', 'points', tonight, runs.map((r) => ({
      accountId: r.accountId, name: shown(r), value: r.score, tie: -r.createdAt.getTime(),
      detail: { outcome: r.outcome, reached: r.chapter + 1, kills: r.kills },
    })), me, ['Every player\'s best score ever, from any night: the run the server replayed, not a claim.']);
  }
  if (kind === 'week') {
    const runs = await store.bestRuns(nightsBack(today, 7));
    const by = new Map<string, Ranked & { nights: number; best: number }>();
    for (const r of runs) {
      const x = by.get(r.accountId) ?? { accountId: r.accountId, name: shown(r), value: 0, tie: 0, detail: {}, nights: 0, best: 0 };
      x.value += r.score; x.nights++; x.best = Math.max(x.best, r.score); x.tie = x.best;
      by.set(r.accountId, x);
    }
    return finish('week', 'points', tonight, [...by.values()].map((x) => ({ ...x, detail: { nights: x.nights, best: x.best } })), me, [
      'Your best score on each of the last seven nights, added up. Play every night to climb.',
    ]);
  }
  if (kind === 'streak') {
    const nights = nightsBack(today, 60);
    const runs = await store.bestRuns(nights);
    const won = new Map<string, Map<number, BestRun>>();
    for (const r of runs) if (r.outcome === 'won') { const m = won.get(r.accountId) ?? new Map(); m.set(r.night, r); won.set(r.accountId, m); }
    const list: Ranked[] = [];
    for (const [id, m] of won) {
      // tonight still to play does not break a streak: count from tonight if won, else from last night
      let k = m.has(nights[0]!) ? 0 : 1, n = 0, total = 0, any: BestRun | undefined;
      while (k < nights.length && m.has(nights[k]!)) { const r = m.get(nights[k]!)!; any = r; total += r.score; n++; k++; }
      if (n > 0) list.push({ accountId: id, name: shown(any!), value: n, tie: total, detail: { total } });
    }
    return finish('streak', 'nights', tonight, list, me, ["Nights in a row you got out of the city, one a day. Today's does not break it until the day is over."]);
  }
  const rows: RoomRow[] = (await store.roomTotals(30)).filter((r) => r.rounds >= ROOMS_MIN_ROUNDS);
  return finish('rooms', 'escapes', tonight, rows.map((r) => ({
    accountId: r.accountId, name: shown(r), value: r.escapes, tie: Math.round((1000 * r.escapes) / r.rounds) * 1e6 + r.kills,
    detail: { rounds: r.rounds, rate: Math.round((100 * r.escapes) / r.rounds), kills: r.kills },
  })), me, [`Rooms in the last 30 days, signed in: escapes first, then how often you got out, then kills. ${ROOMS_MIN_ROUNDS} rounds to be listed.`]);
}
