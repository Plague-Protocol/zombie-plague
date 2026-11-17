// Sign-in: the wallet signs a message with a nonce the server just gave it, the server checks the signature,
// and hands back a token. No passwords, no sessions to store: the token says which account it is.
import { SignJWT, jwtVerify } from 'jose';
import { createPublicClient, http, verifyMessage, type Hex } from 'viem';
import { isAddress } from 'viem';

export const NONCE_TTL_MS = 5 * 60_000;
export const TOKEN_TTL = '7d';

/** The exact text a wallet signs. */
export const signInMessage = (nonce: string) => `Zombie Plague sign-in\nnonce: ${nonce}`;

/**
 * Checks that `signature` is `address` signing `message`. With an RPC it also accepts smart-contract wallets
 * (ERC-1271, and ERC-6492 for ones not deployed yet), which is what thirdweb's in-app wallets may be; without
 * one, only plain wallets. The viem call is the same either way.
 */
export type SignatureChecker = (address: string, message: string, signature: string) => Promise<boolean>;

export function makeSignatureChecker(rpc?: string): SignatureChecker {
  const client = rpc ? createPublicClient({ transport: http(rpc) }) : null;
  return async (address, message, signature) => {
    if (!isAddress(address)) return false;
    try {
      return client
        ? await client.verifyMessage({ address, message, signature: signature as Hex })
        : await verifyMessage({ address, message, signature: signature as Hex });
    } catch { return false; }
  };
}

export class Auth {
  private nonces = new Map<string, { nonce: string; at: number }>();
  private key: Uint8Array;

  constructor(secret: string, private check: SignatureChecker, private now: () => number = Date.now) {
    this.key = new TextEncoder().encode(secret);
  }

  /** A fresh nonce for an address (one at a time: asking again replaces it). */
  nonce(address: string): string {
    const n = globalThis.crypto.randomUUID().replaceAll('-', '');
    this.nonces.set(address.toLowerCase(), { nonce: n, at: this.now() });
    for (const [k, v] of this.nonces) if (this.now() - v.at > NONCE_TTL_MS) this.nonces.delete(k); // forget the old ones
    return n;
  }

  /** The token, if the signature is the address signing its current nonce. A nonce works once. */
  async verify(address: string, signature: string, accountId: (address: string) => Promise<string>): Promise<string | null> {
    const a = address.toLowerCase();
    const n = this.nonces.get(a);
    if (!n || this.now() - n.at > NONCE_TTL_MS) return null;
    this.nonces.delete(a);
    if (!(await this.check(address, signInMessage(n.nonce), signature))) return null;
    return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(await accountId(a)).setIssuedAt().setExpirationTime(TOKEN_TTL).sign(this.key);
  }

  /** The account id a token is for, or null. */
  async accountOf(token: string | null | undefined): Promise<string | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      return payload.sub ?? null;
    } catch { return null; }
  }
}
