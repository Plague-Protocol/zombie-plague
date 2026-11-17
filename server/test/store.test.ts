// The same behaviour from both stores: memory always, Postgres when TEST_DATABASE_URL points at a database to use.
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore, PgStore, type Store } from '../src/store.ts';

const url = process.env.TEST_DATABASE_URL;
const stores: Array<[string, () => Promise<Store>]> = [['memory', async () => new MemoryStore()]];
if (url) stores.push(['postgres', async () => PgStore.connect(url)]);
const opened: Store[] = [];
afterAll(async () => { for (const s of opened) await s.close(); });

const run = (accountId: string, o: Partial<Parameters<Store['addRun']>[0]> = {}) => ({
  accountId, night: 7, content: 1, chapter: 2, outcome: 'won' as const, lossReason: null, secondsLeft: 30, kills: 3, hash: 'abc', replayOk: true, score: 0, stats: null, log: Buffer.from([1, 2, 3]), ...o,
});

for (const [name, make] of stores) {
  describe(`${name} store`, () => {
    const fresh = async () => { const s = await make(); opened.push(s); return s; };
    const addr = () => '0x' + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');

    it('one account per address, whatever the case', async () => {
      const s = await fresh();
      const a = addr();
      const one = await s.upsertAccount(a), two = await s.upsertAccount(a.toUpperCase().replace('0X', '0x'));
      expect(two.id).toBe(one.id);
      expect(one.address).toBe(a.toLowerCase());
      expect((await s.accountById(one.id))?.address).toBe(one.address);
      expect(await s.accountById('nobody')).toBeNull();
      await s.setName(one.id, 'Sam');
      expect((await s.accountById(one.id))?.name).toBe('Sam');
    });

    it('keeps runs, counts the ones that replayed, and counts recent failures', async () => {
      const s = await fresh();
      const a = await s.upsertAccount(addr());
      await s.addRun(run(a.id));
      await s.addRun(run(a.id, { replayOk: true }));
      await s.addRun(run(a.id, { replayOk: false }));
      const st = await s.runStats(a.id);
      expect(st.okRuns).toBe(2);
      expect(await st.failedSince(7)).toBe(1);
      const recent = await s.recentRuns(a.id, 2);
      expect(recent.length).toBe(2);
      expect('log' in recent[0]!).toBe(false);
      expect((await s.runStats((await s.upsertAccount(addr())).id)).okRuns).toBe(0);
    });

    it('best replayed run per account per night, by score, and room totals', async () => {
      const s = await fresh();
      const night = Math.floor(Math.random() * 1e9), other = night + 1;
      const [a, b, c] = [await s.upsertAccount(addr()), await s.upsertAccount(addr()), await s.upsertAccount(addr())];
      await s.addRun(run(a.id, { night, score: 200 })); await s.addRun(run(a.id, { night, score: 900, outcome: 'lost' }));
      await s.addRun(run(a.id, { night: other, score: 50 }));
      await s.addRun(run(b.id, { night, score: 400, stats: { cleared: 1, kills: 4, bites: 2, shots: 10, hits: 5, rescues: 0, optional: 1, doses: 0, lostEscorts: 0, husks: 0 } }));
      await s.addRun(run(c.id, { night, score: 9999, replayOk: false }));
      const best = (await s.bestRuns([night])).sort((x, y) => y.score - x.score);
      expect(best.map((r) => r.score)).toEqual([900, 400]); // a lost run can be your best; a failed replay never counts
      expect(best[1]!.stats?.bites).toBe(2);
      expect((await s.bestRuns([night, other])).length).toBe(3);
      expect(await s.bestRuns([])).toEqual([]);
      await s.addRoundSeats([{ accountId: a.id, code: 'ABCDE', status: 'escaped', kills: 3, escaped: true }, { accountId: a.id, code: 'FGHJK', status: 'turned', kills: 1, escaped: false }]);
      const t = (await s.roomTotals(30)).find((r) => r.accountId === a.id)!;
      expect([t.rounds, t.escapes, t.kills]).toEqual([2, 1, 4]);
    });

    it('counts for the admin page, and the accounts whose replays fail', async () => {
      const s = await fresh();
      const before = await s.adminCounts();
      const a = await s.upsertAccount(addr()), b = await s.upsertAccount(addr());
      await s.addRun(run(a.id, { replayOk: false })); await s.addRun(run(a.id, { replayOk: false })); await s.addRun(run(a.id));
      await s.addRun(run(b.id));
      const after = await s.adminCounts();
      expect(after.accounts - before.accounts).toBe(2);
      expect(after.runs24h - before.runs24h).toBe(4);
      expect(after.failed24h - before.failed24h).toBe(2);
      const sus = (await s.failedAccounts(7, 50)).find((x) => x.accountId === a.id)!;
      expect([sus.failed, sus.ok]).toEqual([2, 1]);
      expect((await s.failedAccounts(7, 50)).some((x) => x.accountId === b.id)).toBe(false);
      const ref = `USDm:${Math.floor(Math.random() * 1e9)}`;
      await s.addSettlement({ roomId: ref, winners: [], logHash: '0x00', status: 'pending', tx: null, error: null });
      expect((await s.settlementsAll(10)).some((x) => x.roomId === ref)).toBe(true);
    });

    it('last selves: set, replaced, read back by chapter, cleared', async () => {
      const s = await fresh();
      const a = await s.upsertAccount(addr());
      expect(await s.lastSelf(a.id, 0)).toBeNull();
      await s.setLastSelf(a.id, { chapter: 0, x: 1, y: 2, weapon: 'pistol' }, 0);
      await s.setLastSelf(a.id, { chapter: 0, x: 3, y: 4, weapon: null }, 0);
      await s.setLastSelf(a.id, { chapter: 1, x: 9, y: 9, weapon: 'bat' }, 1);
      expect(await s.lastSelf(a.id, 0)).toMatchObject({ x: 3, y: 4, weapon: null });
      expect(await s.lastSelf(a.id, 1)).toMatchObject({ x: 9, weapon: 'bat' });
      await s.setLastSelf(a.id, null, 0);
      expect(await s.lastSelf(a.id, 0)).toBeNull();
      expect(await s.lastSelf(a.id, 1)).not.toBeNull();
    });
  });
}
