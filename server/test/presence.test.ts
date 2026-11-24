import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store.ts';
import { ONLINE_MS, Presence } from '../src/presence.ts';

describe('presence', () => {
  it('online while a page or a room is open, then active today, and the count online takes in guests', async () => {
    let t = Date.UTC(2026, 10, 24, 12);
    const p = new Presence(new MemoryStore(), () => t);
    p.touch('a'); p.guest('g1'); p.open('b');
    expect(p.online()).toBe(3);
    expect(await p.of(['a', 'b', 'c'])).toEqual(new Map([['a', 'online'], ['b', 'online']]));
    t += ONLINE_MS + 1000;
    expect(p.online()).toBe(1); // b still has its room open
    expect((await p.of(['a'])).get('a')).toBe('today');
    p.close('b');
    t += ONLINE_MS + 1000;
    expect(p.online()).toBe(0);
    t = Date.UTC(2026, 10, 25, 1); // past midnight: yesterday is not today
    expect((await p.of(['a', 'b'])).size).toBe(0);
  });

  it('two connections: online until both have closed', async () => {
    let t = 1e12;
    const p = new Presence(new MemoryStore(), () => t);
    p.open('a'); p.open('a'); p.close('a');
    t += ONLINE_MS * 3;
    expect((await p.of(['a'])).get('a')).toBe('online');
    p.close('a');
    t += ONLINE_MS + 1000; // they were about until they left: online a little longer, then not
    expect((await p.of(['a'])).get('a')).toBe('today');
  });
});
