// The Armoury page: the bank, the two loadouts (ranked, inside the budget everyone shares; practice, without a limit),
// the shop (kit to buy or borrow for a night), weapon upgrades, and loans. Loaded only when the page opens; the
// catalogue and rules are core/armoury.ts, the same file the server checks against.
import {
  ALL_WEAPONS, DAILY_RATION, KIT, kitDef, loanFee, loadoutPoints, RANKED_POINTS, ROUND_PAY, STANDARD, UPGRADE_NAMES, upgradable, upgradePrice, weaponsOf,
  type KitId, type Loadout, type UpId,
  MAX_GRIT, perkAt, ROSTER, SURVIVORS, svLevel, svPrice, type SurvivorId,
} from '../../../core/armoury';
import { UPGRADE_LEVELS, WEAPON_NAMES } from '../../../core/config';
import type { WeaponKind } from '../../../core/types';
import { armoury, armouryPost, esc, fmt, type ArmouryView } from './kit';

type Slot = 'ranked' | 'open';
const GROUPS: Array<[string, string]> = [['weapon', 'Weapons'], ['gear', 'Gear'], ['supply', 'Supplies']];
const clone = (l: Loadout): Loadout => ({ ...l, kit: [...l.kit], ups: { ...l.ups } });

export function mountArmoury(root: HTMLElement): void {
  let v: ArmouryView | null = null;
  let slot: Slot = 'ranked';
  let draft: Record<Slot, Loadout> = { ranked: { kit: [], ups: {} }, open: { kit: [], ups: {} } };
  let dirty = false, msg = '', err = '', busy = false;

  const take = (next: ArmouryView, keepDraft = false) => {
    v = next;
    if (!keepDraft || !dirty) { draft = { ranked: clone(next.loadouts.ranked), open: clone(next.loadouts.open) }; dirty = false; }
  };
  const borrowed = () => (v?.loans ?? []).map((l) => l.item as KitId);
  const has = (id: KitId) => !!v && (v.owned.kit.includes(id) || borrowed().includes(id));

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
          <button type="button" data-a="slot:ranked" class="${slot === 'ranked' ? 'on' : ''}">Ranked &middot; ${loadoutPoints(draft.ranked)}/${RANKED_POINTS}</button>
          <button type="button" data-a="slot:open" class="${slot === 'open' ? 'on' : ''}">Practice &middot; open</button>
        </div>
        <p class="muted" style="font-size:14px;margin:0 0 12px">${slot === 'ranked' ? `Tonight's city is ranked: everyone gets the same ${RANKED_POINTS} points to spend on what they own.` : 'Practice nights take whatever you own: no limit, and they pay half.'}</p>
        <div class="ph">Survivor</div>
        <div class="who">${mine.map((id) => `<button type="button" class="face${who === id ? ' on' : ''}" data-a="sv:${id}" title="${esc(ROSTER[id].perk)}"><img src="/survivors/${id}.webp" alt="" width="60" height="72" /><span>${SURVIVORS[id].name}</span></button>`).join('')}</div>
        <label class="ups" style="margin:8px 0 14px">${SURVIVORS[who].name}'s perk<select data-a="grit">${Array.from({ length: svLevel(v.owned, who) }, (_, k) => `<option value="${k}"${grit === k ? ' selected' : ''}>${k ? `Level ${k}: ${perkAt(who, k)} (${k} pt${k > 1 ? 's' : ''})` : `Base: ${perkAt(who, 0)}`}</option>`).join('')}</select></label>
        <div class="ph">Kit</div>
        <div class="pick">${[...STANDARD.map((w) => `<span class="chip2 on fixed">${WEAPON_NAMES[w]}</span>`), ...avail.map((k) => `<button type="button" class="chip2${l.kit.includes(k.id) ? ' on' : ''}" data-a="kit:${k.id}">${esc(k.name)} <i>${k.points}</i>${v!.owned.kit.includes(k.id) ? '' : ' <span class="tag">Borrowed</span>'}</button>`)].join('')}</div>
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
        <div class="ph">Loans</div>
        <h3>Borrowed for a night</h3>
        <p style="margin-bottom:12px">Take kit you cannot afford yet into your next night. The fee comes out of what that night banks; if it banks less, you owe the rest and cannot borrow again until it is paid. Unused loans lapse after a day, free.</p>
        ${v.loans.length ? `<ul class="runs">${v.loans.map((x) => `<li class="won"><span class="body"><b>${esc(kitDef(x.item as KitId).name)}</b><small>fee ${fmt(x.fee)} when a night carries it</small></span></li>`).join('')}</ul>` : '<p class="muted" style="font-size:14px">Nothing borrowed.</p>'}
        <div class="card" style="margin-top:16px;border-style:dashed"><div class="ph">USDm</div><h3>Top up with USDm <span class="tag">Coming soon</span></h3><p>Buy cash with USDm on Celo, for players who would rather not wait. Earning by playing stays the main way in.</p></div>
      </div>
    </div>
    ${msg || err ? `<p class="${err ? 'err' : 'muted'}" style="margin:16px 0 0">${esc(err || msg)}</p>` : ''}

    <div class="sec" style="margin-top:40px"><div class="kicker">Roster</div><h2 class="ph2">Survivors</h2><p class="sub">Who you play. Each has one perk that grows over three levels; a level brought into a ranked night costs a loadout point.</p>
      <div class="grid roster">${ids.map((id) => {
        const lv = svLevel(v!.owned, id), next = lv + 1, price = next <= MAX_GRIT + 1 ? svPrice(id, next) : 0;
        return `<div class="card sv${lv ? ' own' : ''}"><img src="/survivors/${id}.webp" alt="" loading="lazy" width="150" height="180" /><div>
          <div class="ph">${esc(ROSTER[id].role)}</div><h3>${SURVIVORS[id].name} ${lv ? `<span class="tag g">${lv > 1 ? `Perk ${lv - 1}` : 'Yours'}</span>` : ''}</h3>
          <p>${esc(ROSTER[id].blurb)}</p><p style="margin-top:6px;color:#e8e0cc">${esc(ROSTER[id].perk)}: ${lv ? perkAt(id, lv - 1) : perkAt(id, 0)}${next <= MAX_GRIT + 1 && lv ? ` &rarr; ${perkAt(id, lv)}` : ''}</p>
          <div class="buy">${next > MAX_GRIT + 1 ? '<span class="tag g">Max</span>' : `<button class="btn${lv ? ' ghost' : ''} sm" type="button" data-a="buy:sv.${id}"${v!.cash < price || busy ? ' disabled' : ''}>${lv ? `Perk ${lv}` : 'Unlock'} &middot; ${fmt(price)}</button>`}</div></div></div>`;
      }).join('')}</div>
    </div>

    ${GROUPS.map(([g, title]) => `<div class="sec" style="margin-top:40px"><div class="kicker">Shop</div><h2 class="ph2">${title}</h2><div class="grid">${KIT.filter((k) => k.group === g).map((k) => {
      const own = v!.owned.kit.includes(k.id), lent = borrowed().includes(k.id);
      return `<div class="card shop${own ? ' own' : ''}"><div class="ph">${k.points} pt${k.points > 1 ? 's' : ''} in a loadout</div><h3>${esc(k.name)} ${own ? '<span class="tag g">Owned</span>' : lent ? '<span class="tag">Borrowed</span>' : ''}</h3><p>${esc(k.blurb)}</p>
        ${own ? '' : `<div class="buy"><button class="btn sm" type="button" data-a="buy:${k.id}"${v!.cash < k.price || busy ? ' disabled' : ''}>Buy ${fmt(k.price)}</button>${lent ? '' : `<button class="btn ghost sm" type="button" data-a="borrow:${k.id}"${v!.cash < 0 || busy ? ' disabled' : ''}>Borrow ${fmt(loanFee(k.id))}</button>`}</div>`}</div>`;
    }).join('')}</div></div>`).join('')}

    <div class="sec" style="margin-top:40px"><div class="kicker">Workshop</div><h2 class="ph2">Upgrades</h2><p class="sub">Permanent, for weapons you own. A level brought into a night costs a loadout point.</p>
      <div class="grid">${ALL_WEAPONS.filter((w) => (STANDARD as readonly string[]).includes(w) || v!.owned.kit.includes(w as KitId)).map((w) => `<div class="card"><h3>${WEAPON_NAMES[w]}</h3>${upgradable(w as WeaponKind).map((u) => {
        const n = v!.owned.ups[`${w}.${u}` as UpId] ?? 0, price = n < UPGRADE_LEVELS ? upgradePrice(w as WeaponKind, u, n + 1) : 0;
        return `<div class="uprow"><span>${UPGRADE_NAMES[u]}</span><span class="pips">${Array.from({ length: UPGRADE_LEVELS }, (_, k) => `<em class="${k < n ? 'on' : ''}"></em>`).join('')}</span>${n < UPGRADE_LEVELS ? `<button class="btn ghost sm" type="button" data-a="buy:${w}.${u}"${v!.cash < price || busy ? ' disabled' : ''}>${fmt(price)}</button>` : '<span class="tag g">Max</span>'}</div>`;
      }).join('')}</div>`).join('')}</div>
    </div>`;
  }

  async function act(path: 'buy' | 'borrow' | 'loadout', body: unknown, done: string): Promise<void> {
    busy = true; err = ''; msg = ''; draw();
    const r = await armouryPost(path, body);
    busy = false;
    if (r.view) { take(r.view, path !== 'loadout'); if (path === 'loadout') dirty = false; msg = done; } else err = r.error ?? 'Failed.';
    draw();
  }

  root.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
    if (!b || b.tagName === 'SELECT' || !v) return;
    const [k, arg] = b.dataset.a!.split(':') as [string, string];
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
    else if (k === 'buy') void act('buy', { item: arg }, 'Bought.');
    else if (k === 'borrow') void act('borrow', { item: arg }, `Borrowed. Add it to a loadout to take it into your next night.`);
  });
  root.addEventListener('change', (e) => {
    const s = e.target as HTMLSelectElement, a = s.dataset.a;
    if (!a) return;
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
