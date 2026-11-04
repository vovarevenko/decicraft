/**
 * Builds the 1-cell-padded cell volume of one octree node from shared world memory (mesh workers;
 * pure TypeScript, also used by unit tests). Spec: ARCHITECTURE.md §6.1.
 *
 * Level 0 copies voxels chunk by chunk (uniform chunks are filled). Level L ≥ 1 downsamples every
 * 2^L-voxel block: opaque if ≥ 3/8 of it is OPAQUE (≥ 1/4 when the opaque voxels are mostly
 * SUP.STRUCT, so thin walls and trunks thicken instead of vanishing), typed by the most frequent
 * *exposed* opaque voxel (non-opaque above), else the most frequent opaque one; else WATER if ≥ 1/4
 * water; else GLASS if ≥ 1/4 glass; else AIR. Plants are dropped. Uniform chunks cost O(1) per cell.
 *
 * Also samples the sky/canopy column maps around the node's vertex grid (see `colSky`) and hashes
 * everything the mesher reads, so re-meshes whose inputs did not change can be skipped.
 */
import { CHUNK_BITS, CHUNK_MASK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, WORLD_X, WORLD_Z } from '../../config';
import { B, OPAQUE as OPAQUE_TABLE, RENDER_KIND as RENDER_KIND_TABLE, RK, SUP, SUPPORT as SUPPORT_TABLE } from '../../world/blocks';
import type { WorldData } from '../../world/world';
import { WordHash } from './hash';
import { COLS, NODE_CELLS, PAD as PAD_EDGE, PAD3, SKY_REACH, padIndex as padIndexOf } from './layout';

// Module-local bindings for the hot loops: some module runners (vitest) compile imported bindings
// into getter calls, which would distort the benchmarks several times over.
const OPAQUE = OPAQUE_TABLE;
const RENDER_KIND = RENDER_KIND_TABLE;
const SUPPORT = SUPPORT_TABLE;
const PAD = PAD_EDGE;
const PAD2 = PAD * PAD;
const padIndex = padIndexOf;
const SHIFT_Z = CHUNK_BITS;
const SHIFT_Y = 2 * CHUNK_BITS;
const MASK = CHUNK_MASK;
const AIR: number = B.AIR;
const WATER: number = B.WATER;
const GLASS: number = B.GLASS;
const RK_WATER: number = RK.WATER;
const RK_GLASS: number = RK.GLASS;
const N = NODE_CELLS;
const PLANE = CHUNKS_X * CHUNKS_Z;
const LAYER = 1 << SHIFT_Y; // index step of +y inside a chunk array
const STRUCT = SUP.STRUCT;

/** Downsampled id of a uniform chunk: opaque ids keep their type, water and glass survive, the rest is air. */
const UNIFORM_CELL = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  const rk = RENDER_KIND[id];
  UNIFORM_CELL[id] = OPAQUE[id] ? id : rk === RK.WATER ? B.WATER : rk === RK.GLASS ? B.GLASS : B.AIR;
}

export class VolumeBuilder {
  /** Padded cell volume, PAD³ block ids, index = padIndex(x, y, z). */
  readonly volume = new Uint8Array(PAD3);
  /**
   * Column samples around the node's vertex grid, COLS × COLS, index k + j·COLS: column k ↔ world
   * x = ox − off + (k − SKY_REACH)·cell (off = 1 at level 0, cell/2 above), likewise j ↔ z. A vertex at
   * cell corner (i, j) lies between columns i + SKY_REACH and i + SKY_REACH + 1 (likewise j); see
   * Mesher.computeLight for which columns a face's vertex averages.
   */
  readonly colSky = new Int16Array(COLS * COLS);
  readonly colCanopy = new Int16Array(COLS * COLS);

  private readonly volumeWords = new Uint32Array(this.volume.buffer);
  private readonly skyWords = new Uint32Array(this.colSky.buffer);
  private readonly canopyWords = new Uint32Array(this.colCanopy.buffer);
  private readonly hist = new Uint16Array(256);
  private readonly exposedHist = new Uint16Array(256);
  private readonly blockIds = new Uint8Array(512);
  private readonly hasher = new WordHash();

  /** Fills `volume`, `colSky` and `colCanopy` for the node of `level` with voxel origin (ox, oy, oz). */
  build(world: WorldData, level: number, ox: number, oy: number, oz: number): void {
    if (level === 0) this.copyVoxels(world, ox, oy, oz);
    else this.downsample(world, level, ox, oy, oz);
    this.readColumns(world, level, ox, oz);
  }

  /** 53-bit hash of the last build (volume + column samples + level). */
  hash(level: number): number {
    return this.hasher.reset(level).words(this.volumeWords).words(this.skyWords).words(this.canopyWords).digest();
  }

  /** Level 0: one cell per voxel; virtual bedrock below y = 0, air outside the world. */
  private copyVoxels(world: WorldData, ox: number, oy: number, oz: number): void {
    const vol = this.volume;
    vol.fill(AIR);
    if (oy === 0) vol.fill(B.BEDROCK, 0, PAD2);
    const x0 = ox - 1;
    const y0 = oy - 1;
    const z0 = oz - 1;
    const x1 = ox + N + 1;
    const y1 = oy + N + 1;
    const z1 = oz + N + 1;
    const cyHi = Math.min(CHUNKS_Y - 1, (y1 - 1) >> SHIFT_Z);
    const czHi = Math.min(CHUNKS_Z - 1, (z1 - 1) >> SHIFT_Z);
    const cxHi = Math.min(CHUNKS_X - 1, (x1 - 1) >> SHIFT_Z);
    for (let cy = Math.max(0, y0 >> SHIFT_Z); cy <= cyHi; cy++) {
      const ay = Math.max(y0, cy << SHIFT_Z);
      const by = Math.min(y1, (cy + 1) << SHIFT_Z);
      for (let cz = Math.max(0, z0 >> SHIFT_Z); cz <= czHi; cz++) {
        const az = Math.max(z0, cz << SHIFT_Z);
        const bz = Math.min(z1, (cz + 1) << SHIFT_Z);
        for (let cx = Math.max(0, x0 >> SHIFT_Z); cx <= cxHi; cx++) {
          const ax = Math.max(x0, cx << SHIFT_Z);
          const len = Math.min(x1, (cx + 1) << SHIFT_Z) - ax;
          const key = cx + cz * CHUNKS_X + cy * PLANE;
          const t = world.table[key];
          if (t < 0) {
            const id = -1 - t;
            if (id === AIR) continue;
            for (let y = ay; y < by; y++) {
              for (let z = az; z < bz; z++) {
                const dst = padIndex(ax - ox, y - oy, z - oz);
                vol.fill(id, dst, dst + len);
              }
            }
            continue;
          }
          const arr = world.chunkArray(key);
          if (arr === null) continue; // segment not attached yet: reads as air, the job is stale anyway
          for (let y = ay; y < by; y++) {
            for (let z = az; z < bz; z++) {
              const src = (ax & MASK) | ((z & MASK) << SHIFT_Z) | ((y & MASK) << SHIFT_Y);
              const dst = padIndex(ax - ox, y - oy, z - oz);
              for (let i = 0; i < len; i++) vol[dst + i] = arr[src + i];
            }
          }
        }
      }
    }
  }

  /** Level ≥ 1: one cell per 2^level-voxel block (blocks never straddle chunks: 32 is a multiple of 2^level). */
  private downsample(world: WorldData, level: number, ox: number, oy: number, oz: number): void {
    const vol = this.volume;
    const s = 1 << level;
    vol.fill(AIR);
    if (oy === 0) vol.fill(B.BEDROCK, 0, PAD2);
    const x0 = ox - s;
    const y0 = oy - s;
    const z0 = oz - s;
    const x1 = ox + (N + 1) * s;
    const y1 = oy + (N + 1) * s;
    const z1 = oz + (N + 1) * s;
    const cyHi = Math.min(CHUNKS_Y - 1, (y1 - 1) >> SHIFT_Z);
    const czHi = Math.min(CHUNKS_Z - 1, (z1 - 1) >> SHIFT_Z);
    const cxHi = Math.min(CHUNKS_X - 1, (x1 - 1) >> SHIFT_Z);
    for (let cy = Math.max(0, y0 >> SHIFT_Z); cy <= cyHi; cy++) {
      const ky0 = (Math.max(y0, cy << SHIFT_Z) - oy) >> level;
      const ky1 = (Math.min(y1, (cy + 1) << SHIFT_Z) - oy) >> level;
      for (let cz = Math.max(0, z0 >> SHIFT_Z); cz <= czHi; cz++) {
        const kz0 = (Math.max(z0, cz << SHIFT_Z) - oz) >> level;
        const kz1 = (Math.min(z1, (cz + 1) << SHIFT_Z) - oz) >> level;
        for (let cx = Math.max(0, x0 >> SHIFT_Z); cx <= cxHi; cx++) {
          const kx0 = (Math.max(x0, cx << SHIFT_Z) - ox) >> level;
          const kx1 = (Math.min(x1, (cx + 1) << SHIFT_Z) - ox) >> level;
          const key = cx + cz * CHUNKS_X + cy * PLANE;
          const t = world.table[key];
          if (t < 0) {
            const id = UNIFORM_CELL[-1 - t];
            if (id === AIR) continue;
            for (let ky = ky0; ky < ky1; ky++) {
              for (let kz = kz0; kz < kz1; kz++) {
                const dst = padIndex(kx0, ky, kz);
                vol.fill(id, dst, dst + (kx1 - kx0));
              }
            }
            continue;
          }
          const arr = world.chunkArray(key);
          if (arr === null) continue;
          // The layer above the chunk's top row decides whether its top voxels are exposed.
          let aboveUniform: number = AIR;
          let aboveArr: Uint8Array | null = null;
          if (cy + 1 < CHUNKS_Y) {
            const ta = world.table[key + PLANE];
            if (ta < 0) aboveUniform = -1 - ta;
            else aboveArr = world.chunkArray(key + PLANE);
          }
          for (let ky = ky0; ky < ky1; ky++) {
            const ly0 = (oy + ky * s) & MASK;
            for (let kz = kz0; kz < kz1; kz++) {
              const lz0 = (oz + kz * s) & MASK;
              let dst = padIndex(kx0, ky, kz);
              for (let kx = kx0; kx < kx1; kx++, dst++) {
                const lx0 = (ox + kx * s) & MASK;
                vol[dst] = this.reduceBlock(arr, lx0, ly0, lz0, s, aboveUniform, aboveArr);
              }
            }
          }
        }
      }
    }
  }

  /** Downsampled id of the s³ block at local chunk coords (lx0, ly0, lz0). */
  private reduceBlock(
    arr: Uint8Array,
    lx0: number,
    ly0: number,
    lz0: number,
    s: number,
    aboveUniform: number,
    aboveArr: Uint8Array | null,
  ): number {
    // Most blocks are a single id (open air, deep ground): no histogram needed.
    const first = arr[lx0 | (lz0 << SHIFT_Z) | (ly0 << SHIFT_Y)];
    let uniform = true;
    scan: for (let dy = 0; dy < s; dy++) {
      for (let dz = 0; dz < s; dz++) {
        const i = lx0 | ((lz0 + dz) << SHIFT_Z) | ((ly0 + dy) << SHIFT_Y);
        for (let dx = 0; dx < s; dx++) {
          if (arr[i + dx] !== first) {
            uniform = false;
            break scan;
          }
        }
      }
    }
    if (uniform) return UNIFORM_CELL[first];

    const hist = this.hist;
    const exposed = this.exposedHist;
    const ids = this.blockIds;
    let distinct = 0;
    let opaque = 0;
    let struct = 0;
    let water = 0;
    let glass = 0;
    for (let dy = 0; dy < s; dy++) {
      const ly = ly0 + dy;
      for (let dz = 0; dz < s; dz++) {
        let i = lx0 | ((lz0 + dz) << SHIFT_Z) | (ly << SHIFT_Y);
        for (let dx = 0; dx < s; dx++, i++) {
          const id = arr[i];
          if (OPAQUE[id] === 1) {
            opaque++;
            if (SUPPORT[id] === STRUCT) struct++;
            if (hist[id]++ === 0) ids[distinct++] = id;
            let up: number;
            if (ly < MASK) up = arr[i + LAYER];
            else if (aboveArr !== null) up = aboveArr[i & (LAYER - 1)]; // same x, z in the chunk above, y = 0
            else up = aboveUniform;
            if (OPAQUE[up] === 0) exposed[id]++;
          } else {
            const rk = RENDER_KIND[id];
            if (rk === RK_WATER) water++;
            else if (rk === RK_GLASS) glass++;
          }
        }
      }
    }
    const total = s * s * s;
    let out: number = AIR;
    if (opaque * 8 >= total * 3 || (opaque * 4 >= total && struct * 2 > opaque)) {
      let best = -1;
      let bestCount = 0;
      for (let k = 0; k < distinct; k++) {
        const c = exposed[ids[k]];
        if (c > bestCount) {
          bestCount = c;
          best = ids[k];
        }
      }
      if (best < 0) {
        for (let k = 0; k < distinct; k++) {
          const c = hist[ids[k]];
          if (c > bestCount) {
            bestCount = c;
            best = ids[k];
          }
        }
      }
      out = best;
    } else if (water * 4 >= total) {
      out = WATER;
    } else if (glass * 4 >= total) {
      out = GLASS;
    }
    for (let k = 0; k < distinct; k++) {
      hist[ids[k]] = 0;
      exposed[ids[k]] = 0;
    }
    return out;
  }

  /** Samples the sky and canopy maps on the column grid around the node (0 outside the world = open sky). */
  private readColumns(world: WorldData, level: number, ox: number, oz: number): void {
    const s = 1 << level;
    const off = (level === 0 ? 1 : s >> 1) + SKY_REACH * s;
    const sky = world.sky;
    const canopy = world.canopy;
    for (let j = 0; j < COLS; j++) {
      const z = oz - off + j * s;
      const zIn = z >= 0 && z < WORLD_Z;
      for (let k = 0; k < COLS; k++) {
        const x = ox - off + k * s;
        const c = k + j * COLS;
        if (zIn && x >= 0 && x < WORLD_X) {
          const w = x + z * WORLD_X;
          this.colSky[c] = sky[w];
          this.colCanopy[c] = canopy[w];
        } else {
          this.colSky[c] = 0;
          this.colCanopy[c] = 0;
        }
      }
    }
  }
}
