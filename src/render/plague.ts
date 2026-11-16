// What the plague left in the streets, and what it does to the air: the quarantine teams' marks on the
// doors (which tell you what is inside), body bags laid out on the pavement, burn sites, warning
// placards, spores hanging in the blocks that have fallen, and the rings a noise sends out.
// All of it is a handful of merged meshes: no textures, no extra lights beyond the fire pool.
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Group, InstancedBufferAttribute, InstancedMesh, type Material, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, Object3D, Points, PointsMaterial, RingGeometry, Vector3,
} from 'three';
import { MeshBuilder } from './mesh';
import type { LightSource } from './city';
import { PITCH, STREET, cellOf } from '../core/map';
import { chance, fork, int, range, shuffle } from '../core/rng';
import type { GameState } from '../core/state';
import type { MapData, Vec2 } from '../core/types';

const RED = 0xb01c14, WHITE = 0xc9cdc4, TAPE = 0xb89a18;

/** A spot on the pavement beside a street point, and whether that street runs north-south. */
function kerb(map: MapData, p: Vec2, side: number): { at: Vec2; vertical: boolean } | null {
  const vertical = Math.abs((p.x - STREET / 2) % PITCH) < 1e-6;
  const at = vertical ? { x: p.x + side * 3.3, y: p.y } : { x: p.x, y: p.y + side * 3.3 };
  return map.blocked[cellOf(map, at)] === 1 ? null : { at, vertical };
}

/**
 * The street dressing for a district. `solid` is the city's own weathered material (lit by your
 * flashlight); the marks, tape and embers are drawn unlit so they read in the dark, like paint that
 * catches what light there is.
 */
export function plagueDressing(s: GameState, solid: Material): { group: Group; lights: LightSource[] } {
  const rng = fork(s.seed, 'dress');
  const lit = new MeshBuilder(), glow = new MeshBuilder();
  const lights: LightSource[] = [];

  // the doors: a red X (infected inside) with tape across it, or a white ring (cleared)
  for (const h of s.houses) {
    if (!h.mark) continue;
    const x = h.pos.x, z = h.pos.y - 1.2 + 0.14, y = 1.5;
    if (h.mark === 'infected') {
      for (const a of [0.8, -0.8]) { const m = glow.mark(); glow.box(x, y, z, 1.7, 0.16, 0.02, RED); glow.tiltZ(m, a, x, y); }
      for (const ty of [0.75, 2.3]) {
        glow.box(x, ty, z + 0.04, 2.3, 0.11, 0.02, TAPE);
        for (let k = -3; k <= 3; k += 2) glow.box(x + k * 0.3, ty, z + 0.05, 0.16, 0.11, 0.02, 0x15140f);
      }
    } else {
      for (let k = 0; k < 8; k++) {
        const m = glow.mark();
        glow.box(x, y + 0.62, z, 0.56, 0.13, 0.02, WHITE);
        glow.tiltZ(m, (k / 8) * Math.PI * 2, x, y);
      }
    }
  }

  const keep: Vec2[] = [
    s.safehouse, s.player.pos, ...s.tasks.flatMap((t) => [t.pos, ...(t.parts ?? [])]), ...s.pickups.map((p) => p.pos), ...s.crates.map((c) => c.pos),
    ...s.houses.map((h) => h.pos), ...s.stores.map((st) => st.pos), ...s.survivors.flatMap((v) => [v.pos, v.fetchPos]),
  ];
  const free = (at: Vec2, r: number) => keep.every((k) => Math.hypot(k.x - at.x, k.y - at.y) > r);
  const spots = shuffle(rng, s.map.points);
  const place = (n: number, r: number, f: (at: Vec2, vertical: boolean, side: number) => void) => {
    for (let k = 0; k < n && spots.length;) {
      const side = chance(rng, 0.5) ? 1 : -1;
      const q = kerb(s.map, spots.pop()!, side);
      if (!q || !free(q.at, r) || Math.min(q.at.x, q.at.y) < 5 || Math.max(q.at.x, q.at.y) > s.map.size - 5) continue; // not hanging over the edge of the city
      keep.push(q.at);
      f(q.at, q.vertical, side);
      k++;
    }
  };

  // body bags, laid out in rows where the teams left them (one in each row has come open)
  place(9, 7, (at, vertical) => {
    const n = int(rng, 2, 4), open = int(rng, 0, n - 1);
    for (let k = 0; k < n; k++) {
      const o = (k - (n - 1) / 2) * 0.95, x = at.x + (vertical ? 0 : o), z = at.y + (vertical ? o : 0);
      const tone = chance(rng, 0.3) ? 0x8a8a52 : 0xa9aca4;
      const m = lit.mark();
      lit.box(x, 0.2, z, 2.0, 0.34, 0.62, tone, tone).box(x + 0.75, 0.3, z, 0.42, 0.36, 0.5, tone).box(x, 0.375, z, 1.9, 0.02, 0.05, 0x2a2b2e);
      if (k === open) lit.box(x - 0.3, 0.38, z, 0.8, 0.03, 0.3, 0x1a0606);
      if (vertical) continue;
      // lie them across the pavement, not along it
      lit.turnY(m, x, z);
    }
    lit.disc(at.x, at.y, range(rng, 0.8, 1.5), 0.03, 0x2a0909, 9, 0.5, int(rng, 1, 1e6));
  });

  // burn sites: a scorched ring, what is left in it, embers still going
  place(4, 12, (at) => {
    lit.disc(at.x, at.y, 2.0, 0.03, 0x0b0a09, 11, 0.35, int(rng, 1, 1e6));
    for (let k = 0; k < 7; k++) {
      const a = range(rng, 0, Math.PI * 2), r = range(rng, 0, 1.1), h = range(rng, 0.18, 0.5);
      lit.box(at.x + Math.cos(a) * r, h / 2, at.y + Math.sin(a) * r, range(rng, 0.4, 1.3), h, range(rng, 0.25, 0.5), 0x15110e, 0x1d1713);
    }
    for (let k = 0; k < 9; k++) {
      const a = range(rng, 0, Math.PI * 2), r = range(rng, 0, 1.2);
      glow.box(at.x + Math.cos(a) * r, range(rng, 0.1, 0.5), at.y + Math.sin(a) * r, 0.1, 0.06, 0.1, chance(rng, 0.5) ? 0xff5a1c : 0xa82a0c);
    }
    lights.push({ pos: new Vector3(at.x, 1.3, at.y), color: 0xff5a20, kind: 'fire', broken: true });
  });

  // quarantine placards on posts
  place(8, 6, (at) => {
    lit.box(at.x, 1.2, at.y, 0.09, 2.4, 0.09, 0x6a6e74);
    lit.box(at.x, 2.3, at.y + 0.06, 0.95, 0.95, 0.05, 0xc9a227).box(at.x, 2.3, at.y + 0.09, 0.8, 0.8, 0.02, 0x15140f).box(at.x, 2.3, at.y + 0.1, 0.66, 0.66, 0.02, 0xc9a227);
    for (const [ox, oy] of [[0, 0.17], [-0.16, -0.1], [0.16, -0.1]] as const) lit.box(at.x + ox, 2.3 + oy, at.y + 0.115, 0.2, 0.2, 0.02, 0x15140f);
    lit.box(at.x, 2.3, at.y + 0.125, 0.1, 0.1, 0.02, 0xc9a227);
  });

  const group = new Group();
  if (lit.triangles) group.add(new Mesh(lit.build(), solid));
  if (glow.triangles) group.add(new Mesh(glow.build(), new MeshBasicMaterial({ vertexColors: true })));
  return { group, lights };
}

/** Spores hanging in the air of a block that has fallen: pale motes drifting round you, there and nowhere else. */
export class Spores {
  readonly points: Points;
  private seeds: Float32Array;
  private amount = 0;
  private static readonly N = 90;

  constructor() {
    const n = Spores.N;
    this.seeds = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) this.seeds[i] = Math.random();
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    this.points = new Points(g, new PointsMaterial({ color: 0xb8d86a, size: 0.24, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  update(focus: Vector3, time: number, on: boolean, dt: number): void {
    this.amount += ((on ? 1 : 0) - this.amount) * (1 - Math.exp(-1.2 * dt));
    this.points.visible = this.amount > 0.02;
    if (!this.points.visible) return;
    (this.points.material as PointsMaterial).opacity = this.amount * 0.55;
    const a = this.points.geometry.getAttribute('position') as BufferAttribute, sd = this.seeds, W = 34, H = 7;
    const wrap = (v: number, c: number, w: number) => c + ((((v - c) % w) + w * 1.5) % w) - w / 2;
    for (let i = 0; i < Spores.N; i++) {
      const sx = sd[i * 3]!, sy = sd[i * 3 + 1]!, sz = sd[i * 3 + 2]!;
      a.setXYZ(i,
        wrap(sx * W + Math.sin(time * 0.31 + sy * 40) * 1.4 + time * 0.25, focus.x, W),
        0.4 + ((sy * H + time * (0.12 + sz * 0.18)) % H),
        wrap(sz * W + Math.cos(time * 0.27 + sx * 40) * 1.4, focus.z, W));
    }
    a.needsUpdate = true;
  }
}

/** Rings spreading over the ground from a noise: a scream, a cough, breaking glass. They show how far it carried. */
export class Waves {
  readonly mesh: InstancedMesh;
  private live: Array<{ x: number; z: number; to: number; t: number; dur: number; color: Color }> = [];
  private tmp = new Object3D();
  private col = new Color();

  constructor() {
    this.mesh = new InstancedMesh(
      new RingGeometry(0.93, 1, 40).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ transparent: true, blending: AdditiveBlending, depthWrite: false }), 6);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.setColorAt(0, this.col);
  }

  ring(x: number, z: number, to: number, color: number, dur = 0.7): void {
    if (this.live.length >= 6) this.live.shift();
    this.live.push({ x, z, to, t: 0, dur, color: new Color(color) });
  }

  update(dt: number): void {
    this.live = this.live.filter((w) => (w.t += dt) < w.dur);
    this.live.forEach((w, i) => {
      const k = w.t / w.dur, r = w.to * (1 - (1 - k) * (1 - k));
      this.tmp.position.set(w.x, 0.25, w.z);
      this.tmp.scale.set(r, 1, r);
      this.tmp.updateMatrix();
      this.mesh.setMatrixAt(i, this.tmp.matrix);
      this.mesh.setColorAt(i, this.col.copy(w.color).multiplyScalar((1 - k) * 0.9));
    });
    this.mesh.count = this.live.length;
    this.mesh.visible = this.live.length > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Tentacles: what grows out of a lasher where its head was. Every one in view is an instance of one
 * tapering tube, and the writhing is done on the graphics chip (each has its own phase), so a knot of
 * them costs one draw call and no per-frame geometry.
 */
export class Tentacles {
  readonly mesh: InstancedMesh;
  private phase: InstancedBufferAttribute;
  private time = { value: 0 };
  private n = 0;
  private tmp = new Object3D();

  constructor(private max = 48) {
    const RINGS = 10, SIDES = 5;
    const pos: number[] = [], nor: number[] = [], idx: number[] = [];
    for (let i = 0; i <= RINGS; i++) {
      const t = i / RINGS, r = 0.1 * (1 - t) ** 0.8 + 0.012;
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        pos.push(Math.cos(a) * r, t, Math.sin(a) * r);
        nor.push(Math.cos(a), 0.15, Math.sin(a));
      }
    }
    for (let i = 0; i < RINGS; i++) for (let k = 0; k < SIDES; k++) {
      const a = i * SIDES + k, b = i * SIDES + ((k + 1) % SIDES), c = a + SIDES, d = b + SIDES;
      idx.push(a, c, b, b, c, d);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(nor), 3));
    g.setIndex(idx);
    this.phase = new InstancedBufferAttribute(new Float32Array(max), 1);
    g.setAttribute('phase', this.phase);
    const mat = new MeshLambertMaterial({ color: 0x7a1c30, emissive: 0x200509 });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float phase;\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float tt = position.y, wa = uTime * 2.4 + phase;
transformed.x += (sin(tt * 5.0 + wa) * 0.2 + sin(tt * 11.0 - wa * 1.7) * 0.06) * tt;
transformed.z += cos(tt * 4.0 + wa * 0.8) * 0.2 * tt;`);
    };
    this.mesh = new InstancedMesh(g, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  begin(time: number): void {
    this.time.value = time;
    this.n = 0;
  }

  /** One of them: rooted at a point, leaning `tilt` from upright toward `heading` (game radians), `len` long. */
  add(x: number, y: number, z: number, heading: number, tilt: number, len: number, phase: number): void {
    if (this.n >= this.max) return;
    this.tmp.position.set(x, y, z);
    this.tmp.rotation.set(tilt, Math.PI / 2 - heading, 0, 'YXZ');
    this.tmp.scale.set(1, len, 1);
    this.tmp.updateMatrix();
    this.mesh.setMatrixAt(this.n, this.tmp.matrix);
    this.phase.setX(this.n++, phase);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.phase.needsUpdate = true;
  }
}
