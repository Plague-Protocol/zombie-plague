import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { rulesId } from '../server/src/rules-id';

export default defineConfig({
  // the rules this build plays by: stamped on every night's log, so the server can tell an update from a bad replay
  define: { __RULES__: JSON.stringify(rulesId(fileURLToPath(new URL('../core', import.meta.url)))) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    // The site (app.ts, site/) is what loads first; it imports the game in the background. Everything the game needs
    // stays in one 'game' file; only the pages it loads later (puzzle, store, full map, multiplayer) are split off.
    // The game's rules live in ../core (shared with the server); the parts only rooms use (view, codec, protocol) and the
    // armoury's catalogue (the site's Armoury page; the game takes only core/loadout.ts) stay out.
    rolldownOptions: { output: { advancedChunks: { groups: [{ name: 'preload', test: /preload-helper|modulepreload-polyfill/, priority: 2 }, { name: 'game', test: /web\/src\/(?!ui\/(store|fullmap|puzzle|splash)|net\/|site\/|audio\/|app\.ts)|^(?!.*node_modules).*\/core\/(?!view|codec|protocol|armoury)[^/]+$|node_modules\/three\// }] } } },
  },
  server: { fs: { allow: ['..'] } }, // ../core is outside this folder
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'], testTimeout: 30000 },
});
