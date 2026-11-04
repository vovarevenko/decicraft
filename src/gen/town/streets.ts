/**
 * Street features: cracked asphalt flush with the ground (GRAVEL base), potholes with rubble, grass
 * in cracks, faded centre-line dashes, CURB edges and raised PAVING sidewalks on a sand bed with
 * missing pavers and weeds. Street ends at the town border crumble into the countryside.
 */
import { B } from '../../world/blocks';
import { ORDER, type Feature, type VoxelWriter } from '../types';
import { GROUND_TOP, PAVED_TOP, patchNoise, rnd2, subSeed, valueNoise2 } from './common';
import type { Rect } from './frame';
import type { StreetPlan } from './layout';

/** Length (voxels) over which a ragged street end decays. */
const RAGGED_LEN = 30;

const inRects = (x: number, z: number, rects: readonly Rect[]): boolean => {
  for (const r of rects) if (x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1) return true;
  return false;
};

/** 0 = intact … 1 = fully crumbled, by distance to the street's ragged ends. */
function raggedness(s: StreetPlan, x: number, z: number): number {
  const a = s.axis === 'x' ? x : z;
  const lo = s.axis === 'x' ? s.asphalt.x0 : s.asphalt.z0;
  const hi = s.axis === 'x' ? s.asphalt.x1 : s.asphalt.z1;
  let e = Infinity;
  if (s.raggedMin) e = Math.min(e, a - lo);
  if (s.raggedMax) e = Math.min(e, hi - 1 - a);
  return e >= RAGGED_LEN ? 0 : 1 - e / RAGGED_LEN;
}

/**
 * Cracked asphalt: polygonal "alligator" cracks in patches (iso-lines of a fine value noise inside the
 * high areas of a coarse mask), so cracking clusters instead of running across the whole street.
 */
function isCrack(x: number, z: number, maskSeed: number, crackSeed: number): boolean {
  const mask = valueNoise2(x, z, 44, maskSeed);
  if (mask < 0.56) return false;
  return Math.abs(valueNoise2(x, z, 10, crackSeed) - 0.5) < 0.05 * Math.min(1, (mask - 0.56) * 6);
}

function stampStreet(w: VoxelWriter, s: StreetPlan, seed: number, clean: readonly Rect[], solid: readonly Rect[]): void {
  const crackSeed = subSeed(seed, 1);
  const maskSeed = subSeed(seed, 2);
  const holeSeed = subSeed(seed, 3);
  const plantSeed = subSeed(seed, 4);
  const fadeSeed = subSeed(seed, 5);
  const ragSeed = subSeed(seed, 6);
  const a = s.asphalt;
  const centre = s.axis === 'x' ? (a.z0 + a.z1) >> 1 : (a.x0 + a.x1) >> 1;

  for (let z = a.z0; z < a.z1; z++) {
    for (let x = a.x0; x < a.x1; x++) {
      const isClean = inRects(x, z, clean);
      const rag = inRects(x, z, solid) ? 0 : raggedness(s, x, z);
      if (rag > 0 && patchNoise(x, z, 9, ragSeed) < rag * 0.95) {
        // Crumbled end: gravel and sod instead of asphalt, flush with the ground.
        const g = rnd2(x, z, ragSeed) < 0.45 + 0.4 * rag;
        w.set(x, GROUND_TOP, z, g ? B.GRASS : B.GRAVEL);
        w.set(x, GROUND_TOP - 1, z, g ? B.DIRT : B.GRAVEL);
        continue;
      }
      w.fill(x, GROUND_TOP - 3, z, x + 1, GROUND_TOP - 1, z + 1, B.GRAVEL);
      w.fill(x, GROUND_TOP - 1, z, x + 1, GROUND_TOP + 1, z + 1, B.ASPHALT);
      if (isClean) continue;

      const hole = patchNoise(x, z, 13, holeSeed);
      if (hole > 0.85) {
        // Pothole: one or two voxels deep with rubble and gravel at the bottom.
        w.set(x, GROUND_TOP, z, B.AIR);
        if (hole > 0.91) {
          w.set(x, GROUND_TOP - 1, z, B.AIR);
          w.set(x, GROUND_TOP - 2, z, rnd2(x, z, holeSeed) < 0.5 ? B.RUBBLE : B.GRAVEL);
        } else {
          w.set(x, GROUND_TOP - 1, z, rnd2(x, z, holeSeed) < 0.4 ? B.RUBBLE : B.GRAVEL);
        }
        continue;
      }
      // Cracks, some sprouting grass.
      if (isCrack(x, z, maskSeed, crackSeed)) {
        w.set(x, GROUND_TOP, z, B.DIRT);
        const p = rnd2(x, z, plantSeed);
        if (p < 0.3) w.set(x, GROUND_TOP + 1, z, p < 0.18 ? B.TALL_GRASS : B.DRY_GRASS);
        continue;
      }
      // Faded centre-line dashes.
      const along = s.axis === 'x' ? x : z;
      const across = s.axis === 'x' ? z : x;
      if (across === centre && (along & 31) < 14 && patchNoise(x, z, 11, fadeSeed) > 0.38) {
        w.set(x, GROUND_TOP, z, B.CONCRETE);
      }
    }
  }

  for (const r of s.curbs) {
    for (let z = r.z0; z < r.z1; z++) {
      for (let x = r.x0; x < r.x1; x++) {
        const isClean = inRects(x, z, clean);
        const rag = raggedness(s, x, z);
        if (rag > 0 && patchNoise(x, z, 9, ragSeed) < rag * 0.95) continue;
        // Curb stones are 0.5 m long; a few are broken out.
        const seg = s.axis === 'x' ? x >> 3 : z >> 3;
        if (!isClean && rnd2(seg, s.axis === 'x' ? z : x, holeSeed) < 0.05) {
          w.set(x, GROUND_TOP, z, B.GRAVEL);
          continue;
        }
        w.fill(x, GROUND_TOP - 1, z, x + 1, PAVED_TOP + 1, z + 1, B.CURB);
      }
    }
  }

  for (const r of s.paving) {
    for (let z = r.z0; z < r.z1; z++) {
      for (let x = r.x0; x < r.x1; x++) {
        const isClean = inRects(x, z, clean);
        const rag = raggedness(s, x, z);
        if (rag > 0 && patchNoise(x, z, 9, ragSeed) < rag * 0.95) continue;
        // Pavers are 20×10 cm: a missing one leaves a 2×1 hole with a weed in it.
        const px = s.axis === 'x' ? x >> 1 : x;
        const pz = s.axis === 'x' ? z : z >> 1;
        const density = 0.03 + 0.14 * patchNoise(x, z, 21, fadeSeed);
        if (!isClean && rnd2(px, pz, holeSeed) < density) {
          w.set(x, GROUND_TOP, z, B.DIRT);
          const p = rnd2(px, pz, plantSeed);
          if (p < 0.65) w.set(x, PAVED_TOP, z, p < 0.4 ? B.TALL_GRASS : B.DRY_GRASS);
          continue;
        }
        w.set(x, GROUND_TOP, z, B.SAND);
        w.set(x, PAVED_TOP, z, B.PAVING);
      }
    }
  }
}

/**
 * One street (asphalt, curbs and sidewalks) as a single ground feature. `clean` areas get no potholes,
 * cracks or missing pavers; `solid` areas (the spawn pad) keep intact asphalt even at a ragged end.
 */
export function streetFeature(s: StreetPlan, seed: number, clean: readonly Rect[], solid: readonly Rect[]): Feature {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const r of [s.asphalt, ...s.paving, ...s.curbs]) {
    x0 = Math.min(x0, r.x0);
    z0 = Math.min(z0, r.z0);
    x1 = Math.max(x1, r.x1);
    z1 = Math.max(z1, r.z1);
  }
  return {
    kind: `street:${s.kind}`,
    min: [x0, GROUND_TOP - 3, z0],
    max: [x1, PAVED_TOP + 1, z1],
    order: ORDER.GROUND,
    stamp: (w) => stampStreet(w, s, seed, clean, solid),
  };
}

/**
 * Flat paved area (front path, forecourt, driveway, bus-stop pad) one voxel above the ground, on a
 * sand bed; `worn` lets grass through a share of the slabs.
 */
export function pavedFeature(kind: string, r: Rect, block: number, seed: number, worn: number): Feature {
  return {
    kind,
    min: [r.x0, GROUND_TOP, r.z0],
    max: [r.x1, PAVED_TOP + 1, r.z1],
    order: ORDER.GROUND,
    stamp: (w) => {
      for (let z = r.z0; z < r.z1; z++) {
        for (let x = r.x0; x < r.x1; x++) {
          const cell = block === B.PAVING ? rnd2(x >> 1, z, seed) : rnd2(x >> 2, z >> 2, seed);
          if (cell < worn * patchNoise(x, z, 12, seed)) {
            w.set(x, GROUND_TOP, z, B.GRASS);
            continue;
          }
          w.set(x, GROUND_TOP, z, B.SAND);
          w.set(x, PAVED_TOP, z, block);
        }
      }
    },
  };
}
