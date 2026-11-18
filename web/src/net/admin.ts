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
#admin { position: fixed; inset: 0; z-index: 50; overflow-y: auto; background: #050806; color: #d4c9b2; font: 15px/1.45 system-ui, sans-serif; padding: 16px; }
#admin h1 { margin: 0 0 4px; font: 400 34px 'Eater', system-ui, sans-serif; color: #e8e0cc; }
#admin .ad-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 18px; }
#admin .ad-pill { display: inline-block; max-width: 100%; font: 17px 'VT323', monospace; letter-spacing: .08em; padding: 3px 12px; border-radius: 999px;
  border: 1px solid rgba(107,142,35,.35); background: rgba(10,16,10,.8); color: #a0bb94; }
#admin .ad-pill i { display: inline-block; vertical-align: 1px; margin-right: 8px; width: 8px; height: 8px; border-radius: 50%; background: #84cc16; box-shadow: 0 0 8px #84cc16; }
#admin .ad-pill.mem i { background: #f2b630; box-shadow: 0 0 8px #f2b630; }
#admin .ad-pill b { color: #e8e0cc; font-weight: 400; }
#admin .ad-bar .grow { flex: 1; }
#admin .ad-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 14px; }
#admin .ad-kpi { border: 1px solid rgba(107,142,35,.22); border-radius: 12px; padding: 12px 14px; background: linear-gradient(180deg, #0d150d, #080d08); }
#admin .ad-kpi .k { font: 15px 'VT323', monospace; letter-spacing: .2em; text-transform: uppercase; color: #6b8e23; }
#admin .ad-kpi b { display: block; font: 400 34px/1.1 'VT323', monospace; color: #e8e0cc; }
#admin .ad-kpi small { color: #7d9a72; font-size: 13px; }
#admin .ad-kpi.warn b { color: #f2b630; } #admin .ad-kpi.bad b { color: #ff6b5e; }
#admin .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
#admin .card { border: 1px solid rgba(107,142,35,.22); border-radius: 14px; padding: 16px 18px; background: linear-gradient(180deg, #0d150d, #080d08); min-width: 0; }
#admin .card h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font: 16px 'VT323', monospace; letter-spacing: .22em; text-transform: uppercase; color: #84cc16; }
#admin .card h3 .n { margin-left: auto; font-size: 15px; letter-spacing: .1em; color: #7d9a72; }
#admin .kv { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid rgba(107,142,35,.1); }
#admin .kv:last-of-type { border-bottom: 0; }
#admin .kv span { color: #8fa785; }
#admin .kv b { font-weight: 600; color: #e8e0cc; text-align: right; word-break: break-all; font-variant-numeric: tabular-nums; }
#admin .warn { color: #f2b630 !important; } #admin .bad { color: #ff6b5e !important; } #admin .good { color: #9be15d !important; }
#admin .ad-tbl { overflow-x: auto; margin: 0 -6px; }
#admin table { width: 100%; border-collapse: collapse; font-size: 14px; }
#admin td, #admin th { text-align: left; padding: 8px 6px; border-bottom: 1px solid rgba(107,142,35,.1); vertical-align: middle; }
#admin td { word-break: break-word; font-variant-numeric: tabular-nums; }
#admin th { font: 15px 'VT323', monospace; letter-spacing: .16em; text-transform: uppercase; color: #6b8e23; font-weight: 400; }
#admin tr:last-child td { border-bottom: 0; }
#admin tr:hover td { background: rgba(132,204,22,.04); }
#admin code { font: 13px ui-monospace, Menlo, monospace; color: #a0bb94; }
#admin .ad-badge { display: inline-block; font: 14px 'VT323', monospace; letter-spacing: .12em; text-transform: uppercase; padding: 0 7px; border-radius: 4px; border: 1px solid currentColor; }
#admin .ad-none { color: #7d9a72; padding: 4px 0; }
#admin .ad-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
#admin button { font: 700 17px 'VT323', monospace; letter-spacing: .14em; text-transform: uppercase; padding: 4px 14px; border-radius: 6px; border: 2px solid #6b8e23;
  background: #6b8e23; color: #060b06; cursor: pointer; }
#admin button:not(:disabled):hover { filter: brightness(1.12); }
#admin button.ghost { background: transparent; color: #a8c46a; border-color: rgba(107,142,35,.5); }
#admin button.danger { background: transparent; border-color: rgba(224,72,58,.6); color: #ff7a6b; }
#admin button.danger:hover { background: rgba(224,72,58,.12); }
#admin td button { padding: 2px 10px; font-size: 15px; }
#admin button:disabled { opacity: .4; cursor: default; }
#admin .wide { grid-column: 1 / -1; }
#admin .msg { color: #f2b630; font: 17px 'VT323', monospace; letter-spacing: .06em; }
#admin .msg:empty { display: none; }
#admin .ad-note { margin: 10px 0 0; color: #7d9a72; font-size: 13px; }
#admin .ad-gate { max-width: 560px; border: 1px solid rgba(107,142,35,.25); border-radius: 14px; padding: 22px; background: linear-gradient(180deg, #0d150d, #080d08); }
#admin .ad-gate p { margin: 0 0 14px; color: #a0bb94; }
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
  const card = (title: string, wide = false, n?: number | string) => {
    const c = el('div', '', `card${wide ? ' wide' : ''}`); const h = el('h3', title);
    if (n !== undefined && n !== 0) h.append(el('span', String(n), 'n'));
    c.append(h); return c;
  };
  const wrap = (t: HTMLElement) => { const d = el('div', '', 'ad-tbl'); d.append(t); return d; };
  const act = async (label: string, f: () => Promise<unknown>) => { msg = `${label}…`; await draw(false); try { await f(); msg = `${label}: done.`; } catch (e) { msg = `${label}: ${e instanceof Error ? e.message : 'failed'}`; } await draw(); };

  async function draw(fetchIt = true): Promise<void> {
    const data = fetchIt ? await call<Overview>('GET', '/admin/overview').catch(() => 0) : last;
    root.replaceChildren(el('h1', 'Admin'));
    if (typeof data === 'number' || !data) {
      const why = data === 403 ? (account() ? 'This wallet is not an admin. Sign in with one listed in ADMIN_ADDRESSES, or holding a contract admin role.' : 'Sign in with an admin wallet to see the server, players, rooms and contracts.') : 'The server is not answering. It may be restarting; try again in a moment.';
      const g = el('div', '', 'ad-gate');
      g.append(el('p', why));
      if (!account() && (window as unknown as { ethereum?: unknown }).ethereum) {
        const b = el('button', 'Sign in with wallet'); b.onclick = () => void signIn(apiBase()).then(() => draw(), (e: Error) => { msg = e.message; void draw(false); }); g.append(b);
      } else if (typeof data !== 'number' || data !== 403) { const b = el('button', 'Try again', 'ghost'); b.onclick = () => void draw(); g.append(b); }
      g.append(el('div', msg, 'msg'));
      root.append(g);
      return;
    }
    last = data;
    const o = data;
    const bar = el('div', '', 'ad-bar');
    const up = el('span', '', `ad-pill${o.server.db === 'memory' ? ' mem' : ''}`);
    up.append(el('i'), document.createTextNode('Server up '), el('b', ago(o.server.uptimeS)), document.createTextNode(` · ${o.server.db === 'memory' ? 'memory store (nothing is kept)' : 'database'} · content v${o.server.content}`));
    const who = el('span', '', 'ad-pill'); who.title = o.you; who.append(document.createTextNode('Admin '), el('b', `${o.you.slice(0, 6)}…${o.you.slice(-4)}`));
    const refresh = el('button', 'Refresh', 'ghost'); refresh.onclick = () => void draw();
    const back = el('button', 'Close', 'ghost'); back.onclick = () => root.remove();
    bar.append(up, who, el('span', '', 'ad-grow'), el('span', msg, 'msg'), refresh, ...(parent ? [] : [back]));
    root.append(bar);

    const kpis = el('div', '', 'ad-kpis');
    const kpi = (k: string, v: string, small: string, cls = '') => { const d = el('div', '', `ad-kpi${cls ? ` ${cls}` : ''}`); d.append(el('div', k, 'k'), el('b', v), el('small', small)); return d; };
    kpis.append(
      kpi('Accounts', String(o.players.accounts), `+${o.players.accounts24h} in 24 h`),
      kpi('Runs', String(o.players.runs24h), `${o.players.runs} all time`),
      kpi('Failed replays', String(o.players.failed24h), 'in 24 h', o.players.failed24h ? 'warn' : ''),
      kpi('Room rounds', String(o.players.rounds24h), 'in 24 h'),
      kpi('Rooms live', String(o.rooms.length), o.rooms.length ? `${o.rooms.reduce((a, r) => a + r.connected, 0)} players in them` : 'none open'),
    );
    root.append(kpis);
    const grid = el('div', '', 'grid');
    root.append(grid);

    const srv = card('Server');
    srv.append(kv('Uptime', ago(o.server.uptimeS)), kv('Memory', `${o.server.rssMb} MB`, o.server.rssMb > 400 ? 'warn' : ''), kv('Store', o.server.db, o.server.db === 'memory' ? 'warn' : 'good'), kv('Content', `v${o.server.content}`), kv('Node', o.server.node));
    grid.append(srv);

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
      const row = el('div', '', 'ad-actions'); row.append(p, w);
      c.append(row);
      grid.append(c);
    }
    if (!o.stacks.length) { const c = card('Stake contracts'); c.append(el('div', 'Staked rooms are off on this server.', 'ad-none'), el('p', 'Set STAKED=true with the contract addresses to turn them on.', 'ad-note')); grid.append(c); }

    const rooms = card('Live rooms', true, o.rooms.length);
    if (!o.rooms.length) rooms.append(el('div', 'No rooms open right now.', 'ad-none'));
    else {
      const t = el('table'); t.innerHTML = '<tr><th>Room</th><th>State</th><th>Seats</th><th>Time</th><th></th></tr>';
      for (const r of o.rooms) {
        const tr = el('tr');
        tr.append(el('td', r.onChain ? `${r.stack} #${r.onChain}` : r.code), el('td', r.state), el('td', `${r.connected}/${r.seats}`), el('td', r.state === 'playing' ? ago(r.elapsedS) : ''));
        const td = el('td'); const b = el('button', 'Close', 'danger');
        b.onclick = () => { if (confirm(`Close ${r.code}? Everyone in it is sent back.${r.onChain ? ' A started staked room is not paid by closing it: its players reclaim after the window.' : ''}`)) void act(`Close ${r.code}`, () => call('POST', `/admin/rooms/${encodeURIComponent(r.code)}/close`)); };
        td.append(b); tr.append(td); t.append(tr);
      }
      rooms.append(wrap(t));
    }
    grid.append(rooms);

    const st = card('Settlements', true, o.settlements.length ? `latest ${o.settlements.length}` : undefined);
    if (!o.settlements.length) st.append(el('div', 'No staked room has settled yet.', 'ad-none'));
    else {
      const t = el('table'); t.innerHTML = '<tr><th>Room</th><th>Status</th><th>Winners</th><th>Transaction / error</th><th></th></tr>';
      for (const s of o.settlements) {
        const tr = el('tr');
        const stat = el('td'); stat.append(el('span', s.status, `ad-badge ${s.status === 'done' ? 'good' : s.status === 'failed' ? 'bad' : 'warn'}`));
        const txd = el('td'); txd.append(s.tx ? el('code', s.tx) : el('span', s.error ?? '', s.error ? 'bad' : ''));
        tr.append(el('td', s.roomId), stat, el('td', String(s.winners.length)), txd);
        const td = el('td');
        if (s.status !== 'done') { const b = el('button', 'Retry'); b.onclick = () => void act(`Retry ${s.roomId}`, () => call('POST', `/admin/settlements/${encodeURIComponent(s.roomId)}/retry`)); td.append(b); }
        tr.append(td); t.append(tr);
      }
      st.append(wrap(t));
    }
    grid.append(st);

    const sus = card('Failed replays · 7 days', true, o.suspicious.length);
    if (!o.suspicious.length) sus.append(el('div', 'None. Every run sent in replayed to what it claimed.', 'ad-none'));
    else {
      const t = el('table'); t.innerHTML = '<tr><th>Account</th><th>Failed</th><th>Replayed</th></tr>';
      for (const x of o.suspicious) {
        const tr = el('tr'); const who = el('td');
        if (x.name) who.append(el('b', x.name), document.createTextNode(' '));
        who.append(el('code', x.address));
        tr.append(who, el('td', String(x.failed), 'warn'), el('td', String(x.ok))); t.append(tr);
      }
      sus.append(wrap(t));
    }
    sus.append(el('p', 'A failed replay is a run whose log does not end the way the player said: a modified client, or a bug. Several from one account is worth a look.', 'ad-note'));
    grid.append(sus);
  }
  let last: Overview | null = null;
  void draw();
}
