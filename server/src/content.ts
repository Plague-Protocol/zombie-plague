// The task content, by version. A run records which version it was played against, and a replay must use
// the same one, so the server keeps every version it has ever served. The core holds one global "current"
// content, so the swap is always undone (and never held across an await).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setContent, type Content } from '../../src/core/content.ts';

export class ContentRegistry {
  private byVersion = new Map<number, Content>();
  latest = 0;

  /** Every *.json in `dir` that has a numeric `version` and passes the game's own checks. */
  static fromDir(dir: string): ContentRegistry {
    const r = new ContentRegistry();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      let c: Content;
      try { c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Content; } catch { continue; }
      if (typeof c?.version === 'number' && c.groups && c.story) r.add(c);
    }
    if (!r.byVersion.size) throw new Error(`no task content found in ${dir}`);
    r.use(r.latest);
    return r;
  }

  add(c: Content): void {
    setContent(c); // throws if the content is not valid
    this.byVersion.set(c.version, c);
    this.latest = Math.max(this.latest, c.version);
  }

  has(version: number): boolean { return this.byVersion.has(version); }

  /** Make `version` the current content. */
  use(version: number): void {
    const c = this.byVersion.get(version);
    if (!c) throw new Error(`unknown content version ${version}`);
    setContent(c);
  }

  /** Run `fn` against a version, then put the latest back. `fn` must be synchronous. */
  with<T>(version: number, fn: () => T): T {
    this.use(version);
    try { return fn(); } finally { this.use(this.latest); }
  }
}

/** The night everyone plays on a given (UTC) day: a hash of the date, so no coordination is needed. */
export function nightOf(date: Date): number {
  const text = date.toISOString().slice(0, 10);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
