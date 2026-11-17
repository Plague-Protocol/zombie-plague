// The operator's page (/admin on the site, listed in the nav for admins). Like plague-celo's /admin: server health, players, live rooms,
// the stake contracts (gas, fees, paused), settlements, and the accounts whose replays fail. Who may see it is
// decided by the server (a signed-in wallet in ADMIN_ADDRESSES, or one holding a contract's admin role). Pausing a
// contract and taking the fees out are sent from the admin's own wallet straight to the contracts.
import { account, apiBase, signIn } from './account';

interface Overview {
  you: string;
  server: { uptimeS: number; rssMb: number; db: string; content: number; node: string };
  players: { accounts: number; runs: number; runs24h: number; failed24h: number; accounts24h: number; rounds24h: number };
  rooms: Array<{ code: string; state: string; seats: number; connected: number; stack: string | null; onChain: string | null; elapsedS: number }>;
  stacks: Array<{ symbol: string; rooms?: string; paused?: boolean; feeManager?: string; fees?: string; held?: string; roomCount?: string; gas?: string; error?: string }>;
  settlements: Array<{ roomId: string; winners: string[]; status: string; tx: string | null; error: string | null }>;
  suspicious: Array<{ address: string; name: string | null; failed: number; ok: number }>;
}

const CSS = `
#admin { position: fixed; inset: 0; z-index: 50; overflow-y: auto; background: #050806; color: #d4c9b2; font: 15px/1.4 system-ui, sans-serif; padding: 16px; }
#admin h1 { margin: 0 0 4px; font: 400 34px 'Eater', system-ui, sans-serif; color: #e8e0cc; }
#admin .sub { color: #7a8a72; margin-bottom: 12px; word-break: break-all; }
#admin .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
#admin .card { border: 1px solid #23361d; border-radius: 10px; padding: 12px; background: #0b130a; }
#admin .card h3 { margin: 0 0 8px; font-size: 13px; letter-spacing: .14em; text-transform: uppercase; color: #a8c46a; }
#admin .kv { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; border-bottom: 1px dashed #17240f; }
#admin .kv b { font-weight: 600; color: #e8e0cc; text-align: right; word-break: break-all; }
#admin .warn { color: #f2b630; } #admin .bad { color: #e0483a; } #admin .good { color: #8fd16a; }
#admin table { width: 100%; border-collapse: collapse; font-size: 13px; }
#admin td, #admin th { text-align: left; padding: 4px 6px; border-bottom: 1px solid #17240f; vertical-align: top; word-break: break-all; }
#admin th { color: #7a8a72; font-weight: 500; }
#admin button { font: inherit; font-size: 13px; padding: 4px 10px; border-radius: 6px; border: 1px solid #6b8e23; background: #6b8e23; color: #060b06; cursor: pointer; margin: 4px 4px 0 0; }
#admin button.ghost { background: transparent; color: #a8c46a; }
#admin button.danger { background: #8a1f17; border-color: #8a1f17; color: #fff; }
#admin button:disabled { opacity: .4; }
#admin .wide { grid-column: 1 / -1; }
#admin .msg { margin: 8px 0; color: #f2b630; min-height: 1.2em; }
#admin.inpage > h1 { display: none; }
#admin.inpage { position: static; inset: auto; z-index: auto; overflow: visible; background: transparent; padding: 0; }
`;

const el = (tag: string, text = '', cls = '') => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const units = (wei: string | undefined, decimals: number) => {
  if (wei === undefined) return '?';
  const v = BigInt(wei), d = 10n ** BigInt(decimals);
  return `${v / d}.${(v % d).toString().padStart(decimals, '0').slice(0, 4)}`;
};
const ago = (s: number) => (s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

/** The admin page, inside `parent` (a site page), or over everything. */
export function openAdmin(parent?: HTMLElement): void {
  if (!document.getElementById('admin-css')) { const st = el('style'); st.id = 'admin-css'; st.textContent = CSS; document.head.appendChild(st); }
  const root = el('div'); root.id = 'admin';
  if (parent) root.className = 'inpage';
  (parent ?? document.body).appendChild(root);
  let msg = '';
  let decimals: Record<string, number> = {};
  void import('./stake').then((m) => { decimals = Object.fromEntries(m.stakeConfigs().map((c) => [c.symbol, c.decimals])); });

  async function call<T>(method: 'GET' | 'POST', path: string): Promise<T | number> {
    const me = account();
    const r = await fetch(`${apiBase()}${path}`, { method, headers: me ? { authorization: `Bearer ${me.token}` } : {} });
    return r.ok ? ((await r.json()) as T) : r.status;
  }

  const kv = (k: string, v: string, cls = '') => { const row = el('div', '', 'kv'); row.append(el('span', k)); const b = el('b', v); if (cls) b.className = cls; row.append(b); return row; };
  const card = (title: string, wide = false) => { const c = el('div', '', `card${wide ? ' wide' : ''}`); c.append(el('h3', title)); return c; };
  const act = async (label: string, f: () => Promise<unknown>) => { msg = `${label}…`; await draw(false); try { await f(); msg = `${label}: done.`; } catch (e) { msg = `${label}: ${e instanceof Error ? e.message : 'failed'}`; } await draw(); };

  async function draw(fetchIt = true): Promise<void> {
    const data = fetchIt ? await call<Overview>('GET', '/admin/overview').catch(() => 0) : last;
    root.replaceChildren(el('h1', 'Admin'));
    if (typeof data === 'number' || !data) {
      const why = data === 403 ? (account() ? 'This wallet is not an admin.' : 'Sign in with an admin wallet.') : 'The server is not answering.';
      root.append(el('div', why, 'sub'));
      if (!account() && (window as unknown as { ethereum?: unknown }).ethereum) {
        const b = el('button', 'Sign in with wallet'); b.onclick = () => void signIn(apiBase()).then(() => draw(), (e: Error) => { msg = e.message; void draw(false); }); root.append(b);
      }
      root.append(el('div', msg, 'msg'));
      return;
    }
    last = data;
    const o = data;
    root.append(el('div', `Signed in as ${o.you}`, 'sub'));
    const top = el('div');
    const refresh = el('button', 'Refresh', 'ghost'); refresh.onclick = () => void draw();
    const back = el('button', 'Close', 'ghost'); back.onclick = () => root.remove();
    top.append(refresh, ...(parent ? [] : [back]), el('div', msg, 'msg'));
    root.append(top);
    const grid = el('div', '', 'grid');
    root.append(grid);

    const srv = card('Server');
    srv.append(kv('Up', ago(o.server.uptimeS)), kv('Memory', `${o.server.rssMb} MB`, o.server.rssMb > 400 ? 'warn' : ''), kv('Database', o.server.db, o.server.db === 'memory' ? 'warn' : 'good'), kv('Content', `v${o.server.content}`), kv('Node', o.server.node));
    const pl = card('Players');
    pl.append(kv('Accounts', `${o.players.accounts} (+${o.players.accounts24h} today)`), kv('Runs', `${o.players.runs} (${o.players.runs24h} today)`),
      kv('Failed replays today', String(o.players.failed24h), o.players.failed24h ? 'warn' : 'good'), kv('Room rounds today', String(o.players.rounds24h)), kv('Rooms live', String(o.rooms.length)));
    grid.append(srv, pl);

    for (const s of o.stacks) {
      const c = card(`Stake contract · ${s.symbol}`);
      if (s.error) { c.append(kv('Error', s.error, 'bad')); grid.append(c); continue; }
      const dec = decimals[s.symbol] ?? 18;
      const gas = Number(BigInt(s.gas ?? '0') / 10n ** 14n) / 1e4;
      c.append(kv('Contract', s.rooms ?? '?'), kv('State', s.paused ? 'PAUSED' : 'open', s.paused ? 'bad' : 'good'), kv('Rooms created', s.roomCount ?? '?'),
        kv('Held in escrow', `${units(s.held, dec)} ${s.symbol}`), kv('Fees collected', `${units(s.fees, dec)} ${s.symbol}`),
        kv('Settle key gas', `${gas} CELO`, gas < 0.5 ? 'bad' : gas < 2 ? 'warn' : 'good'));
      const cfg = { chainId: Number((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CHAIN_ID ?? 42220) };
      const p = el('button', s.paused ? 'Unpause' : 'Pause new rooms', s.paused ? '' : 'danger');
      p.onclick = () => { if (s.paused || confirm(`Pause ${s.symbol} rooms? Nobody can create or join until unpaused. Rooms already started still settle.`)) void act(s.paused ? 'Unpause' : 'Pause', async () => (await import('./stake')).adminTx(cfg, s.rooms!, s.paused ? 'unpause' : 'pause')); };
      const w = el('button', 'Withdraw fees to this wallet', 'ghost');
      w.onclick = () => { if (confirm(`Send all ${units(s.fees, dec)} ${s.symbol} of fees to ${o.you}?`)) void act('Withdraw fees', async () => (await import('./stake')).adminTx(cfg, s.feeManager!, 'withdrawAll', o.you)); };
      c.append(p, w);
      grid.append(c);
    }
    if (!o.stacks.length) { const c = card('Stake contracts'); c.append(el('div', 'Staked rooms are off on this server (STAKED=false).')); grid.append(c); }

    const rooms = card('Live rooms', true);
    if (!o.rooms.length) rooms.append(el('div', 'None.'));
    else {
      const t = el('table'); t.innerHTML = '<tr><th>Room</th><th>State</th><th>Seats</th><th>Time</th><th></th></tr>';
      for (const r of o.rooms) {
        const tr = el('tr');
        tr.append(el('td', r.onChain ? `${r.stack} #${r.onChain}` : r.code), el('td', r.state), el('td', `${r.connected}/${r.seats}`), el('td', r.state === 'playing' ? ago(r.elapsedS) : ''));
        const td = el('td'); const b = el('button', 'Close', 'danger');
        b.onclick = () => { if (confirm(`Close ${r.code}? Everyone in it is sent back.${r.onChain ? ' A started staked room is not paid by closing it: its players reclaim after the window.' : ''}`)) void act(`Close ${r.code}`, () => call('POST', `/admin/rooms/${encodeURIComponent(r.code)}/close`)); };
        td.append(b); tr.append(td); t.append(tr);
      }
      rooms.append(t);
    }
    grid.append(rooms);

    const st = card('Settlements (latest 50)', true);
    if (!o.settlements.length) st.append(el('div', 'None yet.'));
    else {
      const t = el('table'); t.innerHTML = '<tr><th>Room</th><th>Status</th><th>Winners</th><th>Transaction / error</th><th></th></tr>';
      for (const s of o.settlements) {
        const tr = el('tr');
        tr.append(el('td', s.roomId), el('td', s.status, s.status === 'done' ? 'good' : s.status === 'failed' ? 'bad' : 'warn'), el('td', String(s.winners.length)), el('td', s.tx ?? s.error ?? ''));
        const td = el('td');
        if (s.status !== 'done') { const b = el('button', 'Retry'); b.onclick = () => void act(`Retry ${s.roomId}`, () => call('POST', `/admin/settlements/${encodeURIComponent(s.roomId)}/retry`)); td.append(b); }
        tr.append(td); t.append(tr);
      }
      st.append(t);
    }
    grid.append(st);

    const sus = card('Failed replays, last 7 days', true);
    if (!o.suspicious.length) sus.append(el('div', 'None. Every run sent in replayed to what it claimed.'));
    else {
      const t = el('table'); t.innerHTML = '<tr><th>Account</th><th>Failed</th><th>Replayed</th></tr>';
      for (const x of o.suspicious) { const tr = el('tr'); tr.append(el('td', x.name ? `${x.name} (${x.address})` : x.address), el('td', String(x.failed), 'warn'), el('td', String(x.ok))); t.append(tr); }
      sus.append(t, el('div', 'A failed replay is a run whose log does not end the way the player said: a modified client, or a bug. Several from one account is worth a look.', 'sub'));
    }
    grid.append(sus);
  }
  let last: Overview | null = null;
  void draw();
}
