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
  AnimationMixer, BufferAttribute, Color, DataTexture, EqualStencilFunc, FloatType, GreaterDepth, Group, InstancedBufferAttribute, InstancedMesh, KeepStencilOp,
  Matrix4, type Material, MeshBasicMaterial, MeshLambertMaterial, Quaternion, RGBAFormat, type SkinnedMesh, Vector3, Vector4,
} from 'three';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HEIGHT, type CharacterAssets, type ClipName } from './characters';

export type CrowdClip = 'ZIdle' | 'ZWalk' | 'Sprint' | 'ZAttack' | 'Hit' | 'Death' | 'ZRise';
const CLIPS: CrowdClip[] = ['ZIdle', 'ZWalk', 'Sprint', 'ZAttack', 'Hit', 'Death', 'ZRise'];
const BAKE_FPS = 30;
const TURN_RATE = 10; // rad/s, as the characters turn

/** What one of them has lost (add them up). */
export const MUT = { legs: 1, leftArm: 2, rightArm: 4, head: 8, face: 16 } as const;
/** The parts that can go: which bones they are, and the joint each is torn off at. */
const PARTS = [
  { bones: /^(Left|Right)(UpLeg|Leg|Foot|Toes)/, joint: 'Hips' },
  { bones: /^Left(Arm|ForeArm|Hand)/, joint: 'LeftArm' },
  { bones: /^Right(Arm|ForeArm|Hand)/, joint: 'RightArm' },
  { bones: /^Head/, joint: 'Head' },
] as const;

/** The parts things are fixed to (bones of the character). */
const ANCHORS = ['Head', 'UpperChest', 'RightArm'] as const;
export type Anchor = typeof ANCHORS[number];

interface Baked { start: number; rows: number }
interface Track { clip: CrowdClip; t0: number; rate: number; yaw: number; seen: number }

// What makes them not people: the skin drained to a grey-green, patches of black rot and of old blood that sit on the
// body (noise over its rest pose, in world units) and differ from one to the next, darker hands and mouth-level smears.
const ROT_NOISE = `
float rotHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float rotNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rotHash(i), rotHash(i + vec3(1,0,0)), f.x), mix(rotHash(i + vec3(0,1,0)), rotHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rotHash(i + vec3(0,0,1)), rotHash(i + vec3(1,0,1)), f.x), mix(rotHash(i + vec3(0,1,1)), rotHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;
const ROT_COLOUR = `
{
  float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  float pale = smoothstep(0.45, 0.8, lum); // the brightest of the skin is skin: make it a corpse's
  vec3 dead = mix(vec3(lum) * vec3(0.62, 0.66, 0.6) * 0.7, vec3(0.62, 0.68, 0.66) * lum * 1.05, pale);
  vec3 q = vRot * 2.4;
  float n = rotNoise(q) * 0.65 + rotNoise(q * 2.7) * 0.35;
  dead = mix(dead, vec3(0.06, 0.055, 0.04), smoothstep(0.55, 0.78, n) * 0.9);
  float h = vRot.z / 2.8; // up the body at rest
  float bib = smoothstep(0.32, 0.48, h) * (1.0 - smoothstep(0.62, 0.7, h)); // from the mouth down the chest
  float b = rotNoise(q * 1.6 + 11.0) + bib * 0.35;
  dead = mix(dead, vec3(0.3, 0.015, 0.02), smoothstep(0.62, 0.84, b) * 0.95);
  dead *= 0.8 + 0.35 * rotNoise(q * 6.0);
  diffuseColor.rgb = dead;
}`;

export class Crowd {
  readonly group = new Group();
  private meshes: InstancedMesh[] = [];
  private rows: InstancedBufferAttribute[] = [];
  private muts: InstancedBufferAttribute[] = [];
  /** Per instance: 1 if it is close enough to the player to show through a building (see `xrays`). */
  private nears: InstancedBufferAttribute[] = [];
  /**
   * Their red silhouettes through buildings: the same instances again, drawn only where a building is in front
   * (the stencil the city writes, as for the player's own blue one) and only for the ones close to the player.
   * Something about to bite you behind a wall is shown; the street beyond it is not.
   */
  private xrays: InstancedMesh[] = [];
  private counts = [0, 0];
  private baked = new Map<CrowdClip, Baked>();
  private tracks = new Map<number, Track>();
  private time = 0;
  private frame = 0;
  private m = new Matrix4();
  private q = new Quaternion();
  private lean = new Quaternion();
  private side = new Vector3(1, 0, 0);
  private up = new Vector3(0, 1, 0);
  private s: Vector3;
  private sv = new Vector3();
  private tint = new Color();
  private at = new Vector3();
  /** Where the stump of the neck, the upper back and the right shoulder are, every baked frame (3 floats each). */
  private anchors: Float32Array;
  /** The last one drawn: its frame, and how it was placed. */
  private last = { row: 0, m: new Matrix4(), yaw: 0 };

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
    this.anchors = new Float32Array(total * ANCHORS.length * 3);
    const anchorBones = ANCHORS.map((n) => sm.skeleton.bones.find((b) => b.name === n)!);
    const k = new Matrix4(), w = new Vector3();
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
        anchorBones.forEach((bone, i) => { if (bone) this.anchors.set(bone.getWorldPosition(w).toArray(), ((b.start + f) * ANCHORS.length + i) * 3); });
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

    /**
     * Pose each instance on the graphics chip from the baked bone texture, and pull lost parts in to their stump.
     * The silhouette (`xray`) draws the same pose, flat and only for instances flagged near: the rest are put
     * outside the screen before a single pixel of them is drawn.
     */
    // the rot's noise runs in world units over the body at rest: the mesh's own units, scaled to a character's height
    sm.geometry.computeBoundingBox();
    const rest = sm.geometry.boundingBox!.getSize(new Vector3());
    const rotScale = HEIGHT / Math.max(rest.x, rest.y, rest.z, 1e-6);
    const patch = (m: MeshLambertMaterial | MeshBasicMaterial, xray: boolean) => {
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n#define ROT_SCALE ${rotScale.toFixed(6)}`);
        shader.uniforms.boneTex = { value: tex };
        shader.uniforms.joints = { value: joints };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute float animRow;
attribute vec4 part;
attribute float mut;
attribute float near;
uniform vec4 joints[4];
varying float vStump;
varying vec3 vRot;
uniform highp sampler2D boneTex;
mat4 crowdBone(float b) {
  ivec2 p = ivec2(int(b) * 4, int(animRow));
  return mat4(texelFetch(boneTex, p, 0), texelFetch(boneTex, p + ivec2(1, 0), 0), texelFetch(boneTex, p + ivec2(2, 0), 0), texelFetch(boneTex, p + ivec2(3, 0), 0));
}
mat4 crowdSkin() {
  return skinWeight.x * crowdBone(skinIndex.x) + skinWeight.y * crowdBone(skinIndex.y) + skinWeight.z * crowdBone(skinIndex.z) + skinWeight.w * crowdBone(skinIndex.w);
}`)
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = normalize(mat3(crowdSkin()) * normal);')
          .replace('#include <begin_vertex>', `vRot = position * ROT_SCALE + vec3(float(gl_InstanceID) * 3.7, 0.0, float(gl_InstanceID) * 1.3); // the body at rest (so the rot stays put on it as it moves), shifted so no two rot alike
vStump = 0.0;
float bits = mut;
vec3 restPos = position;
if (bits >= 16.0) {
  // half the face gone: the right side of the head, from the front, caved in to the skull and raw. In the mesh's own
  // units at rest (z up, x across the shoulders, +y forward): the head runs z 2.6 to 3.77 about x = y = 0.
  bits -= 16.0;
  if (part[3] > 0.4 && position.x < 0.03 && position.y > -0.1 && position.z > 2.85) {
    restPos.x = mix(position.x, 0.05, 0.7);
    restPos.y = mix(position.y, -0.15, 0.45);
    vStump = 0.85;
  }
}
vec3 transformed = (crowdSkin() * vec4(restPos, 1.0)).xyz;
for (int k = 3; k >= 0; k--) {
  float bit = exp2(float(k));
  if (bits >= bit) {
    bits -= bit;
    float w = part[k];
    if (w > 0.4) { transformed = (crowdBone(joints[k].w) * vec4(joints[k].xyz, 1.0)).xyz; vStump = 1.0; }
    else vStump = max(vStump, w * 2.0);
  }
}`)
          .replace('#include <project_vertex>', xray ? '#include <project_vertex>\nif (near < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);' : '#include <project_vertex>');
        if (!xray) {
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>\nvarying float vStump;\nvarying vec3 vRot;\n${ROT_NOISE}`)
            .replace('#include <color_fragment>', `#include <color_fragment>\n${ROT_COLOUR}\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.015, 0.02), clamp(vStump, 0.0, 1.0));`);
        }
      };
    };
    // one silhouette material for both skins: dull blood red, only where the city drew a building (stencil 1), behind it
    const xrayMat = new MeshBasicMaterial({
      color: 0xb3261e, depthFunc: GreaterDepth, depthWrite: false, transparent: true, opacity: 0.42,
      stencilWrite: true, stencilRef: 1, stencilFunc: EqualStencilFunc, stencilFail: KeepStencilOp, stencilZFail: KeepStencilOp, stencilZPass: KeepStencilOp,
    });
    patch(xrayMat, true);

    for (const skin of ['zombieMaleA', 'zombieFemaleA'] as const) {
      const mat = new MeshLambertMaterial({ map: (assets.materials[skin] as MeshLambertMaterial).map });
      patch(mat, false);
      const geo = sm.geometry.clone();
      const row = new InstancedBufferAttribute(new Float32Array(max), 1);
      geo.setAttribute('animRow', row);
      geo.setAttribute('part', new BufferAttribute(part, 4));
      const mut = new InstancedBufferAttribute(new Float32Array(max), 1);
      geo.setAttribute('mut', mut);
      const near = new InstancedBufferAttribute(new Float32Array(max), 1);
      geo.setAttribute('near', near);
      this.muts.push(mut);
      this.nears.push(near);
      const im = new InstancedMesh(geo, mat as Material, max);
      im.frustumCulled = false; // spread over the street: the bounds of one would cull the rest
      im.setColorAt(0, this.tint.setHex(0xffffff)); // a colour each, so a kind can be told apart (pallid, or nearly black)
      im.count = 0;
      this.meshes.push(im);
      this.rows.push(row);
      this.group.add(im);
      // the same instances (same geometry and matrices, so no extra upload), drawn as a silhouette after the city
      const x = new InstancedMesh(geo, xrayMat as Material, max);
      x.instanceMatrix = im.instanceMatrix;
      x.frustumCulled = false;
      x.renderOrder = 2;
      x.count = 0;
      this.xrays.push(x);
      this.group.add(x);
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
      /** Lean forward by this much (radians): the hunch of something that is not a person any more. */ hunch?: number;
      /** What it has lost (MUT bits). */ mut?: number;
      /** Stand still at this point of the clip (0..1). */ hold?: number;
      /** Play back and forth between these two points of the clip (0..1): a crawl made from the start of getting up. */ pong?: readonly [number, number];
      /** Close enough to the player to show through a building. */ near?: boolean;
    } = {}): boolean {
    const skin = id % 2;
    const n = this.counts[skin]!;
    if (n >= this.max) return false;
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
    this.nears[skin]!.setX(n, o.near ? 1 : 0);
    this.q.setFromAxisAngle(this.up, t.yaw);
    if (o.hunch) this.q.multiply(this.lean.setFromAxisAngle(this.side, o.hunch)); // pitched forward over its feet
    const gaunt = o.hunch ? 0.92 : 1;
    this.m.compose(this.at.set(x, o.y ?? 0, z), this.q, this.sv.set(this.s.x * (o.wide ?? 1) * gaunt, this.s.y * (o.tall ?? 1) / gaunt, this.s.z * (o.wide ?? 1) * gaunt));
    this.meshes[skin]!.setMatrixAt(n, this.m);
    this.meshes[skin]!.setColorAt(n, this.tint.setHex(o.tint ?? 0xffffff).multiplyScalar(o.bright ?? 1));
    this.counts[skin] = n + 1;
    this.last.row = row; this.last.m.copy(this.m); this.last.yaw = t.yaw;
    return true;
  }

  /**
   * Where a part of the last one drawn is in the world this frame: the stump of its neck, its upper back, or its right
   * shoulder, as its body is posed, turned, leaning and stretched. What grows out of it stays on it.
   */
  on(part: Anchor, out = new Vector3()): Vector3 {
    const i = (this.last.row * ANCHORS.length + ANCHORS.indexOf(part)) * 3;
    return out.fromArray(this.anchors, i).applyMatrix4(this.last.m);
  }

  /** Which way the last one drawn faces, in the game's radians (it turns smoothly, so not quite where it is headed). */
  get lastHeading(): number { return Math.PI / 2 - this.last.yaw; }

  /** Finish the frame: upload what was drawn, forget the ones no longer in view. */
  end(): void {
    this.meshes.forEach((im, i) => {
      im.count = this.counts[i]!;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.rows[i]!.needsUpdate = true;
      this.muts[i]!.needsUpdate = true;
      this.nears[i]!.needsUpdate = true;
      this.xrays[i]!.count = this.counts[i]!;
    });
    if (this.frame % 60 === 0) for (const [id, t] of this.tracks) if (this.frame - t.seen > 30) this.tracks.delete(id);
  }

  /** How many were drawn this frame. */
  get drawn(): number { return this.counts[0]! + this.counts[1]!; }

  /** Forget everyone (a new district). */
  reset(): void { this.tracks.clear(); }
}

