// Promotions across the site (bounties, prizes, deals, news), a deal's extra ZP on top-ups, and granting ZP.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex, type Log } from 'viem';
import { makeServer, wallet } from './helpers.ts';
import { registerAdmin } from '../src/admin.ts';
import { Hub } from '../src/rooms.ts';
import type { ReceiptReader, TopupConfig } from '../src/topup.ts';

const TOKEN = '0x6a7fe8a1b3e7ae33ac0723e7eadabd79dc5230f8', TREASURY = '0x1111111111111111111111111111111111111111';
const config: TopupConfig = { token: TOKEN, treasury: TREASURY, decimals: 18, rate: 1000, symbol: 'USDm', chainId: 11142220 };
const transfer = (from: string, value: bigint): Log => ({
  address: TOKEN as Hex, data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: from as Hex, to: TREASURY as Hex } }) as [Hex, ...Hex[]],
  blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
});
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

async function world() {
  const receipts = new Map<string, Awaited<ReturnType<ReceiptReader>>>();
  const s = await makeServer({ topup: { config, read: async (tx: string) => receipts.get(tx) ?? null } } as never);
  const boss = wallet(), player = wallet();
  registerAdmin(s.app, { store: s.store, auth: s.auth, hub: new Hub({ contentVersion: () => 1 }), chains: {}, admins: [boss.account.address.toLowerCase()], startedAt: Date.now(), db: 'memory', content: () => 1 });
  const bt = (await boss.signIn(s.app)).body.token, p = (await player.signIn(s.app)).body;
  const as = (t: string | null) => (method: 'GET' | 'POST', url: string, payload?: unknown) => s.app.inject({ method, url, payload: payload as never, headers: t ? { authorization: `Bearer ${t}` } : {} });
  return { s, receipts, player, admin: as(bt), me: as(p.token), anon: as(null), playerId: p.account.id };
}
const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe('promotions', () => {
  it('an admin makes one, the site shows it while it runs, and ending it takes it down; nobody else can', async () => {
    const w = await world();
    expect((await w.me('POST', '/admin/promos', { kind: 'news', title: 'Hello', endsAt: soon(1) })).statusCode).toBe(403);
    const bad = await w.admin('POST', '/admin/promos', { kind: 'prize', title: 'Win', endsAt: soon(1), topupBonus: 50 });
    expect(bad.json().error).toMatch(/only a deal/);
    expect((await w.admin('POST', '/admin/promos', { kind: 'news', title: 'Old', endsAt: soon(-1) })).statusCode).toBe(400);
    expect((await w.admin('POST', '/admin/promos', { kind: 'bounty', title: 'Link', endsAt: soon(1), cta: { label: 'Go', href: 'javascript:alert(1)' } })).statusCode).toBe(400);
    const made = await w.admin('POST', '/admin/promos', { kind: 'bounty', title: 'First to get out of the docks', body: '5,000 ZP to the first escape tonight', endsAt: soon(24), cta: { label: 'Play', href: '/play' } });
    expect(made.statusCode).toBe(200);
    await w.admin('POST', '/admin/promos', { kind: 'news', title: 'Later', startsAt: soon(5), endsAt: soon(6) }); // not started yet
    const live = (await w.anon('GET', '/promos')).json();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ kind: 'bounty', title: 'First to get out of the docks', cta: { label: 'Play', href: '/play' } });
    await w.admin('POST', `/admin/promos/${made.json().id}/end`);
    expect((await w.anon('GET', '/promos')).json()).toHaveLength(0);
    expect((await w.admin('GET', '/admin/promos')).json()).toHaveLength(2);
  });

  it('a running deal pays its share on top of every top-up, on top of the first-top-up double', async () => {
    const w = await world();
    await w.admin('POST', '/admin/promos', { kind: 'deal', title: '+50% ZP this weekend', endsAt: soon(48), topupBonus: 50 });
    const view = (await w.me('GET', '/armoury')).json();
    expect(view.topup.deal).toMatchObject({ bonus: 50, title: '+50% ZP this weekend' });
    w.receipts.set(hash(1), { status: 'success', logs: [transfer(w.player.account.address, 10n ** 18n)] });
    const r = (await w.me('POST', '/armoury/topup', { tx: hash(1) })).json();
    expect(r).toMatchObject({ credited: 1000 + 1000 + 500, bonus: 1500, cash: 2500 });
    w.receipts.set(hash(2), { status: 'success', logs: [transfer(w.player.account.address, 10n ** 18n)] });
    expect((await w.me('POST', '/armoury/topup', { tx: hash(2) })).json()).toMatchObject({ credited: 1500, cash: 4000 });
  });
});

describe('granting ZP', () => {
  it('an admin gives ZP by wallet address or name; a stranger cannot', async () => {
    const w = await world();
    await w.s.store.setName(w.playerId, 'Tolu');
    expect((await w.me('POST', '/admin/grant', { to: 'Tolu', amount: 500, note: 'tester' })).statusCode).toBe(403);
    expect((await w.admin('POST', '/admin/grant', { to: 'tolu', amount: 500, note: 'tester' })).json()).toMatchObject({ to: 'Tolu', amount: 500, balance: 500 });
    expect((await w.admin('POST', '/admin/grant', { to: w.player.account.address, amount: 250, note: 'bounty' })).json().balance).toBe(750);
    expect((await w.admin('POST', '/admin/grant', { to: 'nobody', amount: 1, note: 'x1' })).statusCode).toBe(404);
  });
});
