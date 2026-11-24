// Who is about. Coarse on purpose: a player is "online" (a game or the site open in the last two minutes, or in a
// room) or "active today" (since midnight UTC), and nothing finer is ever shown to anyone else: an exact last-seen
// time says when someone sleeps, and in a game with stakes that is not ours to hand out.
//
// Kept in memory, and written to the account at most every few minutes so "today" survives a restart. Guests
// (no account) count toward the home page's online number by a random id their browser keeps, and nothing else.
import type { Store } from './store.ts';

/** Seen this recently (a heartbeat comes once a minute while a page is open): online. */
export const ONLINE_MS = 2 * 60_000;
/** How often an account's last-seen is written down at most. */
const SAVE_EVERY_MS = 5 * 60_000;

export type Seen = 'online' | 'today';

const midnight = (t: number) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

export class Presence {
  private seen = new Map<string, number>(); // account -> when, this run of the server
  private saved = new Map<string, number>(); // account -> when it was last written down
  private sockets = new Map<string, number>(); // account -> open game connections
  private guests = new Map<string, number>(); // a guest's browser id -> when

  constructor(private store: Store, private now: () => number = Date.now) {}

  /** The account did something (an API call, a heartbeat, a frame in a room). */
  touch(accountId: string): void {
    const t = this.now();
    this.seen.set(accountId, t);
    if (t - (this.saved.get(accountId) ?? 0) >= SAVE_EVERY_MS) {
      this.saved.set(accountId, t);
      void this.store.touchSeen(accountId, new Date(t)).catch(() => { /* a nicety: never in the way */ });
    }
  }

  /** A guest's heartbeat (a random id from their browser, nothing more). */
  guest(id: string): void {
    const t = this.now();
    this.guests.set(id, t);
    if (this.guests.size > 20_000) for (const [k, v] of this.guests) if (t - v > ONLINE_MS) this.guests.delete(k);
  }

  /** A game connection opened or closed for the account (in a room, or waiting for one, they are online). */
  open(accountId: string): void { this.sockets.set(accountId, (this.sockets.get(accountId) ?? 0) + 1); this.touch(accountId); }
  close(accountId: string): void {
    const n = (this.sockets.get(accountId) ?? 1) - 1;
    if (n > 0) this.sockets.set(accountId, n); else this.sockets.delete(accountId);
    this.touch(accountId);
  }

  private onlineNow(accountId: string, t: number): boolean {
    return (this.sockets.get(accountId) ?? 0) > 0 || t - (this.seen.get(accountId) ?? 0) < ONLINE_MS;
  }

  /** How each of these accounts stands: online, active today, or not said (left out). */
  async of(ids: string[]): Promise<Map<string, Seen>> {
    const t = this.now(), today = midnight(t), out = new Map<string, Seen>();
    const ask: string[] = [];
    for (const id of ids) {
      if (this.onlineNow(id, t)) out.set(id, 'online');
      else if ((this.seen.get(id) ?? 0) >= today) out.set(id, 'today');
      else ask.push(id);
    }
    if (ask.length) {
      try {
        for (const id of await this.store.seenSince(ask, new Date(today))) out.set(id, 'today');
      } catch { /* a nicety */ }
    }
    return out;
  }

  /** For the home page: signed-in players and guests with a page open now. */
  online(): number {
    const t = this.now();
    let n = 0;
    for (const id of new Set([...this.seen.keys(), ...this.sockets.keys()])) if (this.onlineNow(id, t)) n++;
    for (const v of this.guests.values()) if (t - v < ONLINE_MS) n++;
    return n;
  }
}
