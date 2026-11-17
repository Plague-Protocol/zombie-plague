// The admin page's wallet acts (web/src/net/stake.ts adminTx) against a real contract, with a stand-in wallet holding the
// admin key: pause, unpause, take the fees. Use the TEST stack only.
//   RPC=... PROXY=0x... ADMIN_KEY=0x... npx tsx tools/sepolia-admin-check.mts
import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { adminTx } from '../../web/src/net/stake.ts';
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`set ${k}`); return v; };
const RPC = env('RPC'), PROXY = env('PROXY') as Hex, KEY = env('ADMIN_KEY') as Hex;
const chain = { id: 11142220, name: 'celo-sepolia', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
const w = createWalletClient({ account: privateKeyToAccount(KEY), chain, transport: http(RPC) });
(globalThis as unknown as { window: unknown }).window = { ethereum: { request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
  if (method === 'eth_requestAccounts') return [w.account.address];
  if (method === 'eth_chainId') return '0xaa044c';
  if (method === 'eth_sendTransaction') { const [tx] = params as [{ to: Hex; data: Hex }]; return w.sendTransaction({ to: tx.to, data: tx.data }); }
  if (method === 'eth_getTransactionReceipt') { try { const r = await pub.getTransactionReceipt({ hash: params[0] as Hex }); return { status: r.status === 'success' ? '0x1' : '0x0', logs: [] }; } catch { return null; } }
  throw new Error(method);
} } };
const abi = parseAbi(['function paused() view returns (bool)', 'function feeManager() view returns (address)', 'function token() view returns (address)', 'function balance() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const read = async <T,>(address: Hex, fn: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName: fn as never, args: args as never }) as Promise<T>;
const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 20 && !(await f()); i++) await new Promise((r) => setTimeout(r, 1000)); return f(); };
const ok = (c: boolean, m: string) => { if (!c) throw new Error('FAILED: ' + m); console.log('  ok:', m); };
const cfg = { chainId: 11142220 };
await adminTx(cfg, PROXY, 'pause');
ok(await until(async () => read<boolean>(PROXY, 'paused')), 'paused from the admin wallet');
await adminTx(cfg, PROXY, 'unpause');
ok(await until(async () => !(await read<boolean>(PROXY, 'paused'))), 'unpaused');
const fm = await read<Hex>(PROXY, 'feeManager'), token = await read<Hex>(PROXY, 'token');
const fees = await read<bigint>(fm, 'balance'), before = await read<bigint>(token, 'balanceOf', [w.account.address]);
await adminTx(cfg, fm, 'withdrawAll', w.account.address);
ok(await until(async () => (await read<bigint>(token, 'balanceOf', [w.account.address])) === before + fees), `fees withdrawn to the admin wallet (${fees} units)`);
ok((await read<bigint>(fm, 'balance')) === 0n, 'the fee contract is empty');
process.exit(0);
