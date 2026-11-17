// Google / passkey sign-in through thirdweb's embedded wallet. A separate chunk: only ever fetched when a player taps
// "Sign in with Google", so it costs the first load nothing.
import { createThirdwebClient } from 'thirdweb';
import { inAppWallet } from 'thirdweb/wallets';

export interface Social { address: string; sign(message: string): Promise<string> }

export async function connectSocial(how: 'google' | 'passkey'): Promise<Social> {
  const clientId = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_THIRDWEB_CLIENT_ID;
  if (!clientId) throw new Error('Sign-in is not set up in this build.');
  const client = createThirdwebClient({ clientId });
  const wallet = inAppWallet();
  const account = how === 'google'
    ? await wallet.connect({ client, strategy: 'google' })
    : await wallet.connect({ client, strategy: 'passkey', type: (localStorage.getItem('zp.passkey') ? 'sign-in' : 'sign-up') });
  if (how === 'passkey') { try { localStorage.setItem('zp.passkey', '1'); } catch { /* sign-up again next time is harmless: it signs in */ } }
  return { address: account.address, sign: (message) => account.signMessage({ message }) };
}
