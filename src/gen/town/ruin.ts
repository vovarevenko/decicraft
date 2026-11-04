/**
 * The partly collapsed ruin: wall heights fall off towards a collapse corner along a jagged,
 * course-stepped profile; the roof is gone, the floor is overgrown and debris mounds of rubble and
 * bricks lie where the roof came down. All heights are pure functions of the plan, so the planner can
 * reason about intact wall stretches (doors, windows) and sapling spots before anything is stamped.
 */
import { clamp, smoothstep } from '../../core/math';
import { hash3 } from '../../core/rng';
import { B } from '../../world/blocks';
import { GROUND_TOP, moundHeight, patchNoise, rnd2, subSeed, valueNoise2, weedAt } from './common';
import type { BuildingPlan, RuinPlan } from './building';
import type { LocalWriter } from './frame';

interface RuinGeometry {
  ruin: RuinPlan | null;
  yF: number;
  yTop: number;
  W: number;
  D: number;
  seed: number;
}

/** Exclusive top y of the ruin's walls at local column (u, v) (walls start at yF). */
export function ruinWallTop(p: RuinGeometry, u: number, v: number, partition = false): number {
  const r = p.ruin!;
  const full = p.yTop + 1 - p.yF;
  const f = smoothstep(r.r0, r.r1, Math.hypot(u - r.cu, v - r.cv));
  const jag = (valueNoise2(u, v, 5, subSeed(p.seed, 41)) - 0.5) * 12 * (1 - f * f);
  let h = clamp(r.minH + (full - r.minH) * f + jag, 0, full);
  if (partition) h *= 0.85;
  // Brickwork breaks in two-voxel courses.
  return p.yF + (h >= full ? full : Math.floor(h / 2) * 2);
}

/** First air voxel above the floor, ground or debris at local column (u, v). */
export function ruinSurface(p: RuinGeometry, u: number, v: number): number {
  const r = p.ruin!;
  const inside = u >= 0 && u < p.W && v >= 0 && v < p.D;
  let h = 0;
  r.mounds.forEach((m, i) => {
    h = Math.max(h, moundHeight(u - m.u, v - m.v, m.r, m.h, subSeed(p.seed, 50 + i)));
  });
  return (inside ? p.yF + 1 : GROUND_TOP + 1) + h;
}

/** Foundation, overgrown floor, broken walls and partitions. */
export function stampRuinShell(lw: LocalWriter, p: BuildingPlan): void {
  const { W, D, t, yF, plinth } = p;
  const r = p.ruin!;
  lw.fill(-plinth, GROUND_TOP - 2, -plinth, W + plinth, yF, D + plinth, p.plinthMat);
  const sf = subSeed(p.seed, 42);
  const sp = subSeed(p.seed, 43);
  for (let v = t; v < D - t; v++) {
    for (let u = t; u < W - t; u++) {
      const n = patchNoise(u, v, 9, sf);
      const id = n > 0.6 ? B.GRASS : n > 0.52 ? B.MOSS : n > 0.47 ? B.DIRT : B.CONCRETE;
      lw.set(u, yF, v, id);
      if (id === B.GRASS && rnd2(u, v, sp) < 0.3) lw.set(u, yF + 1, v, rnd2(v, u, sp) < 0.7 ? B.TALL_GRASS : B.DRY_GRASS);
    }
  }
  const so = subSeed(p.seed, 44);
  const full = p.yTop + 1;
  const column = (u: number, v: number, top: number, outer: boolean) => {
    if (top <= yF) return;
    lw.fill(u, yF, v, u + 1, top, v + 1, p.core);
    // Scraps of plaster survive on the outside; weeds grow on the broken tops (plants, so a wall
    // stump still falls when it is cut loose).
    if (outer) for (let y = yF; y < top; y++) if (patchNoise(u + v, y, 7, so) > 0.6) lw.set(u, y, v, p.outer);
    if (top < full && rnd2(u, v, so) < 0.3) lw.setSoft(u, top, v, weedAt(u, v, so));
  };
  for (let v = 0; v < D; v++) {
    for (let u = 0; u < W; u++) {
      const wall = u < t || u >= W - t || v < t || v >= D - t;
      if (!wall) continue;
      column(u, v, ruinWallTop(p, u, v), u === 0 || v === 0 || u === W - 1 || v === D - 1);
    }
  }
  for (const pr of r.partitions) {
    for (let v = pr.v0; v < pr.v1; v++) for (let u = pr.u0; u < pr.u1; u++) column(u, v, ruinWallTop(p, u, v, true), false);
  }
}

/** Debris mounds of rubble with brick chunks and plaster bits, weeds on top (stamped last). */
export function stampRuinDebris(lw: LocalWriter, p: BuildingPlan): void {
  const { W, D, yF } = p;
  p.ruin!.mounds.forEach((m, i) => {
    const seed = subSeed(p.seed, 50 + i);
    for (let v = m.v - m.r - 1; v <= m.v + m.r + 1; v++) {
      for (let u = m.u - m.r - 1; u <= m.u + m.r + 1; u++) {
        const h = moundHeight(u - m.u, v - m.v, m.r, m.h, seed);
        if (h <= 0) continue;
        const base = u >= 0 && u < W && v >= 0 && v < D ? yF + 1 : GROUND_TOP + 1;
        for (let y = base; y < base + h; y++) {
          const k = hash3(u, y, v, seed) & 15;
          lw.set(u, y, v, k < 3 ? B.BRICK : k === 3 ? B.PLASTER : B.RUBBLE);
        }
        // Soft: a weed never replaces the rubble of an overlapping, higher mound.
        if (patchNoise(u, v, 5, seed) > 0.62 && rnd2(u, v, seed) < 0.45) lw.setSoft(u, base + h, v, weedAt(u, v, seed));
      }
    }
  });
}
