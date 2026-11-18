// What the site's pages share: escaping, icons, the server's boards and account, sign-in.
import { account, apiBase, type Account } from '../net/account';
import type { Loadout, Owned } from '../../../core/armoury';

export { account, apiBase, type Account };

/** Text made safe to put in markup. */
export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const fmt = (n: number): string => n.toLocaleString();
export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shown = (a: Account): string => a.name || short(a.address);
export const ago = (d: string | number): string => {
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON = {
  home: svg('<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>'),
  play: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>'),
  trophy: svg('<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 20h8M9 17h6"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  book: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7M8 11h5"/>'),
  shield: svg('<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 4 6"/>'),
  door: svg('<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M3 21h18M14 12h.01"/>'),
  key: svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M14 9l2 2"/>'),
  dice: svg('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h.01M15 15h.01M15 9h.01M9 15h.01M12 12h.01"/>'),
  coin: svg('<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>'),
  shieldGun: svg('<path d="M4 7h11l2 2h3v3h-3l-1 1h-3l-1 5H8l1-5H4z"/><path d="M8 10h4"/>'),
  bio: svg('<circle cx="12" cy="12" r="2"/><path d="M12 10a5 5 0 1 1 4-8M12 10a5 5 0 1 0-4-8M14 13a5 5 0 1 1 1 8.5M10 13a5 5 0 1 0-1 8.5"/>'),
  edit: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
  chev: '<span class="chev" aria-hidden="true">&rsaquo;</span>',
};

export type Kind = 'night' | 'week' | 'streak' | 'rooms';
export interface Row { rank: number; name: string; value: number; title: string; detail: Record<string, number | string> }
export interface Board {
  kind: Kind; unit: 'points' | 'nights' | 'escapes'; of: number; rows: Row[]; rules: string[];
  me: { rank: number; value: number; title: string; toNext: { gap: number; name: string } | null; detail: Record<string, number | string> } | null;
}
export const BOARD_NAMES: Record<Kind, string> = { night: 'Today', week: 'This week', streak: 'Streak', rooms: 'Rooms' };
export const unitOf = (b: Pick<Board, 'unit'>, n: number): string => (b.unit === 'points' ? 'pts' : b.unit === 'nights' ? (n === 1 ? 'night' : 'nights') : n === 1 ? 'escape' : 'escapes');
/** One line of what a run or a record was made of. */
export function detail(kind: Kind, d: Record<string, number | string>): string {
  if (kind === 'night') {
    const out = d.outcome === 'won' ? `got out with ${d.secondsLeft}s left` : `reached district ${d.reached}`;
    return [out, `${d.kills} kills`, `${d.bites} ${d.bites === 1 ? 'bite' : 'bites'}`, d.accuracy ? `${d.accuracy}% hits` : '', d.rescues ? `${d.rescues} helped` : ''].filter(Boolean).join(' · ');
  }
  if (kind === 'week') return `${d.nights} ${d.nights === 1 ? 'night' : 'nights'} · best ${fmt(Number(d.best))}`;
  if (kind === 'streak') return `${fmt(Number(d.total))} pts across the streak`;
  return `${d.rounds} rounds · out ${d.rate}% of the time · ${d.kills} kills`;
}

const auth = (): Record<string, string> => { const me = account(); return me ? { authorization: `Bearer ${me.token}` } : {}; };
/** GET from the server; null if it is not there or says no. */
export async function api<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${apiBase()}${path}`, { headers: auth(), signal: AbortSignal.timeout(8000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}
const boards = new Map<string, { at: number; b: Promise<Board | null> }>();
/** A board, kept for a minute (pages ask for the same ones). */
export function board(kind: Kind): Promise<Board | null> {
  const key = `${kind}:${account()?.address ?? ''}`, hit = boards.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.b;
  const b = api<Board>(`/leaderboard?board=${kind}`);
  boards.set(key, { at: Date.now(), b });
  return b;
}
export const forgetBoards = (): void => boards.clear();

export interface Me {
  account: { id: string; address: string; name: string | null; createdAt: string };
  okRuns: number;
  runs: Array<{ night: number; chapter: number; outcome: string; lossReason: string | null; secondsLeft: number; kills: number; replayOk: boolean; score: number; createdAt: string }>;
}

/** Set the name others see; the copy kept on this device follows. */
export async function setName(name: string): Promise<string | null> {
  const r = await fetch(`${apiBase()}/me`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ name }) }).catch(() => null);
  if (!r?.ok) return r?.status === 409 ? 'That name is taken. Try another.' : r?.status === 400 ? 'Letters, numbers, spaces and _ . \' - only, up to 20.' : 'The server did not take it. Try again.';
  const set = ((await r.json().catch(() => ({}))) as { name?: string }).name ?? name;
  try { const a = account(); if (a) localStorage.setItem('zp.account', JSON.stringify({ ...a, name: set })); } catch { /* the server has it */ }
  forgetBoards();
  return null;
}

/** Sign in (wallet, Google or passkey, whichever this browser can), then `done`. */
export function signInThen(done: () => void): void {
  void import('../net/gate').then((m) => m.showGate(() => { forgetBoards(); done(); }, {
    title: 'Sign in',
    text: 'Your nights count on the leaderboard, your last self waits for you where you fell, and multiplayer opens.',
    cancel: true,
  }));
}

/** Whether the server lets this account into the admin page (asked once a session per account). */
export async function isAdmin(): Promise<boolean> {
  const me = account();
  if (!me) return false;
  const key = `zp.admin.${me.address}`;
  try { const v = sessionStorage.getItem(key); if (v) return v === '1'; } catch { /* ask */ }
  let ok = false;
  try { ok = (await fetch(`${apiBase()}/admin/overview`, { headers: auth(), signal: AbortSignal.timeout(8000) })).ok; } catch { return false; }
  try { sessionStorage.setItem(key, ok ? '1' : '0'); } catch { /* ask again next time */ }
  return ok;
}

// ---------------------------------------------------------------- the armoury

export interface ArmouryView {
  cash: number; owned: Owned; loadouts: { ranked: Loadout; open: Loadout };
  loans: Array<{ id: string; item: string; fee: number; createdAt: string; dueAt: string; lender: string | null; lateFee: number; overdue: boolean }>;
  /** What this account put up for others to borrow. */
  listings: Array<{ id: string; item: string; rate: number; status: 'open' | 'lent'; dueAt: string | null; borrower: string | null }>;
  /** The cheapest offer from another player, by item. */
  offers: Record<string, { listing: string; rate: number; lender: string }>;
  /** The server's clock (due times are counted from it). */
  now: string;
  earnedToday: number; dailyCap: number; tonight: number;
  /** Buying cash with a stablecoin, when the server has it on. */
  topup: { token: string; treasury: string; decimals: number; rate: number; symbol: string; chainId: number; min: string } | null;
  credited?: number;
}
/** Item names, for saying what a night carries (kept small: the catalogue, core/armoury.ts, is not on the first page; a test keeps them equal). */
export const ITEM_NAMES: Record<string, string> = {
  pistol: 'Pistol', baton: 'Police baton', bat: 'Baseball bat', machete: 'Machete', shotgun: 'Shotgun', rifle: 'Assault rifle',
  helmet: 'Riot helmet', vest: 'Kevlar vest', ammo: 'Ammo belt', bottles: 'Bottle bag', cash: 'Emergency cash',
};
/** An item's picture: drawn for gear and supplies, the game's own mesh for weapons. */
export const itemArt = (id: string): string => `/armoury/${['vest', 'helmet', 'ammo', 'bottles', 'cash'].includes(id) ? `${id}.svg` : `${id}.webp`}`;
/** Keep the loadouts on this device, where the game reads them when a night starts. */
function keepLoadouts(v: ArmouryView): void {
  try {
    const a = account();
    // the names of what each loadout carries go too, so the game can say what you brought without the catalogue
    const names = (l: Loadout) => ['pistol', 'baton', ...l.kit].map((k) => ITEM_NAMES[k] ?? k);
    if (a) localStorage.setItem('zp.armoury', JSON.stringify({ address: a.address, loadouts: v.loadouts, carry: { ranked: names(v.loadouts.ranked), open: names(v.loadouts.open) }, loans: v.loans.map((x) => ({ item: x.item, dueAt: x.dueAt })) }));
  } catch { /* the game starts with the standard kit */ }
}
/** The account's armoury (and the device's copy of its loadouts brought up to date). */
export async function armoury(): Promise<ArmouryView | null> {
  if (!account()) return null;
  const v = await api<ArmouryView>('/armoury');
  if (v) keepLoadouts(v);
  return v;
}
/** Buy, borrow or save loadouts: the armoury as it is after, or why not. */
export async function armouryPost(path: 'buy' | 'borrow' | 'return' | 'lend' | 'unlist' | 'loadout' | 'topup', body: unknown): Promise<{ view?: ArmouryView; error?: string }> {
  try {
    const r = await fetch(`${apiBase()}/armoury/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const j = await r.json() as ArmouryView & { error?: string };
    if (!r.ok) return { error: j.error ?? 'The server said no.' };
    keepLoadouts(j);
    return { view: j };
  } catch { return { error: 'The server is not answering. Try again.' }; }
}
