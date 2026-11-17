// Buying armoury cash with USDm. There is no contract: the player sends the token to the treasury with a plain
// transfer from the wallet they signed in with, and hands the server the transaction. The server reads the receipt
// from the chain itself and credits cash only for a mined, successful Transfer of the configured token, from that
// account's address, to the treasury. The ledger's (account, 'topup', tx) key makes a transaction count once.
import { createPublicClient, erc20Abi, http, parseEventLogs, type Hex, type Log } from 'viem';

export interface TopupConfig { token: string; treasury: string; decimals: number; rate: number; symbol: string; chainId: number }
/** The fewest token units a top-up may be (a tenth of a token). */
export const minUnits = (c: TopupConfig): bigint => 10n ** BigInt(c.decimals) / 10n;
/** Cash for an amount of the token: `rate` per whole token, rounded down. */
export const cashFor = (c: TopupConfig, units: bigint): number => Number((units * BigInt(c.rate)) / 10n ** BigInt(c.decimals));

/** Reads a transaction's receipt (null if it is not mined, or not there). */
export type ReceiptReader = (tx: Hex) => Promise<{ status: 'success' | 'reverted'; logs: Log[] } | null>;
export function rpcReceipts(rpc: string): ReceiptReader {
  const client = createPublicClient({ transport: http(rpc, { retryCount: 2 }) });
  return async (tx) => { try { return await client.getTransactionReceipt({ hash: tx }); } catch { return null; } };
}

/** What a transaction paid the treasury from `address`, in token units, or why it does not count. */
export async function verifyTopup(read: ReceiptReader, c: TopupConfig, address: string, tx: Hex): Promise<{ units: bigint; cash: number } | { error: string }> {
  const rc = await read(tx);
  if (!rc) return { error: 'That transaction is not on the chain yet. Try again in a moment.' };
  if (rc.status !== 'success') return { error: 'That transaction failed on the chain.' };
  const me = address.toLowerCase(), token = c.token.toLowerCase(), treasury = c.treasury.toLowerCase();
  let units = 0n;
  for (const l of parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: rc.logs, strict: false })) {
    if (l.address.toLowerCase() !== token || !l.args.from || !l.args.to || l.args.value === undefined) continue;
    if (l.args.from.toLowerCase() === me && l.args.to.toLowerCase() === treasury) units += l.args.value;
  }
  if (units === 0n) return { error: `That transaction did not send ${c.symbol} from your wallet to the armoury.` };
  if (units < minUnits(c)) return { error: `The least a top-up can be is 0.1 ${c.symbol}.` };
  return { units, cash: cashFor(c, units) };
}
