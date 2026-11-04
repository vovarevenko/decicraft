/**
 * The town with the real worldgen flora (no stand-ins): its apple trees, bushes and saplings stay
 * inside the town and inside their feature bounds, stamp identically for any tiling, keep their crowns
 * clear of buildings and street furniture, root on solid town voxels, and never bury the windfall
 * apples in a trunk. tests/town.test.ts covers the town itself with small stand-in trees.
 */
import { beforeAll, describe, expect, test } from 'vitest';
import { TOWN_BUILD_RECT, TOWN_GROUND_Y } from '../src/config';
import { planTown } from '../src/gen/town/index';
import type { ColumnSample, Feature, GenContext, ItemSpawn, TerrainSampler, TownPlan, VoxelWriter } from '../src/gen/types';
import { B, FOLIAGE, RENDER_KIND, RK, SOLID } from '../src/world/blocks';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean(env.BENCH);

const flatTerrain: TerrainSampler = {
  sample(_x: number, _z: number, out: ColumnSample): ColumnSample {
    out.biome = 0;
    out.weights = [1, 0, 0, 0];
    out.surfaceY = TOWN_GROUND_Y;
    out.waterY = 0;
    out.topBlock = B.GRASS;
    return out;
  },
  surfaceY: () => TOWN_GROUND_Y,
  biomeAt: () => 0,
};
const CTX: GenContext = { seed: Number(env.TOWN_SEED ?? 20261103), terrain: flatTerrain };

/** Natural ground under the flat town: GRASS on top of DIRT. */
const ground = (y: number): number => (y >= TOWN_GROUND_Y ? B.AIR : y === TOWN_GROUND_Y - 1 ? B.GRASS : B.DIRT);
const key = (x: number, y: number, z: number): number => (y * 1024 + z) * 1024 + x;
const unkey = (k: number): [number, number, number] => [k % 1024, Math.floor(k / (1024 * 1024)), Math.floor(k / 1024) % 1024];

interface Tile {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Sparse writer stamping one feature over flat ground, clipped to a tile; collects out-of-bounds writes. */
class SparseWriter implements VoxelWriter {
  x0 = 0;
  z0 = 0;
  x1 = 0;
  z1 = 0;
  readonly voxels = new Map<number, number>();
  readonly violations: string[] = [];

  constructor(private readonly f: Feature) {}

  setTile(t: Tile): void {
    this.x0 = t.x0;
    this.z0 = t.z0;
    this.x1 = t.x1;
    this.z1 = t.z1;
  }

  inTile(x: number, z: number): boolean {
    return x >= this.x0 && x < this.x1 && z >= this.z0 && z < this.z1;
  }

  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (!this.inTile(x, z)) return B.AIR;
    return this.voxels.get(key(x, y, z)) ?? ground(y);
  }

  private check(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const { min, max, kind } = this.f;
    const ints = [x0, y0, z0, x1, y1, z1].every(Number.isInteger);
    const inside = x0 >= min[0] && y0 >= min[1] && z0 >= min[2] && x1 <= max[0] && y1 <= max[1] && z1 <= max[2];
    if ((!ints || !inside) && this.violations.length < 10) this.violations.push(`${kind}: [${x0},${y0},${z0}]–[${x1},${y1},${z1}) vs bounds [${min}]–[${max})`);
  }

  set(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z, x + 1, y + 1, z + 1);
    if (this.inTile(x, z) && y >= 0) this.voxels.set(key(x, y, z), id);
  }

  setSoft(x: number, y: number, z: number, id: number): void {
    const cur = this.get(x, y, z);
    if (cur === B.AIR || RENDER_KIND[cur] === RK.PLANT) this.set(x, y, z, id);
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return;
    this.check(x0, y0, z0, x1, y1, z1);
    for (let y = Math.max(0, y0); y < y1; y++)
      for (let z = Math.max(z0, this.z0); z < Math.min(z1, this.z1); z++)
        for (let x = Math.max(x0, this.x0); x < Math.min(x1, this.x1); x++) this.voxels.set(key(x, y, z), id);
  }
}

/** Tiles of `size` voxels starting at `offset`, covering the feature's footprint. */
function tilesOver(f: Feature, size: number, offset: number): Tile[] {
  const tiles: Tile[] = [];
  const start = (a: number) => offset + Math.floor((a - offset) / size) * size;
  for (let z = start(f.min[2]); z < f.max[2]; z += size) for (let x = start(f.min[0]); x < f.max[0]; x += size) tiles.push({ x0: x, z0: z, x1: x + size, z1: z + size });
  return tiles;
}

/** Stamps one feature tile by tile (fresh RNG state is the feature's own business). */
function stampAlone(f: Feature, tiles: Tile[]): SparseWriter {
  const w = new SparseWriter(f);
  for (const t of tiles) {
    w.setTile(t);
    f.stamp(w, CTX);
  }
  return w;
}

// Dense buffer of the town's structures (everything but the overgrowth and the fences).
const SX = 640;
const SZ = 640;
const Y0 = 100;
const SY = 160;
const idx = (x: number, y: number, z: number): number => ((y - Y0) * SZ + z) * SX + x;

class DenseWriter implements VoxelWriter {
  readonly x0 = 0;
  readonly z0 = 0;
  readonly x1 = SX;
  readonly z1 = SZ;

  constructor(private readonly buf: Uint8Array) {}

  inTile(x: number, z: number): boolean {
    return x >= 0 && x < SX && z >= 0 && z < SZ;
  }

  get(x: number, y: number, z: number): number {
    if (!this.inTile(x, z) || y >= Y0 + SY) return B.AIR;
    return y < Y0 ? ground(y) : this.buf[idx(x, y, z)];
  }

  set(x: number, y: number, z: number, id: number): void {
    if (this.inTile(x, z) && y >= Y0 && y < Y0 + SY) this.buf[idx(x, y, z)] = id;
  }

  setSoft(x: number, y: number, z: number, id: number): void {
    const cur = this.get(x, y, z);
    if (cur === B.AIR || RENDER_KIND[cur] === RK.PLANT) this.set(x, y, z, id);
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = Math.max(y0, Y0); y < Math.min(y1, Y0 + SY); y++)
      for (let z = Math.max(z0, 0); z < Math.min(z1, SZ); z++) for (let x = Math.max(x0, 0); x < Math.min(x1, SX); x++) this.buf[idx(x, y, z)] = id;
  }
}

const isGrowth = (f: Feature): boolean => f.kind.startsWith('tree:') || f.kind === 'bush';

let plan: TownPlan;
let planMs = 0;
let structures: Uint8Array;
const growth = new Map<Feature, SparseWriter>();
const solidAt = (x: number, y: number, z: number): boolean => {
  if (x < 0 || z < 0 || x >= SX || z >= SZ || y >= Y0 + SY) return false;
  return SOLID[y < Y0 ? ground(y) : structures[idx(x, y, z)]] === 1;
};

beforeAll(() => {
  const times: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    plan = planTown(CTX);
    times.push(performance.now() - t0);
  }
  planMs = times.sort((a, b) => a - b)[2];
  structures = new Uint8Array(SX * SZ * SY);
  structures.fill(B.DIRT, 0, idx(0, TOWN_GROUND_Y - 1, 0));
  structures.fill(B.GRASS, idx(0, TOWN_GROUND_Y - 1, 0), idx(0, TOWN_GROUND_Y, 0));
  const dense = new DenseWriter(structures);
  const ordered = plan.features.map((f, i) => ({ f, i })).sort((a, b) => a.f.order - b.f.order || a.i - b.i);
  for (const { f } of ordered) {
    if (isGrowth(f)) growth.set(f, stampAlone(f, tilesOver(f, 128, 0)));
    else if (f.kind !== 'prop:fence') f.stamp(dense, CTX);
  }
}, 60_000);

describe('town overgrowth with the real flora', () => {
  test('planTown with real tree bounds (timing reported; < 30 ms asserted with BENCH); everything inside TOWN_BUILD_RECT', () => {
    console.info(`[town] planTown with the real flora: median ${planMs.toFixed(2)} ms`);
    if (BENCH) expect(planMs).toBeLessThan(30);
    const R = TOWN_BUILD_RECT;
    const kinds = plan.features.filter(isGrowth).map((f) => f.kind);
    expect(kinds.filter((k) => k === 'tree:apple').length).toBeGreaterThanOrEqual(4);
    expect(kinds).toContain('tree:sapling');
    expect(kinds).toContain('bush');
    for (const f of plan.features) {
      const inside = f.min[0] >= R.x0 && f.min[2] >= R.z0 && f.max[0] <= R.x1 && f.max[2] <= R.z1;
      expect(inside, `${f.kind} [${f.min}]–[${f.max})`).toBe(true);
    }
  });

  test('trees and bushes stamp inside their bounds and identically for different tilings', () => {
    for (const [f, a] of growth) {
      const b = stampAlone(f, tilesOver(f, 96, -40).reverse());
      expect([...a.violations, ...b.violations]).toEqual([]);
      expect(b.voxels.size, f.kind).toBe(a.voxels.size);
      for (const [k, id] of a.voxels) if (b.voxels.get(k) !== id) expect(`${f.kind} differs at ${unkey(k)}`).toBe('');
    }
  });

  test('apple crowns keep 0.5 m from walls, roofs, street furniture and the streets', () => {
    const near: string[] = [];
    for (const [f, w] of growth) {
      if (f.kind !== 'tree:apple') continue;
      for (const [k, id] of w.voxels) {
        if (!FOLIAGE[id]) continue;
        const [x, y, z] = unkey(k);
        if (y < TOWN_GROUND_Y + 2) continue;
        for (let dz = -5; dz <= 5; dz++)
          for (let dx = -5; dx <= 5; dx++) if (dx * dx + dz * dz < 25 && solidAt(x + dx, y, z + dz) && near.length < 10) near.push(`${f.kind} leaf at ${x},${y},${z} near ${x + dx},${z + dz}`);
      }
    }
    expect(near).toEqual([]);
  });

  test('saplings root on solid town voxels (the shop roof, the ruin debris)', () => {
    const saplings = [...growth].filter(([f]) => f.kind === 'tree:sapling');
    expect(saplings.length).toBeGreaterThanOrEqual(2);
    for (const [f, w] of saplings) {
      let low: [number, number, number] | null = null;
      for (const [k, id] of w.voxels) {
        const p = unkey(k);
        if (SOLID[id] && (!low || p[1] < low[1])) low = p;
      }
      expect(low, f.kind).not.toBeNull();
      const [x, y, z] = low!;
      expect(solidAt(x, y - 1, z), `${f.kind} root at ${x},${y},${z}`).toBe(true);
      expect(solidAt(x, y + 1, z), `${f.kind} trunk at ${x},${y + 1},${z} free of the building`).toBe(false);
    }
  });

  test('windfall apples and twigs lie on the ground or on a root, never inside a trunk', () => {
    const onGround = plan.spawns.filter((s): s is ItemSpawn => s.type === 'item' && s.y === TOWN_GROUND_Y);
    expect(onGround.filter((s) => s.item === 'apple').length).toBeGreaterThanOrEqual(4);
    const solidWithTrees = (x: number, y: number, z: number): boolean => {
      if (solidAt(x, y, z)) return true;
      for (const w of growth.values()) {
        const id = w.voxels.get(key(x, y, z));
        if (id !== undefined && SOLID[id]) return true;
      }
      return false;
    };
    for (const it of onGround) {
      const x = Math.floor(it.x);
      const z = Math.floor(it.z);
      // world.floorBelow steps up out of solid voxels: a root lifts the item a little, a trunk buries it.
      let y = it.y;
      while (y < it.y + 3 && solidWithTrees(x, y, z)) y++;
      expect(y - it.y, `${it.item} at ${it.x},${it.z}: lifted by ${y - it.y} voxels`).toBeLessThanOrEqual(2);
    }
  });
});
