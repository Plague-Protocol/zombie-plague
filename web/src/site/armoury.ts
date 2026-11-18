// The Armoury page: the bank, the two loadouts (ranked, inside the budget everyone shares; practice, without a limit),
// the shop (kit to buy or borrow for a night), weapon upgrades, and loans. Loaded only when the page opens; the
// catalogue and rules are core/armoury.ts, the same file the server checks against.
import {
  ALL_WEAPONS, DAILY_RATION, KIT, kitDef, LATE_DAYS, LEND_RATES, lendFee, lenderCut, loanFee, LOAN_DAYS, loadoutPoints, MAX_LOANS, RANKED_POINTS, ROUND_PAY,
  STANDARD, UPGRADE_NAMES, upgradable, upgradePrice, weaponsOf, type KitId, type LendRate, type LoanDays, type Loadout, type UpId,
  MAX_GRIT, perkAt, ROSTER, SURVIVORS, svLevel, svPrice, type SurvivorId,
} from '../../../core/armoury';
import { UPGRADE_LEVELS, WEAPON_NAMES } from '../../../core/config';
import type { WeaponKind } from '../../../core/types';
import { armoury, armouryPost, esc, fmt, itemArt, type ArmouryView } from './kit';

type Slot = 'ranked' | 'open';
const GROUPS: Array<[string, string]> = [['weapon', 'Weapons'], ['gear', 'Gear'], ['supply', 'Supplies']];
const clone = (l: Loadout): Loadout => ({ ...l, kit: [...l.kit], ups: { ...l.ups } });

export function mountArmoury(root: HTMLElement): void {
  let v: ArmouryView | null = null;
  let slot: Slot = 'ranked';
  let draft: Record<Slot, Loadout> = { ranked: { kit: [], ups: {} }, open: { kit: [], ups: {} } };
  let dirty = false, msg = '', err = '', busy = false;
  let term: LoanDays = 3; // what the shop's borrow prices are for
  const lendRate: Partial<Record<KitId, LendRate>> = {};
  /** When something is due, in words: the day and time, and how long from now (by the server's clock). */
  const due = (iso: string): string => {
    const d = new Date(iso), left = d.getTime() - new Date(v!.now).getTime();
    const when = d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    if (left <= 0) return `was due ${when}`;
    const h = Math.round(left / 36e5);
    return `due ${when} &middot; in ${h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(left / 6e4))} min`}`;
  };
  const listed = (id: KitId) => v?.listings.find((x) => x.item === id);

  const take = (next: ArmouryView, keepDraft = false) => {
    v = next;
    if (!keepDraft || !dirty) { draft = { ranked: clone(next.loadouts.ranked), open: clone(next.loadouts.open) }; dirty = false; }
  };
  const borrowed = () => (v?.loans ?? []).map((l) => l.item as KitId);
  const has = (id: KitId) => !!v && ((v.owned.kit.includes(id) && !listed(id)) || borrowed().includes(id));

  function draw(): void {
    if (!v) return;
    const l = draft[slot], pts = loadoutPoints(l), over = slot === 'ranked' && pts > RANKED_POINTS;
    const avail = KIT.filter((k) => has(k.id));
    const ids = Object.keys(SURVIVORS) as SurvivorId[];
    const mine = ids.filter((id) => svLevel(v!.owned, id) > 0), who = l.survivor ?? 'sam', grit = l.grit ?? 0;
    const brings = weaponsOf(l);
    const upRows = brings.flatMap((w) => upgradable(w).map((u) => [w, u, v!.owned.ups[`${w}.${u}` as UpId] ?? 0] as const)).filter(([, , n]) => n > 0);
    root.innerHTML = `
    <div class="status" style="margin-bottom:22px">
      <span class="k">Bank</span><span><b style="${v.cash < 0 ? 'color:#ff7a6b' : ''}">${fmt(v.cash)}</b> <span class="muted">cash</span></span>
      <span class="muted">Earned today <b style="font-size:20px">${fmt(v.earnedToday)}</b> of ${fmt(v.dailyCap)}</span>
      ${v.cash < 0 ? '<span class="tag r">You owe from a loan: your next nights pay it back</span>' : ''}
    </div>
    <p class="sub" style="margin-top:-8px">Every verified night banks a share of its score (practice nights half), the first night of the day adds ${DAILY_RATION}, and a multiplayer round pays ${ROUND_PAY.played}, plus ${ROUND_PAY.escaped} if you get out.</p>

    <div class="split">
      <div class="card">
        <div class="ph">Loadout</div>
        <h3>What you carry in</h3>
        <div class="seg" style="grid-template-columns:1fr 1fr;margin:10px 0 14px">
          <button type="button" data-a="slot:ranked" class="${slot === 'ranked' ? 'on' : ''}">Ranked &middot; ${loadoutPoints(draft.ranked)}/${RANKED_POINTS} pts</button>
          <button type="button" data-a="slot:open" class="${slot === 'open' ? 'on' : ''}">Practice &middot; no limit</button>
        </div>
        <p class="slotnote">${slot === 'ranked'
          ? `<b>Used for tonight's city and multiplayer rooms</b>, the nights that count on the leaderboard. To keep it fair, everyone gets the same ${RANKED_POINTS} points to spend on what they own: owning more gives you choice, not more power.`
          : '<b>Used for practice nights</b>: a random city that is not on the leaderboard. Bring anything you own, with no points limit, to try kit out or learn the streets. Practice nights bank half the cash.'}</p>
        <div class="ph">Survivor</div>
        <div class="who">${mine.map((id) => `<button type="button" class="face${who === id ? ' on' : ''}" data-a="sv:${id}" title="${esc(ROSTER[id].perk)}"><img src="/survivors/${id}.webp" alt="" width="60" height="72" /><span>${SURVIVORS[id].name}</span></button>`).join('')}</div>
        <label class="ups" style="margin:8px 0 14px">${SURVIVORS[who].name}'s perk<select data-a="grit">${Array.from({ length: svLevel(v.owned, who) }, (_, k) => `<option value="${k}"${grit === k ? ' selected' : ''}>${k ? `Level ${k}: ${perkAt(who, k)} (${k} pt${k > 1 ? 's' : ''})` : `Base: ${perkAt(who, 0)}`}</option>`).join('')}</select></label>
        <div class="ph">Kit</div>
        <div class="pick">${[...STANDARD.map((w) => `<span class="chip2 on fixed"><img src="${itemArt(w)}" alt="" />${WEAPON_NAMES[w]}</span>`), ...avail.map((k) => `<button type="button" class="chip2${l.kit.includes(k.id) ? ' on' : ''}" data-a="kit:${k.id}"><img src="${itemArt(k.id)}" alt="" />${esc(k.name)} <i>${k.points}</i>${v!.owned.kit.includes(k.id) ? '' : ' <span class="tag">Borrowed</span>'}</button>`)].join('')}</div>
        ${avail.length ? '' : '<p class="muted" style="font-size:14px">You start with the pistol and baton. Buy or borrow kit below to bring more.</p>'}
        ${upRows.length ? `<div class="ph" style="margin-top:14px">Upgrades</div><div class="ups">${upRows.map(([w, u, n]) => `<label>${WEAPON_NAMES[w]} &middot; ${UPGRADE_NAMES[u]}<select data-a="up:${w}.${u}">${Array.from({ length: n + 1 }, (_, k) => `<option value="${k}"${(l.ups[`${w}.${u}` as UpId] ?? 0) === k ? ' selected' : ''}>${k ? `Level ${k} (${k} pt${k > 1 ? 's' : ''})` : 'Off'}</option>`).join('')}</select></label>`).join('')}</div>` : ''}
        <label class="ups" style="margin-top:12px">In hand at the start<select data-a="hand">${brings.map((w) => `<option value="${w}"${(l.hand ?? 'pistol') === w ? ' selected' : ''}>${WEAPON_NAMES[w]}</option>`).join('')}</select></label>
        <div class="meter${over ? ' over' : ''}" style="margin-top:14px"><i style="width:${slot === 'ranked' ? Math.min(100, (pts / RANKED_POINTS) * 100) : 100}%"></i></div>
        <p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0 0">
          <button class="btn sm" type="button" data-a="save"${!dirty || over || busy ? ' disabled' : ''}>Save loadouts</button>
          <span class="${over ? 'err' : 'muted'}" style="font-size:14px">${over ? `${pts} points: ${pts - RANKED_POINTS} over the ranked budget` : dirty ? 'Not saved yet' : 'Saved. The game uses it from your next night.'}</span>
        </p>
      </div>
      <div class="card">
        <div class="ph">Loans &middot; ${v.loans.length} of ${MAX_LOANS}</div>
        <h3>Borrowed kit</h3>
        <p style="margin-bottom:12px">Borrow for 1, 3 or 7 days; the fee is paid when you borrow. Give it back any time to free a place. Kept past its due time, it costs a late fee for each day started, and after ${LATE_DAYS} days it goes back by itself.</p>
        ${v.loans.length ? `<ul class="loans">${v.loans.map((x) => `<li class="${x.overdue ? 'late' : ''}"><img src="${itemArt(x.item)}" alt="" /><span class="body"><b>${esc(kitDef(x.item as KitId).name)}</b><small>${x.lender ? `from ${esc(x.lender)}` : 'from the armoury'} &middot; ${due(x.dueAt)}</small>${x.overdue ? `<small class="err">Overdue: ${fmt(x.lateFee)} a day until it is back</small>` : ''}</span><button class="btn ghost sm" type="button" data-a="return:${x.id}"${busy ? ' disabled' : ''}>Return</button></li>`).join('')}</ul>` : '<p class="muted" style="font-size:14px">Nothing borrowed. Every item in the shop can be borrowed.</p>'}
        ${v.listings.length ? `<div class="ph" style="margin-top:18px">Lent out</div><ul class="loans">${v.listings.map((x) => `<li><img src="${itemArt(x.item)}" alt="" /><span class="body"><b>${esc(kitDef(x.item as KitId).name)}</b><small>${x.status === 'lent' ? `with ${esc(x.borrower ?? 'someone')} &middot; ${due(x.dueAt!)}` : `on the rack at ${x.rate === 100 ? 'the armoury’s price' : `${x.rate}% of the armoury’s price`}`}</small></span>${x.status === 'open' ? `<button class="btn ghost sm" type="button" data-a="unlist:${x.id}"${busy ? ' disabled' : ''}>Take back</button>` : '<span class="tag">Out</span>'}</li>`).join('')}</ul>` : ''}
        ${topupCard()}
      </div>
    </div>
    ${msg || err ? `<p class="${err ? 'err' : 'muted'}" style="margin:16px 0 0">${esc(err || msg)}</p>` : ''}

    <div class="sec" style="margin-top:40px"><div class="kicker">Roster</div><h2 class="ph2">Survivors</h2><p class="sub">Who you play. Each has one perk that grows over three levels; a level brought into a ranked night costs a loadout point.</p>
      <div class="grid roster">${ids.map((id) => {
        const lv = svLevel(v!.owned, id), next = lv + 1, price = next <= MAX_GRIT + 1 ? svPrice(id, next) : 0;
        return `<div class="card sv${lv ? ' own' : ''}">
          <div class="svart"><img src="/survivors/${id}.webp" alt="" loading="lazy" width="150" height="180" />${lv ? `<span class="tag g">${lv > 1 ? `Perk ${lv - 1}` : 'Yours'}</span>` : ''}</div>
          <div class="ph">${esc(ROSTER[id].role)}</div><h3>${SURVIVORS[id].name}</h3>
          <p>${esc(ROSTER[id].blurb)}</p>
          <p class="perk"><b>${esc(ROSTER[id].perk)}</b>${lv ? perkAt(id, lv - 1) : perkAt(id, 0)}${next <= MAX_GRIT + 1 && lv ? ` &rarr; ${perkAt(id, lv)}` : ''}</p>
          <div class="buy">${next > MAX_GRIT + 1 ? '<span class="tag g">Fully upgraded</span>' : `<button class="btn${lv ? ' ghost' : ''} sm" type="button" data-a="buy:sv.${id}"${v!.cash < price || busy ? ' disabled' : ''}>${lv ? `Perk ${lv}` : 'Unlock'} &middot; ${fmt(price)}</button>`}</div></div>`;
      }).join('')}</div>
    </div>

    <div class="sec" style="margin-top:40px"><div class="kicker">Shop</div><h2 class="ph2">Buy, borrow or lend</h2>
      <p class="sub">Buy to keep. Borrow from the armoury, or from another player for less. What you own you can lend out: others pay to borrow it and you bank ${Math.round(lenderCut(100))}% of the fee, but it stays off your loadouts while it is up for loan.</p>
      <div class="termbar"><span class="k">Borrow for</span><div class="seg">${LOAN_DAYS.map((d) => `<button type="button" data-a="term:${d}" class="${term === d ? 'on' : ''}">${d} day${d > 1 ? 's' : ''}</button>`).join('')}</div></div>
    </div>
    ${GROUPS.map(([g, title]) => `<div class="sec" style="margin-top:28px"><h3 class="grouph">${title}</h3><div class="grid">${KIT.filter((k) => k.group === g).map((k) => shopCard(k.id)).join('')}</div></div>`).join('')}

    <div class="sec" style="margin-top:40px"><div class="kicker">Workshop</div><h2 class="ph2">Upgrades</h2><p class="sub">Permanent, for weapons you own. A level brought into a night costs a loadout point.</p>
      <div class="grid">${ALL_WEAPONS.filter((w) => (STANDARD as readonly string[]).includes(w) || v!.owned.kit.includes(w as KitId)).map((w) => `<div class="card"><div class="itemart sm"><img src="${itemArt(w)}" alt="" loading="lazy" width="320" height="200" /></div><h3>${WEAPON_NAMES[w]}</h3>${upgradable(w as WeaponKind).map((u) => {
        const n = v!.owned.ups[`${w}.${u}` as UpId] ?? 0, price = n < UPGRADE_LEVELS ? upgradePrice(w as WeaponKind, u, n + 1) : 0;
        return `<div class="uprow"><span>${UPGRADE_NAMES[u]}</span><span class="pips">${Array.from({ length: UPGRADE_LEVELS }, (_, k) => `<em class="${k < n ? 'on' : ''}"></em>`).join('')}</span>${n < UPGRADE_LEVELS ? `<button class="btn ghost sm" type="button" data-a="buy:${w}.${u}"${v!.cash < price || busy ? ' disabled' : ''}>${fmt(price)}</button>` : '<span class="tag g">Max</span>'}</div>`;
      }).join('')}</div>`).join('')}</div>
    </div>`;
  }

  /** A shop card: buy it; borrow it (from the armoury, or the cheapest player offer) for the chosen term; or, owned, lend it out. */
  function shopCard(id: KitId): string {
    const k = kitDef(id), own = v!.owned.kit.includes(id), loan = v!.loans.find((x) => x.item === id), mineListed = listed(id);
    const offer = v!.offers[id], full = v!.loans.length >= MAX_LOANS, broke = v!.cash < 0;
    const tag = own ? (mineListed ? `<span class="tag">${mineListed.status === 'lent' ? 'Lent out' : 'Up for loan'}</span>` : '<span class="tag g">Owned</span>') : loan ? '<span class="tag">Borrowed</span>' : '';
    let actions: string;
    if (own && mineListed) actions = mineListed.status === 'open' ? `<button class="btn ghost sm" type="button" data-a="unlist:${mineListed.id}"${busy ? ' disabled' : ''}>Take back</button>` : `<span class="muted" style="font-size:14px">With ${esc(mineListed.borrower ?? 'someone')}, ${due(mineListed.dueAt!)}</span>`;
    else if (own) {
      const r = lendRate[id] ?? 100;
      actions = `<label class="lendrow">Lend at<select data-a="rate:${id}">${LEND_RATES.map((x) => `<option value="${x}"${x === r ? ' selected' : ''}>${x === 100 ? 'armoury price' : `${x}% of it`}</option>`).join('')}</select></label>
        <button class="btn ghost sm" type="button" data-a="lend:${id}"${busy ? ' disabled' : ''}>Lend out</button>
        <small class="muted lendnote">You bank ${fmt(lenderCut(lendFee(id, 1, r)))} / ${fmt(lenderCut(lendFee(id, 3, r)))} / ${fmt(lenderCut(lendFee(id, 7, r)))} when it goes for 1 / 3 / 7 days</small>`;
    } else if (loan) actions = `<button class="btn sm" type="button" data-a="buy:${id}"${v!.cash < k.price || busy ? ' disabled' : ''}>Buy ${fmt(k.price)}</button><span class="muted" style="font-size:14px">Borrowed, ${due(loan.dueAt)}</span>`;
    else {
      const off = offer ? lendFee(id, term, offer.rate as LendRate) : 0;
      actions = `<button class="btn sm" type="button" data-a="buy:${id}"${v!.cash < k.price || busy ? ' disabled' : ''}>Buy ${fmt(k.price)}</button>
        <button class="btn ghost sm" type="button" data-a="borrow:${id}"${broke || full || busy ? ' disabled' : ''} title="From the armoury, ${term} day${term > 1 ? 's' : ''}">Borrow ${fmt(loanFee(id, term))}</button>
        ${offer ? `<button class="btn ghost sm offer" type="button" data-a="borrowp:${id}:${offer.listing}"${broke || full || busy || v!.cash < off ? ' disabled' : ''} title="From ${esc(offer.lender)}, ${term} day${term > 1 ? 's' : ''}">From ${esc(offer.lender)} &middot; ${fmt(off)}</button>` : ''}`;
    }
    return `<div class="card shop${own ? ' own' : ''}"><div class="itemart"><img src="${itemArt(id)}" alt="" loading="lazy" width="320" height="200" /></div><div class="ph">${k.points} pt${k.points > 1 ? 's' : ''} in a loadout</div><h3>${esc(k.name)} ${tag}</h3><p>${esc(k.blurb)}</p>
      <div class="buy">${actions}</div></div>`;
  }

  /** The stablecoin top-up: packs, paid from the signed-in wallet; a paid transaction is kept until the server has counted it. */
  function topupCard(): string {
    const t = v!.topup;
    if (!t) return '<div class="card" style="margin-top:16px;border-style:dashed"><div class="ph">USDm</div><h3>Top up with USDm <span class="tag">Coming soon</span></h3><p>Buy cash with USDm on Celo, for players who would rather not wait. Earning by playing stays the main way in.</p></div>';
    const wallet = !!(window as unknown as { ethereum?: unknown }).ethereum;
    const owed = pendingTx();
    return `<div class="card" style="margin-top:16px"><div class="ph">${esc(t.symbol)} on Celo</div><h3>Top up</h3>
      <p>${fmt(t.rate)} cash for each ${esc(t.symbol)}, sent from the wallet you signed in with. The server checks the payment on the chain before it adds the cash.</p>
      ${owed ? `<p class="err" style="margin-top:10px">A payment is waiting to be counted.</p><div class="buy"><button class="btn sm" type="button" data-a="topup-retry"${busy ? ' disabled' : ''}>Count my payment</button></div>` : ''}
      <div class="buy">${[1, 5, 10].map((n) => `<button class="btn ghost sm" type="button" data-a="topup:${n}"${!wallet || busy || owed ? ' disabled' : ''}>${n} ${esc(t.symbol)} &rarr; ${fmt(n * t.rate)}</button>`).join('')}</div>
      ${wallet ? '' : '<p class="muted" style="font-size:14px;margin-top:8px">Paying needs a wallet in the browser: open the game in MiniPay or a wallet app.</p>'}</div>`;
  }
  const PENDING = 'zp.topup.pending';
  const pendingTx = (): string | null => { try { return localStorage.getItem(PENDING); } catch { return null; } };
  async function count(tx: string): Promise<void> {
    const r = await armouryPost('topup', { tx });
    if (r.view) { take(r.view, true); try { localStorage.removeItem(PENDING); } catch { /* fine */ } msg = `Paid. ${fmt(r.view.credited ?? 0)} cash added.`; err = ''; }
    else if (/already been counted/.test(r.error ?? '')) { try { localStorage.removeItem(PENDING); } catch { /* fine */ } msg = 'That payment was already counted.'; }
    else err = `${r.error ?? 'The server did not count it yet.'} Your payment is safe: try "Count my payment" again in a moment.`;
  }
  async function topup(n: number): Promise<void> {
    const t = v!.topup!;
    busy = true; err = ''; msg = 'Confirm the payment in your wallet…'; draw();
    try {
      const m = await import('../net/stake');
      const tx = await m.payToken({ token: t.token, chainId: t.chainId }, t.treasury, BigInt(n) * 10n ** BigInt(t.decimals));
      try { localStorage.setItem(PENDING, tx); } catch { /* counted now or never shown */ }
      msg = 'Paid. Counting it…'; draw();
      await count(tx);
    } catch (e) { err = e instanceof Error ? e.message.slice(0, 160) : 'The wallet refused.'; msg = ''; }
    busy = false; draw();
  }

  async function act(path: 'buy' | 'borrow' | 'return' | 'lend' | 'unlist' | 'loadout', body: unknown, done: string): Promise<void> {
    busy = true; err = ''; msg = ''; draw();
    const r = await armouryPost(path, body);
    busy = false;
    if (r.view) { take(r.view, path !== 'loadout'); if (path === 'loadout') dirty = false; msg = done; } else err = r.error ?? 'Failed.';
    draw();
  }

  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!b || b.tagName === 'SELECT' || !v) return;
    const [k, arg, arg2] = b.dataset.a!.split(':') as [string, string, string | undefined];
    if (k === 'slot') { slot = arg as Slot; draw(); }
    else if (k === 'sv') {
      const l = draft[slot], id = arg as SurvivorId;
      if (id === 'sam') { delete l.survivor; delete l.grit; } else { l.survivor = id; l.grit = Math.min(l.grit ?? 0, svLevel(v.owned, id) - 1); if (!l.grit) delete l.grit; }
      dirty = true; msg = ''; draw();
    }
    else if (k === 'kit') {
      const l = draft[slot], id = arg as KitId;
      l.kit = l.kit.includes(id) ? l.kit.filter((x) => x !== id) : [...l.kit, id];
      // what is no longer brought cannot be in hand or upgraded
      const brings = weaponsOf(l);
      if (l.hand && !brings.includes(l.hand)) delete l.hand;
      for (const key of Object.keys(l.ups)) if (!brings.includes(key.split('.')[0] as WeaponKind)) delete l.ups[key as UpId];
      dirty = true; msg = ''; draw();
    } else if (k === 'save') void act('loadout', draft, 'Loadouts saved.');
    else if (k === 'topup') void topup(Number(arg));
    else if (k === 'topup-retry') { const tx = pendingTx(); if (tx) { busy = true; draw(); void count(tx).then(() => { busy = false; draw(); }); } }
    else if (k === 'buy') void act('buy', { item: arg }, 'Bought.');
    else if (k === 'term') { term = Number(arg) as LoanDays; draw(); }
    else if (k === 'borrow') void act('borrow', { item: arg, days: term }, `Borrowed for ${term} day${term > 1 ? 's' : ''}. Add it to a loadout to take it into your next night.`);
    else if (k === 'borrowp') void act('borrow', { item: arg, days: term, listing: arg2 }, `Borrowed for ${term} day${term > 1 ? 's' : ''}. Add it to a loadout to take it into your next night.`);
    else if (k === 'return') void act('return', { loan: arg }, 'Returned. That loan place is free again.');
    else if (k === 'lend') { if (confirm(`Put your ${kitDef(arg as KitId).name} up for loan? It comes off your loadouts until you take it back.`)) void act('lend', { item: arg, rate: lendRate[arg as KitId] ?? 100 }, 'Up for loan. You are paid each time someone borrows it.'); }
    else if (k === 'unlist') void act('unlist', { listing: arg }, 'Taken back. Add it to a loadout to carry it again.');
  });
  root.addEventListener('change', (e) => {
    const s = e.target as HTMLSelectElement, a = s.dataset.a;
    if (!a) return;
    if (a.startsWith('rate:')) { lendRate[a.slice(5) as KitId] = Number(s.value) as LendRate; draw(); return; }
    const l = draft[slot];
    if (a === 'hand') { if (s.value === 'pistol') delete l.hand; else l.hand = s.value as WeaponKind; }
    else if (a === 'grit') { const n = Number(s.value); if (n) { l.grit = n; l.survivor = l.survivor ?? 'sam'; } else { delete l.grit; if (l.survivor === 'sam') delete l.survivor; } }
    else if (a.startsWith('up:')) { const key = a.slice(3) as UpId, n = Number(s.value); if (n) l.ups[key] = n; else delete l.ups[key]; }
    dirty = true; msg = ''; draw();
  });

  void armoury().then((x) => {
    if (!x) { root.innerHTML = '<p class="muted">The armoury is not reachable right now. Try again in a moment.</p>'; return; }
    take(x); draw();
  });
}
