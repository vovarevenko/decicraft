/**
 * Cheap particle effects (instanced tiny cubes + soft sprites). OWNER: agent "env-fx".
 * Fixed-capacity pools, no per-frame allocations, a single draw call per pool.
 *
 * Pools (each hidden while empty, so idle pools cost no draw call):
 *  - debris: lit opaque cubes with per-instance colour (block chips, leaf flakes, dust specks, bursts);
 *  - clear:  lit translucent cubes (flat glass shards, water droplets);
 *  - flames: additive camera-facing quads (flames, embers) — unaffected by exposure, faded by fog;
 *  - haze:   alpha-blended camera-facing quads (smoke, dust, splash mist), dimmed at night.
 * The simulation lives in env/particleSim.ts (no three.js); update() steps it and copies the live
 * particles into the instance buffers, uploading only the used range.
 */
import * as THREE from 'three';
import { clamp, lerp, srgbToLinear, TAU, type Vec3Like } from '../core/math';
import { createNoise2D, fbm2 } from '../core/noise';
import { B, COLOR_BOTTOM, COLOR_SIDE, COLOR_TOP, FOLIAGE, RENDER_KIND, RK, SOLID, VARY } from '../world/blocks';
import type { WorldData } from '../world/world';
import { CubeSim, makeCubeParams, makeSpriteParams, SpriteSim } from './env/particleSim';
import { sharedUniforms } from './sharedUniforms';

export interface BurstOptions {
  /** sRGB 0xRRGGBB colour, or several to pick from randomly. */
  color: number | readonly number[];
  count: number;
  /** Initial speed, world units/s (default 15). */
  speed?: number;
  /** Cube edge, world units (default 0.35 ≈ 3.5 cm). */
  size?: number;
  /** Gravity multiplier (default 1). */
  gravity?: number;
  /** Lifetime seconds (default 1.2, randomised ±30%). */
  life?: number;
  /** Preferred direction (e.g. the hit face normal); default up. */
  dir?: Vec3Like;
  /** Random spawn offset radius, world units (default 0.5). */
  spread?: number;
}

const DEBRIS_CAPACITY = 3000;
const CLEAR_CAPACITY = 800;
const FLAME_CAPACITY = 600;
const HAZE_CAPACITY = 800;
/** Translucent pools draw after the world's glass and water (renderOrder 0), haze below flames. */
const CLEAR_ORDER = 10;
const HAZE_ORDER = 11;
const FLAME_ORDER = 12;

/** sRGB byte → linear. */
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR[i] = srgbToLinear(i / 255);

/** Debris per blockBreak() call when no count is given. */
const BREAK_COUNT = 8;
/** Glass shards are the pane colour pulled this far towards white. */
const GLASS_WHITEN = 0.45;
/** Air drag of ordinary debris, 1/s. */
const DEBRIS_DRAG = 0.4;
/** Opacity of the translucent cubes. */
const CLEAR_OPACITY = 0.62;

/** Linear colours of the effects. */
const DROPLET = [0.62, 0.74, 0.78] as const;
const MIST_FROM = [0.78, 0.84, 0.86] as const;
const MIST_TO = [0.86, 0.9, 0.92] as const;
const DUST_FROM = [0.3, 0.26, 0.2] as const;
const DUST_TO = [0.37, 0.34, 0.29] as const;
const FLAME_HOT = [1.0, 0.6, 0.2] as const;
const FLAME_COOL = [0.85, 0.16, 0.02] as const;
const EMBER_HOT = [1.0, 0.62, 0.24] as const;
const EMBER_COOL = [0.7, 0.12, 0.0] as const;
const SMOKE_FROM = [0.16, 0.15, 0.14] as const;
const SMOKE_TO = [0.3, 0.3, 0.31] as const;

/** Fire emission per second at intensity 1. */
const FLAME_RATE = 48;
const EMBER_RATE = 3;
const SMOKE_RATE = 6;
/** Horizontal drift of smoke (units/s); the clouds drift the same way. */
const WIND_X = 1.4;
const WIND_Z = 0.5;

/** Sprites fade in over this first fraction of their life and out over this last fraction. */
const FADE_IN = 0.12;
const FADE_OUT = 0.45;
/** Flame quads are this much taller than wide. */
const FLAME_ASPECT = 1.4;

const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

/** Whole number of particles to emit for `rate`·`dt`, rounding the fraction stochastically (no per-source state). */
function emitCount(rate: number, dt: number): number {
  const n = rate * dt;
  const whole = Math.floor(n);
  return whole + (Math.random() < n - whole ? 1 : 0);
}

// ---------------------------------------------------------------- sprite shaders

const SPRITE_VERTEX = /* glsl */ `
attribute vec4 iPosSize;
attribute vec4 iColor;
attribute float iRot;
uniform float uAspect;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(iPosSize.xyz, 1.0);
  vec2 corner = position.xy * vec2(iPosSize.w, iPosSize.w * uAspect);
  float c = cos(iRot);
  float s = sin(iRot);
  mvPosition.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;
  vColor = iColor;
  #include <fog_vertex>
}
`;

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uDaylight;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
const float NIGHT_LIGHT = 0.14;
void main() {
  float mask = texture2D(uMap, vUv).r * vColor.a;
#ifdef ADDITIVE
  // Light emitters: fog fades them out instead of tinting (adding fog colour would glow).
  gl_FragColor = vec4(vColor.rgb, mask);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.a *= 1.0 - fogFactor;
  #endif
#else
  gl_FragColor = vec4(vColor.rgb * mix(NIGHT_LIGHT, 1.0, uDaylight), mask);
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
#ifndef ADDITIVE
  // After the output conversion, as in three's own materials: fogColor is given in output colour space.
  #include <fog_fragment>
#endif
}
`;

/** Soft round puff with a noisy outline (mask in every channel), generated once on the CPU. */
function createPuffTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  const outline = createNoise2D(0x70756666);
  const density = createNoise2D(0x70756667);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * 2 - 1;
      const v = ((y + 0.5) / size) * 2 - 1;
      const d = Math.hypot(u, v) * (0.88 + 0.24 * fbm2(outline, u * 1.8, v * 1.8, 3));
      const edge = clamp((1 - d) / 0.8, 0, 1);
      const m = edge * edge * (3 - 2 * edge) * (0.72 + 0.28 * fbm2(density, u * 3.1, v * 3.1, 3));
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = Math.round(clamp(m, 0, 1) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'particle-puff';
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function createSpriteMaterial(name: string, additive: boolean, map: THREE.Texture, aspect: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uMap: { value: map },
      uAspect: { value: aspect },
      uDaylight: sharedUniforms.uDaylight,
    },
    defines: additive ? { ADDITIVE: '' } : {},
    vertexShader: SPRITE_VERTEX,
    fragmentShader: SPRITE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: true,
    toneMapped: !additive,
  });
}

/** A dynamic instance attribute uploaded as its used prefix only, through one reused range (no per-frame garbage). */
class InstanceUpload {
  readonly array: Float32Array;
  private readonly range = { start: 0, count: 0 };

  constructor(readonly attribute: THREE.BufferAttribute) {
    attribute.setUsage(THREE.DynamicDrawUsage);
    this.array = attribute.array as Float32Array;
  }

  /** Marks the first `used` instances for upload. */
  mark(used: number): void {
    const a = this.attribute;
    this.range.count = used * a.itemSize;
    a.clearUpdateRanges();
    a.updateRanges.push(this.range);
    a.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- pools

/** A cube simulation mirrored into one InstancedMesh (matrix + colour per instance). */
class CubePool {
  readonly sim: CubeSim;
  readonly mesh: THREE.InstancedMesh;
  private readonly matrices: InstanceUpload;
  private readonly colors: InstanceUpload;

  constructor(name: string, capacity: number, geometry: THREE.BufferGeometry, material: THREE.Material) {
    this.sim = new CubeSim(capacity);
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    // Created up front: precompile must see the per-instance colour the pool renders with.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.matrices = new InstanceUpload(mesh.instanceMatrix);
    this.colors = new InstanceUpload(mesh.instanceColor);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    this.mesh = mesh;
  }

  /** Writes every live particle's transform (tumble, shrink-out, flatness) and colour. */
  sync(): void {
    const sim = this.sim;
    const n = sim.count;
    const mesh = this.mesh;
    mesh.count = n;
    mesh.visible = n > 0;
    if (n === 0) return;
    const m = this.matrices.array;
    const c = this.colors.array;
    for (let i = 0; i < n; i++) {
      const s = sim.size[i] * sim.scale(i);
      const t = s * sim.flat[i];
      const ax = sim.ax[i];
      const ay = sim.ay[i];
      const az = sim.az[i];
      const cos = Math.cos(sim.angle[i]);
      const sin = Math.sin(sim.angle[i]);
      const k = 1 - cos;
      // Axis-angle rotation, columns scaled by (s, s·flat, s); column-major like Matrix4.elements.
      const o = i * 16;
      m[o] = (cos + ax * ax * k) * s;
      m[o + 1] = (ay * ax * k + az * sin) * s;
      m[o + 2] = (az * ax * k - ay * sin) * s;
      m[o + 3] = 0;
      m[o + 4] = (ax * ay * k - az * sin) * t;
      m[o + 5] = (cos + ay * ay * k) * t;
      m[o + 6] = (az * ay * k + ax * sin) * t;
      m[o + 7] = 0;
      m[o + 8] = (ax * az * k + ay * sin) * s;
      m[o + 9] = (ay * az * k - ax * sin) * s;
      m[o + 10] = (cos + az * az * k) * s;
      m[o + 11] = 0;
      m[o + 12] = sim.px[i];
      m[o + 13] = sim.py[i];
      m[o + 14] = sim.pz[i];
      m[o + 15] = 1;
      c[i * 3] = sim.r[i];
      c[i * 3 + 1] = sim.g[i];
      c[i * 3 + 2] = sim.b[i];
    }
    this.matrices.mark(n);
    this.colors.mark(n);
  }
}

/** A sprite simulation mirrored into one instanced camera-facing quad mesh. */
class SpritePool {
  readonly sim: SpriteSim;
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly posSize: InstanceUpload;
  private readonly color: InstanceUpload;
  private readonly rot: InstanceUpload;

  constructor(name: string, capacity: number, quad: THREE.BufferGeometry, material: THREE.Material) {
    this.sim = new SpriteSim(capacity);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(quad.getIndex());
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    const attribute = (name: string, itemSize: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
      geometry.setAttribute(name, a);
      return new InstanceUpload(a);
    };
    this.posSize = attribute('iPosSize', 4);
    this.color = attribute('iColor', 4);
    this.rot = attribute('iRot', 1);
    geometry.instanceCount = 0;
    this.geometry = geometry;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.visible = false;
    mesh.frustumCulled = false;
    this.mesh = mesh;
  }

  /** Writes position/size, colour/opacity (by age) and rotation of every live sprite. */
  sync(): void {
    const sim = this.sim;
    const n = sim.count;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    const ps = this.posSize.array;
    const col = this.color.array;
    const rot = this.rot.array;
    const c0 = sim.c0;
    const c1 = sim.c1;
    for (let i = 0; i < n; i++) {
      const age = sim.age(i);
      const fade = Math.min(1, age / FADE_IN, (1 - age) / FADE_OUT);
      const o = i * 4;
      const p = i * 3;
      ps[o] = sim.px[i];
      ps[o + 1] = sim.py[i];
      ps[o + 2] = sim.pz[i];
      ps[o + 3] = lerp(sim.size0[i], sim.size1[i], age);
      col[o] = lerp(c0[p], c1[p], age);
      col[o + 1] = lerp(c0[p + 1], c1[p + 1], age);
      col[o + 2] = lerp(c0[p + 2], c1[p + 2], age);
      col[o + 3] = sim.alpha[i] * Math.max(0, fade);
      rot[i] = sim.rot[i];
    }
    this.posSize.mark(n);
    this.color.mark(n);
    this.rot.mark(n);
  }
}

// ---------------------------------------------------------------- effects

export class Particles {
  private readonly world: WorldData;
  private readonly debris: CubePool;
  private readonly clear: CubePool;
  private readonly flames: SpritePool;
  private readonly haze: SpritePool;
  /** Scratch spawn descriptions and the last random direction (no allocations per particle). */
  private readonly cube = makeCubeParams();
  private readonly sprite = makeSpriteParams();
  private rx = 0;
  private ry = 0;
  private rz = 0;

  /** `world` is used for cheap debris ground collision (particles rest on / bounce off solid voxels). */
  constructor(scene: THREE.Scene, world: WorldData) {
    this.world = world;
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.debris = new CubePool('particles-debris', DEBRIS_CAPACITY, box, new THREE.MeshLambertMaterial({ name: 'particle-debris' }));
    this.clear = new CubePool(
      'particles-clear',
      CLEAR_CAPACITY,
      box,
      new THREE.MeshLambertMaterial({ name: 'particle-clear', transparent: true, opacity: CLEAR_OPACITY, depthWrite: false }),
    );
    this.clear.mesh.renderOrder = CLEAR_ORDER;

    const quad = new THREE.PlaneGeometry(1, 1);
    const puff = createPuffTexture();
    this.flames = new SpritePool('particles-flames', FLAME_CAPACITY, quad, createSpriteMaterial('particle-flames', true, puff, FLAME_ASPECT));
    this.flames.mesh.renderOrder = FLAME_ORDER;
    this.haze = new SpritePool('particles-haze', HAZE_CAPACITY, quad, createSpriteMaterial('particle-haze', false, puff, 1));
    this.haze.mesh.renderOrder = HAZE_ORDER;

    scene.add(this.debris.mesh, this.clear.mesh, this.haze.mesh, this.flames.mesh);
  }

  /** Live particle counts per pool (debug overlay, tests). */
  get counts(): { debris: number; clear: number; flames: number; haze: number } {
    return { debris: this.debris.sim.count, clear: this.clear.sim.count, flames: this.flames.sim.count, haze: this.haze.sim.count };
  }

  burst(pos: Vec3Like, opts: BurstOptions): void {
    const colors = opts.color;
    if (!(opts.count > 0) || (typeof colors !== 'number' && colors.length === 0)) return;
    const speed = opts.speed ?? 15;
    const size = opts.size ?? 0.35;
    const life = opts.life ?? 1.2;
    const spread = opts.spread ?? 0.5;
    let dx = 0;
    let dy = 1;
    let dz = 0;
    const len = opts.dir === undefined ? 0 : Math.hypot(opts.dir.x, opts.dir.y, opts.dir.z);
    if (opts.dir !== undefined && len > 1e-6) {
      dx = opts.dir.x / len;
      dy = opts.dir.y / len;
      dz = opts.dir.z / len;
    }
    const p = this.cube;
    p.size = size;
    p.flat = 1;
    p.gravity = opts.gravity ?? 1;
    p.drag = DEBRIS_DRAG;
    p.diesOnLanding = false;
    for (let k = 0; k < opts.count; k++) {
      this.randomInSphere();
      p.x = pos.x + this.rx * spread;
      p.y = pos.y + this.ry * spread;
      p.z = pos.z + this.rz * spread;
      this.randomInSphere();
      const v = speed * rand(0.6, 1);
      p.vx = dx * v + this.rx * speed * 0.45;
      p.vy = dy * v + this.ry * speed * 0.45;
      p.vz = dz * v + this.rz * speed * 0.45;
      p.life = life * rand(0.7, 1.3);
      const hex = typeof colors === 'number' ? colors : colors[Math.floor(Math.random() * colors.length)];
      p.r = LINEAR[(hex >> 16) & 255];
      p.g = LINEAR[(hex >> 8) & 255];
      p.b = LINEAR[hex & 255];
      this.debris.sim.spawn(p);
    }
  }

  /** Debris in the block's colours flying out of voxel (x, y, z) (towards `normal` if given). */
  blockBreak(x: number, y: number, z: number, blockId: number, count = BREAK_COUNT, normal?: Vec3Like): void {
    const id = blockId & 255;
    if (!(count > 0) || id === B.AIR || id === B.WATER) return;
    const glass = RENDER_KIND[id] === RK.GLASS;
    // Leaves and plants break into light flakes that flutter down.
    const flakes = !glass && (RENDER_KIND[id] === RK.PLANT || FOLIAGE[id] === 1);
    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (normal !== undefined && (normal.x !== 0 || normal.y !== 0 || normal.z !== 0)) {
      nx = normal.x;
      ny = normal.y;
      nz = normal.z;
    }
    // A knock leaves the voxel standing: chips fly off the hit face rather than out of the emptied cell.
    const intact = normal !== undefined && SOLID[this.world.getBlock(x, y, z)] === 1;
    const o = id * 3;
    const p = this.cube;
    p.diesOnLanding = false;
    for (let k = 0; k < count; k++) {
      if (intact) {
        p.x = x + 0.5 + nx * 0.62 + rand(-0.45, 0.45) * (1 - Math.abs(nx));
        p.y = y + 0.5 + ny * 0.62 + rand(-0.45, 0.45) * (1 - Math.abs(ny));
        p.z = z + 0.5 + nz * 0.62 + rand(-0.45, 0.45) * (1 - Math.abs(nz));
      } else {
        p.x = x + rand(0.1, 0.9);
        p.y = y + rand(0.1, 0.9);
        p.z = z + rand(0.1, 0.9);
      }
      const speed = (intact ? rand(5, 10) : rand(7, 15)) * (flakes ? 0.6 : glass ? 1.2 : 1);
      this.randomInSphere();
      p.vx = (nx + this.rx * 0.9) * speed;
      p.vy = (ny + this.ry * 0.9) * speed + rand(3, 7);
      p.vz = (nz + this.rz * 0.9) * speed;

      if (glass) {
        p.size = rand(0.18, 0.55);
        p.flat = rand(0.12, 0.22);
        p.life = rand(1, 1.8);
        p.gravity = 1;
        p.drag = 0.3;
        p.r = lerp(LINEAR[COLOR_SIDE[o]], 1, GLASS_WHITEN);
        p.g = lerp(LINEAR[COLOR_SIDE[o + 1]], 1, GLASS_WHITEN);
        p.b = lerp(LINEAR[COLOR_SIDE[o + 2]], 1, GLASS_WHITEN);
        this.clear.sim.spawn(p);
        continue;
      }

      p.size = flakes ? rand(0.12, 0.3) : rand(0.14, 0.42);
      p.flat = flakes ? 0.25 : rand(0.55, 1);
      p.life = flakes ? rand(1.3, 2.2) : rand(0.9, 1.6);
      p.gravity = flakes ? 0.3 : 1;
      p.drag = flakes ? 2.6 : DEBRIS_DRAG;
      this.blockColor(id);
      this.debris.sim.spawn(p);
    }
  }

  /** Water droplets (entering water, digging next to water). */
  splash(pos: Vec3Like, strength = 0.6): void {
    const s = clamp(strength, 0.1, 1);
    const fx = Math.floor(pos.x);
    const fz = Math.floor(pos.z);
    // Start just above the surface: a droplet touching water vanishes.
    let y = pos.y;
    for (let i = 0; i < 8 && this.world.getBlock(fx, Math.floor(y), fz) === B.WATER; i++) y = Math.floor(y) + 1.05;
    const radius = 0.8 + 1.8 * s;

    const p = this.cube;
    p.flat = 1;
    p.gravity = 1;
    p.drag = 0.5;
    p.diesOnLanding = true;
    p.r = DROPLET[0];
    p.g = DROPLET[1];
    p.b = DROPLET[2];
    const drops = Math.round(10 + 30 * s);
    for (let k = 0; k < drops; k++) {
      this.randomInDisc();
      const out = rand(1.5, 7) * (0.5 + 0.5 * s);
      p.x = pos.x + this.rx * radius;
      p.y = y + rand(0, 0.3);
      p.z = pos.z + this.rz * radius;
      p.vx = this.rx * out;
      p.vy = rand(8, 26) * (0.45 + 0.55 * s);
      p.vz = this.rz * out;
      p.size = rand(0.1, 0.26);
      p.life = rand(1.2, 1.8);
      this.clear.sim.spawn(p);
    }

    const q = this.sprite;
    const mists = Math.round(2 + 4 * s);
    for (let k = 0; k < mists; k++) {
      this.randomInDisc();
      q.x = pos.x + this.rx * radius * 0.6;
      q.y = y + 0.3;
      q.z = pos.z + this.rz * radius * 0.6;
      q.vx = this.rx * 1.5;
      q.vy = rand(2, 5) * s;
      q.vz = this.rz * 1.5;
      q.life = rand(0.5, 0.9);
      q.size0 = 1.2 + 1.5 * s;
      q.size1 = 3 + 4 * s;
      this.setColors(MIST_FROM, MIST_TO, 1);
      q.alpha = 0.28;
      q.rise = 0.5;
      q.drag = 2.5;
      q.rot = Math.random() * TAU;
      q.spin = rand(-0.6, 0.6);
      this.haze.sim.spawn(q);
    }
  }

  /** A dust puff (falling bodies landing, heavy impacts). */
  dust(pos: Vec3Like, radius: number): void {
    const r = clamp(radius, 1, 20);

    // Specks of whatever the impact hit, kicked up and outwards.
    const ground = this.world.getBlock(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z));
    const p = this.cube;
    p.flat = 1;
    p.gravity = 1;
    p.drag = 1.2;
    p.diesOnLanding = false;
    const specks = Math.round(clamp(r * 1.2, 3, 16));
    for (let k = 0; k < specks; k++) {
      this.randomInDisc();
      const out = rand(4, 10);
      p.x = pos.x + this.rx * r * 0.4;
      p.y = pos.y + 0.3;
      p.z = pos.z + this.rz * r * 0.4;
      p.vx = this.rx * out;
      p.vy = rand(5, 12);
      p.vz = this.rz * out;
      p.size = rand(0.1, 0.25);
      p.life = rand(0.8, 1.4);
      if (SOLID[ground] === 1) {
        this.blockColor(ground);
      } else {
        const f = rand(0.8, 1.2);
        p.r = DUST_FROM[0] * f;
        p.g = DUST_FROM[1] * f;
        p.b = DUST_FROM[2] * f;
      }
      this.debris.sim.spawn(p);
    }

    const n = Math.round(clamp(4 + r * 0.6, 4, 14));
    const q = this.sprite;
    for (let k = 0; k < n; k++) {
      this.randomInDisc();
      const out = rand(0.6, 1.4) * r;
      q.x = pos.x + this.rx * r * 0.5;
      q.y = pos.y + rand(0.2, 0.2 + r * 0.15);
      q.z = pos.z + this.rz * r * 0.5;
      q.vx = this.rx * out;
      q.vy = rand(1, 3);
      q.vz = this.rz * out;
      q.life = rand(1.4, 2.4);
      q.size0 = r * rand(0.35, 0.55);
      q.size1 = r * rand(1.1, 1.6);
      this.setColors(DUST_FROM, DUST_TO, rand(0.85, 1.15));
      q.alpha = 0.42;
      q.rise = 0.6;
      q.drag = 1.8;
      q.rot = Math.random() * TAU;
      q.spin = rand(-0.5, 0.5);
      this.haze.sim.spawn(q);
    }
  }

  /** Emits flames + smoke for this frame at `pos` (campfire, torch). Call every frame while burning. */
  fire(pos: Vec3Like, dt: number, intensity = 1): void {
    const k = clamp(intensity, 0, 4);
    if (k <= 0 || !(dt > 0)) return;
    const root = Math.sqrt(k);
    const q = this.sprite;

    const flames = emitCount(FLAME_RATE * k, dt);
    for (let i = 0; i < flames; i++) {
      this.randomInDisc();
      q.x = pos.x + this.rx * 1.1 * root;
      q.y = pos.y + rand(0, 0.5);
      q.z = pos.z + this.rz * 1.1 * root;
      q.vx = rand(-0.7, 0.7);
      q.vy = rand(2, 5);
      q.vz = rand(-0.7, 0.7);
      q.life = rand(0.35, 0.7);
      q.size0 = rand(1.8, 2.8) * root;
      q.size1 = 0.5 * root;
      this.setColors(FLAME_HOT, FLAME_COOL, 1);
      q.alpha = 0.42;
      q.rise = 18;
      q.drag = 2.5;
      q.rot = rand(-0.25, 0.25);
      q.spin = rand(-1, 1);
      this.flames.sim.spawn(q);
    }

    const embers = emitCount(EMBER_RATE * k, dt);
    for (let i = 0; i < embers; i++) {
      this.randomInDisc();
      q.x = pos.x + this.rx * 0.8 * root;
      q.y = pos.y + 0.5;
      q.z = pos.z + this.rz * 0.8 * root;
      q.vx = rand(-2.5, 2.5);
      q.vy = rand(6, 14);
      q.vz = rand(-2.5, 2.5);
      q.life = rand(0.9, 1.8);
      q.size0 = 0.22;
      q.size1 = 0.1;
      this.setColors(EMBER_HOT, EMBER_COOL, 1);
      q.alpha = 1;
      q.rise = 1;
      q.drag = 0.9;
      q.rot = 0;
      q.spin = 0;
      this.flames.sim.spawn(q);
    }

    const smoke = emitCount(SMOKE_RATE * k, dt);
    for (let i = 0; i < smoke; i++) {
      this.randomInDisc();
      q.x = pos.x + this.rx * 0.8 * root;
      q.y = pos.y + rand(3.5, 5.5) * root;
      q.z = pos.z + this.rz * 0.8 * root;
      q.vx = WIND_X + rand(-0.6, 0.6);
      q.vy = rand(3, 5);
      q.vz = WIND_Z + rand(-0.6, 0.6);
      q.life = rand(3.5, 5.5);
      q.size0 = 2.2 * root;
      q.size1 = rand(9, 12) * root;
      this.setColors(SMOKE_FROM, SMOKE_TO, rand(0.85, 1.15));
      q.alpha = 0.2;
      q.rise = 1.2;
      q.drag = 0.3;
      q.rot = Math.random() * TAU;
      q.spin = rand(-0.4, 0.4);
      this.haze.sim.spawn(q);
    }
  }

  update(dt: number): void {
    if (dt > 0) {
      this.debris.sim.step(dt, this.world);
      this.clear.sim.step(dt, this.world);
      this.flames.sim.step(dt);
      this.haze.sim.step(dt);
    }
    this.debris.sync();
    this.clear.sync();
    this.flames.sync();
    this.haze.sync();
  }

  /**
   * A colour of block `id` for the scratch cube: mostly the side colour, some top (grass) and bottom
   * (soil) — they differ only for a few blocks — with the block's brightness variation.
   */
  private blockColor(id: number): void {
    const face = Math.random();
    const table = face < 0.3 ? COLOR_TOP : face > 0.7 ? COLOR_BOTTOM : COLOR_SIDE;
    const f = 1 + (Math.random() * 2 - 1) * (VARY[id] / 255 + 0.05);
    const o = id * 3;
    const p = this.cube;
    p.r = LINEAR[table[o]] * f;
    p.g = LINEAR[table[o + 1]] * f;
    p.b = LINEAR[table[o + 2]] * f;
  }

  /** Birth/death colours of the scratch sprite, both scaled by `f`. */
  private setColors(from: readonly number[], to: readonly number[], f: number): void {
    const q = this.sprite;
    q.r0 = from[0] * f;
    q.g0 = from[1] * f;
    q.b0 = from[2] * f;
    q.r1 = to[0] * f;
    q.g1 = to[1] * f;
    q.b1 = to[2] * f;
  }

  /** Uniform random point in the unit ball → (rx, ry, rz). */
  private randomInSphere(): void {
    let x = 0;
    let y = 0;
    let z = 0;
    do {
      x = Math.random() * 2 - 1;
      y = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    this.rx = x;
    this.ry = y;
    this.rz = z;
  }

  /** Uniform random point in the horizontal unit disc → (rx, 0, rz). */
  private randomInDisc(): void {
    let x = 0;
    let z = 0;
    do {
      x = Math.random() * 2 - 1;
      z = Math.random() * 2 - 1;
    } while (x * x + z * z > 1);
    this.rx = x;
    this.ry = 0;
    this.rz = z;
  }
}
