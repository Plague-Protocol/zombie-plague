import { currentTask, fallenBlocks, finalChapter, isRevealed, requiredDone, type GameState } from '../../../core/state';
import { stepDef } from '../../../core/content';
import { shortName } from '../../../core/story';
import type { MapData, Vec2 } from '../../../core/types';

// The map is drawn rotated 45 degrees so that "up" on the map is "up" on screen (the camera's
// fixed yaw). World (x, y) -> map: rotate by +45 degrees.
export const ROT = Math.PI / 4;
const PX = 3; // pixels per world unit in the cached base image (sharp when the full map is zoomed in)

const DISTRICT_COLORS: Record<string, string> = {
  downtown: '#3b3e46', residential: '#33402f', park: '#26402a', industrial: '#3d3935', outskirts: '#3a332b', water: '#0f2a3d',
};
const SOLID_COLORS: Record<string, string> = {
  tower: '#15161a', building: '#15161a', shop: '#2a2622', house: '#4a3a30', warehouse: '#24272c', container: '#5a3a2a',
  store: '#8c2422', hospital: '#c8c8c0', bus: '#6a6a60', truck: '#3f4628', sandbag: '#7a6a4a', ambulance: '#d8d8d2', tree: '#2e5a33', deadtree: '#4a4136', water: '#0f2a3d',
};

/** The left safe-area inset (a phone's notch in landscape), in CSS px. */
export function insetLeft(): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--l')) || 0;
}

/** The map image (roads, districts, buildings), drawn once per district and again each time a block falls:
 * fallen blocks are red, with the street round them stained. */
export function drawBase(map: MapData, fallen: number[] = []): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = Math.ceil(map.size * PX);
  const g = c.getContext('2d')!;
  g.scale(PX, PX);
  g.fillStyle = '#5a5d63'; // roads
  g.fillRect(0, 0, map.size, map.size);
  for (const b of map.blocks) {
    g.fillStyle = DISTRICT_COLORS[b.district] ?? '#333';
    g.fillRect(b.x, b.y, b.size, b.size);
  }
  for (const i of fallen) {
    const b = map.blocks[i]!;
    g.fillStyle = 'rgba(150,24,16,.28)';
    g.fillRect(b.x - 4.5, b.y - 4.5, b.size + 9, b.size + 9);
    g.fillStyle = 'rgba(170,28,18,.5)';
    g.fillRect(b.x, b.y, b.size, b.size);
  }
  for (const d of map.decor) {
    if (d.kind === 'pier') { g.fillStyle = '#5a4a35'; g.fillRect(d.x, d.y, d.w, d.h); }
    if (d.kind === 'canopy') { g.fillStyle = '#7a7670'; g.fillRect(d.x, d.y, d.w, d.h); }
  }
  for (const o of map.buildings) {
    const col = SOLID_COLORS[o.kind];
    if (!col) continue;
    g.fillStyle = col;
    if (o.kind === 'tree' || o.kind === 'deadtree') { g.beginPath(); g.arc(o.x + o.w / 2, o.y + o.h / 2, 1.6, 0, Math.PI * 2); g.fill(); }
    else g.fillRect(o.x, o.y, o.w, o.h);
  }
  return c;
}

interface Marker { pos: Vec2; color: string; size: number; label?: string; shape?: 'dot' | 'square' | 'ring' | 'cash' | 'cross' | 'ladder'; rim?: boolean }

export function markers(s: GameState): Marker[] {
  const out: Marker[] = [];
  const cur = currentTask(s);
  for (const t of s.tasks) {
    if (t.done || !isRevealed(s, t)) continue; // later steps stay hidden until they come up
    const piece = stepDef(t.id).parts?.name;
    t.parts?.forEach((q, i) => { if (!t.got![i]) out.push({ pos: q, color: '#f2b630', size: 4, shape: 'dot', label: piece }); });
    out.push({ pos: t.pos, color: t.required ? '#f2b630' : '#3f9be6', size: t === cur ? 7 : 5, shape: 'ring', label: t === cur ? shortName(t) : undefined });
  }
  if (s.safehouseKnown) out.push({ pos: s.safehouse, color: requiredDone(s) ? '#3ddc84' : '#d9534f', size: 8, shape: 'ring', label: finalChapter(s) ? 'Evac' : 'Subway' });
  if (s.escort) out.push({ pos: s.escort.pos, color: '#7fe08a', size: 4.5, shape: 'dot', label: s.escort.name });
  if (s.flare) out.push({ pos: s.flare.pos, color: '#ff4030', size: 5, shape: 'dot', label: 'lure' });
  for (const st of s.stores) out.push({ pos: st.pos, color: '#ff4b4b', size: 6, shape: 'cash', label: 'Weapons' });
  for (const v of s.survivors) {
    if (v.status === 'done') continue;
    out.push({ pos: v.pos, color: '#7fe08a', size: 6, shape: 'ring', label: v.name });
    if (v.request === 'fetch' && v.status === 'asked' && !v.carrying) out.push({ pos: v.fetchPos, color: '#7fe08a', size: 4, shape: 'dot', label: `${v.name}'s bag` });
  }
  for (const h of s.houses) if (!h.searched) out.push({ pos: h.pos, color: h.mark === 'infected' ? '#e0483a' : h.mark === 'clear' ? '#f2f2ee' : '#8f9ab0', size: h.mark ? 2.6 : 2.2, shape: 'dot' });
  for (const a of s.abandoned) out.push({ pos: a.pos, color: '#c06a50', size: 3.5, shape: 'dot', label: a.name });
  // antiviral doses: a green cross, and the nearest one keeps to the minimap's rim so you always know which way the next one is
  const pp = s.player.pos;
  const doses = s.pickups.filter((p) => !p.taken && p.kind === 'antiviral')
    .sort((a, b) => Math.hypot(a.pos.x - pp.x, a.pos.y - pp.y) - Math.hypot(b.pos.x - pp.x, b.pos.y - pp.y));
  doses.forEach((p, i) => out.push({ pos: p.pos, color: '#4ad27a', size: 4.5, shape: 'cross', label: 'Vaccine', rim: i === 0 }));
  for (const p of s.pickups) if (!p.taken && p.kind === 'jerrycan') out.push({ pos: p.pos, color: '#e05030', size: 3, shape: 'square' });
  for (const p of s.pickups) if (!p.taken && p.kind !== 'ammo' && p.kind !== 'bottles' && p.kind !== 'jerrycan' && p.kind !== 'antiviral') out.push({ pos: p.pos, color: p.kind === 'bat' || p.kind === 'machete' ? '#d0a070' : p.kind === 'vest' || p.kind === 'helmet' ? '#8cc4ff' : '#f2d060', size: 3.5, shape: 'dot' });
  for (const v of s.vehicles) if (!v.wrecked && v.id !== s.player.vehicleId) out.push({ pos: v.pos, color: '#e8e8e8', size: 3, shape: 'square' });
  for (const l of s.map.ladders) out.push({ pos: l.foot, color: '#d8b030', size: 3.4, shape: 'ladder', label: 'Ladder' }); // a way up
  return out;
}

export function drawMarker(g: CanvasRenderingContext2D, m: Marker, x: number, y: number, scale: number, labels: boolean): void {
  const r = m.size * scale;
  g.fillStyle = m.color;
  g.strokeStyle = m.color;
  g.lineWidth = Math.max(1.5, 2 * scale);
  switch (m.shape) {
    case 'ring': g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(x, y, r * 0.35, 0, Math.PI * 2); g.fill(); break;
    case 'square': g.fillRect(x - r, y - r, r * 2, r * 2); break;
    case 'cross': {
      const t = r * 0.42;
      g.fillStyle = '#06140b'; g.fillRect(x - r - 1, y - t - 1, r * 2 + 2, t * 2 + 2); g.fillRect(x - t - 1, y - r - 1, t * 2 + 2, r * 2 + 2);
      g.fillStyle = m.color; g.fillRect(x - r, y - t, r * 2, t * 2); g.fillRect(x - t, y - r, t * 2, r * 2);
      break;
    }
    case 'ladder': {
      g.lineWidth = Math.max(1, 1.2 * scale);
      g.beginPath();
      g.moveTo(x - r * 0.5, y - r); g.lineTo(x - r * 0.5, y + r); g.moveTo(x + r * 0.5, y - r); g.lineTo(x + r * 0.5, y + r);
      for (const k of [-0.5, 0, 0.5]) { g.moveTo(x - r * 0.5, y + k * r); g.lineTo(x + r * 0.5, y + k * r); }
      g.stroke();
      break;
    }
    case 'cash': g.fillRect(x - r, y - r, r * 2, r * 2); g.fillStyle = '#000'; g.font = `bold ${Math.round(r * 1.6)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', x, y + 0.5); break;
    default: g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  if (labels && m.label) {
    g.font = `${Math.round(11 * Math.max(1, scale))}px system-ui`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillStyle = '#fff';
    g.shadowColor = '#000';
    g.shadowBlur = 3;
    g.fillText(m.label, x, y - r - 3);
    g.shadowBlur = 0;
  }
}

export function drawPlayer(g: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(heading + ROT + Math.PI / 2);
  g.fillStyle = '#fff';
  g.strokeStyle = '#000';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.7, size * 0.8);
  g.lineTo(0, size * 0.4);
  g.lineTo(-size * 0.7, size * 0.8);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

export class CityMap {
  private base: HTMLCanvasElement | null = null;
  private seed = -1;
  private fallen = -1;
  private mini: HTMLCanvasElement;
  readonly full: HTMLCanvasElement;
  readonly overlay: HTMLElement;
  open = false;
  /** Where the player is (the full map opens on them). */
  player: Vec2 | null = null;
  /** The full-screen map: pan, pinch and draw. Loaded the first time it is opened. */
  private view: { opened(): void; closed(): void; draw(s: GameState, base: HTMLCanvasElement): void } | null = null;

  /** `live`: whether a night is on screen (the site and the title cover the game: no map over them). */
  constructor(onToggle: (open: boolean) => void, live: () => boolean = () => true) {
    this.mini = document.getElementById('minimap') as HTMLCanvasElement;
    this.full = document.getElementById('fullmap') as HTMLCanvasElement;
    this.overlay = document.getElementById('map-screen')!;
    const toggle = () => {
      this.open = !this.open;
      this.overlay.style.display = this.open ? 'flex' : 'none';
      if (this.open) {
        if (this.view) this.view.opened();
        else void import('./fullmap').then(({ FullMap }) => { this.view ??= new FullMap(this); if (this.open) this.view.opened(); });
      } else this.view?.closed();
      onToggle(this.open);
    };
    this.mini.addEventListener('pointerdown', (e) => { e.stopPropagation(); toggle(); });
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // typing, not asking for the map
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'KeyM' && (this.open || live())) toggle();
      else if (e.code === 'Escape' && this.open) toggle();
    });
    this.toggle = toggle;
  }

  toggle: () => void;

  private ensureBase(s: GameState): HTMLCanvasElement {
    if (!this.base || this.seed !== s.seed || this.fallen !== s.fallenN) {
      this.base = drawBase(s.map, fallenBlocks(s));
      this.seed = s.seed;
      this.fallen = s.fallenN;
    }
    return this.base;
  }

  /** The corner minimap, centred on the player, ~60 m around. */
  drawMini(s: GameState): void {
    this.player = s.player.pos; // the full map opens on the player
    const base = this.ensureBase(s);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = this.mini.clientWidth || 120;
    if (this.mini.width !== Math.round(size * dpr)) { this.mini.width = this.mini.height = Math.round(size * dpr); }
    const g = this.mini.getContext('2d')!;
    const R = (size * dpr) / 2;
    const worldR = 55;
    const k = R / worldR; // px per world unit
    const p = s.player.pos;
    g.save();
    g.clearRect(0, 0, R * 2, R * 2);
    g.beginPath();
    g.arc(R, R, R - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#0b0c0f';
    g.fillRect(0, 0, R * 2, R * 2);
    g.translate(R, R);
    g.rotate(ROT);
    g.drawImage(base, -p.x * k, -p.y * k, base.width * (k / PX), base.height * (k / PX));
    g.restore();
    // markers (positions rotated into minimap space, clamped to the rim when out of range)
    const cos = Math.cos(ROT), sin = Math.sin(ROT);
    g.save();
    for (const m of markers(s)) {
      const dx = m.pos.x - p.x, dy = m.pos.y - p.y;
      let x = (dx * cos - dy * sin) * k, y = (dx * sin + dy * cos) * k;
      const d = Math.hypot(x, y);
      const edge = R - 8 * dpr;
      if (d > edge) {
        if (m.shape !== 'ring' && !m.rim) continue; // only objectives (and the nearest vaccine) stick to the rim
        x *= edge / d; y *= edge / d;
      }
      drawMarker(g, m, R + x, R + y, dpr * 0.8, false);
    }
    drawPlayer(g, R, R, s.player.heading, 7 * dpr);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    g.arc(R, R, R - 1, 0, Math.PI * 2);
    g.stroke();
  }

  /** The full city map, while it is open. */
  drawFull(s: GameState): void {
    if (this.open && this.view) this.view.draw(s, this.ensureBase(s));
  }
}
