// ZP rooms: players stake ZP (the game currency, never paid out) instead of crypto. The server holds the stakes in the
// same ledger as the armoury, so a stake, its refund and its pay-out are each one idempotent ledger row:
//   zpstake  -stake  ref = the seat's stake ref (room uid + a nonce: leaving and sitting again is a new stake)
//   zprefund +stake  same ref (left before the start, the room was closed, or nobody got out)
//   zpwin    +share  ref = room uid (once per account per room)
//   zpdone   0       same ref as the stake: this stake is settled (won or lost)
// A stake with neither a refund nor a done row was cut short (a restart mid-round): recover() hands it back.
import type { Store } from './store.ts';

/** The stakes on offer, in ZP. */
export const ZP_STAKES = [50, 100, 250, 500, 1000] as const;
export type ZpStake = (typeof ZP_STAKES)[number];
export const isZpStake = (n: unknown): n is ZpStake => (ZP_STAKES as readonly unknown[]).includes(n);
/** The house keeps this share of every pot that is won (it takes ZP out of the game, which keeps ZP worth having). */
export const ZP_FEE = 0.05;

export interface ZpSeat { accountId: string; ref: string; escaped: boolean }

/** Who gets what from a finished ZP room. Nobody out: every stake back, no fee. */
export function zpPayout(stake: number, seats: ZpSeat[]): { fee: number; share: number; winners: string[]; refund: boolean } {
  const winners = [...new Set(seats.filter((s) => s.escaped).map((s) => s.accountId))];
  if (!winners.length) return { fee: 0, share: 0, winners: [], refund: true };
  const pot = stake * seats.length;
  const share = Math.floor((pot * (1 - ZP_FEE)) / winners.length);
  return { fee: pot - share * winners.length, share, winners, refund: false };
}

export class ZpBank {
  constructor(private store: Store, private log: (m: string) => void = (m) => console.log(`[zp] ${m}`)) {}

  /** Take a stake. False: not enough ZP. */
  async stake(accountId: string, ref: string, amount: number): Promise<boolean> {
    return (await this.store.ledger(accountId, -amount, 'zpstake', ref)).ok;
  }
  async refund(accountId: string, ref: string, amount: number): Promise<void> {
    await this.store.ledger(accountId, amount, 'zprefund', ref);
  }
  /** Pay a finished room out: winners their share, every stake marked settled (or refunded when nobody got out). */
  async settle(uid: string, stake: number, seats: ZpSeat[]): Promise<void> {
    const p = zpPayout(stake, seats);
    if (p.refund) { for (const s of seats) await this.refund(s.accountId, s.ref, stake); return; }
    for (const w of p.winners) await this.store.ledger(w, p.share, 'zpwin', uid);
    for (const s of seats) await this.store.ledger(s.accountId, 0, 'zpdone', s.ref);
    this.log(`room ${uid}: ${p.winners.length} of ${seats.length} out, ${p.share} each, ${p.fee} to the house`);
  }
  /** After a restart: every stake that was never refunded nor settled goes back. */
  async recover(): Promise<number> {
    const open = await this.store.openZpStakes();
    for (const s of open) await this.refund(s.accountId, s.ref, s.amount);
    if (open.length) this.log(`refunded ${open.length} stake(s) cut short by a restart`);
    return open.length;
  }
}
