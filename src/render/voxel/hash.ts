/**
 * Streaming 53-bit hash over 32-bit words: two independent 32-bit lanes (FNV-1a style and murmur3
 * style) finalised with fmix32. Detects unchanged mesh inputs (volume.ts) and outputs (meshJob.ts);
 * not cryptographic, but collisions are vanishingly rare at 53 bits.
 */
export class WordHash {
  private h1 = 0;
  private h2 = 0;

  /** Starts a new hash. */
  reset(seed: number): this {
    this.h1 = 0x811c9dc5 ^ seed;
    this.h2 = 0x6a09e667 + seed;
    return this;
  }

  /** Mixes one 32-bit word. */
  word(w: number): this {
    this.h1 = Math.imul(this.h1 ^ w, 0x01000193);
    this.h2 = mixLane(this.h2, w);
    return this;
  }

  /** Mixes every word of `words`. */
  words(words: Uint32Array): this {
    let h1 = this.h1;
    let h2 = this.h2;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = mixLane(h2, w);
    }
    this.h1 = h1;
    this.h2 = h2;
    return this;
  }

  /** Hash of everything mixed since reset(): a non-negative safe integer. */
  digest(): number {
    return (fmix32(this.h1) >>> 0) * 0x200000 + (fmix32(this.h2) >>> 11);
  }
}

function mixLane(h: number, w: number): number {
  let k = Math.imul(w, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  h ^= Math.imul(k, 0x1b873593);
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}
