/**
 * Shared constants and deterministic noise helpers of the town generator.
 */
import { TOWN_GROUND_Y } from '../../config';
import { U32_TO_UNIT, hash2, hash32 } from '../../core/rng';
import { B } from '../../world/blocks';

/** Top voxel of the flat natural ground (GRASS from the terrain). */
export const GROUND_TOP = TOWN_GROUND_Y - 1;
/** First air voxel above the natural ground = where feet stand on a road. */
export const GROUND_Y = TOWN_GROUND_Y;
/** Top voxel of sidewalk paving, curbs, paths and forecourts (one voxel above the road surface). */
export const PAVED_TOP = TOWN_GROUND_Y;

/** Door openings (DoorSpawn) and window defaults, voxels. */
export const DOOR_W = 9;
export const DOOR_H = 20;

/** Stable seed for a named sub-stream of a parent seed. */
export const subSeed = (seed: number, salt: number): number => hash32(seed ^ hash32(salt + 0x51ed27));

/** Uniform [0, 1) from 2D integer coordinates and a seed. */
export const rnd2 = (x: number, z: number, seed: number): number => hash2(x, z, seed) * U32_TO_UNIT;

/** Plant block of a weed tuft in a hashed cell: mostly dry grass, some tall grass. */
export const weedAt = (x: number, z: number, seed: number): number => (rnd2(z, x, seed) < 0.65 ? B.DRY_GRASS : B.TALL_GRASS);

/** Smooth value noise in [0, 1) on a lattice of `cell` voxels (no allocation). */
export function valueNoise2(x: number, z: number, cell: number, seed: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(ix, iz, seed) * U32_TO_UNIT;
  const b = hash2(ix + 1, iz, seed) * U32_TO_UNIT;
  const c = hash2(ix, iz + 1, seed) * U32_TO_UNIT;
  const d = hash2(ix + 1, iz + 1, seed) * U32_TO_UNIT;
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Two-octave value noise in [0, 1) — blotchy patches with ragged edges. */
export const patchNoise = (x: number, z: number, cell: number, seed: number): number =>
  0.7 * valueNoise2(x, z, cell, seed) + 0.3 * valueNoise2(x, z, cell * 0.37, seed ^ 0x2c1b);

/**
 * Height (voxels, 0..height) of a noise-deformed debris mound at offset (dx, dz) from its centre:
 * a dome with lumpy surface and a wobbly outline that never leaves the circle of `radius`.
 */
export function moundHeight(dx: number, dz: number, radius: number, height: number, seed: number): number {
  const ang = Math.atan2(dz, dx);
  const wobble = 0.7 + 0.3 * valueNoise2(Math.cos(ang) * 6 + 50, Math.sin(ang) * 6 + 50, 2.2, seed);
  const r = Math.hypot(dx, dz) / (radius * wobble);
  if (r >= 1) return 0;
  const lump = 0.75 + 0.25 * valueNoise2(dx, dz, 3, seed ^ 0x77);
  return Math.floor(height * (1 - r * r) * lump + 0.35);
}
