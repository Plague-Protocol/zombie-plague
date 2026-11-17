// Signing in with a wallet the page already has (MiniPay, or any wallet that injects window.ethereum), and talking to
// the server's API with the token that gives. Loaded only when someone signs in or a signed-in player finishes a run.
import type { RunResult } from '../seams/progress';
import type { Husk } from '../core/types';

export interface Account { token: string; address: string; name: string | null }

const KEY = 'zp.account';
interface Eth { request(a: { method: string; params?: unknown[] }): Promise<unknown> }
const eth = () => (window as unknown as { ethereum?: Eth }).ethereum;

/** Who is signed in on this device, if anyone. */
export function account(): Account | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Account | null; } catch { return null; }
}
export function signOut(): void { try { localStorage.removeItem(KEY); } catch { /* nothing to clear */ } }

const hex = (s: string) => `0x${Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('')}`;

/** Ask the wallet for an address, have it sign the server's nonce, and keep the token. `api` is the server's HTTP base. */
export async function signIn(api: string): Promise<Account> {
  const e = eth();
  if (!e) throw new Error('No wallet found.');
  const [address] = (await e.request({ method: 'eth_requestAccounts' })) as string[];
  if (!address) throw new Error('The wallet gave no address.');
  return proveAddress(api, address, async (message) => (await e.request({ method: 'personal_sign', params: [hex(message), address] })) as string);
}

/** Whether this build can offer Google / passkey sign-in (it needs a thirdweb client id). */
export const socialAvailable = (): boolean => !!(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_THIRDWEB_CLIENT_ID;

/**
 * Sign in without a wallet app: a Google account or a passkey makes an embedded wallet (thirdweb), which signs the same
 * nonce. That wallet holds no stake money here: staking still needs MiniPay or another wallet. Loaded on tap.
 */
export async function signInSocial(api: string, how: 'google' | 'passkey'): Promise<Account> {
  const { connectSocial } = await import('./social');
  const w = await connectSocial(how);
  return proveAddress(api, w.address, w.sign);
}

/** The server's challenge: it hands over a nonce, the wallet signs the sign-in message holding it, the server checks and gives a token. */
async function proveAddress(api: string, address: string, sign: (message: string) => Promise<string>): Promise<Account> {
  const n = await post<{ nonce: string }>(api, '/auth/nonce', { address });
  const message = `Zombie Plague sign-in\nnonce: ${n.nonce}`;
  const signature = await sign(message);
  const v = await post<{ token: string; account: { address: string; name: string | null } }>(api, '/auth/verify', { address, signature });
  const acc: Account = { token: v.token, address: v.account.address, name: v.account.name };
  try { localStorage.setItem(KEY, JSON.stringify(acc)); } catch { /* signed in for this page only */ }
  return acc;
}

async function post<T>(api: string, path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(`${api}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status === 401 ? 'Signature not accepted.' : r.status === 429 ? 'Slow down.' : `Server said ${r.status}.`);
  return (await r.json()) as T;
}

export const apiBase = (): string => {
  const q = new URLSearchParams(location.search).get('server');
  const ws = q ?? (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_SERVER_URL ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787`;
  return ws.replace(/^ws/, 'http');
};

/** Send a finished night to the server, which replays it before believing it. Fire and forget: a failure only means it is not on the board. */
export async function uploadRun(r: RunResult): Promise<{ replayOk: boolean; score?: number; parts?: Record<string, number> } | null> {
  const acc = account();
  if (!acc) return null;
  try {
    return await post<{ replayOk: boolean; score?: number; parts?: Record<string, number> }>(apiBase(), '/runs', {
      result: { seed: r.seed, chapter: r.chapter, outcome: r.outcome, lossReason: r.lossReason, secondsLeft: r.secondsLeft, replay: r.replay },
    }, acc.token);
  } catch { return null; }
}

/** Where this account's last self is waiting in a chapter (the server's word, not the device's). */
export async function lastSelfFromServer(chapter: number): Promise<Husk | null> {
  const acc = account();
  if (!acc) return null;
  try {
    const r = await fetch(`${apiBase()}/last-self?chapter=${chapter}`, { headers: { authorization: `Bearer ${acc.token}` } });
    if (!r.ok) return null;
    const j = (await r.json()) as { husk: { pos: { x: number; y: number }; weapon: Husk['weapon'] } | null };
    return j.husk;
  } catch { return null; }
}

/** Tonight's night (everyone plays the same city on a day), if the server can be reached and runs this content. */
export async function tonight(version: number): Promise<number | null> {
  try {
    const r = await fetch(`${apiBase()}/night/today`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { night: number; content: number };
    return j.content === version ? j.night >>> 0 : null;
  } catch { return null; }
}
