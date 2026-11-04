/**
 * Roofs: clean stepped gable and mono-pitch slopes (2-voxel skin, so steps never leave diagonal
 * gaps) with eaves/verge overhang, exposed rafters, gable infill, holes and weeds; flat roofs get
 * tatters of bitumen felt and weeds inside their parapet. Chimneys and attic windows go to the post
 * list. Overgrowth up here is plants only: a ground block (SUP.ANCHOR) on a roof would keep the roof
 * standing after its walls are knocked out.
 */
import { B } from '../../world/blocks';
import { patchNoise, rnd2, subSeed, weedAt } from './common';
import type { LocalWriter } from './frame';
import type { BuildingBuilder } from './building';

export type RoofType = 'gable' | 'mono' | 'flat';

export interface RoofPlan {
  type: RoofType;
  /** Skin material. */
  mat: number;
  /** Gable-end infill under the skin. */
  gableMat: number;
  /** Eave-side wall plate infill under the skin. */
  wallMat: number;
  /** Gable: ridge parallel to u (eaves front/back) or to v (gables front/back). Mono: high side at the front when along u. */
  ridgeAlongU: boolean;
  rise: number;
  run: number;
  /** Overhang beyond the walls on the eave sides / gable sides. */
  eave: number;
  verge: number;
  /** Hole and weed amounts, 0..1. */
  holes: number;
  weeds: number;
  W: number;
  D: number;
  t: number;
  yTop: number;
  bounds: { u0: number; v0: number; u1: number; v1: number; y1: number };
}

export interface RoofOptions {
  type: RoofType;
  mat: number;
  gableMat: number;
  wallMat: number;
  ridgeAlongU: boolean;
  rise: number;
  run: number;
  eave: number;
  verge: number;
  holes: number;
  weeds: number;
}

/** Extents across (S) and along (L) the slope. */
const across = (r: RoofPlan): number => (r.ridgeAlongU ? r.D : r.W);
const along = (r: RoofPlan): number => (r.ridgeAlongU ? r.W : r.D);

/** Distance (voxels) of across-coordinate b from the low eave edge. */
function eaveDist(r: RoofPlan, b: number): number {
  const S = across(r);
  return r.type === 'gable' ? Math.min(b + r.eave, S - 1 - b + r.eave) : S - 1 - b + r.eave;
}

/** Top skin voxel at across-coordinate b. */
export function skinTop(r: RoofPlan, b: number): number {
  return r.yTop + 1 + Math.floor(((eaveDist(r, b) - r.eave) * r.rise) / r.run);
}

/** Top roof voxel over local column (u, v) (the slab top for flat roofs). */
export function roofTopAt(r: RoofPlan, u: number, v: number): number {
  if (r.type === 'flat') return r.yTop;
  return skinTop(r, r.ridgeAlongU ? v : u);
}

/** Highest skin voxel (ridge) of a sloped roof. */
export function ridgeTop(r: RoofPlan): number {
  if (r.type === 'flat') return r.yTop;
  const S = across(r);
  let best = -Infinity;
  for (let b = -r.eave; b < S + r.eave; b++) best = Math.max(best, skinTop(r, b));
  return best;
}

export function makeRoof(b: BuildingBuilder, o: RoofOptions): RoofPlan {
  // A flat roof is the top slab itself; its weeds stand one voxel above it.
  const r: RoofPlan = { ...o, W: b.W, D: b.D, t: b.t, yTop: b.yTop, bounds: { u0: 0, v0: 0, u1: b.W, v1: b.D, y1: b.yTop + 2 } };
  if (o.type === 'flat') return r;
  const eu = o.ridgeAlongU ? o.verge : o.eave;
  const ev = o.ridgeAlongU ? o.eave : o.verge;
  r.bounds = { u0: -eu, v0: -ev, u1: b.W + eu, v1: b.D + ev, y1: ridgeTop(r) + 2 };
  return r;
}

/** Stamps the roof of a planned building (after walls and interiors, before the post list). */
export function stampRoof(lw: LocalWriter, r: RoofPlan, seed: number): void {
  if (r.type === 'flat') {
    stampFlatRoof(lw, r, seed);
    return;
  }
  const S = across(r);
  const L = along(r);
  const t = r.t;
  const holeSeed = subSeed(seed, 31);
  const weedSeed = subSeed(seed, 32);
  const holeT = 1 - 0.16 * r.holes;
  const weedT = 1 - 0.3 * r.weeds;
  let dMax = 0;
  for (let b = -r.eave; b < S + r.eave; b++) dMax = Math.max(dMax, eaveDist(r, b));
  const put = (a: number, y: number, b: number, id: number) => {
    if (r.ridgeAlongU) lw.set(a, y, b, id);
    else lw.set(b, y, a, id);
  };
  const column = (a: number, b: number, y0: number, y1: number, id: number) => {
    if (y1 <= y0) return;
    if (r.ridgeAlongU) lw.fill(a, y0, b, a + 1, y1, b + 1, id);
    else lw.fill(b, y0, a, b + 1, y1, a + 1, id);
  };

  for (let b = -r.eave; b < S + r.eave; b++) {
    const top = skinTop(r, b);
    const inside = b >= 0 && b < S;
    // Infill under the skin: gable ends and the eave-side wall plates.
    if (inside) {
      const plate = b < t || b >= S - t;
      for (let a = 0; a < L; a++) {
        const gableEnd = a < t || a >= L - t;
        if (gableEnd) column(a, b, r.yTop + 1, top - 1, r.gableMat);
        else if (plate) column(a, b, r.yTop + 1, top - 1, r.wallMat);
      }
    }
    for (let a = -r.verge; a < L + r.verge; a++) {
      // Rafters every 6 voxels, two voxels deep so the stepped beam stays face-connected; visible
      // under the eaves and through holes.
      if (a >= 1 && a < L - 1 && a % 6 === 3) {
        put(a, top - 2, b, B.DARK_WOOD);
        put(a, top - 3, b, B.DARK_WOOD);
      }
      const interior = a >= 2 && a < L - 2 && b >= 1 && b < S - 1;
      if (interior && patchNoise(a, b, 6, holeSeed) > holeT) continue;
      put(a, top, b, r.mat);
      put(a, top - 1, b, r.mat);
      if (r.type === 'gable' && eaveDist(r, b) === dMax) put(a, top + 1, b, r.mat);
      else if (patchNoise(a, b, 9, weedSeed) > weedT && rnd2(a, b, weedSeed) < 0.35) put(a, top + 1, b, weedAt(a, b, weedSeed));
    }
  }
}

/** Concrete slab with tatters of bitumen roofing felt (RUBBER) and weeds where dust has gathered. */
function stampFlatRoof(lw: LocalWriter, r: RoofPlan, seed: number): void {
  const t = r.t;
  const feltSeed = subSeed(seed, 33);
  const weedSeed = subSeed(seed, 34);
  const weedT = 1 - 0.3 * r.weeds;
  const y = r.yTop;
  for (let v = t; v < r.D - t; v++) {
    for (let u = t; u < r.W - t; u++) {
      if (patchNoise(u, v, 10, feltSeed) < 0.42) lw.set(u, y, v, B.RUBBER);
      else if (patchNoise(u, v, 9, weedSeed) > weedT && rnd2(u, v, weedSeed) < 0.35) lw.set(u, y + 1, v, weedAt(u, v, weedSeed));
    }
  }
}
