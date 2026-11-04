/**
 * Voxel sets shared by the interaction helpers: removed voxels, flooded cells, re-voxelised pieces — and their chunk
 * order, in which big writes go chunk by chunk (sortByChunk) and can be split on chunk boundaries (sliceEnd).
 * OWNER: agent "interaction".
 */
import { CHUNK_BITS, CHUNK_COUNT, CHUNKS_X, CHUNKS_Y } from '../../config';
import { chunkKeyAt } from '../../world/world';

/** Voxels as packed xyz triples plus one block id each — the shape of DetachedPiece and VoxelList. */
export interface VoxelSet {
  readonly positions: ArrayLike<number>;
  readonly ids: ArrayLike<number>;
  readonly count: number;
}

/** Growable voxel list, meant to be kept and reused (clear()) instead of reallocated. */
export class VoxelList implements VoxelSet {
  positions: Int32Array;
  ids: Uint8Array;
  count = 0;

  constructor(capacity = 256) {
    const cap = Math.max(4, capacity | 0);
    this.positions = new Int32Array(cap * 3);
    this.ids = new Uint8Array(cap);
  }

  /** The list held by another list's arrays (e.g. transferred from a worker), without copying them. */
  static wrap(positions: Int32Array, ids: Uint8Array, count: number): VoxelList {
    const list = new VoxelList(0);
    list.positions = positions;
    list.ids = ids;
    list.count = count;
    return list;
  }

  clear(): void {
    this.count = 0;
  }

  push(x: number, y: number, z: number, id: number): void {
    if (this.count === this.ids.length) this.grow();
    const i = this.count++;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.ids[i] = id;
  }

  /** View of the used part of `positions` (for APIs that take packed triples). */
  triples(): Int32Array {
    return this.positions.subarray(0, this.count * 3);
  }

  private grow(): void {
    const positions = new Int32Array(this.positions.length * 2);
    positions.set(this.positions);
    const ids = new Uint8Array(this.ids.length * 2);
    ids.set(this.ids);
    this.positions = positions;
    this.ids = ids;
  }
}

/**
 * Chunk order of in-world voxel (x, y, z): (cz·CHUNKS_X + cx)·CHUNKS_Y + cy — column stacks of chunks, so a list in
 * this order rescans each column's sky/canopy height once per write.
 */
export const chunkOrder = (x: number, y: number, z: number): number =>
  ((z >> CHUNK_BITS) * CHUNKS_X + (x >> CHUNK_BITS)) * CHUNKS_Y + (y >> CHUNK_BITS);

/**
 * In-world voxels [0, count) of `positions` (xyz triples) and `ids` sorted by chunkOrder, stable within a chunk, as
 * new arrays with room for `capacity` voxels. A counting sort: O(count + CHUNK_COUNT).
 */
export function sortByChunk(positions: Int32Array, ids: Uint8Array, count: number, capacity = count): { positions: Int32Array; ids: Uint8Array } {
  const starts = new Int32Array(CHUNK_COUNT + 1);
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = chunkOrder(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    order[i] = k;
    starts[k + 1]++;
  }
  for (let k = 1; k <= CHUNK_COUNT; k++) starts[k] += starts[k - 1];
  const p = new Int32Array(Math.max(count, capacity) * 3);
  const d = new Uint8Array(Math.max(count, capacity));
  for (let i = 0; i < count; i++) {
    const j = starts[order[i]]++;
    p[j * 3] = positions[i * 3];
    p[j * 3 + 1] = positions[i * 3 + 1];
    p[j * 3 + 2] = positions[i * 3 + 2];
    d[j] = ids[i];
  }
  return { positions: p, ids: d };
}

/**
 * End of the write slice of `set` that starts at voxel `from`: whole chunk runs (maximal runs of consecutive voxels
 * in one chunk), added while the slice holds fewer than `budget` voxels — at least one run, and at most one run over
 * the budget. In chunk order every chunk is one run, so it is written in one slice (a render node spans 2×2×2 chunks,
 * so a node may be dirtied by several slices: FallingBody holds its meshes until the write is complete).
 */
export function sliceEnd(set: VoxelSet, from: number, budget: number): number {
  const p = set.positions;
  const end = set.count;
  let i = from;
  while (i < end && i - from < budget) {
    const key = chunkKeyAt(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    i++;
    while (i < end && chunkKeyAt(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) === key) i++;
  }
  return i;
}
