import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    // Everything the game needs at start stays in one file; only the pages loaded later (puzzle,
    // store, full map, multiplayer) are split off. Shared modules would otherwise become extra startup chunks.
    // The game's rules live in ../core (shared with the server); the parts only rooms use (view, codec, protocol) stay out.
    rolldownOptions: { output: { advancedChunks: { groups: [{ name: 'game', test: /web\/src\/(?!ui\/(store|fullmap|puzzle|splash)|net\/)|^(?!.*node_modules).*\/core\/(?!view|codec|protocol)[^/]+$|node_modules\/three\// }] } } },
  },
  server: { fs: { allow: ['..'] } }, // ../core is outside this folder
  test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'], testTimeout: 30000 },
});
