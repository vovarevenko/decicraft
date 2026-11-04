/**
 * Deterministic hashing and PRNG.
 * World generation MUST be deterministic (every generation worker rebuilds the same world plan),
 * so generation code uses only these helpers — never Math.random().
 */

export const U32_TO_UNIT = 1 / 4294967296;

/** 32-bit integer avalanche hash (lowbias32). Returns an unsigned 32-bit integer. */
export function hash32(n: number): number {
  let x = n | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of integer 2D coordinates + seed → uint32. */
export function hash2(x: number, z: number, seed = 0): number {
  return hash32((x | 0) ^ hash32((z | 0) ^ hash32(seed ^ 0x5bd1e995)));
}

/** Hash of integer 3D coordinates + seed → uint32. */
export function hash3(x: number, y: number, z: number, seed = 0): number {
  return hash32((x | 0) ^ hash32((y | 0) ^ hash32((z | 0) ^ hash32(seed ^ 0x27d4eb2d))));
}

/** Uniform float in [0, 1) from integer 2D coordinates. */
export function rand2(x: number, z: number, seed = 0): number {
  return hash2(x, z, seed) * U32_TO_UNIT;
}

/** Uniform float in [0, 1) from integer 3D coordinates. */
export function rand3(x: number, y: number, z: number, seed = 0): number {
  return hash3(x, y, z, seed) * U32_TO_UNIT;
}

/** Small, fast, seedable PRNG (sfc32). */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    this.a = hash32(seed ^ 0x9e3779b9);
    this.b = hash32(seed + 0x6a09e667);
    this.c = hash32(seed ^ 0xbb67ae85);
    this.d = 1;
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() * U32_TO_UNIT;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Uniform integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Standard normal sample (Box–Muller). */
  gauss(): number {
    let u = 0;
    while (u === 0) u = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = items[i];
      items[i] = items[j];
      items[j] = t;
    }
    return items;
  }

  /** Independent child generator (stable for a given parent state + salt). */
  fork(salt: number): Rng {
    return new Rng(hash32(this.nextU32() ^ hash32(salt)));
  }
}
