/**
 * Structural support analysis. OWNER: agent "interaction".
 * After voxels are removed, SUP.STRUCT voxels next to the removed cells are flood-filled
 * (6-neighbourhood through SUP.STRUCT / SUP.ANCHOR voxels only — foliage (SUP.LEAF), air, water and
 * plants never carry support and are never seeds); a component that reaches an ANCHOR voxel (or y = 0)
 * is supported. Searching lower voxels first (best-first by ascending y) finds anchors fast. A
 * component that is not supported and is ≤ GAMEPLAY.maxFallingBodyVoxels becomes a detached piece that
 * also takes the foliage reachable from its STRUCT voxels through foliage within 30 voxels (so a cut
 * tree falls with its crown but never drags a neighbour's crown). Foliage-only clumps never fall.
 * If a search exceeds the budget the component is assumed supported. Seeds sharing a component are deduped.
 *
 * Foliage ownership: a foliage voxel goes with the piece only if it is strictly closer (in steps through
 * foliage) to the piece's STRUCT voxels than to any other support — a STRUCT voxel outside the piece or an
 * ANCHOR voxel. So of two touching crowns each keeps its own leaves, and a bush next to a trunk stays put.
 *
 * Pure reads of a WorldData: the analysis runs in the felling worker (game/interaction/felling.ts), which also gets
 * the box of every voxel a call read (findDetached's `readBox`) to tell whether a later edit made its answer stale.
 */
import { CHUNK_BITS, CHUNK_COUNT, CHUNK_MASK, CHUNK_VOL, CHUNKS_X, CHUNKS_Z, GAMEPLAY, WORLD_Y } from '../config';
import { FOLIAGE, SUP, SUPPORT } from './blocks';
import type { WorldData } from './world';

export interface DetachedPiece {
  /** Voxel coordinates packed as triples [x0, y0, z0, x1, y1, z1, …]. */
  positions: Int32Array;
  /** Block ids, one per voxel. */
  ids: Uint8Array;
  count: number;
  min: [number, number, number];
  /** Exclusive. */
  max: [number, number, number];
}

/** Foliage at most this many steps (through foliage) from a piece's STRUCT voxels falls with the piece. */
export const FOLIAGE_REACH = 30;
/**
 * Foliage is scanned twice as deep as it can be taken: any rival support closer than the piece to a voxel
 * within FOLIAGE_REACH touches foliage within this depth, so ownership is decided correctly.
 */
const FOLIAGE_SCAN = 2 * FOLIAGE_REACH;

/** Packs in-world voxel coordinates into one non-negative int32: x | z << 11 | y << 22 (x, z < 2048, y < 512). */
export const packVoxel = (x: number, y: number, z: number): number => x | (z << 11) | (y << 22);
export const packedX = (p: number): number => p & 2047;
export const packedY = (p: number): number => p >>> 22;
export const packedZ = (p: number): number => (p >>> 11) & 2047;

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];

/**
 * `seeds`: removed voxel positions packed as triples. With `readBox` (x0, y0, z0 inclusive, x1, y1, z1 exclusive)
 * the call also reports a box containing every voxel it read from the world: an edit outside the box cannot
 * change the result (the felling worker's answers are checked against it).
 */
export function findDetached(
  world: WorldData,
  seeds: ArrayLike<number>,
  budget: number,
  maxPieceVoxels: number = GAMEPLAY.maxFallingBodyVoxels,
  readBox?: Int32Array,
): DetachedPiece[] {
  if (readBox !== undefined) seedBox(seeds, readBox);
  // Most removals (digging soil, rock) touch no STRUCT voxel at all: skip setting up the search state.
  if (!touchesStruct(world, seeds)) return [];
  analysis ??= new SupportAnalysis();
  return analysis.run(world, seeds, budget, maxPieceVoxels, readBox ?? null);
}

/** Search state shared by all calls: it keeps its capacity instead of regrowing (and becoming garbage) per felling. */
let analysis: SupportAnalysis | null = null;

/** True if a seed (packed triples) has a SUP.STRUCT neighbour: only then can the removal detach anything. */
export function touchesStruct(world: WorldData, seeds: ArrayLike<number>): boolean {
  const n = Math.floor(seeds.length / 3);
  for (let i = 0; i < n; i++) {
    const x = seeds[i * 3];
    const y = seeds[i * 3 + 1];
    const z = seeds[i * 3 + 2];
    for (let k = 0; k < 6; k++) {
      if (SUPPORT[world.getBlock(x + DX[k], y + DY[k], z + DZ[k])] === SUP.STRUCT) return true;
    }
  }
  return false;
}

/** Sets `box` to the seeds' bounds grown by one voxel (their neighbours are read), or to an empty box. */
function seedBox(seeds: ArrayLike<number>, box: Int32Array): void {
  box[0] = box[1] = box[2] = 0x7fffffff;
  box[3] = box[4] = box[5] = -0x7fffffff;
  const n = Math.floor(seeds.length / 3);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const c = seeds[i * 3 + a];
      if (c - 1 < box[a]) box[a] = c - 1;
      if (c + 2 > box[a + 3]) box[a + 3] = c + 2;
    }
  }
}

/** Grows `box` to contain packed voxels [from, list.length) of `list` and their neighbours. */
function growBox(box: Int32Array, list: IntList, from: number): void {
  if (from >= list.length) return;
  const data = list.data;
  let x0 = box[0];
  let y0 = box[1];
  let z0 = box[2];
  let x1 = box[3];
  let y1 = box[4];
  let z1 = box[5];
  for (let i = from; i < list.length; i++) {
    const p = data[i];
    const x = p & 2047;
    const y = p >>> 22;
    const z = (p >>> 11) & 2047;
    if (x - 1 < x0) x0 = x - 1;
    if (y - 1 < y0) y0 = y - 1;
    if (z - 1 < z0) z0 = z - 1;
    if (x + 2 > x1) x1 = x + 2;
    if (y + 2 > y1) y1 = y + 2;
    if (z + 2 > z1) z1 = z + 2;
  }
  box[0] = x0;
  box[1] = y0;
  box[2] = z0;
  box[3] = x1;
  box[4] = y1;
  box[5] = z1;
}

/** Growable int32 list, used as a stack or (with an external read cursor) as a FIFO queue. */
class IntList {
  data: Int32Array;
  length = 0;

  constructor(capacity: number) {
    this.data = new Int32Array(capacity);
  }

  push(v: number): void {
    if (this.length === this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = v;
  }
}

/**
 * Open-addressing hash map (linear probing) from packed voxels to non-negative int32 values; get() → -1 if absent.
 * clear() is O(1): slots written in an earlier generation read as empty, and the capacity is kept.
 */
class PackedMap {
  size = 0;
  private keys: Int32Array;
  private vals: Int32Array;
  /** Generation that wrote each slot; only slots of the current generation are in use. */
  private gens: Int32Array;
  private gen = 1;
  private shift: number;
  private mask: number;

  constructor(bits: number) {
    this.keys = new Int32Array(1 << bits);
    this.vals = new Int32Array(1 << bits);
    this.gens = new Int32Array(1 << bits);
    this.shift = 32 - bits;
    this.mask = (1 << bits) - 1;
  }

  get(key: number): number {
    const keys = this.keys;
    const gens = this.gens;
    const gen = this.gen;
    let i = Math.imul(key, 0x9e3779b1) >>> this.shift;
    while (gens[i] === gen) {
      if (keys[i] === key) return this.vals[i];
      i = (i + 1) & this.mask;
    }
    return -1;
  }

  set(key: number, value: number): void {
    if ((this.size + 1) * 2 > this.keys.length) this.rehash(33 - this.shift);
    const keys = this.keys;
    const gens = this.gens;
    const gen = this.gen;
    let i = Math.imul(key, 0x9e3779b1) >>> this.shift;
    while (gens[i] === gen) {
      if (keys[i] === key) {
        this.vals[i] = value;
        return;
      }
      i = (i + 1) & this.mask;
    }
    gens[i] = gen;
    keys[i] = key;
    this.vals[i] = value;
    this.size++;
  }

  clear(): void {
    this.gen++;
    this.size = 0;
  }

  private rehash(bits: number): void {
    const oldKeys = this.keys;
    const oldVals = this.vals;
    const oldGens = this.gens;
    const oldGen = this.gen;
    this.keys = new Int32Array(1 << bits);
    this.vals = new Int32Array(1 << bits);
    this.gens = new Int32Array(1 << bits);
    this.gen = 1;
    this.shift = 32 - bits;
    this.mask = (1 << bits) - 1;
    this.size = 0;
    for (let i = 0; i < oldKeys.length; i++) if (oldGens[i] === oldGen) this.set(oldKeys[i], oldVals[i]);
  }
}

/** Zeroed 32³ pages returned by VoxelBytes.clear(), shared by all stores. */
const sparePages: Uint8Array[] = [];
const PLANE = CHUNKS_X * CHUNKS_Z;

/**
 * Byte per voxel of the world (0 = absent) in 32³ pages, one per touched chunk (same key and index layout as the
 * world store). Neighbouring voxels share a page, so a flood fill stays in cache; clear() zeroes only the pages in
 * use and keeps them for later calls.
 */
class VoxelBytes {
  size = 0;
  private readonly pages = new Array<Uint8Array | null>(CHUNK_COUNT).fill(null);
  /** Keys of the pages in use. */
  private readonly used: number[] = [];

  /** Value of packed voxel p, 0 if absent. */
  get(p: number): number {
    const x = p & 2047;
    const y = p >>> 22;
    const z = (p >>> 11) & 2047;
    const page = this.pages[(x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + (y >> CHUNK_BITS) * PLANE];
    return page === null ? 0 : page[(x & CHUNK_MASK) | ((z & CHUNK_MASK) << CHUNK_BITS) | ((y & CHUNK_MASK) << (2 * CHUNK_BITS))];
  }

  /** Sets packed voxel p to `value` (1..255). */
  set(p: number, value: number): void {
    const x = p & 2047;
    const y = p >>> 22;
    const z = (p >>> 11) & 2047;
    const key = (x >> CHUNK_BITS) + (z >> CHUNK_BITS) * CHUNKS_X + (y >> CHUNK_BITS) * PLANE;
    let page = this.pages[key];
    if (page === null) {
      page = this.pages[key] = sparePages.pop() ?? new Uint8Array(CHUNK_VOL);
      this.used.push(key);
    }
    const i = (x & CHUNK_MASK) | ((z & CHUNK_MASK) << CHUNK_BITS) | ((y & CHUNK_MASK) << (2 * CHUNK_BITS));
    if (page[i] === 0) this.size++;
    page[i] = value;
  }

  clear(): void {
    for (const key of this.used) {
      const page = this.pages[key]!;
      page.fill(0);
      sparePages.push(page);
      this.pages[key] = null;
    }
    this.used.length = 0;
    this.size = 0;
  }
}

/** Priority queue of packed voxels by ascending y: one stack per level, pops come from the lowest level. */
class LevelQueue {
  size = 0;
  private readonly levels: (IntList | null)[] = new Array<IntList | null>(WORLD_Y).fill(null);
  private lowest = WORLD_Y;

  push(p: number): void {
    const y = p >>> 22;
    let level = this.levels[y];
    if (level === null) level = this.levels[y] = new IntList(64);
    level.push(p);
    if (y < this.lowest) this.lowest = y;
    this.size++;
  }

  /** Callers check `size > 0` first. */
  pop(): number {
    let level = this.levels[this.lowest];
    while (level === null || level.length === 0) level = this.levels[++this.lowest];
    this.size--;
    return level.data[--level.length];
  }

  clear(): void {
    for (const level of this.levels) if (level !== null) level.length = 0;
    this.lowest = WORLD_Y;
    this.size = 0;
  }
}

/**
 * Search state of a findDetached() call, shared by all its searches so seeds of one component are analysed once.
 * One instance serves every call; run() resets it.
 */
class SupportAnalysis {
  private world!: WorldData;
  private budget = 0;
  /** STRUCT voxel → id of the search that reached it. */
  private readonly owner = new PackedMap(12);
  /** Foliage voxels already given to a piece of this call (1). */
  private readonly taken = new VoxelBytes();
  /** Foliage voxel → steps from the current piece's STRUCT voxels. */
  private readonly reach = new VoxelBytes();
  /** Foliage voxel → steps from the nearest rival support. */
  private readonly rivalReach = new VoxelBytes();
  private readonly open = new LevelQueue();
  /** STRUCT voxels of the current search. */
  private readonly component = new IntList(1024);
  /** Foliage BFS from the piece: queue (component first, then foliage in BFS order) with parallel depths. */
  private readonly queue = new IntList(1024);
  private readonly depths = new IntList(1024);
  /** Foliage BFS from rivals. */
  private readonly rivalQueue = new IntList(64);
  private readonly rivalDepths = new IntList(64);
  /** Foliage the current piece takes along. */
  private readonly foliage = new IntList(1024);
  private searches = 0;

  /** `box` (findDetached's readBox, already holding the seeds' box): grown by every voxel the searches read. */
  run(world: WorldData, seeds: ArrayLike<number>, budget: number, maxVoxels: number, box: Int32Array | null): DetachedPiece[] {
    this.world = world;
    this.budget = budget;
    this.owner.clear();
    this.taken.clear();
    this.searches = 0;
    const pieces: DetachedPiece[] = [];
    const n = Math.floor(seeds.length / 3);
    for (let i = 0; i < n; i++) {
      const sx = seeds[i * 3];
      const sy = seeds[i * 3 + 1];
      const sz = seeds[i * 3 + 2];
      for (let k = 0; k < 6; k++) {
        const x = sx + DX[k];
        const y = sy + DY[k];
        const z = sz + DZ[k];
        if (SUPPORT[world.getBlock(x, y, z)] !== SUP.STRUCT) continue;
        const key = packVoxel(x, y, z);
        if (this.owner.get(key) !== -1) continue; // its component is already analysed
        const id = ++this.searches;
        const supported = this.supported(key, id);
        // A search reads the neighbours of the voxels it pushed (all of them in `component`), a foliage pass those
        // of its queues: the lists are scanned once afterwards instead of tracking the box in the hot loops.
        if (box !== null) growBox(box, this.component, 0);
        if (supported || this.component.length > maxVoxels) continue;
        this.gatherFoliage(id, maxVoxels - this.component.length);
        if (box !== null) {
          growBox(box, this.queue, this.component.length);
          growBox(box, this.rivalQueue, 0);
        }
        pieces.push(this.buildPiece());
      }
    }
    return pieces;
  }

  /**
   * Best-first flood fill (lowest y first) through STRUCT voxels from `start`. True as soon as an ANCHOR
   * voxel (bedrock below y = 0 included) or a voxel of an earlier search is reached, or the budget runs out;
   * false with the whole component in `component` otherwise.
   */
  private supported(start: number, id: number): boolean {
    const { world, owner, open, component } = this;
    open.clear();
    component.length = 0;
    owner.set(start, id);
    open.push(start);
    component.push(start);
    while (open.size > 0) {
      const p = open.pop();
      const x = p & 2047;
      const y = p >>> 22;
      const z = (p >>> 11) & 2047;
      for (let k = 0; k < 6; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        const nz = z + DZ[k];
        const support = SUPPORT[world.getBlock(nx, ny, nz)];
        if (support === SUP.ANCHOR) return true;
        if (support !== SUP.STRUCT) continue;
        const key = packVoxel(nx, ny, nz);
        const o = owner.get(key);
        if (o === id) continue;
        // An earlier search that ended unsupported explored its whole (closed) component, so reaching
        // another search's voxel means reaching a supported — or too large to tell — structure.
        if (o !== -1 || component.length >= this.budget) return true;
        owner.set(key, id);
        open.push(key);
        component.push(key);
      }
    }
    return false;
  }

  /**
   * Fills `foliage` with the foliage the current piece (search `id`) takes along, nearest first, at most `room`
   * voxels: reachable through foliage within FOLIAGE_REACH steps of its STRUCT voxels, strictly closer to them
   * than to any rival support, and not taken by an earlier piece of this call.
   */
  private gatherFoliage(id: number, room: number): void {
    const { world, owner, reach, rivalReach, queue, depths, rivalQueue, rivalDepths, component, foliage } = this;
    reach.clear();
    rivalReach.clear();
    queue.length = 0;
    depths.length = 0;
    rivalQueue.length = 0;
    rivalDepths.length = 0;
    foliage.length = 0;

    // Distances from the piece; foliage touching a rival is where rival distances start (1 step).
    for (let i = 0; i < component.length; i++) {
      queue.push(component.data[i]);
      depths.push(0);
    }
    for (let head = 0; head < queue.length; head++) {
      const p = queue.data[head];
      const d = depths.data[head];
      const x = p & 2047;
      const y = p >>> 22;
      const z = (p >>> 11) & 2047;
      let touchesRival = false;
      for (let k = 0; k < 6; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        const nz = z + DZ[k];
        const block = world.getBlock(nx, ny, nz);
        if (FOLIAGE[block] === 1) {
          if (d >= FOLIAGE_SCAN || reach.size >= this.budget) continue;
          const key = packVoxel(nx, ny, nz);
          if (reach.get(key) !== 0) continue;
          reach.set(key, d + 1);
          queue.push(key);
          depths.push(d + 1);
        } else if (d > 0) {
          const support = SUPPORT[block];
          if (support === SUP.ANCHOR || (support === SUP.STRUCT && owner.get(packVoxel(nx, ny, nz)) !== id)) touchesRival = true;
        }
      }
      if (touchesRival) {
        rivalReach.set(p, 1);
        rivalQueue.push(p);
        rivalDepths.push(1);
      }
    }

    // Distances from rivals, through any foliage (paths may leave the piece's scanned region).
    for (let head = 0; head < rivalQueue.length; head++) {
      const d = rivalDepths.data[head];
      if (d >= FOLIAGE_REACH) continue;
      const p = rivalQueue.data[head];
      const x = p & 2047;
      const y = p >>> 22;
      const z = (p >>> 11) & 2047;
      for (let k = 0; k < 6; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        const nz = z + DZ[k];
        if (FOLIAGE[world.getBlock(nx, ny, nz)] !== 1 || rivalReach.size >= this.budget) continue;
        const key = packVoxel(nx, ny, nz);
        if (rivalReach.get(key) !== 0) continue;
        rivalReach.set(key, d + 1);
        rivalQueue.push(key);
        rivalDepths.push(d + 1);
      }
    }

    // The queue holds foliage in non-decreasing depth order after the component.
    for (let i = component.length; i < queue.length && foliage.length < room; i++) {
      const d = depths.data[i];
      if (d > FOLIAGE_REACH) break;
      const p = queue.data[i];
      const rival = rivalReach.get(p);
      if ((rival !== 0 && rival <= d) || this.taken.get(p) !== 0) continue;
      this.taken.set(p, 1);
      foliage.push(p);
    }
  }

  private buildPiece(): DetachedPiece {
    const { component, foliage } = this;
    const count = component.length + foliage.length;
    const piece: DetachedPiece = {
      positions: new Int32Array(count * 3),
      ids: new Uint8Array(count),
      count,
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    this.write(piece, component, 0);
    this.write(piece, foliage, component.length);
    return piece;
  }

  private write(piece: DetachedPiece, list: IntList, offset: number): void {
    const { positions, ids, min, max } = piece;
    for (let i = 0; i < list.length; i++) {
      const p = list.data[i];
      const x = p & 2047;
      const y = p >>> 22;
      const z = (p >>> 11) & 2047;
      const j = offset + i;
      positions[j * 3] = x;
      positions[j * 3 + 1] = y;
      positions[j * 3 + 2] = z;
      ids[j] = this.world.getBlock(x, y, z);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x + 1 > max[0]) max[0] = x + 1;
      if (y + 1 > max[1]) max[1] = y + 1;
      if (z + 1 > max[2]) max[2] = z + 1;
    }
  }
}
