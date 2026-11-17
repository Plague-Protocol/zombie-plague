import { describe, expect, it } from 'vitest';
import { datan2, dcos, dhypot, dsin } from '../../core/dmath';
import { createRng, next } from '../../core/rng';

describe('deterministic math', () => {
  it('matches the standard functions to 1e-8 over 100,000 seeded samples', () => {
    const r = createRng(12345);
    let worst = 0;
    for (let i = 0; i < 100_000; i++) {
      const big = i % 10 === 0;
      const x = (next(r) - 0.5) * (big ? 400 : 20), y = (next(r) - 0.5) * (big ? 400 : 20);
      worst = Math.max(worst, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)), Math.abs(datan2(y, x) - Math.atan2(y, x)), Math.abs(dhypot(x, y) - Math.hypot(x, y)));
    }
    expect(worst).toBeLessThan(1e-8);
  });

  it('gets the edges right: zero, the axes, all four quadrants, signed zero', () => {
    expect(datan2(0, 0)).toBe(0);
    expect(datan2(0, 1)).toBe(0);
    expect(datan2(1, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(datan2(-1, 0)).toBeCloseTo(-Math.PI / 2, 9);
    expect(datan2(0, -1)).toBeCloseTo(Math.PI, 9);
    for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1], [0.001, -5], [-0.001, -5]] as const) expect(datan2(y, x)).toBeCloseTo(Math.atan2(y, x), 8);
    expect(dsin(0)).toBe(0);
    expect(dcos(0)).toBeCloseTo(1, 10);
    expect(dsin(Math.PI)).toBeCloseTo(0, 8);
    expect(dhypot(3, 4)).toBe(5);
  });

  it('is exactly repeatable: the same inputs give the same bits every time', () => {
    const run = () => { let h = 0; for (let i = 0; i < 2000; i++) h = (h * 31 + dsin(i * 0.37) * 1e6 + datan2(i - 1000, 733 - i) * 1e6 + dhypot(i, 5)) % 1e9; return h; };
    expect(run()).toBe(run());
  });
});
