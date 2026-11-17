// The leaderboards: tonight's city, the week, streaks, rooms. Loaded only when someone opens them.
// Every number on them comes from the server's own replay of a run (or its own run of a room), never from a client.
import { account, apiBase } from './account';

type Kind = 'night' | 'week' | 'streak' | 'rooms';
interface Row { rank: number; name: string; value: number; title: string; detail: Record<string, number | string> }
interface Board {
  kind: Kind; unit: 'points' | 'nights' | 'escapes'; of: number; rows: Row[]; rules: string[];
  me: { rank: number; value: number; title: string; toNext: { gap: number; name: string } | null; detail: Record<string, number | string> } | null;
}

const TABS: Array<[Kind, string]> = [['night', 'Tonight'], ['week', 'This week'], ['streak', 'Streak'], ['rooms', 'Rooms']];
const EMPTY: Record<Kind, string> = {
  night: 'Nobody has a score in tonight\'s city yet. Be the first: everyone plays the same streets today.',
  week: 'No scores this week yet.',
  streak: 'No one has got out of the city two nights running. Yet.',
  rooms: 'Play three rounds of multiplayer signed in to be listed.',
};

const CSS = `
#board { position: fixed; inset: 0; z-index: 35; display: flex; flex-direction: column; align-items: center; gap: 10px; overflow-y: auto;
  background: rgba(4,6,10,.96); font-family: 'VT323', monospace; color: #d4c9b2; padding: calc(env(safe-area-inset-top, 0px) + 18px) 16px 24px; }
#board h2 { margin: 0; font-family: 'Eater', system-ui, sans-serif; font-weight: 400; font-size: clamp(28px, 6vw, 48px); letter-spacing: .05em; text-shadow: 0 0 24px rgba(230,51,41,.45); }
#board .tabs { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; }
#board .tabs button, #board .close { font: inherit; font-size: 19px; letter-spacing: .12em; text-transform: uppercase; padding: 5px 14px; border: 2px solid #3d5a2a;
  border-radius: 6px; background: transparent; color: #a8c46a; cursor: pointer; }
#board .tabs button.on { background: #6b8e23; color: #060b06; border-color: #6b8e23; }
#board .me { width: min(640px, 100%); border: 2px solid #f2b630; border-radius: 8px; padding: 8px 12px; color: #f2d58a; font-size: 20px; text-align: center; }
#board .me b { color: #fff3c9; font-weight: 400; }
#board ol { list-style: none; margin: 0; padding: 0; width: min(640px, 100%); }
#board li { display: grid; grid-template-columns: 2.6em 1fr auto; gap: 2px 10px; align-items: baseline; padding: 6px 8px; border-bottom: 1px solid #1c2a18; font-size: 21px; }
#board li .r { color: #7a8a72; text-align: right; }
#board li:nth-child(1) .r { color: #f2b630; }
#board li .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#board li .t { color: #e0483a; font-size: 15px; letter-spacing: .1em; text-transform: uppercase; margin-left: 6px; }
#board li .v { color: #e8e0cc; }
#board li .d { grid-column: 2 / 4; color: #6f7d68; font-size: 15px; }
#board details { width: min(640px, 100%); color: #8f9c86; font-size: 17px; }
#board summary { cursor: pointer; color: #a8c46a; letter-spacing: .1em; text-transform: uppercase; }
#board .msg { color: #8f9c86; font-size: 19px; text-align: center; max-width: 32em; }
`;

const fmt = (n: number) => n.toLocaleString();
const unitOf = (b: Board, n: number) => (b.unit === 'points' ? 'pts' : b.unit === 'nights' ? (n === 1 ? 'night' : 'nights') : n === 1 ? 'escape' : 'escapes');

/** One line of what a run or a record was made of. */
function detail(kind: Kind, d: Record<string, number | string>): string {
  if (kind === 'night') {
    const out = d.outcome === 'won' ? `got out with ${d.secondsLeft}s left` : `reached district ${d.reached}`;
    return [out, `${d.kills} kills`, `${d.bites} ${d.bites === 1 ? 'bite' : 'bites'}`, d.accuracy ? `${d.accuracy}% hits` : '', d.rescues ? `${d.rescues} helped` : ''].filter(Boolean).join(' · ');
  }
  if (kind === 'week') return `${d.nights} ${d.nights === 1 ? 'night' : 'nights'} · best ${fmt(Number(d.best))}`;
  if (kind === 'streak') return `${fmt(Number(d.total))} pts across the streak`;
  return `${d.rounds} rounds · out ${d.rate}% of the time · ${d.kills} kills`;
}

export function openBoard(): void {
  if (document.getElementById('board')) return;
  if (!document.getElementById('board-css')) { const st = document.createElement('style'); st.id = 'board-css'; st.textContent = CSS; document.head.appendChild(st); }
  const root = document.createElement('div');
  root.id = 'board';
  document.body.appendChild(root);
  let kind: Kind = 'night';
  const cache = new Map<Kind, Board>();
  const el = (tag: string, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

  async function load(k: Kind): Promise<Board | string> {
    const have = cache.get(k);
    if (have) return have;
    try {
      const me = account();
      const r = await fetch(`${apiBase()}/leaderboard?board=${k}`, { headers: me ? { authorization: `Bearer ${me.token}` } : {}, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return 'The leaderboard is not answering. Try again in a minute.';
      const b = (await r.json()) as Board;
      cache.set(k, b);
      return b;
    } catch { return 'Cannot reach the server. The leaderboard needs a connection.'; }
  }

  async function draw(): Promise<void> {
    root.replaceChildren(el('h2', '', 'Leaderboard'));
    const tabs = el('div', 'tabs');
    for (const [k, label] of TABS) {
      const b = el('button', k === kind ? 'on' : '', label) as HTMLButtonElement;
      b.onclick = () => { kind = k; void draw(); };
      tabs.append(b);
    }
    root.append(tabs);
    const wait = el('p', 'msg', 'Counting the survivors…');
    root.append(wait);
    const b = await load(kind);
    if (kind !== (typeof b === 'string' ? kind : b.kind)) return; // switched tabs while it loaded
    wait.remove();
    if (typeof b === 'string') { root.append(el('p', 'msg', b)); }
    else {
      if (b.me) {
        const m = el('div', 'me');
        const next = b.me.toNext ? ` ${fmt(b.me.toNext.gap)} ${unitOf(b, b.me.toNext.gap)} to pass ${b.me.toNext.name}.` : ' Nobody is ahead of you.';
        m.append(`You: #${b.me.rank} of ${b.of} · `, Object.assign(el('b'), { textContent: b.me.title }), ` · ${fmt(b.me.value)} ${unitOf(b, b.me.value)}.${next}`);
        root.append(m);
      } else if (!account()) root.append(el('p', 'msg', 'Sign in and finish a night to get on the board.'));
      if (!b.rows.length) root.append(el('p', 'msg', EMPTY[kind]));
      else {
        const ol = el('ol');
        for (const r of b.rows) {
          const li = el('li');
          const n = el('span', 'n', r.name);
          n.append(el('span', 't', r.title));
          li.append(el('span', 'r', `#${r.rank}`), n, el('span', 'v', `${fmt(r.value)} ${unitOf(b, r.value)}`), el('span', 'd', detail(kind, r.detail)));
          ol.append(li);
        }
        root.append(ol);
      }
      const how = el('details');
      how.append(el('summary', '', 'How it is scored'));
      for (const line of b.rules) how.append(el('p', '', line));
      root.append(how);
    }
    const close = el('button', 'close', 'Back') as HTMLButtonElement;
    close.onclick = () => root.remove();
    root.append(close);
  }
  void draw();
}
