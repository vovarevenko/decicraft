/**
 * Voxel ray casting (Amanatides–Woo DDA). OWNER: agent "player".
 */
import type { Vec3Like } from '../core/math';
import { B, PLANT_HEIGHT } from './blocks';
import type { WorldData } from './world';

export interface VoxelHit {
  /** Hit voxel coordinates. */
  x: number;
  y: number;
  z: number;
  /** Normal of the face that was entered (-1/0/1 per axis); (0,0,0) if the ray started inside the voxel. */
  nx: number;
  ny: number;
  nz: number;
  /** Block id of the hit voxel. */
  id: number;
  /** Distance along the ray to the entry point (world units). */
  distance: number;
  /** Entry point (world units). */
  px: number;
  py: number;
  pz: number;
}

export const makeVoxelHit = (): VoxelHit => ({ x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0, distance: 0, px: 0, py: 0, pz: 0 });

/** Tallest plant (PLANT_HEIGHT) minus one: how far below an entered air cell a plant can still reach into it. */
const PLANT_LOOKDOWN = 11;

const acceptVisible = (id: number): boolean => id !== B.AIR && id !== B.WATER;

/**
 * Walks voxels along the ray from `origin` in unit direction `dir` up to `maxDist`.
 * Returns the first voxel for which `accept(id, x, y, z)` is true (default: any non-AIR, non-WATER
 * block, i.e. solids, foliage and plants), or null.
 *
 * Tall plants: plants are drawn up to PLANT_HEIGHT voxels above their own cell. When the ray enters an
 * AIR cell, look down through at most 11 AIR cells; if the first non-AIR cell below is a plant whose
 * PLANT_HEIGHT exceeds the number of cells walked (and accept() allows plants), return THAT plant voxel
 * (normal = the entered face of the air cell, distance/point = entry into the air cell). The cell the
 * ray starts in is not entered, so a ray cast from inside a tall reed bed does not stop at distance 0.
 *
 * Returns `out` when given (overwritten), otherwise a new object. Callers that keep a hit across frames
 * must copy the fields they need.
 */
export function raycastVoxels(
  world: WorldData,
  origin: Vec3Like,
  dir: Vec3Like,
  maxDist: number,
  accept: (id: number, x: number, y: number, z: number) => boolean = acceptVisible,
  out?: VoxelHit,
): VoxelHit | null {
  const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  const dx = len > 0 ? dir.x / len : 0;
  const dy = len > 0 ? dir.y / len : 0;
  const dz = len > 0 ? dir.z / len : 0;
  let x = Math.floor(origin.x);
  let y = Math.floor(origin.y);
  let z = Math.floor(origin.z);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
  // Ray length per voxel along each axis, and the ray length at which the next boundary is crossed.
  const tDeltaX = stepX !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? 1 / Math.abs(dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? 1 / Math.abs(dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - origin.x) * tDeltaX : stepX < 0 ? (origin.x - x) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - origin.y) * tDeltaY : stepY < 0 ? (origin.y - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - origin.z) * tDeltaZ : stepZ < 0 ? (origin.z - z) * tDeltaZ : Infinity;
  let t = 0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let entered = false;

  for (;;) {
    const id = world.getBlock(x, y, z);
    if (accept(id, x, y, z)) return writeHit(out, x, y, z, nx, ny, nz, id, t, origin, dx, dy, dz);
    if (id === B.AIR && entered) {
      const plantY = tallPlantBelow(world, x, y, z, accept);
      if (plantY !== null) return writeHit(out, x, plantY, z, nx, ny, nz, world.getBlock(x, plantY, z), t, origin, dx, dy, dz);
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else if (tMaxZ !== Infinity) {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    } else {
      return null; // zero direction: only the start cell exists
    }
    if (t > maxDist) return null;
    entered = true;
  }
}

/** y of the plant drawn into air cell (x, y, z) from below (see raycastVoxels), or null. */
function tallPlantBelow(
  world: WorldData,
  x: number,
  y: number,
  z: number,
  accept: (id: number, x: number, y: number, z: number) => boolean,
): number | null {
  for (let walked = 1; walked <= PLANT_LOOKDOWN; walked++) {
    const id = world.getBlock(x, y - walked, z);
    if (id === B.AIR) continue;
    return PLANT_HEIGHT[id] > walked && accept(id, x, y - walked, z) ? y - walked : null;
  }
  return null;
}

function writeHit(
  out: VoxelHit | undefined,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  id: number,
  t: number,
  origin: Vec3Like,
  dx: number,
  dy: number,
  dz: number,
): VoxelHit {
  const hit = out ?? makeVoxelHit();
  hit.x = x;
  hit.y = y;
  hit.z = z;
  hit.nx = nx;
  hit.ny = ny;
  hit.nz = nz;
  hit.id = id;
  hit.distance = t;
  hit.px = origin.x + dx * t;
  hit.py = origin.y + dy * t;
  hit.pz = origin.z + dz * t;
  return hit;
}
