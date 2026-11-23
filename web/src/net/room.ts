// Playing in a room, in the browser. Loaded only when someone taps Multiplayer.
//
// The server runs the game. This builds the same district from the seed the server gives (createRoom, so every map,
// step and crate is in the right place without being sent) and keeps that state as a *shadow*: nothing here runs the
// rules except one thing, walking. The player's own walking is predicted from their inputs so the controls answer at
// once, then corrected when the server's word on where they are comes back. Everyone and everything else is drawn
// a little in the past, between the two snapshots either side of that moment, so it moves smoothly.
import { movePlayer, createRoom, playerVehicle, predictVehicle, type GameState } from '../../../core/state';
import { SURVIVORS, type SurvivorId } from '../../../core/survivors';
import { quantize, type Command } from '../../../core/replay';
import { content } from '../../../core/content';
import type { GameEvent, Input, Player, Zombie } from '../../../core/types';
import type { PlayerView } from '../../../core/view';
import type { GameView } from '../render/view';
import type { Controls } from '../input/controls';
import { Actor, loadSkin, type SkinName } from '../render/characters';
import { makeDecoder } from '../../../core/codec';
import { ROOM_DT, type ClientMsg, type Eligibility, type OpenRoom, type SeatInfo, type ServerMsg } from '../../../core/protocol';
import { ROOM_PLAYERS_MAX, ROOM_TASKS, ZOMBIE_HEALTH } from '../../../core/config';
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
#mp { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 20px 16px;
  background: radial-gradient(ellipse at 50% 30%, rgba(40,10,8,.55), rgba(4,6,4,.96) 70%); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
  font: 16px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #d4c9b2; overflow-y: auto; }
#mp .mp-card { width: min(520px, 100%); margin: auto; display: flex; flex-direction: column; gap: 16px; padding: 26px 24px 20px; border-radius: 16px;
  background: linear-gradient(180deg, #0e160d, #070b07); border: 1px solid rgba(107,142,35,.3); box-shadow: 0 24px 60px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.4) inset; }
#mp .mp-kicker { font: 15px 'VT323', monospace; letter-spacing: .28em; text-transform: uppercase; color: #e0483a; }
#mp h2 { margin: -6px 0 0; font: 400 clamp(28px, 6vw, 38px)/1.1 'Eater', system-ui, sans-serif; letter-spacing: .03em; color: #efe6d2; text-shadow: 0 0 18px rgba(230,51,41,.35); }
#mp .mp-lead { margin: -6px 0 0; color: #a0b294; }
#mp .mp-label { font: 15px 'VT323', monospace; letter-spacing: .2em; text-transform: uppercase; color: #6b8e23; margin-bottom: 8px; }
#mp .mp-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
#mp .mp-chip { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 9px 6px; border-radius: 10px; cursor: pointer; font: inherit;
  background: #0b110a; border: 1px solid rgba(107,142,35,.35); color: #d4c9b2; }
#mp .mp-chip b { font: 22px/1 'VT323', monospace; letter-spacing: .06em; color: #efe6d2; }
#mp .mp-chip small { font-size: 12px; color: #7d9a72; }
#mp .mp-chip.on { background: rgba(107,142,35,.22); border-color: #9bd34a; box-shadow: 0 0 0 1px #9bd34a inset; }
#mp .mp-chip.on small { color: #c8e07a; }
#mp .mp-chip:disabled { opacity: .35; cursor: default; }
#mp .mp-note { padding: 11px 13px; border-radius: 10px; background: rgba(107,142,35,.07); border: 1px solid rgba(107,142,35,.18); color: #b5c4a8; font-size: 14px; }
#mp .mp-note b { color: #efe6d2; font-weight: 600; }
#mp .mp-note.gold { background: rgba(242,182,48,.07); border-color: rgba(242,182,48,.25); }
#mp .mp-btn { font: 700 22px 'VT323', monospace; letter-spacing: .16em; text-transform: uppercase; padding: 11px 18px; border-radius: 10px; cursor: pointer;
  border: 2px solid #6b8e23; background: #6b8e23; color: #060b06; width: 100%; }
#mp .mp-btn:not(:disabled):hover { filter: brightness(1.1); }
#mp .mp-btn.ghost { background: transparent; color: #b5d07a; }
#mp .mp-btn:disabled { opacity: .4; cursor: default; }
#mp .mp-row { display: flex; gap: 10px; } #mp .mp-row > * { flex: 1; }
#mp .mp-row .mp-btn { font-size: 19px; letter-spacing: .1em; padding: 11px 10px; white-space: nowrap; }
#mp .mp-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 4px; border-top: 1px solid rgba(107,142,35,.15); }
#mp .mp-link { background: none; border: 0; padding: 6px 0; font: 17px 'VT323', monospace; letter-spacing: .12em; text-transform: uppercase; color: #a0bb94; cursor: pointer; }
#mp .mp-link:hover { color: #efe6d2; }
#mp .mp-bal { font: 17px 'VT323', monospace; letter-spacing: .08em; color: #7d9a72; } #mp .mp-bal b { color: #e8c86a; font-weight: 400; }
#mp .mp-tabs { display: flex; gap: 6px; padding: 4px; border-radius: 10px; background: #0a0f09; border: 1px solid rgba(107,142,35,.2); }
#mp .mp-tabs button { flex: 1; font: 18px 'VT323', monospace; letter-spacing: .14em; text-transform: uppercase; padding: 6px; border: 0; border-radius: 7px; background: none; color: #8fa785; cursor: pointer; }
#mp .mp-tabs button.on { background: #6b8e23; color: #060b06; }
#mp input { font: inherit; background: #0b0f0b; color: #efe6d2; border: 1px solid rgba(107,142,35,.45); border-radius: 8px; padding: 9px 11px; width: 100%; min-width: 0; }
#mp input.link { font-size: 13px; }
#mp input.code { text-transform: uppercase; letter-spacing: .3em; font-family: 'VT323', monospace; font-size: 22px; text-align: center; }
#mp .mp-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #8fa785; }
#mp .mp-code { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
#mp .mp-code b { font: 400 clamp(40px, 11vw, 60px)/1 'VT323', monospace; letter-spacing: .3em; color: #efe6d2; }
#mp .mp-status { font: 18px 'VT323', monospace; letter-spacing: .1em; color: #c8e07a; text-align: right; }
#mp .mp-status.wait { color: #e8c86a; }
#mp .mp-seats { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
#mp .mp-seats li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 9px; background: #0b110a; border: 1px solid rgba(107,142,35,.15); }
#mp .mp-seats li.off { opacity: .45; }
#mp .mp-seats .av { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font: 600 13px system-ui; color: #060b06; background: #8fb34a; }
#mp .mp-seats .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #efe6d2; }
#mp .mp-seats .tg { font: 14px 'VT323', monospace; letter-spacing: .14em; text-transform: uppercase; color: #8fa785; }
#mp .mp-seats .mp-btn.sm { flex: none; font-size: 17px; padding: 5px 14px; letter-spacing: .1em; }
#mp .mp-seats li.empty { justify-content: center; color: #5d6f55; border-style: dashed; font-size: 13px; }
#mp .err { color: #ff7a6b; font-size: 14px; } #mp .err:empty { display: none; }
#mp .ok { color: #c8e07a; font-size: 14px; }
#mp .quiet { border: 1px dashed rgba(107,142,35,.4); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
#mp .quiet b { color: #efe6d2; }
#mp .mp-spin { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(155,211,74,.3); border-top-color: #9bd34a; border-radius: 50%; animation: mp-spin .8s linear infinite; vertical-align: -2px; margin-right: 8px; }
@keyframes mp-spin { to { transform: rotate(360deg); } }
@media (max-width: 420px) { #mp .mp-card { padding: 20px 16px 16px; } #mp .mp-row { flex-direction: column; } }
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
#roomend.turned { background: radial-gradient(ellipse at 50% 45%, rgba(0,0,0,.35), rgba(0,0,0,.88) 75%), url(/ending/end.webp) center 30%/cover #050505; }
#roomend.turned h2, #roomend.turned li, #roomend.turned p { text-shadow: 0 2px 12px #000, 0 0 3px #000; }
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
  'not-eligible': 'Staked rooms need an account that is a day old, with three nights that passed their replay check, none failed in the last 7 days, and not already in a staked room.',
  'no-chain': 'The server could not read the chain. Try again.',
  signin: 'Sign in to play with others.',
  'no-zp': 'Not enough ZP for that stake. Play a night, or top up in the Armoury.',
  'zp-off': 'ZP rooms are not open on this server yet.',
};
/** Why a player may not sit in a staked room yet, and when that clears: said before any money moves. */
export function eligText(e: Eligibility): string {
  if (e.ok) return '';
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  switch (e.why) {
    case 'signin': return 'Sign in to stake.';
    case 'off': return 'Staked rooms are not open yet.';
    case 'busy': return 'You are already in a staked room. Finish or leave that one first.';
    case 'new': return `Your account is new. Staked rooms open to it on ${when(e.until)}.`;
    case 'runs': return `Finish ${e.need - e.have} more ${e.need - e.have === 1 ? 'night' : 'nights'} (solo, signed in) to unlock staked rooms: ${e.have} of ${e.need} so far.`;
    case 'failed': return `One of your recent nights failed its replay check, so staked rooms are closed to you until ${when(e.until)}. Free and ZP rooms are open.`;
  }
}

/** The ZP stakes on offer (the server's list: server/src/zp.ts). */
const ZP_STAKES = [50, 100, 250, 500, 1000] as const;
/** Errors that may only mean the chain has not caught up with a transaction a moment ago: the seat is asked for again. */
const RETRY = new Set(['not-staked', 'no-room', 'no-chain']);

/** The lobby: choose a name, make or join a room, wait for the others, go. Resolves when the round begins. */
export function openLobby(host: Host, opts: { join?: string; staked?: string; act?: 'quick' | 'create' | 'staked' } = {}): void {
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
  /** May this player sit in a staked room? Asked before the wallet is touched; null: not known yet. */
  let elig: Eligibility | null = null;
  const checkElig = async () => {
    if (!me) { elig = { ok: false, why: 'signin' }; draw(); return; }
    try {
      const r = await fetch(`${httpUrl(url)}/staked/eligible`, { headers: { authorization: `Bearer ${me.token}` } });
      elig = r.ok ? (await r.json()) as Eligibility : null;
    } catch { elig = null; } // the server's own check still stands when they sit
    draw();
  };
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
    if (stacks.length) { draw(); void checkElig(); }
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
    ws.onclose = () => { connecting = false; if (!began) { roomInfo = null; if (!err) err = 'Disconnected.'; watchQuiet(); if (away) banner(false); draw(); } };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data as string) as ServerMsg;
      if (m.t === 'room' || m.t === 'err' || m.t === 'confirm') connecting = false; // an answer to join or create
      if (m.t === 'room') { const before = roomInfo?.seats.length ?? 0; roomInfo = m; err = ''; seating = null; watchQuiet(); if (away) banner(m.seats.length > before); draw(); }
      else if (m.t === 'err') {
        if (seating && RETRY.has(m.code) && seating.tries < 12) { seating.tries++; const { stack, id } = seating; setTimeout(() => send({ t: 'staked', stack, roomId: String(id) }), 1500); return; }
        seating = null;
        if (m.elig) elig = m.elig;
        err = (m.elig && eligText(m.elig)) || (ERRORS[m.code] ?? 'Something went wrong.'); draw();
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
  /** Which card opened the lobby: its screen shows only that way to play (Back returns to the Play page for another). */
  const mode: 'quick' | 'create' | 'staked' | 'join' = invite || opts.join ? 'join' : opts.act ?? (stakedInvite ? 'staked' : 'quick');
  /** On Staked rooms: ZP, or the crypto stakes (when the server and this browser can do them). */
  let tab: 'zp' | 'crypto' = stakedInvite ? 'crypto' : 'zp';
  /** A ZP room joined by its code, waiting for the player to agree to its stake. */
  let joinAsk: Extract<ServerMsg, { t: 'confirm' }> | null = null;
  /** Players waiting in public rooms, by stake ('free' for none), and the public rooms still taking players, refreshed while the menu is open. */
  let waitingBy: Record<string, number> = {};
  let openRooms: OpenRoom[] | null = null; // null until the first answer
  /** On the way into a room (asked to join or create, no answer yet): the list is not redrawn under the player's finger. */
  let connecting = false;
  const fetchWaiting = async () => {
    try {
      const r = await fetch(`${httpUrl(url)}/rooms/live`);
      if (r.ok) {
        const j = (await r.json()) as { byStake?: Record<string, number>; open?: OpenRoom[] };
        waitingBy = j.byStake ?? {}; openRooms = j.open ?? [];
        if (!roomInfo && !joinAsk && !connecting) draw();
      }
    } catch { /* the counts are a nicety */ }
  };
  void fetchWaiting();
  const waitTimer = window.setInterval(() => { if (!root.isConnected) { clearInterval(waitTimer); return; } if (!roomInfo) void fetchWaiting(); }, 5_000);
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

  /** A panel: what the screen is about, then its parts. */
  function card(kicker: string, title: string, lead?: string): HTMLDivElement {
    const c = el('div', { class: 'mp-card' });
    c.append(el('div', { class: 'mp-kicker' }, kicker), el('h2', {}, title));
    if (lead) c.append(el('p', { class: 'mp-lead' }, lead));
    root.append(c);
    return c;
  }
  const btn = (text: string, ghost = false) => el('button', { class: ghost ? 'mp-btn ghost' : 'mp-btn' }, text);
  /** Back to the site's Play page, to choose a different way to play. */
  const backTo = () => { const b = el('button', { class: 'mp-link' }, '← Back to Play'); b.onclick = () => { ws?.close(); root.remove(); if (soloOn) host.holdSolo(false); }; return b; };
  function foot(c: HTMLElement): void {
    const f = el('div', { class: 'mp-foot' });
    const b = el('span', { class: 'mp-bal' });
    if (zpHave !== null) { b.textContent = 'You have '; b.append(el('b', {}, `${zpHave.toLocaleString()} ZP`)); }
    f.append(backTo(), b);
    c.append(el('div', { class: 'err' }, err), f);
  }
  /** The stakes, as chips: free (unless `zpOnly`) and each ZP stake, with how many wait at it; the ones you cannot cover are off. */
  function stakeChips(c: HTMLElement, zpOnly: boolean): void {
    const sec = el('div');
    sec.append(el('div', { class: 'mp-label' }, 'Stake'));
    const grid = el('div', { class: 'mp-chips' });
    for (const v of zpOnly ? ZP_STAKES : [null, ...ZP_STAKES]) {
      const n = waitingBy[v === null ? 'free' : String(v)] ?? 0;
      const short = v !== null && zpHave !== null && zpHave < v;
      const b = el('button', { class: `mp-chip${stake === v ? ' on' : ''}` });
      b.append(el('b', {}, v === null ? 'Free' : `${v} ZP`), el('small', {}, short ? `need ${(v! - zpHave!).toLocaleString()} more` : mode === 'create' ? (v === null ? 'nothing at stake' : 'a seat') : n ? `${n} waiting` : 'no room yet'));
      if (short) b.disabled = true;
      b.onclick = () => { stake = v; zpNote = ''; draw(); };
      grid.append(b);
    }
    sec.append(grid);
    c.append(sec);
  }
  const stakeNote = (c: HTMLElement) => {
    const n = el('div', { class: `mp-note${stake ? ' gold' : ''}` });
    n.innerHTML = stake
      ? `Everyone stakes <b>${stake} ZP</b>. Those who get out split the pot, less 5%. If nobody gets out, every stake comes back, and leaving before the start gives yours back.`
      : 'A <b>free room</b>: nothing at stake, just the night. 2 to 8 players, and the way out has seats for half of you.';
    c.append(n);
    if (zpNote) c.append(el('div', { class: 'ok' }, zpNote));
  };
  /** Rooms are for signed-in players: the ways to sign in this browser has. */
  function signInPanel(c: HTMLElement): void {
    c.append(el('div', { class: 'mp-note' }, invite ? `You were invited to room ${invite}. Sign in to join it: it is free.` : 'Rooms are for signed-in players, so your name is on the board and your seat waits if you drop. It is free.'));
    const signedIn = (a: Account) => { me = a; ws?.close(); ws = null; if (stacks.length) void checkElig(); if (invite) { const code = invite; connect(() => send({ t: 'join', code })); } void import('../site/kit').then((k) => k.armoury()).then((x) => { if (x) zpHave = x.cash; draw(); }); draw(); };
    if ((window as unknown as { ethereum?: unknown }).ethereum) {
      const si = btn('Sign in with wallet');
      si.onclick = async () => { si.disabled = true; try { signedIn(await signIn(httpUrl(url))); } catch (e) { err = e instanceof Error ? e.message : 'Sign-in failed.'; draw(); } };
      c.append(si);
    }
    if (socialAvailable()) {
      for (const how of ['google', 'passkey'] as const) {
        const b = btn(how === 'google' ? 'Sign in with Google' : 'Sign in with a passkey', true);
        b.onclick = async () => { b.disabled = true; try { signedIn(await signInSocial(httpUrl(url), how)); } catch (e) { err = e instanceof Error ? e.message : 'Sign-in failed.'; draw(); } };
        c.append(b);
      }
    }
  }

  function draw(): void {
    root.replaceChildren();
    if (!roomInfo && joinAsk) {
      // a ZP room by its code: say what it costs before anything is taken
      const a = joinAsk;
      const c = card(`Room ${a.code}`, `Stake ${a.zp} ZP to join`, `${a.seats} ${a.seats === 1 ? 'player is' : 'players are'} in it now. The pot is ${a.pot.toLocaleString()} ZP and grows with every seat.`);
      const n = el('div', { class: 'mp-note gold' });
      n.innerHTML = `Everyone stakes <b>${a.zp} ZP</b>. Those who get out split the pot, less 5%. If nobody gets out, every stake comes back. Leaving before the start gives yours back.`;
      c.append(n);
      const yes = btn(`Stake ${a.zp} ZP and join`);
      if (zpHave !== null && zpHave < a.zp) { yes.disabled = true; yes.textContent = `You need ${a.zp - zpHave} more ZP`; }
      yes.onclick = () => { joinAsk = null; connect(() => send({ t: 'join', code: a.code, zp: a.zp })); draw(); };
      c.append(yes);
      foot(c);
      return;
    }
    if (!roomInfo) {
      if (mode === 'join') {
        // a code typed on the Play page, or an invite link: on the way in (or the reason it did not work)
        const c = card('Join with a code', invite ? `Room ${invite}` : 'Join a room');
        if (!me) signInPanel(c);
        else if (!err) { const w = el('div', { class: 'mp-note' }); w.append(el('span', { class: 'mp-spin' }), document.createTextNode('Joining…')); c.append(w); }
        foot(c);
        return;
      }
      const titles: Record<typeof mode, [string, string]> = {
        quick: ['Join a public room', 'Pick a stake: join a room that is waiting, or create one anyone can join if none is.'],
        create: ['New private room', 'A room only your friends can join, by its code or your invite link.'],
        staked: ['Staked rooms', 'Everyone stakes the same. Those who get out split the pot.'],
      };
      const c = card('Multiplayer', titles[mode][0], titles[mode][1]);
      if (!me) { signInPanel(c); foot(c); return; }
      // the server seats you under your username when you have one: only an account without one is asked
      if (!me.name) {
        const f = el('label', { class: 'mp-field' }, 'Your name in the room');
        const nm = el('input', { placeholder: 'Your name', maxlength: '20', value: name() });
        nm.addEventListener('input', () => localStorage.setItem(KEY_NAME, nm.value.trim()));
        f.append(nm); c.append(f);
      }
      const crypto = stacks.length > 0 && (window as unknown as { ethereum?: unknown }).ethereum;
      if (mode === 'staked' && crypto) {
        const tabs = el('div', { class: 'mp-tabs' });
        for (const [k, label] of [['zp', 'ZP'], ['crypto', stacks.map((x) => x.symbol).join(' · ')]] as const) {
          const b = el('button', k === tab ? { class: 'on' } : {}, label);
          b.onclick = () => { tab = k; draw(); };
          tabs.append(b);
        }
        c.append(tabs);
      }
      if (mode === 'staked' && crypto && tab === 'crypto') { cryptoPanel(c); foot(c); return; }
      if (mode === 'staked' && stake === null) stake = ZP_STAKES[1]; // staked rooms are for staking: 100 ZP picked to start
      stakeChips(c, mode === 'staked');
      stakeNote(c);
      const tail = stake ? ` · ${stake} ZP` : '';
      const short = stake !== null && zpHave !== null && zpHave < stake; // the stake picked is more than you have
      const guard = (b: HTMLButtonElement) => { if (short) { b.disabled = true; b.textContent = 'Not enough ZP for this stake'; } return b; };
      // quick opens a public room when none is waiting (and, should one have opened a moment ago, sits you in it)
      const quick = () => { connecting = true; connect(() => send(stake ? { t: 'quick', zp: stake } : { t: 'quick' })); };
      const create = () => { connecting = true; connect(() => send(stake ? { t: 'create', zp: stake } : { t: 'create' })); };
      if (mode === 'create') { const b = btn(`Create room${tail}`); b.onclick = create; c.append(guard(b)); }
      else {
        // the public rooms at this stake still taking players, each with a Join; a new one only when none is waiting
        const here = (openRooms ?? []).filter((o) => o.zp === stake);
        c.append(el('div', { class: 'mp-label' }, `Open public rooms${stake ? ` · ${stake} ZP` : ' · free'}`));
        const list = el('ul', { class: 'mp-seats' });
        if (openRooms === null) list.append(el('li', { class: 'empty' }, 'Looking for open rooms…'));
        else if (!here.length) list.append(el('li', { class: 'empty' }, 'No room is waiting at this stake. Create one and others can join you.'));
        for (const o of here) {
          const li = el('li');
          const who = o.host ? `${o.host}'s room` : `Room ${o.code}`;
          const j = el('button', { class: 'mp-btn sm' }, 'Join') as HTMLButtonElement;
          j.onclick = () => { connecting = true; connect(() => send(stake ? { t: 'join', code: o.code, zp: stake } : { t: 'join', code: o.code })); };
          if (short) j.disabled = true;
          li.append(el('span', { class: 'av' }, String(o.players)), el('span', { class: 'nm' }, who),
            el('span', { class: 'tg' }, o.startsIn !== null ? `starts in ${o.startsIn}s` : `${o.players} of ${ROOM_PLAYERS_MAX}`), j);
          list.append(li);
        }
        c.append(list);
        const row = el('div', { class: 'mp-row' });
        const a = btn(`Create a room${tail}`); a.onclick = quick;
        if (here.length || openRooms === null) { a.disabled = true; a.title = 'Join the open room: a new one can be made once it fills or starts'; }
        row.append(guard(a));
        if (mode === 'staked') { const b = btn('Private room', true); b.onclick = create; row.append(guard(b)); }
        c.append(row);
        if (here.length) c.append(el('div', { class: 'mp-note' }, 'A room is already waiting at this stake: join it. Create opens again once it fills or starts.'));
      }
      foot(c);
      return;
    }
    // ---- in a room
    const r = roomInfo;
    const host_ = r.you === r.host, alone = r.seats.length < 2;
    const kind = r.onChain ? `Staked room · ${r.stack ?? ''}` : `${r.public ? 'Public room' : 'Private room'}${r.zp ? ` · ${r.zp} ZP` : ' · free'}`;
    const c = card(kind, r.state === 'lobby' ? 'The waiting room' : 'In the round');
    const head = el('div', { class: 'mp-code' });
    const code = el('div');
    code.append(el('div', { class: 'mp-label' }, r.onChain ? 'Room number' : 'Room code'), el('b', {}, r.onChain ? `#${r.onChain}` : r.code));
    const status = el('div', { class: `mp-status${alone ? ' wait' : ''}` },
      r.startsIn !== null ? `Starting in ${r.startsIn}…` : r.onChain ? `${r.seats.length} staked` : `${r.seats.length} of ${ROOM_PLAYERS_MAX}${alone ? ' · waiting' : ' · ready'}`);
    head.append(code, status);
    c.append(head);
    if (r.zp) {
      const n = el('div', { class: 'mp-note gold' });
      n.innerHTML = `Pot <b>${(r.pot ?? 0).toLocaleString()} ZP</b> (${r.zp} ZP a seat). Those who get out split it, less 5%; nobody out, every stake back. Leaving before the start gives yours back.`;
      c.append(n);
    }
    const list = el('ul', { class: 'mp-seats' });
    for (const st of r.seats as SeatInfo[]) {
      const li = el('li', st.connected ? {} : { class: 'off' });
      li.append(el('span', { class: 'av' }, (st.name.trim()[0] ?? '?').toUpperCase()), el('span', { class: 'nm' }, `${st.name}${st.seat === r.you ? ' (you)' : ''}`),
        el('span', { class: 'tg' }, st.seat === r.host ? 'host' : st.connected ? '' : 'dropped'));
      list.append(li);
    }
    if (!r.onChain && r.state === 'lobby' && r.seats.length < ROOM_PLAYERS_MAX) list.append(el('li', { class: 'empty' }, alone ? 'Waiting for players: share the invite' : `${ROOM_PLAYERS_MAX - r.seats.length} seats open`));
    c.append(list);
    const start = btn(host_ ? (alone ? 'Start' : 'Start the round') : 'Waiting for host', alone || !host_);
    start.disabled = !host_ || alone || note !== '';
    start.onclick = () => { if (r.onChain) void chainStep('Confirm in your wallet…', (m, cfg) => m.startStaked(cfg, BigInt(r.onChain!)), r.stack); else send({ t: 'start' }); };
    const share = btn('Share invite', !alone);
    share.onclick = () => void shareInvite(r.onChain ? { staked: `${r.stack}:${r.onChain}` } : { join: r.code });
    const row = el('div', { class: 'mp-row' });
    if (alone) row.append(share, start); else row.append(start, share);
    c.append(row);
    if (linkShown) { // shown as typed (capitals would break it), selected on a tap
      const f = el('label', { class: 'mp-field' }, shareNote);
      const box = el('input', { class: 'link', readonly: '', value: linkShown });
      box.addEventListener('focus', () => box.select());
      f.append(box); c.append(f);
    }
    if (quiet && alone && !r.onChain) {
      const box = el('div', { class: 'quiet' });
      const go = btn('Play while I wait', true);
      go.onclick = () => { away = true; soloOn = true; root.style.display = 'none'; host.soloWhileWaiting(); banner(false); };
      box.append(el('b', {}, 'Quiet right now'), el('span', {}, 'Play today\'s city while you wait. You keep your seat, and we call you back the moment someone joins.'), go);
      c.append(box);
    }
    c.append(el('p', { class: 'mp-lead' }, r.onChain
      ? 'The host closes the doors on the chain, and the round starts when the chain says so. Leaving gets your stake back while the room is waiting.'
      : r.public ? 'Anyone who picks this stake in Join a public room lands here. The round starts when the host says, or 20 seconds after four are in.'
        : 'Only people with the code or your invite can join. The round starts when the host says, or 20 seconds after four are in.'));
    if (note) c.append(el('div', { class: 'ok' }, note));
    const f = el('div', { class: 'mp-foot' });
    const leave = el('button', { class: 'mp-link' }, '← Leave room');
    leave.onclick = () => {
      send({ t: 'leave' }); roomInfo = null; watchQuiet();
      if (r.onChain) void chainStep('Getting your stake back…', (m, cfg) => (host_ ? m.cancelStaked(cfg, BigInt(r.onChain!)) : m.leaveStaked(cfg, BigInt(r.onChain!))), r.stack);
      else draw();
    };
    f.append(leave, el('span', { class: 'mp-bal' }, me?.name ? `Signed in as ${me.name}` : ''));
    c.append(el('div', { class: 'err' }, err), f);
  }

  /** Crypto staked rooms (USDm, USDT): made and joined from the wallet, on the chain. */
  function cryptoPanel(c: HTMLElement): void {
    const cur = stacks[pick]!, unit = cur.symbol;
    if (stacks.length > 1) { // each token has its own contract, and its own room numbers
      const tok = el('div', { class: 'mp-tabs' });
      stacks.forEach((x, i) => { const b = el('button', i === pick ? { class: 'on' } : {}, x.symbol); b.onclick = () => { pick = i; draw(); }; tok.append(b); });
      c.append(tok);
    }
    const amtF = el('label', { class: 'mp-field' }, `Stake (${unit})`), amt = el('input', { value: '0.05', inputmode: 'decimal' });
    const sizeF = el('label', { class: 'mp-field' }, 'Players (2 to 8)'), size = el('input', { value: '4', inputmode: 'numeric', maxlength: '1' });
    amtF.append(amt); sizeF.append(size);
    const fields = el('div', { class: 'mp-row' }); fields.append(amtF, sizeF);
    const mkS = btn('Create a staked room');
    const barred = elig !== null && !elig.ok; // nothing goes to the chain from someone the server will not seat
    mkS.disabled = note !== '' || barred;
    mkS.onclick = () => void chainStep('Confirm in your wallet…', async (m, cfg) => {
      const n = Number(size.value);
      if (!(n >= 2 && n <= 8)) throw new Error('2 to 8 players.');
      const id = await m.createStaked(cfg, n, m.parseAmount(amt.value, cfg.decimals));
      note = 'Taking your seat…'; seatIn(cfg.symbol, id);
    });
    const idIn = el('input', { class: 'code', placeholder: 'ROOM #', maxlength: '12', inputmode: 'numeric', value: stakedInvite && stakedInvite.symbol === unit ? stakedInvite.id : '' });
    const jnS = btn('Join', true);
    jnS.disabled = note !== '' || barred;
    jnS.onclick = () => void chainStep('Confirm in your wallet…', async (m, cfg) => {
      if (!/^\d{1,12}$/.test(idIn.value.trim())) throw new Error('Enter the room number.');
      const id = BigInt(idIn.value.trim());
      await m.joinStaked(cfg, id);
      note = 'Taking your seat…'; seatIn(cfg.symbol, id);
    });
    const jr = el('div', { class: 'mp-row' }); jr.append(idIn, jnS);
    if (elig && !elig.ok) c.append(el('div', { class: 'mp-note' }, eligText(elig)));
    c.append(fields, mkS, el('div', { class: 'mp-label' }, 'Or join one by its number'), jr,
      el('div', { class: 'mp-note gold' }, 'Real money: you can lose your stake. Players who get out split the pot less a 1.5% fee; if nobody gets out, everyone is refunded. The server plays the round, and the whole round is kept so it can be checked.'));
    if (note) c.append(el('div', { class: 'ok' }, note));
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
  // the site's Join a public room / Private room cards open the menu with that button first: the player picks a stake, then presses it
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
  /** At the wheel: the car's true (predicted) heading and speed; its position is `truth`. */
  private car = { heading: 0, speed: 0 };
  private zombies = new Map<number, Zombie>();
  /** Cars driven off somewhere out of sight: not drawn (and not where they were parked). */
  private gone = new Set<number>();
  private actors = new Map<number, Actor>();
  /** When each of the others last fired (their shoot pose, for a moment). */
  private shotAt = new Map<number, number>();
  private shooting = new Set<number>();
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
    host.toast(`Get ${ROOM_TASKS} steps done (any of them: whoever finishes one first has it), then reach the exit. Seats are limited: the first ones out take them.`);
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
    const before = p.status;
    Object.assign(p, rest);
    // bitten down or out of time: you get up as one of them, and are told plainly what that means now
    if (!this.firstSnap && before !== p.status) {
      if (p.status === 'down') this.host.toast('You are down. You are getting back up, but not as yourself.');
      else if (p.status === 'turned') this.host.toast('You have turned. Hunt the living: get to them and BITE. The dead near you follow you, and go for whoever you go for.');
    }
    p.pos = { x: pos.x, y: pos.y };
    p.vel = { x: vel.x, y: vel.y };
    p.heading = heading;
    this.pending = this.pending.filter((x) => x.seq > ack);
    // the cars: what each one in sight is like now; one driven off out of sight is not drawn where it was parked
    for (const c of v.vehicles) {
      const k = s.vehicles.find((x) => x.id === c.id);
      if (!k) continue;
      k.health = c.health; k.fuel = c.fuel; k.wrecked = c.wrecked;
      if (c.id === p.vehicleId) { k.pos = { x: c.pos.x, y: c.pos.y }; k.heading = c.heading; k.speed = c.speed; }
      else if (this.gone.has(c.id)) { k.pos = { x: c.pos.x, y: c.pos.y }; k.heading = c.heading; } // back in sight
      this.gone.delete(c.id);
    }
    for (const id of v.carsGone) { const k = s.vehicles.find((x) => x.id === id); if (k && id !== p.vehicleId) { this.gone.add(id); k.pos = { x: -999, y: -999 }; k.speed = 0; } }
    const car = playerVehicle(s);
    if (car && p.status === 'alive') { // at the wheel: the server's car, then the inputs it has not seen yet
      for (const x of this.pending) predictVehicle(s, car, x.input, ROOM_DT);
      p.pos = { x: car.pos.x, y: car.pos.y };
      this.car = { heading: car.heading, speed: car.speed };
    } else if (p.status === 'alive' || p.status === 'turned') for (const x of this.pending) movePlayer(s, x.input, ROOM_DT);
    this.truth = { x: p.pos.x, y: p.pos.y };
    const ex = was.x - this.truth.x, ey = was.y - this.truth.y;
    if (DEBUG && !this.firstSnap) ((window as unknown as { __mpErr?: number[] }).__mpErr ??= []).push(Math.hypot(ex, ey)); // how far off the prediction was
    if (this.firstSnap || Math.hypot(ex, ey) > SNAP_BEYOND) this.off = { x: 0, y: 0 }; // a jump (a first fix, a knock-back): do not slide
    else this.off = { x: ex, y: ey };
    this.firstSnap = false;
    // the district's changing parts
    s.phase = v.phase;
    v.taken.forEach((t, i) => { const k = s.pickups[i]; if (k) k.taken = t; });
    s.drops = v.drops.map((d) => ({ id: d.id, pos: d.pos, from: -1, taken: false }));
    v.opened.forEach((t, i) => { const k = s.crates[i]; if (k) k.opened = t; });
    v.searched.forEach((t, i) => { const k = s.houses[i]; if (k) k.searched = t; });
    for (const t of v.tasks) { const k = s.tasks.find((x) => x.id === t.id); if (k) { k.done = t.done; if (t.by !== undefined) k.doneBy = t.by; if (t.got) k.got = t.got; if (t.targets) k.targets = t.targets; } }
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
      const car = playerVehicle(s);
      if (!this.over && car && p.status === 'alive') { // driving: the car answers the stick at once
        car.pos = { x: this.truth.x, y: this.truth.y };
        car.heading = this.car.heading; car.speed = this.car.speed;
        predictVehicle(s, car, input, ROOM_DT);
        this.truth = { x: car.pos.x, y: car.pos.y };
        this.car = { heading: car.heading, speed: car.speed };
      } else if (!this.over && (p.status === 'alive' || p.status === 'turned') && !(p.hold.taskId || p.work)) {
        p.pos = { x: this.truth.x, y: this.truth.y };
        movePlayer(s, input, ROOM_DT);
        this.truth = { x: p.pos.x, y: p.pos.y };
      }
    }
    if (this.acc > ROOM_DT) this.acc = 0;
    this.off.x *= Math.exp(-dt / EASE);
    this.off.y *= Math.exp(-dt / EASE);
    p.pos = { x: this.truth.x + this.off.x, y: this.truth.y + this.off.y };
    const mine = playerVehicle(s);
    if (mine) { mine.pos = { x: p.pos.x, y: p.pos.y }; mine.heading = this.car.heading; mine.speed = this.car.speed; p.heading = this.car.heading; }

    const now = performance.now() / 1000;
    for (const e of this.events) if (e.type === 'shot' && e.shooter !== undefined && e.shooter !== p.id) this.shotAt.set(e.shooter, now); // they fire: their arms come up, not yours
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

    // the cars others are driving (or that were left rolling), between the two snapshots
    const carsBefore = new Map(a.v.vehicles.map((c) => [c.id, c]));
    for (const c of b.v.vehicles) {
      if (c.id === this.local.vehicleId || this.gone.has(c.id)) continue;
      const k = s.vehicles.find((x) => x.id === c.id), o = carsBefore.get(c.id);
      if (!k) continue;
      k.pos = { x: o ? lerp(o.pos.x, c.pos.x) : c.pos.x, y: o ? lerp(o.pos.y, c.pos.y) : c.pos.y };
      k.heading = o ? arc(o.heading, c.heading) : c.heading;
      k.speed = c.speed;
    }

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
      p.vehicleId = o.vehicleId;
      act.root.visible = o.vehicleId === null; // at the wheel: the car is what you see
      const sp = Math.hypot(p.pos.x - (act.root.position.x), p.pos.y - act.root.position.z) / Math.max(dt, 1e-3);
      if (o.status === 'down' || o.status === 'dead') act.play('Death', { once: true, fade: 0.15 });
      else if (o.status === 'turned') act.shamble(Math.min(8, sp));
      else if (o.hidden || (o.crouched && sp < 0.3)) act.play('Kneel', { startAt: 0.12, timeScale: 0.0001, fade: 0.25 }); // down low
      else act.locomote(Math.min(5.5, sp));
      act.crouch(o.status === 'alive' && o.crouched && !o.hidden && sp >= 0.3); // a low creep, knees bent
      const fired = o.status === 'alive' && now - (this.shotAt.get(o.id) ?? -9) < 0.35;
      if (fired !== this.shooting.has(o.id)) { act.setUpper(fired ? 'ShootUpper' : null, { restart: true, timeScale: 1.6 }); if (fired) this.shooting.add(o.id); else this.shooting.delete(o.id); }
      act.update(p.pos.x, p.pos.y, p.heading, dt, true);
      act.root.position.y = o.roof !== null ? s.map.ladders[o.roof]?.height ?? 0 : 0; // up on a roof
    }
    for (const [id, act] of this.actors) if (!seen.has(id)) act.root.visible = false; // out of sight: not drawn
  }

  /** Names over the heads of the players you can see. */
  private labels(): void {
    const s = this.shadow;
    const spans = Array.from(this.names.children) as HTMLElement[];
    let n = 0;
    // names only over players in plain view on screen, and never over the map
    const mapOpen = document.getElementById('map-screen')?.style.display === 'flex';
    for (const [id, act] of this.actors) {
      if (mapOpen || !act.root.visible) continue;
      const p = s.players[id]!;
      const at = this.host.view.projectPx(p.pos, 3.4);
      if (!at || at.x < 0 || at.y < 0 || at.x > innerWidth || at.y > innerHeight) continue;
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
    box.classList.toggle('turned', !!m && !out); // the ending's picture behind it, as in a night alone
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
