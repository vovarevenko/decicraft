import { describe, expect, test, vi } from 'vitest';
import { CHUNK, GEN_TILE, GEN_TILES_X, PLAYER, TOWN_GROUND_Y, WORLD_SEED, WORLD_X, WORLD_Y, WORLD_Z } from '../src/config';
import { FeatureIndex } from '../src/gen/nature/featureIndex';
import { CHUNKS_PER_TILE, TILE_CHUNKS, TileGenerator, type TileResult } from '../src/gen/nature/tileGenerator';
import { TileWriter } from '../src/gen/nature/tileWriter';
import { TOWN_FLAT_RECT } from '../src/gen/terrain';
import { ORDER, type Feature, type TownPlan, type VoxelWriter } from '../src/gen/types';
import { B, FOLIAGE, OPAQUE, SKY_OPAQUE, SOLID, SUP, SUPPORT } from '../src/world/blocks';

vi.mock('../src/gen/town/index', () => ({
  planTown: (): TownPlan => ({ features: [], spawns: [], landmarks: [], entrance: { x: 585, z: 585, yaw: Math.PI / 4 } }),
}));

const SEED = WORLD_SEED;
/** One shared generator: building the plan + an 8 MB tile buffer per test would be wasteful. */
const gen = new TileGenerator(SEED);

const at = (r: TileResult, cx: number, cy: number, cz: number): number | Uint8Array => r.chunks[cx + cz * TILE_CHUNKS + cy * TILE_CHUNKS * TILE_CHUNKS];

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** The first difference between two tile results, or '' when they are identical. */
function tileDiff(a: TileResult, b: TileResult): string {
  if (a.tx !== b.tx || a.tz !== b.tz) return `tiles ${a.tx},${a.tz} and ${b.tx},${b.tz}`;
  for (let i = 0; i < CHUNKS_PER_TILE; i++) {
    const ca = a.chunks[i];
    const cb = b.chunks[i];
    if (typeof ca === 'number' || typeof cb === 'number') {
      if (ca !== cb) return `chunk ${i}: ${typeof ca === 'number' ? ca : 'voxels'} vs ${typeof cb === 'number' ? cb : 'voxels'}`;
      continue;
    }
    const d = firstDiff(ca, cb);
    if (d >= 0) return `chunk ${i}, voxel ${d}`;
  }
  for (let i = 0; i < a.sky.length; i++) if (a.sky[i] !== b.sky[i] || a.canopy[i] !== b.canopy[i]) return `sky/canopy of column ${i}`;
  return '';
}

/** Wraps the tile writer and counts writes outside a feature's declared bounds. */
class BoundsChecker implements VoxelWriter {
  violations = 0;
  min: number[] = [0, 0, 0];
  max: number[] = [0, 0, 0];
  constructor(private readonly w: VoxelWriter) {}
  get x0(): number {
    return this.w.x0;
  }
  get z0(): number {
    return this.w.z0;
  }
  get x1(): number {
    return this.w.x1;
  }
  get z1(): number {
    return this.w.z1;
  }
  inTile(x: number, z: number): boolean {
    return this.w.inTile(x, z);
  }
  get(x: number, y: number, z: number): number {
    return this.w.get(x, y, z);
  }
  private check(x: number, y: number, z: number): void {
    if (x < this.min[0] || y < this.min[1] || z < this.min[2] || x >= this.max[0] || y >= this.max[1] || z >= this.max[2]) this.violations++;
  }
  set(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z);
    this.w.set(x, y, z, id);
  }
  setSoft(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z);
    this.w.setSoft(x, y, z, id);
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    this.check(x0, y0, z0);
    this.check(x1 - 1, y1 - 1, z1 - 1);
    this.w.fill(x0, y0, z0, x1, y1, z1, id);
  }
}

describe('tile writer & feature index', () => {
  test('clips to the tile, reads AIR outside and BEDROCK below', () => {
    const w = new TileWriter();
    w.reset(256, 384);
    w.set(255, 10, 400, B.STONE);
    w.set(256 + GEN_TILE, 10, 400, B.STONE);
    w.set(300, -1, 400, B.STONE);
    w.set(300, WORLD_Y, 400, B.STONE);
    expect(w.data.some((v) => v !== 0)).toBe(false);
    w.set(300, 10, 400, B.DIRT);
    expect(w.get(300, 10, 400)).toBe(B.DIRT);
    expect(w.get(255, 10, 400)).toBe(B.AIR);
    expect(w.get(300, -1, 400)).toBe(B.BEDROCK);
    expect(w.get(300, WORLD_Y, 400)).toBe(B.AIR);
    w.setSoft(300, 10, 400, B.OAK_LEAVES);
    expect(w.get(300, 10, 400)).toBe(B.DIRT);
    w.set(300, 11, 400, B.TALL_GRASS);
    w.setSoft(300, 11, 400, B.OAK_LEAVES);
    expect(w.get(300, 11, 400)).toBe(B.OAK_LEAVES);
    w.fill(250, -5, 380, 260, 3, 390, B.CLAY);
    expect(w.get(256, 0, 384)).toBe(B.CLAY);
    expect(w.get(259, 2, 389)).toBe(B.CLAY);
    expect(w.get(260, 2, 389)).toBe(B.AIR);
    expect(w.get(259, 3, 389)).toBe(B.AIR);
    w.reset(0, 0);
    expect(w.data.some((v) => v !== 0)).toBe(false);
  });

  test('lists overlapping features per tile in (order, index) order', () => {
    const f = (min: [number, number, number], max: [number, number, number], order: number): Feature => ({ kind: 't', min, max, order, stamp: () => {} });
    const features = [
      f([100, 0, 100], [140, 10, 140], ORDER.TREE), // tiles (0,0), (1,0), (0,1), (1,1)
      f([0, 0, 0], [10, 10, 10], ORDER.GROUND),
      f([120, 0, 5], [130, 10, 6], ORDER.BUILDING),
      f([-50, 0, -50], [-1, 10, -1], ORDER.TREE), // outside the world
      f([1270, 0, 1270], [1400, 10, 1400], ORDER.DECOR),
    ];
    const index = new FeatureIndex(features);
    expect([...index.featuresIn(0, 0)]).toEqual([1, 2, 0]);
    expect([...index.featuresIn(1, 0)]).toEqual([2, 0]);
    expect([...index.featuresIn(1, 1)]).toEqual([0]);
    expect([...index.featuresIn(GEN_TILES_X - 1, GEN_TILES_X - 1)]).toEqual([4]);
  });
});

describe('tile generator', () => {
  test('deterministic: two generator instances produce identical tiles, in any order', () => {
    // A forest tile (dense crowns across tile borders) and a hills tile (pines, boulders, tors).
    const tiles = [[7, 2], [8, 8]];
    const a = tiles.map(([tx, tz]) => gen.generate(tx, tz));
    // The second instance (another worker) generates them in reverse order: no state carries over.
    const other = new TileGenerator(SEED);
    const b = [...tiles].reverse().map(([tx, tz]) => other.generate(tx, tz)).reverse();
    for (let i = 0; i < tiles.length; i++) expect(tileDiff(a[i], b[i]), `tile ${tiles[i]}`).toBe('');
  });

  test('every feature writes only inside its declared bounds', () => {
    const checker = new BoundsChecker(gen.writer);
    const index = new FeatureIndex(gen.plan.features);
    let stamped = 0;
    for (const [tx, tz] of [[7, 2], [8, 1], [5, 5], [8, 8], [7, 6], [2, 7], [9, 0], [5, 9]]) {
      gen.begin(tx, tz);
      gen.fillTerrain();
      for (const i of index.featuresIn(tx, tz)) {
        const f = gen.plan.features[i];
        checker.min = f.min;
        checker.max = f.max;
        f.stamp(checker, { seed: SEED, terrain: gen.terrain });
        stamped++;
      }
    }
    expect(stamped).toBeGreaterThan(25);
    expect(checker.violations).toBe(0);
  });

  test('the player spawn box (0.6 × 1.8 m) is clear and stands on the ground', () => {
    const s = gen.plan.playerSpawn;
    gen.generate(Math.floor(s.x / GEN_TILE), Math.floor(s.z / GEN_TILE));
    const w = gen.writer;
    for (let y = s.y; y < s.y + PLAYER.height; y++) {
      for (let z = s.z - PLAYER.halfWidth; z < s.z + PLAYER.halfWidth; z++) {
        for (let x = s.x - PLAYER.halfWidth; x < s.x + PLAYER.halfWidth; x++) {
          const id = w.get(Math.floor(x), y, Math.floor(z));
          expect(SOLID[id] || FOLIAGE[id], `blocked at ${x},${y},${z}`).toBe(0);
        }
      }
    }
    expect(SOLID[w.get(Math.floor(s.x), s.y - 1, Math.floor(s.z))]).toBe(1);
    expect(s.y).toBe(TOWN_GROUND_Y);
  });

  test('no trees in the water or on the flat town ground', () => {
    const data = gen.writer.data;
    const isTreeVoxel = (id: number): boolean => SUPPORT[id] === SUP.STRUCT || FOLIAGE[id] === 1;
    // Terrain and features only: decoration (plants) and extraction add no wood or foliage.
    const stamp = (tx: number, tz: number): void => {
      gen.begin(tx, tz);
      gen.fillTerrain();
      gen.stampFeatures();
    };
    // Every tile the pond reaches: nothing grows out of the water.
    const t = gen.terrain;
    const p = t.pond;
    const pondTiles = new Set<number>();
    for (let z = Math.max(0, Math.floor(p.z - p.reach)); z < Math.min(WORLD_Z, p.z + p.reach); z += 2) {
      for (let x = Math.max(0, Math.floor(p.x - p.reach)); x < Math.min(WORLD_X, p.x + p.reach); x += 2) {
        if (t.pondRho(x, z) < 1) pondTiles.add(Math.floor(x / GEN_TILE) + Math.floor(z / GEN_TILE) * GEN_TILES_X);
      }
    }
    let water = 0;
    let overWater = 0;
    for (const k of pondTiles) {
      stamp(k % GEN_TILES_X, Math.floor(k / GEN_TILES_X));
      for (let col = 0; col < GEN_TILE * GEN_TILE; col++) {
        const base = col * WORLD_Y;
        let y = 90;
        while (y < 140 && data[base + y] !== B.WATER) y++;
        if (y === 140) continue;
        water++;
        for (let yy = y + 1; yy < y + 40; yy++) if (isTreeVoxel(data[base + yy])) overWater++;
      }
    }
    expect(water).toBeGreaterThan(10000);
    expect(overWater).toBe(0);
    // Every tile along the town's forest and meadow borders: no wood on the flat ground (town mocked empty).
    const ex = Math.floor((TOWN_FLAT_RECT.x1 - 1) / GEN_TILE);
    const ez = Math.floor((TOWN_FLAT_RECT.z1 - 1) / GEN_TILE);
    const edgeTiles: number[][] = [];
    for (let tz = 0; tz <= ez; tz++) edgeTiles.push([ex, tz]);
    for (let tx = 0; tx < ex; tx++) edgeTiles.push([tx, ez]);
    let inTown = 0;
    for (const [tx, tz] of edgeTiles) {
      stamp(tx, tz);
      const w = gen.writer;
      for (let z = w.z0; z < Math.min(w.z1, TOWN_FLAT_RECT.z1); z++) {
        for (let x = w.x0; x < Math.min(w.x1, TOWN_FLAT_RECT.x1); x++) {
          const base = (x - w.x0 + (z - w.z0) * GEN_TILE) * WORLD_Y;
          for (let y = TOWN_GROUND_Y - 6; y < TOWN_GROUND_Y + 30; y++) if (SUPPORT[data[base + y]] === SUP.STRUCT) inTown++;
        }
      }
    }
    expect(edgeTiles.length).toBeGreaterThanOrEqual(9);
    expect(inTown).toBe(0);
  });

  test('extraction: uniform chunks as ids, chunk arrays match the tile, sky/canopy match the columns', () => {
    for (const [tx, tz] of [[7, 2], [2, 7]]) {
      const r = gen.generate(tx, tz);
      const w = gen.writer;
      let uniform = 0;
      for (let cy = 0; cy < WORLD_Y / CHUNK; cy++) {
        for (let cz = 0; cz < TILE_CHUNKS; cz++) {
          for (let cx = 0; cx < TILE_CHUNKS; cx++) {
            const c = at(r, cx, cy, cz);
            for (let k = 0; k < 64; k++) {
              const lx = (k * 7) & 31;
              const ly = (k * 13) & 31;
              const lz = (k * 29) & 31;
              const v = w.get(w.x0 + cx * CHUNK + lx, cy * CHUNK + ly, w.z0 + cz * CHUNK + lz);
              expect(typeof c === 'number' ? c : c[lx + lz * CHUNK + ly * CHUNK * CHUNK]).toBe(v);
            }
            if (typeof c === 'number') uniform++;
          }
        }
      }
      // Deep stone and open sky stay uniform (the memory budget depends on it).
      expect(uniform).toBeGreaterThan(CHUNKS_PER_TILE / 2);
      expect(at(r, 0, 0, 0)).toBe(B.STONE);
      expect(at(r, 0, 15, 0)).toBe(B.AIR);
      for (let k = 0; k < 300; k++) {
        const lx = (k * 37) % GEN_TILE;
        const lz = (k * 91) % GEN_TILE;
        let canopy = 0;
        let sky = 0;
        for (let y = WORLD_Y - 1; y >= 0; y--) {
          const id = w.get(w.x0 + lx, y, w.z0 + lz);
          if (!canopy && OPAQUE[id]) canopy = y + 1;
          if (SKY_OPAQUE[id]) {
            sky = y + 1;
            break;
          }
        }
        expect(r.canopy[lx + lz * GEN_TILE]).toBe(canopy);
        expect(r.sky[lx + lz * GEN_TILE]).toBe(sky);
        expect(canopy).toBeGreaterThanOrEqual(sky);
      }
    }
  });

  test('forest tiles are wooded, with litter, ferns and shade', () => {
    const r = gen.generate(7, 2);
    let shaded = 0;
    for (let i = 0; i < r.sky.length; i++) if (r.canopy[i] > r.sky[i] + 20) shaded++;
    expect(shaded / r.sky.length).toBeGreaterThan(0.25);
    const counts = new Uint32Array(256);
    const data = gen.writer.data;
    for (let i = 0; i < data.length; i++) counts[data[i]]++;
    expect(counts[B.OAK_LEAVES]).toBeGreaterThan(0);
    expect(counts[B.LITTER]).toBeGreaterThan(1000);
    expect(counts[B.FERN]).toBeGreaterThan(50);
  });
});
