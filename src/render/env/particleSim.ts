/**
 * Particle simulation core: fixed-capacity structure-of-arrays pools, no three.js and no allocations
 * per particle or per frame. OWNER: agent "env-fx". Rendering lives in render/particles.ts.
 *
 * Live particles occupy [0, count); a dead one is replaced by the last (swap-remove). When a pool is
 * full, new particles overwrite existing ones round-robin, so fresh effects always show.
 */
import { GRAVITY } from '../../config';
import { B, SOLID } from '../../world/blocks';
import type { WorldData } from '../../world/world';

/** What the cube simulation needs from the world. */
export type BlockReader = Pick<WorldData, 'getBlock'>;

/** Scratch description of one cube particle, filled by the caller and copied by `CubeSim.spawn`. */
export interface CubeParams {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Edge length, world units. */
  size: number;
  /** Thickness relative to the edge: 1 = cube, < 1 = flat shard or flake. */
  flat: number;
  /** Seconds. */
  life: number;
  /** Gravity multiplier. */
  gravity: number;
  /** Air drag rate, 1/s. */
  drag: number;
  /** Linear colour. */
  r: number;
  g: number;
  b: number;
  /** Vanishes on touching ground or water instead of bouncing and resting (droplets). */
  diesOnLanding: boolean;
}

/** A fresh scratch CubeParams with defaults (a 3.5 cm cube, 1 s life, normal gravity). */
export const makeCubeParams = (): CubeParams => ({
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  size: 0.35,
  flat: 1,
  life: 1,
  gravity: 1,
  drag: 0,
  r: 1,
  g: 1,
  b: 1,
  diesOnLanding: false,
});

const RESTING = 1;
const DIES_ON_LANDING = 2;
/** Fraction of the vertical speed kept by a bounce, and of the horizontal speed by ground friction. */
const BOUNCE = 0.35;
const FRICTION = 0.55;
const WALL_BOUNCE = 0.3;
/** Landing slower than this (units/s) comes to rest. */
const REST_SPEED = 3;
/** Water: gravity multiplier (slow sinking) and drag. */
const WATER_GRAVITY = 0.15;
const WATER_DRAG = 5;
/** Particles shrink away over this last fraction of their life. */
export const SHRINK_FRACTION = 0.3;
/** Max distance per integration substep (no tunnelling through 1-voxel slabs). */
const MAX_STEP = 0.9;
/** A particle that dies on landing lingers this long. */
export const SPLAT_TIME = 0.08;

function solidAt(world: BlockReader, x: number, y: number, z: number): boolean {
  return SOLID[world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
}

/** Tumbling cubes with gravity, drag, bouncing and resting on solid voxels (foliage is not solid). */
export class CubeSim {
  readonly capacity: number;
  count = 0;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly size: Float32Array;
  readonly flat: Float32Array;
  readonly gravity: Float32Array;
  readonly drag: Float32Array;
  /** Spin axis (unit), angle and angular speed. */
  readonly ax: Float32Array;
  readonly ay: Float32Array;
  readonly az: Float32Array;
  readonly angle: Float32Array;
  readonly spin: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly flags: Uint8Array;
  private next = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.life = f();
    this.maxLife = f();
    this.size = f();
    this.flat = f();
    this.gravity = f();
    this.drag = f();
    this.ax = f();
    this.ay = f();
    this.az = f();
    this.angle = f();
    this.spin = f();
    this.r = f();
    this.g = f();
    this.b = f();
    this.flags = new Uint8Array(capacity);
  }

  /** Adds a particle (overwriting an old one when full); returns its index. */
  spawn(p: CubeParams): number {
    let i: number;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this.next;
      this.next = (this.next + 1) % this.capacity;
    }
    this.px[i] = p.x;
    this.py[i] = p.y;
    this.pz[i] = p.z;
    this.vx[i] = p.vx;
    this.vy[i] = p.vy;
    this.vz[i] = p.vz;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.size[i] = p.size;
    this.flat[i] = p.flat;
    this.gravity[i] = p.gravity;
    this.drag[i] = p.drag;
    // Random tumbling axis.
    const ux = Math.random() * 2 - 1;
    const uy = Math.random() * 2 - 1;
    const uz = Math.random() * 2 - 1;
    const len = Math.hypot(ux, uy, uz) || 1;
    this.ax[i] = ux / len;
    this.ay[i] = uy / len;
    this.az[i] = uz / len;
    this.angle[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 10);
    this.r[i] = p.r;
    this.g[i] = p.g;
    this.b[i] = p.b;
    this.flags[i] = p.diesOnLanding ? DIES_ON_LANDING : 0;
    return i;
  }

  /** Particle `i` lies on a solid voxel (no integration until that voxel disappears). */
  isResting(i: number): boolean {
    return (this.flags[i] & RESTING) !== 0;
  }

  /** Current visual scale factor (1, shrinking to 0 over the last SHRINK_FRACTION of life). */
  scale(i: number): number {
    return Math.min(1, this.life[i] / (this.maxLife[i] * SHRINK_FRACTION));
  }

  /** Advances every live particle by `dt` seconds against `world`; expired ones are removed. */
  step(dt: number, world: BlockReader): void {
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.remove(i);
        i--;
        continue;
      }
      if (this.flags[i] & RESTING) {
        // Stays put until the voxel under it disappears.
        if (solidAt(world, this.px[i], this.py[i] - this.size[i] * 0.5 - 0.05, this.pz[i])) continue;
        this.flags[i] &= ~RESTING;
      }
      const speed = Math.abs(this.vx[i]) + Math.abs(this.vy[i]) + Math.abs(this.vz[i]);
      const steps = Math.min(8, Math.max(1, Math.ceil((speed * dt) / MAX_STEP)));
      const h = dt / steps;
      for (let s = 0; s < steps && !(this.flags[i] & RESTING); s++) this.integrate(i, h, world);
      this.angle[i] += this.spin[i] * dt;
    }
  }

  private integrate(i: number, dt: number, world: BlockReader): void {
    const half = this.size[i] * 0.5;
    let x = this.px[i];
    let y = this.py[i];
    let z = this.pz[i];
    let vx = this.vx[i];
    let vy = this.vy[i];
    let vz = this.vz[i];
    const inWater = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER;
    const dies = (this.flags[i] & DIES_ON_LANDING) !== 0;
    if (inWater && dies) this.life[i] = Math.min(this.life[i], SPLAT_TIME);

    vy -= GRAVITY * this.gravity[i] * (inWater ? WATER_GRAVITY : 1) * dt;
    const drag = inWater ? WATER_DRAG : this.drag[i];
    if (drag > 0) {
      const k = Math.exp(-drag * dt);
      vx *= k;
      vy *= k;
      vz *= k;
    }

    const nx = x + vx * dt;
    if (solidAt(world, nx, y, z)) vx = -vx * WALL_BOUNCE;
    else x = nx;
    const nz = z + vz * dt;
    if (solidAt(world, x, y, nz)) vz = -vz * WALL_BOUNCE;
    else z = nz;

    const ny = y + vy * dt;
    if (vy < 0 && solidAt(world, x, ny - half, z)) {
      // Sit on top of the voxel below (unless buried inside solid ground: then stay where it is).
      const top = Math.floor(ny - half) + 1 + half;
      if (!solidAt(world, x, top, z)) y = top;
      if (dies) this.life[i] = Math.min(this.life[i], SPLAT_TIME);
      if (-vy < REST_SPEED) {
        vx = 0;
        vy = 0;
        vz = 0;
        this.flags[i] |= RESTING;
      } else {
        vy = -vy * BOUNCE;
        vx *= FRICTION;
        vz *= FRICTION;
      }
    } else if (vy > 0 && solidAt(world, x, ny + half, z)) {
      vy = 0;
    } else {
      y = ny;
    }

    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last];
    this.py[i] = this.py[last];
    this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.vz[i] = this.vz[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size[i] = this.size[last];
    this.flat[i] = this.flat[last];
    this.gravity[i] = this.gravity[last];
    this.drag[i] = this.drag[last];
    this.ax[i] = this.ax[last];
    this.ay[i] = this.ay[last];
    this.az[i] = this.az[last];
    this.angle[i] = this.angle[last];
    this.spin[i] = this.spin[last];
    this.r[i] = this.r[last];
    this.g[i] = this.g[last];
    this.b[i] = this.b[last];
    this.flags[i] = this.flags[last];
  }
}

/** Scratch description of one sprite particle (flame, ember, smoke, dust, mist). */
export interface SpriteParams {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  /** Size (world units) at birth and at death. */
  size0: number;
  size1: number;
  /** Linear colour at birth and at death. */
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  /** Peak opacity (or additive strength). */
  alpha: number;
  /** Upward acceleration (buoyancy), units/s². */
  rise: number;
  /** Drag rate, 1/s. */
  drag: number;
  /** Initial rotation in the screen plane (radians) and rotation speed (rad/s). */
  rot: number;
  spin: number;
}

/** A fresh scratch SpriteParams with neutral defaults. */
export const makeSpriteParams = (): SpriteParams => ({
  x: 0,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  life: 1,
  size0: 1,
  size1: 1,
  r0: 1,
  g0: 1,
  b0: 1,
  r1: 1,
  g1: 1,
  b1: 1,
  alpha: 1,
  rise: 0,
  drag: 0,
  rot: 0,
  spin: 0,
});

/** Camera-facing sprites drifting with buoyancy and drag (no collisions). */
export class SpriteSim {
  readonly capacity: number;
  count = 0;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly size0: Float32Array;
  readonly size1: Float32Array;
  readonly rot: Float32Array;
  readonly spin: Float32Array;
  /** Birth (c0) and death (c1) colours, interleaved rgb. */
  readonly c0: Float32Array;
  readonly c1: Float32Array;
  readonly alpha: Float32Array;
  readonly rise: Float32Array;
  readonly drag: Float32Array;
  private next = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    const f = (n = 1) => new Float32Array(capacity * n);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.life = f();
    this.maxLife = f();
    this.size0 = f();
    this.size1 = f();
    this.rot = f();
    this.spin = f();
    this.c0 = f(3);
    this.c1 = f(3);
    this.alpha = f();
    this.rise = f();
    this.drag = f();
  }

  /** Adds a particle (overwriting an old one when full); returns its index. */
  spawn(p: SpriteParams): number {
    let i: number;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      i = this.next;
      this.next = (this.next + 1) % this.capacity;
    }
    this.px[i] = p.x;
    this.py[i] = p.y;
    this.pz[i] = p.z;
    this.vx[i] = p.vx;
    this.vy[i] = p.vy;
    this.vz[i] = p.vz;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size0;
    this.size1[i] = p.size1;
    this.rot[i] = p.rot;
    this.spin[i] = p.spin;
    this.c0[i * 3] = p.r0;
    this.c0[i * 3 + 1] = p.g0;
    this.c0[i * 3 + 2] = p.b0;
    this.c1[i * 3] = p.r1;
    this.c1[i * 3 + 1] = p.g1;
    this.c1[i * 3 + 2] = p.b1;
    this.alpha[i] = p.alpha;
    this.rise[i] = p.rise;
    this.drag[i] = p.drag;
    return i;
  }

  /** Age as a fraction of the lifetime, 0 at birth … 1 at death. */
  age(i: number): number {
    return 1 - this.life[i] / this.maxLife[i];
  }

  /** Advances every live sprite by `dt` seconds; expired ones are removed. */
  step(dt: number): void {
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.remove(i);
        i--;
        continue;
      }
      this.vy[i] += this.rise[i] * dt;
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k;
      this.vy[i] *= k;
      this.vz[i] *= k;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;
    }
  }

  private remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.px[i] = this.px[last];
    this.py[i] = this.py[last];
    this.pz[i] = this.pz[last];
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.vz[i] = this.vz[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size0[i] = this.size0[last];
    this.size1[i] = this.size1[last];
    this.rot[i] = this.rot[last];
    this.spin[i] = this.spin[last];
    for (let c = 0; c < 3; c++) {
      this.c0[i * 3 + c] = this.c0[last * 3 + c];
      this.c1[i * 3 + c] = this.c1[last * 3 + c];
    }
    this.alpha[i] = this.alpha[last];
    this.rise[i] = this.rise[last];
    this.drag[i] = this.drag[last];
  }
}
