// A server with a made-up leaderboard, for looking at the leaderboard screen. Never for production.
import { Auth, makeSignatureChecker } from '../src/auth.ts';
import { ContentRegistry, nightOf } from '../src/content.ts';
import { buildApp } from '../src/http.ts';
import { MemoryStore } from '../src/store.ts';
const store = new MemoryStore();
const content = ContentRegistry.fromDir(new URL('../../public/content', import.meta.url).pathname);
const app = await buildApp({ store, auth: new Auth('a-demo-secret-that-is-at-least-32-characters', makeSignatureChecker()), content, origins: ['http://localhost:4179'] });
const names = ['Ada', 'Kofi', 'Mira', 'Tunde', 'Lena', 'Sam', 'Ife', 'Chen', null, 'Zara', 'Ola', null];
const today = new Date();
let i = 0;
for (const n of names) {
  const a = await store.upsertAccount('0x' + (i + 1).toString(16).padStart(40, String(i % 10)));
  if (n) await store.setName(a.id, n);
  for (let k = 0; k < 7; k++) {
    if ((i + k) % 3 === 2) continue;
    const won = (i + k) % 2 === 0;
    const st = { cleared: won ? 3 : 1 + (k % 2), kills: 20 + i * 7 + k, bites: (i + k) % 4, shots: 40 + i, hits: 20 + i, rescues: k % 3, optional: i % 2, doses: k % 2, lostEscorts: 0, husks: 0 };
    await store.addRun({ accountId: a.id, night: nightOf(new Date(today.getTime() - k * 864e5)), content: 1, chapter: won ? 2 : st.cleared, outcome: won ? 'won' : 'lost', lossReason: won ? null : 'caught', secondsLeft: won ? 30 + i * 9 : 0, kills: st.kills, hash: 'x', replayOk: true, score: 1000 * st.cleared + (won ? 2000 + (30 + i * 9) * 8 : 0) + st.kills * 4 - st.bites * 50, stats: st, log: Buffer.alloc(0) });
  }
  await store.addRoundSeats(Array.from({ length: 3 + (i % 4) }, (_, r) => ({ accountId: a.id, code: 'ABCDE', status: r % 2 ? 'escaped' : 'turned', kills: r + i, escaped: r % 2 === 1 })));
  i++;
}
await app.listen({ port: 8787, host: '127.0.0.1' });
console.log('demo board on :8787');
