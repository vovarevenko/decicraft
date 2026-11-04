/**
 * Voxel world storage, shared between the main thread and workers via SharedArrayBuffer.
 *
 * Layout:
 *  - `table` (Int32 per chunk): ≥ 0 → slot index of a full 32³ Uint8 array; < 0 → the whole chunk is
 *    one block id (-1 - value). Most chunks (deep stone, open air) are uniform and cost 4 bytes.
 *  - `segments`: big SharedArrayBuffers holding SEGMENT_CHUNKS chunk arrays each.
 *  - `sky` (Int16 per column): y of the first voxel above the topmost SKY_OPAQUE voxel (terrain, walls,
 *    roofs — not foliage or tree bark); 0 = none.
 *  - `canopy` (Int16 per column): y of the first voxel above the topmost OPAQUE voxel including foliage
 *    and bark (so canopy ≥ sky). Together they drive the mesher's skylight term (indoor darkening, canopy
 *    shade).
 * Below y = 0 the world is virtual bedrock: getBlock returns BEDROCK, setBlock rejects it.
 *
 * `WorldData` is the read-only view (usable in workers). `World` adds mutation, dirty tracking
 * and change notifications and must only be used on the main thread (single writer).
 */
import {
  CHUNK_BITS,
  CHUNK_COUNT,
  CHUNK_MASK,
  CHUNK_VOL,
  CHUNKS_X,
  CHUNKS_Y,
  CHUNKS_Z,
  WORLD_X,
  WORLD_Y,
  WORLD_Z,
} from '../config';
import { B, OPAQUE, SKY_OPAQUE, SOLID } from './blocks';

/** Chunk arrays per shared segment (32 MB per segment). */
export const SEGMENT_CHUNKS = 1024;
const SEG_SHIFT = 10;
const SEG_MASK = SEGMENT_CHUNKS - 1;
const VOL_SHIFT = 15; // log2(CHUNK_VOL)
const PLANE = CHUNKS_X * CHUNKS_Z;
/** Skylight of a vertex depends on sky heights up to this many voxels above it (mesher falloff). */
const SKY_FALLOFF = 37;

/** Chunk key = cx + cz·CHUNKS_X + cy·CHUNKS_X·CHUNKS_Z. */
export const chunkKey = (cx: number, cy: number, cz: number): number => cx + cz * CHUNKS_X + cy * PLANE;
/** Key of the chunk containing voxel (x, y, z) — caller guarantees in-bounds integer coords. */
export const chunkKeyAt = (x: number, y: number, z: number): number =>
  (x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + (y >> CHUNK_BITS) * PLANE;

export function chunkCoords(key: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const cy = Math.floor(key / PLANE);
  const r = key - cy * PLANE;
  const cz = Math.floor(r / CHUNKS_X);
  out[0] = r - cz * CHUNKS_X;
  out[1] = cy;
  out[2] = cz;
  return out;
}

/** Index of local voxel (lx, ly, lz) inside a chunk array: x + z·32 + y·1024 (horizontal slices are contiguous). */
export const localIndex = (lx: number, ly: number, lz: number): number =>
  lx | (lz << CHUNK_BITS) | (ly << (2 * CHUNK_BITS));

export interface WorldShared {
  table: SharedArrayBuffer;
  segments: SharedArrayBuffer[];
  sky: SharedArrayBuffer;
  canopy: SharedArrayBuffer;
}

export class WorldData {
  readonly table: Int32Array;
  readonly sky: Int16Array;
  readonly canopy: Int16Array;
  readonly segments: Uint8Array[] = [];
  protected readonly tableBuffer: SharedArrayBuffer;
  protected readonly skyBuffer: SharedArrayBuffer;
  protected readonly canopyBuffer: SharedArrayBuffer;
  protected readonly segmentBuffers: SharedArrayBuffer[] = [];

  constructor(shared: WorldShared) {
    this.tableBuffer = shared.table;
    this.skyBuffer = shared.sky;
    this.canopyBuffer = shared.canopy;
    this.table = new Int32Array(shared.table);
    this.sky = new Int16Array(shared.sky);
    this.canopy = new Int16Array(shared.canopy);
    shared.segments.forEach((s, i) => this.attachSegment(s, i));
  }

  /** Registers a segment (workers receive new segments from the main thread in order). */
  attachSegment(sab: SharedArrayBuffer, index = this.segments.length): void {
    this.segmentBuffers[index] = sab;
    this.segments[index] = new Uint8Array(sab);
  }

  /** Snapshot of the shared buffers, for posting to a worker. */
  toShared(): WorldShared {
    return { table: this.tableBuffer, segments: this.segmentBuffers.slice(), sky: this.skyBuffer, canopy: this.canopyBuffer };
  }

  /**
   * Block id at integer voxel coords. Below the world → BEDROCK, above / outside horizontally → AIR.
   * Non-negative floats are floored implicitly. A chunk whose segment has not reached this worker yet
   * reads as AIR (the result is stale anyway and will be redone).
   */
  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= WORLD_Y || x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return B.AIR;
    const v = this.table[(x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + (y >> CHUNK_BITS) * PLANE];
    if (v < 0) return -1 - v;
    const seg = this.segments[v >> SEG_SHIFT];
    if (seg === undefined) return B.AIR;
    return seg[((v & SEG_MASK) << VOL_SHIFT) | (x & CHUNK_MASK) | ((z & CHUNK_MASK) << CHUNK_BITS) | ((y & CHUNK_MASK) << (2 * CHUNK_BITS))];
  }

  isSolidAt(x: number, y: number, z: number): boolean {
    return SOLID[this.getBlock(x, y, z)] === 1;
  }

  /** The chunk's own voxel array (a view into shared memory, index = localIndex) or null if uniform / not attached. */
  chunkArray(key: number): Uint8Array | null {
    const v = this.table[key];
    if (v < 0) return null;
    const seg = this.segments[v >> SEG_SHIFT];
    if (seg === undefined) return null;
    const off = (v & SEG_MASK) << VOL_SHIFT;
    return seg.subarray(off, off + CHUNK_VOL);
  }

  /** Uniform block id of the chunk, or -1 if it has its own array. */
  chunkUniform(key: number): number {
    const v = this.table[key];
    return v < 0 ? -1 - v : -1;
  }

  /** y of the first voxel above the topmost SKY_OPAQUE (roof) voxel of column (x, z); 0 if none / out of bounds. */
  skyHeight(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
    return this.sky[x + z * WORLD_X];
  }

  /** y of the first voxel above the topmost opaque voxel incl. foliage of column (x, z); 0 if none / out of bounds. */
  canopyHeight(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
    return this.canopy[x + z * WORLD_X];
  }

  /** y + 1 of the topmost SOLID voxel in column (x, z); 0 if the column has none. Roofs count — prefer floorBelow(). */
  topSolidY(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= WORLD_X || z >= WORLD_Z) return 0;
    for (let cy = CHUNKS_Y - 1; cy >= 0; cy--) {
      const v = this.table[(x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + cy * PLANE];
      if (v < 0) {
        if (SOLID[-1 - v]) return (cy + 1) << CHUNK_BITS;
        continue;
      }
      for (let ly = CHUNK_MASK; ly >= 0; ly--) {
        const y = (cy << CHUNK_BITS) | ly;
        if (SOLID[this.getBlock(x, y, z)]) return y + 1;
      }
    }
    return 0;
  }

  /**
   * Floor under an intended position: from (x, y, z) first steps up out of SOLID voxels (≤ 20), then
   * scans down (≤ maxDown) to the first SOLID voxel and returns the y just above it (where something
   * standing there has its feet). Returns the start y (after stepping up) if no floor was found.
   * Use this — not topSolidY — to place items/mobs inside buildings or under trees.
   */
  floorBelow(x: number, y: number, z: number, maxDown = 64): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    let yi = Math.floor(y);
    for (let i = 0; i < 20 && SOLID[this.getBlock(xi, yi, zi)]; i++) yi++;
    for (let d = 0; d <= maxDown; d++) {
      if (SOLID[this.getBlock(xi, yi - d - 1, zi)]) return yi - d;
    }
    return yi;
  }
}

export type ChangeListener = (dirtyChunks: ReadonlySet<number>) => void;

/** Main-thread world: the single writer. */
export class World extends WorldData {
  /**
   * Bumped whenever a chunk's mesh inputs change: an edit inside it, an edit of a neighbouring voxel
   * across its border (faces/AO), or a skylight change affecting it. Node-level staleness of async
   * meshes is tracked by the renderer itself (see ChunkRenderer).
   */
  readonly chunkVersion = new Uint32Array(CHUNK_COUNT);
  private nextSlot = 0;
  private dirty = new Set<number>();
  /** setBlocks scratch: chunks to mark (1), listed in `bulkKeys`, and per column 1 + its index in `bulkColumns` (0 = untouched). */
  private readonly bulkMarks = new Uint8Array(CHUNK_COUNT);
  /** setBlocks scratch: the keys whose `bulkMarks` byte is set, the first `bulkKeyCount` entries (each key once). */
  private readonly bulkKeys = new Int32Array(CHUNK_COUNT);
  private bulkKeyCount = 0;
  private bulkColumnSlot: Int32Array | null = null;
  /** setBlocks scratch: touched columns as (column, highest changed y, flags: 1 sky, 2 canopy) triples. */
  private bulkColumns = new Int32Array(3 * 1024);
  /** While recordMarks runs its write: the set every chunk marked dirty is added to. */
  private recording: Set<number> | null = null;
  private readonly segmentListeners: ((sab: SharedArrayBuffer, index: number) => void)[] = [];
  private readonly changeListeners: ChangeListener[] = [];

  static create(): World {
    const table = new SharedArrayBuffer(CHUNK_COUNT * 4);
    new Int32Array(table).fill(-1); // every chunk = uniform AIR
    const sky = new SharedArrayBuffer(WORLD_X * WORLD_Z * 2);
    const canopy = new SharedArrayBuffer(WORLD_X * WORLD_Z * 2);
    return new World({ table, segments: [], sky, canopy });
  }

  /** Number of non-uniform chunks allocated so far. */
  get allocatedChunks(): number {
    return this.nextSlot;
  }

  /** Called whenever a new shared segment is created (forward it to workers before posting new jobs). */
  onSegmentAdded(fn: (sab: SharedArrayBuffer, index: number) => void): void {
    this.segmentListeners.push(fn);
  }

  /**
   * Called from `flush()` with the keys of every chunk whose meshes may have changed: the edited
   * chunk, neighbours touching an edited border voxel (faces/AO), and chunks whose skylight changed.
   * Listeners must consume the set synchronously.
   */
  onChange(fn: ChangeListener): void {
    this.changeListeners.push(fn);
  }

  /** Generation phase: stores a generated chunk (array is copied) or a uniform id. Does not mark dirty. */
  loadChunk(key: number, data: Uint8Array | number): void {
    if (typeof data === 'number') {
      this.table[key] = -1 - data;
      return;
    }
    const slot = this.table[key] >= 0 ? this.table[key] : this.allocChunk(key, 0);
    const off = (slot & SEG_MASK) << VOL_SHIFT;
    this.segments[slot >> SEG_SHIFT].set(data, off);
  }

  /** Generation phase: copies a w×d rectangle of sky and canopy heights (row-major, index lx + lz·w). */
  loadSky(x0: number, z0: number, w: number, d: number, sky: Int16Array, canopy: Int16Array): void {
    for (let lz = 0; lz < d; lz++) {
      const dst = x0 + (z0 + lz) * WORLD_X;
      this.sky.set(sky.subarray(lz * w, lz * w + w), dst);
      this.canopy.set(canopy.subarray(lz * w, lz * w + w), dst);
    }
  }

  /**
   * Sets one voxel. Returns false if out of bounds or unchanged. Marks dirty chunks and keeps the
   * sky/canopy maps up to date. Changes are reported to listeners on the next `flush()`.
   */
  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return false;
    x |= 0;
    y |= 0;
    z |= 0;
    const key = (x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + (y >> CHUNK_BITS) * PLANE;
    let v = this.table[key];
    if (v < 0) {
      if (-1 - v === id) return false;
      v = this.allocChunk(key, -1 - v);
    }
    const seg = this.segments[v >> SEG_SHIFT];
    const idx =
      ((v & SEG_MASK) << VOL_SHIFT) | (x & CHUNK_MASK) | ((z & CHUNK_MASK) << CHUNK_BITS) | ((y & CHUNK_MASK) << (2 * CHUNK_BITS));
    const old = seg[idx];
    if (old === id) return false;
    seg[idx] = id;
    this.markAround(x, y, z, null);
    if (SKY_OPAQUE[old] !== SKY_OPAQUE[id]) this.updateColumnMap(this.sky, SKY_OPAQUE, x, y, z, id, SKY_FALLOFF);
    if (OPAQUE[old] !== OPAQUE[id]) this.updateColumnMap(this.canopy, OPAQUE, x, y, z, id, 1);
    return true;
  }

  /**
   * Bulk setBlock: voxel i ∈ [start, end) at (positions[3i], positions[3i + 1], positions[3i + 2]) becomes
   * ids[i] (or `ids` for all). Same end state as calling setBlock for each, but chunks are marked dirty once
   * and the sky/canopy maps are recomputed once per touched column — use it for thousands of voxels
   * (felled trees, landing pieces); it costs O(voxels + marked chunks), so a few voxels are cheap too.
   * Returns the number of voxels that changed.
   */
  setBlocks(positions: ArrayLike<number>, ids: ArrayLike<number> | number, end: number, start = 0): number {
    const marks = this.bulkMarks;
    const slots = (this.bulkColumnSlot ??= new Int32Array(WORLD_X * WORLD_Z));
    let columns = this.bulkColumns;
    let touched = 0;
    let changed = 0;
    for (let i = start; i < end; i++) {
      const x = positions[i * 3] | 0;
      const y = positions[i * 3 + 1] | 0;
      const z = positions[i * 3 + 2] | 0;
      if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) continue;
      const id = typeof ids === 'number' ? ids : ids[i];
      const key = (x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + (y >> CHUNK_BITS) * PLANE;
      let v = this.table[key];
      if (v < 0) {
        if (-1 - v === id) continue;
        v = this.allocChunk(key, -1 - v);
      }
      const seg = this.segments[v >> SEG_SHIFT];
      const idx =
        ((v & SEG_MASK) << VOL_SHIFT) | (x & CHUNK_MASK) | ((z & CHUNK_MASK) << CHUNK_BITS) | ((y & CHUNK_MASK) << (2 * CHUNK_BITS));
      const old = seg[idx];
      if (old === id) continue;
      seg[idx] = id;
      changed++;
      this.markAround(x, y, z, marks);
      const flags = (SKY_OPAQUE[old] !== SKY_OPAQUE[id] ? 1 : 0) | (OPAQUE[old] !== OPAQUE[id] ? 2 : 0);
      if (flags === 0) continue;
      const col = x + z * WORLD_X;
      let slot = slots[col] - 1;
      if (slot < 0) {
        if (3 * touched === columns.length) {
          const grown = new Int32Array(columns.length * 2);
          grown.set(columns);
          columns = this.bulkColumns = grown;
        }
        slot = touched++;
        slots[col] = slot + 1;
        columns[3 * slot] = col;
        columns[3 * slot + 1] = y;
        columns[3 * slot + 2] = flags;
      } else {
        if (y > columns[3 * slot + 1]) columns[3 * slot + 1] = y;
        columns[3 * slot + 2] |= flags;
      }
    }
    for (let s = 0; s < touched; s++) {
      const col = columns[3 * s];
      slots[col] = 0;
      const x = col % WORLD_X;
      const z = (col - x) / WORLD_X;
      const top = columns[3 * s + 1];
      const flags = columns[3 * s + 2];
      if (flags & 1) this.rescanColumnMap(this.sky, SKY_OPAQUE, x, z, top, SKY_FALLOFF, marks);
      if (flags & 2) this.rescanColumnMap(this.canopy, OPAQUE, x, z, top, 1, marks);
    }
    // Only the listed keys: a few voxels (an axe swing) cost a few marks, not a pass over every chunk.
    const keys = this.bulkKeys;
    for (let k = 0; k < this.bulkKeyCount; k++) {
      const key = keys[k];
      marks[key] = 0;
      this.mark(key);
    }
    this.bulkKeyCount = 0;
    return changed;
  }

  /**
   * Runs `write` (setBlock / setBlocks calls) and adds every chunk it marks dirty to `into`: the chunks it edits, the
   * neighbours across the borders it touches and the chunks whose skylight it changes — exactly what the next flush()
   * reports for it. A FallingBody holds back the meshes of all of them while it writes in slices (ChunkRenderer.holdMeshes).
   */
  recordMarks(into: Set<number>, write: () => void): void {
    const outer = this.recording;
    this.recording = into;
    try {
      write();
    } finally {
      this.recording = outer;
    }
  }

  /** Reports accumulated dirty chunks to listeners. The game loop calls this once per frame. */
  flush(): void {
    if (this.dirty.size === 0) return;
    const set = this.dirty;
    this.dirty = new Set();
    for (const fn of this.changeListeners) fn(set);
  }

  private mark(key: number): void {
    this.dirty.add(key);
    this.chunkVersion[key]++;
    this.recording?.add(key);
  }

  private allocChunk(key: number, fill: number): number {
    const slot = this.nextSlot++;
    const segIndex = slot >> SEG_SHIFT;
    if (segIndex >= this.segments.length) {
      const sab = new SharedArrayBuffer(SEGMENT_CHUNKS * CHUNK_VOL);
      this.attachSegment(sab, segIndex);
      for (const fn of this.segmentListeners) fn(sab, segIndex);
    }
    if (fill !== 0) {
      const off = (slot & SEG_MASK) << VOL_SHIFT;
      this.segments[segIndex].fill(fill, off, off + CHUNK_VOL);
    }
    this.table[key] = slot; // publish after the array is filled (workers may read concurrently)
    return slot;
  }

  /** Marks the voxel's chunk and the neighbours across any border it touches — now, or into `marks` (setBlocks). */
  private markAround(x: number, y: number, z: number, marks: Uint8Array | null): void {
    const cx = x >> CHUNK_BITS;
    const cy = y >> CHUNK_BITS;
    const cz = z >> CHUNK_BITS;
    const lx = x & CHUNK_MASK;
    const ly = y & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    const x0 = lx === 0 ? -1 : 0;
    const x1 = lx === CHUNK_MASK ? 1 : 0;
    const y0 = ly === 0 ? -1 : 0;
    const y1 = ly === CHUNK_MASK ? 1 : 0;
    const z0 = lz === 0 ? -1 : 0;
    const z1 = lz === CHUNK_MASK ? 1 : 0;
    for (let dy = y0; dy <= y1; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= CHUNKS_Y) continue;
      for (let dz = z0; dz <= z1; dz++) {
        const nz = cz + dz;
        if (nz < 0 || nz >= CHUNKS_Z) continue;
        for (let dx = x0; dx <= x1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= CHUNKS_X) continue;
          const key = nx + nz * CHUNKS_X + ny * PLANE;
          if (marks === null) this.mark(key);
          else if (marks[key] === 0) this.bulkMark(marks, key);
        }
      }
    }
  }

  /** setBlocks: sets key's `marks` byte and lists the key, for marking at the end of the call. */
  private bulkMark(marks: Uint8Array, key: number): void {
    marks[key] = 1;
    this.bulkKeys[this.bulkKeyCount++] = key;
  }

  /**
   * Keeps a column height map (sky: SKY_OPAQUE, canopy: OPAQUE) current after voxel (x, y, z) became `id`.
   * Skylight of a vertex may depend on the maps of columns within ±2 and on heights up to `below` voxels
   * above it, so those chunks are marked dirty.
   */
  private updateColumnMap(map: Int16Array, table: Uint8Array, x: number, y: number, z: number, id: number, below: number): void {
    const col = x + z * WORLD_X;
    const s = map[col];
    let ns = s;
    if (table[id]) {
      if (y >= s) ns = y + 1;
    } else if (y === s - 1) {
      ns = this.topIn(table, x, y - 1, z) + 1;
    }
    if (ns === s) return;
    map[col] = ns;
    this.markColumnChange(x, z, s, ns, below, null);
  }

  /**
   * setBlocks: recomputes a column height map after any voxels of the column changed, the highest at `top`.
   * Nothing above max(old height − 1, top) changed, so the scan starts there.
   */
  private rescanColumnMap(map: Int16Array, table: Uint8Array, x: number, z: number, top: number, below: number, marks: Uint8Array): void {
    const col = x + z * WORLD_X;
    const s = map[col];
    const ns = this.topIn(table, x, Math.max(s - 1, top), z) + 1;
    if (ns === s) return;
    map[col] = ns;
    this.markColumnChange(x, z, s, ns, below, marks);
  }

  /**
   * Highest y' ≤ y of column (x, z) whose block is set in `table`, or -1. Uniform chunks are skipped whole,
   * the others are scanned in their own array (felled crowns leave tall columns of non-uniform air).
   */
  private topIn(table: Uint8Array, x: number, y: number, z: number): number {
    const base = (x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X;
    const local = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << CHUNK_BITS);
    while (y >= 0) {
      const cy = y >> CHUNK_BITS;
      const v = this.table[base + cy * PLANE];
      if (v < 0) {
        if (table[-1 - v]) return y;
      } else {
        const seg = this.segments[v >> SEG_SHIFT];
        const off = ((v & SEG_MASK) << VOL_SHIFT) | local;
        for (let ly = y & CHUNK_MASK; ly >= 0; ly--) {
          if (table[seg[off | (ly << (2 * CHUNK_BITS))]]) return (cy << CHUNK_BITS) | ly;
        }
      }
      y = (cy << CHUNK_BITS) - 1;
    }
    return -1;
  }

  /**
   * Marks the chunks whose skylight may depend on column (x, z) after its height went from s to ns. Wall faces
   * also sample columns a few voxels in front of them (up to 6), which may lie in the next chunk: that is still
   * enough, because ChunkRenderer re-meshes every node whose 1-cell padding touches a marked chunk.
   */
  private markColumnChange(x: number, z: number, s: number, ns: number, below: number, marks: Uint8Array | null): void {
    const cyLo = Math.max(0, (Math.min(s, ns) - below) >> CHUNK_BITS);
    const cyHi = Math.min(CHUNKS_Y - 1, (Math.max(s, ns) + 1) >> CHUNK_BITS);
    const cxLo = Math.max(0, (x - 2) >> CHUNK_BITS);
    const cxHi = Math.min(CHUNKS_X - 1, (x + 2) >> CHUNK_BITS);
    const czLo = Math.max(0, (z - 2) >> CHUNK_BITS);
    const czHi = Math.min(CHUNKS_Z - 1, (z + 2) >> CHUNK_BITS);
    for (let cy = cyLo; cy <= cyHi; cy++) {
      for (let cz = czLo; cz <= czHi; cz++) {
        for (let cx = cxLo; cx <= cxHi; cx++) {
          const key = cx + cz * CHUNKS_X + cy * PLANE;
          if (marks === null) this.mark(key);
          else if (marks[key] === 0) this.bulkMark(marks, key);
        }
      }
    }
  }
}
