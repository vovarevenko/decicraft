/**
 * Geometry of a falling piece (see game/fallingBody.ts): piece-space block grid, the fall plan (toppling decision,
 * pivot, axis, contact probes on its STRUCT skeleton), rigid pose, and re-voxelisation by inverse-transform sampling
 * that keeps the skeleton connected — split into a pure scan (scanLanding) and the write (writeLanding: the scanned
 * cells, which writeLandingCells can also write a range at a time, then the skeleton's joins, joinSkeleton).
 * planFall and scanLanding only read a WorldData: they run in the felling worker (see interaction/felling.ts).
 * OWNER: agent "interaction".
 */
import { CHUNK_BITS, CHUNK_MASK, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, GRAVITY, WORLD_X, WORLD_Y, WORLD_Z } from '../../config';
import type { Vec3Like } from '../../core/math';
import { B, FOLIAGE, SOLID, SUP, SUPPORT, isReplaceable } from '../../world/blocks';
import type { DetachedPiece } from '../../world/structure';
import { chunkKey, type World, type WorldData } from '../../world/world';
import type { VoxelList, VoxelSet } from './voxelList';

/** Natural tree wood (bark and trunk cores): a toppling tree breaks through other trees' crowns… */
const TREE_WOOD = new Uint8Array(256);
for (const id of [B.OAK_LOG, B.BIRCH_LOG, B.PINE_LOG, B.WOOD]) TREE_WOOD[id] = 1;
/** …higher than this above its own base (2 m); lower down, trunks and stumps stop it. */
export const PASS_WOOD_ABOVE = 20;

/** Detached pieces with fewer voxels crumble into item drops instead of falling. */
export const MIN_FALLING_VOXELS = 40;

const PROBES = 200;
/** Layers at the bottom of a piece that make up its base (footprint for toppling). */
const BASE_LAYERS = 3;
/** A piece topples when at least this many times taller than its base is wide… */
const TOPPLE_ASPECT = 2.5;
const MIN_TOPPLE_HEIGHT = 6;
/** …and something solid lies at most this many voxels below its base (a stump, not thin air). */
const STAND_GAP = 6;

/** Dense block-id grid over a box (0 = empty). */
export interface BlockGrid {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  /** Index (x − minX) + sx·((y − minY) + sy·(z − minZ)). */
  readonly ids: Uint8Array;
}

/** Block-id grid over a piece's bounding box at rest. */
export interface PieceGrid extends BlockGrid {
  /** Rest positions (xyz triples) of the SUP.STRUCT voxels: the skeleton that carries the piece. */
  readonly struct: Int32Array;
}

export function buildPieceGrid(piece: DetachedPiece): PieceGrid {
  const [minX, minY, minZ] = piece.min;
  const sx = piece.max[0] - minX;
  const sy = piece.max[1] - minY;
  const sz = piece.max[2] - minZ;
  const ids = new Uint8Array(sx * sy * sz);
  const p = piece.positions;
  let structCount = 0;
  for (let i = 0; i < piece.count; i++) {
    ids[p[i * 3] - minX + sx * (p[i * 3 + 1] - minY + sy * (p[i * 3 + 2] - minZ))] = piece.ids[i];
    if (SUPPORT[piece.ids[i]] === SUP.STRUCT) structCount++;
  }
  const struct = new Int32Array(structCount * 3);
  for (let i = 0, k = 0; i < piece.count; i++) {
    if (SUPPORT[piece.ids[i]] !== SUP.STRUCT) continue;
    struct[k++] = p[i * 3];
    struct[k++] = p[i * 3 + 1];
    struct[k++] = p[i * 3 + 2];
  }
  return { minX, minY, minZ, sx, sy, sz, ids, struct };
}

/** Block of the grid at rest voxel (x, y, z); 0 when empty or outside the grid. */
export function gridBlock(grid: BlockGrid, x: number, y: number, z: number): number {
  const gx = x - grid.minX;
  const gy = y - grid.minY;
  const gz = z - grid.minZ;
  if (gx < 0 || gy < 0 || gz < 0 || gx >= grid.sx || gy >= grid.sy || gz >= grid.sz) return 0;
  return grid.ids[gx + grid.sx * (gy + grid.sy * gz)];
}

/**
 * Rigid pose of a piece: a point p of the piece at rest (world coordinates before it moved) is now at
 * pivot + R·(p − rest), R being a rotation about an axis through the pivot.
 */
export class PiecePose {
  /** Rotation, row-major 3×3. */
  readonly m = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /** The pivot at rest. */
  readonly rest = { x: 0, y: 0, z: 0 };
  /** The pivot now. */
  readonly pivot = { x: 0, y: 0, z: 0 };

  /** R = right-handed rotation by `angle` about the unit axis (ax, ay, az) (Rodrigues; same as three.js). */
  setRotation(ax: number, ay: number, az: number, angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const m = this.m;
    m[0] = c + t * ax * ax;
    m[1] = t * ax * ay - s * az;
    m[2] = t * ax * az + s * ay;
    m[3] = t * ax * ay + s * az;
    m[4] = c + t * ay * ay;
    m[5] = t * ay * az - s * ax;
    m[6] = t * ax * az - s * ay;
    m[7] = t * ay * az + s * ax;
    m[8] = c + t * az * az;
    return this;
  }

  /** Current world position of rest point (x, y, z). */
  toWorld(x: number, y: number, z: number, out: Vec3Like): Vec3Like {
    const m = this.m;
    const dx = x - this.rest.x;
    const dy = y - this.rest.y;
    const dz = z - this.rest.z;
    out.x = this.pivot.x + m[0] * dx + m[1] * dy + m[2] * dz;
    out.y = this.pivot.y + m[3] * dx + m[4] * dy + m[5] * dz;
    out.z = this.pivot.z + m[6] * dx + m[7] * dy + m[8] * dz;
    return out;
  }

  /** The rest point now at world position (x, y, z): rest + Rᵀ·(p − pivot), the inverse of toWorld. */
  toRest(x: number, y: number, z: number, out: Vec3Like): Vec3Like {
    const m = this.m;
    const dx = x - this.pivot.x;
    const dy = y - this.pivot.y;
    const dz = z - this.pivot.z;
    out.x = this.rest.x + m[0] * dx + m[3] * dy + m[6] * dz;
    out.y = this.rest.y + m[1] * dx + m[4] * dy + m[7] * dz;
    out.z = this.rest.z + m[2] * dx + m[5] * dy + m[8] * dz;
    return out;
  }
}

/** How a detached piece starts to fall (see FallingBody): plain data, so the felling worker can post it. */
export interface FallPlan {
  readonly grid: PieceGrid;
  /** Topples about its base edge (a tree standing on its stump); otherwise it drops straight down. */
  readonly tree: boolean;
  /** The pivot at rest: on the base's bottom edge facing the push direction when toppling, else under the box centre. */
  readonly rest: Vec3Like;
  /** Horizontal rotation axis (up × push direction). */
  readonly axis: Vec3Like;
  /** 3g / 2h (h = piece height): the toppling pendulum's rate. */
  readonly toppleRate: number;
  /** Contact probes (pickContactSamples) as offsets from `rest`, xyz triples. */
  readonly probes: Float32Array;
  /** Largest distance of a probe from the pivot (bounds how far probes sweep per radian). */
  readonly probeReach: number;
}

/**
 * Plans the fall of a detached piece pushed away from `from` (the player): it topples when it stands on something
 * within STAND_GAP voxels below its base and is at least TOPPLE_ASPECT times taller than its base is wide (and
 * MIN_TOPPLE_HEIGHT tall); then the pivot is the base's bottom edge facing the push direction. Reads the world only
 * below the piece's base (planReadBox).
 */
export function planFall(world: WorldData, piece: DetachedPiece, from: Vec3Like): FallPlan {
  const [x0, y0, z0] = piece.min;
  const [x1, y1, z1] = piece.max;
  const height = y1 - y0;
  const grid = buildPieceGrid(piece);
  const push = pushDirection(piece, from);

  let dx = push.x;
  let dz = push.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6) {
    dx /= len;
    dz /= len;
  } else {
    dx = 1;
    dz = 0;
  }

  // Base footprint: centre, width and the reach of its edge towards the push direction.
  const p = piece.positions;
  let cx = 0;
  let cz = 0;
  let nBase = 0;
  let bx0 = Infinity;
  let bx1 = -Infinity;
  let bz0 = Infinity;
  let bz1 = -Infinity;
  let stands = false;
  for (let i = 0; i < piece.count; i++) {
    const y = p[i * 3 + 1];
    if (y >= y0 + BASE_LAYERS) continue;
    const x = p[i * 3];
    const z = p[i * 3 + 2];
    cx += x + 0.5;
    cz += z + 0.5;
    nBase++;
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x + 1);
    bz0 = Math.min(bz0, z);
    bz1 = Math.max(bz1, z + 1);
    if (y === y0 && !stands) stands = solidBelow(world, x, y, z);
  }
  cx /= nBase;
  cz /= nBase;
  const tree = stands && height >= MIN_TOPPLE_HEIGHT && height >= TOPPLE_ASPECT * Math.max(bx1 - bx0, bz1 - bz0);
  const rest = { x: 0, y: y0, z: 0 };
  if (tree) {
    const half = 0.5 * (Math.abs(dx) + Math.abs(dz));
    let front = 0;
    for (let i = 0; i < piece.count; i++) {
      if (p[i * 3 + 1] >= y0 + BASE_LAYERS) continue;
      front = Math.max(front, (p[i * 3] + 0.5 - cx) * dx + (p[i * 3 + 2] + 0.5 - cz) * dz + half);
    }
    rest.x = cx + dx * front;
    rest.z = cz + dz * front;
  } else {
    rest.x = (x0 + x1) / 2;
    rest.z = (z0 + z1) / 2;
  }

  const probes = pickContactSamples(piece, grid, rest, tree, PROBES);
  let probeReach = 0;
  for (let i = 0; i < probes.length; i += 3) probeReach = Math.max(probeReach, Math.hypot(probes[i], probes[i + 1], probes[i + 2]));
  return {
    grid,
    tree,
    rest,
    axis: { x: dz, y: 0, z: -dx },
    toppleRate: (3 * GRAVITY) / (2 * Math.max(1, height)),
    probes,
    probeReach,
  };
}

/** Grows read box `box` (x0, y0, z0 inclusive, x1, y1, z1 exclusive) to hold the voxels planFall reads for `piece`. */
export function planReadBox(piece: DetachedPiece, box: Int32Array): void {
  box[0] = Math.min(box[0], piece.min[0]);
  box[1] = Math.min(box[1], piece.min[1] - STAND_GAP - 1);
  box[2] = Math.min(box[2], piece.min[2]);
  box[3] = Math.max(box[3], piece.max[0]);
  box[4] = Math.max(box[4], piece.max[1]);
  box[5] = Math.max(box[5], piece.max[2]);
}

/** Horizontal unit direction from `from` to the centre of the piece's lowest layer (where a tree stands); +x if none. */
function pushDirection(piece: DetachedPiece, from: Vec3Like): Vec3Like {
  const p = piece.positions;
  let x = 0;
  let z = 0;
  let n = 0;
  for (let i = 0; i < piece.count; i++) {
    if (p[i * 3 + 1] !== piece.min[1]) continue;
    x += p[i * 3] + 0.5;
    z += p[i * 3 + 2] + 0.5;
    n++;
  }
  const dx = x / n - from.x;
  const dz = z / n - from.z;
  if (dx * dx + dz * dz <= 1e-6) return { x: 1, y: 0, z: 0 };
  const s = 1 / Math.sqrt(dx * dx + dz * dz); // as THREE.Vector3.normalize(), bit for bit
  return { x: dx * s, y: 0, z: dz * s };
}

/** Something solid within STAND_GAP voxels under (x, y, z). */
function solidBelow(world: WorldData, x: number, y: number, z: number): boolean {
  for (let d = 1; d <= STAND_GAP; d++) if (world.isSolidAt(x, y - d, z)) return true;
  return false;
}

/**
 * Picks ≈`maxSamples` piece voxels as contact probes and returns their centres relative to `origin` as xyz
 * triples. Only the STRUCT voxels are candidates when the piece has any: the skeleton (trunk, branches) comes to
 * rest on the ground and the crown's leaves sink in and are crushed, so the landed piece is supported again. The
 * candidates extreme along ±x, ±y, ±z are always included; the rest come from systematic sampling proportional
 * to a weight biased to the extremities. Toppling pieces (`topple`): squared distance from `origin` (the pivot —
 * far voxels sweep fastest), with a sixth of all weight kept for the bottom layer (it rests on the stump).
 * Falling pieces: downward-facing voxels, the faces that meet the ground.
 */
export function pickContactSamples(
  piece: DetachedPiece,
  grid: PieceGrid,
  origin: Vec3Like,
  topple: boolean,
  maxSamples: number,
): Float32Array {
  // The candidates: the skeleton's voxels, or every voxel of a piece without one.
  const skeleton = grid.struct.length > 0;
  const p = skeleton ? grid.struct : piece.positions;
  const n = skeleton ? grid.struct.length / 3 : piece.count;
  const weights = new Float32Array(n);
  const extremes = [0, 0, 0, 0, 0, 0];
  let farthest = 1e-9;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      if (p[i * 3 + a] < p[extremes[a * 2] * 3 + a]) extremes[a * 2] = i;
      if (p[i * 3 + a] > p[extremes[a * 2 + 1] * 3 + a]) extremes[a * 2 + 1] = i;
    }
    if (topple) {
      const dx = p[i * 3] + 0.5 - origin.x;
      const dy = p[i * 3 + 1] + 0.5 - origin.y;
      const dz = p[i * 3 + 2] + 0.5 - origin.z;
      weights[i] = dx * dx + dy * dy + dz * dz;
      farthest = Math.max(farthest, weights[i]);
    }
  }
  const bottom = p[extremes[2] * 3 + 1];
  let total = 0;
  if (topple) {
    let bottomCount = 0;
    for (let i = 0; i < n; i++) {
      if (p[i * 3 + 1] === bottom) {
        bottomCount++;
      } else {
        weights[i] = 0.03 + weights[i] / farthest;
        total += weights[i];
      }
    }
    // The bottom layer shares a sixth of all weight: the drop onto the stump needs probes there.
    const each = (total > 0 ? total / 5 : 1) / bottomCount;
    for (let i = 0; i < n; i++) if (p[i * 3 + 1] === bottom) weights[i] = each;
    total += each * bottomCount;
  } else {
    for (let i = 0; i < n; i++) {
      // Downward-facing: nothing below that belongs to the skeleton (leaves below do not hold it up).
      const below = gridBlock(grid, p[i * 3], p[i * 3 + 1] - 1, p[i * 3 + 2]);
      weights[i] = below === 0 || (skeleton && SUPPORT[below] !== SUP.STRUCT) ? 1 : 0.03;
      total += weights[i];
    }
  }

  const chosen = new Uint8Array(n);
  const picks: number[] = [];
  for (const i of extremes) {
    if (chosen[i] === 0 && picks.length < maxSamples) {
      chosen[i] = 1;
      picks.push(i);
    }
  }
  const step = total / Math.max(1, maxSamples - picks.length);
  let next = step / 2;
  let acc = 0;
  for (let i = 0; i < n && picks.length < maxSamples; i++) {
    acc += weights[i];
    if (acc < next) continue;
    if (chosen[i] === 0) {
      chosen[i] = 1;
      picks.push(i);
    }
    while (next <= acc) next += step;
  }

  const out = new Float32Array(picks.length * 3);
  for (let k = 0; k < picks.length; k++) {
    const i = picks[k];
    out[k * 3] = p[i * 3] + 0.5 - origin.x;
    out[k * 3 + 1] = p[i * 3 + 1] + 0.5 - origin.y;
    out[k * 3 + 2] = p[i * 3 + 2] + 0.5 - origin.z;
  }
  return out;
}

/**
 * True if any probe (offsets from pose.rest, xyz triples) is inside a SOLID world voxel at this pose. With
 * `passWood` (a toppling tree) natural tree wood more than PASS_WOOD_ABOVE above the piece's base does not count:
 * the tree crashes through its neighbours' crowns instead of hanging in their branches.
 */
export function hasContact(world: WorldData, pose: PiecePose, samples: Float32Array, passWood = false): boolean {
  const m = pose.m;
  const { x: px, y: py, z: pz } = pose.pivot;
  const passY = passWood ? pose.rest.y + PASS_WOOD_ABOVE : Infinity;
  for (let i = 0; i < samples.length; i += 3) {
    const dx = samples[i];
    const dy = samples[i + 1];
    const dz = samples[i + 2];
    const wx = px + m[0] * dx + m[1] * dy + m[2] * dz;
    const wy = py + m[3] * dx + m[4] * dy + m[5] * dz;
    const wz = pz + m[6] * dx + m[7] * dy + m[8] * dz;
    const id = world.getBlock(Math.floor(wx), Math.floor(wy), Math.floor(wz));
    if (SOLID[id] === 1 && (wy <= passY || TREE_WOOD[id] === 0)) return true;
  }
  return false;
}

/** Vetoes writing block `id` into world cell (x, y, z) (e.g. the cells the player stands in). */
export type WriteVeto = (x: number, y: number, z: number, id: number) => boolean;

/**
 * Writes the posed piece back into the world by inverse-transform sampling (scanLanding, then writeLanding): every
 * world cell in the posed bounding box whose centre maps into a filled grid cell receives that block — only if the
 * cell is replaceable (air, plant, water) and `blocked` does not veto it. Then the STRUCT skeleton is re-joined
 * (joinSkeleton). Written cells are appended to `written`; returns how many were written.
 */
export function revoxelize(world: World, grid: PieceGrid, pose: PiecePose, written: VoxelList, blocked?: WriteVeto): number {
  const start = written.count;
  scanLanding(world, grid, pose, written);
  writeLanding(world, grid, pose, written, start, blocked);
  return written.count - start;
}

/**
 * The landing cells of the posed piece, by inverse-transform sampling: every world cell in the posed bounding box
 * whose centre maps (rest = rest + Rᵀ·(centre − pivot)) into a filled grid cell gets that block, unless the cell
 * already holds it or is not replaceable (air, plant, water). Only reads the world (the felling worker runs it);
 * appends the cells to `out` and returns how many.
 */
export function scanLanding(world: WorldData, grid: BlockGrid, pose: PiecePose, out: VoxelList): number {
  const { minX, minY, minZ, sx, sy, sz, ids } = grid;
  const m = pose.m;
  const corner = { x: 0, y: 0, z: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    pose.toWorld(minX + (c & 1 ? sx : 0), minY + (c & 2 ? sy : 0), minZ + (c & 4 ? sz : 0), corner);
    x0 = Math.min(x0, corner.x);
    y0 = Math.min(y0, corner.y);
    z0 = Math.min(z0, corner.z);
    x1 = Math.max(x1, corner.x);
    y1 = Math.max(y1, corner.y);
    z1 = Math.max(z1, corner.z);
  }
  const ix0 = Math.max(0, Math.floor(x0));
  const iy0 = Math.max(0, Math.floor(y0));
  const iz0 = Math.max(0, Math.floor(z0));
  const ix1 = Math.min(WORLD_X, Math.ceil(x1));
  const iy1 = Math.min(WORLD_Y, Math.ceil(y1));
  const iz1 = Math.min(WORLD_Z, Math.ceil(z1));
  const { x: rx, y: ry, z: rz } = pose.rest;
  const { x: px, y: py, z: pz } = pose.pivot;
  const start = out.count;
  for (let z = iz0; z < iz1; z++) {
    for (let y = iy0; y < iy1; y++) {
      const cx = ix0 + 0.5 - px;
      const cy = y + 0.5 - py;
      const cz = z + 0.5 - pz;
      let qx = rx + m[0] * cx + m[3] * cy + m[6] * cz;
      let qy = ry + m[1] * cx + m[4] * cy + m[7] * cz;
      let qz = rz + m[2] * cx + m[5] * cy + m[8] * cz;
      // One cell along +x moves the rest-space sample by Rᵀ·(1, 0, 0) = the first row of R. The posed box is
      // mostly empty around a tilted piece: only the steps whose samples can land in the grid are visited.
      const t0 = Math.max(0, rowFirst(qx, m[0], minX, minX + sx), rowFirst(qy, m[1], minY, minY + sy), rowFirst(qz, m[2], minZ, minZ + sz));
      const t1 = Math.min(ix1 - ix0, rowEnd(qx, m[0], minX, minX + sx), rowEnd(qy, m[1], minY, minY + sy), rowEnd(qz, m[2], minZ, minZ + sz));
      if (t1 <= t0) continue;
      qx += t0 * m[0];
      qy += t0 * m[1];
      qz += t0 * m[2];
      for (let x = ix0 + t0, xe = ix0 + t1; x < xe; x++, qx += m[0], qy += m[1], qz += m[2]) {
        const gx = Math.floor(qx) - minX;
        const gy = Math.floor(qy) - minY;
        const gz = Math.floor(qz) - minZ;
        if (gx < 0 || gy < 0 || gz < 0 || gx >= sx || gy >= sy || gz >= sz) continue;
        const id = ids[gx + sx * (gy + sy * gz)];
        if (id === 0) continue;
        const current = world.getBlock(x, y, z);
        if (current === id || !isReplaceable(current)) continue;
        out.push(x, y, z, id);
      }
    }
  }
  return out.count - start;
}

/**
 * Writes landing cells [start, written.count) of `written` (scanLanding's, maybe of an older world): every cell is
 * checked against the world as it is now — dropped (the list is compacted in place) if it already holds its block,
 * is no longer replaceable or `blocked` vetoes it — the rest is written in bulk, then the STRUCT skeleton is
 * re-joined (joinSkeleton, appending its cells). Returns how many of the scanned cells were written: they are
 * [start, start + that) of `written`, the skeleton's cells follow them up to written.count.
 */
export function writeLanding(world: World, grid: PieceGrid, pose: PiecePose, written: VoxelList, start: number, blocked?: WriteVeto): number {
  const n = writeLandingCells(world, written, start, written.count, start, blocked);
  written.count = n;
  joinSkeleton(world, grid, pose, written, blocked);
  return n - start;
}

/**
 * writeLanding's cells, a range at a time (a landing written in slices over several frames): checks scanned cells
 * [from, end) of `cells` against the world as it is now, as writeLanding does, moves those that pass down to `to`
 * (≤ from: the written cells of all slices stay in front, in order) and writes them in bulk. Returns the end of the
 * written cells; writeLanding's joinSkeleton comes after the last range, with cells.count set to that end.
 */
export function writeLandingCells(world: World, cells: VoxelList, from: number, end: number, to: number, blocked?: WriteVeto): number {
  const p = cells.positions;
  const ids = cells.ids;
  let n = to;
  for (let i = from; i < end; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    const id = ids[i];
    const current = world.getBlock(x, y, z);
    if (current === id || !isReplaceable(current) || blocked?.(x, y, z, id)) continue;
    p[n * 3] = x;
    p[n * 3 + 1] = y;
    p[n * 3 + 2] = z;
    ids[n++] = id;
  }
  // Every cell is listed once, so checking first and writing in bulk gives the same world.
  world.setBlocks(p, ids, n, to);
  return n;
}

/**
 * Row clipping for scanLanding: along one rest axis the sample of step t is q + t·d, and the steps
 * [rowFirst, rowEnd) contain every t where it lies in [lo, hi) — with a step of slack on both sides, so float
 * rounding never drops a cell (the per-cell bounds check stays exact).
 */
function rowFirst(q: number, d: number, lo: number, hi: number): number {
  if (Math.abs(d) < 1e-12) return q > lo - 1 && q < hi + 1 ? -Infinity : Infinity;
  return Math.floor(Math.min((lo - q) / d, (hi - q) / d)) - 1;
}

function rowEnd(q: number, d: number, lo: number, hi: number): number {
  if (Math.abs(d) < 1e-12) return q > lo - 1 && q < hi + 1 ? Infinity : -Infinity;
  return Math.floor(Math.max((lo - q) / d, (hi - q) / d)) + 2;
}

/**
 * Keeps the STRUCT skeleton 6-connected at its pose, so the landed piece is one supported structure and no later
 * dig next to it makes it fall again: inverse sampling leaves a rotated one-voxel branch only edge- or
 * corner-connected and can drop its voxels. Every skeleton voxel's block goes into the cell holding its posed
 * centre, and for each +x/+y/+z skeleton neighbour whose cell is not face-adjacent, one cell in between (two
 * for a corner step) — into replaceable or foliage cells only, and where `blocked` does not veto it. Runs after the
 * landing's cells are written, over skeleton voxels [from, end) of grid.struct (all by default: a landing written in
 * slices joins them a range at a time, in order); appends the cells it writes to `written`.
 */
export function joinSkeleton(
  world: World,
  grid: PieceGrid,
  pose: PiecePose,
  written: VoxelList,
  blocked?: WriteVeto,
  from = 0,
  end = grid.struct.length / 3,
): void {
  const s = grid.struct;
  const m = pose.m;
  const c = { x: 0, y: 0, z: 0 };
  for (let i = from * 3; i < end * 3; i += 3) {
    const x = s[i];
    const y = s[i + 1];
    const z = s[i + 2];
    const id = gridBlock(grid, x, y, z);
    pose.toWorld(x + 0.5, y + 0.5, z + 0.5, c);
    const ax = Math.floor(c.x);
    const ay = Math.floor(c.y);
    const az = Math.floor(c.z);
    putSkeleton(world, ax, ay, az, id, written, blocked);
    for (let k = 0; k < 3; k++) {
      if (SUPPORT[gridBlock(grid, x + (k === 0 ? 1 : 0), y + (k === 1 ? 1 : 0), z + (k === 2 ? 1 : 0))] !== SUP.STRUCT) continue;
      // The neighbour's posed centre is one rotated unit step away: c + R·e_k (column k of R).
      const dx = Math.floor(c.x + m[k]) - ax;
      const dy = Math.floor(c.y + m[3 + k]) - ay;
      const dz = Math.floor(c.z + m[6 + k]) - az;
      const axes = (dx !== 0 ? 1 : 0) + (dy !== 0 ? 1 : 0) + (dz !== 0 ? 1 : 0);
      if (axes < 2) continue; // the same or face-adjacent cells
      if (axes === 3) {
        putSkeleton(world, ax + dx, ay, az, id, written, blocked);
        putSkeleton(world, ax + dx, ay + dy, az, id, written, blocked);
        continue;
      }
      // An edge step: the cells in between are one step along either changed axis, and either joins the two —
      // the first along x (or y if x did not change), the second along the remaining changed axis.
      const firstY = dx === 0 ? dy : 0;
      const secondY = dy - firstY;
      if (isStruct(world, ax + dx, ay + firstY, az) || isStruct(world, ax, ay + secondY, az + dz)) continue;
      if (!putSkeleton(world, ax + dx, ay + firstY, az, id, written, blocked)) putSkeleton(world, ax, ay + secondY, az + dz, id, written, blocked);
    }
  }
}

const isStruct = (world: WorldData, x: number, y: number, z: number): boolean => SUPPORT[world.getBlock(x, y, z)] === SUP.STRUCT;

/** Writes skeleton block `id` into cell (x, y, z) unless it already is STRUCT; true if the cell now is STRUCT. */
function putSkeleton(world: World, x: number, y: number, z: number, id: number, written: VoxelList, blocked?: WriteVeto): boolean {
  const current = world.getBlock(x, y, z);
  if (SUPPORT[current] === SUP.STRUCT) return true;
  if (!(isReplaceable(current) || FOLIAGE[current] === 1) || blocked?.(x, y, z, id)) return false;
  if (!world.setBlock(x, y, z, id)) return false;
  written.push(x, y, z, id);
  return true;
}

/**
 * Keys of the chunks holding voxels [from, set.count), plus the chunks across any border they touch (faces/AO change
 * there too).
 */
export function touchedChunks(set: VoxelSet, out: Set<number> = new Set(), from = 0): Set<number> {
  const p = set.positions;
  let last = -1;
  for (let i = from; i < set.count; i++) {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    const cx = x >> CHUNK_BITS;
    const cy = y >> CHUNK_BITS;
    const cz = z >> CHUNK_BITS;
    const key = chunkKey(cx, cy, cz);
    if (key !== last) out.add(key);
    last = key;
    const lx = x & CHUNK_MASK;
    const ly = y & CHUNK_MASK;
    const lz = z & CHUNK_MASK;
    if (lx === 0 && cx > 0) out.add(chunkKey(cx - 1, cy, cz));
    if (lx === CHUNK_MASK && cx < CHUNKS_X - 1) out.add(chunkKey(cx + 1, cy, cz));
    if (ly === 0 && cy > 0) out.add(chunkKey(cx, cy - 1, cz));
    if (ly === CHUNK_MASK && cy < CHUNKS_Y - 1) out.add(chunkKey(cx, cy + 1, cz));
    if (lz === 0 && cz > 0) out.add(chunkKey(cx, cy, cz - 1));
    if (lz === CHUNK_MASK && cz < CHUNKS_Z - 1) out.add(chunkKey(cx, cy, cz + 1));
  }
  return out;
}
