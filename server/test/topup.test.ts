import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex, type Log } from 'viem';
import { makeServer, wallet } from './helpers.ts';
import type { ReceiptReader, TopupConfig } from '../src/topup.ts';

const TOKEN = '0x6a7fe8a1b3e7ae33ac0723e7eadabd79dc5230f8', TREASURY = '0x1111111111111111111111111111111111111111';
const config: TopupConfig = { token: TOKEN, treasury: TREASURY, decimals: 18, rate: 500, symbol: 'USDm', chainId: 11142220 };
const ONE = 10n ** 18n;
const transfer = (token: string, from: string, to: string, value: bigint): Log => ({
  address: token as Hex, data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Hex, to: to as Hex } }) as [Hex, ...Hex[]],
  blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
});
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

async function setup() {
  const receipts = new Map<string, Awaited<ReturnType<ReceiptReader>>>();
  const read: ReceiptReader = async (tx) => receipts.get(tx) ?? null;
  const s = await makeServer({ topup: { config, read } } as never);
  const w = wallet();
  const { body } = await w.signIn(s.app);
  const me = w.account.address;
  const post = (tx: string) => s.app.inject({ method: 'POST', url: '/armoury/topup', headers: { authorization: `Bearer ${body.token}` }, payload: { tx } });
  return { ...s, receipts, me, post, token: body.token };
}

describe('top-ups in USDm', () => {
  it('credits a mined transfer from your wallet to the treasury, once', async () => {
    const t = await setup();
    t.receipts.set(hash(1), { status: 'success', logs: [transfer(TOKEN, t.me, TREASURY, 3n * ONE)] });
    const before = (await t.app.inject({ method: 'GET', url: '/armoury', headers: { authorization: `Bearer ${t.token}` } })).json();
    expect(before.topup.firstBonus).toBe(true);
    const r = await t.post(hash(1));
    expect(r.statusCode).toBe(200);
    expect(r.json().credited).toBe(3000); // the first top-up is paid double
    expect(r.json().bonus).toBe(1500);
    expect(r.json().cash).toBe(3000);
    expect(r.json().topup.firstBonus).toBe(false);
    expect((await t.post(hash(1))).statusCode).toBe(409); // the same transaction twice
    t.receipts.set(hash(9), { status: 'success', logs: [transfer(TOKEN, t.me, TREASURY, ONE)] });
    const again = await t.post(hash(9));
    expect(again.json()).toMatchObject({ credited: 500, bonus: 0, cash: 3500 }); // the second is not
    const view = (await t.app.inject({ method: 'GET', url: '/armoury', headers: { authorization: `Bearer ${t.token}` } })).json();
    expect(view.topup).toMatchObject({ token: TOKEN, treasury: TREASURY, rate: 500, symbol: 'USDm' });
  });

  it('refuses a transfer that is not yours, not to the treasury, in another token, failed, unmined, or too small', async () => {
    const t = await setup();
    const other = '0x2222222222222222222222222222222222222222';
    const cases: Array<[number, Awaited<ReturnType<ReceiptReader>>, RegExp]> = [
      [2, { status: 'success', logs: [transfer(TOKEN, other, TREASURY, ONE)] }, /did not send/],
      [3, { status: 'success', logs: [transfer(TOKEN, t.me, other, ONE)] }, /did not send/],
      [4, { status: 'success', logs: [transfer(other, t.me, TREASURY, ONE)] }, /did not send/],
      [5, { status: 'reverted', logs: [] }, /failed/],
      [6, null, /not on the chain/],
      [7, { status: 'success', logs: [transfer(TOKEN, t.me, TREASURY, ONE / 20n)] }, /least/],
    ];
    for (const [n, rc, why] of cases) {
      if (rc) t.receipts.set(hash(n), rc);
      const r = await t.post(hash(n));
      expect(r.statusCode, String(n)).toBe(400);
      expect(r.json().error, String(n)).toMatch(why);
    }
    expect((await t.post('0x1234')).statusCode).toBe(400);
  });

  it('is off without a token configured', async () => {
    const s = await makeServer();
    const w = wallet();
    const { body } = await w.signIn(s.app);
    expect((await s.app.inject({ method: 'POST', url: '/armoury/topup', headers: { authorization: `Bearer ${body.token}` }, payload: { tx: hash(1) } })).statusCode).toBe(404);
    expect((await s.app.inject({ method: 'GET', url: '/armoury', headers: { authorization: `Bearer ${body.token}` } })).json().topup).toBeNull();
  });
});
