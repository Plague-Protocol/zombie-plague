// The promotion banner under the header on every page: a bounty, a prize, a deal or news, with a live countdown to
// its deadline and one button. Several running at once take turns. A player can close one (remembered on this device).
// The promotions come from the server (/promos), made on the admin page.
import { api, esc } from './kit';

export interface Promo { id: string; kind: 'bounty' | 'prize' | 'deal' | 'news'; title: string; body: string; cta: { label: string; href: string } | null; endsAt: string; topupBonus: number }

const BADGE: Record<Promo['kind'], string> = { bounty: '🏆 Bounty', prize: '🎁 Prize', deal: '⚡ Deal', news: '📣 News' };
const HIDDEN = 'zp.promos.hidden';
let live: Promo[] = [];
let at = 0;
let fetchedAt = 0;

const hidden = (): string[] => { try { return JSON.parse(localStorage.getItem(HIDDEN) ?? '[]') as string[]; } catch { return []; } };
const hide = (id: string) => { try { localStorage.setItem(HIDDEN, JSON.stringify([...hidden(), id].slice(-30))); } catch { /* this visit only */ } };
const shown = () => { const h = hidden(); return live.filter((p) => !h.includes(p.id) && Date.parse(p.endsAt) > Date.now()); };

/** "2d 04:13:22", "04:13:22", or "ending" */
export function left(endsAt: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((Date.parse(endsAt) - now) / 1000));
  if (!s) return 'ending';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const hms = [h, m, x].map((n) => String(n).padStart(2, '0')).join(':');
  return d ? `${d}d ${hms}` : hms;
}

function html(p: Promo, n: number, of: number): string {
  const cta = p.cta ? `<a class="btn sm" href="${esc(p.cta.href)}"${/^https:/.test(p.cta.href) ? ' target="_blank" rel="noopener"' : ''}>${esc(p.cta.label)}</a>` : '';
  return `<div class="promo ${p.kind}" role="region" aria-label="${esc(BADGE[p.kind])}"><div class="wrap">
    <span class="pbadge">${BADGE[p.kind]}</span>
    <span class="ptext"><b>${esc(p.title)}</b>${p.body ? `<span>${esc(p.body)}</span>` : ''}</span>
    <span class="pclock" data-ends="${esc(p.endsAt)}" title="Time left">⏳ ${left(p.endsAt)}</span>
    ${cta}
    ${of > 1 ? `<span class="pdots">${n + 1}/${of}</span>` : ''}
    <button class="pclose" type="button" data-promo-close="${esc(p.id)}" aria-label="Close">×</button>
  </div></div>`;
}

/** Draw the banner into `slot` (the shell's mount point), from what was last fetched. */
export function drawPromos(slot: HTMLElement | null): void {
  if (!slot) return;
  const list = shown();
  if (!list.length) { slot.innerHTML = ''; return; }
  at %= list.length;
  slot.innerHTML = html(list[at]!, at, list.length);
}

/** Keep the banner current: fetch now and every few minutes, tick its clock each second, take turns every 8 s. */
export function startPromos(slot: () => HTMLElement | null): void {
  const fetchIt = async () => { const r = await api<Promo[]>('/promos'); if (r) { live = r; fetchedAt = Date.now(); drawPromos(slot()); } };
  void fetchIt();
  setInterval(() => { if (Date.now() - fetchedAt > 5 * 60_000) void fetchIt(); }, 60_000);
  let tick = 0;
  setInterval(() => {
    const el = slot();
    if (!el) return;
    if (++tick % 8 === 0 && shown().length > 1) { at++; drawPromos(el); return; }
    const c = el.querySelector<HTMLElement>('.pclock');
    if (c?.dataset.ends) { const t = left(c.dataset.ends); c.textContent = `⏳ ${t}`; if (t === 'ending') drawPromos(el); }
  }, 1000);
  document.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-promo-close]');
    if (!b) return;
    hide(b.dataset.promoClose!);
    drawPromos(slot());
  });
}
