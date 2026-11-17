// The guest's allowance runs out: the game waits behind this until the player signs in. Loaded only then.
import { apiBase, signIn, signInSocial, socialAvailable } from './account';

const CSS = `
#gate { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px;
  background: rgba(4,6,10,.95); font-family: 'VT323', monospace; color: #d4c9b2; text-align: center; padding: 24px; }
#gate h2 { margin: 0; font-family: 'Eater', system-ui, sans-serif; font-weight: 400; font-size: clamp(30px, 7vw, 54px); letter-spacing: .05em; text-shadow: 0 0 24px rgba(230,51,41,.45); }
#gate p { margin: 0; max-width: 34em; font-size: 20px; line-height: 1.3; color: #a9b79a; }
#gate button { font: inherit; font-size: 22px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; padding: 8px 26px; border: 2px solid #6b8e23;
  border-radius: 6px; background: #6b8e23; color: #060b06; cursor: pointer; min-width: 14em; }
#gate button.ghost { background: transparent; color: #a8c46a; }
#gate button:disabled { opacity: .4; cursor: default; }
#gate .err { color: #e0483a; min-height: 1.2em; }
#gate small { color: #6f7d68; font-size: 16px; }
`;

/** Cover the game until a sign-in succeeds, then call `done`. */
export function showGate(done: () => void): void {
  if (document.getElementById('gate')) return;
  if (!document.getElementById('gate-css')) { const st = document.createElement('style'); st.id = 'gate-css'; st.textContent = CSS; document.head.appendChild(st); }
  const root = document.createElement('div');
  root.id = 'gate';
  const h = document.createElement('h2'); h.textContent = 'It is in your blood now';
  const p = document.createElement('p');
  p.textContent = 'That was your free taste. Sign in to keep playing: your nights count on the leaderboard, your last self waits for you where you fell, and multiplayer opens.';
  const err = document.createElement('div'); err.className = 'err';
  root.append(h, p);
  const go = (label: string, how: () => Promise<unknown>, ghost = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (ghost) b.className = 'ghost';
    b.onclick = async () => {
      for (const x of root.querySelectorAll('button')) (x as HTMLButtonElement).disabled = true;
      err.textContent = '';
      try { await how(); root.remove(); done(); }
      catch (e) { err.textContent = e instanceof Error ? e.message.slice(0, 140) : 'Sign-in failed.'; for (const x of root.querySelectorAll('button')) (x as HTMLButtonElement).disabled = false; }
    };
    root.append(b);
  };
  const wallet = !!(window as unknown as { ethereum?: unknown }).ethereum;
  if (wallet) go('Sign in with wallet', () => signIn(apiBase()));
  if (socialAvailable()) {
    go('Sign in with Google', () => signInSocial(apiBase(), 'google'), wallet);
    go('Sign in with a passkey', () => signInSocial(apiBase(), 'passkey'), true);
  }
  if (!wallet && !socialAvailable()) { const n = document.createElement('p'); n.textContent = 'Open the game in MiniPay or a wallet browser to sign in.'; root.append(n); }
  const s = document.createElement('small'); s.textContent = 'Free. No payment is asked for to sign in.';
  root.append(err, s);
  document.body.appendChild(root);
}
