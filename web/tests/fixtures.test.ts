// The replay fixtures: a night and a room round recorded once, with the fingerprint each must end at.
// A second engine (Safari/JavaScriptCore, a server's Node) replays the same logs and must reach the same
// fingerprints. Regenerate with `UPDATE_FIXTURES=1 npx vitest run tests/fixtures.test.ts` only when the
// rules are deliberately changed: a changed fingerprint means every stored log would replay differently.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { command, hashState, quantize, replay, replayRoom, Recorder, RoomRecorder, STEP, type NightLog, type RoomLog } from '../../core/replay';
import { createGame, createRoom, step } from '../../core/state';
import { createRng, next } from '../../core/rng';

const FILE = new URL('./fixtures/replay-v1.json', import.meta.url);
interface Fixtures { night: { log: NightLog; hash: string }; room: { log: RoomLog; hash: string } }

function recordNight(seed: number) {
  const g = createGame(seed);
  const rec = new Recorder(seed, 1);
  rec.begin(0, null);
  const r = createRng(seed * 31 + 7);
  let dx = 0, dy = 0;
  for (let i = 0; i < 40 / STEP && g.phase === 'playing'; i++) {
    if (i % 45 === 0) { const a = next(r) * Math.PI * 2, m = next(r); dx = Math.cos(a) * m; dy = Math.sin(a) * m; }
    const input = quantize({ dx, dy, fire: next(r) < 0.3, action: next(r) < 0.02, reload: next(r) < 0.01, swap: next(r) < 0.005, throw: next(r) < 0.004, light: next(r) < 0.004 });
    if (i === 300) for (const c of [{ t: 'buy', item: { kind: 'medkit' } }, { t: 'equip', weapon: 'baton' }, { t: 'grace' }] as const) { rec.command(c); command(g, c); }
    step(g, input, STEP);
    rec.step(input);
  }
  return { log: JSON.parse(JSON.stringify(rec.log())) as NightLog, hash: hashState(g) };
}

function recordRoom(seed: number, n: number) {
  const g = createRoom(seed, n);
  const dt = 1 / 30;
  const rec = new RoomRecorder(seed, n, 1, dt);
  const r = createRng(seed * 13 + n);
  const dir = Array.from({ length: n }, () => ({ dx: 0, dy: 0 }));
  for (let i = 0; i < 45 / dt && g.phase === 'playing'; i++) {
    const inputs = dir.map((m, k) => {
      if (i % 40 === k * 9) { const a = next(r) * Math.PI * 2; m.dx = Math.cos(a); m.dy = Math.sin(a); }
      return quantize({ dx: m.dx, dy: m.dy, fire: next(r) < 0.25, action: next(r) < 0.03, light: next(r) < 0.004, throw: next(r) < 0.004 });
    });
    step(g, inputs, dt);
    rec.tick(inputs);
  }
  return { log: JSON.parse(JSON.stringify(rec.log())) as RoomLog, hash: hashState(g) };
}

describe('replay fixtures', () => {
  if (process.env.UPDATE_FIXTURES) {
    it('writes the fixtures', () => {
      const f: Fixtures = { night: recordNight(17), room: recordRoom(9, 4) };
      writeFileSync(FILE, JSON.stringify(f));
      expect(replay(f.night.log)).toBeTruthy();
    });
    return;
  }
  const f = JSON.parse(readFileSync(FILE, 'utf8')) as Fixtures;

  it('a recorded night replays to the recorded fingerprint', () => {
    expect(hashState(replay(f.night.log))).toBe(f.night.hash);
  });
  it('a recorded room round replays to the recorded fingerprint', () => {
    expect(hashState(replayRoom(f.room.log))).toBe(f.room.hash);
  });
  it('the fingerprint is a real fingerprint: changing one input changes it', () => {
    const log = JSON.parse(JSON.stringify(f.room.log)) as RoomLog;
    log.seats[0]![1] = -(log.seats[0]![1] ?? 0) - 0.5; // the other way (adding to one already at full stick would be clamped away)
    expect(hashState(replayRoom(log))).not.toBe(f.room.hash);
  });
});
