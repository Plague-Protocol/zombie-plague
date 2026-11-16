// The infected, drawn as a crowd: every zombie and every body in two draw calls (one per skin).
//
// Their animations are baked once at load into a texture of bone matrices (one row per frame at
// BAKE_FPS), so the graphics chip poses each one by reading its row, and the CPU only works out
// which row each one is on. Individually animated characters (an animation mixer, a skeleton and a
// draw call each) cost far more per zombie; this is what lets the town be crowded on a phone.
// No blending between clips: at this distance a switch reads fine, and it halves the texture reads.
//
// Mutilation is done in the same shader, with no new models: each one carries a few bits (`mut`) saying
// what it has lost, and the vertices of that part are pulled in to the joint it was torn off at, which
// leaves a raw stump. So half a body dragging itself along, a missing arm and no head at all are the same
// mesh as everyone else.
import {
  AnimationMixer, BufferAttribute, Color, DataTexture, FloatType, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, type Material,
  MeshLambertMaterial, Quaternion, RGBAFormat, type SkinnedMesh, Vector3, Vector4,
} from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { CharacterAssets, ClipName } from './characters';

export type CrowdClip = 'ZIdle' | 'ZWalk' | 'Sprint' | 'ZAttack' | 'Hit' | 'Death' | 'ZRise';
const CLIPS: CrowdClip[] = ['ZIdle', 'ZWalk', 'Sprint', 'ZAttack', 'Hit', 'Death', 'ZRise'];
const BAKE_FPS = 30;
const TURN_RATE = 10; // rad/s, as the characters turn

/** What one of them has lost (add them up). */
export const MUT = { legs: 1, leftArm: 2, rightArm: 4, head: 8 } as const;
/** The parts that can go: which bones they are, and the joint each is torn off at. */
const PARTS = [
  { bones: /^(Left|Right)(UpLeg|Leg|Foot|Toes)/, joint: 'Hips' },
  { bones: /^Left(Arm|ForeArm|Hand)/, joint: 'LeftArm' },
  { bones: /^Right(Arm|ForeArm|Hand)/, joint: 'RightArm' },
  { bones: /^Head/, joint: 'Head' },
] as const;

interface Baked { start: number; rows: number }
interface Track { clip: CrowdClip; t0: number; rate: number; yaw: number; seen: number }

export class Crowd {
  readonly group = new Group();
  private meshes: InstancedMesh[] = [];
  private rows: InstancedBufferAttribute[] = [];
  private muts: InstancedBufferAttribute[] = [];
  private counts = [0, 0];
  private baked = new Map<CrowdClip, Baked>();
  private tracks = new Map<number, Track>();
  private time = 0;
  private frame = 0;
  private m = new Matrix4();
  private q = new Quaternion();
  private up = new Vector3(0, 1, 0);
  private s: Vector3;
  private sv = new Vector3();
  private tint = new Color();
  private at = new Vector3();

  constructor(assets: CharacterAssets, readonly max = 160) {
    this.s = new Vector3().setScalar(assets.scale);
    // bake: pose a copy of the character frame by frame and keep each bone's skinning matrix
    const root = clone(assets.template);
    let mesh: SkinnedMesh | null = null;
    root.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as SkinnedMesh; });
    const sm = mesh! as SkinnedMesh;
    const bones = sm.skeleton.bones.length;
    const mixer = new AnimationMixer(root);
    let total = 0;
    for (const c of CLIPS) { const clip = assets.clips.get(c as ClipName)!; const rows = Math.ceil(clip.duration * BAKE_FPS) + 1; this.baked.set(c, { start: total, rows }); total += rows; }
    const data = new Float32Array(bones * 4 * 4 * total);
    const k = new Matrix4();
    for (const c of CLIPS) {
      const clip = assets.clips.get(c as ClipName)!;
      const b = this.baked.get(c)!;
      mixer.stopAllAction();
      mixer.clipAction(clip).reset().play();
      for (let f = 0; f < b.rows; f++) {
        mixer.setTime(Math.min(f / BAKE_FPS, clip.duration - 1e-4));
        root.updateMatrixWorld(true);
        sm.skeleton.bones.forEach((bone, i) => {
          k.multiplyMatrices(bone.matrixWorld, sm.skeleton.boneInverses[i]!).multiply(sm.bindMatrix);
          data.set(k.elements, ((b.start + f) * bones + i) * 16);
        });
      }
    }
    const tex = new DataTexture(data, bones * 4, total, RGBAFormat, FloatType);
    tex.needsUpdate = true;

    // for every vertex, which part it belongs to (if any); for every part, its joint (bone, and where that is at rest)
    const names = sm.skeleton.bones.map((b) => b.name);
    const si = sm.geometry.getAttribute('skinIndex'), sw = sm.geometry.getAttribute('skinWeight');
    const part = new Float32Array(si.count * 4);
    for (let v = 0; v < si.count; v++) for (let c = 0; c < 4; c++) {
      const name = names[si.getComponent(v, c)] ?? '', w = sw.getComponent(v, c);
      PARTS.forEach((p, k) => { if (p.bones.test(name)) part[v * 4 + k]! += w; });
    }
    const unbind = sm.bindMatrix.clone().invert();
    const joints = PARTS.map((p) => {
      const i = Math.max(0, names.indexOf(p.joint));
      const at = new Vector3().setFromMatrixPosition(sm.skeleton.boneInverses[i]!.clone().invert()).applyMatrix4(unbind);
      return new Vector4(at.x, at.y, at.z, i);
    });

    for (const skin of ['zombieMaleA', 'zombieFemaleA'] as const) {
      const mat = new MeshLambertMaterial({ map: (assets.materials[skin] as MeshLambertMaterial).map });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.boneTex = { value: tex };
        shader.uniforms.joints = { value: joints };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute float animRow;
attribute vec4 part;
attribute float mut;
uniform vec4 joints[4];
varying float vStump;
uniform highp sampler2D boneTex;
mat4 crowdBone(float b) {
  ivec2 p = ivec2(int(b) * 4, int(animRow));
  return mat4(texelFetch(boneTex, p, 0), texelFetch(boneTex, p + ivec2(1, 0), 0), texelFetch(boneTex, p + ivec2(2, 0), 0), texelFetch(boneTex, p + ivec2(3, 0), 0));
}`)
          .replace('#include <beginnormal_vertex>', `mat4 skinM = skinWeight.x * crowdBone(skinIndex.x) + skinWeight.y * crowdBone(skinIndex.y)
  + skinWeight.z * crowdBone(skinIndex.z) + skinWeight.w * crowdBone(skinIndex.w);
vec3 objectNormal = normalize(mat3(skinM) * normal);`)
          .replace('#include <begin_vertex>', `vec3 transformed = (skinM * vec4(position, 1.0)).xyz;
vStump = 0.0;
float bits = mut;
for (int k = 3; k >= 0; k--) {
  float bit = exp2(float(k));
  if (bits >= bit) {
    bits -= bit;
    float w = part[k];
    if (w > 0.4) { transformed = (crowdBone(joints[k].w) * vec4(joints[k].xyz, 1.0)).xyz; vStump = 1.0; }
    else vStump = max(vStump, w * 2.0);
  }
}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vStump;')
          .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.015, 0.02), clamp(vStump, 0.0, 1.0));');
      };
      const geo = sm.geometry.clone();
      const row = new InstancedBufferAttribute(new Float32Array(max), 1);
      geo.setAttribute('animRow', row);
      geo.setAttribute('part', new BufferAttribute(part, 4));
      const mut = new InstancedBufferAttribute(new Float32Array(max), 1);
      geo.setAttribute('mut', mut);
      this.muts.push(mut);
      const im = new InstancedMesh(geo, mat as Material, max);
      im.frustumCulled = false; // spread over the street: the bounds of one would cull the rest
      im.setColorAt(0, this.tint.setHex(0xffffff)); // a colour each, so a kind can be told apart (pallid, or nearly black)
      im.count = 0;
      this.meshes.push(im);
      this.rows.push(row);
      this.group.add(im);
    }
  }

  /** Start a frame: nothing drawn yet. */
  begin(dt: number): void {
    this.time += dt;
    this.frame++;
    this.counts = [0, 0];
  }

  /**
   * One of them, this frame. `rate` scales the clip (foot-locked walking); `once` clips hold their
   * last frame; `restart` plays a once clip again from the top; `end` shows it already finished.
   */
  draw(id: number, x: number, z: number, heading: number, clip: CrowdClip, dt: number,
    o: { rate?: number; once?: boolean; restart?: boolean; end?: boolean; y?: number; tint?: number; bright?: number; wide?: number; tall?: number;
      /** What it has lost (MUT bits). */ mut?: number;
      /** Stand still at this point of the clip (0..1). */ hold?: number;
      /** Play back and forth between these two points of the clip (0..1): a crawl made from the start of getting up. */ pong?: readonly [number, number];
    } = {}): void {
    const skin = id % 2;
    const n = this.counts[skin]!;
    if (n >= this.max) return;
    const rate = o.rate ?? 1;
    const want = Math.PI / 2 - heading;
    let t = this.tracks.get(id);
    if (!t) { t = { clip, t0: o.end ? -1e6 : this.time, rate, yaw: want, seen: this.frame }; this.tracks.set(id, t); }
    else if (t.clip !== clip || o.restart) { t.clip = clip; t.t0 = o.end ? -1e6 : this.time; t.rate = rate; }
    else if (t.rate !== rate) { t.t0 = this.time - ((this.time - t.t0) * t.rate) / rate; t.rate = rate; } // same place in the cycle
    t.seen = this.frame;
    let d = want - t.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    t.yaw += Math.abs(d) <= TURN_RATE * dt ? d : Math.sign(d) * TURN_RATE * dt;

    const b = this.baked.get(clip)!;
    const f = Math.floor((this.time - t.t0) * t.rate * BAKE_FPS);
    let row = b.start + (o.once || o.end ? Math.min(f, b.rows - 1) : ((f % (b.rows - 1)) + (b.rows - 1)) % (b.rows - 1));
    if (o.pong) {
      const lo = Math.floor(o.pong[0] * (b.rows - 1)), len = Math.max(1, Math.floor(o.pong[1] * (b.rows - 1)) - lo);
      const ph = ((f % (len * 2)) + len * 2) % (len * 2);
      row = b.start + lo + (ph < len ? ph : len * 2 - ph);
    }
    if (o.hold !== undefined) row = b.start + Math.floor(o.hold * (b.rows - 1));
    this.rows[skin]!.setX(n, row);
    this.muts[skin]!.setX(n, o.mut ?? 0);
    this.q.setFromAxisAngle(this.up, t.yaw);
    this.m.compose(this.at.set(x, o.y ?? 0, z), this.q, this.sv.set(this.s.x * (o.wide ?? 1), this.s.y * (o.tall ?? 1), this.s.z * (o.wide ?? 1)));
    this.meshes[skin]!.setMatrixAt(n, this.m);
    this.meshes[skin]!.setColorAt(n, this.tint.setHex(o.tint ?? 0xffffff).multiplyScalar(o.bright ?? 1));
    this.counts[skin] = n + 1;
  }

  /** Finish the frame: upload what was drawn, forget the ones no longer in view. */
  end(): void {
    this.meshes.forEach((im, i) => {
      im.count = this.counts[i]!;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.rows[i]!.needsUpdate = true;
      this.muts[i]!.needsUpdate = true;
    });
    if (this.frame % 60 === 0) for (const [id, t] of this.tracks) if (this.frame - t.seen > 30) this.tracks.delete(id);
  }

  /** How many were drawn this frame. */
  get drawn(): number { return this.counts[0]! + this.counts[1]!; }

  /** Forget everyone (a new district). */
  reset(): void { this.tracks.clear(); }
}

