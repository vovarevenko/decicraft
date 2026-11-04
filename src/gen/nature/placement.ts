/**
 * Placement of natural features (trees, rocks, bushes, dead wood), deer herds and natural landmarks.
 * OWNER: agent "worldgen". Deterministic for a seed: all randomness comes from one Rng consumed in a
 * fixed order, all terrain queries are pure.
 */
import { BIOME_FOREST, BIOME_HILLS, BIOME_MEADOW, WORLD_X, WORLD_Z } from '../../config';
import { clamp, smoothstep, TAU } from '../../core/math';
import { hash32, Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import {
  bushBounds,
  fallenLogBounds,
  stampBush,
  stampFallenLog,
  stampStump,
  stampTree,
  stumpBounds,
  treeBounds,
  treeCrownRadius,
  treeCrownSpan,
  type FallenLogParams,
  type StumpParams,
  type TreeKind,
  type TreeParams,
} from '../flora';
import { boulderBounds, outcropBounds, stampBoulder, stampOutcrop, type OutcropParams } from '../rocks';
import { POND_BANK_RHO, TOWN_FLAT_RECT, type NaturalTerrain } from '../terrain';
import { ORDER, type Feature, type Landmark, type MobSpawn, type TownPlan } from '../types';

export interface NaturePlan {
  features: Feature[];
  spawns: MobSpawn[];
  landmarks: Landmark[];
  /** Parameters of every planted tree (also inside `features`), for checks and debugging. */
  trees: TreeParams[];
}

/** Horizontal keep-out circle of a placed feature. */
interface Disc {
  x: number;
  z: number;
  r: number;
}

/** A rock's footprint and the height it reaches (crowns above it need not keep clear). */
interface Rock extends Disc {
  top: number;
}

interface PlacedTree {
  p: TreeParams;
  /** Desired (species) crown radius before shyness. */
  crown: number;
  /** Trunk keep-out radius incl. root flare. */
  foot: number;
  /** Crown height band [bottom, top); filled in before crown shyness. */
  span: [number, number];
}

/** Spawn keep-out radius (6 m) for every natural feature. */
const SPAWN_CLEAR = 60;
/** Gap kept between neighbouring crowns (0.3 m) and between crowns and buildings/rocks (0.5 m). */
const CROWN_GAP = 3;
const OBSTACLE_GAP = 5;
const EDGE_MARGIN = 12;

const W = [0, 0, 0, 0] as [number, number, number, number];

class NaturePlanner {
  readonly features: Feature[] = [];
  readonly trees: PlacedTree[] = [];
  readonly rocks: Rock[] = [];
  readonly bushes: Disc[] = [];
  readonly logs: Disc[] = [];
  private readonly rng: Rng;
  private readonly buildings: Feature[];

  constructor(
    readonly seed: number,
    readonly terrain: NaturalTerrain,
    town: TownPlan,
    readonly spawnX: number,
    readonly spawnZ: number,
  ) {
    this.rng = new Rng(hash32(seed ^ 0x9a7e5));
    this.buildings = town.features.filter((f) => f.order >= ORDER.BUILDING);
  }

  // ---------------------------------------------------------------- shared checks

  /** True when (x, z) lies outside the flat town area (+margin) and inside the map (−EDGE_MARGIN). */
  private inNature(x: number, z: number, margin: number): boolean {
    if (x < EDGE_MARGIN || z < EDGE_MARGIN || x >= WORLD_X - EDGE_MARGIN || z >= WORLD_Z - EDGE_MARGIN) return false;
    return x >= TOWN_FLAT_RECT.x1 + margin || z >= TOWN_FLAT_RECT.z1 + margin;
  }

  private nearSpawn(x: number, z: number, r: number): boolean {
    return Math.hypot(x - this.spawnX, z - this.spawnZ) < SPAWN_CLEAR + r;
  }

  /** Dry ground well away from the pond. */
  private dry(x: number, z: number, rho: number): boolean {
    return this.terrain.pondRho(x, z) >= rho;
  }

  private clearOf(list: readonly Disc[], x: number, z: number, r: number): boolean {
    for (const d of list) {
      const min = d.r + r;
      if ((d.x - x) * (d.x - x) + (d.z - z) * (d.z - z) < min * min) return false;
    }
    return true;
  }

  private clearOfTrees(x: number, z: number, r: number): boolean {
    for (const t of this.trees) {
      const min = t.foot + r;
      if ((t.p.x - x) * (t.p.x - x) + (t.p.z - z) * (t.p.z - z) < min * min) return false;
    }
    return true;
  }

  private clearOfBuildings(x: number, z: number, r: number): boolean {
    return distToBuildings(this.buildings, x, z) >= r;
  }

  /**
   * Dart throwing: a fine jittered grid of candidates visited in a deterministic shuffled order, so
   * accepted points (each checked against a minimum distance by the caller) end up evenly spread.
   */
  private darts(cell: number, fn: (x: number, z: number) => void): void {
    const pts: number[] = [];
    this.grid(cell, (x, z) => pts.push(x, z));
    const order: number[] = [];
    for (let i = 0; i < pts.length >> 1; i++) order.push(i);
    this.rng.shuffle(order);
    for (const i of order) fn(pts[i * 2], pts[i * 2 + 1]);
  }

  /** Jittered grid over the map: calls fn(x, z) once per cell with a deterministic jittered point. */
  private grid(cell: number, fn: (x: number, z: number) => void): void {
    const rng = this.rng;
    for (let gz = 0; gz * cell < WORLD_Z; gz++) {
      for (let gx = 0; gx * cell < WORLD_X; gx++) {
        const x = Math.floor((gx + rng.range(0.15, 0.85)) * cell);
        const z = Math.floor((gz + rng.range(0.15, 0.85)) * cell);
        fn(x, z);
      }
    }
  }

  // ---------------------------------------------------------------- rocks

  placeRocks(): void {
    const t = this.terrain;
    const rng = this.rng;
    // Tors on the hill crests.
    const outcrops: Disc[] = [];
    this.grid(150, (x, z) => {
      const roll = rng.next();
      const size = rng.range(13, 24);
      const seed = rng.nextU32();
      if (!this.inNature(x, z, 60) || this.nearSpawn(x, z, 100)) return;
      t.weightsAt(x, z, W);
      if (W[BIOME_HILLS] < 0.95 || t.hillDomeAt(x, z) < 0.5 || roll > 0.6) return;
      if (t.slopeAt(x, z, 3) > 1.6 || !this.clearOf(outcrops, x, z, size + 110)) return;
      const p: OutcropParams = { x, y: t.surfaceY(x, z), z, size, seed };
      const b = outcropBounds(p);
      outcrops.push({ x, z, r: size });
      this.rocks.push({ x, z, r: Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) * 0.5, top: b.max[1] });
      this.features.push({ kind: 'outcrop', min: b.min, max: b.max, order: ORDER.ROCK, stamp: (w) => stampOutcrop(w, p) });
    });
    // Boulders: plenty in the hills, a few mossy ones in the forest and the meadow.
    this.grid(78, (x, z) => {
      const roll = rng.next();
      const u = rng.next();
      const seed = rng.nextU32();
      if (!this.inNature(x, z, 40)) return;
      t.weightsAt(x, z, W);
      const p = 0.55 * W[BIOME_HILLS] + 0.12 * W[BIOME_FOREST] + 0.05 * W[BIOME_MEADOW];
      if (roll >= p) return;
      const hills = W[BIOME_HILLS] > 0.5;
      const r = hills ? 5 + 15 * u * u : 5 + 6 * u; // 0.5–2 m in the hills, ≤ 1.1 m elsewhere
      if (this.nearSpawn(x, z, 40 + r) || !this.dry(x, z, 1.9) || !this.clearOf(this.rocks, x, z, r * 1.6 + 12)) return;
      if (!this.clearOfBuildings(x, z, r * 1.6 + OBSTACLE_GAP)) return;
      const y = t.surfaceY(x, z);
      const b = boulderBounds(x, y, z, r);
      this.rocks.push({ x, z, r: r * 1.6, top: b.max[1] });
      this.features.push({ kind: 'boulder', min: b.min, max: b.max, order: ORDER.ROCK, stamp: (w) => stampBoulder(w, x, y, z, r, seed) });
    });
  }

  // ---------------------------------------------------------------- trees

  /** Plants a tree unless the spot is unsuitable; `spacing` = min distance from the trunk to a neighbour's root flare. */
  private tryTree(x: number, z: number, kind: TreeKind, scale: number, seed: number, maxSlope: number, spacing: number): void {
    // 2 m off the flat town ground, so roots never reach it.
    if (!this.inNature(x, z, 20) || this.nearSpawn(x, z, 0)) return;
    if (!this.dry(x, z, 1.35) || this.terrain.slopeAt(x, z, 2) > maxSlope) return;
    const foot = kind === 'sapling' ? 3 : 8 * scale + 4;
    if (!this.clearOf(this.rocks, x, z, foot + 4) || !this.clearOfTrees(x, z, spacing)) return;
    const y = this.terrain.surfaceY(x, z);
    this.trees.push({ p: { kind, x, y, z, seed, scale }, crown: treeCrownRadius(kind, scale), foot, span: [0, 0] });
  }

  placeTrees(): void {
    const t = this.terrain;
    const rng = this.rng;
    // Deciduous forest, trunks ≥ ~5.6 m apart (≈ 6.5 m on average); clearings stay open; fringes mix in birch and pine.
    this.darts(20, (x, z) => {
      const roll = rng.next();
      const species = rng.next();
      const size = rng.range(0.82, 1.12);
      const seed = rng.nextU32();
      t.weightsAt(x, z, W);
      const wf = W[BIOME_FOREST];
      if (wf < 0.05) return;
      const dens = smoothstep(0.2, 0.45, t.forestDensity(x, z));
      if (roll >= wf * dens * 0.94) return;
      const pPine = clamp(0.08 + 1.5 * W[BIOME_HILLS], 0, 0.7);
      const pBirch = 0.36 + 0.3 * (1 - wf);
      const kind: TreeKind = species < 0.03 ? 'dead' : species < 0.03 + pPine ? 'pine' : species < 0.03 + pPine + pBirch ? 'birch' : 'oak';
      this.tryTree(x, z, kind, size * (0.78 + 0.22 * wf), seed, 0.9, 46);
    });
    // Saplings and young birches in forest clearings and gaps.
    this.darts(46, (x, z) => {
      const roll = rng.next();
      const young = rng.chance(0.5);
      const size = young ? rng.range(0.6, 0.8) : rng.range(0.8, 1); // young birches 8–16 m, saplings ≈ 1.5–3.3 m
      const seed = rng.nextU32();
      t.weightsAt(x, z, W);
      const p = W[BIOME_FOREST] * (1 - smoothstep(0.2, 0.45, t.forestDensity(x, z))) * 0.22;
      if (roll >= p) return;
      this.tryTree(x, z, young ? 'birch' : 'sapling', size, seed, 0.9, young ? 40 : 12);
    });
    // Pines on the gentler hill slopes (~9–14 m apart), a few birches low down, rare dead trees.
    this.darts(40, (x, z) => {
      const roll = rng.next();
      const species = rng.next();
      const size = rng.range(0.85, 1.1);
      const seed = rng.nextU32();
      t.weightsAt(x, z, W);
      const wh = W[BIOME_HILLS];
      if (wh < 0.3) return;
      const slope = t.slopeAt(x, z, 2);
      const p = wh * (slope < 0.7 ? 0.9 : slope < 1.0 ? 0.35 : 0);
      if (roll >= p) return;
      const low = t.hillDomeAt(x, z) < 0.3;
      const kind: TreeKind = species < 0.05 ? 'dead' : low && species < 0.25 ? 'birch' : 'pine';
      this.tryTree(x, z, kind, size, seed, 1.0, 92);
    });
    // A few solitary meadow trees, away from the pond.
    this.grid(150, (x, z) => {
      const roll = rng.next();
      const oak = rng.chance(0.55);
      const size = rng.range(0.9, 1.15);
      const seed = rng.nextU32();
      t.weightsAt(x, z, W);
      if (roll >= W[BIOME_MEADOW] * 0.28 || !this.dry(x, z, 2.2)) return;
      this.tryTree(x, z, oak ? 'oak' : 'birch', size, seed, 0.6, 90);
    });
    this.applyCrownShyness();
    for (const tr of this.trees) {
      const p = tr.p;
      const b = treeBounds(p);
      this.features.push({ kind: `tree:${p.kind}`, min: b.min, max: b.max, order: ORDER.TREE, stamp: (w) => stampTree(w, p) });
    }
  }

  /**
   * Crown shyness: every tree gets a convex crown cell — its share of the space towards each
   * neighbour whose crown shares a height band (a weighted Voronoi split leaving a 0.3 m gap), and
   * half-planes keeping 0.5 m from rocks reaching the crown and from buildings, clear of the spawn and
   * inside the map. Crowns
   * grow into the gaps of their cell (asymmetric crowns). Trees whose cell is hopelessly small are dropped.
   */
  private applyCrownShyness(): void {
    for (const t of this.trees) t.span = treeCrownSpan(t.p);
    const kept: PlacedTree[] = [];
    for (const a of this.trees) {
      const ax = a.p.x + 0.5;
      const az = a.p.z + 0.5;
      const cell: number[] = [];
      let inscribed = a.crown;
      const plane = (ux: number, uz: number, dist: number): void => {
        cell.push(ux, uz, dist);
        inscribed = Math.min(inscribed, dist);
      };
      for (const b of this.trees) {
        if (b === a || b.span[0] >= a.span[1] + CROWN_GAP || a.span[0] >= b.span[1] + CROWN_GAP) continue;
        const dx = b.p.x - a.p.x;
        const dz = b.p.z - a.p.z;
        const d = Math.hypot(dx, dz);
        if (d >= a.crown + b.crown + CROWN_GAP) continue;
        plane(dx / d, dz / d, ((d - CROWN_GAP) * a.crown) / (a.crown + b.crown));
      }
      for (const r of this.rocks) {
        if (r.top + OBSTACLE_GAP <= a.span[0]) continue; // the crown is above the rock
        const d = Math.hypot(r.x - ax, r.z - az);
        if (d - r.r - OBSTACLE_GAP < a.crown) plane((r.x - ax) / d, (r.z - az) / d, d - r.r - OBSTACLE_GAP);
      }
      for (const f of this.buildings) {
        // The nearest point of a box: the whole box lies beyond the line through it, normal to the ray.
        const qx = clamp(ax, f.min[0], f.max[0]) - ax;
        const qz = clamp(az, f.min[2], f.max[2]) - az;
        const d = Math.hypot(qx, qz);
        if (d < a.crown + OBSTACLE_GAP) plane(qx / Math.max(d, 1e-6), qz / Math.max(d, 1e-6), d - OBSTACLE_GAP);
      }
      const ds = Math.hypot(this.spawnX - ax, this.spawnZ - az);
      if (ds - 30 < a.crown) plane((this.spawnX - ax) / ds, (this.spawnZ - az) / ds, ds - 30);
      if (ax - 2 < a.crown) plane(-1, 0, ax - 2);
      if (WORLD_X - 2 - ax < a.crown) plane(1, 0, WORLD_X - 2 - ax);
      if (az - 2 < a.crown) plane(0, -1, az - 2);
      if (WORLD_Z - 2 - az < a.crown) plane(0, 1, WORLD_Z - 2 - az);
      if (inscribed < (a.p.kind === 'sapling' ? 3 : 12)) continue;
      // maxCrownRadius = farthest reach of the cell within the species crown (rays every 11.25°).
      let reach = 0;
      for (let k = 0; k < 32; k++) {
        const cx = Math.cos((k * TAU) / 32);
        const cz = Math.sin((k * TAU) / 32);
        let len = a.crown;
        for (let j = 0; j < cell.length; j += 3) {
          const c = cx * cell[j] + cz * cell[j + 1];
          if (c > 1e-9) len = Math.min(len, cell[j + 2] / c);
        }
        reach = Math.max(reach, len);
      }
      a.p.crownCell = cell;
      a.p.maxCrownRadius = Math.floor(reach);
      kept.push(a);
    }
    this.trees.length = 0;
    this.trees.push(...kept);
  }

  // ---------------------------------------------------------------- bushes & dead wood

  private addBush(x: number, z: number, r: number, seed: number): boolean {
    if (!this.inNature(x, z, 10) || this.nearSpawn(x, z, r)) return false;
    if (!this.dry(x, z, 1.3) || this.terrain.slopeAt(x, z, 2) > 1.1) return false;
    if (!this.clearOfTrees(x, z, r + 4) || !this.clearOf(this.rocks, x, z, r + 3) || !this.clearOf(this.bushes, x, z, r + 6)) return false;
    if (!this.clearOfBuildings(x, z, r * 1.6 + OBSTACLE_GAP)) return false;
    const y = this.terrain.surfaceY(x, z);
    const b = bushBounds(x, y, z, r);
    this.bushes.push({ x, z, r: r * 1.4 });
    this.features.push({ kind: 'bush', min: b.min, max: b.max, order: ORDER.TREE, stamp: (w) => stampBush(w, x, y, z, r, seed) });
    return true;
  }

  placeBushes(): void {
    const t = this.terrain;
    const rng = this.rng;
    const pond = t.pond;
    // A ring of bushes on the pond banks.
    const n = rng.int(7, 11);
    const a0 = rng.range(0, TAU);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i * TAU) / n + rng.range(-0.25, 0.25);
      const target = rng.range(POND_BANK_RHO - 0.05, 2.1);
      const r = rng.range(4, 8);
      const seed = rng.nextU32();
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let d = pond.b * 0.8; d < pond.a * 3; d += 3) {
        const x = Math.floor(pond.x + ca * d);
        const z = Math.floor(pond.z + sa * d);
        if (t.pondRho(x, z) >= target) {
          this.addBush(x, z, r, seed);
          break;
        }
      }
    }
    // Understory, fringe and hill bushes.
    this.grid(96, (x, z) => {
      const roll = rng.next();
      const r = rng.range(4, 7.5);
      const seed = rng.nextU32();
      t.weightsAt(x, z, W);
      const fringe = W[BIOME_MEADOW] * (W[BIOME_FOREST] + W[BIOME_HILLS]);
      const p = 0.3 * W[BIOME_FOREST] * t.forestDensity(x, z) + 1.2 * fringe + 0.12 * W[BIOME_HILLS];
      if (roll < p) this.addBush(x, z, r, seed);
    });
  }

  placeDeadWood(): void {
    const t = this.terrain;
    const rng = this.rng;
    const barks = [B.OAK_LOG, B.OAK_LOG, B.BIRCH_LOG, B.PINE_LOG];
    this.grid(170, (x, z) => {
      const roll = rng.next();
      const len = rng.range(25, 60);
      const a = rng.range(0, TAU);
      const radius = rng.range(2, 3.5);
      const bark = barks[rng.int(0, barks.length)];
      t.weightsAt(x, z, W);
      if (roll >= 0.45 * W[BIOME_FOREST] + 0.12 * W[BIOME_HILLS]) return;
      const ax = x - (Math.cos(a) * len) / 2;
      const az = z - (Math.sin(a) * len) / 2;
      const bx = x + (Math.cos(a) * len) / 2;
      const bz = z + (Math.sin(a) * len) / 2;
      if (!this.inNature(ax, az, 15) || !this.inNature(bx, bz, 15) || this.nearSpawn(x, z, len / 2 + 20)) return;
      if (!this.dry(x, z, 1.6) || t.slopeAt(x, z, 3) > 0.5 || t.slopeAt(Math.floor(ax), Math.floor(az), 2) > 0.6) return;
      if (t.slopeAt(Math.floor(bx), Math.floor(bz), 2) > 0.6 || !this.clearOfBuildings(x, z, len / 2 + radius + 6)) return;
      for (const tr of this.trees) if (segmentDist(ax, az, bx, bz, tr.p.x, tr.p.z) < tr.foot + radius + 3) return;
      for (const list of [this.rocks, this.bushes, this.logs]) {
        for (const d of list) if (segmentDist(ax, az, bx, bz, d.x, d.z) < d.r + radius + 3) return;
      }
      const p: FallenLogParams = { ax, ay: t.surfaceY(Math.floor(ax), Math.floor(az)), az, bx, by: t.surfaceY(Math.floor(bx), Math.floor(bz)), bz, radius, bark };
      const b = fallenLogBounds(p);
      this.logs.push({ x, z, r: len / 2 + radius });
      this.features.push({ kind: 'log', min: b.min, max: b.max, order: ORDER.DECOR, stamp: (w) => stampFallenLog(w, p) });
    });
    this.grid(140, (x, z) => {
      const roll = rng.next();
      const radius = rng.range(2, 3.5);
      const height = rng.int(3, 8);
      const bark = barks[rng.int(0, barks.length)];
      const seed = rng.nextU32();
      t.weightsAt(x, z, W);
      if (roll >= 0.45 * W[BIOME_FOREST] + 0.15 * W[BIOME_HILLS]) return;
      // Root ridges reach radius·4.6 + 3 from the axis: this clearance also keeps them off the town ground.
      const clear = radius * 4.6 + 6;
      if (!this.inNature(x, z, clear) || this.nearSpawn(x, z, 20) || !this.dry(x, z, 1.6) || t.slopeAt(x, z, 2) > 0.8) return;
      if (!this.clearOfTrees(x, z, clear) || !this.clearOf(this.rocks, x, z, clear) || !this.clearOf(this.logs, x, z, clear)) return;
      if (!this.clearOf(this.bushes, x, z, clear) || !this.clearOfBuildings(x, z, clear)) return;
      const p: StumpParams = { x, y: t.surfaceY(x, z), z, radius, height, bark, seed };
      const b = stumpBounds(p);
      this.logs.push({ x, z, r: radius * 4.6 });
      this.features.push({ kind: 'stump', min: b.min, max: b.max, order: ORDER.DECOR, stamp: (w) => stampStump(w, p) });
    });
  }

  // ---------------------------------------------------------------- deer

  /** A herd of `count` deer in open ground of `biome`, ≥ 25 m from the player spawn. */
  placeHerd(biome: number, count: number, x0: number, z0: number, x1: number, z1: number, spawns: MobSpawn[]): void {
    const t = this.terrain;
    const rng = this.rng;
    const ok = (x: number, z: number): boolean => {
      t.weightsAt(x, z, W);
      return (
        W[biome] > 0.9 &&
        Math.hypot(x - this.spawnX, z - this.spawnZ) >= 300 &&
        this.dry(x, z, 2.2) &&
        t.slopeAt(x, z, 2) < 0.5 &&
        this.clearOfTrees(x, z, 8) &&
        this.clearOf(this.rocks, x, z, 6) &&
        this.clearOf(this.logs, x, z, 4) &&
        this.clearOf(this.bushes, x, z, 3)
      );
    };
    let cx = -1;
    let cz = -1;
    let best = -Infinity;
    for (let i = 0; i < 160; i++) {
      const x = Math.floor(rng.range(x0, x1));
      const z = Math.floor(rng.range(z0, z1));
      if (!ok(x, z)) continue;
      // Prefer clearings: deer graze in the open.
      const score = biome === BIOME_FOREST ? -t.forestDensity(x, z) : 0;
      if (score > best) {
        best = score;
        cx = x;
        cz = z;
        if (biome !== BIOME_FOREST || score > -0.3) break;
      }
    }
    if (cx < 0) return;
    const a0 = rng.range(0, TAU);
    for (let k = 0; k < count; k++) {
      let x = cx;
      let z = cz;
      for (let attempt = 0; attempt < 12; attempt++) {
        const a = a0 + (k * TAU) / count + rng.range(-0.5, 0.5);
        const d = k === 0 ? 0 : rng.range(14, 32);
        const px = Math.floor(cx + Math.cos(a) * d);
        const pz = Math.floor(cz + Math.sin(a) * d);
        if (ok(px, pz)) {
          x = px;
          z = pz;
          break;
        }
      }
      spawns.push({ type: 'mob', mob: 'deer', x: x + 0.5, y: t.surfaceY(x, z), z: z + 0.5 });
    }
  }

  // ---------------------------------------------------------------- landmarks

  landmarks(townCentre: { x: number; z: number }): Landmark[] {
    const t = this.terrain;
    let hx = 960;
    let hz = 960;
    let hy = -1;
    for (let z = 660; z < WORLD_Z - 40; z += 16) {
      for (let x = 660; x < WORLD_X - 40; x += 16) {
        t.weightsAt(x, z, W);
        if (W[BIOME_HILLS] < 0.9) continue;
        const y = t.surfaceY(x, z);
        if (y > hy) {
          hy = y;
          hx = x;
          hz = z;
        }
      }
    }
    let fx = 0;
    let fz = 0;
    let fn = 0;
    for (const tr of this.trees) {
      t.weightsAt(tr.p.x, tr.p.z, W);
      if (W[BIOME_FOREST] < 0.9) continue;
      fx += tr.p.x;
      fz += tr.p.z;
      fn++;
    }
    return [
      { name: 'Городок', x: townCentre.x, z: townCentre.z },
      { name: 'Лес', x: fn > 0 ? Math.round(fx / fn) : 960, z: fn > 0 ? Math.round(fz / fn) : 320 },
      { name: 'Пруд', x: Math.round(t.pond.x), z: Math.round(t.pond.z) },
      { name: 'Холмы', x: hx, z: hz },
    ];
  }
}

/** Distance from point (px, pz) to the segment (ax, az)–(bx, bz). */
function segmentDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

/** Horizontal distance from (x, z) to the nearest building footprint (Infinity if none). */
function distToBuildings(buildings: readonly Feature[], x: number, z: number): number {
  let best = Infinity;
  for (const f of buildings) {
    const dx = Math.max(f.min[0] - x, 0, x - f.max[0]);
    const dz = Math.max(f.min[2] - z, 0, z - f.max[2]);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

/**
 * Plans the natural features around the town: rocks first (trees avoid them), then trees with crown
 * shyness, bushes, fallen logs and stumps, the two deer herds and the natural landmarks.
 */
export function planNature(
  seed: number,
  terrain: NaturalTerrain,
  town: TownPlan,
  spawn: { x: number; z: number },
  townCentre: { x: number; z: number },
): NaturePlan {
  const planner = new NaturePlanner(seed, terrain, town, spawn.x, spawn.z);
  planner.placeRocks();
  planner.placeTrees();
  planner.placeBushes();
  planner.placeDeadWood();
  const spawns: MobSpawn[] = [];
  planner.placeHerd(BIOME_FOREST, 3, 700, 40, WORLD_X - 40, 580, spawns);
  planner.placeHerd(BIOME_MEADOW, 2, 60, 700, 580, WORLD_Z - 40, spawns);
  return { features: planner.features, spawns, landmarks: planner.landmarks(townCentre), trees: planner.trees.map((t) => t.p) };
}
