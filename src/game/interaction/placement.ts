/**
 * Placement geometry (ARCHITECTURE.md §11.2): the cells a cube of material occupies and which of them may be
 * filled. OWNER: agent "interaction".
 */
import { WORLD_X, WORLD_Y, WORLD_Z } from '../../config';
import { isReplaceable } from '../../world/blocks';
import type { WorldData } from '../../world/world';
import type { AABB } from '../physics';

/** The part of a VoxelHit that placement needs. */
export interface FaceHit {
  x: number;
  y: number;
  z: number;
  /** Clicked face normal (exactly one non-zero component). */
  nx: number;
  ny: number;
  nz: number;
  /** Hit point on the face (world units). */
  px: number;
  py: number;
  pz: number;
}

/** Largest cube edge; cell buffers hold MAX_PLACE_SIZE³ triples. */
export const MAX_PLACE_SIZE = 5;

/** First offset of an `n`-cell run centred on its anchor cell; even runs lean towards the hit fraction `f` (0..1). */
function centredStart(f: number, n: number): number {
  return Math.round(Math.min(0.999, Math.max(0, f)) - n / 2);
}

/**
 * Writes the cells of a placement cube with edge `size` to `out` as packed triples, nearest to the hit point
 * first; returns their count. The cube starts in the cell adjacent to the clicked face — or in the hit voxel's
 * own cell when `inPlace` (plant targets) — extends away from the face, and is centred on that anchor cell in
 * the two other axes. Returns 0 if the hit has no face normal.
 */
export function placementCells(hit: FaceHit, size: number, inPlace: boolean, out: Int32Array): number {
  const n = Math.max(1, Math.min(MAX_PLACE_SIZE, Math.round(size)));
  const nx = Math.sign(hit.nx);
  const ny = Math.sign(hit.ny);
  const nz = Math.sign(hit.nz);
  const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : nz !== 0 ? 2 : -1;
  if (axis < 0) return 0;
  const ax = hit.x + (inPlace ? 0 : nx);
  const ay = hit.y + (inPlace ? 0 : ny);
  const az = hit.z + (inPlace ? 0 : nz);
  // Along the normal the run goes away from the face (step ±1 from offset 0); across it, a centred run.
  const sx = axis === 0 ? nx : 1;
  const sy = axis === 1 ? ny : 1;
  const sz = axis === 2 ? nz : 1;
  const ox = axis === 0 ? 0 : centredStart(hit.px - ax, n);
  const oy = axis === 1 ? 0 : centredStart(hit.py - ay, n);
  const oz = axis === 2 ? 0 : centredStart(hit.pz - az, n);
  let count = 0;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        out[count * 3] = ax + (axis === 0 ? i * sx : ox + i);
        out[count * 3 + 1] = ay + (axis === 1 ? j * sy : oy + j);
        out[count * 3 + 2] = az + (axis === 2 ? k * sz : oz + k);
        count++;
      }
    }
  }
  sortNearest(out, count, hit.px, hit.py, hit.pz);
  return count;
}

/** Insertion sort of `count` cell triples by the distance of their centres to (px, py, pz). */
function sortNearest(cells: Int32Array, count: number, px: number, py: number, pz: number): void {
  const d2 = (i: number): number => {
    const dx = cells[i * 3] + 0.5 - px;
    const dy = cells[i * 3 + 1] + 0.5 - py;
    const dz = cells[i * 3 + 2] + 0.5 - pz;
    return dx * dx + dy * dy + dz * dz;
  };
  for (let i = 1; i < count; i++) {
    const x = cells[i * 3];
    const y = cells[i * 3 + 1];
    const z = cells[i * 3 + 2];
    const key = d2(i);
    let j = i - 1;
    while (j >= 0 && d2(j) > key) {
      cells[(j + 1) * 3] = cells[j * 3];
      cells[(j + 1) * 3 + 1] = cells[j * 3 + 1];
      cells[(j + 1) * 3 + 2] = cells[j * 3 + 2];
      j--;
    }
    cells[(j + 1) * 3] = x;
    cells[(j + 1) * 3 + 1] = y;
    cells[(j + 1) * 3 + 2] = z;
  }
}

/** Bounding box of `count` cell triples (for querying solid entities around a placement). */
export function cellsBounds(cells: Int32Array, count: number, out: AABB): AABB {
  out.minX = out.minY = out.minZ = Infinity;
  out.maxX = out.maxY = out.maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = cells[i * 3];
    const y = cells[i * 3 + 1];
    const z = cells[i * 3 + 2];
    out.minX = Math.min(out.minX, x);
    out.minY = Math.min(out.minY, y);
    out.minZ = Math.min(out.minZ, z);
    out.maxX = Math.max(out.maxX, x + 1);
    out.maxY = Math.max(out.maxY, y + 1);
    out.maxZ = Math.max(out.maxZ, z + 1);
  }
  return out;
}

/**
 * Compacts `cells` (keeping their order) to those inside the world that are replaceable (air, plants, water) and
 * whose unit cube does not overlap any of `blockers` (the player, solid entities). Returns the new count.
 */
export function filterPlaceable(world: WorldData, cells: Int32Array, count: number, blockers: readonly AABB[]): number {
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const x = cells[i * 3];
    const y = cells[i * 3 + 1];
    const z = cells[i * 3 + 2];
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) continue;
    if (!isReplaceable(world.getBlock(x, y, z)) || overlapsAny(x, y, z, blockers)) continue;
    cells[kept * 3] = x;
    cells[kept * 3 + 1] = y;
    cells[kept * 3 + 2] = z;
    kept++;
  }
  return kept;
}

function overlapsAny(x: number, y: number, z: number, boxes: readonly AABB[]): boolean {
  for (const b of boxes) {
    if (x < b.maxX && x + 1 > b.minX && y < b.maxY && y + 1 > b.minY && z < b.maxZ && z + 1 > b.minZ) return true;
  }
  return false;
}
