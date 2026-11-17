// The home page's live parts: the nav and menu buttons, who is signed in, and tonight's board.
// The page itself is plain HTML in index.html; this is its own chunk, so the game's startup code stays as it was.
import { account, apiBase, signOut } from '../net/account';

const $ = (id: string) => document.getElementById(id);

export function initHome(): void {
  const menu = document.querySelector<HTMLDetailsElement>('#title .menu');
  // nav buttons stand in for the hero's own (which main.ts wires): Play, Play with friends, Leaderboard
  for (const b of document.querySelectorAll<HTMLElement>('#title [data-go]')) {
    b.addEventListener('click', () => {
      if (menu) menu.open = false;
      const target = $(b.dataset.go!) as HTMLButtonElement | null;
      if (target && !target.disabled) target.click();
      else $('top')?.scrollIntoView(); // still loading: the hero says so
    });
  }
  for (const a of document.querySelectorAll('#title .menu a')) a.addEventListener('click', () => { if (menu) menu.open = false; });
  $('boardbtn')!.addEventListener('click', () => { void import('../net/board').then((m) => m.openBoard()); });
  if (new URLSearchParams(location.search).has('admin')) void import('../net/admin').then((m) => m.openAdmin());
  showAccount();
  void loadTonight();
}

/** "Sign in", or who you are (a tap offers to sign out). */
function showAccount(): void {
  const me = account();
  const label = me ? (me.name || `${me.address.slice(0, 6)}…${me.address.slice(-4)}`) : 'Sign in';
  for (const b of document.querySelectorAll<HTMLButtonElement>('#title .signin')) {
    b.textContent = label;
    b.title = me ? 'Signed in. Tap to sign out.' : '';
    b.onclick = () => {
      document.querySelector<HTMLDetailsElement>('#title .menu')!.open = false;
      if (me) { if (confirm(`Signed in as ${label}. Sign out?`)) { signOut(); showAccount(); } return; }
      void import('../net/gate').then((m) => m.showGate(showAccount, {
        title: 'Sign in',
        text: 'Your nights count on the leaderboard, your last self waits for you where you fell, and multiplayer opens.',
        cancel: true,
      }));
    };
  }
}

interface Board { of: number; rows: Array<{ rank: number; name: string; value: number }> }

/** Tonight's board: how many are on it, the best score, the top five. */
async function loadTonight(): Promise<void> {
  const list = $('home-top')!;
  const msg = (t: string) => { const li = document.createElement('li'); li.className = 'msg'; li.textContent = t; list.replaceChildren(li); };
  let b: Board;
  try {
    const r = await fetch(`${apiBase()}/leaderboard?board=night`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    b = await r.json() as Board;
  } catch { msg('The board is not reachable right now. You can still play.'); return; }
  $('home-players')!.textContent = b.of.toLocaleString();
  $('home-best')!.textContent = b.rows[0] ? b.rows[0].value.toLocaleString() : '—';
  if (!b.rows.length) { msg('Nobody has a score in tonight\'s city yet. Be the first.'); return; }
  list.replaceChildren(...b.rows.slice(0, 5).map((row) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    const i = document.createElement('i'); i.textContent = `#${row.rank}`;
    n.append(i, row.name);
    const v = document.createElement('span'); v.textContent = `${row.value.toLocaleString()} pts`;
    li.append(n, v);
    return li;
  }));
}
