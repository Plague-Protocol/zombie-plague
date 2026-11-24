import { scoreRun } from '../src/score.ts';
import type { Board } from '../src/boards.ts';
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { idleNight, makeServer, SECRET, wallet, type Server } from './helpers.ts';
import { Auth, makeSignatureChecker } from '../src/auth.ts';
import { check, MAX_CHAPTERS, OTHER_RULES, refuseBeforeReplay } from '../src/runs.ts';
import { RULES } from '../src/rules.ts';
import { nightOf } from '../src/content.ts';
import { loadConfig } from '../src/config.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('sign-in', () => {
  it('a wallet signs a nonce and gets a token that says which account it is', async () => {
    const s = await makeServer();
    const w = wallet();
    const r = await w.signIn(s.app);
    expect(r.status).toBe(200);
    const me = await s.app.inject({ method: 'GET', url: '/me', headers: bearer(r.body.token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { account: { address: string } }).account.address).toBe(w.account.address.toLowerCase());
    expect((await s.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: bearer('nonsense') })).statusCode).toBe(401);
  });

  it('refuses a signature from another wallet, a replayed one, and a stale nonce', async () => {
    const s = await makeServer();
    const a = wallet(), b = wallet();
    const n = (await s.app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: a.account.address } })).json() as { nonce: string };
    const { signInMessage } = await import('../src/auth.ts');
    const forged = await b.account.signMessage({ message: signInMessage(n.nonce) });
    expect((await s.app.inject({ method: 'POST', url: '/auth/verify', payload: { address: a.account.address, signature: forged } })).statusCode).toBe(401);
    // the nonce is spent by a failed try too: a second go needs a new one
    const good = await a.account.signMessage({ message: signInMessage(n.nonce) });
    expect((await s.app.inject({ method: 'POST', url: '/auth/verify', payload: { address: a.account.address, signature: good } })).statusCode).toBe(401);
    const first = await a.signIn(s.app);
    expect(first.status).toBe(200);
    const replayed = await s.app.inject({ method: 'POST', url: '/auth/verify', payload: { address: a.account.address, signature: first.signature } });
    expect(replayed.statusCode).toBe(401); // the same signature again
    // a nonce that has aged out
    let t = 1_000_000;
    const old = new Auth(SECRET, makeSignatureChecker(), () => t);
    const nn = old.nonce(a.account.address);
    t += 6 * 60_000;
    const sig = await a.account.signMessage({ message: signInMessage(nn) });
    expect(await old.verify(a.account.address, sig, async () => 'x')).toBeNull();
  });

  it('rejects a bad address, a token signed with another secret, and floods', async () => {
    const s = await makeServer();
    expect((await s.app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: 'nope' } })).statusCode).toBe(400);
    const other = new Auth('another-secret-another-secret-another-secret', makeSignatureChecker());
    const w = wallet();
    const nonce = other.nonce(w.account.address);
    const { signInMessage } = await import('../src/auth.ts');
    const token = await other.verify(w.account.address, await w.account.signMessage({ message: signInMessage(nonce) }), async () => 'someone');
    expect((await s.app.inject({ method: 'GET', url: '/me', headers: bearer(token!) })).statusCode).toBe(401);
    let limited = 0;
    for (let i = 0; i < 30; i++) if ((await s.app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: w.account.address } })).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('the display name is checked', async () => {
    const s = await makeServer();
    const t = (await wallet().signIn(s.app)).body.token;
    expect((await s.app.inject({ method: 'POST', url: '/me', headers: bearer(t), payload: { name: 'Sam <script>' } })).statusCode).toBe(400);
    expect((await s.app.inject({ method: 'POST', url: '/me', headers: bearer(t), payload: { name: 'Sam' } })).statusCode).toBe(200);
    // names are one each: another account cannot take it, in any case; its owner can set it again
    const t2 = (await wallet().signIn(s.app)).body.token;
    expect((await s.app.inject({ method: 'POST', url: '/me', headers: bearer(t2), payload: { name: 'sAM' } })).statusCode).toBe(409);
    expect((await s.app.inject({ method: 'POST', url: '/me', headers: bearer(t2), payload: { name: 'Sam2' } })).statusCode).toBe(200);
    expect((await s.app.inject({ method: 'POST', url: '/me', headers: bearer(t), payload: { name: 'SAM' } })).statusCode).toBe(200);
  });
});

describe('the day\'s night', () => {
  it('is the same for everyone on a day and different on the next', async () => {
    let d = new Date('2026-11-17T03:00:00Z');
    const s = await makeServer({ now: () => d });
    const a = (await s.app.inject({ method: 'GET', url: '/night/today' })).json() as { night: number; content: number };
    d = new Date('2026-11-17T23:59:00Z');
    expect(((await s.app.inject({ method: 'GET', url: '/night/today' })).json() as { night: number }).night).toBe(a.night);
    d = new Date('2026-11-18T00:01:00Z');
    expect(((await s.app.inject({ method: 'GET', url: '/night/today' })).json() as { night: number }).night).not.toBe(a.night);
    expect(a.night).toBe(nightOf(new Date('2026-11-17T12:00:00Z')));
    expect(a.content).toBe(s.content.latest);
  });
});

describe('runs are checked by replay', () => {
  it('an honest log verifies, is stored, and a lost run leaves your last self where you fell', async () => {
    const s = await makeServer();
    const w = wallet();
    const { token, account } = (await w.signIn(s.app)).body;
    const claim = idleNight(41);
    const r = await s.app.inject({ method: 'POST', url: '/runs', headers: bearer(token), payload: { result: claim } });
    expect(r.json()).toMatchObject({ replayOk: true });
    const runs = ((await s.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).json() as { runs: Array<{ replayOk: boolean; kills: number }>; okRuns: number });
    expect(runs.okRuns).toBe(1);
    expect(runs.runs[0]!.replayOk).toBe(true);
    if (claim.outcome === 'lost' && (claim.lossReason === 'caught' || claim.lossReason === 'time')) {
      const self = await s.store.lastSelf(account.id, 0);
      expect(self).not.toBeNull();
      const api = await s.app.inject({ method: 'GET', url: '/last-self?chapter=0', headers: bearer(token) });
      expect((api.json() as { husk: { pos: { x: number } } | null }).husk?.pos.x).toBeCloseTo(self!.x, 5);
    }
    expect(((await s.app.inject({ method: 'GET', url: '/last-self?chapter=1', headers: bearer(token) })).json() as { husk: unknown }).husk).toBeNull();
  });

  it('the stored log is the log, gzipped', async () => {
    const s = await makeServer();
    const { token, account } = (await wallet().signIn(s.app)).body;
    const claim = idleNight(42);
    await s.app.inject({ method: 'POST', url: '/runs', headers: bearer(token), payload: { result: claim } });
    void account;
    const stored = (s.store as unknown as { runs: Array<{ log: Buffer }> }).runs[0]!;
    expect(JSON.parse(gunzipSync(stored.log).toString())).toEqual(claim.replay);
  });

  it('one changed input, a wrong claim, or a different night do not verify', async () => {
    const s = await makeServer();
    const base = idleNight(43);
    const selves = new Map();
    expect(check(base, s.content, selves).replayOk).toBe(true);
    // change an input: stand still becomes walking, so the run ends differently
    const moved = clone(base);
    moved.replay.chapters[0]!.runs[1] = 1; moved.replay.chapters[0]!.runs[2] = 0.5;
    expect(check(moved, s.content, selves).replayOk).toBe(false);
    // claim a win that was a loss, more time than there was, a lie about the reason
    const win = clone(base); win.outcome = 'won'; win.lossReason = null;
    expect(check(win, s.content, selves).replayOk).toBe(false);
    const time = clone(base); time.secondsLeft += 5;
    expect(check(time, s.content, selves).replayOk).toBe(false);
    const why = clone(base); why.lossReason = base.lossReason === 'caught' ? 'time' : 'caught';
    expect(check(why, s.content, selves).replayOk).toBe(false);
  });

  it('a night played under other rules (an update meanwhile) is refused as such, and not kept as a failed replay', async () => {
    const s = await makeServer();
    const { token } = (await wallet().signIn(s.app)).body;
    const same = idleNight(45); same.replay.rules = RULES;
    expect((await s.app.inject({ method: 'POST', url: '/runs', headers: bearer(token), payload: { result: same } })).json()).toMatchObject({ replayOk: true });
    const other = idleNight(46); other.replay.rules = 'aaaaaaaaaaaa';
    const r = (await s.app.inject({ method: 'POST', url: '/runs', headers: bearer(token), payload: { result: other } })).json() as { replayOk: boolean; reason: string };
    expect(r).toMatchObject({ replayOk: false, reason: OTHER_RULES });
    const me = (await s.app.inject({ method: 'GET', url: '/me', headers: bearer(token) })).json() as { runs: unknown[] };
    expect(me.runs.length).toBe(1); // only the one that was checked
  });

  it('refuses what cannot be a log before replaying any of it', async () => {
    const s = await makeServer();
    const base = idleNight(44);
    const many = clone(base);
    for (let i = 0; i < MAX_CHAPTERS; i++) many.replay.chapters.push(clone(base.replay.chapters[0]!));
    expect(refuseBeforeReplay(many, s.content)).toMatch(/chapters/);
    const wrongNight = clone(base); wrongNight.seed = 999;
    expect(refuseBeforeReplay(wrongNight, s.content)).toMatch(/different night/);
    const oldContent = clone(base); oldContent.replay.content = 777;
    expect(refuseBeforeReplay(oldContent, s.content)).toMatch(/unknown content/);
    const wrongChapter = clone(base); wrongChapter.chapter = 2;
    expect(refuseBeforeReplay(wrongChapter, s.content)).toMatch(/last one/);
    expect(refuseBeforeReplay({ ...base, replay: null as never }, s.content)).toMatch(/not a night log/);
    // and a chapter that is longer than any chapter can be is refused by the replay itself
    const long = clone(base);
    long.replay.chapters[0]!.runs = [20 * 60 * 60 + 1, 0, 0, 0];
    const v = check(long, s.content, new Map());
    expect(v.replayOk).toBe(false);
  });

  it('ignores the last self a client puts in its own log: the server replays with its own', async () => {
    const s = await makeServer();
    const base = idleNight(45);
    const forged = clone(base);
    forged.replay.chapters[0]!.husk = { pos: { x: 100, y: 100 }, weapon: 'rifle' };
    const honest = check(base, s.content, new Map());
    const withForgery = check(forged, s.content, new Map());
    expect(withForgery.replayOk).toBe(true);
    expect(withForgery.hash).toBe(honest.hash);
    // and with a last self the SERVER knows, the replay does differ (it is really being used)
    const real = check(base, s.content, new Map([[0, { pos: { x: base.replay.chapters[0]!.runs.length, y: 5 }, weapon: 'rifle' as const }]]));
    expect(real.hash).not.toBe(honest.hash);
  });

  it('needs sign-in, and limits how fast runs are sent', async () => {
    const s = await makeServer();
    const claim = idleNight(46);
    expect((await s.app.inject({ method: 'POST', url: '/runs', payload: { result: claim } })).statusCode).toBe(401);
    const { token } = (await wallet().signIn(s.app)).body;
    expect((await s.app.inject({ method: 'POST', url: '/runs', headers: bearer(token), payload: { result: { ...claim, outcome: 'maybe' } } })).statusCode).toBe(400);
    let limited = 0;
    for (let i = 0; i < 10; i++) if ((await s.app.inject({ method: 'POST', url: '/runs', headers: bearer(token), payload: { result: claim } })).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe('the leaderboard', () => {
  const rec = (s: Server, id: string, night: number, score: number, o: Partial<Parameters<Server['store']['addRun']>[0]> = {}) =>
    s.store.addRun({ accountId: id, night, content: 1, chapter: 2, outcome: 'won', lossReason: null, secondsLeft: 30, kills: 3, hash: 'x', replayOk: true, score, stats: null, log: Buffer.alloc(0), ...o });
  const DAY = 864e5;

  it('tonight: best replayed score per player, with titles, and where you stand', async () => {
    const t = new Date('2026-11-17T12:00:00Z');
    const s = await makeServer({ now: () => t });
    const night = nightOf(t);
    const w = wallet();
    const { body } = await w.signIn(s.app);
    const me = body.account.id;
    const a = await s.store.upsertAccount('0x' + 'a'.repeat(40)), b = await s.store.upsertAccount('0x' + 'b'.repeat(40));
    await s.store.setName(b.id, 'Bea');
    await rec(s, a.id, night, 3000); await rec(s, a.id, night, 5000); await rec(s, b.id, night, 4000); await rec(s, me, night, 2500);
    await rec(s, b.id, night, 9000, { replayOk: false }); await rec(s, a.id, night - 1, 9999);
    const board = (await s.app.inject({ method: 'GET', url: '/leaderboard', headers: { authorization: `Bearer ${body.token}` } })).json() as Board;
    expect(board.rows.map((r) => r.value)).toEqual([5000, 4000, 2500]);
    expect(board.rows[0]!.title).toBe('Last Light');
    expect(board.rows[1]!.name).toBe('Bea');
    expect(board.me).toMatchObject({ rank: 3, value: 2500, toNext: { gap: 1501, name: 'Bea' } });
    expect(board.rules.length).toBeGreaterThan(2);
    expect((await s.app.inject({ method: 'GET', url: '/leaderboard' })).json().me).toBeNull(); // not signed in
    expect((await s.app.inject({ method: 'GET', url: '/leaderboard?board=nope' })).statusCode).toBe(400);
  });

  it('this week adds up your best per night; a streak counts nights in a row you got out', async () => {
    const t = new Date('2026-11-17T12:00:00Z');
    const s = await makeServer({ now: () => t });
    const n = (k: number) => nightOf(new Date(t.getTime() - k * DAY));
    const a = await s.store.upsertAccount('0x' + 'a'.repeat(40)), b = await s.store.upsertAccount('0x' + 'b'.repeat(40));
    // a: three nights in a row up to last night (tonight not played yet), then a gap
    for (const k of [1, 2, 3, 5]) await rec(s, a.id, n(k), 1000);
    // b: one big night, and a lost one tonight
    await rec(s, b.id, n(0), 2500); await rec(s, b.id, n(1), 100, { outcome: 'lost' });
    await rec(s, b.id, n(8), 9999); // outside the week
    const week = (await s.app.inject({ method: 'GET', url: '/leaderboard?board=week' })).json() as Board;
    expect(week.rows.map((r) => [r.name.slice(0, 4), r.value])).toEqual([['0xaa', 4000], ['0xbb', 2600]]);
    const streak = (await s.app.inject({ method: 'GET', url: '/leaderboard?board=streak' })).json() as Board;
    expect(streak.rows.map((r) => [r.name.slice(0, 4), r.value])).toEqual([['0xaa', 3], ['0xbb', 1]]);
  });

  it('rooms: escapes over the last month, three rounds to be listed', async () => {
    const s = await makeServer();
    const a = await s.store.upsertAccount('0x' + 'a'.repeat(40)), b = await s.store.upsertAccount('0x' + 'b'.repeat(40));
    const seat = (id: string, escaped: boolean) => ({ accountId: id, code: 'ABCDE', status: escaped ? 'escaped' : 'dead', kills: 2, escaped });
    await s.store.addRoundSeats([seat(a.id, true), seat(a.id, false), seat(a.id, true), seat(b.id, true), seat(b.id, true)]);
    const rooms = (await s.app.inject({ method: 'GET', url: '/leaderboard?board=rooms' })).json() as Board;
    expect(rooms.rows.length).toBe(1); // b has only two rounds
    expect(rooms.rows[0]).toMatchObject({ value: 2, detail: { rounds: 3, rate: 67, kills: 6 } });
  });

  it('rooms today, for the home page: rounds played and signed-in players who got out', async () => {
    const s = await makeServer();
    const a = await s.store.upsertAccount('0x' + 'a'.repeat(40)), b = await s.store.upsertAccount('0x' + 'b'.repeat(40));
    expect((await s.app.inject({ method: 'GET', url: '/rooms/today' })).json()).toEqual({ rounds: 0, escapes: 0 });
    await s.store.addRoundSeats([
      { accountId: a.id, code: 'ABCDE', status: 'escaped', kills: 2, escaped: true }, { accountId: b.id, code: 'ABCDE', status: 'turned', kills: 0, escaped: false },
      { accountId: b.id, code: 'FGHJK', status: 'escaped', kills: 1, escaped: true },
    ]);
    expect((await s.app.inject({ method: 'GET', url: '/rooms/today' })).json()).toEqual({ rounds: 2, escapes: 2 });
  });

  it('all time, for the home page: players, room escapes, and the best score of each of the top players', async () => {
    const s = await makeServer();
    expect((await s.app.inject({ method: 'GET', url: '/stats' })).json()).toEqual({ players: 0, escapes: 0, online: 0, top: [] });
    const a = await s.store.upsertAccount('0x' + 'a'.repeat(40)), b = await s.store.upsertAccount('0x' + 'b'.repeat(40));
    await s.store.setName(a.id, 'Ada');
    await s.store.addRoundSeats([{ accountId: b.id, code: 'ABCDE', status: 'escaped', kills: 2, escaped: true }]);
    await rec(s, a.id, 7, 1200); await rec(s, a.id, 8, 800); await rec(s, b.id, 7, 600); await rec(s, b.id, 8, 5000, { replayOk: false });
    expect((await s.app.inject({ method: 'GET', url: '/stats' })).json()).toEqual({
      players: 2, escapes: 1, online: 0, top: [{ name: 'Ada', score: 1200 }, { name: '0xbbbb…bbbb', score: 600 }],
    });
    // the All time board is the same list, in full
    const all = (await s.app.inject({ method: 'GET', url: '/leaderboard?board=all' })).json() as Board;
    expect(all.rows.map((r) => [r.name, r.value])).toEqual([['Ada', 1200], ['0xbbbb…bbbb', 600]]);
  });

  it('who is about: a heartbeat counts toward online now, and the boards mark players online or active today (nothing finer)', async () => {
    const s = await makeServer();
    const w = wallet();
    const { body } = await w.signIn(s.app);
    const other = await s.store.upsertAccount('0x' + 'c'.repeat(40));
    await rec(s, body.account.id, 7, 900); await rec(s, other.id, 7, 500);
    // a guest's page and a signed-in player's
    expect((await s.app.inject({ method: 'POST', url: '/ping', payload: { g: 'abcdef1234' } })).statusCode).toBe(200);
    await s.app.inject({ method: 'POST', url: '/ping', headers: { authorization: `Bearer ${body.token}` }, payload: {} });
    expect(((await s.app.inject({ method: 'GET', url: '/stats' })).json() as { online: number }).online).toBe(2);
    // someone seen earlier today (written down, not in this run of the server's memory)
    await s.store.touchSeen(other.id, new Date());
    const b = (await s.app.inject({ method: 'GET', url: '/leaderboard?board=all' })).json() as Board;
    expect(b.rows.map((r) => r.on)).toEqual(['online', 'today']);
    expect(JSON.stringify(b)).not.toContain(other.id); // no account ids, no times
    // a bad guest id is ignored
    await s.app.inject({ method: 'POST', url: '/ping', payload: { g: 'NOT OK!' } });
    expect(((await s.app.inject({ method: 'GET', url: '/stats' })).json() as { online: number }).online).toBe(2);
  });
});

describe('the score', () => {
  const st = { cleared: 0, kills: 0, bites: 0, shots: 0, hits: 0, rescues: 0, optional: 0, doses: 0, lostEscorts: 0, husks: 0 };
  it('rewards getting further first, time left only on a night survived, and caps killing', () => {
    expect(scoreRun({ ...st, cleared: 1 }, false, 100).score).toBe(1000);
    expect(scoreRun({ ...st, cleared: 3 }, true, 100).score).toBe(3000 + 2000 + 800 + 500); // + a clean night
    expect(scoreRun({ ...st, kills: 10_000 }, false, 0).score).toBe(1000);
    expect(scoreRun({ ...st, shots: 19, hits: 19 }, false, 0).score).toBe(0); // too few shots to count
    expect(scoreRun({ ...st, shots: 40, hits: 30 }, false, 0).score).toBe(300);
  });
  it('costs bites, doses and people you let turn, and never goes below zero', () => {
    expect(scoreRun({ ...st, cleared: 3, bites: 1 }, true, 0).parts.clean).toBeUndefined();
    expect(scoreRun({ ...st, cleared: 1, bites: 4, doses: 2, lostEscorts: 1 }, false, 0).score).toBe(1000 - 200 - 60 - 150);
    expect(scoreRun({ ...st, bites: 99 }, false, 0).score).toBe(0);
  });
});

describe('config and content', () => {
  it('refuses to start without a real secret, and finds the game\'s content', async () => {
    expect(() => loadConfig({ JWT_SECRET: 'short' })).toThrow(/32/);
    const c = loadConfig({ JWT_SECRET: SECRET, ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
    expect(c.origins).toEqual(['https://a.example', 'https://b.example']);
    const s = await makeServer();
    expect(s.content.has(s.content.latest)).toBe(true);
    expect(s.content.latest).toBeGreaterThan(0);
  });
});
