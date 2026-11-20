// The site's pages. Each is markup (filled from the server where it needs to be) plus what happens once it is on screen.
// Buttons that start the game carry data-play (app.ts wires them, and keeps them disabled until the city has loaded).
import {
  account, api, board, BOARD_NAMES, detail, esc, fmt, ICON, ITEM_NAMES, itemArt, ago, setName, short, shown, signInThen, unitOf,
  type Board, type Kind, type Me,
} from './kit';

export interface Ctx {
  /** Draw the page (and the header) again: after a sign-in, a sign-out, a new name. */
  refresh(): void;
  /** The admin page, inside this element. */
  admin(into: HTMLElement): void;
}
export interface Page { title: string; html(): string; mount?(root: HTMLElement, ctx: Ctx): void }

const loading = '<div class="loading" data-loading><i></i>Loading the city&hellip;</div>';
const head = (kicker: string, title: string, sub = '') => `<div class="kicker">${kicker}</div><h1 class="ph1">${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ''}`;

/** What a loadout takes into a night (this device's copy, the one the game starts with), as pictures and names. */
function carrying(slot: 'ranked' | 'open'): string {
  const me = account();
  if (!me) return '';
  let kit: string[] = [], lent: string[] = [];
  try {
    const a = JSON.parse(localStorage.getItem('zp.armoury') ?? 'null') as { address: string; loadouts: Record<string, { kit: string[] }>; loans?: Array<{ item: string }> } | null;
    if (a?.address === me.address) { kit = a.loadouts[slot]?.kit ?? []; lent = (a.loans ?? []).map((x) => x.item); }
  } catch { /* the standard kit */ }
  return `<span class="carry"><em>You carry</em>${['pistol', 'baton', ...kit].map((id) => `<span class="it${lent.includes(id) ? ' b' : ''}" title="${lent.includes(id) ? 'Borrowed' : ''}"><img src="${itemArt(id)}" alt="" />${esc(ITEM_NAMES[id] ?? id)}</span>`).join('')}</span>`;
}

const DISTRICTS = `
  <div class="card"><img class="art" src="/intro/bg-game.webp" alt="" loading="lazy" /><div class="ph">01 &middot; Downtown</div><h3>Where it started</h3><p>Scavenge, help who you can and find the parts you need, then get down into the subway before the streets close in.</p></div>
  <div class="card"><img class="art" src="/intro/bg-horror.webp" alt="" loading="lazy" /><div class="ph">02 &middot; The docks</div><h3>Across the tracks</h3><p>Work through the yards to the gate in the army barricade. Cars and bikes get you there faster, but every engine is heard.</p></div>
  <div class="card"><img class="art" src="/intro/bg-patient-zero.webp" alt="" loading="lazy" /><div class="ph">03 &middot; The edge</div><h3>The last helicopter</h3><p>The landing zone is the only way out of Port Halden. Get there before the infection reaches zero.</p></div>`;

const THREATS = `
  <div class="card"><div class="ph">The clock</div><h3>It is your infection</h3><p>Every bite jumps it forward. Antiviral doses hold it back. When it runs out, you are one of them.</p></div>
  <div class="card"><div class="ph">People</div><h3>Survivors, and who is bitten</h3><p>People ask for help and some will follow you. Someone coughing may already be bitten: check them, and decide whether to leave them.</p></div>
  <div class="card"><div class="ph">Stealth</div><h3>Light and noise</h3><p>Your light shows you the street and shows you to them. Kill it, throw a bottle to pull them away, and listen for screamers.</p></div>
  <div class="card"><div class="ph">Loot</div><h3>Houses and stores</h3><p>Search houses for doses, scrap and rounds, but a red X means something is inside. Spend what you find at weapon stores.</p></div>
  <div class="card"><div class="ph">Wheels</div><h3>Cars and bikes</h3><p>Faster than running, with seats for the people you saved. Watch the fuel, and shake off what grabs on.</p></div>
  <div class="card"><div class="ph">Memory</div><h3>Your last self</h3><p>Where you fell, you wait, still carrying what you carried. Put it down to take your gear back.</p></div>`;

// ---------------------------------------------------------------- home

export const home: Page = {
  title: 'Zombie Plague',
  html: () => {
    const me = account();
    return `
  <section class="hero"><div class="wrap">
    <span class="badge">Survival horror &middot; A new night every day</span>
    <h1><span>BITTEN.</span><span class="red">GET OUT.</span></h1>
    <p class="lede">You were bitten in Port Halden, and the infection is your clock. Cross three districts, find the doses that hold it back, and reach the last evacuation helicopter before you turn.</p>
    <div class="ctas">
      <button class="btn" type="button" data-play="solo" disabled>Play now</button>
      <a class="btn red" href="/play">Play with friends</a>
      <a class="btn ghost" href="/how-to-play">How to play</a>
    </div>
    <p class="note">${me ? `Signed in as ${esc(shown(me))}. Today's best run goes on the board.` : 'Free in your browser. Sign in after a few minutes to keep playing and save your nights.'}</p>
    <div class="ios-tip">For full screen on iPhone: tap Share, then <b>Add to Home Screen</b>, and play from the new icon.</div>
    <div class="stats">
      <div class="stat"><b>3</b><span>Districts</span></div>
      <a class="stat" href="/ranks" data-board="night"><b data-k="players">&mdash;</b><span>On today's board</span></a>
      <a class="stat" href="/ranks" data-board="night"><b data-k="best">&mdash;</b><span>Best today</span></a>
      <a class="stat" href="/ranks" data-board="rooms" title="Signed-in players who got out of a multiplayer room today"><b data-k="escapes">&mdash;</b><span>Room escapes today</span></a>
    </div>
  </div></section>
  <div class="ticker" aria-hidden="true"><div>THE CLOCK IS YOUR INFECTION  |  FIND THE DOSES  |  CHECK WHO IS COUGHING  |  KILL THE LIGHT  |  MIND THE RED X  |  REACH THE HELICOPTER  |  THE CLOCK IS YOUR INFECTION  |  FIND THE DOSES  |  CHECK WHO IS COUGHING  |  KILL THE LIGHT  |  MIND THE RED X  |  REACH THE HELICOPTER  |  </div></div>
  <div class="wrap page">
    ${me ? `<div class="status" data-k="status"><span class="k">Your night</span><span class="muted">Loading your standing&hellip;</span></div>` : ''}
    <div class="tiles" style="margin-top:${me ? 18 : 0}px">
      <a class="tile" href="/play"><span class="ico">${ICON.play}</span><h3>Play</h3><p>Today's city &middot; Public rooms &middot; Private rooms &middot; Random city</p><span class="go">${ICON.chev}</span></a>
      <a class="tile" href="/ranks"><span class="ico a">${ICON.trophy}</span><h3>Ranks</h3><p>Today &middot; This week &middot; Streaks &middot; Rooms</p><span class="go">${ICON.chev}</span></a>
      <a class="tile" href="/profile"><span class="ico b">${ICON.user}</span><h3>Profile</h3><p>${me ? 'Your name, your standing, your last nights' : 'Sign in to keep a record'}</p><span class="go">${ICON.chev}</span></a>
      <a class="tile" href="/how-to-play"><span class="ico g">${ICON.book}</span><h3>How to play</h3><p>The night &middot; The controls &middot; Scoring &middot; Questions</p><span class="go">${ICON.chev}</span></a>
    </div>
    <div class="sec">
      <div class="kicker">How a night goes</div>
      <h2 class="ph2">Three districts. One clock.</h2>
      <p class="sub">Every chapter is a district with jobs to do before the way out opens. Leave one with time to spare and it pays, in scrap for the stores ahead.</p>
      <div class="grid districts">${DISTRICTS}</div>
    </div>
    <div class="split sec" style="align-items:stretch">
      <div class="card" style="display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr));align-items:center">
        <div>
          <div class="kicker">Multiplayer</div>
          <h2 class="ph2">Not everyone gets out</h2>
          <p class="sub" style="margin-bottom:16px">The same streets with up to seven others in them, and one exit with seats for half of you. The server runs the round, so what happens is what happened.</p>
          <a class="btn red" href="/play">Find a room</a>
        </div>
        <img src="/intro/bg-zombie-portrait.webp" alt="" loading="lazy" style="width:100%;border-radius:12px;aspect-ratio:4/3;object-fit:cover;filter:saturate(.8) brightness(.8)" />
      </div>
      <div class="panel">
        <h3>Top of today</h3>
        <ol id="top5"><li class="msg">Loading the board&hellip;</li></ol>
        <a class="btn ghost sm" href="/ranks">All rankings</a>
      </div>
    </div>
    <div class="sec card deduce">
      <div>
        <div class="kicker">Our other game &middot; Deduce</div>
        <h2 class="ph2">Who in the room is infected?</h2>
        <p class="sub" style="margin-bottom:14px">Surviving the streets is one thing. Reading people is another. In Deduce, one player is secretly Patient Zero and turns someone new every round. The rest of you have to talk, vote and find them before the room is lost.</p>
        <ul><li>Lie, scheme, and frame the innocent, or catch the one who does</li><li>Vote someone out every round; a wrong guess spreads it</li><li>Stake USDm on Celo and the survivors split the pot</li></ul>
        <a class="btn red" href="https://deduce.zplague.xyz" target="_blank" rel="noopener">Test your instincts on Deduce &rarr;</a>
      </div>
      <div class="vote" aria-hidden="true"><span>?</span><span>?</span><span class="sus">!</span><span>?</span><span class="sus">?</span><span>?</span></div>
    </div>
  </div>`;
  },
  mount(root) {
    // each count opens its board on the Ranks page (solo: Today; multiplayer: Rooms)
    root.querySelectorAll<HTMLAnchorElement>('a.stat[data-board]').forEach((a) => a.addEventListener('click', () => {
      try { sessionStorage.setItem('zp.board', a.dataset.board!); } catch { /* the Ranks page opens on Today */ }
    }));
    void api<{ rounds: number; escapes: number }>('/rooms/today').then((r) => {
      const b = root.querySelector('[data-k=escapes]');
      if (b && r) b.textContent = fmt(r.escapes);
    });
    void board('night').then((b) => {
      const list = root.querySelector('#top5');
      if (!list) return;
      if (!b) { list.innerHTML = '<li class="msg">The board is not reachable right now. You can still play.</li>'; return; }
      root.querySelector('[data-k=players]')!.textContent = fmt(b.of);
      root.querySelector('[data-k=best]')!.textContent = b.rows[0] ? fmt(b.rows[0].value) : '—';
      list.innerHTML = b.rows.length
        ? b.rows.slice(0, 5).map((r) => `<li><span><i>#${r.rank}</i>${esc(r.name)}</span><span>${fmt(r.value)} pts</span></li>`).join('')
        : '<li class="msg">Nobody has a score in today\'s city yet. Be the first.</li>';
      const st = root.querySelector('[data-k=status]');
      if (st) {
        void board('streak').then((s) => {
          const n = b.me, k = s?.me;
          st.innerHTML = `<span class="k">Your night</span>`
            + (n ? `<span><b>#${n.rank}</b> <span class="muted">of ${fmt(b.of)}</span></span><span><b>${fmt(n.value)}</b> <span class="muted">pts</span></span><span class="tag">${esc(n.title)}</span>`
              : '<span class="muted">No run in today\'s city yet.</span>')
            + `<span><b>${k ? k.value : 0}</b> <span class="muted">${k?.value === 1 ? 'night' : 'nights'} streak</span></span>`
            + (n?.toNext ? `<span class="muted">${fmt(n.toNext.gap)} pts to pass ${esc(n.toNext.name)}</span>` : '');
        });
      }
    });
  },
};

// ---------------------------------------------------------------- play

const stakingOn = !!(import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_STAKE_STACKS;
/** The tag on rooms that need an account: gone once you are signed in. */
const needsSignIn = () => (account() ? '' : '<span class="tag m">Sign in</span>');
export const play: Page = {
  title: 'Play',
  html: () => `
  <div class="wrap page">
    ${head('Choose your night', 'Play', 'Today\'s city is the same for everyone and counts for the board. Rooms put you on the streets with others. On a phone, the game turns sideways when it starts.')}
    ${loading}
    ${account() ? '<p class="muted" style="margin:-6px 0 14px;font-size:15px">What you carry is set in the <a href="/armoury">Armoury</a>.</p>' : ''}
    <div class="modes">
      <button class="mode hot" type="button" data-play="solo" disabled><span class="ico">${ICON.bio}</span><span class="body"><h3>Today's city <span class="tag g">Counts for ranks</span></h3><p>Solo &middot; three districts &middot; the same streets for everyone today &middot; your ranked loadout</p>${carrying('ranked')}</span>${ICON.chev}</button>
      <button class="mode" type="button" data-play="quick" disabled><span class="ico a">${ICON.users}</span><span class="body"><h3>Join a public room ${needsSignIn()}</h3><p>Multiplayer: we put you with whoever is waiting, or open a new room anyone can join &middot; 2 to 8 players</p><p class="live" data-k="live" hidden></p></span>${ICON.chev}</button>
      <button class="mode" type="button" data-play="create" disabled><span class="ico p">${ICON.door}</span><span class="body"><h3>Private room ${needsSignIn()}</h3><p>Multiplayer, friends only: make a room, then share its five-letter code or an invite link</p></span>${ICON.chev}</button>
      <div class="mode" style="cursor:default"><span class="ico b">${ICON.key}</span><span class="body"><h3>Join with a code</h3><p>A friend read out their room's code? Type it here.</p>
        <form data-join><input name="code" maxlength="5" placeholder="CODE" autocomplete="off" autocapitalize="characters" aria-label="Room code" /><button class="btn sm" type="submit" disabled data-play="join">Join</button></form></span></div>
      <button class="mode" type="button" data-play="practice" disabled><span class="ico g">${ICON.dice}</span><span class="body"><h3>Random city <span class="tag m">Not ranked</span></h3><p>A new city every time, with everything you own and no points limit. Pays half the ZP, and is not on the board.</p>${carrying('open')}</span>${ICON.chev}</button>
      <button class="mode" type="button" data-play="rooms" disabled data-k="staked"><span class="ico a">${ICON.coin}</span><span class="body"><h3>Staked rooms ${needsSignIn()}<span class="tag g">ZP</span>${stakingOn ? '<span class="tag">USDm &middot; USDT</span>' : ''}</h3><p>Everyone stakes the same and those who get out split the pot. Stake ZP from 50 a seat${stakingOn ? ', or real USDm and USDT on Celo from a wallet' : ''}.</p></span>${ICON.chev}</button>
    </div>
    <div class="sec grid">
      <div class="card"><div class="ph">Guests</div><h3>About three minutes free</h3><p>Play straight away. After a few minutes the game asks you to sign in to carry on: free, with Google, a passkey or a wallet.</p></div>
      <div class="card"><div class="ph">Sound</div><h3>Turn it up</h3><p>You will hear them before you see them: footsteps, coughs, screamers, engines.</p></div>
      <div class="card"><div class="ph">Phones</div><h3>Sideways to play</h3><p>The site works upright; the game asks you to turn your phone when it starts. On iPhone, play from the Home Screen for full screen.</p></div>
    </div>
  </div>`,
  mount(root) {
    // who is about, on the public-room button: a lobby without a list of empty rooms
    const out = root.querySelector<HTMLElement>('[data-k=live]');
    if (!out) return;
    const show = async () => {
      const n = await api<{ waiting: number; playing: number }>('/rooms/live');
      if (!out.isConnected) return;
      const bits = [n?.waiting ? `${n.waiting} waiting in a public room` : '', n?.playing ? `${n.playing} playing now` : ''].filter(Boolean);
      out.hidden = !bits.length;
      out.textContent = bits.join(' · ');
      setTimeout(() => { if (out.isConnected) void show(); }, 15000);
    };
    void show();
  },
};

// ---------------------------------------------------------------- ranks

const EMPTY: Record<Kind, string> = {
  night: 'Nobody has a score in today\'s city yet. Be the first: everyone plays the same streets today.',
  week: 'No scores this week yet.',
  streak: 'No one has got out of the city two nights running. Yet.',
  rooms: 'Play three rounds of multiplayer signed in to be listed.',
};
export const ranks: Page = {
  title: 'Ranks',
  html: () => `
  <div class="wrap page">
    ${head('Rankings', 'Leaderboards', 'Every run is replayed on the server before it counts, so the scores here are the ones that really happened. Titles go by where you stand among everyone on the board.')}
    <div class="seg" role="tablist">${(Object.keys(BOARD_NAMES) as Kind[]).map((k, i) => `<button type="button" role="tab" data-kind="${k}"${i ? '' : ' class="on"'}>${BOARD_NAMES[k]}</button>`).join('')}</div>
    <div data-k="board"><div class="loading"><i></i>Loading the board&hellip;</div></div>
  </div>`,
  mount(root, ctx) {
    const out = root.querySelector<HTMLElement>('[data-k=board]')!;
    let kind: Kind = (sessionStorage.getItem('zp.board') as Kind | null) ?? 'night';
    const show = async () => {
      root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
      out.innerHTML = '<div class="loading"><i></i>Loading the board&hellip;</div>';
      const want = kind, b = await board(kind);
      if (want !== kind) return; // switched while it loaded
      out.innerHTML = b ? drawBoard(b) : '<p class="muted">The board is not reachable right now.</p>';
      out.querySelector('[data-signin]')?.addEventListener('click', () => signInThen(ctx.refresh));
    };
    root.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      kind = b.dataset.kind as Kind;
      try { sessionStorage.setItem('zp.board', kind); } catch { /* fine */ }
      void show();
    }));
    void show();
  },
};
function drawBoard(b: Board): string {
  const v = (n: number) => `${fmt(n)} ${unitOf(b, n)}`;
  const me = b.me
    ? `<div class="mine">You: <b>#${b.me.rank}</b> of ${fmt(b.of)} &middot; <b>${esc(b.me.title)}</b> &middot; ${v(b.me.value)}${b.me.toNext ? ` &middot; ${fmt(b.me.toNext.gap)} to pass ${esc(b.me.toNext.name)}` : ''}</div>`
    : account() ? '' : '<div class="mine">Sign in and play to see where you stand. <button class="linkish" type="button" data-signin>Sign in</button></div>';
  if (!b.rows.length) return `${me}<div class="empty"><span class="ico">${ICON.trophy}</span><p><b>The board is empty</b>${EMPTY[b.kind]}</p></div>${rules(b)}`;
  const top = b.rows.slice(0, 3), order = top.length === 3 ? [top[1]!, top[0]!, top[2]!] : top;
  const pod = `<div class="podium">${order.map((r) => `<div class="pod${r === top[0] ? ' p1' : ''}"><div class="medal">#${r.rank}</div><span class="n">${esc(r.name)}</span><span class="tag r">${esc(r.title)}</span><div class="v">${v(r.value)}</div></div>`).join('')}</div>`;
  const myName = account() ? shown(account()!) : null;
  const rows = `<ol class="rows">${b.rows.map((r) => `<li${r.name === myName ? ' class="me"' : ''}><span class="rk">#${r.rank}</span><span class="n"><b>${esc(r.name)} <span class="tag r">${esc(r.title)}</span></b><span class="d">${esc(detail(b.kind, r.detail))}</span></span><span class="v">${v(r.value)}</span></li>`).join('')}</ol>`;
  return `${me}${pod}${rows}${rules(b)}`;
}
const rules = (b: Board) => (b.rules.length ? `<details class="rules"><summary>How this board is scored</summary><ul>${b.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : '');

// ---------------------------------------------------------------- profile

export const profile: Page = {
  title: 'Profile',
  html: () => {
    const me = account();
    if (!me) return `
  <div class="wrap page">
    ${head('Your record', 'Profile')}
    <div class="card" style="max-width:640px">
      <h3>Sign in to keep a record</h3>
      <p>Signed in, your best run each night goes on the leaderboard, your streak counts, your last self waits for you where you fell, and multiplayer opens. It is free: Google, a passkey, or a wallet like MiniPay.</p>
      <p style="margin-top:16px"><button class="btn" type="button" data-signin>Sign in</button></p>
    </div>
  </div>`;
    return `
  <div class="wrap page">
    ${head('Your record', 'Profile')}
    <div class="prof">
      <div>
        <div class="pcard">
          <div class="pname" data-k="pname"><h2>${esc(shown(me))}</h2>${me.name ? `<button class="iconbtn" type="button" data-k="rename" aria-label="Change your name" title="Change your name">${ICON.edit}</button>` : ''}</div>
          <div class="addr"><span>${esc(short(me.address))}</span><button class="iconbtn sm" type="button" data-k="copy" aria-label="Copy address" title="Copy address">${ICON.copy}</button></div>
          <div class="muted" data-k="since" style="font-size:13px;margin-top:4px">&nbsp;</div>
          <form data-k="name"${me.name ? ' hidden' : ''}><input name="name" maxlength="20" placeholder="Pick a name others see" value="${esc(me.name ?? '')}" aria-label="Name" autocomplete="off" /><button class="btn sm" type="submit">Save</button>${me.name ? '<button class="btn ghost sm" type="button" data-k="cancel">Cancel</button>' : ''}</form>
          <div class="err" data-k="nameerr" style="font-size:14px;min-height:1.2em;margin-top:4px"></div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
          <button class="btn sm" type="button" data-play="solo" disabled>Play now</button>
          <button class="btn ghost sm" type="button" data-k="out">Sign out</button>
        </div>
      </div>
      <div>
        <div class="status" data-k="bank" style="margin-bottom:20px"><span class="k">Bank</span><span class="muted">&hellip;</span><a class="btn ghost sm" href="/armoury" style="margin-left:auto">Armoury</a></div>
        <div class="kicker">Standing</div>
        <div class="boxes" data-k="boxes" style="margin:8px 0 26px">${(Object.keys(BOARD_NAMES) as Kind[]).map((k) => `<div class="box" data-box="${k}"><div class="k">${BOARD_NAMES[k]}</div><b>&mdash;</b><small>&nbsp;</small></div>`).join('')}</div>
        <div class="kicker">Last nights</div>
        <ul class="runs" data-k="runs" style="margin-top:8px"><li><span class="body muted">Loading&hellip;</span></li></ul>
      </div>
    </div>
  </div>`;
  },
  mount(root, ctx) {
    const me = account();
    if (!me) return;
    root.querySelector('[data-k=out]')?.addEventListener('click', () => {
      if (!confirm(`Sign out ${shown(me)} on this device?`)) return;
      void import('../net/account').then((m) => { m.signOut(); ctx.refresh(); });
    });
    const form = root.querySelector<HTMLFormElement>('[data-k=name]')!;
    const nameBox = root.querySelector<HTMLElement>('[data-k=pname]')!;
    const input = form.elements.namedItem('name') as HTMLInputElement;
    const errBox = root.querySelector('[data-k=nameerr]')!;
    const editing = (on: boolean) => { form.hidden = !on; nameBox.hidden = on; errBox.textContent = ''; if (on) { input.value = me.name ?? ''; input.focus(); input.select(); } };
    root.querySelector('[data-k=rename]')?.addEventListener('click', () => editing(true));
    root.querySelector('[data-k=cancel]')?.addEventListener('click', () => editing(false));
    root.querySelector('[data-k=copy]')?.addEventListener('click', (e) => {
      const b = e.currentTarget as HTMLElement;
      void navigator.clipboard?.writeText(me.address).then(() => { b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200); });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      if (v === me.name) { editing(false); return; }
      const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
      btn.disabled = true;
      void setName(v).then((err) => { btn.disabled = false; if (err) errBox.textContent = err; else ctx.refresh(); });
    });
    for (const k of Object.keys(BOARD_NAMES) as Kind[]) {
      void board(k).then((b) => {
        const box = root.querySelector(`[data-box=${k}]`);
        if (!box || !b) return;
        box.querySelector('b')!.textContent = b.me ? `#${b.me.rank}` : '—';
        box.querySelector('small')!.textContent = b.me ? `${b.me.title} · ${fmt(b.me.value)} ${unitOf(b, b.me.value)}` : k === 'rooms' ? 'Three rounds to be listed' : 'Not on it yet';
      });
    }
    void import('./kit').then((k) => k.armoury()).then((a) => {
      const b = root.querySelector('[data-k=bank] .muted');
      if (b && a) b.innerHTML = `<b style="color:#e8e0cc">${fmt(a.cash)}</b> ZP &middot; ${a.owned.kit.length} items owned &middot; ${a.loans.length} on loan`;
      const card = root.querySelector<HTMLElement>('.pcard');
      if (card && a) card.style.backgroundImage = `linear-gradient(180deg, rgba(6,11,6,0) 35%, #060b06 80%), radial-gradient(ellipse at 50% 30%, rgba(132,204,22,.16), transparent 60%), url(/survivors/${a.loadouts.ranked.survivor ?? 'sam'}.webp)`;
    });
    void api<Me>('/me').then((m) => {
      const list = root.querySelector('[data-k=runs]');
      if (!list) return;
      if (!m) { list.innerHTML = '<li><span class="body muted">Could not load your nights. Your sign-in may have expired: sign out and in again.</span></li>'; return; }
      root.querySelector('[data-k=since]')!.textContent = `Joined ${new Date(m.account.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} · ${m.okRuns} checked ${m.okRuns === 1 ? 'run' : 'runs'}`;
      list.innerHTML = m.runs.length ? m.runs.map((r) => {
        const won = r.outcome === 'won';
        const what = won ? `Got out with ${Math.round(r.secondsLeft)}s left` : `${r.lossReason === 'caught' ? 'Caught' : 'Turned'} in district ${r.chapter + 1}`;
        return `<li class="${won ? 'won' : ''}"><span class="body"><b>${what}</b> <span class="tag ${won ? 'g' : 'r'}">${won ? 'Escaped' : 'Lost'}</span><small>${r.kills} kills &middot; ${ago(r.createdAt)}</small></span>`
          + `<span class="v">${r.replayOk ? `${fmt(r.score)} pts<small>&#10003; verified</small>` : '<small style="color:#ff7a6b">not verified</small>'}</span></li>`;
      }).join('') : '<li><span class="body muted">No nights yet. Play now\'s city and it shows up here.</span></li>';
    });
  },
};

// ---------------------------------------------------------------- how to play

export const how: Page = {
  title: 'How to play',
  html: () => `
  <div class="wrap page">
    ${head('Field manual', 'How to play', 'You were bitten in Port Halden. The quarantine is closing district by district, and one last helicopter leaves tonight from the far side of the city.')}
    <div class="split">
      <div class="card"><div class="ph">The goal</div><h3>Get out before you turn</h3>
        <ol class="steps"><li><b>Do the district's jobs.</b> The yellow arrow and the ring on your map show the next one.</li><li><b>Find the way out.</b> It opens once the required jobs are done: the subway, the barricade gate, the landing zone.</li><li><b>Watch the clock.</b> It is your infection. Bites take time off; antiviral doses put it back.</li></ol></div>
      <div class="card"><div class="ph">Every day</div><h3>A new city, the same for everyone</h3><p>Today's streets, houses and stores are laid out the same for every player, so the board is a fair fight. A random city is new every time and does not count.</p></div>
    </div>
    <div class="sec"><div class="kicker">The night</div><h2 class="ph2">Three districts</h2><div class="grid three">${DISTRICTS}</div></div>
    <div class="sec"><div class="kicker">What is out there</div><h2 class="ph2">The city plays back</h2><div class="grid three">${THREATS}</div></div>
    <div class="sec">
      <div class="kicker">Controls</div><h2 class="ph2">Pick it up in a minute</h2>
      <div class="card only-touch"><div class="ph">On a phone</div><h3>Thumbs</h3><p style="margin-bottom:14px">Drag anywhere on the screen to move. The buttons sit on the right, under your thumb:</p>
        <div class="pads"><div><span>FIRE</span>Shoot, or swing the baton</div><div><span>USE</span>Search, talk, drive, open (shows up when there is something)</div><div><span>&#8635;</span>Reload</div><div><span>SWAP</span>Change weapon</div><div><span>THROW</span>A bottle, to pull them away</div><div><span>LIGHT</span>Your flashlight on or off</div></div>
        <p style="margin-top:14px">Tap the minimap for the full city map. <button class="linkish" type="button" data-toggle="show-keys">Show keyboard controls</button></p></div>
      <div class="card only-keys"><div class="ph">On a keyboard</div><h3>Keys</h3>
        <div class="keys"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></span><span>Move</span><span><kbd>Space</kbd></span><span>Fire</span><span><kbd>E</kbd></span><span>Use: search, talk, drive, open</span>
          <span><kbd>R</kbd></span><span>Reload</span><span><kbd>Q</kbd></span><span>Swap weapon</span><span><kbd>F</kbd></span><span>Flashlight</span><span><kbd>G</kbd></span><span>Throw a bottle</span><span><kbd>M</kbd></span><span>Full map</span></div>
        <p style="margin-top:14px">The mouse is not needed. <button class="linkish" type="button" data-toggle="show-touch">Show phone controls</button></p></div>
    </div>
    <div class="sec split">
      <div><div class="kicker">Scoring</div><h2 class="ph2">What counts</h2><ul class="steps" data-k="rules"><li class="muted">Loading the rules&hellip;</li></ul></div>
      <div class="card"><div class="ph">Multiplayer</div><h3>Rooms</h3><p>2 to 8 players on the same streets, one exit with seats for half of you. Join a public room puts you with whoever is waiting; a private room is joined by its code or an invite link. Rooms need a sign-in, and three rounds put you on the rooms board.</p></div>
    </div>
    <div class="sec faq"><div class="kicker">Questions</div><h2 class="ph2">Before you ask</h2>
      <details><summary>Do I need a wallet?</summary><p>No. Sign in with Google or a passkey, and a wallet is made for you. MiniPay and other wallet browsers can sign in with the wallet they already have.</p></details>
      <details><summary>Is it free?</summary><p>Yes. Guests get about three minutes before the game asks for a (free) sign-in. Scrap (what you find and spend during a night) and ZP (what you bank between nights) are game currencies: neither is money and neither can be withdrawn. Crypto staked rooms, when they open, are the only part that uses real money, and they are optional.</p></details>
      <details><summary>Why do I have to turn my phone?</summary><p>The streets need the width, and the controls need both thumbs. The site itself works upright; only the game asks you to turn.</p></details>
      <details><summary>How do I get full screen on iPhone?</summary><p>Safari will not let a web page hide its bars. Tap Share, then Add to Home Screen, and play from the new icon: it opens full screen.</p></details>
      <details><summary>What is the Armoury?</summary><p>Where you spend the ZP your nights and rounds bank: weapons, gear and supplies you keep, upgrades, and survivors with perks. You choose a loadout for ranked nights (everyone gets the same 8 points, so it is choice, not power) and one for random cities. Rooms use your ranked loadout. You can borrow kit for a night, and top up with USDm where it is open. ZP stays in the game: it is never paid out.</p></details>
      <details><summary>Can someone fake a score?</summary><p>Every run is sent as the inputs that made it, and the server plays it again before it counts. A run that does not replay to the same result is not on the board.</p></details>
      <details><summary>Where is my progress kept?</summary><p>Signed in, on the server: your runs, your standing and your last self. As a guest, only on this device.</p></details>
    </div>
  </div>`,
  mount(root) {
    root.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => b.addEventListener('click', () => document.documentElement.classList.toggle(b.dataset.toggle!)));
    void board('night').then((b) => {
      const ul = root.querySelector('[data-k=rules]');
      if (ul) ul.innerHTML = b?.rules.length ? b.rules.map((r) => `<li>${esc(r)}</li>`).join('') : '<li>Clearing districts, getting out and the time you have left count most; kills, people helped and a clean run add to it; bites and doses cost a little. Only your best run of the night counts.</li>';
    });
  },
};

// ---------------------------------------------------------------- armoury

export const armouryPage: Page = {
  title: 'Armoury',
  html: () => account() ? `
  <div class="wrap page">
    ${head('Between nights', 'Armoury', 'Earn ZP by playing, buy weapons, gear and supplies to keep, upgrade what you own, or borrow kit for a night. Then choose what you carry in.')}
    <div data-k="armoury"><div class="loading"><i></i>Opening the armoury&hellip;</div></div>
  </div>` : `
  <div class="wrap page">
    ${head('Between nights', 'Armoury')}
    <div class="card" style="max-width:640px"><h3>Sign in to arm yourself</h3><p>Signed in, every verified night banks ZP. Spend it on weapons, gear and upgrades you keep, or borrow kit for a night, and choose the loadout you carry in.</p><p style="margin-top:16px"><button class="btn" type="button" data-signin>Sign in</button></p></div>
  </div>`,
  mount(root) {
    const into = root.querySelector<HTMLElement>('[data-k=armoury]');
    if (into) void import('./armoury').then((m) => m.mountArmoury(into));
  },
};

// ---------------------------------------------------------------- admin

export const admin: Page = {
  title: 'Admin',
  html: () => `<div class="wrap page">${head('Operations', 'Admin', `Server, players, live rooms, stake contracts and settlements.${account() ? '' : ' Sign in with an admin wallet.'}`)}<div data-k="admin"></div></div>`,
  mount(root, ctx) { ctx.admin(root.querySelector('[data-k=admin]')!); },
};

export const notFound: Page = {
  title: 'Not found',
  html: () => `<div class="wrap page">${head('404', 'Nothing here', 'Whatever was on this street is gone.')}<a class="btn" href="/">Back home</a></div>`,
};

