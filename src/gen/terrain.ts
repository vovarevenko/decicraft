/**
 * Natural terrain: biome layout & blending, heights, ground layers, pond, column filling and
 * surface decoration. OWNER: agent "worldgen". Must be deterministic and fast (called per column
 * in workers and on demand on the main thread).
 */
import {
  BIOME_FOREST,
  BIOME_HILLS,
  BIOME_MEADOW,
  BIOME_TOWN,
  QUADRANT_SPLIT,
  TOWN_BUILD_RECT,
  TOWN_GROUND_Y,
  WORLD_X,
  WORLD_Y,
  WORLD_Z,
  type BiomeId,
} from '../config';
import { clamp, lerp, smoothstep, TAU } from '../core/math';
import { createNoise2D, fbm2, ridged2, type Noise2D } from '../core/noise';
import { hash2, hash32, Rng } from '../core/rng';
import { B, RENDER_KIND, RK } from '../world/blocks';
import type { ColumnSample, TerrainSampler, VoxelWriter } from './types';

/** First air voxel above the pond's water surface (the top water voxel is at POND_WATER_Y - 1). */
export const POND_WATER_Y = 116;
/** Exactly flat town ground: TOWN_BUILD_RECT grown by 2 m (max exclusive). */
export const TOWN_FLAT_RECT = {
  x0: TOWN_BUILD_RECT.x0 - 20,
  z0: TOWN_BUILD_RECT.z0 - 20,
  x1: TOWN_BUILD_RECT.x1 + 20,
  z1: TOWN_BUILD_RECT.z1 + 20,
} as const;
/** Subsoil layers and lenses occur only down to this depth below the top ground voxel; deeper is plain STONE. */
export const STRATA_DEPTH = 24;
/** Normalised pond radius (1 = waterline) where the banks meet the surrounding meadow. */
export const POND_BANK_RHO = 1.55;
/** Reeds grow in water at most this deep (voxels). */
export const REED_MAX_DEPTH = 3;

const NAT_WARP = 100; // natural borders are domain-warped by up to ≈ ±8 m (fbm extremes ≈ ±0.8)
const NAT_WARP_FREQ = 1 / 320;
const NAT_BLEND = 60; // half-width of natural border blends (≈ 12 m in total)
const TOWN_BLEND = 80; // town border blend ≈ 8 m …
const TOWN_BLEND_VAR = 15; // … varying by ±1.5 m along the border
const TOWN_BLEND_MAX = TOWN_BLEND + TOWN_BLEND_VAR;
const EDGE_SMOOTH = 150; // hills relax into a gentle rim within 15 m of the map edge
const POND_SAND_RHO = 1.16;
const POND_FAR = 99;
const LITTER_DENSITY = 0.42;

/** Natural ground blocks plants may grow on. */
const NATURAL_TOP = new Uint8Array(256);
for (const id of [B.GRASS, B.LITTER, B.MOSS, B.SAND, B.MUD, B.DIRT, B.GRAVEL]) NATURAL_TOP[id] = 1;

export interface PondShape {
  /** Centre (voxels). */
  x: number;
  z: number;
  /** Semi-axes (voxels) of the waterline ellipse before domain warping; `angle` rotates the long axis. */
  a: number;
  b: number;
  angle: number;
  /** Max water depth (voxels). */
  depth: number;
  /** First air voxel above the water surface. */
  waterY: number;
  /** Centre of the gravel patch on the shore. */
  gravelX: number;
  gravelZ: number;
  /** Beyond this distance from the centre the pond does not affect the terrain. */
  reach: number;
}

/**
 * Ground horizons of one column (depths in voxels below the top ground voxel, inclusive ranges).
 * Filled by `NaturalTerrain.prepareStrata`, consumed by `fillColumn`.
 */
export interface Strata {
  top: number;
  soil: number;
  soilEnd: number;
  sub: number;
  /** Weathered GRAVEL band starts at this depth (ends at rockHead - 1). */
  bandStart: number;
  rockHead: number;
  rock: number;
  /** Rock below this depth is STONE even in granite patches (granite stays within STRATA_DEPTH). */
  rockEnd: number;
  lens: number;
  lensLo: number;
  lensHi: number;
}

/** A fresh ColumnSample to pass to `TerrainSampler.sample` (reuse it; sample() never allocates). */
export function createColumnSample(): ColumnSample {
  return { biome: BIOME_TOWN, weights: [1, 0, 0, 0], surfaceY: TOWN_GROUND_Y, waterY: 0, topBlock: B.GRASS };
}

const salted = (seed: number, k: number): number => hash32(seed ^ Math.imul(k + 1, 0x9e3779b1));

function dominant(w0: number, w1: number, w2: number, w3: number): BiomeId {
  let b: BiomeId = BIOME_TOWN;
  let m = w0;
  if (w1 > m) {
    m = w1;
    b = BIOME_FOREST;
  }
  if (w2 > m) {
    m = w2;
    b = BIOME_MEADOW;
  }
  if (w3 > m) b = BIOME_HILLS;
  return b;
}

/**
 * The natural terrain of one seed. Implements TerrainSampler and exposes a few extras used by the
 * world plan and the tile generator (biome weights, forest density, pond shape, slopes, batch sampling).
 * Instances keep scratch state, so they are cheap per call but not re-entrant.
 */
export class NaturalTerrain implements TerrainSampler {
  readonly seed: number;
  readonly pond: PondShape;

  private readonly nWarpX: Noise2D;
  private readonly nWarpZ: Noise2D;
  private readonly nTown: Noise2D;
  private readonly nForest: Noise2D;
  private readonly nMeadow: Noise2D;
  private readonly nHills: Noise2D;
  private readonly nRoll: Noise2D;
  private readonly nBump: Noise2D;
  private readonly nDensity: Noise2D;
  private readonly nPatch: Noise2D;
  private readonly nPond: Noise2D;
  private readonly nSoil: Noise2D;
  private readonly nRock: Noise2D;
  private readonly nFlora: Noise2D;
  private readonly hashSalt: number;
  private readonly pondCos: number;
  private readonly pondSin: number;

  // Scratch results of the last evalColumn / naturalWeights call.
  private readonly wts: [number, number, number, number] = [1, 0, 0, 0];
  private natF = 0;
  private natM = 0;
  private natH = 0;
  private hillsDepth = 0;
  /** Hill dome profile of the last evaluated column (0 outside the hills). */
  private dome = 0;
  private rho = POND_FAR;
  private readonly strata: Strata = {
    top: B.GRASS, soil: B.DIRT, soilEnd: 4, sub: B.CLAY, bandStart: 12, rockHead: 14, rock: B.STONE, rockEnd: STRATA_DEPTH,
    lens: B.GRAVEL, lensLo: 1, lensHi: 0,
  };
  private areaH = new Float64Array(0);
  private areaDome = new Float64Array(0);
  private areaRho = new Float64Array(0);

  constructor(seed: number) {
    this.seed = seed;
    this.nWarpX = createNoise2D(salted(seed, 1));
    this.nWarpZ = createNoise2D(salted(seed, 2));
    this.nTown = createNoise2D(salted(seed, 3));
    this.nForest = createNoise2D(salted(seed, 4));
    this.nMeadow = createNoise2D(salted(seed, 5));
    this.nHills = createNoise2D(salted(seed, 6));
    this.nRoll = createNoise2D(salted(seed, 7));
    this.nBump = createNoise2D(salted(seed, 8));
    this.nDensity = createNoise2D(salted(seed, 9));
    this.nPatch = createNoise2D(salted(seed, 10));
    this.nPond = createNoise2D(salted(seed, 11));
    this.nSoil = createNoise2D(salted(seed, 12));
    this.nRock = createNoise2D(salted(seed, 13));
    this.nFlora = createNoise2D(salted(seed, 14));
    this.hashSalt = salted(seed, 15);

    const rng = new Rng(salted(seed, 16));
    const angle = rng.range(0, Math.PI);
    const a = rng.range(94, 104);
    const b = rng.range(64, 72);
    const cx = 370 + rng.range(-30, 30);
    const cz = 900 + rng.range(-30, 30);
    const g = rng.range(0, TAU);
    this.pondCos = Math.cos(angle);
    this.pondSin = Math.sin(angle);
    const gu = a * 0.96 * Math.cos(g);
    const gv = b * 0.96 * Math.sin(g);
    this.pond = {
      x: cx,
      z: cz,
      a,
      b,
      angle,
      depth: rng.range(17, 20),
      waterY: POND_WATER_Y,
      gravelX: cx + gu * this.pondCos - gv * this.pondSin,
      gravelZ: cz + gu * this.pondSin + gv * this.pondCos,
      reach: a * POND_BANK_RHO + 40,
    };
  }

  // ------------------------------------------------------------------ TerrainSampler

  sample(x: number, z: number, out: ColumnSample): ColumnSample {
    const h = this.evalColumn(x, z);
    const w = this.wts;
    const w0 = w[0];
    const w1 = w[1];
    const w2 = w[2];
    const w3 = w[3];
    const dome = this.dome;
    const rho = this.rho;
    let slope = 0;
    if (w3 > 0) {
      const gx = this.heightAt(x + 1, z) - this.heightAt(x - 1, z);
      const gz = this.heightAt(x, z + 1) - this.heightAt(x, z - 1);
      slope = 0.5 * Math.sqrt(gx * gx + gz * gz);
    }
    this.finishColumn(x, z, h, w0, w1, w2, w3, dome, rho, slope, out);
    return out;
  }

  surfaceY(x: number, z: number): number {
    return Math.round(this.evalColumn(x, z));
  }

  biomeAt(x: number, z: number): BiomeId {
    const w = this.weightsAt(x, z, this.wts);
    return dominant(w[0], w[1], w[2], w[3]);
  }

  // ------------------------------------------------------------------ extras

  /** Biome weights [town, forest, meadow, hills] (sum 1) at column (x, z). */
  weightsAt(x: number, z: number, out: [number, number, number, number]): [number, number, number, number] {
    const town = this.townWeight(x, z);
    if (town >= 1) {
      out[0] = 1;
      out[1] = 0;
      out[2] = 0;
      out[3] = 0;
      return out;
    }
    this.naturalWeights(x, z);
    const rest = 1 - town;
    out[0] = town;
    out[1] = this.natF * rest;
    out[2] = this.natM * rest;
    out[3] = this.natH * rest;
    return out;
  }

  /** Unrounded natural ground height (first air voxel ≈ round(heightAt)). */
  heightAt(x: number, z: number): number {
    return this.evalColumn(x, z);
  }

  /** Ground gradient magnitude (voxels per voxel) from central differences `step` voxels apart. */
  slopeAt(x: number, z: number, step = 1): number {
    const gx = this.evalColumn(x + step, z) - this.evalColumn(x - step, z);
    const gz = this.evalColumn(x, z + step) - this.evalColumn(x, z - step);
    return Math.sqrt(gx * gx + gz * gz) / (2 * step);
  }

  /** Forest canopy density 0..1: low values are clearings (grass instead of litter, no trees). */
  forestDensity(x: number, z: number): number {
    return clamp(0.62 + 0.8 * fbm2(this.nDensity, x * (1 / 260), z * (1 / 260), 2), 0, 1);
  }

  /** Normalised pond radius at (x, z): < 1 under water, < POND_BANK_RHO on the banks, large far away. */
  pondRho(x: number, z: number): number {
    const p = this.pond;
    const dx = x + 0.5 - p.x;
    const dz = z + 0.5 - p.z;
    if (dx * dx + dz * dz > p.reach * p.reach) return POND_FAR;
    const u = dx * this.pondCos + dz * this.pondSin + 16 * this.nPond(x * (1 / 64), z * (1 / 64));
    const v = -dx * this.pondSin + dz * this.pondCos + 16 * this.nPond(x * (1 / 64) + 41.3, z * (1 / 64) - 17.9);
    const ua = u / p.a;
    const vb = v / p.b;
    return Math.sqrt(ua * ua + vb * vb);
  }

  /** Hill dome profile 0..1 (0 = valley floor, 1 = crest) — rock outcrops go on high values. */
  hillDomeAt(x: number, z: number): number {
    return this.domeAt(x, z);
  }

  /**
   * Batch version of sample() for a w×d block of columns starting at (x0, z0): `out[lx + lz·w]`
   * receives exactly what sample(x0 + lx, z0 + lz) would return; neighbour heights for slopes are shared.
   */
  sampleArea(x0: number, z0: number, w: number, d: number, out: ColumnSample[]): void {
    const n = w * d;
    if (this.areaH.length < n) {
      this.areaH = new Float64Array(n);
      this.areaDome = new Float64Array(n);
      this.areaRho = new Float64Array(n);
    }
    const H = this.areaH;
    for (let lz = 0; lz < d; lz++) {
      for (let lx = 0; lx < w; lx++) {
        const i = lx + lz * w;
        H[i] = this.evalColumn(x0 + lx, z0 + lz);
        const ow = out[i].weights;
        ow[0] = this.wts[0];
        ow[1] = this.wts[1];
        ow[2] = this.wts[2];
        ow[3] = this.wts[3];
        this.areaDome[i] = this.dome;
        this.areaRho[i] = this.rho;
      }
    }
    for (let lz = 0; lz < d; lz++) {
      for (let lx = 0; lx < w; lx++) {
        const i = lx + lz * w;
        const o = out[i];
        const ow = o.weights;
        const x = x0 + lx;
        const z = z0 + lz;
        let slope = 0;
        if (ow[3] > 0) {
          const hxp = lx + 1 < w ? H[i + 1] : this.evalColumn(x + 1, z);
          const hxm = lx > 0 ? H[i - 1] : this.evalColumn(x - 1, z);
          const hzp = lz + 1 < d ? H[i + w] : this.evalColumn(x, z + 1);
          const hzm = lz > 0 ? H[i - w] : this.evalColumn(x, z - 1);
          const gx = hxp - hxm;
          const gz = hzp - hzm;
          slope = 0.5 * Math.sqrt(gx * gx + gz * gz);
        }
        this.finishColumn(x, z, H[i], ow[0], ow[1], ow[2], ow[3], this.areaDome[i], this.areaRho[i], slope, o);
      }
    }
  }

  /** Describes the ground horizons of a column (reused object; valid until the next call). */
  prepareStrata(x: number, z: number, s: ColumnSample): Strata {
    const st = this.strata;
    const top = s.topBlock;
    const hills = s.weights[3];
    const n1 = this.nSoil(x * (1 / 37), z * (1 / 37));
    const n2 = this.nSoil(x * (1 / 23) + 71.3, z * (1 / 23) - 5.1);
    const n3 = this.nSoil(x * (1 / 61) - 33.7, z * (1 / 61) + 12.9);
    const u1 = 0.5 + 0.5 * n1;
    const u2 = 0.5 + 0.5 * n2;
    st.top = top;
    st.rock = B.STONE;
    st.rockEnd = STRATA_DEPTH;
    st.lensLo = 1;
    st.lensHi = 0;
    if (top === B.STONE || top === B.GRANITE) {
      st.soil = top;
      st.soilEnd = 0;
      st.sub = top;
      st.rockHead = 1;
      st.bandStart = 1;
      st.rock = top;
      return st;
    }
    // Topsoil: thinner on hill slopes, sand/mud/gravel horizons at the pond.
    let soilEnd: number;
    if (top === B.SAND) {
      st.soil = B.SAND;
      soilEnd = 2 + Math.round(2 * u1);
    } else if (top === B.MUD) {
      st.soil = B.MUD;
      soilEnd = 2 + Math.round(u1);
    } else if (top === B.GRAVEL) {
      st.soil = B.GRAVEL;
      soilEnd = 2 + Math.round(2 * u1);
    } else {
      st.soil = B.DIRT;
      const deep = lerp(3 + 3 * u1, 1 + 2 * u1, hills); // 3–6 voxels in the lowlands, 1–3 in the hills
      soilEnd = Math.max(1, Math.round(top === B.MOSS ? deep * 0.5 : deep));
    }
    st.soilEnd = soilEnd;
    // Subsoil: clay in the lowlands, weathered gravel in the hills; rock comes close to the surface in the hills.
    const lowRock = 12 + Math.round(8 * u2);
    const hillRock = soilEnd + 1 + Math.round(3 * u2);
    const rockHead = Math.min(STRATA_DEPTH - 2, Math.max(soilEnd + 1, Math.round(lerp(lowRock, hillRock, hills))));
    st.rockHead = rockHead;
    st.sub = hills > 0.5 ? B.GRAVEL : B.CLAY;
    st.bandStart = Math.max(soilEnd + 1, rockHead - 1 - Math.round(2 * (0.5 + 0.5 * n3)));
    // Lenses of gravel (or sand near the pond) inside the subsoil, at a smoothly varying depth.
    const lensN = this.nSoil(x * (1 / 29) - 151.2, z * (1 / 29) + 77.7);
    if (lensN > 0.22 && hills < 0.5) {
      const half = (lensN - 0.22) * 5;
      const c = soilEnd + 3 + 6 * (0.5 + 0.5 * this.nSoil(x * (1 / 47) + 19.9, z * (1 / 47) + 203.1));
      st.lensLo = Math.max(soilEnd + 1, Math.round(c - half));
      st.lensHi = Math.min(rockHead - 1, Math.round(c + half));
      const pdx = x - this.pond.x;
      const pdz = z - this.pond.z;
      const nearPond = pdx * pdx + pdz * pdz < 4 * this.pond.a * this.pond.a;
      st.lens = nearPond || n3 > 0.45 ? B.SAND : B.GRAVEL;
    }
    // Granite bodies in the hills, starting a little below the rock head.
    if (hills > 0.5 && this.graniteAt(x, z)) {
      st.rock = B.GRANITE;
      st.rockEnd = STRATA_DEPTH;
    }
    return st;
  }

  /** Plant block for a natural top block at (x, z), or AIR (deterministic per column). */
  plantFor(w: VoxelWriter, x: number, z: number, y: number, top: number, s: ColumnSample): number {
    const hsh = hash2(x, z, this.hashSalt);
    const u = (hsh & 0xffff) * (1 / 65536);
    const v = (hsh >>> 16) * (1 / 65536);
    if (top === B.MUD || top === B.SAND) {
      const rho = this.pondRho(x, z);
      if (rho < 1.2) return this.reedPatch(x, z) > -0.1 && u < 0.4 ? B.REEDS : v < 0.05 ? B.TALL_GRASS : B.AIR;
      return v < 0.06 ? B.TALL_GRASS : B.AIR;
    }
    const wt = s.weights;
    const biome = this.ditherBiome(x, z, wt[0], wt[1], wt[2], wt[3]);
    if (biome === BIOME_MEADOW) {
      if (top !== B.GRASS) return B.AIR;
      const patch = this.nFlora(x * (1 / 55), z * (1 / 55));
      const clump = this.nFlora(x * (1 / 9) + 13.1, z * (1 / 9) - 7.7);
      const flowers = patch > 0.25 ? (clump > 0.05 ? 0.1 + 0.6 * (patch - 0.25) : 0.02) : 0.012;
      if (u < flowers) return this.flowerAt(x, z);
      const grass = 0.25 + 0.15 * (0.5 + 0.5 * this.nFlora(x * (1 / 30) - 51.3, z * (1 / 30) + 9.2));
      return v < grass ? B.TALL_GRASS : B.AIR;
    }
    if (biome === BIOME_FOREST) {
      const fern = this.nFlora(x * (1 / 40) + 77.1, z * (1 / 40) - 31.4);
      if (top === B.LITTER) {
        if (u > 0.955 && nearWood(w, x, y, z)) return B.MUSHROOM;
        if (fern > 0.22 && u < 0.5 * (fern - 0.1)) return B.FERN;
        return v < 0.035 ? B.TALL_GRASS : B.AIR;
      }
      if (top === B.GRASS) {
        if (u < 0.02) return this.flowerAt(x, z);
        if (fern > 0.25 && u < 0.08) return B.FERN;
        return v < 0.2 ? B.TALL_GRASS : B.AIR;
      }
      if (top === B.MOSS) return u < 0.1 ? B.FERN : B.AIR;
      return B.AIR;
    }
    if (biome === BIOME_HILLS) {
      if (top === B.GRASS) return u < 0.18 ? B.DRY_GRASS : v < 0.08 ? B.TALL_GRASS : B.AIR;
      if (top === B.MOSS) return u < 0.06 ? B.DRY_GRASS : B.AIR;
      if (top === B.GRAVEL) return u < 0.03 ? B.DRY_GRASS : B.AIR;
      return B.AIR;
    }
    // Town yards (roads, sidewalks and floors are not natural tops and never get here).
    if (top !== B.GRASS) return B.AIR;
    if (u < 0.015) return this.flowerAt(x, z);
    return v < 0.24 ? B.TALL_GRASS : v < 0.33 ? B.DRY_GRASS : B.AIR;
  }

  /** Reed patchiness (-1..1) around the pond. */
  reedPatch(x: number, z: number): number {
    return this.nFlora(x * (1 / 24) - 211.7, z * (1 / 24) + 64.3);
  }

  /** True if a column hashes into the given fraction (stable per seed and salt). */
  chance(x: number, z: number, salt: number, p: number): boolean {
    return hash2(x, z, this.hashSalt ^ salt) * (1 / 4294967296) < p;
  }

  // ------------------------------------------------------------------ internals

  /** Weights + unrounded height of a column; leaves weights/dome/rho in the scratch fields. */
  private evalColumn(x: number, z: number): number {
    const wts = this.wts;
    const town = this.townWeight(x, z);
    this.dome = 0;
    let h: number;
    if (town >= 1) {
      wts[0] = 1;
      wts[1] = 0;
      wts[2] = 0;
      wts[3] = 0;
      h = TOWN_GROUND_Y;
    } else {
      this.naturalWeights(x, z);
      const rest = 1 - town;
      const w1 = this.natF * rest;
      const w2 = this.natM * rest;
      const w3 = this.natH * rest;
      wts[0] = town;
      wts[1] = w1;
      wts[2] = w2;
      wts[3] = w3;
      h = town * TOWN_GROUND_Y;
      if (w1 > 0) h += w1 * this.forestHeight(x, z);
      if (w2 > 0) h += w2 * this.meadowHeight(x, z);
      if (w3 > 0) h += w3 * this.hillsHeight(x, z, this.hillsDepth);
    }
    const rho = this.pondRho(x, z);
    this.rho = rho;
    if (rho < POND_BANK_RHO) h = this.pondGround(x, z, h, rho);
    return h;
  }

  /** 1 inside the flat town rect, falling to 0 over ≈ 6.5–9.5 m outside its east and south edges. */
  private townWeight(x: number, z: number): number {
    const ex = x + 0.5 - TOWN_FLAT_RECT.x1;
    const ez = z + 0.5 - TOWN_FLAT_RECT.z1;
    if (ex <= 0 && ez <= 0) return 1;
    const d = ex > 0 && ez > 0 ? Math.sqrt(ex * ex + ez * ez) : Math.max(ex, ez);
    if (d >= TOWN_BLEND_MAX) return 0;
    const blend = TOWN_BLEND + TOWN_BLEND_VAR * this.nTown(x * (1 / 170), z * (1 / 170));
    return 1 - smoothstep(0, blend, d);
  }

  /** Domain-warped soft quadrants for forest (NE), meadow (SW) and hills (SE); the NW part is split diagonally. */
  private naturalWeights(x: number, z: number): void {
    const fx = x * NAT_WARP_FREQ;
    const fz = z * NAT_WARP_FREQ;
    const wx = x + NAT_WARP * fbm2(this.nWarpX, fx, fz, 2);
    const wz = z + NAT_WARP * fbm2(this.nWarpZ, fx, fz, 2);
    const sx = smoothstep(-NAT_BLEND, NAT_BLEND, wx - QUADRANT_SPLIT);
    const sz = smoothstep(-NAT_BLEND, NAT_BLEND, wz - QUADRANT_SPLIT);
    let f = sx * (1 - sz);
    let m = (1 - sx) * sz;
    const nw = (1 - sx) * (1 - sz);
    if (nw > 0) {
      const d = smoothstep(-NAT_BLEND, NAT_BLEND, wx - wz);
      f += nw * d;
      m += nw * (1 - d);
    }
    this.natF = f;
    this.natM = m;
    this.natH = sx * sz;
    this.hillsDepth = Math.min(wx, wz) - QUADRANT_SPLIT;
  }

  /** Gently rolling forest floor ≈ 116–150, rising away from the map centre. */
  private forestHeight(x: number, z: number): number {
    const ramp = 0.5 * clamp((x - QUADRANT_SPLIT) / QUADRANT_SPLIT, 0, 1) + 0.5 * clamp((QUADRANT_SPLIT - z) / QUADRANT_SPLIT, 0, 1);
    return 123 + 17 * ramp + 9 * fbm2(this.nForest, x * (1 / 340), z * (1 / 340), 2) + 1.4 * this.nBump(x * (1 / 24), z * (1 / 24));
  }

  /** Mostly flat meadow ≈ 117–125. */
  private meadowHeight(x: number, z: number): number {
    return 121 + 3.5 * fbm2(this.nMeadow, x * (1 / 420), z * (1 / 420), 2) + 0.9 * this.nBump(x * (1 / 45) + 50.3, z * (1 / 45) - 20.9);
  }

  /**
   * Rocky hills: broad domes (crests ≈ y 260–290) carrying ridged rocky detail, rising from the biome
   * border; the detail fades and the slopes relax within EDGE_SMOOTH of the map edge.
   */
  private hillsHeight(x: number, z: number, depth: number): number {
    const mask = smoothstep(-30, 240, depth);
    const dome = this.domeAt(x, z);
    this.dome = dome;
    const rocky = ridged2(this.nRoll, x * (1 / 170), z * (1 / 170), 3) - 0.45;
    const edge = Math.min(WORLD_X - x, WORLD_Z - z);
    const detail = edge < EDGE_SMOOTH ? smoothstep(0, EDGE_SMOOTH, edge) : 1;
    return 122 + mask * (16 + 146 * dome + 26 * dome * rocky * detail);
  }

  /** Hill dome profile 0..1; relaxes towards a gentle rim near the map edge so no cliff meets the edge. */
  private domeAt(x: number, z: number): number {
    const dome = smoothstep(-0.5, 0.75, fbm2(this.nHills, x * (1 / 420), z * (1 / 420), 2));
    const edge = Math.min(WORLD_X - x, WORLD_Z - z);
    if (edge >= EDGE_SMOOTH) return dome;
    const rim = 0.45 + 0.2 * this.nRoll(x * (1 / 900) + 7.7, z * (1 / 900) - 3.1);
    return lerp(rim, dome, smoothstep(0, EDGE_SMOOTH, edge));
  }

  /** Pond basin below the waterline and sloping banks up to the surrounding ground. */
  private pondGround(x: number, z: number, h: number, rho: number): number {
    if (rho >= 1) {
      const t = smoothstep(1, POND_BANK_RHO, rho);
      return lerp(POND_WATER_Y + 0.2, Math.max(h, POND_WATER_Y + 1), t);
    }
    const shape = smoothstep(0, 1, (1 - rho) / 0.72);
    const bottom = POND_WATER_Y - 0.6 - this.pond.depth * shape + 0.7 * this.nBump(x * (1 / 20) - 90.1, z * (1 / 20) + 3.3);
    return Math.min(bottom, POND_WATER_Y - 0.6);
  }

  private finishColumn(
    x: number,
    z: number,
    h: number,
    w0: number,
    w1: number,
    w2: number,
    w3: number,
    dome: number,
    rho: number,
    slope: number,
    out: ColumnSample,
  ): void {
    const surfaceY = Math.round(h);
    const ow = out.weights;
    ow[0] = w0;
    ow[1] = w1;
    ow[2] = w2;
    ow[3] = w3;
    out.biome = dominant(w0, w1, w2, w3);
    out.surfaceY = surfaceY;
    out.waterY = rho < 1 && surfaceY < POND_WATER_Y ? POND_WATER_Y : 0;
    out.topBlock = this.topBlockAt(x, z, surfaceY, w0, w1, w2, w3, dome, rho, slope);
  }

  private topBlockAt(
    x: number,
    z: number,
    surfaceY: number,
    w0: number,
    w1: number,
    w2: number,
    w3: number,
    dome: number,
    rho: number,
    slope: number,
  ): number {
    if (rho < POND_BANK_RHO) {
      const pb = this.pondTop(x, z, surfaceY, rho);
      if (pb !== B.AIR) return pb;
    }
    const biome = this.ditherBiome(x, z, w0, w1, w2, w3);
    if (biome === BIOME_FOREST) {
      const d = this.forestDensity(x, z) + 0.12 * this.nPatch(x * (1 / 13), z * (1 / 13));
      return d > LITTER_DENSITY ? B.LITTER : B.GRASS;
    }
    if (biome === BIOME_HILLS) return this.hillsTop(x, z, surfaceY, dome, slope);
    return B.GRASS;
  }

  /** Sand/mud banks and bottom, the gravel patch; AIR = no pond material here. */
  private pondTop(x: number, z: number, surfaceY: number, rho: number): number {
    if (rho < POND_SAND_RHO + 0.05) {
      const gx = x + 0.5 - this.pond.gravelX;
      const gz = z + 0.5 - this.pond.gravelZ;
      const gr = 21 + 7 * this.nPatch(x * (1 / 11) + 300.5, z * (1 / 11));
      if (gx * gx + gz * gz < gr * gr) return B.GRAVEL;
    }
    const p = this.nPatch(x * (1 / 34) - 120.7, z * (1 / 34) + 44.4);
    if (rho < 1) {
      const depth = POND_WATER_Y - surfaceY;
      if (depth > 6 + 2 * p) return B.MUD;
      return p > -0.15 ? B.SAND : B.MUD;
    }
    if (rho < POND_SAND_RHO + 0.06 * p) return p > -0.25 ? B.SAND : B.MUD;
    return B.AIR;
  }

  /** Slope-dependent hill surface: exposed rock, moss on thin soil, scree at slope feet, grass. */
  private hillsTop(x: number, z: number, surfaceY: number, dome: number, slope: number): number {
    const p = this.nPatch(x * (1 / 21) + 61.9, z * (1 / 21) - 8.4);
    const high = surfaceY > 236 ? 0.4 * smoothstep(236, 270, surfaceY) : 0;
    const rock = smoothstep(0.7, 1.3, slope) + 0.22 * p + high;
    if (rock > 0.55) return this.graniteAt(x, z) ? B.GRANITE : B.STONE;
    if (rock > 0.38) return B.MOSS;
    if (dome > 0.03 && dome < 0.3 && slope > 0.15 && slope < 0.9 && p > -0.15) return B.GRAVEL;
    return p > 0.32 ? B.MOSS : B.GRASS;
  }

  private graniteAt(x: number, z: number): boolean {
    return this.nRock(x * (1 / 95), z * (1 / 95)) > 0.15;
  }

  /** Picks one biome per column with probability = weight, in coherent patches (mixed fringes). */
  private ditherBiome(x: number, z: number, w0: number, w1: number, w2: number, w3: number): BiomeId {
    if (w0 >= 0.9999) return BIOME_TOWN;
    if (w1 >= 0.9999) return BIOME_FOREST;
    if (w2 >= 0.9999) return BIOME_MEADOW;
    if (w3 >= 0.9999) return BIOME_HILLS;
    const jitter = (hash2(x, z, this.hashSalt ^ 0x51ed) >>> 8) * (1 / 16777216) - 0.5;
    const t = clamp(0.5 + 0.6 * this.nPatch(x * (1 / 27) + 97.1, z * (1 / 27) - 13.7) + 0.16 * jitter, 0, 0.99999);
    let c = w0;
    if (t < c) return BIOME_TOWN;
    c += w1;
    if (t < c) return BIOME_FOREST;
    c += w2;
    if (t < c) return BIOME_MEADOW;
    return BIOME_HILLS;
  }

  private flowerAt(x: number, z: number): number {
    const k = this.nFlora(x * (1 / 90) + 401.3, z * (1 / 90) - 87.5);
    return k < -0.2 ? B.FLOWER_BLUE : k < 0.22 ? B.FLOWER_WHITE : B.FLOWER_YELLOW;
  }
}

/**
 * True if a log or wood voxel lies within 3 voxels of (x, y, z) at ground level. Cells beyond the tile
 * read as AIR, which only thins out mushrooms along tile edges (each column is decorated exactly once).
 */
function nearWood(w: VoxelWriter, x: number, y: number, z: number): boolean {
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      if (dx === 0 && dz === 0) continue;
      const b = w.get(x + dx, y, z + dz);
      if (b === B.OAK_LOG || b === B.BIRCH_LOG || b === B.PINE_LOG || b === B.WOOD) return true;
    }
  }
  return false;
}

/** Creates the terrain sampler for a seed (pure; safe to create in every worker). */
export function createTerrain(seed: number): TerrainSampler {
  return new NaturalTerrain(seed);
}

/** Same as createTerrain, typed with the natural-terrain extras (plan, tile generator). */
export function createNaturalTerrain(seed: number): NaturalTerrain {
  return new NaturalTerrain(seed);
}

function natural(terrain: TerrainSampler): NaturalTerrain {
  if (!(terrain instanceof NaturalTerrain)) throw new Error('fillColumn/decorateColumn need a terrain made by createTerrain()');
  return terrain;
}

/**
 * Fills one column of the tile with natural terrain: STONE from y = 0 (no bedrock voxels — y < 0 is
 * virtual bedrock), subsoil layers and lenses only within ~24 voxels below the surface (deeper = plain
 * STONE, so deep chunks stay uniform), topsoil and the biome's top block; water up to the water level.
 * In the town quadrant the ground is exactly flat at TOWN_GROUND_Y over TOWN_BUILD_RECT (+2 m).
 */
export function fillColumn(w: VoxelWriter, terrain: TerrainSampler, x: number, z: number, sample: ColumnSample): void {
  const t = natural(terrain);
  const top = Math.min(sample.surfaceY, WORLD_Y) - 1;
  if (top >= 0) {
    const st = t.prepareStrata(x, z, sample);
    const shallow = Math.max(0, top - STRATA_DEPTH);
    if (shallow > 0) w.fill(x, 0, z, x + 1, shallow, z + 1, B.STONE);
    for (let y = shallow; y <= top; y++) {
      const d = top - y;
      let id: number;
      if (d === 0) id = st.top;
      else if (d >= st.rockHead) id = d <= st.rockEnd ? st.rock : B.STONE;
      else if (d >= st.lensLo && d <= st.lensHi) id = st.lens;
      else if (d <= st.soilEnd) id = st.soil;
      else if (d < st.bandStart) id = st.sub;
      else id = B.GRAVEL;
      w.set(x, y, z, id);
    }
  }
  if (sample.waterY > sample.surfaceY) w.fill(x, Math.max(0, sample.surfaceY), z, x + 1, Math.min(sample.waterY, WORLD_Y), z + 1, B.WATER);
}

/**
 * Runs after all features: places plant blocks (tall grass, flowers, ferns, reeds, mushrooms,
 * dry grass) on suitable top voxels with AIR above, by deterministic hash rules per biome.
 * Must not place plants on roads, floors, roofs (check the actual top block via the writer).
 * Plants only ever replace AIR, never WATER: reeds go into the first AIR cell above the water surface
 * where the water is ≤ 3 voxels deep, or on MUD/SAND shoreline cells.
 */
export function decorateColumn(w: VoxelWriter, terrain: TerrainSampler, x: number, z: number, sample: ColumnSample): void {
  const t = natural(terrain);
  const s = sample.surfaceY;
  if (s <= 0 || s >= WORLD_Y) return;
  if (sample.waterY > 0) {
    const wy = sample.waterY;
    if (
      wy - s <= REED_MAX_DEPTH &&
      wy < WORLD_Y &&
      w.get(x, wy - 1, z) === B.WATER &&
      w.get(x, wy, z) === B.AIR &&
      t.reedPatch(x, z) > -0.25 &&
      t.chance(x, z, 0x7eed, 0.5)
    ) {
      w.set(x, wy, z, B.REEDS);
    }
    return;
  }
  if (w.get(x, s, z) !== B.AIR) return;
  const top = w.get(x, s - 1, z);
  if (NATURAL_TOP[top] !== 1) return;
  const plant = t.plantFor(w, x, z, s, top, sample);
  if (plant !== B.AIR && RENDER_KIND[plant] === RK.PLANT) w.set(x, s, z, plant);
}

export type { BiomeId };
