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

interface PlayerMoney { address: string; in: string; out: string; owed: string; how: string }
interface RoomMoney {
  id: string; host: string; stake: string; maxPlayers: number; state: string; createdAt: number; expiresAt: number; startedAt: number | null; endedAt: number | null;
  staked: string; pot: string; winners: string[]; share: string; fee: string; refunded: string; reclaimed: string; owed: string; why: string | null;
  txs: { created: string; started: string | null; ended: string | null }; players: PlayerMoney[];
  settlement: { status: string; error: string | null; tx: string | null } | null; issues: string[];
}
interface Totals {
  rooms: number; started: number; settled: number; refundedRooms: number; staked: string; staked30d: string; paidToWinners: string; refunded: string; reclaimed: string;
  leftBeforeStart: string; fees: string; fees30d: string; feesWithdrawn: string; emergency: string; owed: string; expectHeld: string; expectFees: string;
}
interface FundsView {
  on: boolean; syncing?: boolean;
  stacks: Array<{ symbol: string; cursor: number | null; error: string | null; reclaimAfter: number; onChain: { held: string; fees: string } | null; totals: Totals; attention: RoomMoney[]; rooms: RoomMoney[] }>;
  topups: { count: number; cash: number; recent: Array<{ address: string; name: string | null; cash: number; tx: string; at: string }>; config: { symbol: string; rate: number; treasury: string; decimals: number } | null };
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
#admin .ad-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
#admin .ad-form input, #admin .ad-form select { font: 14px system-ui, sans-serif; background: #0b0f0b; color: #d4c9b2; border: 1px solid rgba(107,142,35,.4); border-radius: 6px; padding: 6px 9px; min-width: 0; }
#admin .ad-form input[name=title] { flex: 1 1 320px; } #admin .ad-form input[name=body] { flex: 1 1 260px; } #admin .ad-form input[name=to] { flex: 1 1 260px; }
#admin .ad-form label { color: #8fa785; font-size: 13px; display: flex; gap: 6px; align-items: center; }
#admin .ad-form input[type=number] { width: 90px; }
#admin .ad-gate { max-width: 560px; border: 1px solid rgba(107,142,35,.25); border-radius: 14px; padding: 22px; background: linear-gradient(180deg, #0d150d, #080d08); }
#admin .ad-gate p { margin: 0 0 14px; color: #a0bb94; }
#admin.inpage > h1 { display: none; }
#admin .ad-sec { margin: 26px 0 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
#admin .ad-sec h2 { margin: 0; font: 400 26px 'VT323', monospace; letter-spacing: .14em; text-transform: uppercase; color: #e8e0cc; }
#admin .ad-sec .grow { flex: 1; }
#admin input.ad-find { font: 14px ui-monospace, Menlo, monospace; background: #0b0f0b; color: #d4c9b2; border: 1px solid rgba(107,142,35,.4); border-radius: 6px; padding: 5px 9px; min-width: 0; width: min(320px, 100%); }
#admin tr.ad-more td { background: rgba(132,204,22,.03); }
#admin tr.ad-open { cursor: pointer; }
#admin .ad-issue { color: #f2b630; font-size: 13px; margin-top: 3px; }
#admin a { color: #a8c46a; }
#admin.inpage { position: static; inset: auto; z-index: auto; overflow: visible; background: transparent; padding: 0; }
`;

const el = (tag: string, text = '', cls = '') => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
const units = (wei: string | undefined, decimals: number) => {
  if (wei === undefined) return '?';
  const v = BigInt(wei), d = 10n ** BigInt(decimals);
  return `${v / d}.${(v % d).toString().padStart(decimals, '0').slice(0, 4)}`;
};
const EXPLORER: Record<number, string> = { 42220: 'https://celoscan.io', 11142220: 'https://celo-sepolia.blockscout.com', 44787: 'https://celo-alfajores.blockscout.com' };
const chainId = Number((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CHAIN_ID ?? 42220);
const txLink = (tx: string | null | undefined): HTMLElement => {
  if (!tx) return document.createElement('span');
  const base = EXPLORER[chainId];
  const c = document.createElement('code'); c.textContent = `${tx.slice(0, 10)}…`; c.title = tx;
  if (!base) return c;
  const a = document.createElement('a'); a.href = `${base}/tx/${tx}`; a.target = '_blank'; a.rel = 'noopener'; a.append(c); return a;
};
const when = (s: number | null) => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : '');
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

    grid.append(await promoCard(), grantCard());

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

    const fundsBox = el('div', '', 'wide');
    fundsBox.append(el('div', 'Reading the money in staked rooms…', 'ad-none'));
    void drawFunds(fundsBox, false, o.stacks);

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
    root.append(fundsBox);
  }

  /** Promotions: the banner across the site. Make one (a deal may pay extra ZP on top-ups), see them all, end one. */
  async function promoCard(): Promise<HTMLElement> {
    interface P { id: string; kind: string; title: string; body: string; cta: { label: string; href: string } | null; startsAt: string; endsAt: string; topupBonus: number; discount: number; scope: string; ended: boolean }
    const c = card('Promotions', true);
    const list = await call<P[]>('GET', '/admin/promos').catch(() => 0);
    const f = document.createElement('form'); f.className = 'ad-form';
    f.innerHTML = `<select name="kind"><option value="bounty">🏆 Bounty</option><option value="prize">🎁 Prize</option><option value="deal">⚡ Deal</option><option value="sale">🏷️ Sale</option><option value="news">📣 News</option></select>
      <input name="title" maxlength="80" placeholder="Headline: First out of the docks wins 5,000 ZP" required />
      <input name="body" maxlength="280" placeholder="One line more (optional)" />
      <input name="label" maxlength="24" placeholder="Button (e.g. Play now)" /><input name="href" placeholder="Button link: /play or https://…" />
      <label>Ends <input name="ends" type="datetime-local" required /></label>
      <label data-for="deal">Top-up bonus % <input name="bonus" type="number" min="0" max="200" value="0" /></label>
      <label data-for="sale">Discount % <input name="discount" type="number" min="0" max="90" value="20" /></label>
      <label data-for="sale">On <select name="scope"><option value="all">everything</option><option value="weapon">weapons</option><option value="gear">gear</option><option value="supply">supplies</option><option value="upgrade">upgrades</option><option value="survivor">survivors and perks</option></select></label>
      <button type="submit">Publish</button><button type="button" class="ghost" data-cancel hidden>Cancel edit</button>`;
    const kindSel = f.elements.namedItem('kind') as HTMLSelectElement;
    // only the fields that belong to the kind: a deal's bonus, a sale's discount
    const fit = () => { for (const l of f.querySelectorAll<HTMLElement>('[data-for]')) l.hidden = l.dataset.for !== kindSel.value; };
    kindSel.onchange = fit; fit();
    const local = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
    const submit = f.querySelector<HTMLButtonElement>('button[type=submit]')!, cancel = f.querySelector<HTMLButtonElement>('[data-cancel]')!;
    /** Load a promotion into the form to change it (its kind stays). */
    const edit = (p: P) => {
      const set = (n: string, v: string) => { (f.elements.namedItem(n) as HTMLInputElement).value = v; };
      f.dataset.edit = p.id; kindSel.value = p.kind; kindSel.disabled = true; fit();
      set('title', p.title); set('body', p.body); set('label', p.cta?.label ?? ''); set('href', p.cta?.href ?? ''); set('ends', local(p.endsAt));
      set('bonus', String(p.topupBonus)); set('discount', String(p.discount)); set('scope', p.scope);
      submit.textContent = 'Save changes'; cancel.hidden = false;
      f.scrollIntoView({ block: 'center' });
    };
    cancel.onclick = () => { delete f.dataset.edit; kindSel.disabled = false; submit.textContent = 'Publish'; cancel.hidden = true; f.reset(); fit(); };
    const ends = f.elements.namedItem('ends') as HTMLInputElement;
    const d = new Date(Date.now() + 86400_000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); ends.value = d.toISOString().slice(0, 16);
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
      const kind = kindSel.value, editing = f.dataset.edit;
      const body = {
        ...(editing ? {} : { kind }), title: v('title'), body: v('body'), endsAt: new Date(v('ends')).toISOString(),
        topupBonus: kind === 'deal' ? Number(v('bonus')) || 0 : 0, discount: kind === 'sale' ? Number(v('discount')) || 0 : 0, scope: kind === 'sale' ? v('scope') : 'all',
        cta: v('label') && v('href') ? { label: v('label'), href: v('href') } : null,
      };
      void act(editing ? 'Save promotion' : 'Publish promotion', async () => { const r = await fetch(`${apiBase()}/admin/promos${editing ? `/${editing}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account()?.token ?? ''}` }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${r.status})`); });
    };
    c.append(f, el('p', 'Shows under the header on every page with a countdown, until it ends. A deal pays its bonus % extra ZP on every top-up while it runs; a sale takes its discount % off buying in the armoury (loans keep their fee). Edit changes one that is running or scheduled. Pay bounties and prizes with Grant ZP (or by hand for crypto).', 'ad-note'));
    if (typeof list !== 'number' && list.length) {
      const t = el('table'); t.innerHTML = '<tr><th>Kind</th><th>Headline</th><th>Ends</th><th>State</th><th></th></tr>';
      for (const p of list) {
        const live = !p.ended && Date.parse(p.startsAt) <= Date.now() && Date.parse(p.endsAt) > Date.now();
        const tr = el('tr'); const st = el('td'); st.append(el('span', p.ended ? 'ended' : live ? 'live' : Date.parse(p.endsAt) <= Date.now() ? 'over' : 'scheduled', `ad-badge ${live ? 'good' : ''}`));
        tr.append(el('td', p.kind + (p.topupBonus ? ` +${p.topupBonus}%` : '') + (p.discount ? ` −${p.discount}% ${p.scope}` : '')), el('td', p.title), el('td', new Date(p.endsAt).toLocaleString()), st);
        const td = el('td');
        if (!p.ended && Date.parse(p.endsAt) > Date.now()) { const e = el('button', 'Edit', 'ghost'); e.onclick = () => edit(p); td.append(e, document.createTextNode(' ')); }
        if (live) { const b = el('button', 'End now', 'danger'); b.onclick = () => void act('End promotion', () => call('POST', `/admin/promos/${p.id}/end`)); td.append(b); }
        tr.append(td); t.append(tr);
      }
      c.append(wrap(t));
    }
    return c;
  }

  /** Give ZP to a player: testers, a bounty or a prize paid. */
  function grantCard(): HTMLElement {
    const c = card('Grant ZP');
    const f = document.createElement('form'); f.className = 'ad-form';
    f.innerHTML = '<input name="to" placeholder="Wallet address or player name" required /><input name="amount" type="number" min="1" max="100000" placeholder="ZP" required /><input name="note" maxlength="60" placeholder="Why (tester, bounty: docks…)" required /><button type="submit">Grant</button>';
    f.onsubmit = (e) => {
      e.preventDefault();
      const v = (n: string) => (f.elements.namedItem(n) as HTMLInputElement).value.trim();
      void act(`Grant ${v('amount')} ZP to ${v('to')}`, async () => {
        const r = await fetch(`${apiBase()}/admin/grant`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account()?.token ?? ''}` }, body: JSON.stringify({ to: v('to'), amount: Number(v('amount')), note: v('note') }) });
        const j = (await r.json().catch(() => ({}))) as { error?: string; balance?: number };
        if (!r.ok) throw new Error(j.error ?? `refused (${r.status})`);
      });
    };
    c.append(f, el('p', 'Written in the ledger with your note. ZP is game currency: it is never paid out.', 'ad-note'));
    return c;
  }

  /** The Funds section: totals, a check against the contracts, the rooms that need someone, every room's money, top-ups. */
  async function drawFunds(box: HTMLElement, sync: boolean, contracts: Overview['stacks']): Promise<void> {
    const f = await call<FundsView>('GET', `/admin/funds${sync ? '?sync=1' : ''}`).catch(() => 0);
    box.replaceChildren();
    const head = el('div', '', 'ad-sec');
    head.append(el('h2', 'Funds'), el('span', '', 'grow'));
    const read = el('button', 'Read the chain now', 'ghost') as HTMLButtonElement;
    read.onclick = () => { read.disabled = true; read.textContent = 'Reading…'; void drawFunds(box, true, contracts); };
    head.append(read);
    box.append(head);
    if (typeof f === 'number' || !f) { box.append(el('div', 'The funds view did not load. Try Refresh.', 'ad-none')); return; }
    if (f.syncing) box.append(el('p', 'Still reading the chain (the first read walks back through the contract history). These numbers fill in as it goes; read again in a minute.', 'ad-note'));
    if (!f.on) box.append(el('div', 'Staked rooms are off on this server, so there is no stake money to account for.', 'ad-none'));

    for (const s of f.stacks) {
      const dec = decimals[s.symbol] ?? 18;
      const u = (v: string | undefined) => `${units(v, dec)} ${s.symbol}`;
      const t = s.totals;
      const sub = el('div', '', 'ad-sec'); sub.append(el('h2', s.symbol), el('span', `read to block ${s.cursor ?? '—'}`, 'ad-pill'));
      if (s.error) sub.append(el('span', `chain read failed: ${s.error}`, 'bad'));
      box.append(sub);

      const kpis = el('div', '', 'ad-kpis');
      const kpi = (k: string, v: string, small: string, cls = '') => { const d = el('div', '', `ad-kpi${cls ? ` ${cls}` : ''}`); d.append(el('div', k, 'k'), el('b', v), el('small', small)); return d; };
      const back = BigInt(t.refunded) + BigInt(t.leftBeforeStart) + BigInt(t.reclaimed);
      kpis.append(
        kpi('Staked', units(t.staked, dec), `${units(t.staked30d, dec)} in 30 days · ${t.rooms} rooms`),
        kpi('Paid to winners', units(t.paidToWinners, dec), `${t.settled} rooms settled`),
        kpi('Given back', units(String(back), dec), `refunds ${units(t.refunded, dec)} · left ${units(t.leftBeforeStart, dec)} · reclaimed ${units(t.reclaimed, dec)}`),
        kpi('Fees earned', units(t.fees, dec), `${units(t.fees30d, dec)} in 30 days`, 'good'),
        kpi('Fees withdrawn', units(t.feesWithdrawn, dec), `${units(t.expectFees, dec)} still in the fee contract`),
        kpi('Owed, unclaimed', units(t.owed, dec), 'payouts the token refused', BigInt(t.owed) > 0n ? 'warn' : ''),
      );
      box.append(kpis);

      const grid = el('div', '', 'grid');
      box.append(grid);
      const rec = card('Check against the contracts');
      const diff = (chain: string | undefined, expect: string) => {
        if (chain === undefined) return { text: 'chain not answering', cls: 'warn' };
        const d = BigInt(chain) - BigInt(expect);
        return d === 0n ? { text: 'matches', cls: 'good' } : { text: `differs by ${units(String(d < 0n ? -d : d), dec)} (${d > 0n ? 'more' : 'less'} on chain)`, cls: 'bad' };
      };
      const h = diff(s.onChain?.held, t.expectHeld), fz = diff(s.onChain?.fees, t.expectFees);
      rec.append(kv('Escrow holds (chain)', s.onChain ? u(s.onChain.held) : '?'), kv('Escrow should hold (events)', u(t.expectHeld)), kv('Escrow', h.text, h.cls),
        kv('Fee contract holds (chain)', s.onChain ? u(s.onChain.fees) : '?'), kv('Fees should be (events)', u(t.expectFees)), kv('Fees', fz.text, fz.cls));
      if (BigInt(t.emergency) > 0n) rec.append(kv('Emergency withdrawals', u(t.emergency), 'bad'));
      rec.append(el('p', 'The escrow should hold exactly the stakes of rooms still open plus payouts waiting to be claimed. A difference means history the server has not read (set STAKE_FROM_BLOCK to the deploy block) or money moved outside the game.', 'ad-note'));
      grid.append(rec);

      const policy = card('Refund rules');
      policy.append(
        kv('Waiting room past expiry', 'anyone can refund all (expireRoom)'),
        kv('Started, never settled', `each player reclaims after ${Math.round(s.reclaimAfter / 3600)} h`),
        kv('Nobody got out', 'all stakes back, no fee'),
        kv('Payout refused by token', 'held; player calls claim'),
      );
      grid.append(policy);

      // the rooms that need someone
      const att = card('Needs attention', true, s.attention.length);
      if (!s.attention.length) att.append(el('div', 'Nothing. Every room is either open, paid out or refunded.', 'ad-none'));
      else {
        const tb = el('table'); tb.innerHTML = '<tr><th>Room</th><th>State</th><th>In the room</th><th>What is wrong</th><th></th></tr>';
        for (const r of s.attention) {
          const tr = el('tr');
          const what = el('td'); for (const i of r.issues) what.append(el('div', i, 'ad-issue'));
          tr.append(el('td', `#${r.id}`), el('td', r.state), el('td', u(String(BigInt(r.pot) + BigInt(r.owed)))), what);
          const td = el('td');
          if (r.settlement && r.settlement.status !== 'done') { const b = el('button', 'Retry settlement'); b.onclick = () => void act(`Retry ${s.symbol}:${r.id}`, () => call('POST', `/admin/settlements/${encodeURIComponent(`${s.symbol}:${r.id}`)}/retry`)); td.append(b); }
          const rooms = contracts.find((c) => c.symbol === s.symbol)?.rooms;
          if (r.state === 'waiting' && rooms) {
            const b = el('button', 'Refund everyone', 'danger');
            b.onclick = () => { if (confirm(`Refund every stake in ${s.symbol} room #${r.id}? This sends expireRoom(${r.id}) from your wallet.`)) void act(`Refund #${r.id}`, async () => (await import('./stake')).adminTx({ chainId }, rooms, 'expireRoom', BigInt(r.id))); };
            td.append(b);
          }
          tr.append(td); tb.append(tr);
        }
        att.append(wrap(tb));
      }
      grid.append(att);

      // every room, newest first, searchable, with each player's money on a click
      const all = card('Rooms', true, s.rooms.length ? `latest ${s.rooms.length}` : undefined);
      const tools = el('div', '', 'ad-actions');
      const find = el('input', '', 'ad-find') as HTMLInputElement; find.placeholder = 'Room number or wallet address';
      const csv = el('button', 'Download CSV', 'ghost');
      csv.onclick = () => {
        const rows = [['room', 'state', 'created', 'started', 'ended', 'stake', 'player', 'in', 'out', 'owed', 'result', 'why', 'end_tx']];
        for (const r of s.rooms) for (const p of r.players) rows.push([r.id, r.state, when(r.createdAt), when(r.startedAt), when(r.endedAt), units(r.stake, dec), p.address, units(p.in, dec), units(p.out, dec), units(p.owed, dec), p.how, r.why ?? '', r.txs.ended ?? '']);
        const blob = new Blob([rows.map((x) => x.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `stakes-${s.symbol}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      };
      tools.append(find, csv);
      all.append(tools);
      const tb = el('table');
      const fill = () => {
        const q = find.value.trim().toLowerCase().replace(/^#/, '');
        tb.innerHTML = '<tr><th>Room</th><th>State</th><th>Created</th><th>Players</th><th>Staked</th><th>Winners · share</th><th>Fee</th><th>Given back</th><th>Ended</th></tr>';
        const list = q ? s.rooms.filter((r) => r.id === q || r.players.some((p) => p.address.includes(q))) : s.rooms;
        if (!list.length) { const tr = el('tr'); const td = el('td', q ? 'No room matches.' : 'No staked room yet.', 'ad-none'); (td as HTMLTableCellElement).colSpan = 9; tr.append(td); tb.append(tr); return; }
        for (const r of list) {
          const tr = el('tr', '', 'ad-open');
          const state = el('td'); state.append(el('span', r.state, `ad-badge ${r.state === 'settled' ? 'good' : r.state === 'refunded' ? '' : r.issues.length ? 'bad' : 'warn'}`));
          const ended = el('td'); ended.append(document.createTextNode(`${when(r.endedAt)} `), txLink(r.txs.ended));
          tr.append(el('td', `#${r.id}`), state, el('td', when(r.createdAt)), el('td', `${r.players.length}/${r.maxPlayers}`), el('td', u(r.staked)),
            el('td', r.winners.length ? `${r.winners.length} · ${units(r.share, dec)}` : ''), el('td', BigInt(r.fee) ? units(r.fee, dec) : ''),
            el('td', BigInt(r.refunded) + BigInt(r.reclaimed) ? units(String(BigInt(r.refunded) + BigInt(r.reclaimed)), dec) : ''), ended);
          tb.append(tr);
          let more: HTMLElement | null = null;
          tr.onclick = () => {
            if (more) { more.remove(); more = null; return; }
            more = el('tr', '', 'ad-more');
            const td = el('td') as HTMLTableCellElement; td.colSpan = 9;
            const inner = el('table'); inner.innerHTML = '<tr><th>Player</th><th>Put in</th><th>Got back</th><th>Owed</th><th>Result</th></tr>';
            for (const p of r.players) {
              const pr = el('tr'); const who = el('td'); who.append(el('code', p.address));
              if (p.address === r.host) who.append(document.createTextNode(' host'));
              pr.append(who, el('td', units(p.in, dec)), el('td', units(p.out, dec)), el('td', BigInt(p.owed) ? units(p.owed, dec) : '', BigInt(p.owed) ? 'warn' : ''), el('td', p.how));
              inner.append(pr);
            }
            const meta = el('p', '', 'ad-note');
            meta.append(document.createTextNode(`Created ${when(r.createdAt)} `), txLink(r.txs.created), document.createTextNode(r.startedAt ? ` · started ${when(r.startedAt)} ` : ''), txLink(r.txs.started),
              document.createTextNode(r.why ? ` · ${r.why}` : ''), document.createTextNode(r.settlement ? ` · server settlement: ${r.settlement.status}${r.settlement.error ? ` (${r.settlement.error})` : ''}` : ''));
            td.append(inner, meta); more.append(td); tr.after(more);
          };
        }
      };
      find.oninput = fill;
      fill();
      all.append(wrap(tb));
      grid.append(all);
    }

    // armoury top-ups: stablecoin paid to the treasury for game cash
    const tp = f.topups;
    const tc = card('Armoury top-ups', true, tp.count || undefined);
    if (!tp.config && !tp.count) tc.append(el('div', 'Top-ups are off on this server.', 'ad-none'));
    else {
      const tokens = tp.config ? (tp.cash / tp.config.rate).toFixed(2) : '?';
      tc.append(kv('Top-ups', String(tp.count)), kv('ZP credited', tp.cash.toLocaleString()), kv('Paid in', `≈ ${tokens} ${tp.config?.symbol ?? ''}`, 'good'));
      if (tp.config) tc.append(kv('Treasury', tp.config.treasury));
      if (tp.recent.length) {
        const tb = el('table'); tb.innerHTML = '<tr><th>When</th><th>Account</th><th>ZP</th><th>Transaction</th></tr>';
        for (const x of tp.recent) {
          const tr = el('tr'); const who = el('td'); if (x.name) who.append(el('b', x.name), document.createTextNode(' ')); who.append(el('code', x.address));
          const txd = el('td'); txd.append(txLink(x.tx));
          tr.append(el('td', new Date(x.at).toISOString().slice(0, 16).replace('T', ' ')), who, el('td', x.cash.toLocaleString()), txd); tb.append(tr);
        }
        tc.append(wrap(tb));
      }
    }
    const g2 = el('div', '', 'grid'); g2.append(tc); box.append(g2);
  }
  let last: Overview | null = null;
  void draw();
}
