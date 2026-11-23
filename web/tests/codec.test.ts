import { describe, expect, it } from 'vitest';
import { makeDecoder, makeEncoder } from '../../core/codec';
import { createRoom, step } from '../../core/state';
import { viewFor } from '../../core/view';

function busy() {
  const g = createRoom(777, 4);
  const dense = g.zombies.filter((z) => z.action !== 'dormant')[10]!;
  g.players.forEach((p, i) => { p.pos = { x: dense.pos.x + (i - 1.5) * 3, y: dense.pos.y + 3 }; });
  g.zombies.forEach((z) => { z.alertT = 30; });
  for (let i = 0; i < 90; i++) step(g, [], 1 / 30);
  return g;
}

describe('the snapshot wire form', () => {
  it('round-trips a view to within the precision it sends', () => {
    const g = busy();
    const v = viewFor(g, 0);
    const out = makeDecoder()(makeEncoder()(v));
    expect(out.seat).toBe(0);
    expect(out.tick).toBe(v.tick);
    expect(out.you.pos.x).toBeCloseTo(v.you.pos.x, 1);
    expect(out.you.pos.y).toBeCloseTo(v.you.pos.y, 1);
    expect(out.you.health).toBe(Math.round(v.you.health));
    expect(out.you.status).toBe(v.you.status);
    expect(out.you.arsenal).toEqual(JSON.parse(JSON.stringify(v.you.arsenal), (_k, x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)));
    expect(out.others.length).toBe(v.others.length);
    v.others.forEach((o, i) => { expect(out.others[i]!.id).toBe(o.id); expect(out.others[i]!.weapon).toBe(o.weapon); expect(out.others[i]!.light).toBe(o.light); expect(out.others[i]!.status).toBe(o.status); });
    expect(out.zombies.length).toBe(v.zombies.length);
    v.zombies.forEach((z, i) => { const o = out.zombies[i]!; expect([o.id, o.kind, o.action]).toEqual([z.id, z.kind, z.action]); expect(o.pos.x).toBeCloseTo(z.pos.x, 1); expect(o.frozen).toBe(z.frozen); });
    expect(out.tasks).toEqual(v.tasks);
    expect(out.taken).toEqual(v.taken);
    expect(out.seatsLeft).toBe(v.seatsLeft);
  });

  it('sends what is unchanged only once, and a change only as that change', () => {
    const g = busy();
    const enc = makeEncoder(), dec = makeDecoder();
    const first = enc(viewFor(g, 1));
    expect(Object.keys(first.c!)).toEqual(expect.arrayContaining(['y.arsenal', 'tasks', 'taken']));
    dec(first);
    step(g, [], 1 / 30);
    const second = enc(viewFor(g, 1));
    expect(Object.keys(second.c ?? {}).filter((k) => !['y.remaining', 'roomRemaining', 'y.coughT', 'y.invuln'].includes(k))).toEqual([]);
    g.players[1]!.funds += 25;
    g.players[1]!.arsenal.ammo.pistol += 5;
    const third = enc(viewFor(g, 1));
    expect(Object.keys(third.c!).sort()).toEqual(expect.arrayContaining(['y.arsenal', 'y.funds']));
    expect(third.c!.tasks).toBeUndefined();
    const v = dec(third);
    expect(v.you.funds).toBe(g.players[1]!.funds);
    expect(v.tasks.length).toBe(g.tasks.filter((t) => t.owner === undefined || t.owner === 1).length); // still there (your own): the decoder kept it
  });

  it('sends a zombie in full once, then only its moves, nothing while it keeps still, and its id when it goes', () => {
    const g = busy();
    const enc = makeEncoder(), dec = makeDecoder();
    const first = enc(viewFor(g, 0));
    dec(first);
    expect(first.z.length).toBe(viewFor(g, 0).zombies.length);
    // a few snapshots on: whatever moved comes as small steps, and the decoder lands exactly where the encoder is
    for (let k = 0; k < 6; k++) {
      for (let i = 0; i < 2; i++) step(g, [], 1 / 30);
      const v = viewFor(g, 0), w = enc(v), out = dec(w);
      expect(w.z.length).toBeLessThan(v.zombies.length + 1);
      for (const d of w.zd ?? []) { expect(Math.abs(d[1] ?? 0)).toBeLessThan(40); expect(Math.abs(d[2] ?? 0)).toBeLessThan(40); }
      const byId = new Map(out.zombies.map((z) => [z.id, z]));
      expect(out.zombies.length).toBe(v.zombies.length);
      for (const z of v.zombies) {
        const o = byId.get(z.id)!;
        expect(o.pos.x).toBeCloseTo(Math.round(z.pos.x * 16) / 16, 6); // no drift: the steps add up to the same place
        expect(o.pos.y).toBeCloseTo(Math.round(z.pos.y * 16) / 16, 6);
        expect(o.action).toBe(z.action);
      }
    }
    // standing still: nothing at all about it
    const still = viewFor(g, 0);
    const again = enc(still);
    expect(again.z.length + (again.zd?.length ?? 0)).toBe(0);
    // out of view: its id once, and the decoder forgets it
    const gone = { ...still, zombies: still.zombies.slice(1) };
    const w = enc(gone);
    expect(w.zg).toEqual([still.zombies[0]!.id]);
    expect(dec(w).zombies.some((z) => z.id === still.zombies[0]!.id)).toBe(false);
  });

  it('a new connection starts from nothing and is told everything', () => {
    const g = busy();
    const old = makeEncoder();
    old(viewFor(g, 0));
    const fresh = makeEncoder()(viewFor(g, 0));
    expect(fresh.c!.tasks).toBeDefined();
    expect(fresh.c!['y.arsenal']).toBeDefined();
  });

  it('is a fraction of the size of the view as plain JSON, and a steady snapshot is smaller still', () => {
    const g = busy();
    const enc = makeEncoder();
    const plain = JSON.stringify(viewFor(g, 0)).length;
    enc(viewFor(g, 0)); // the first carries everything
    step(g, [], 1 / 30);
    const steady = JSON.stringify(enc(viewFor(g, 0))).length;
    process.stdout.write(`snapshot: ${plain} bytes as plain JSON, ${steady} bytes steady (${viewFor(g, 0).zombies.length} zombies, ${viewFor(g, 0).others.length} others in view)\n`);
    expect(steady).toBeLessThan(plain / 3);
  });

  it('events pass through, with their numbers rounded', () => {
    const g = busy();
    g.events.push({ type: 'scream', id: 1, pos: { x: g.players[0]!.pos.x + 1.123456789, y: g.players[0]!.pos.y }, count: 2 });
    const w = makeEncoder()(viewFor(g, 0));
    expect(w.e!.length).toBe(1);
    expect(JSON.stringify(w.e)).not.toMatch(/\.\d{3,}/);
  });
});
