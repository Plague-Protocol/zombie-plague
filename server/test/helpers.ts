import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { fileURLToPath } from 'node:url';
import { Auth, makeSignatureChecker, signInMessage } from '../src/auth.ts';
import { ContentRegistry } from '../src/content.ts';
import { buildApp } from '../src/http.ts';
import { MemoryStore } from '../src/store.ts';
import { createGame, step } from '../../core/state.ts';
import { quantize, Recorder, STEP, type NightLog } from '../../core/replay.ts';
import type { Claim } from '../src/runs.ts';

export const CONTENT_DIR = fileURLToPath(new URL('../../web/public/content', import.meta.url));
export const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';

export async function makeServer(extra: { now?: () => Date } = {}) {
  const store = new MemoryStore();
  const content = ContentRegistry.fromDir(CONTENT_DIR);
  const auth = new Auth(SECRET, makeSignatureChecker());
  const app = await buildApp({ store, auth, content, origins: ['http://localhost:5173'], ...extra });
  return { app, store, content, auth };
}

export type Server = Awaited<ReturnType<typeof makeServer>>;

/** A wallet, and a way to sign in with it through the API. Returns the token and account. */
export function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  return {
    account,
    async signIn(app: Server['app']) {
      const n = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { address: account.address } });
      const nonce = (n.json() as { nonce: string }).nonce;
      const signature = await account.signMessage({ message: signInMessage(nonce) });
      const v = await app.inject({ method: 'POST', url: '/auth/verify', payload: { address: account.address, signature } });
      return { status: v.statusCode, body: v.json() as { token: string; account: { id: string } }, signature };
    },
  };
}

/** Play a night standing still until it ends, writing it down; return the honest claim for it. */
export function idleNight(seed: number, content = 1): Claim {
  const g = createGame(seed);
  const rec = new Recorder(seed, content);
  rec.begin(0, null);
  const input = quantize({ dx: 0, dy: 0 });
  for (let i = 0; i < 20 * 60 * 60 && g.phase === 'playing'; i++) { step(g, input, STEP); rec.step(input); }
  if (g.phase === 'playing') throw new Error('the night did not end');
  const replay = JSON.parse(JSON.stringify(rec.log())) as NightLog;
  return { seed, chapter: 0, outcome: g.phase === 'won' ? 'won' : 'lost', lossReason: g.lossReason, secondsLeft: g.remaining, replay };
}
