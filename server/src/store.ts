// Where accounts, runs and last selves are kept. One interface, two implementations: memory (development,
// tests) and Postgres. Nothing else in the server knows which.
import pg from 'pg';
import type { RunStats } from '../../core/replay.ts';
import type { Loadout, Owned } from '../../core/armoury.ts';

export interface Account {
  id: string;
  address: string; // lower-case 0x
  name: string | null;
  createdAt: Date;
}

export interface RunRecord {
  id: string;
  accountId: string;
  night: number;
  content: number;
  chapter: number;
  outcome: 'won' | 'lost';
  lossReason: string | null;
  secondsLeft: number;
  kills: number;
  hash: string;
  replayOk: boolean;
  /** The server's score for it (0 if the replay failed), and what the replay counted. */
  score: number;
  stats: RunStats | null;
  log: Buffer; // gzip of the NightLog JSON
  createdAt: Date;
}

/** An account's best replayed run on one night. */
export interface BestRun { accountId: string; name: string | null; address: string; night: number; score: number; outcome: 'won' | 'lost'; chapter: number; secondsLeft: number; kills: number; stats: RunStats | null; createdAt: Date }

/** One signed-in seat's part in a finished room round. */
export interface RoundSeat { accountId: string; code: string; status: string; kills: number; escaped: boolean }
export interface RoomRow { accountId: string; name: string | null; address: string; rounds: number; escapes: number; kills: number }

export interface LastSelfRecord { chapter: number; x: number; y: number; weapon: string | null }

/** The two loadouts a player keeps: one inside the ranked budget, one without a limit (practice). */
export interface Loadouts { ranked: Loadout; open: Loadout }
/** What an account has between nights: banked cash (below zero is a debt from a loan), what it owns, its loadouts. */
export interface Bank { cash: number; owned: Owned; loadouts: Loadouts | null }
/** An item borrowed for a term (its fee paid when borrowed): active until it is returned, or goes back by itself after
 * the late days. From the armoury, or from another player's listing (`lenderId`, `listingId`). */
export interface Loan { id: string; item: string; fee: number; status: 'active' | 'used' | 'returned' | 'expired'; createdAt: Date; dueAt: Date; lenderId: string | null; listingId: string | null }
export interface NewLoan { id: string; accountId: string; item: string; fee: number; dueAt: Date; lenderId?: string; listingId?: string }
/** An owned item a player put up for others to borrow: off their loadouts while it is listed. */
export interface Listing { id: string; ownerId: string; item: string; rate: number; status: 'open' | 'lent' | 'withdrawn'; loanId: string | null; createdAt: Date }
/** Ledger reasons that count as earning (toward the daily cap). */
export const EARN_REASONS = ['run', 'round'] as const;


/** What the server owes the chain for a staked round that has ended: written before the transaction is sent, so a restart resumes instead of repeating. */
export interface Settlement {
  roomId: string;
  winners: string[];
  logHash: string; // 0x + 64 hex: sha256 of the stored log
  status: 'pending' | 'sent' | 'done' | 'failed';
  tx: string | null;
  error: string | null;
}

export interface Store {
  /** Idempotent on roomId: a second call for the same room changes nothing and returns false. */
  addSettlement(s: Settlement): Promise<boolean>;
  updateSettlement(roomId: string, patch: Partial<Pick<Settlement, 'status' | 'tx' | 'error'>>): Promise<void>;
  settlementsOpen(): Promise<Settlement[]>;
  settlement(roomId: string): Promise<Settlement | null>;
  upsertAccount(address: string): Promise<Account>;
  accountById(id: string): Promise<Account | null>;
  /** Set the name others see. False: someone else already has it (names are unique, ignoring case). */
  setName(id: string, name: string): Promise<boolean>;
  addRun(r: Omit<RunRecord, 'id' | 'createdAt'>): Promise<RunRecord>;
  recentRuns(accountId: string, limit: number): Promise<Omit<RunRecord, 'log'>[]>;
  /** How many replay-checked free runs this account has, and when its first was. */
  runStats(accountId: string): Promise<{ okRuns: number; failedSince: (days: number) => Promise<number> }>;
  /** For each account, its best-scoring replayed run on each of these nights. */
  bestRuns(nights: number[]): Promise<BestRun[]>;
  addRoundSeats(rows: RoundSeat[]): Promise<void>;
  /** For the admin page. */
  adminCounts(): Promise<{ accounts: number; runs: number; runs24h: number; failed24h: number; accounts24h: number; rounds24h: number }>;
  /** Accounts with replays that failed in the last `days`: the first place to look for cheating. */
  failedAccounts(days: number, limit: number): Promise<Array<{ accountId: string; address: string; name: string | null; failed: number; ok: number }>>;
  settlementsAll(limit: number): Promise<Settlement[]>;
  /** Rooms played by signed-in accounts since `days` ago, summed per account. */
  roomTotals(days: number): Promise<RoomRow[]>;
  lastSelf(accountId: string, chapter: number): Promise<LastSelfRecord | null>;
  setLastSelf(accountId: string, rec: LastSelfRecord | null, chapter: number): Promise<void>;
  bank(accountId: string): Promise<Bank>;
  /**
   * Move cash in or out, written in the ledger. Idempotent on (account, reason, ref): the same ref twice changes
   * nothing and returns ok false. Unless `allowDebt`, a debit that would take the balance below zero is refused.
   */
  ledger(accountId: string, delta: number, reason: string, ref: string, allowDebt?: boolean): Promise<{ ok: boolean; cash: number }>;
  /** Pay `price` and own `item` at `level`, as one step: refused (false) if the balance is short. */
  purchase(accountId: string, item: string, level: number, price: number, ref: string): Promise<boolean>;
  /** What an account earned (run and round pay) since a moment. */
  earnedSince(accountId: string, since: Date): Promise<number>;
  setLoadouts(accountId: string, l: Loadouts): Promise<void>;
  /** Loans the account holds now (active, overdue ones included until they go back). */
  loansActive(accountId: string): Promise<Loan[]>;
  loanById(id: string): Promise<(Loan & { accountId: string }) | null>;
  addLoan(l: NewLoan): Promise<Loan>;
  /** Close an active loan; false if it was not active (already returned). */
  closeLoan(id: string, status: 'used' | 'returned' | 'expired'): Promise<boolean>;
  /** An owner's listings that are not withdrawn. */
  listingsOf(ownerId: string): Promise<Listing[]>;
  /** Every open listing, with who is lending. */
  openListings(): Promise<Array<Listing & { ownerName: string | null; ownerAddress: string }>>;
  addListing(ownerId: string, item: string, rate: number): Promise<Listing>;
  listingById(id: string): Promise<Listing | null>;
  /** Mark an open listing lent to a loan; false if it is not open any more (someone took it first, or it was withdrawn). */
  takeListing(id: string, loanId: string): Promise<boolean>;
  /** A lent listing back on the rack (its loan ended). */
  reopenListing(id: string): Promise<void>;
  /** Withdraw an open listing; false if it is lent out. */
  withdrawListing(id: string): Promise<boolean>;
  close(): Promise<void>;
}

const newId = () => globalThis.crypto.randomUUID();

export class MemoryStore implements Store {
  private accounts = new Map<string, Account>();
  private runs: RunRecord[] = [];
  private selves = new Map<string, LastSelfRecord>();
  private settlements = new Map<string, Settlement>();
  private seats: Array<RoundSeat & { at: Date }> = [];
  now = () => new Date();

  async upsertAccount(address: string): Promise<Account> {
    const a = address.toLowerCase();
    let acc = [...this.accounts.values()].find((x) => x.address === a);
    if (!acc) { acc = { id: newId(), address: a, name: null, createdAt: this.now() }; this.accounts.set(acc.id, acc); }
    return acc;
  }
  async accountById(id: string) { return this.accounts.get(id) ?? null; }
  async addSettlement(s: Settlement) { if (this.settlements.has(s.roomId)) return false; this.settlements.set(s.roomId, { ...s }); return true; }
  async updateSettlement(roomId: string, patch: Partial<Pick<Settlement, 'status' | 'tx' | 'error'>>) { const x = this.settlements.get(roomId); if (x) Object.assign(x, patch); }
  async settlementsOpen() { return [...this.settlements.values()].filter((x) => x.status === 'pending' || x.status === 'sent').map((x) => ({ ...x })); }
  async settlement(roomId: string) { const x = this.settlements.get(roomId); return x ? { ...x } : null; }
  async setName(id: string, name: string) {
    const k = name.toLowerCase();
    if ([...this.accounts.values()].some((x) => x.id !== id && x.name?.toLowerCase() === k)) return false;
    const a = this.accounts.get(id); if (a) a.name = name;
    return true;
  }
  async addRun(r: Omit<RunRecord, 'id' | 'createdAt'>) { const rec = { ...r, id: newId(), createdAt: this.now() }; this.runs.push(rec); return rec; }
  async recentRuns(accountId: string, limit: number) {
    return this.runs.filter((r) => r.accountId === accountId).slice(-limit).reverse().map(({ log: _log, ...rest }) => { void _log; return rest; });
  }
  async runStats(accountId: string) {
    const mine = this.runs.filter((r) => r.accountId === accountId);
    return {
      okRuns: mine.filter((r) => r.replayOk).length,
      failedSince: async (days: number) => mine.filter((r) => !r.replayOk && this.now().getTime() - r.createdAt.getTime() < days * 864e5).length,
    };
  }
  async bestRuns(nights: number[]): Promise<BestRun[]> {
    const want = new Set(nights), best = new Map<string, RunRecord>();
    for (const r of this.runs) {
      if (!want.has(r.night) || !r.replayOk) continue;
      const k = `${r.accountId}:${r.night}`, b = best.get(k);
      if (!b || r.score > b.score) best.set(k, r);
    }
    return [...best.values()].map((r) => { const a = this.accounts.get(r.accountId)!; return { accountId: r.accountId, name: a.name, address: a.address, night: r.night, score: r.score, outcome: r.outcome, chapter: r.chapter, secondsLeft: r.secondsLeft, kills: r.kills, stats: r.stats, createdAt: r.createdAt }; });
  }
  async adminCounts() {
    const day = this.now().getTime() - 864e5;
    return {
      accounts: this.accounts.size, runs: this.runs.length,
      runs24h: this.runs.filter((r) => r.createdAt.getTime() > day).length,
      failed24h: this.runs.filter((r) => !r.replayOk && r.createdAt.getTime() > day).length,
      accounts24h: [...this.accounts.values()].filter((a) => a.createdAt.getTime() > day).length,
      rounds24h: new Set(this.seats.filter((x) => x.at.getTime() > day).map((x) => x.code)).size,
    };
  }
  async failedAccounts(days: number, limit: number) {
    const since = this.now().getTime() - days * 864e5, by = new Map<string, { failed: number; ok: number }>();
    for (const r of this.runs) { if (r.createdAt.getTime() < since) continue; const x = by.get(r.accountId) ?? { failed: 0, ok: 0 }; if (r.replayOk) x.ok++; else x.failed++; by.set(r.accountId, x); }
    return [...by].filter(([, x]) => x.failed > 0).sort((a, b) => b[1].failed - a[1].failed).slice(0, limit)
      .map(([id, x]) => { const a = this.accounts.get(id)!; return { accountId: id, address: a.address, name: a.name, ...x }; });
  }
  async settlementsAll(limit: number) { return [...this.settlements.values()].slice(-limit).reverse().map((x) => ({ ...x })); }
  async addRoundSeats(rows: RoundSeat[]) { for (const r of rows) this.seats.push({ ...r, at: this.now() }); }
  async roomTotals(days: number): Promise<RoomRow[]> {
    const since = this.now().getTime() - days * 864e5, by = new Map<string, RoomRow>();
    for (const x of this.seats) {
      if (x.at.getTime() < since) continue;
      const a = this.accounts.get(x.accountId);
      if (!a) continue;
      const row = by.get(x.accountId) ?? { accountId: x.accountId, name: a.name, address: a.address, rounds: 0, escapes: 0, kills: 0 };
      row.rounds++; if (x.escaped) row.escapes++; row.kills += x.kills;
      by.set(x.accountId, row);
    }
    return [...by.values()];
  }
  async lastSelf(accountId: string, chapter: number) { return this.selves.get(`${accountId}:${chapter}`) ?? null; }
  async setLastSelf(accountId: string, rec: LastSelfRecord | null, chapter: number) {
    if (rec) this.selves.set(`${accountId}:${chapter}`, rec); else this.selves.delete(`${accountId}:${chapter}`);
  }
  private banks = new Map<string, { cash: number; owned: Map<string, number>; loadouts: Loadouts | null }>();
  private ledgerRows: Array<{ accountId: string; delta: number; reason: string; ref: string; at: Date }> = [];
  private loanRows: Array<Loan & { accountId: string }> = [];
  private bk(id: string) { let b = this.banks.get(id); if (!b) { b = { cash: 0, owned: new Map(), loadouts: null }; this.banks.set(id, b); } return b; }
  async bank(accountId: string): Promise<Bank> {
    const b = this.bk(accountId);
    return { cash: b.cash, owned: ownedFrom([...b.owned]), loadouts: b.loadouts ? structuredClone(b.loadouts) : null };
  }
  async ledger(accountId: string, delta: number, reason: string, ref: string, allowDebt = false) {
    const b = this.bk(accountId);
    if (this.ledgerRows.some((x) => x.accountId === accountId && x.reason === reason && x.ref === ref)) return { ok: false, cash: b.cash };
    if (delta < 0 && !allowDebt && b.cash + delta < 0) return { ok: false, cash: b.cash };
    b.cash += delta;
    this.ledgerRows.push({ accountId, delta, reason, ref, at: this.now() });
    return { ok: true, cash: b.cash };
  }
  async purchase(accountId: string, item: string, level: number, price: number, ref: string) {
    const r = await this.ledger(accountId, -price, 'buy', ref);
    if (r.ok) this.bk(accountId).owned.set(item, Math.max(level, this.bk(accountId).owned.get(item) ?? 0));
    return r.ok;
  }
  async earnedSince(accountId: string, since: Date) {
    return this.ledgerRows.filter((x) => x.accountId === accountId && (EARN_REASONS as readonly string[]).includes(x.reason) && x.at >= since).reduce((a, x) => a + x.delta, 0);
  }
  async setLoadouts(accountId: string, l: Loadouts) { this.bk(accountId).loadouts = structuredClone(l); }
  private listingRows: Listing[] = [];
  private pub = (x: Loan & { accountId: string }): Loan => { const { accountId: _a, ...l } = x; void _a; return { ...l }; };
  async loansActive(accountId: string) { return this.loanRows.filter((x) => x.accountId === accountId && x.status === 'active').map(this.pub); }
  async loanById(id: string) { const l = this.loanRows.find((x) => x.id === id); return l ? { ...l } : null; }
  async addLoan(n: NewLoan) {
    const l = { id: n.id, accountId: n.accountId, item: n.item, fee: n.fee, status: 'active' as const, createdAt: this.now(), dueAt: n.dueAt, lenderId: n.lenderId ?? null, listingId: n.listingId ?? null };
    this.loanRows.push(l);
    return this.pub(l);
  }
  async closeLoan(id: string, status: 'used' | 'returned' | 'expired') { const l = this.loanRows.find((x) => x.id === id && x.status === 'active'); if (l) l.status = status; return !!l; }
  async listingsOf(ownerId: string) { return this.listingRows.filter((x) => x.ownerId === ownerId && x.status !== 'withdrawn').map((x) => ({ ...x })); }
  async openListings() {
    return this.listingRows.filter((x) => x.status === 'open').map((x) => { const a = this.accounts.get(x.ownerId); return { ...x, ownerName: a?.name ?? null, ownerAddress: a?.address ?? '' }; });
  }
  async addListing(ownerId: string, item: string, rate: number) { const l: Listing = { id: newId(), ownerId, item, rate, status: 'open', loanId: null, createdAt: this.now() }; this.listingRows.push(l); return { ...l }; }
  async listingById(id: string) { const l = this.listingRows.find((x) => x.id === id); return l ? { ...l } : null; }
  async takeListing(id: string, loanId: string) { const l = this.listingRows.find((x) => x.id === id && x.status === 'open'); if (l) { l.status = 'lent'; l.loanId = loanId; } return !!l; }
  async reopenListing(id: string) { const l = this.listingRows.find((x) => x.id === id && x.status === 'lent'); if (l) { l.status = 'open'; l.loanId = null; } }
  async withdrawListing(id: string) { const l = this.listingRows.find((x) => x.id === id && x.status === 'open'); if (l) l.status = 'withdrawn'; return !!l; }
  async close() {}
}

/** Owned items from (item, level) rows: kit ids at level 1, upgrades ("rifle.damage") at their level. */
export function ownedFrom(rows: Array<[string, number]>): Owned {
  const o: Owned = { kit: [], ups: {} };
  for (const [item, level] of rows) {
    if (item.includes('.')) (o.ups as Record<string, number>)[item] = level;
    else (o.kit as string[]).push(item);
  }
  return o;
}

/** The tables, created if they are not there. Plain SQL: there is no generate step to run. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS account (
  id         text PRIMARY KEY,
  address    text NOT NULL UNIQUE,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run (
  id          text PRIMARY KEY,
  account_id  text NOT NULL REFERENCES account(id),
  night       bigint NOT NULL,
  content     integer NOT NULL,
  chapter     integer NOT NULL,
  outcome     text NOT NULL,
  loss_reason text,
  seconds_left double precision NOT NULL,
  kills       integer NOT NULL,
  hash        text NOT NULL,
  replay_ok   boolean NOT NULL,
  log         bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_account_idx ON run (account_id, created_at);
CREATE INDEX IF NOT EXISTS run_night_idx ON run (night, outcome, seconds_left);
ALTER TABLE run ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0;
ALTER TABLE run ADD COLUMN IF NOT EXISTS stats text;
CREATE INDEX IF NOT EXISTS run_score_idx ON run (night, account_id, score DESC) WHERE replay_ok;
CREATE TABLE IF NOT EXISTS round_seat (
  id         bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES account(id),
  code       text NOT NULL,
  status     text NOT NULL,
  kills      integer NOT NULL,
  escaped    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS round_seat_idx ON round_seat (created_at, account_id);
CREATE TABLE IF NOT EXISTS settlement (
  room_id    text PRIMARY KEY,
  winners    text NOT NULL,
  log_hash   text NOT NULL,
  status     text NOT NULL,
  tx         text,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS last_self (
  account_id text NOT NULL REFERENCES account(id),
  chapter    integer NOT NULL,
  x          double precision NOT NULL,
  y          double precision NOT NULL,
  weapon     text,
  PRIMARY KEY (account_id, chapter)
);
ALTER TABLE account ADD COLUMN IF NOT EXISTS cash bigint NOT NULL DEFAULT 0;
ALTER TABLE account ADD COLUMN IF NOT EXISTS loadouts text;
CREATE INDEX IF NOT EXISTS account_name_idx ON account (lower(name));
CREATE TABLE IF NOT EXISTS owned (
  account_id text NOT NULL REFERENCES account(id),
  item       text NOT NULL,
  level      integer NOT NULL,
  PRIMARY KEY (account_id, item)
);
CREATE TABLE IF NOT EXISTS ledger (
  id         bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES account(id),
  delta      bigint NOT NULL,
  reason     text NOT NULL,
  ref        text NOT NULL,
  cash_after bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, reason, ref)
);
CREATE INDEX IF NOT EXISTS ledger_earn_idx ON ledger (account_id, created_at);
CREATE TABLE IF NOT EXISTS loan (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES account(id),
  item       text NOT NULL,
  fee        integer NOT NULL,
  status     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loan_account_idx ON loan (account_id, status);
ALTER TABLE loan ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE loan ADD COLUMN IF NOT EXISTS lender_id text;
ALTER TABLE loan ADD COLUMN IF NOT EXISTS listing_id text;
UPDATE loan SET due_at = created_at + interval '1 day' WHERE due_at IS NULL;
CREATE TABLE IF NOT EXISTS listing (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL REFERENCES account(id),
  item       text NOT NULL,
  rate       integer NOT NULL,
  status     text NOT NULL,
  loan_id    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_owner_idx ON listing (owner_id, status);
CREATE INDEX IF NOT EXISTS listing_open_idx ON listing (item) WHERE status = 'open';
`;

export class PgStore implements Store {
  private pool: pg.Pool;
  private constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 8 }); }

  static async connect(url: string): Promise<PgStore> {
    const s = new PgStore(url);
    await s.pool.query(SCHEMA);
    return s;
  }

  async upsertAccount(address: string): Promise<Account> {
    const a = address.toLowerCase();
    const r = await this.pool.query('INSERT INTO account (id, address) VALUES ($1, $2) ON CONFLICT (address) DO UPDATE SET address = EXCLUDED.address RETURNING id, address, name, created_at', [newId(), a]);
    return this.acc(r.rows[0]);
  }
  private acc(r: { id: string; address: string; name: string | null; created_at: Date }): Account { return { id: r.id, address: r.address, name: r.name, createdAt: r.created_at }; }
  private sett(x: { room_id: string; winners: string; log_hash: string; status: Settlement['status']; tx: string | null; error: string | null }): Settlement {
    return { roomId: x.room_id, winners: JSON.parse(x.winners), logHash: x.log_hash, status: x.status, tx: x.tx, error: x.error };
  }
  async addSettlement(s: Settlement) {
    const r = await this.pool.query('INSERT INTO settlement (room_id, winners, log_hash, status) VALUES ($1,$2,$3,$4) ON CONFLICT (room_id) DO NOTHING', [s.roomId, JSON.stringify(s.winners), s.logHash, s.status]);
    return (r.rowCount ?? 0) > 0;
  }
  async updateSettlement(roomId: string, p: Partial<Pick<Settlement, 'status' | 'tx' | 'error'>>) {
    await this.pool.query('UPDATE settlement SET status = COALESCE($2, status), tx = COALESCE($3, tx), error = $4 WHERE room_id = $1', [roomId, p.status ?? null, p.tx ?? null, p.error ?? null]);
  }
  async settlementsOpen() { const r = await this.pool.query("SELECT * FROM settlement WHERE status IN ('pending','sent') ORDER BY created_at"); return r.rows.map((x) => this.sett(x)); }
  async settlement(roomId: string) { const r = await this.pool.query('SELECT * FROM settlement WHERE room_id = $1', [roomId]); return r.rows[0] ? this.sett(r.rows[0]) : null; }
  async accountById(id: string) { const r = await this.pool.query('SELECT id, address, name, created_at FROM account WHERE id = $1', [id]); return r.rows[0] ? this.acc(r.rows[0]) : null; }
  async setName(id: string, name: string) {
    const r = await this.pool.query('UPDATE account SET name = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM account WHERE lower(name) = lower($2) AND id <> $1)', [id, name]);
    return (r.rowCount ?? 0) > 0;
  }
  async addRun(x: Omit<RunRecord, 'id' | 'createdAt'>): Promise<RunRecord> {
    const id = newId();
    const r = await this.pool.query(
      'INSERT INTO run (id, account_id, night, content, chapter, outcome, loss_reason, seconds_left, kills, hash, replay_ok, log, score, stats) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING created_at',
      [id, x.accountId, x.night, x.content, x.chapter, x.outcome, x.lossReason, x.secondsLeft, x.kills, x.hash, x.replayOk, x.log, x.score, x.stats ? JSON.stringify(x.stats) : null]);
    return { ...x, id, createdAt: r.rows[0].created_at };
  }
  async recentRuns(accountId: string, limit: number) {
    const r = await this.pool.query('SELECT id, account_id, night, content, chapter, outcome, loss_reason, seconds_left, kills, hash, replay_ok, score, stats, created_at FROM run WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2', [accountId, limit]);
    return r.rows.map((x) => ({ id: x.id, accountId: x.account_id, night: Number(x.night), content: x.content, chapter: x.chapter, outcome: x.outcome, lossReason: x.loss_reason, secondsLeft: x.seconds_left, kills: x.kills, hash: x.hash, replayOk: x.replay_ok, score: x.score, stats: x.stats ? JSON.parse(x.stats) : null, createdAt: x.created_at }));
  }
  async runStats(accountId: string) {
    const r = await this.pool.query('SELECT count(*)::int AS n FROM run WHERE account_id = $1 AND replay_ok', [accountId]);
    return {
      okRuns: r.rows[0].n as number,
      failedSince: async (days: number) => (await this.pool.query("SELECT count(*)::int AS n FROM run WHERE account_id = $1 AND NOT replay_ok AND created_at > now() - ($2 || ' days')::interval", [accountId, String(days)])).rows[0].n as number,
    };
  }
  async bestRuns(nights: number[]): Promise<BestRun[]> {
    if (!nights.length) return [];
    const r = await this.pool.query(
      `SELECT DISTINCT ON (r.account_id, r.night) r.account_id, a.name, a.address, r.night, r.score, r.outcome, r.chapter, r.seconds_left, r.kills, r.stats, r.created_at
         FROM run r JOIN account a ON a.id = r.account_id
        WHERE r.night = ANY($1::bigint[]) AND r.replay_ok
        ORDER BY r.account_id, r.night, r.score DESC, r.created_at`, [nights.map(String)]);
    return r.rows.map((x) => ({ accountId: x.account_id, name: x.name, address: x.address, night: Number(x.night), score: x.score, outcome: x.outcome, chapter: x.chapter, secondsLeft: x.seconds_left, kills: x.kills, stats: x.stats ? JSON.parse(x.stats) : null, createdAt: x.created_at }));
  }
  async adminCounts() {
    const r = await this.pool.query(`SELECT
      (SELECT count(*)::int FROM account) AS accounts, (SELECT count(*)::int FROM run) AS runs,
      (SELECT count(*)::int FROM run WHERE created_at > now() - interval '1 day') AS runs24h,
      (SELECT count(*)::int FROM run WHERE NOT replay_ok AND created_at > now() - interval '1 day') AS failed24h,
      (SELECT count(*)::int FROM account WHERE created_at > now() - interval '1 day') AS accounts24h,
      (SELECT count(DISTINCT code)::int FROM round_seat WHERE created_at > now() - interval '1 day') AS rounds24h`);
    return r.rows[0];
  }
  async failedAccounts(days: number, limit: number) {
    const r = await this.pool.query(
      `SELECT r.account_id, a.address, a.name, count(*) FILTER (WHERE NOT r.replay_ok)::int AS failed, count(*) FILTER (WHERE r.replay_ok)::int AS ok
         FROM run r JOIN account a ON a.id = r.account_id WHERE r.created_at > now() - ($1 || ' days')::interval
        GROUP BY r.account_id, a.address, a.name HAVING count(*) FILTER (WHERE NOT r.replay_ok) > 0 ORDER BY failed DESC LIMIT $2`, [String(days), limit]);
    return r.rows.map((x) => ({ accountId: x.account_id, address: x.address, name: x.name, failed: x.failed, ok: x.ok }));
  }
  async settlementsAll(limit: number) { const r = await this.pool.query('SELECT * FROM settlement ORDER BY created_at DESC LIMIT $1', [limit]); return r.rows.map((x) => this.sett(x)); }
  async addRoundSeats(rows: RoundSeat[]) {
    for (const x of rows) await this.pool.query('INSERT INTO round_seat (account_id, code, status, kills, escaped) VALUES ($1,$2,$3,$4,$5)', [x.accountId, x.code, x.status, x.kills, x.escaped]);
  }
  async roomTotals(days: number): Promise<RoomRow[]> {
    const r = await this.pool.query(
      `SELECT s.account_id, a.name, a.address, count(*)::int AS rounds, count(*) FILTER (WHERE s.escaped)::int AS escapes, sum(s.kills)::int AS kills
         FROM round_seat s JOIN account a ON a.id = s.account_id
        WHERE s.created_at > now() - ($1 || ' days')::interval GROUP BY s.account_id, a.name, a.address`, [String(days)]);
    return r.rows.map((x) => ({ accountId: x.account_id, name: x.name, address: x.address, rounds: x.rounds, escapes: x.escapes, kills: x.kills }));
  }
  async lastSelf(accountId: string, chapter: number) {
    const r = await this.pool.query('SELECT chapter, x, y, weapon FROM last_self WHERE account_id = $1 AND chapter = $2', [accountId, chapter]);
    return r.rows[0] ?? null;
  }
  async setLastSelf(accountId: string, rec: LastSelfRecord | null, chapter: number) {
    if (!rec) { await this.pool.query('DELETE FROM last_self WHERE account_id = $1 AND chapter = $2', [accountId, chapter]); return; }
    await this.pool.query('INSERT INTO last_self (account_id, chapter, x, y, weapon) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id, chapter) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, weapon = EXCLUDED.weapon', [accountId, chapter, rec.x, rec.y, rec.weapon]);
  }
  async bank(accountId: string): Promise<Bank> {
    const [a, o] = await Promise.all([
      this.pool.query('SELECT cash, loadouts FROM account WHERE id = $1', [accountId]),
      this.pool.query('SELECT item, level FROM owned WHERE account_id = $1', [accountId]),
    ]);
    const row = a.rows[0];
    return { cash: Number(row?.cash ?? 0), owned: ownedFrom(o.rows.map((x) => [x.item, x.level])), loadouts: row?.loadouts ? JSON.parse(row.loadouts) : null };
  }
  /** Cash moves inside a transaction with its ledger row (the row's unique key makes a repeat a no-op). */
  private async move(c: pg.PoolClient, accountId: string, delta: number, reason: string, ref: string, allowDebt: boolean) {
    const u = await c.query(`UPDATE account SET cash = cash + $2 WHERE id = $1 ${allowDebt || delta >= 0 ? '' : 'AND cash + $2 >= 0'} RETURNING cash`, [accountId, delta]);
    if (!u.rows[0]) return { ok: false, cash: Number((await c.query('SELECT cash FROM account WHERE id = $1', [accountId])).rows[0]?.cash ?? 0) };
    const cash = Number(u.rows[0].cash);
    const l = await c.query('INSERT INTO ledger (account_id, delta, reason, ref, cash_after) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id, reason, ref) DO NOTHING', [accountId, delta, reason, ref, cash]);
    if (!l.rowCount) return null; // a repeat: undo
    return { ok: true, cash };
  }
  private async tx<T, F>(f: (c: pg.PoolClient) => Promise<T | null>, fallback: F): Promise<T | F> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await f(c);
      if (out === null) { await c.query('ROLLBACK'); return fallback; }
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async ledger(accountId: string, delta: number, reason: string, ref: string, allowDebt = false) {
    const r = await this.tx(async (c) => { const m = await this.move(c, accountId, delta, reason, ref, allowDebt); return m?.ok ? m : null; }, null);
    if (r) return r;
    const cur = await this.pool.query('SELECT cash FROM account WHERE id = $1', [accountId]);
    return { ok: false, cash: Number(cur.rows[0]?.cash ?? 0) };
  }
  async purchase(accountId: string, item: string, level: number, price: number, ref: string) {
    return this.tx(async (c) => {
      const r = await this.move(c, accountId, -price, 'buy', ref, false);
      if (!r?.ok) return null;
      await c.query('INSERT INTO owned (account_id, item, level) VALUES ($1,$2,$3) ON CONFLICT (account_id, item) DO UPDATE SET level = GREATEST(owned.level, EXCLUDED.level)', [accountId, item, level]);
      return true;
    }, false);
  }
  async earnedSince(accountId: string, since: Date) {
    const r = await this.pool.query('SELECT COALESCE(sum(delta), 0)::bigint AS n FROM ledger WHERE account_id = $1 AND reason = ANY($2) AND created_at >= $3', [accountId, EARN_REASONS, since]);
    return Number(r.rows[0].n);
  }
  async setLoadouts(accountId: string, l: Loadouts) { await this.pool.query('UPDATE account SET loadouts = $2 WHERE id = $1', [accountId, JSON.stringify(l)]); }
  private loanRow = (x: { id: string; item: string; fee: number; status: Loan['status']; created_at: Date; due_at: Date; lender_id: string | null; listing_id: string | null }): Loan =>
    ({ id: x.id, item: x.item, fee: x.fee, status: x.status, createdAt: x.created_at, dueAt: x.due_at, lenderId: x.lender_id, listingId: x.listing_id });
  async loansActive(accountId: string) {
    const r = await this.pool.query("SELECT id, item, fee, status, created_at, due_at, lender_id, listing_id FROM loan WHERE account_id = $1 AND status = 'active' ORDER BY created_at", [accountId]);
    return r.rows.map(this.loanRow);
  }
  async loanById(id: string) {
    const r = await this.pool.query('SELECT id, account_id, item, fee, status, created_at, due_at, lender_id, listing_id FROM loan WHERE id = $1', [id]);
    return r.rows[0] ? { ...this.loanRow(r.rows[0]), accountId: r.rows[0].account_id as string } : null;
  }
  async addLoan(n: NewLoan) {
    const r = await this.pool.query("INSERT INTO loan (id, account_id, item, fee, status, due_at, lender_id, listing_id) VALUES ($1,$2,$3,$4,'active',$5,$6,$7) RETURNING created_at",
      [n.id, n.accountId, n.item, n.fee, n.dueAt, n.lenderId ?? null, n.listingId ?? null]);
    return { id: n.id, item: n.item, fee: n.fee, status: 'active' as const, createdAt: r.rows[0].created_at, dueAt: n.dueAt, lenderId: n.lenderId ?? null, listingId: n.listingId ?? null };
  }
  async closeLoan(id: string, status: 'used' | 'returned' | 'expired') { return ((await this.pool.query("UPDATE loan SET status = $2 WHERE id = $1 AND status = 'active'", [id, status])).rowCount ?? 0) > 0; }
  private listingRow = (x: { id: string; owner_id: string; item: string; rate: number; status: Listing['status']; loan_id: string | null; created_at: Date }): Listing =>
    ({ id: x.id, ownerId: x.owner_id, item: x.item, rate: x.rate, status: x.status, loanId: x.loan_id, createdAt: x.created_at });
  async listingsOf(ownerId: string) {
    return (await this.pool.query("SELECT * FROM listing WHERE owner_id = $1 AND status <> 'withdrawn' ORDER BY created_at", [ownerId])).rows.map(this.listingRow);
  }
  async openListings() {
    const r = await this.pool.query("SELECT l.*, a.name AS owner_name, a.address AS owner_address FROM listing l JOIN account a ON a.id = l.owner_id WHERE l.status = 'open' ORDER BY l.created_at LIMIT 500");
    return r.rows.map((x) => ({ ...this.listingRow(x), ownerName: x.owner_name as string | null, ownerAddress: x.owner_address as string }));
  }
  async addListing(ownerId: string, item: string, rate: number) {
    const id = newId();
    const r = await this.pool.query("INSERT INTO listing (id, owner_id, item, rate, status) VALUES ($1,$2,$3,$4,'open') RETURNING *", [id, ownerId, item, rate]);
    return this.listingRow(r.rows[0]);
  }
  async listingById(id: string) { const r = await this.pool.query('SELECT * FROM listing WHERE id = $1', [id]); return r.rows[0] ? this.listingRow(r.rows[0]) : null; }
  async takeListing(id: string, loanId: string) { return ((await this.pool.query("UPDATE listing SET status = 'lent', loan_id = $2 WHERE id = $1 AND status = 'open'", [id, loanId])).rowCount ?? 0) > 0; }
  async reopenListing(id: string) { await this.pool.query("UPDATE listing SET status = 'open', loan_id = NULL WHERE id = $1 AND status = 'lent'", [id]); }
  async withdrawListing(id: string) { return ((await this.pool.query("UPDATE listing SET status = 'withdrawn' WHERE id = $1 AND status = 'open'", [id])).rowCount ?? 0) > 0; }
  async close() { await this.pool.end(); }
}
