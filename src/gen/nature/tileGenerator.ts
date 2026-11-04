/**
 * Generates one GEN_TILE × GEN_TILE tile over the full world height. OWNER: agent "worldgen".
 * Used by the generation workers (one instance per worker, buffers reused for every tile) and
 * directly by tests/benchmarks. Pipeline (ARCHITECTURE.md §5.1): terrain columns → overlapping
 * features in (order, index) order through the clipping writer → surface decoration → sky/canopy
 * heights → chunk extraction with uniform detection.
 */
import { CHUNK, CHUNK_VOL, GEN_TILE, GEN_TILES_X, GEN_TILES_Z, WORLD_Y } from '../../config';
import { OPAQUE, SKY_OPAQUE } from '../../world/blocks';
import { createWorldPlan } from '../plan';
import { createColumnSample, createNaturalTerrain, decorateColumn, fillColumn, type NaturalTerrain } from '../terrain';
import type { ColumnSample, GenContext, WorldPlan } from '../types';
import { FeatureIndex } from './featureIndex';
import { TileWriter } from './tileWriter';

/** Chunks per tile along x and z (4) and along y (16). */
export const TILE_CHUNKS = GEN_TILE / CHUNK;
export const TILE_LAYERS = WORLD_Y / CHUNK;
export const CHUNKS_PER_TILE = TILE_CHUNKS * TILE_CHUNKS * TILE_LAYERS;

// The per-voxel loops of the extraction use these module constants and local aliases of imported
// tables: some module loaders (vitest's, for one) read imported bindings through getters.
/** Tile buffer strides (column-major, see TileWriter): +1 per voxel up, COLUMN per x, ROW per z. */
const COLUMN = WORLD_Y;
const ROW = GEN_TILE * WORLD_Y;
/** Chunk edge, and the stride of y in chunk order (x + z·32 + y·1024). */
const EDGE = CHUNK;
const LAYER = CHUNK * CHUNK;
/** 32-bit words in one column run of a chunk. */
const RUN_WORDS = CHUNK >> 2;

export interface TileResult {
  tx: number;
  tz: number;
  /**
   * Local chunk (cx, cy, cz) — cx, cz in 0..TILE_CHUNKS, cy in 0..TILE_LAYERS — at index
   * cx + cz·TILE_CHUNKS + cy·TILE_CHUNKS²: its block id when uniform, else its voxels (index x + z·32 + y·1024).
   */
  chunks: (number | Uint8Array)[];
  /** Per column (index lx + lz·GEN_TILE): first voxel above the topmost SKY_OPAQUE voxel, 0 = none. */
  sky: Int16Array;
  /** Per column: first voxel above the topmost OPAQUE voxel including foliage, 0 = none. */
  canopy: Int16Array;
}

export class TileGenerator {
  readonly terrain: NaturalTerrain;
  readonly plan: WorldPlan;
  readonly writer = new TileWriter();
  private readonly index: FeatureIndex;
  private readonly ctx: GenContext;
  private readonly columns: ColumnSample[] = [];
  private readonly words: Uint32Array;
  private tx = 0;
  private tz = 0;
  /** Exclusive upper bound of everything written into the current tile. */
  private topY = 0;

  /** `plan` defaults to createWorldPlan(seed); pass one to reuse an existing plan. */
  constructor(readonly seed: number, plan?: WorldPlan) {
    this.terrain = createNaturalTerrain(seed);
    this.plan = plan ?? createWorldPlan(seed);
    this.index = new FeatureIndex(this.plan.features);
    this.ctx = { seed, terrain: this.terrain };
    for (let i = 0; i < GEN_TILE * GEN_TILE; i++) this.columns.push(createColumnSample());
    const d = this.writer.data;
    this.words = new Uint32Array(d.buffer, d.byteOffset, d.byteLength >> 2);
  }

  /** Generates tile (tx, tz) and returns freshly allocated (transferable) result arrays. */
  generate(tx: number, tz: number): TileResult {
    this.begin(tx, tz);
    this.fillTerrain();
    this.stampFeatures();
    this.decorate();
    return this.extract();
  }

  /** Step 1: move the window to tile (tx, tz) and clear it. */
  begin(tx: number, tz: number): void {
    if (!Number.isInteger(tx) || !Number.isInteger(tz) || tx < 0 || tz < 0 || tx >= GEN_TILES_X || tz >= GEN_TILES_Z) {
      throw new RangeError(`tile ${tx},${tz} is outside the ${GEN_TILES_X}×${GEN_TILES_Z} world`);
    }
    this.tx = tx;
    this.tz = tz;
    this.topY = 0;
    this.writer.reset(tx * GEN_TILE, tz * GEN_TILE);
  }

  /** Step 2: natural terrain for every column. */
  fillTerrain(): void {
    const w = this.writer;
    this.terrain.sampleArea(w.x0, w.z0, GEN_TILE, GEN_TILE, this.columns);
    let top = 0;
    for (let lz = 0; lz < GEN_TILE; lz++) {
      for (let lx = 0; lx < GEN_TILE; lx++) {
        const s = this.columns[lx + lz * GEN_TILE];
        fillColumn(w, this.terrain, w.x0 + lx, w.z0 + lz, s);
        top = Math.max(top, s.surfaceY + 1, s.waterY + 1); // +1: plants on top
      }
    }
    this.topY = Math.max(this.topY, top);
  }

  /** Step 3: every feature overlapping the tile, in (order, index) order, clipped by the writer. */
  stampFeatures(): void {
    const list = this.index.featuresIn(this.tx, this.tz);
    const features = this.plan.features;
    for (let i = 0; i < list.length; i++) {
      const f = features[list[i]];
      f.stamp(this.writer, this.ctx);
      if (f.max[1] > this.topY) this.topY = f.max[1];
    }
  }

  /** Step 4: plants on the final surface. */
  decorate(): void {
    const w = this.writer;
    for (let lz = 0; lz < GEN_TILE; lz++) {
      for (let lx = 0; lx < GEN_TILE; lx++) decorateColumn(w, this.terrain, w.x0 + lx, w.z0 + lz, this.columns[lx + lz * GEN_TILE]);
    }
  }

  /** Step 5: sky/canopy heights and chunk extraction (uniform chunks as ids). */
  extract(): TileResult {
    const data = this.writer.data;
    const opaque = OPAQUE;
    const skyOpaque = SKY_OPAQUE;
    const sky = new Int16Array(GEN_TILE * GEN_TILE);
    const canopy = new Int16Array(GEN_TILE * GEN_TILE);
    const top = Math.min(WORLD_Y, this.topY);
    for (let col = 0; col < sky.length; col++) {
      const base = col * COLUMN;
      let y = top - 1;
      while (y >= 0 && opaque[data[base + y]] === 0) y--;
      canopy[col] = y + 1;
      while (y >= 0 && skyOpaque[data[base + y]] === 0) y--;
      sky[col] = y + 1;
    }
    const chunks: (number | Uint8Array)[] = new Array(CHUNKS_PER_TILE);
    for (let cy = 0; cy < TILE_LAYERS; cy++) {
      for (let cz = 0; cz < TILE_CHUNKS; cz++) {
        for (let cx = 0; cx < TILE_CHUNKS; cx++) {
          const u = this.uniformId(cx, cy, cz);
          chunks[cx + cz * TILE_CHUNKS + cy * TILE_CHUNKS * TILE_CHUNKS] = u >= 0 ? u : this.copyChunk(cx, cy, cz);
        }
      }
    }
    return { tx: this.tx, tz: this.tz, chunks, sky, canopy };
  }

  /** Block id if local chunk (cx, cy, cz) is a single block type, else -1 (compares 4 bytes at a time). */
  private uniformId(cx: number, cy: number, cz: number): number {
    const words = this.words;
    const origin = cx * EDGE * COLUMN + cz * EDGE * ROW + cy * EDGE;
    const first = this.writer.data[origin];
    const pattern = Math.imul(first, 0x01010101) >>> 0;
    for (let lz = 0; lz < EDGE; lz++) {
      for (let lx = 0; lx < EDGE; lx++) {
        const w0 = (origin + lx * COLUMN + lz * ROW) >> 2;
        for (let k = w0; k < w0 + RUN_WORDS; k++) if (words[k] !== pattern) return -1;
      }
    }
    return first;
  }

  /** Copies local chunk (cx, cy, cz) into a new array in chunk order (x + z·32 + y·1024). */
  private copyChunk(cx: number, cy: number, cz: number): Uint8Array {
    const data = this.writer.data;
    const out = new Uint8Array(CHUNK_VOL);
    const origin = cx * EDGE * COLUMN + cz * EDGE * ROW + cy * EDGE;
    for (let lz = 0; lz < EDGE; lz++) {
      for (let lx = 0; lx < EDGE; lx++) {
        const src = origin + lx * COLUMN + lz * ROW;
        let dst = lx + lz * EDGE;
        for (let ly = 0; ly < EDGE; ly++, dst += LAYER) out[dst] = data[src + ly];
      }
    }
    return out;
  }
}
