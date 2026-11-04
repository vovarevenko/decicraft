/**
 * Replays a BuildingPlan through the clipped writer. Order: shell (foundation with moss, walls with
 * weathered outer layer, slabs) → partitions & finishes → fallen interior plaster → openings, frames,
 * stairs, furniture, porches, signs → roof → chimneys & roof details → ruin debris → grass along the walls.
 * Every random decision is a hash of the voxel position and the plan's own seed, so stamping is
 * identical in every tile.
 */
import { B } from '../../world/blocks';
import type { VoxelWriter } from '../types';
import { GROUND_TOP, GROUND_Y, patchNoise, rnd2, subSeed } from './common';
import type { BuildingPlan } from './building';
import { LocalWriter } from './frame';
import { stampRoof } from './roof';
import { stampRuinDebris, stampRuinShell } from './ruin';

export function stampBuilding(w: VoxelWriter, p: BuildingPlan): void {
  const lw = new LocalWriter(w, p.frame);
  if (p.ruin) stampRuinShell(lw, p);
  else stampShell(lw, p);
  for (const list of p.inner) list.stamp(lw);
  stampInteriorDecay(lw, p);
  for (const list of p.main) list.stamp(lw);
  if (p.roof) stampRoof(lw, p.roof, p.seed);
  for (const list of p.post) list.stamp(lw);
  if (p.ruin) stampRuinDebris(lw, p);
  stampGroundDetails(lw, p);
}

function stampShell(lw: LocalWriter, p: BuildingPlan): void {
  const { W, D, t, yF, plinth } = p;
  lw.fill(-plinth, GROUND_TOP - 2, -plinth, W + plinth, yF, D + plinth, p.plinthMat);
  lw.fill(t, yF, t, W - t, yF + 1, D - t, p.floorMat);
  const top = p.yTop + 1 + p.parapet;
  lw.fill(0, yF, 0, W, top, t, p.core);
  lw.fill(0, yF, D - t, W, top, D, p.core);
  lw.fill(0, yF, t, t, top, D - t, p.core);
  lw.fill(W - t, yF, t, W, top, D - t, p.core);
  if (p.outer !== p.core) stampOuterLayer(lw, p, top);
  for (let s = 1; s <= p.storeys; s++) {
    const ys = yF + s * p.storeyH;
    lw.fill(t, ys - 1, t, W - t, ys + 1, D - t, p.slabMat);
  }
  if (plinth > 0) stampPlinthMoss(lw, p);
}

/** Outer facing layer (plaster, paint) with fallen patches showing the core, worst near the ground. */
function stampOuterLayer(lw: LocalWriter, p: BuildingPlan, top: number): void {
  const { W, D, yF } = p;
  const thr = 1 - 0.45 * p.decay;
  for (let side = 0; side < 4; side++) {
    const len = side < 2 ? W : D;
    const sp = subSeed(p.seed, 11 + side);
    for (let a = 0; a < len; a++) {
      const u = side === 0 ? a : side === 1 ? a : side === 2 ? 0 : W - 1;
      const v = side === 0 ? 0 : side === 1 ? D - 1 : a;
      for (let y = yF; y < top; y++) {
        let id = p.outer;
        if (p.decay > 0) {
          const splash = y - yF < 10 ? 0.07 : 0;
          if (patchNoise(a, y, 8, sp) > thr - splash) id = p.core;
        }
        lw.set(u, y, v, id);
      }
    }
  }
}

/** Moss creeping up the plinth ledge around the walls. */
function stampPlinthMoss(lw: LocalWriter, p: BuildingPlan): void {
  const { W, D, yF } = p;
  const sm = subSeed(p.seed, 19);
  const ring = (u: number, v: number, a: number) => {
    for (let y = GROUND_TOP + 1; y < yF; y++) if (patchNoise(a, y * 3, 7, sm) > 0.62) lw.set(u, y, v, B.MOSS);
  };
  for (let u = -1; u <= W; u++) {
    ring(u, -1, u);
    ring(u, D, u + 5000);
  }
  for (let v = 0; v < D; v++) {
    ring(-1, v, v + 10000);
    ring(W, v, v + 15000);
  }
}

/** Fallen plaster / peeled wallpaper / missing tiles on the inner wall faces of each room. */
function stampInteriorDecay(lw: LocalWriter, p: BuildingPlan): void {
  const y1 = p.clear;
  for (let i = 0; i < p.rooms.length; i++) {
    const r = p.rooms[i];
    if (r.under === r.finish) continue;
    const seed = subSeed(p.seed, 100 + i);
    const strip = (u0: number, v0: number, u1: number, v1: number) => {
      for (let v = v0; v < v1; v++) {
        for (let u = u0; u < u1; u++) {
          for (let y = 0; y < y1; y++) if (patchNoise(u + v, y, 7, seed) > 0.8) lw.set(u, r.fy + y, v, r.under);
        }
      }
    };
    strip(r.u0, r.v0 - 1, r.u1, r.v0);
    strip(r.u0, r.v1, r.u1, r.v1 + 1);
    strip(r.u0 - 1, r.v0, r.u0, r.v1);
    strip(r.u1, r.v0, r.u1 + 1, r.v1);
  }
}

/** Tall and dry grass along the walls (never over porches, paths or steps: soft writes only). */
function stampGroundDetails(lw: LocalWriter, p: BuildingPlan): void {
  const { W, D } = p;
  const pl = Math.max(p.plinth, 0);
  const m = pl + 3;
  const sg = subSeed(p.seed, 61);
  for (let v = -m; v < D + m; v++) {
    for (let u = -m; u < W + m; u++) {
      if (u >= -pl && u < W + pl && v >= -pl && v < D + pl) {
        u = W + pl - 1;
        continue;
      }
      const density = 0.15 + 0.5 * patchNoise(u, v, 6, sg);
      const r = rnd2(u, v, sg);
      if (r < density) lw.setSoft(u, GROUND_Y, v, r < density * 0.65 ? B.TALL_GRASS : B.DRY_GRASS);
    }
  }
}
