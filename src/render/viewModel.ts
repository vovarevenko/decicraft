/**
 * First-person hand + held item (cm-voxel models), rendered in an overlay pass with its own camera
 * after the world (depth cleared), lit to match the current sun/ambient. OWNER: agent "env-fx".
 *
 * The overlay scene is camera space: its camera sits at the origin looking down -Z and the hand and
 * item are placed in front of it. Every update mirrors the world's lights into that frame (sun/moon
 * direction, hemisphere up axis, pooled point lights relative to the eye; castShadow false). The
 * overlay has no shadow map, so the sun's share is scaled by a short voxel ray towards it and the
 * hemisphere by the skylight of the eye's column: the hand darkens in shade and indoors.
 *
 * Placement: the item sits at its hold pose (render/models getItemHoldPose: camera-space position of
 * the model origin = grip, Euler rotation, scale) and the hand closes around that grip (HAND_GRIP from
 * the wrist); with nothing held the wrist rests at EMPTY_WRIST. Swings rotate everything about a
 * shoulder pivot and flick the item about the grip. Models are built lazily and cached per item; a
 * getter that throws is reported once (console.warn) and the view model shows the bare hand (or no
 * hand when its own model is unavailable).
 */
import * as THREE from 'three';
import { PLAYER, RENDER, WORLD_Y } from '../config';
import { TAU, angleDelta, clamp, damp, lerp } from '../core/math';
import type { GameContext } from '../game/context';
import { HAND, ITEMS } from '../game/items';
import { FOLIAGE, OPAQUE, RENDER_KIND, RK } from '../world/blocks';
import type { WorldData } from '../world/world';
import { getHandGeometry, getItemGeometry, getItemHoldPose } from './models';
import { getModelMaterial } from './voxelModel';

export type SwingKind = 'swing' | 'chop' | 'dig' | 'use' | 'place' | 'eat';

/** Overlay camera: a narrower fov than the world's keeps the hand from stretching at the screen edge. */
const VM_FOV = 65;
const VM_NEAR = 0.05;
const VM_FAR = 100;

/** Wrist (camera space, world units) with nothing in hand: lower right, the sleeve leaving the bottom edge. */
const EMPTY_WRIST = new THREE.Vector3(2.0, -2.1, -4.2);
/** Forearm orientation: turned slightly inwards and up. */
const HAND_QUATERNION = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0.25, 0.05, 'YXZ'));
/** Where the closed hand holds things, relative to the wrist (hand model space). */
const HAND_GRIP = new THREE.Vector3(0, 0.15, -0.85);
const EMPTY_GRIP = HAND_GRIP.clone().applyQuaternion(HAND_QUATERNION).add(EMPTY_WRIST);
/** Swing pivot ("shoulder"), camera space. */
const SHOULDER = new THREE.Vector3(2.2, -4.6, 0.8);

/** Walk bob: one footstep per this distance (0.55 m), amplitudes at walking speed (world units / rad). */
const STEP_LENGTH = 5.5;
const BOB_X = 0.14;
const BOB_Y = 0.16;
const BOB_ROLL = 0.025;
const MAX_BOB = 1.6;
const BOB_RATE = 8;
/** Idle breathing sway. */
const IDLE_X = 0.025;
const IDLE_Y = 0.04;
const IDLE_ROLL = 0.01;
/** Look lag: radians of lag per rad/s of turning, its limit and smoothing rate. */
const LOOK_LAG = 0.03;
const MAX_LAG = 0.1;
const LOOK_RATE = 10;
/** Jump/fall lag: units of offset per unit/s of vertical speed. */
const AIR_LAG = 0.008;
const MAX_AIR = 0.4;
const AIR_RATE = 8;
/** Sprinting lowers and tips the hand. */
const SPRINT_DROP = 0.35;
const SPRINT_TILT = 0.12;
const SPRINT_RATE = 6;
/** Swing poses are followed at this rate (smooths restarts). */
const ANIM_FOLLOW = 30;
/** Raising the new item after a switch. */
const EQUIP_TIME = 0.25;
const EQUIP_DROP = 2.6;
const EQUIP_TILT = 0.4;

/** Mirrored sun distance from the origin (direction only matters). */
const SUN_DISTANCE = 10;
/** Voxel steps of the ray towards the sun/moon and the light kept per foliage / glass voxel crossed. */
const SUN_PROBE_STEPS = 160;
const LEAF_TRANSMISSION = 0.8;
const GLASS_TRANSMISSION = 0.85;
/** Adaptation rate of the shade estimates (1/s). */
const SHADE_RATE = 5;
/** Columns around the eye averaged for the skylight term. */
const SKY_PROBE_X = [0, 2, -2, 0, 0] as const;
const SKY_PROBE_Z = [0, 0, 0, 2, -2] as const;
/** Mirrored point lights stay at least this far from the wrist (a torch in the fist would blow the hand out). */
const MIN_LIGHT_DISTANCE = 12;

/** Glows (additive sprites, sizes in world units, linear colours). */
const TORCH_TIP_INSET = 0.3;
const TORCH_GLOW_SIZE = 2.6;
const TORCH_CORE_SIZE = 1.0;
const TORCH_GLOW = new THREE.Color(1.0, 0.45, 0.12);
const TORCH_CORE = new THREE.Color(1.0, 0.78, 0.4);
const FLASH_GLOW_SIZE = 0.7;
const FLASH_GLOW = new THREE.Color(1.0, 0.95, 0.85);

type Vec3Tuple = readonly [number, number, number];

/** One key of a one-shot clip: time (0..1), arm offset, arm rotation about the shoulder, item flick about the grip. */
interface Key {
  t: number;
  pos: Vec3Tuple;
  arm: Vec3Tuple;
  wrist: Vec3Tuple;
}

interface Clip {
  keys: readonly Key[];
  /** Seconds (tool swings are shortened to fit the tool's swing time). */
  duration: number;
  /** Repeats with the tool's swing time. */
  repeats: boolean;
}

const REST: Vec3Tuple = [0, 0, 0];
const key = (t: number, pos: Vec3Tuple = REST, arm: Vec3Tuple = REST, wrist: Vec3Tuple = REST): Key => ({ t, pos, arm, wrist });

const EAT_ARM: Vec3Tuple = [0.1, 0.25, 0];
const EAT_WRIST: Vec3Tuple = [0.6, 0.2, 0];

/** Clip per swing kind; 'swing' with an empty hand is a punch. */
const CLIPS: Readonly<Record<SwingKind | 'punch', Clip>> = {
  punch: {
    keys: [key(0), key(0.12, [0.1, -0.1, 0.4], REST, [0.1, 0, 0]), key(0.38, [-0.9, 0.55, -2.4], [0.05, 0.12, 0], [-0.1, 0.15, 0]), key(1)],
    duration: 0.27,
    repeats: true,
  },
  swing: {
    keys: [
      key(0),
      key(0.3, [0.1, 0.5, 0.3], [0.45, 0, -0.1], [0.4, 0, 0]),
      key(0.52, [-0.3, -0.4, -1.0], [-0.42, 0.12, 0.1], [-0.6, 0, 0]),
      key(0.68, [-0.25, -0.35, -0.8], [-0.36, 0.1, 0.08], [-0.5, 0, 0]),
      key(1),
    ],
    duration: 0.55,
    repeats: true,
  },
  chop: {
    keys: [
      key(0),
      key(0.32, [0.4, 0.7, 0.4], [0.55, -0.1, -0.35], [0.55, 0, 0]),
      key(0.52, [-0.5, -0.5, -1.0], [-0.5, 0.18, 0.25], [-0.7, 0, 0]),
      key(0.66, [-0.45, -0.45, -0.9], [-0.44, 0.16, 0.22], [-0.6, 0, 0]),
      key(1),
    ],
    duration: 0.55,
    repeats: true,
  },
  dig: {
    keys: [
      key(0),
      key(0.15, [0, 0.3, 0.4], [0.15, 0, 0], [0.15, 0, 0]),
      key(0.42, [-0.3, -0.9, -1.8], [-0.3, 0.05, 0], [-0.3, 0, 0]),
      key(0.7, [-0.2, -0.2, -1.2], [-0.1, 0.05, 0], [0.45, 0, 0]),
      key(1),
    ],
    duration: 0.5,
    repeats: true,
  },
  use: {
    keys: [key(0), key(0.35, [-0.35, 0.35, -0.5], [0.08, 0.06, 0], [0.2, 0, 0]), key(1)],
    duration: 0.3,
    repeats: false,
  },
  place: {
    keys: [key(0), key(0.35, [-0.25, 0.15, -1.1], [0.05, 0.04, 0], [-0.1, 0, 0]), key(1)],
    duration: 0.2,
    repeats: false,
  },
  eat: {
    keys: [
      key(0),
      key(0.28, [-0.9, 1.2, 1.9], EAT_ARM, EAT_WRIST),
      key(0.4, [-0.9, 1.08, 1.9], EAT_ARM, EAT_WRIST),
      key(0.52, [-0.9, 1.22, 1.9], EAT_ARM, EAT_WRIST),
      key(0.64, [-0.9, 1.08, 1.9], EAT_ARM, EAT_WRIST),
      key(0.76, [-0.9, 1.2, 1.9], EAT_ARM, EAT_WRIST),
      key(1),
    ],
    duration: 0.9,
    repeats: false,
  },
};

/** Writes the clip pose at `t` (0..1) into out[0..8]: offset, arm rotation, wrist rotation (smoothstep between keys). */
function sampleClip(keys: readonly Key[], t: number, out: Float32Array): void {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = clamp((t - a.t) / (b.t - a.t), 0, 1);
  const w = u * u * (3 - 2 * u);
  for (let c = 0; c < 3; c++) {
    out[c] = lerp(a.pos[c], b.pos[c], w);
    out[3 + c] = lerp(a.arm[c], b.arm[c], w);
    out[6 + c] = lerp(a.wrist[c], b.wrist[c], w);
  }
}

/** Fraction of light reaching `from` along unit `dir` through the voxels: opaque blocks it, foliage and glass dim it. */
function lightTransmission(world: WorldData, from: THREE.Vector3, dir: THREE.Vector3): number {
  let t = 1;
  let x = from.x;
  let y = from.y;
  let z = from.z;
  for (let i = 0; i < SUN_PROBE_STEPS; i++) {
    x += dir.x;
    y += dir.y;
    z += dir.z;
    if (y >= WORLD_Y) break;
    const id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    if (id === 0) continue;
    if (FOLIAGE[id] === 1) t *= LEAF_TRANSMISSION;
    else if (OPAQUE[id] === 1) return 0;
    else if (RENDER_KIND[id] === RK.GLASS) t *= GLASS_TRANSMISSION;
    if (t < 0.02) return 0;
  }
  return t;
}

/** The mesher's skylight term (roof · leaf, ARCHITECTURE §6.1) averaged over the eye column and its neighbours. */
function skylightAt(world: WorldData, eye: THREE.Vector3): number {
  const y = Math.floor(eye.y);
  const ex = Math.floor(eye.x);
  const ez = Math.floor(eye.z);
  let sum = 0;
  for (let k = 0; k < SKY_PROBE_X.length; k++) {
    const x = ex + SKY_PROBE_X[k];
    const z = ez + SKY_PROBE_Z[k];
    const sky = world.skyHeight(x, z);
    const roof = y >= sky ? 1 : Math.max(0.25, 1 - (sky - y) / 48);
    const leaf = y >= world.canopyHeight(x, z) ? 1 : 0.6;
    sum += roof * leaf;
  }
  return sum / SKY_PROBE_X.length;
}

/** Smooth pseudo-random flicker in about [-1, 1]. */
function flicker(t: number, phase: number): number {
  return 0.5 * Math.sin(t * 13.1 + phase) + 0.3 * Math.sin(t * 21.7 + phase * 1.9) + 0.2 * Math.sin(t * 7.3 + phase * 3.1);
}

/** Soft radial glow (white, falloff in alpha) for the additive sprites. */
function createGlowTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1);
      const f = Math.max(0, 1 - d);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(f * f * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'view-model-glow';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createGlowSprite(texture: THREE.Texture): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    name: 'view-model-glow',
    map: texture,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 1;
  sprite.visible = false;
  return sprite;
}

/** A held item, built once per item id. */
interface HeldItem {
  /** The model at its hold pose (static matrix, camera space). */
  readonly mesh: THREE.Mesh;
  /** Hold-pose position of the model origin (the grip): the hand closes around it. */
  readonly grip: THREE.Vector3;
  /** Glow anchor (top of the model, model space). */
  readonly tip: THREE.Vector3;
  readonly glow: 'torch' | 'flashlight' | null;
}

export class ViewModel {
  /** Overlay scene (camera space) and its camera at the origin. */
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(VM_FOV, 1, VM_NEAR, VM_FAR);

  /** Transform chain: sway (about the eye) → arm (about the shoulder) → grip pivot (item flick) → held models. */
  private readonly sway = new THREE.Group();
  private readonly arm = new THREE.Group();
  private readonly gripPivot = new THREE.Group();
  private readonly held = new THREE.Group();

  private readonly sun = new THREE.DirectionalLight(0xffffff, 0);
  private readonly hemisphere = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);
  private readonly points: THREE.PointLight[] = [];
  private readonly glowOuter: THREE.Sprite;
  private readonly glowCore: THREE.Sprite;

  private material: THREE.Material | null = null;
  private materialFailed = false;
  private hand: THREE.Mesh | null = null;
  private handTried = false;
  private readonly items = new Map<string, HeldItem | null>();
  private itemId: string | null = null;
  private current: HeldItem | null = null;
  /** Wrist position of the current hold (camera space, at rest). */
  private readonly wristRest = new THREE.Vector3();

  private clip: Clip | null = null;
  private clipTime = 0;
  private clipDuration = 1;
  private readonly target = new Float32Array(9);
  private readonly pose = new Float32Array(9);
  private equip = 1;
  private time = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private airOffset = 0;
  private sprint = 0;
  private lagYaw = 0;
  private lagPitch = 0;
  private prevYaw: number | null = null;
  private prevPitch = 0;
  private sunShade = 1;
  private skyShade = 1;

  private readonly toView = new THREE.Quaternion();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();

  constructor() {
    this.camera.name = 'view-model-camera';
    this.sun.name = 'view-model-sun';
    this.sun.castShadow = false;
    this.hemisphere.name = 'view-model-sky';
    this.scene.add(this.sun, this.sun.target, this.hemisphere);
    for (let i = 0; i < RENDER.maxPointLights; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.name = `view-model-light-${i}`;
      light.castShadow = false;
      this.scene.add(light);
      this.points.push(light);
    }

    this.arm.position.copy(SHOULDER);
    const armContent = new THREE.Group();
    armContent.position.copy(SHOULDER).negate();
    this.scene.add(this.sway);
    this.sway.add(this.arm);
    this.arm.add(armContent);
    armContent.add(this.gripPivot);
    this.gripPivot.add(this.held);

    const glow = createGlowTexture();
    this.glowOuter = createGlowSprite(glow);
    this.glowCore = createGlowSprite(glow);
    this.held.add(this.glowOuter, this.glowCore);
    this.placeHand();
  }

  /** Item in hand (null = empty hand). Cheap to call every frame with the same id. */
  setItem(itemId: string | null): void {
    if (itemId === this.itemId) return;
    this.itemId = itemId;
    this.ensureHand();
    if (this.current !== null) this.current.mesh.visible = false;
    this.current = itemId === null ? null : this.heldItem(itemId);
    if (this.current !== null) this.current.mesh.visible = true;
    this.placeHand();
    this.clip = null;
    this.equip = 0;
  }

  /** Plays a one-shot animation (restarts if already playing). */
  swing(kind: SwingKind = 'swing'): void {
    const clip = CLIPS[kind === 'swing' && this.current === null ? 'punch' : kind];
    const swingTime = (this.itemId === null ? undefined : ITEMS[this.itemId]?.tool?.swingTime) ?? HAND.swingTime;
    this.clip = clip;
    this.clipTime = 0;
    // A repeating swing must end before the next one starts.
    this.clipDuration = clip.repeats ? Math.min(clip.duration, swingTime * 0.95) : clip.duration;
  }

  /** Bobbing/sway from ctx.player movement and look, lighting from the environment. */
  update(dt: number, ctx: GameContext): void {
    this.ensureHand();
    this.updateLights(dt, ctx);
    this.animate(dt, ctx);
    this.updateGlows(ctx);
  }

  /** Draws the overlay; called by GameRenderer.render after the world pass. */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.PerspectiveCamera): void {
    if (this.hand === null && this.current === null) return;
    if (this.camera.aspect !== mainCamera.aspect) {
      this.camera.aspect = mainCamera.aspect;
      this.camera.updateProjectionMatrix();
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }

  /**
   * Compiles the overlay's programs (the model material under the overlay's lights, the glow sprites)
   * with renderer.compileAsync. A stand-in mesh carries the shared model material, so this works
   * before (or without) the hand and item models.
   */
  async compile(renderer: THREE.WebGLRenderer): Promise<void> {
    const material = this.modelMaterial();
    const proxy = material === null ? null : new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), material);
    if (proxy !== null) {
      proxy.visible = false;
      this.held.add(proxy);
    }
    try {
      await renderer.compileAsync(this.scene, this.camera);
    } finally {
      if (proxy !== null) {
        this.held.remove(proxy);
        proxy.geometry.dispose();
      }
    }
  }

  // ---------------------------------------------------------------- models

  /** The shared model material, or null (warned once) if it cannot be created. */
  private modelMaterial(): THREE.Material | null {
    if (this.material === null && !this.materialFailed) {
      try {
        this.material = getModelMaterial();
      } catch (e) {
        this.materialFailed = true;
        console.warn('[viewModel] model material unavailable, the view model stays empty:', e);
      }
    }
    return this.material;
  }

  /** Builds the hand once; without it the item (if any) is drawn alone. */
  private ensureHand(): void {
    if (this.handTried) return;
    this.handTried = true;
    const material = this.modelMaterial();
    if (material === null) return;
    try {
      const hand = new THREE.Mesh(getHandGeometry(), material);
      hand.name = 'hand';
      hand.quaternion.copy(HAND_QUATERNION);
      hand.position.copy(this.wristRest);
      this.held.add(hand);
      this.hand = hand;
    } catch (e) {
      console.warn('[viewModel] hand model unavailable, drawing no hand:', e);
    }
  }

  /** The cached held item for `id`, building it on first use; null (warned once) if its model fails. */
  private heldItem(id: string): HeldItem | null {
    const cached = this.items.get(id);
    if (cached !== undefined) return cached;
    const material = this.modelMaterial();
    let item: HeldItem | null = null;
    if (material !== null) {
      try {
        item = this.buildItem(id, material);
      } catch (e) {
        console.warn(`[viewModel] no model for '${id}', showing the bare hand:`, e);
      }
    }
    this.items.set(id, item);
    return item;
  }

  private buildItem(id: string, material: THREE.Material): HeldItem {
    const geometry = getItemGeometry(id);
    const pose = getItemHoldPose(id);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `held-${id}`;
    mesh.position.fromArray(pose.position);
    mesh.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
    mesh.scale.setScalar(pose.scale);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;
    const glow = ITEMS[id]?.light?.kind ?? null;
    const tip = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      box.max.y - (glow === 'torch' ? TORCH_TIP_INSET : 0),
      (box.min.z + box.max.z) / 2,
    );
    this.held.add(mesh);
    return {
      mesh,
      grip: new THREE.Vector3().fromArray(pose.grip ?? pose.position),
      tip,
      glow,
    };
  }

  /** Closes the hand around the current grip (or rests it empty) and moves the item pivot there. */
  private placeHand(): void {
    const grip = this.current?.grip ?? EMPTY_GRIP;
    this.wristRest.copy(HAND_GRIP).applyQuaternion(HAND_QUATERNION).negate().add(grip);
    this.hand?.position.copy(this.wristRest);
    this.gripPivot.position.copy(grip);
    this.held.position.copy(grip).negate();
  }

  // ---------------------------------------------------------------- per frame

  /** Mirrors the world's lights into camera space, shaded by what is between the eye and the sky. */
  private updateLights(dt: number, ctx: GameContext): void {
    const r = ctx.renderer;
    const camera = ctx.camera;
    const eye = camera.position;
    const toView = this.toView.copy(camera.quaternion).invert();
    const env = r.environment;

    this.sun.position.copy(env.lightDir).applyQuaternion(toView).multiplyScalar(SUN_DISTANCE);
    if (env.lightIntensity > 0) {
      this.sunShade += (lightTransmission(ctx.world, eye, env.lightDir) - this.sunShade) * damp(SHADE_RATE, dt);
    }
    this.sun.color.copy(r.sun.color);
    this.sun.intensity = r.sun.intensity * this.sunShade;

    this.skyShade += (skylightAt(ctx.world, eye) - this.skyShade) * damp(SHADE_RATE, dt);
    this.hemisphere.color.copy(r.hemisphere.color);
    this.hemisphere.groundColor.copy(r.hemisphere.groundColor);
    this.hemisphere.intensity = r.hemisphere.intensity * this.skyShade;
    this.hemisphere.position.set(0, 1, 0).applyQuaternion(toView);

    const sources = r.pointLights;
    for (let i = 0; i < this.points.length; i++) {
      const dst = this.points[i];
      const src = sources[i];
      if (src === undefined || src.intensity <= 0) {
        dst.intensity = 0;
        continue;
      }
      const p = this.v1.copy(src.position).sub(eye).applyQuaternion(toView);
      const away = this.v2.copy(p).sub(this.wristRest);
      const d = away.length();
      if (d < MIN_LIGHT_DISTANCE) {
        if (d < 1e-3) away.set(0, 1, 0);
        else away.multiplyScalar(1 / d);
        p.copy(this.wristRest).addScaledVector(away, MIN_LIGHT_DISTANCE);
      }
      dst.position.copy(p);
      dst.color.copy(src.color);
      dst.distance = src.distance;
      dst.decay = src.decay;
      dst.intensity = src.intensity;
    }
  }

  /** Idle sway, walk bob, look and jump lag, sprint pose, equip raise and the one-shot clip. */
  private animate(dt: number, ctx: GameContext): void {
    const player = ctx.player;
    this.time += dt;

    const yaw = player.yaw;
    const pitch = player.pitch;
    const turnYaw = this.prevYaw === null || dt <= 0 ? 0 : angleDelta(this.prevYaw, yaw) / dt;
    const turnPitch = this.prevYaw === null || dt <= 0 ? 0 : (pitch - this.prevPitch) / dt;
    this.prevYaw = yaw;
    this.prevPitch = pitch;
    const look = damp(LOOK_RATE, dt);
    this.lagYaw += (clamp(-turnYaw * LOOK_LAG, -MAX_LAG, MAX_LAG) - this.lagYaw) * look;
    this.lagPitch += (clamp(-turnPitch * LOOK_LAG, -MAX_LAG, MAX_LAG) - this.lagPitch) * look;

    const speed = player.horizontalSpeed;
    const footing = player.flying ? 0 : player.onGround ? 1 : player.inWater > 0.3 ? 0.4 : 0;
    this.bobPhase = (this.bobPhase + speed * dt * (Math.PI / STEP_LENGTH)) % TAU;
    this.bobAmp += (Math.min(speed / PLAYER.walkSpeed, MAX_BOB) * footing - this.bobAmp) * damp(BOB_RATE, dt);
    const air = player.onGround || player.flying ? 0 : clamp(-player.velocity.y * AIR_LAG, -MAX_AIR, MAX_AIR);
    this.airOffset += (air - this.airOffset) * damp(AIR_RATE, dt);
    const sprinting = player.sprinting && player.onGround && speed > PLAYER.walkSpeed * 1.1 ? 1 : 0;
    this.sprint += (sprinting - this.sprint) * damp(SPRINT_RATE, dt);

    const b = this.bobAmp;
    const s = Math.sin(this.bobPhase);
    const t = this.time;
    this.sway.position.set(
      BOB_X * b * s + IDLE_X * Math.sin(t * 0.9),
      -BOB_Y * b * s * s + IDLE_Y * Math.sin(t * 1.7) + this.airOffset - SPRINT_DROP * this.sprint,
      0,
    );
    this.sway.rotation.set(this.lagPitch - SPRINT_TILT * this.sprint, this.lagYaw, BOB_ROLL * b * s + IDLE_ROLL * Math.sin(t * 0.7));

    const target = this.target;
    if (this.clip !== null) {
      this.clipTime += dt;
      const u = this.clipTime / this.clipDuration;
      if (u >= 1) this.clip = null;
      else sampleClip(this.clip.keys, u, target);
    }
    if (this.clip === null) target.fill(0);
    const follow = damp(ANIM_FOLLOW, dt);
    const pose = this.pose;
    for (let i = 0; i < 9; i++) pose[i] += (target[i] - pose[i]) * follow;

    this.equip = Math.min(1, this.equip + dt / EQUIP_TIME);
    const lowered = (1 - this.equip) * (1 - this.equip);
    this.arm.position.set(SHOULDER.x + pose[0], SHOULDER.y + pose[1] - EQUIP_DROP * lowered, SHOULDER.z + pose[2]);
    this.arm.rotation.set(pose[3] - EQUIP_TILT * lowered, pose[4], pose[5]);
    this.gripPivot.rotation.set(pose[6], pose[7], pose[8]);
  }

  /** Torch flame glow / flashlight lens glow at the item's tip. */
  private updateGlows(ctx: GameContext): void {
    const item = this.current;
    const torch = item !== null && item.glow === 'torch';
    const lens = item !== null && item.glow === 'flashlight' && ctx.renderer.flashlight.intensity > 0;
    this.glowOuter.visible = torch;
    this.glowCore.visible = torch || lens;
    if (item === null || (!torch && !lens)) return;
    const tip = this.v1.copy(item.tip).applyMatrix4(item.mesh.matrix);
    const core = this.glowCore.material;
    this.glowCore.position.copy(tip);
    if (torch) {
      const t = ctx.time.elapsed;
      const w = flicker(t, 0);
      this.glowOuter.position.copy(tip);
      this.glowOuter.scale.setScalar(TORCH_GLOW_SIZE * (1 + 0.12 * w));
      this.glowOuter.material.color.copy(TORCH_GLOW);
      this.glowOuter.material.opacity = 0.55 + 0.15 * w;
      this.glowCore.scale.setScalar(TORCH_CORE_SIZE * (1 + 0.2 * flicker(t, 2.1)));
      core.color.copy(TORCH_CORE);
      core.opacity = 0.85;
    } else {
      this.glowCore.scale.setScalar(FLASH_GLOW_SIZE);
      core.color.copy(FLASH_GLOW);
      core.opacity = 0.9;
    }
  }
}
