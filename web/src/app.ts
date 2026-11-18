// The site: what loads first. A header, the pages (home, play, ranks, profile, how to play, admin for admins), a footer
// and, on a phone, a tab bar. The game (main.ts: three.js, the city, its assets) is imported in the background as soon as
// this runs, so it is usually ready by the time someone picks a night; the buttons that start it wait for it.
import './site/site.css';
import { account, armoury, esc, ICON, isAdmin, shown, signInThen, board } from './site/kit';
import { admin, armouryPage, home, how, notFound, play, profile, ranks, type Ctx, type Page } from './site/pages';

// the cold open, once a session (its own chunk)
if (!document.documentElement.classList.contains('intro-seen')) void import('./ui/splash').then((m) => m.runSplash());

type Game = typeof import('./main');
let game: Game | null = null;
let gameErr = '';
/** Still not in after a while: a stalled connection never fails, so say so rather than spin for ever. */
let gameSlow = false;
setTimeout(() => { if (!game && !gameErr) { gameSlow = true; armPlay(); } }, 20000);
void import('./main').then((m) => { game = m; armPlay(); }, (e: unknown) => { gameErr = e instanceof Error ? e.message : String(e); armPlay(); });

const ROUTES: Record<string, Page> = { '/': home, '/play': play, '/armoury': armouryPage, '/ranks': ranks, '/profile': profile, '/how-to-play': how, '/admin': admin };
const NAV: Array<[string, string, string]> = [['/', 'Home', ICON.home], ['/play', 'Play', ICON.play], ['/armoury', 'Armoury', ICON.shieldGun], ['/ranks', 'Ranks', ICON.trophy], ['/profile', 'Profile', ICON.user], ['/how-to-play', 'How to play', ICON.book]];
const app = document.getElementById('app')!;
let adminOk = false;

// an old link (?admin) goes to the admin page
if (new URLSearchParams(location.search).has('admin')) history.replaceState(null, '', `/admin${keep()}`);

/** The query worth keeping from page to page (a test server). */
function keep(): string {
  const s = new URLSearchParams(location.search).get('server');
  return s ? `?server=${encodeURIComponent(s)}` : '';
}
const path = () => location.pathname.replace(/\/+$/, '') || '/';

function shell(): string {
  const me = account(), at = path();
  const links = [...NAV, ...(adminOk ? [['/admin', 'Admin', ICON.shield] as [string, string, string]] : [])];
  const a = ([p, label]: [string, string, string], cls = '') => `<a href="${p}" class="${[at === p ? 'on' : '', p === '/admin' ? 'admin' : '', cls].join(' ').trim()}">${label}</a>`;
  const tabs = NAV.slice(0, 5); // on a phone: Home, Play, Armoury, Ranks, Profile (the rest are in the menu)
  return `
  <header class="hn"><div class="wrap">
    <a class="brand" href="/"><img src="/intro/splash-mark.webp" alt="" width="32" height="32" /><span>ZOMBIE PLAGUE</span></a>
    <nav class="links" aria-label="Pages">${NAV.slice(0, 5).map((l) => a(l)).join('')}</nav>
    <div class="right">
      ${me ? `<a class="chip who" href="/profile" title="Your profile"><span>${esc(shown(me))}</span><i data-k="title" hidden></i></a>` : '<button class="chip who" type="button" data-signin>Sign in</button>'}
      <button class="btn sm" type="button" data-play="solo" disabled>Play</button>
      <details class="menu"><summary aria-label="Menu">&#9776;</summary><div>
        ${links.map((l) => a(l)).join('')}
        ${me ? `<a href="/profile">${esc(shown(me))}</a>` : '<button type="button" data-signin>Sign in</button>'}
      </div></details>
    </div>
  </div></header>
  <main id="page"></main>
  <footer class="foot"><div class="wrap">
    <div><a class="brand" href="/"><img src="/intro/splash-mark.webp" alt="" width="32" height="32" loading="lazy" /><span>ZOMBIE PLAGUE</span></a>
      <p>A survival horror night in your browser. Bitten in Port Halden: get to the last helicopter before you turn.</p></div>
    <div><h4>Play</h4><a href="/play">Today's city</a><a href="/play">Rooms</a><a href="/armoury">Armoury</a></div>
    <div><h4>Learn</h4><a href="/how-to-play">How to play</a><a href="/ranks">Leaderboards</a><a href="/profile">Profile</a></div>
    <div><h4>More</h4><a href="https://deduce.zplague.xyz" target="_blank" rel="noopener">Deduce</a><a href="mailto:support@zplague.xyz">Support</a></div>
  </div></footer>
  <nav class="tabs" style="--n:${tabs.length}" aria-label="Pages">${tabs.map(([p, label, icon]) => `<a href="${p}" class="${[at === p ? 'on' : '', p === '/admin' ? 'admin' : ''].join(' ').trim()}">${icon}${label}</a>`).join('')}</nav>`;
}

const ctx: Ctx = {
  refresh: () => { adminOk = false; render(); checkAdmin(); void armoury(); },
  admin: (into) => { void import('./net/admin').then((m) => m.openAdmin(into)); },
};

function render(): void {
  const page = ROUTES[path()] ?? notFound;
  app.innerHTML = shell();
  const main = app.querySelector<HTMLElement>('#page')!;
  main.innerHTML = page.html();
  document.title = page === home ? 'Zombie Plague' : `${page.title} · Zombie Plague`;
  page.mount?.(main, ctx);
  armPlay();
  // your title tonight, beside your name
  if (account()) void board('night').then((b) => { const t = app.querySelector<HTMLElement>('[data-k=title]'); if (t && b?.me) { t.textContent = b.me.title; t.hidden = false; } });
}

function go(to: string): void {
  history.pushState(null, '', to);
  render();
  const hash = to.split('#')[1];
  if (hash) document.getElementById(hash)?.scrollIntoView(); else app.scrollTop = 0;
}

/** Buttons that start the game work once it has loaded (and say so if it could not). */
function armPlay(): void {
  for (const b of app.querySelectorAll<HTMLButtonElement>('[data-play]')) b.disabled = !game;
  for (const l of app.querySelectorAll<HTMLElement>('[data-loading]')) {
    if (game) l.hidden = true;
    else if (gameErr) { l.className = 'err'; l.textContent = `The game could not load (${gameErr}). Reload the page to try again.`; }
    else if (gameSlow && !l.dataset.slow) {
      l.dataset.slow = '1';
      l.innerHTML = '<i></i>Still loading the city&hellip; a slow connection takes a while. <button class="linkish" type="button" data-reload>Reload</button> if it stays stuck.';
    }
  }
}

function checkAdmin(): void {
  void isAdmin().then((ok) => { if (ok !== adminOk) { adminOk = ok; render(); } });
}

app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const menu = app.querySelector<HTMLDetailsElement>('.menu');
  const link = t.closest<HTMLAnchorElement>('a[href^="/"]');
  if (link && !link.target && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
    e.preventDefault();
    if (menu) menu.open = false;
    go(link.getAttribute('href')! + (link.getAttribute('href')!.includes('?') ? '' : keep()));
    return;
  }
  if (t.closest('[data-reload]')) { location.reload(); return; }
  if (t.closest('[data-signin]')) { if (menu) menu.open = false; signInThen(ctx.refresh); return; }
  const btn = t.closest<HTMLButtonElement>('[data-play]');
  if (!btn || btn.disabled || !game || btn.dataset.play === 'join') return;
  const k = btn.dataset.play;
  if (k === 'solo' || k === 'practice') game.playSolo(k === 'practice');
  else if (k === 'quick' || k === 'create') game.openRooms({ act: k });
  else game.openRooms();
});
app.addEventListener('submit', (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>('[data-join]');
  if (!form) return;
  e.preventDefault();
  const code = (form.elements.namedItem('code') as HTMLInputElement).value.trim();
  if (!/^[A-Za-z]{5}$/.test(code)) { (form.elements.namedItem('code') as HTMLInputElement).focus(); return; }
  game?.openRooms({ join: code.toUpperCase() });
});
window.addEventListener('popstate', render);

render();
checkAdmin();
void armoury(); // the device's copy of your loadouts, for the game to start nights with
