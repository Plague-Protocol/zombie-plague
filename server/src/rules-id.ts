// A fingerprint of the rules: a hash of the core's source. The site and the server each stamp theirs in at build
// time (vite's and esbuild's `define`), and a night log carries the site's. A log played under other rules cannot
// replay the same, and is not a cheat: the server says the game was updated instead of marking a failed replay.
// Node only (vite.config.ts, the server's build, the server): never imported by the game, so it lives here and not in core/.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Files that do not change how a night plays (rooms' wire format and views, this file). */
const NOT_RULES = new Set(['view.ts', 'codec.ts', 'protocol.ts']);

/** The rules' fingerprint, from the core folder's source (12 hex digits). */
export function rulesId(coreDir: string): string {
  const h = createHash('sha256');
  for (const f of readdirSync(coreDir).filter((x) => x.endsWith('.ts') && !NOT_RULES.has(x)).sort()) {
    h.update(f).update('\0').update(readFileSync(join(coreDir, f), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}
