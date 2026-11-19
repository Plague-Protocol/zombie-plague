// Playing in a room, in the browser. Loaded only when someone taps Multiplayer.
//
// The server runs the game. This builds the same district from the seed the server gives (createRoom, so every map,
// step and crate is in the right place without being sent) and keeps that state as a *shadow*: nothing here runs the
// rules except one thing, walking. The player's own walking is predicted from their inputs so the controls answer at
// once, then corrected when the server's word on where they are comes back. Everyone and everything else is drawn
// a little in the past, between the two snapshots either side of that moment, so it moves smoothly.
import { movePlayer, createRoom, type GameState } from '../../../core/state';
import { SURVIVORS, type SurvivorId } from '../../../core/survivors';
import { quantize, type Command } from '../../../core/replay';
import { content } from '../../../core/content';
import type { GameEvent, Input, Player, Zombie } from '../../../core/types';
import type { PlayerView } from '../../../core/view';
import type { GameView } from '../render/view';
import type { Controls } from '../input/controls';
import { Actor, loadSkin, type SkinName } from '../render/characters';
import { makeDecoder } from '../../../core/codec';
import { ROOM_DT, type ClientMsg, type SeatInfo, type ServerMsg } from '../../../core/protocol';
import { ROOM_PLAYERS_MAX, ZOMBIE_HEALTH } from '../../../core/config';
import { account, signIn, signInSocial, socialAvailable, type Account } from './account';

/** What the page lends this module. */
export interface Host {
  view: GameView;
  controls: Controls;
  toast(text: string): void;
  /** Hand the game over to the room: draw `shadow`, call `driver.frame` instead of the single-player step. */
  enter(shadow: GameState, driver: Driver, survivor?: string | null): void;
  /** Close the store page's cached numbers if it is open (a purchase has just come back). */
  refreshStore(): void;
  /** Start today's city while the player keeps a seat in a quiet room (enter() takes over if the round starts). */
  soloWhileWaiting(): void;
  /** Hold (or let go of) that solo night while the lobby is back over it. */
  holdSolo(on: boolean): void;
}
export interface Driver {
  /** Called every drawn frame. Returns the events to narrate this frame. */
  frame(dt: number): GameEvent[];
  /** A purchase, weapon swap or puzzle answer: sent to the server. */
  act(c: Command): boolean;
}

const RENDER_DELAY = 0.1; // seconds behind the newest snapshot that others are drawn
const SNAP_BEYOND = 3; // a correction larger than this many units is a jump, not something to ease
const EASE = 0.1; // seconds over which a small correction fades
const KEY_NAME = 'zp.name';
const DEBUG = new URLSearchParams(location.search).has('debug');

export function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_SERVER_URL;
  if (env) return env;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8787`;
}
const httpUrl = (ws: string) => ws.replace(/^ws/, 'http');

// ---------------------------------------------------------------- the lobby

const CSS = `
#mp { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px;
  background: rgba(4,6,10,.94); font-family: 'VT323', monospace; color: #d4c9b2; text-align: center; padding: 24px; }
#mp h2 { margin: 0; font-family: 'Eater', system-ui, sans-serif; font-weight: 400; font-size: clamp(30px, 7vw, 56px); letter-spacing: .06em; text-shadow: 0 0 24px rgba(230,51,41,.45); }
#mp p { margin: 0; color: #7d9a72; letter-spacing: .12em; text-transform: uppercase; font-size: 18px; }
#mp .row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; align-items: center; }
#mp input { font: inherit; font-size: 22px; background: #0b0f0b; color: #d4c9b2; border: 2px solid #3d5a2a; border-radius: 6px; padding: 6px 10px; width: 9em; text-align: center; text-transform: none; }
#mp input.link { width: min(30em, 92vw); font-size: 15px; text-align: left; }
#mp input.code { text-transform: uppercase; letter-spacing: .3em; width: 5.5em; }
#mp button { font: inherit; font-size: 22px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; padding: 7px 24px; border: 2px solid #6b8e23; border-radius: 6px;
  background: #6b8e23; color: #060b06; cursor: pointer; }
#mp button.ghost { background: transparent; color: #a8c46a; }
#mp button:disabled { opacity: .4; cursor: default; }
#mp .code-big { font-size: clamp(40px, 10vw, 72px); letter-spacing: .35em; text-indent: .35em; color: #e8e0cc; }
#mp ul { list-style: none; margin: 0; padding: 0; min-width: 16em; text-align: left; font-size: 22px; }
#mp li { padding: 3px 10px; border-bottom: 1px solid #1c2a18; }
#mp li.off { opacity: .4; }
#mp li b { color: #e0483a; font-weight: 400; }
#mp .err { color: #e0483a; min-height: 1.2em; }
#mp small { color: #7a8a72; font-size: 16px; }
#mp .stakes button { font-size: 17px; padding: 4px 12px; letter-spacing: .08em; }
#mp .stakes button.on { background: #6b8e23; color: #0b0f0b; }
#mp p.pot { color: #e8c86a; }
#roomend p.won { color: #9bd34a; }
#mp .quiet { border: 1px dashed #3d5a2a; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; align-items: center; gap: 8px; max-width: min(34em, 92vw); text-align: center; }
#mp-wait { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 45; display: flex; gap: 12px; align-items: center; padding: 8px 10px 8px 16px;
  background: rgba(8,12,8,.92); border: 2px solid #3d5a2a; border-radius: 8px; color: #d4c9b2; font-family: 'VT323', ui-monospace, monospace; font-size: 20px; letter-spacing: .06em; max-width: 94vw; }
#mp-wait.hot { border-color: #9bd34a; box-shadow: 0 0 18px rgba(155,211,74,.45); }
#mp-wait button { font: inherit; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; padding: 4px 14px; border: 2px solid #6b8e23; border-radius: 6px; background: #6b8e23; color: #0b0f0b; cursor: pointer; white-space: nowrap; }
#roomhud { position: fixed; left: 50%; top: calc(env(safe-area-inset-top, 0px) + 10px); transform: translateX(-50%); z-index: 4; pointer-events: none;
  font-family: 'VT323', monospace; font-size: 18px; letter-spacing: .14em; color: #d4c9b2; text-shadow: 0 1px 3px #000; text-align: center; white-space: nowrap; }
#roomhud b { color: #f2b630; font-weight: 400; }
#names { position: fixed; inset: 0; z-index: 3; pointer-events: none; overflow: hidden; }
#names span { position: absolute; transform: translate(-50%, -100%); font: 14px system-ui, sans-serif; color: #e8e0cc; text-shadow: 0 1px 3px #000, 0 0 6px #000; white-space: nowrap; }
#names span.turned { color: #e0483a; }
#roomend { position: fixed; inset: 0; z-index: 31; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 12px;
  background: rgba(4,6,10,.88); font-family: 'VT323', monospace; color: #d4c9b2; text-align: center; }
#roomend h2 { margin: 0; font-family: 'Eater', system-ui, sans-serif; font-weight: 400; font-size: clamp(34px, 8vw, 64px); }
#roomend ol { list-style: none; margin: 0; padding: 0; font-size: 24px; min-width: 18em; text-align: left; }
#roomend li { padding: 4px 12px; border-bottom: 1px solid #1c2a18; display: flex; justify-content: space-between; gap: 24px; }
#roomend li.me { color: #f2b630; }
#roomend button { font: inherit; font-size: 22px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; padding: 7px 24px; border: 2px solid #6b8e23; border-radius: 6px; background: #6b8e23; color: #060b06; cursor: pointer; margin-top: 8px; }
`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text) e.textContent = text;
  return e;
};
const ERRORS: Record<string, string> = {
  full: 'That room is full.', 'no-room': 'No room with that code.', started: 'That round has already begun.', rate: 'Too fast.', bad: 'Something went wrong.',
  busy: 'The server is full. Try again in a minute.', hello: 'Not connected yet.',
  'staked-off': 'Staked rooms are not open yet.', 'not-staked': 'The chain does not show your stake in that room.',
  'not-eligible': 'Staked rooms need an account that is a day old, with three finished nights, signed in, and not already in a staked room.',
  'no-chain': 'The server could not read the chain. Try again.',
  signin: 'Sign in to play with others.',
  'no-zp': 'Not enough ZP for that stake. Play a night, or top up in the Armoury.',
  'zp-off': 'ZP rooms are not open on this server yet.',
};
/** The ZP stakes on offer (the server's list: server/src/zp.ts). */
const ZP_STAKES = [50, 100, 250, 500, 1000] as const;
/** Errors that may only mean the chain has not caught up with a transaction a moment ago: the seat is asked for again. */
const RETRY = new Set(['not-staked', 'no-room', 'no-chain']);

/** The lobby: choose a name, make or join a room, wait for the others, go. Resolves when the round begins. */
export function openLobby(host: Host, opts: { join?: string; staked?: string; act?: 'quick' | 'create' } = {}): void {
  if (!document.getElementById('mp-css')) document.head.appendChild(el('style', { id: 'mp-css' }, CSS));
  const root = el('div', { id: 'mp' });
  document.body.appendChild(root);
  const url = serverUrl();
  let ws: WebSocket | null = null;
  let me: Account | null = account();
  let roomInfo: Extract<ServerMsg, { t: 'room' }> | null = null;
  let err = '';
  let note = '';
  /** A room code from an invite link (?join=CODE), joined as soon as the player is signed in. */
  const invite = opts.join && /^[A-Za-z]{5}$/.test(opts.join) ? opts.join.toUpperCase() : null;
  /** A staked room from an invite link (?staked=USDT:5): its token is picked and its number filled in; joining it takes the wallet. */
  const stakedInvite = opts.staked && /^[A-Za-z0-9]{1,8}:\d{1,12}$/.test(opts.staked) ? { symbol: opts.staked.split(':')[0]!, id: opts.staked.split(':')[1]! } : null;
  /** The on-chain room this page is trying to be seated in, and how many times it has asked. */
  let seating: { stack: string; id: bigint; tries: number } | null = null;
  /** The stake tokens on offer: ones this build has the contract for AND the server settles. Empty: no staked lobby. */
  let stacks: import('./stake').StakeConfig[] = [];
  let pick = 0; // which of them the player chose
  let stk: typeof import('./stake') | null = null;
  const loadStake = async () => (stk ??= await import('./stake'));
  // Is there a staked lobby to show? Only if this build knows the contracts and the server says it can settle them.
  void (async () => {
    try {
      const m = await loadStake();
      const mine = m.stakeConfigs();
      if (!mine.length) return;
      const j = (await (await fetch(`${httpUrl(url)}/health`)).json()) as { staked?: boolean; ok?: boolean; stacks?: string[] };
      stacks = j.staked && j.ok ? mine.filter((c) => (j.stacks ?? ['USDm']).includes(c.symbol)) : [];
      if (stakedInvite) pick = Math.max(0, stacks.findIndex((c) => c.symbol === stakedInvite.symbol));
    } catch { stacks = []; }
    if (stacks.length) draw();
  })();
  /** Ask the server for a seat in the on-chain room (it checks the chain and the account; it retries while the chain catches up). */
  const seatIn = (stack: string, id: bigint) => { seating = { stack, id, tries: 0 }; connect(() => send({ t: 'staked', stack, roomId: String(id) })); };
  const cfgOf = (symbol: string | undefined) => stacks.find((c) => c.symbol === symbol) ?? stacks[pick]!;
  /** Run a wallet step, showing what it is waiting for. */
  const chainStep = async (what: string, f: (m: typeof import('./stake'), cfg: import('./stake').StakeConfig) => Promise<void>, symbol?: string) => {
    err = ''; note = what; draw();
    try { const m = await loadStake(); await f(m, cfgOf(symbol)); } catch (e) { err = e instanceof Error ? e.message.slice(0, 160) : 'The wallet refused.'; }
    note = ''; draw();
  };
  const name = () => (localStorage.getItem(KEY_NAME) ?? '').slice(0, 20);
  const send = (m: ClientMsg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  function connect(then: () => void): void {
    if (ws && ws.readyState <= WebSocket.OPEN) { then(); return; }
    err = '';
    ws = new WebSocket(`${url}/play`);
    ws.onopen = () => { send({ t: 'hello', token: me?.token ?? null, name: me?.name || name() }); then(); };
    ws.onerror = () => { err = 'Cannot reach the game server.'; draw(); };
    ws.onclose = () => { if (!began) { roomInfo = null; if (!err) err = 'Disconnected.'; watchQuiet(); if (away) banner(false); draw(); } };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as ServerMsg;
      if (m.t === 'room') { const before = roomInfo?.seats.length ?? 0; roomInfo = m; err = ''; seating = null; watchQuiet(); if (away) banner(m.seats.length > before); draw(); }
      else if (m.t === 'err') {
        if (seating && RETRY.has(m.code) && seating.tries < 12) { seating.tries++; const { stack, id } = seating; setTimeout(() => send({ t: 'staked', stack, roomId: String(id) }), 1500); return; }
        seating = null;
        err = ERRORS[m.code] ?? 'Something went wrong.'; draw();
      }
      else if (m.t === 'confirm') { joinAsk = m; err = ''; draw(); }
      else if (m.t === 'zp') { note = ''; err = ''; zpNote = m.got ? `Your ${m.got} ZP stake is back.` : ''; draw(); }
      else if (m.t === 'begin') begin(m);
      else buffered.push(m); // snapshots that arrive before the shadow is built
    };
  }
  const buffered: ServerMsg[] = [];
  let began = false;

  function begin(m: Extract<ServerMsg, { t: 'begin' }>): void {
    if (began) return;
    began = true;
    away = false; waitBar?.remove(); waitBar = null; clearTimeout(quietTimer);
    if (m.content !== content().version) {
      err = 'The game has been updated. Reload the page to play.';
      ws?.close();
      draw();
      began = false;
      return;
    }
    root.remove();
    const session = new Session(host, ws!, m);
    session.setNames(roomInfo?.seats.map((x) => x.name) ?? []);
    for (const x of buffered.splice(0)) session.message(x);
    ws!.onmessage = (e) => session.message(JSON.parse(e.data as string) as ServerMsg);
    ws!.onclose = () => session.dropped();
  }

  /** The ZP stake picked for Join a public room and New private room (null: a free room), your balance, and the last refund. */
  let stake: number | null = null, zpHave: number | null = null, zpNote = '';
  /** A ZP room joined by its code, waiting for the player to agree to its stake. */
  let joinAsk: Extract<ServerMsg, { t: 'confirm' }> | null = null;
  /** Players waiting in public rooms, by stake ('free' for none), refreshed while the menu is open. */
  let waitingBy: Record<string, number> = {};
  const fetchWaiting = async () => {
    try { const r = await fetch(`${httpUrl(url)}/rooms/live`); if (r.ok) { waitingBy = ((await r.json()) as { byStake?: Record<string, number> }).byStake ?? {}; if (!roomInfo && !joinAsk) draw(); } } catch { /* the counts are a nicety */ }
  };
  void fetchWaiting();
  const waitTimer = window.setInterval(() => { if (!root.isConnected) { clearInterval(waitTimer); return; } if (!roomInfo) void fetchWaiting(); }, 10_000);
  void import('../site/kit').then((k) => k.armoury()).then((a) => { if (a) { zpHave = a.cash; if (!roomInfo) draw(); } }, () => {});
  /** Alone in a free room for a minute: offer a solo night while the seat is kept. */
  let quiet = false, quietTimer = -1;
  /** Playing that solo night with the lobby hidden; `soloOn` stays set once one was started (Back lets it carry on). */
  let away = false, soloOn = false;
  let waitBar: HTMLElement | null = null;
  function watchQuiet(): void {
    const lonely = !!roomInfo && !roomInfo.onChain && roomInfo.state === 'lobby' && roomInfo.seats.length < 2;
    if (!lonely) { clearTimeout(quietTimer); quietTimer = -1; quiet = false; return; }
    if (quietTimer < 0 && !quiet) quietTimer = window.setTimeout(() => { quietTimer = -1; quiet = true; if (!away) draw(); }, 60_000);
  }
  /** The bar over the solo night: how the room stands, and the way back to it. */
  function banner(joined: boolean): void {
    if (!waitBar) { waitBar = el('div', { id: 'mp-wait' }); document.body.appendChild(waitBar); }
    const r = roomInfo;
    const n = r?.seats.length ?? 0;
    const text = !r ? 'Lost your room.' : n > 1 ? `Someone joined your room · ${n} of ${ROOM_PLAYERS_MAX}` : `Your room is waiting · 1 of ${ROOM_PLAYERS_MAX}`;
    const btn = el('button', {}, !r ? 'Back' : n > 1 ? 'Go to room' : 'Back to room');
    btn.onclick = () => {
      away = false; waitBar?.remove(); waitBar = null;
      host.holdSolo(true);
      root.style.display = '';
      draw();
    };
    waitBar.className = n > 1 || !r ? 'hot' : '';
    waitBar.replaceChildren(el('span', {}, text), btn);
    if (joined && n > 1) host.toast('Someone joined your room');
  }

  function draw(): void {
    root.replaceChildren();
    root.append(el('h2', {}, 'Multiplayer'));
    if (!roomInfo && joinAsk) {
      // a ZP room by its code: say what it costs before anything is taken
      const a = joinAsk;
      root.append(el('p', {}, `Room ${a.code} is a ZP room`), el('div', { class: 'code-big' }, `${a.zp} ZP`),
        el('small', {}, `Everyone stakes ${a.zp} ZP. ${a.seats} in it now, pot ${a.pot.toLocaleString()} ZP. Those who get out split the pot, less 5%; if nobody gets out, every stake comes back. Leaving before the start gives yours back.${zpHave !== null ? ` You have ${zpHave.toLocaleString()} ZP.` : ''}`));
      const yes = el('button', {}, `Stake ${a.zp} ZP and join`);
      if (zpHave !== null && zpHave < a.zp) yes.disabled = true;
      yes.onclick = () => { joinAsk = null; connect(() => send({ t: 'join', code: a.code, zp: a.zp })); draw(); };
      const no = el('button', { class: 'ghost' }, 'Not now');
      no.onclick = () => { joinAsk = null; draw(); };
      root.append(yes, no, el('div', { class: 'err' }, err));
      return;
    }
    if (!roomInfo) {
      root.append(el('p', {}, 'Survive together. Not everyone gets out.'));
      if (!me) {
        // rooms are for signed-in players only (the server refuses guests too): a name on the board, a seat to come back to
        root.append(el('small', {}, invite ? `You were invited to room ${invite}. Sign in to join it.` : 'Sign in to play with others. It is free.'));
        const signedIn = (a: Account) => { me = a; ws?.close(); ws = null; if (invite) { const c = invite; connect(() => send({ t: 'join', code: c })); } draw(); };
        if ((window as unknown as { ethereum?: unknown }).ethereum) {
          const si = el('button', {}, 'Sign in with wallet');
          si.onclick = async () => { si.disabled = true; try { signedIn(await signIn(httpUrl(url))); } catch (e) { err = e instanceof Error ? e.message : 'Sign-in failed.'; draw(); } };
          root.append(si);
        }
        if (socialAvailable()) {
          for (const how of ['google', 'passkey'] as const) {
            const b = el('button', { class: 'ghost' }, how === 'google' ? 'Sign in with Google' : 'Sign in with a passkey');
            b.onclick = async () => { b.disabled = true; try { signedIn(await signInSocial(httpUrl(url), how)); } catch (e) { err = e instanceof Error ? e.message : 'Sign-in failed.'; draw(); } };
            root.append(b);
          }
        }
      } else {
        // the server seats you under your username when you have one: only an account without one is asked
        const nm = me.name ? null : el('input', { placeholder: 'Your name', maxlength: '20', value: name() });
        nm?.addEventListener('input', () => localStorage.setItem(KEY_NAME, nm.value.trim()));
        // what to stake: nothing (a free room) or ZP, the game's currency; those who get out split the pot
        const pick = el('div', { class: 'row stakes' });
        pick.append(el('small', {}, 'Stake'));
        for (const v of [null, ...ZP_STAKES]) {
          const n = waitingBy[v === null ? 'free' : String(v)] ?? 0;
          const b = el('button', { class: stake === v ? 'on' : 'ghost' }, `${v === null ? 'Free' : `${v} ZP`}${n ? ` · ${n} waiting` : ''}`);
          if (v !== null && zpHave !== null && zpHave < v) b.disabled = true;
          b.onclick = () => { stake = v; zpNote = ''; draw(); };
          pick.append(b);
        }
        const tail = stake ? ` · ${stake} ZP` : '';
        const quick = el('button', {}, `Join a public room${tail}`);
        quick.onclick = () => connect(() => send(stake ? { t: 'quick', zp: stake } : { t: 'quick' }));
        const mk = el('button', { class: 'ghost' }, `New private room${tail}`);
        mk.onclick = () => connect(() => send(stake ? { t: 'create', zp: stake } : { t: 'create' }));
        const code = el('input', { class: 'code', placeholder: 'CODE', maxlength: '5', value: invite ?? '' });
        const jn = el('button', { class: 'ghost' }, 'Join');
        jn.onclick = () => { if (code.value.trim().length === 5) connect(() => send({ t: 'join', code: code.value.trim() })); };
        const row = el('div', { class: 'row' });
        row.append(code, jn);
        if (nm) root.append(nm);
        root.append(pick, el('small', {}, stake
          ? `Everyone stakes ${stake} ZP. Those who get out split the pot, less 5%. If nobody gets out, everyone gets their stake back.${zpHave !== null ? ` You have ${zpHave.toLocaleString()} ZP.` : ''}`
          : `A free room: nothing at stake.${zpHave !== null ? ` You have ${zpHave.toLocaleString()} ZP to stake.` : ''}`));
        if (zpNote) root.append(el('p', {}, zpNote));
        root.append(quick, mk, row, el('small', {}, `Signed in${me.name ? ` as ${me.name}` : ''}. A public room puts you with whoever is waiting; a private room is joined by its code or your invite link.`));
      }
      root.append(el('small', {}, 'Free rooms. 2 to 8 players, one exit with seats for half of you.'));
      if (stacks.length && me && (window as unknown as { ethereum?: unknown }).ethereum) {
        const cur = stacks[pick]!, unit = cur.symbol;
        root.append(el('p', {}, 'Staked rooms'));
        if (stacks.length > 1) { // USDm or USDT: each has its own contract, and its own room numbers
          const tok = el('div', { class: 'row' });
          stacks.forEach((c, i) => { const b = el('button', { class: i === pick ? '' : 'ghost' }, c.symbol); b.onclick = () => { pick = i; draw(); }; tok.append(b); });
          root.append(tok);
        }
        const amt = el('input', { placeholder: 'Stake', value: '0.05', inputmode: 'decimal' });
        const size = el('input', { placeholder: 'Players', value: '4', inputmode: 'numeric', maxlength: '1' });
        const mkS = el('button', {}, 'New staked room');
        mkS.disabled = note !== '';
        mkS.onclick = () => void chainStep('Confirm in your wallet…', async (m, cfg) => {
          const n = Number(size.value);
          if (!(n >= 2 && n <= 8)) throw new Error('2 to 8 players.');
          const id = await m.createStaked(cfg, n, m.parseAmount(amt.value, cfg.decimals));
          note = 'Taking your seat…'; seatIn(cfg.symbol, id);
        });
        const idIn = el('input', { class: 'code', placeholder: 'ROOM #', maxlength: '12', inputmode: 'numeric', value: stakedInvite && stakedInvite.symbol === unit ? stakedInvite.id : '' });
        const jnS = el('button', { class: 'ghost' }, 'Join');
        jnS.disabled = note !== '';
        jnS.onclick = () => void chainStep('Confirm in your wallet…', async (m, cfg) => {
          if (!/^\d{1,12}$/.test(idIn.value.trim())) throw new Error('Enter the room number.');
          const id = BigInt(idIn.value.trim());
          await m.joinStaked(cfg, id);
          note = 'Taking your seat…'; seatIn(cfg.symbol, id);
        });
        const r3 = el('div', { class: 'row' });
        r3.append(idIn, jnS);
        const sizes = el('div', { class: 'row' });
        sizes.append(el('small', {}, `Stake (${unit})`), amt, el('small', {}, 'Players'), size);
        root.append(sizes, mkS, r3, el('small', {}, 'You can lose your stake. Players who get out split the pot less a 1.5% fee; if nobody gets out, everyone is refunded. The server plays the round, not a person, and the whole round is kept so it can be checked.'));
        if (note) root.append(el('p', {}, note));
      }
    } else {
      const r = roomInfo;
      root.append(el('p', {}, r.onChain ? `Staked room (${r.stack ?? ''})` : r.public ? 'Public room · code' : 'Private room · code'), el('div', { class: 'code-big' }, r.onChain ? `#${r.onChain}` : r.code));
      if (!r.onChain && r.state === 'lobby') root.append(el('small', {}, `${r.seats.length} of ${ROOM_PLAYERS_MAX} · ${r.seats.length < 2 ? 'waiting for players' : 'ready when the host is'}`));
      if (r.zp) root.append(el('p', { class: 'pot' }, `${r.zp} ZP each · pot ${(r.pot ?? 0).toLocaleString()} ZP`), el('small', {}, 'Those who get out split the pot, less 5%. Nobody out: every stake back. Leaving before the start gives yours back.'));
      const list = el('ul');
      for (const s of r.seats as SeatInfo[]) {
        const li = el('li', s.connected ? {} : { class: 'off' }, `${s.name}${s.signedIn ? ' ✓' : ''}${s.seat === r.you ? ' (you)' : ''}${s.seat === r.host ? ' — host' : ''}`);
        list.append(li);
      }
      root.append(list);
      if (r.startsIn !== null) root.append(el('p', {}, `Starting in ${r.startsIn}…`));
      const host_ = r.you === r.host;
      const start = el('button', {}, host_ ? 'Start' : 'Waiting for the host');
      start.disabled = !host_ || r.seats.length < 2 || note !== '';
      start.onclick = () => { if (r.onChain) void chainStep('Confirm in your wallet…', (m, cfg) => m.startStaked(cfg, BigInt(r.onChain!)), r.stack); else send({ t: 'start' }); };
      const leave = el('button', { class: 'ghost' }, 'Leave');
      leave.onclick = () => {
        send({ t: 'leave' }); roomInfo = null; watchQuiet();
        if (r.onChain) { // a waiting room hands the stake back: the host cancels it, anyone else leaves it
          void chainStep('Getting your stake back…', (m, cfg) => (host_ ? m.cancelStaked(cfg, BigInt(r.onChain!)) : m.leaveStaked(cfg, BigInt(r.onChain!))), r.stack);
        } else draw();
      };
      const alone = r.seats.length < 2;
      if (alone) start.className = 'ghost'; // nothing to start yet: bringing someone in is the next step
      const share = el('button', alone ? {} : { class: 'ghost' }, 'Share invite');
      share.onclick = () => void shareInvite(r.onChain ? { staked: `${r.stack}:${r.onChain}` } : { join: r.code });
      root.append(start, share, leave, el('small', {}, r.onChain
        ? 'Staked: the host closes the doors on the chain, and the round starts when the chain says so. Leaving gets your stake back while the room is waiting.'
        : r.public
          ? 'Anyone who picks Join a public room lands here. The round starts when the host says, or 20 seconds after four are in.'
          : 'Only people with the code or your invite can join. The round starts when the host says, or 20 seconds after four are in.'));
      if (quiet && alone && !r.onChain) {
        const box = el('div', { class: 'quiet' });
        const go = el('button', {}, 'Play while I wait');
        go.onclick = () => {
          away = true; soloOn = true;
          root.style.display = 'none';
          host.soloWhileWaiting();
          banner(false);
        };
        box.append(el('p', {}, 'Quiet right now'), el('small', {}, 'Play today\'s city while you wait. You keep your seat, and we call you back the moment someone joins.'), go);
        root.append(box);
      }
      if (note) root.append(el('p', {}, note));
      if (linkShown) { // shown as typed (the lobby's capitals would break it), selected on a tap
        root.append(el('p', {}, shareNote));
        const box = el('input', { class: 'link', readonly: '', value: linkShown });
        box.addEventListener('focus', () => box.select());
        root.append(box);
      }
    }
    root.append(el('div', { class: 'err' }, err));
    const back = el('button', { class: 'ghost' }, 'Back');
    back.onclick = () => { ws?.close(); root.remove(); if (soloOn) host.holdSolo(false); };
    if (!roomInfo) root.append(back);
  }
  let linkShown: string | null = null;
  let shareNote = ''; // apart from `note`, which locks the buttons while a wallet step runs
  /** A link that opens the game straight into this room: the phone's share sheet (WhatsApp and the rest) where there is one, else copied. */
  async function shareInvite(q: { join?: string; staked?: string }): Promise<void> {
    const u = new URL(location.href);
    u.search = '';
    const keep = new URLSearchParams(location.search).get('server');
    if (keep) u.searchParams.set('server', keep);
    if (q.join) u.searchParams.set('join', q.join);
    if (q.staked) u.searchParams.set('staked', q.staked);
    const text = q.staked ? 'A staked room in Zombie Plague. Not everyone gets out.' : `Room ${q.join} in Zombie Plague. Not everyone gets out.`;
    const link = u.toString();
    // the link goes on screen at once, whatever the share sheet does: some wallet browsers have one that never opens or never answers
    linkShown = link; shareNote = 'Send this link:';
    draw();
    const copy = async (): Promise<boolean> => {
      try { await navigator.clipboard.writeText(`${text} ${link}`); return true; } catch { return false; }
    };
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    const touch = matchMedia('(pointer: coarse)').matches;
    if (nav.share && touch) {
      try { await nav.share({ title: 'Zombie Plague', text, url: link }); return; } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return; // they closed the sheet: the link is still there
      }
    }
    if (await copy()) { shareNote = 'Invite link copied. Paste it to your friends:'; draw(); }
  }

  draw();
  if (invite && me) connect(() => send({ t: 'join', code: invite }));
  else if (me && opts.act) { const t = opts.act; connect(() => send({ t })); } // the site's Quick play / Private room
}

// ---------------------------------------------------------------- the round

interface Snap { t: number; arrived: number; v: PlayerView }

/** One round, from `begin` to the end screen. */
class Session implements Driver {
  private shadow: GameState;
  private local: Player;
  private decode = makeDecoder();
  private snaps: Snap[] = [];
  private pending: Array<{ seq: number; input: Input }> = [];
  private seq = 0;
  private acc = 0;
  private events: GameEvent[] = [];
  /** The player's true (predicted) position; what is drawn is this plus a correction that fades. */
  private truth = { x: 0, y: 0 };
  private off = { x: 0, y: 0 };
  private zombies = new Map<number, Zombie>();
  private actors = new Map<number, Actor>();
  private skins = new Map<number, string>();
  private names: HTMLElement;
  private hud: HTMLElement;
  private over = false;
  private firstSnap = true;
  /** Who each seat plays (null: Sam). */
  private sv: Array<string | null> = [];

  constructor(private host: Host, private ws: WebSocket, begin: Extract<ServerMsg, { t: 'begin' }>) {
    this.shadow = createRoom(begin.seed, begin.players);
    this.local = this.shadow.players[begin.seat]!;
    this.shadow.cur = this.local;
    this.truth = { ...this.local.pos };
    this.names = el('div', { id: 'names' });
    this.hud = el('div', { id: 'roomhud' });
    document.body.append(this.names, this.hud);
    host.enter(this.shadow, this, begin.sv?.[begin.seat] ?? null);
    // the others' survivors: their skins are fetched now, and worn as soon as they are in
    this.sv = begin.sv ?? [];
    for (const id of this.sv) { const sk = id ? SURVIVORS[id as SurvivorId]?.skin : null; if (sk) void loadSkin(host.view.assets, sk as SkinName); }
    host.toast('Get the steps done and reach the exit. Seats are limited.');
  }

  message(m: ServerMsg): void {
    if (m.t === 'snap') { const v = this.decode(m.w); this.snaps.push({ t: m.tick * ROOM_DT, arrived: performance.now() / 1000, v }); if (this.snaps.length > 12) this.snaps.shift(); this.reconcile(v, m.ack); this.events.push(...v.events); }
    else if (m.t === 'room') this.roomNames = m.seats.map((x) => x.name);
    else if (m.t === 'end') this.showEnd(m);
    else if (m.t === 'zp') this.zpResult(m);
    else if (m.t === 'err' && m.code === 'rate') this.host.toast('Sending too fast.');
  }

  dropped(): void {
    if (!this.over) { this.host.toast('Disconnected from the server.'); this.showEnd(null); }
  }

  /** The server's word on where you are and what you carry: take it, then re-run the inputs it has not seen yet. */
  private reconcile(v: PlayerView, ack: number): void {
    const p = this.local, s = this.shadow;
    const { pos, vel, heading, ...rest } = v.you as unknown as Record<string, unknown> & { pos: { x: number; y: number }; vel: { x: number; y: number }; heading: number };
    const was = { x: this.truth.x + this.off.x, y: this.truth.y + this.off.y }; // where it was drawn
    Object.assign(p, rest);
    p.pos = { x: pos.x, y: pos.y };
    p.vel = { x: vel.x, y: vel.y };
    p.heading = heading;
    this.pending = this.pending.filter((x) => x.seq > ack);
    if (p.status === 'alive' || p.status === 'turned') for (const x of this.pending) movePlayer(s, x.input, ROOM_DT);
    this.truth = { x: p.pos.x, y: p.pos.y };
    const ex = was.x - this.truth.x, ey = was.y - this.truth.y;
    if (DEBUG && !this.firstSnap) ((window as unknown as { __mpErr?: number[] }).__mpErr ??= []).push(Math.hypot(ex, ey)); // how far off the prediction was
    if (this.firstSnap || Math.hypot(ex, ey) > SNAP_BEYOND) this.off = { x: 0, y: 0 }; // a jump (a first fix, a knock-back): do not slide
    else this.off = { x: ex, y: ey };
    this.firstSnap = false;
    // the district's changing parts
    s.phase = v.phase;
    v.taken.forEach((t, i) => { const k = s.pickups[i]; if (k) k.taken = t; });
    v.opened.forEach((t, i) => { const k = s.crates[i]; if (k) k.opened = t; });
    v.searched.forEach((t, i) => { const k = s.houses[i]; if (k) k.searched = t; });
    for (const t of v.tasks) { const k = s.tasks.find((x) => x.id === t.id); if (k) { k.done = t.done; if (t.got) k.got = t.got; if (t.targets) k.targets = t.targets; } }
    s.safehouseKnown = v.safehouseKnown;
    s.flare = v.flare;
    s.tier = v.tier;
    s.fallenN = v.fallen;
    s.seatsLeft = v.seatsLeft;
    s.elapsed = s.roomLimit - v.roomRemaining;
    s.corpses = v.corpses;
    this.host.refreshStore();
  }

  act(c: Command): boolean {
    this.send({ t: 'cmd', c });
    return true;
  }

  private send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  frame(dt: number): GameEvent[] {
    const p = this.local, s = this.shadow;
    // inputs go out at the server's tick rate, and are walked locally at once
    this.acc += dt;
    for (let n = 0; this.acc >= ROOM_DT && n < 4; n++) {
      this.acc -= ROOM_DT;
      const input = quantize(this.host.controls.read());
      const seq = ++this.seq;
      const b = (input.action ? 1 : 0) | (input.fire ? 2 : 0) | (input.reload ? 4 : 0) | (input.swap ? 8 : 0) | (input.throw ? 16 : 0) | (input.light ? 32 : 0) | (input.crouch ? 64 : 0);
      this.send({ t: 'in', seq, i: [Math.round(input.dx * 64), Math.round(input.dy * 64), b] });
      this.pending.push({ seq, input });
      if (this.pending.length > 90) this.pending.shift();
      if (!this.over && (p.status === 'alive' || p.status === 'turned') && !(p.hold.taskId || p.work)) {
        p.pos = { x: this.truth.x, y: this.truth.y };
        movePlayer(s, input, ROOM_DT);
        this.truth = { x: p.pos.x, y: p.pos.y };
      }
    }
    if (this.acc > ROOM_DT) this.acc = 0;
    this.off.x *= Math.exp(-dt / EASE);
    this.off.y *= Math.exp(-dt / EASE);
    p.pos = { x: this.truth.x + this.off.x, y: this.truth.y + this.off.y };

    this.drawOthers(dt);
    this.labels();
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Everyone but you, a little in the past, between the two snapshots either side of that moment. */
  private drawOthers(dt: number): void {
    const s = this.shadow;
    const newest = this.snaps[this.snaps.length - 1];
    if (!newest) return;
    const now = performance.now() / 1000;
    const when = newest.t + (now - newest.arrived) - RENDER_DELAY; // in the server's time
    let a = newest, b = newest;
    for (let i = this.snaps.length - 1; i >= 0; i--) { if (this.snaps[i]!.t <= when) { a = this.snaps[i]!; b = this.snaps[i + 1] ?? a; break; } a = this.snaps[i]!; b = this.snaps[i + 1] ?? a; }
    const k = b.t > a.t ? Math.max(0, Math.min(1, (when - a.t) / (b.t - a.t))) : 1;
    const lerp = (x: number, y: number) => x + (y - x) * k;
    const arc = (x: number, y: number) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * k;

    // zombies
    const before = new Map(a.v.zombies.map((z) => [z.id, z]));
    const live: Zombie[] = [];
    for (const z of b.v.zombies) {
      const o = before.get(z.id);
      let zz = this.zombies.get(z.id);
      if (!zz) {
        zz = { id: z.id, kind: z.kind, pos: { x: z.pos.x, y: z.pos.y }, heading: z.heading, speed: 0, action: z.action, actionT: 0, cooldown: 0, health: ZOMBIE_HEALTH[z.kind], staggerT: 0, alertT: 0, wanderT: 0, wanderDir: { x: 0, y: 0 } };
        this.zombies.set(z.id, zz);
      }
      zz.kind = z.kind;
      zz.pos.x = o ? lerp(o.pos.x, z.pos.x) : z.pos.x;
      zz.pos.y = o ? lerp(o.pos.y, z.pos.y) : z.pos.y;
      zz.heading = o ? arc(o.heading, z.heading) : z.heading;
      zz.speed = z.speed;
      zz.action = z.action;
      zz.staggerT = z.staggerT;
      zz.frozen = z.frozen;
      zz.roof = z.roof;
      live.push(zz);
    }
    for (const id of this.zombies.keys()) if (!b.v.zombies.some((z) => z.id === id)) this.zombies.delete(id);
    s.zombies = live;

    // other players
    const seen = new Set<number>();
    const prev = new Map(a.v.others.map((o) => [o.id, o]));
    for (const o of b.v.others) {
      seen.add(o.id);
      const p = s.players[o.id]!, q = prev.get(o.id);
      p.pos = { x: q ? lerp(q.pos.x, o.pos.x) : o.pos.x, y: q ? lerp(q.pos.y, o.pos.y) : o.pos.y };
      p.heading = q ? arc(q.heading, o.heading) : o.heading;
      p.status = o.status;
      p.light = o.light;
      p.exposed = o.exposed;
      p.crouched = o.crouched;
      p.hide = o.hidden ? 0 : null;
      p.roof = o.roof;
      p.arsenal.weapon = o.weapon;
      let act = this.actors.get(o.id);
      const own = this.sv[o.id] ? SURVIVORS[this.sv[o.id] as SurvivorId]?.skin as SkinName | undefined : undefined;
      const skin: SkinName = o.status === 'turned' ? (o.id % 2 ? 'zombieFemaleA' : 'zombieMaleA') : own && this.host.view.assets.materials[own] ? own : o.id % 2 ? 'humanFemaleA' : 'humanMaleA';
      if (!act) {
        act = new Actor(this.host.view.assets, skin);
        act.play('Idle', { fade: 0 });
        this.host.view.scene.add(act.root);
        this.actors.set(o.id, act);
        this.skins.set(o.id, skin);
      } else if (this.skins.get(o.id) !== skin) { act.setSkin(skin); this.skins.set(o.id, skin); } // a player who turns looks like one of them
      act.root.visible = true;
      const sp = Math.hypot(p.pos.x - (act.root.position.x), p.pos.y - act.root.position.z) / Math.max(dt, 1e-3);
      if (o.status === 'down' || o.status === 'dead') act.play('Death', { once: true, fade: 0.15 });
      else if (o.status === 'turned') { act.play(sp > 0.5 ? 'Sprint' : 'ZIdle', { fade: 0.15 }); }
      else if (o.hidden || (o.crouched && sp < 0.3)) act.play('Kneel', { startAt: 0.12, timeScale: 0.0001, fade: 0.25 }); // down low
      else act.locomote(Math.min(5.5, sp));
      act.update(p.pos.x, p.pos.y, p.heading, dt, true);
      act.root.position.y = o.roof !== null ? s.map.ladders[o.roof]?.height ?? 0 : 0; // up on a roof
      act.root.rotation.x = o.crouched && sp >= 0.3 ? 0.32 : 0;
    }
    for (const [id, act] of this.actors) if (!seen.has(id)) act.root.visible = false; // out of sight: not drawn
  }

  /** Names over the heads of the players you can see. */
  private labels(): void {
    const s = this.shadow;
    const spans = Array.from(this.names.children) as HTMLElement[];
    let n = 0;
    for (const [id, act] of this.actors) {
      if (!act.root.visible) continue;
      const p = s.players[id]!;
      const at = this.host.view.projectPx(p.pos, 3.4);
      if (!at) continue;
      const sp = spans[n] ?? this.names.appendChild(el('span'));
      sp.textContent = `${this.roomNames[id] ?? `Player ${id + 1}`}${p.status === 'turned' ? ' (turned)' : p.status === 'down' ? ' (down)' : p.exposed ? ' (bitten)' : ''}`;
      sp.className = p.status === 'turned' ? 'turned' : '';
      sp.style.left = `${at.x}px`;
      sp.style.top = `${at.y}px`;
      sp.style.display = 'block';
      n++;
    }
    for (let i = n; i < spans.length; i++) spans[i]!.style.display = 'none';
    const left = Math.max(0, Math.ceil(this.shadow.roomLimit - this.shadow.elapsed));
    this.hud.innerHTML = `ROUND <b>${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</b> · EXIT SEATS <b>${s.seatsLeft}</b>${this.local.status === 'turned' ? ' · <b>YOU HAVE TURNED</b>' : this.local.status === 'down' ? ' · <b>DOWN</b>' : this.local.status === 'escaped' ? ' · <b>YOU ARE OUT</b>' : ''}`;
  }
  private roomNames: string[] = [];

  setNames(names: string[]): void { this.roomNames = names; }

  /** A ZP room's pay-out, under the placings (it comes right after the end). */
  private zpResult(m: Extract<ServerMsg, { t: 'zp' }>): void {
    const text = m.got > m.stake ? `You won ${m.got.toLocaleString()} ZP` : m.got === m.stake ? `Your ${m.stake} ZP stake came back` : `Your ${m.stake} ZP stake is lost`;
    this.host.toast(text);
    const box = document.getElementById('roomend');
    const back = box?.querySelector('button');
    if (box && back) back.before(el('p', { class: m.got > m.stake ? 'won' : '' }, text));
  }

  private showEnd(m: Extract<ServerMsg, { t: 'end' }> | null): void {
    if (this.over) return;
    this.over = true;
    const box = document.getElementById('roomend') ?? document.body.appendChild(el('div', { id: 'roomend' }));
    box.replaceChildren();
    const status = (st: string) => ({ escaped: 'got out', turned: 'turned', dead: 'put down', missed: 'left behind', alive: 'left behind', down: 'left behind' } as Record<string, string>)[st] ?? st;
    const out = m?.placements.find((p) => p.seat === this.local.id)?.status === 'escaped';
    box.append(el('h2', {}, m ? (out ? 'You got out' : 'You did not get out') : 'Disconnected'));
    if (m) {
      const list = el('ol');
      m.placements.forEach((p, i) => {
        const li = el('li', p.seat === this.local.id ? { class: 'me' } : {});
        li.append(el('span', {}, `${i + 1}. ${this.roomNames[p.seat] ?? `Player ${p.seat + 1}`}`), el('span', {}, `${status(p.status)} · ${p.kills} down`));
        list.append(li);
      });
      box.append(list);
    }
    const again = el('button', {}, 'Back to the menu');
    again.onclick = () => location.reload();
    box.append(again);
    box.style.display = 'flex';
  }
}
