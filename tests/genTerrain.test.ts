import { describe, expect, test } from 'vitest';
import { BIOME_FOREST, BIOME_HILLS, BIOME_MEADOW, BIOME_TOWN, GEN_TILE, TOWN_BUILD_RECT, TOWN_GROUND_Y, WORLD_SEED, WORLD_X, WORLD_Y, WORLD_Z } from '../src/config';
import { TileWriter } from '../src/gen/nature/tileWriter';
import {
  createColumnSample,
  createNaturalTerrain,
  createTerrain,
  decorateColumn,
  fillColumn,
  POND_WATER_Y,
  REED_MAX_DEPTH,
  STRATA_DEPTH,
  TOWN_FLAT_RECT,
} from '../src/gen/terrain';
import type { ColumnSample, VoxelWriter } from '../src/gen/types';
import { B, RENDER_KIND, RK } from '../src/world/blocks';

/** A writer over a single column (everything else reads as AIR) — cheap for per-column tests. */
class ColumnWriter implements VoxelWriter {
  readonly data = new Uint8Array(WORLD_Y);
  x0 = 0;
  z0 = 0;
  x1 = 1;
  z1 = 1;
  at(x: number, z: number): this {
    this.x0 = x;
    this.z0 = z;
    this.x1 = x + 1;
    this.z1 = z + 1;
    this.data.fill(B.AIR);
    return this;
  }
  inTile(x: number, z: number): boolean {
    return x === this.x0 && z === this.z0;
  }
  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    return y < WORLD_Y && this.inTile(x, z) ? this.data[y] : B.AIR;
  }
  set(x: number, y: number, z: number, id: number): void {
    if (y >= 0 && y < WORLD_Y && this.inTile(x, z)) this.data[y] = id;
  }
  setSoft(x: number, y: number, z: number, id: number): void {
    const cur = this.get(x, y, z);
    if (cur === B.AIR || RENDER_KIND[cur] === RK.PLANT) this.set(x, y, z, id);
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    if (x0 <= this.x0 && x1 > this.x0 && z0 <= this.z0 && z1 > this.z0) this.data.fill(id, Math.max(0, y0), Math.min(WORLD_Y, y1));
  }
}

const SEED = WORLD_SEED;
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);

function sameSample(a: ColumnSample, b: ColumnSample): void {
  expect(b.surfaceY).toBe(a.surfaceY);
  expect(b.waterY).toBe(a.waterY);
  expect(b.topBlock).toBe(a.topBlock);
  expect(b.biome).toBe(a.biome);
  for (let i = 0; i < 4; i++) expect(b.weights[i]).toBe(a.weights[i]);
}

describe('terrain sampler', () => {
  test('deterministic across instances; surfaceY/biomeAt agree with sample()', () => {
    const a = createTerrain(SEED);
    const b = createTerrain(SEED);
    const sa = createColumnSample();
    const sb = createColumnSample();
    for (let i = 0; i < 2000; i++) {
      const x = (i * 7919) % WORLD_X;
      const z = (i * 104729) % WORLD_Z;
      a.sample(x, z, sa);
      b.sample(x, z, sb);
      sameSample(sa, sb);
      expect(a.surfaceY(x, z)).toBe(sa.surfaceY);
      expect(a.biomeAt(x, z)).toBe(sa.biome);
      const sum = sa.weights[0] + sa.weights[1] + sa.weights[2] + sa.weights[3];
      expect(sum).toBeCloseTo(1, 9);
      for (const w of sa.weights) expect(w).toBeGreaterThanOrEqual(0);
    }
    // A different seed gives a different world.
    const c = createTerrain(SEED + 1);
    let diff = 0;
    for (let i = 0; i < 200; i++) if (c.surfaceY(700 + i * 3, 900) !== a.surfaceY(700 + i * 3, 900)) diff++;
    expect(diff).toBeGreaterThan(20);
  });

  test('batch sampleArea equals per-column sample() (tiles across every biome and the pond)', () => {
    const t = createNaturalTerrain(SEED);
    const s = createColumnSample();
    const n = 24;
    const area = Array.from({ length: n * n }, createColumnSample);
    const pond = t.pond;
    for (const [x0, z0] of [[600, 600], [900, 300], [1000, 1000], [Math.floor(pond.x) - 12, Math.floor(pond.z) + 40], [WORLD_X - n, WORLD_Z - n], [0, 0]]) {
      t.sampleArea(x0, z0, n, n, area);
      for (let lz = 0; lz < n; lz++) for (let lx = 0; lx < n; lx++) sameSample(t.sample(x0 + lx, z0 + lz, s), area[lx + lz * n]);
    }
  });

  test('quadrant layout: town NW, forest NE, meadow SW, hills SE; all four meet near the centre', () => {
    const t = createTerrain(SEED);
    expect(t.biomeAt(300, 300)).toBe(BIOME_TOWN);
    expect(t.biomeAt(1000, 250)).toBe(BIOME_FOREST);
    expect(t.biomeAt(250, 1000)).toBe(BIOME_MEADOW);
    expect(t.biomeAt(1000, 1000)).toBe(BIOME_HILLS);
    const near = new Set<number>();
    for (let z = 560; z <= 720; z += 8) for (let x = 560; x <= 720; x += 8) near.add(t.biomeAt(x, z));
    expect(near.size).toBe(4);
  });

  test('town ground is exactly flat at TOWN_GROUND_Y over TOWN_BUILD_RECT + 2 m, blending out within ~10 m', () => {
    const t = createTerrain(SEED);
    const s = createColumnSample();
    for (let z = TOWN_FLAT_RECT.z0; z < TOWN_FLAT_RECT.z1; z += 3) {
      for (let x = TOWN_FLAT_RECT.x0; x < TOWN_FLAT_RECT.x1; x += 3) {
        t.sample(x, z, s);
        expect(s.surfaceY).toBe(TOWN_GROUND_Y);
        expect(s.weights[0]).toBe(1);
        expect(s.topBlock).toBe(B.GRASS);
      }
    }
    expect(TOWN_FLAT_RECT.x1 - TOWN_BUILD_RECT.x1).toBe(20);
    // Beyond the blend the town has no influence any more.
    for (let z = 0; z < TOWN_FLAT_RECT.z1 - 20; z += 17) {
      t.sample(TOWN_FLAT_RECT.x1 + 100, z, s);
      expect(s.weights[0]).toBe(0);
    }
  });

  test('heights per biome stay in their ranges; hills crests ≈ y 260–300; map edges have no cliffs', () => {
    const t = createNaturalTerrain(SEED);
    const s = createColumnSample();
    const range: Record<number, [number, number]> = { 1: [Infinity, -Infinity], 2: [Infinity, -Infinity], 3: [Infinity, -Infinity] };
    for (let z = 0; z < WORLD_Z; z += 6) {
      for (let x = 0; x < WORLD_X; x += 6) {
        t.sample(x, z, s);
        if (s.waterY > 0) continue;
        for (const b of [1, 2, 3]) {
          if (s.weights[b] < 0.999) continue;
          range[b][0] = Math.min(range[b][0], s.surfaceY);
          range[b][1] = Math.max(range[b][1], s.surfaceY);
        }
      }
    }
    expect(range[BIOME_FOREST][0]).toBeGreaterThanOrEqual(112);
    expect(range[BIOME_FOREST][1]).toBeLessThanOrEqual(155);
    expect(range[BIOME_MEADOW][0]).toBeGreaterThanOrEqual(115);
    expect(range[BIOME_MEADOW][1]).toBeLessThanOrEqual(130);
    expect(range[BIOME_HILLS][1]).toBeGreaterThanOrEqual(255);
    expect(range[BIOME_HILLS][1]).toBeLessThanOrEqual(305);
    let edgeMax = 0;
    for (let i = 600; i < WORLD_X; i += 2) {
      edgeMax = Math.max(edgeMax, t.slopeAt(i, WORLD_Z - 2), t.slopeAt(WORLD_X - 2, i), t.slopeAt(i, 1), t.slopeAt(1, i));
    }
    expect(edgeMax).toBeLessThan(1.6);
  });

  test('pond: irregular ~20×14 m, water surface at POND_WATER_Y, ≤ ~2 m deep, contained by banks', () => {
    const t = createNaturalTerrain(SEED);
    const s = createColumnSample();
    const p = t.pond;
    let water = 0;
    let maxDepth = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    const reach = Math.ceil(p.reach);
    for (let z = Math.floor(p.z - reach); z <= p.z + reach; z++) {
      for (let x = Math.floor(p.x - reach); x <= p.x + reach; x++) {
        t.sample(x, z, s);
        if (s.waterY === 0) continue;
        water++;
        expect(s.waterY).toBe(POND_WATER_Y);
        maxDepth = Math.max(maxDepth, s.waterY - s.surfaceY);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        z0 = Math.min(z0, z);
        z1 = Math.max(z1, z);
        // Containment: a neighbour is water too, or its ground reaches the water surface.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = t.sample(x + dx, z + dz, createColumnSample());
          if (n.waterY === 0) expect(n.surfaceY).toBeGreaterThanOrEqual(POND_WATER_Y);
        }
        t.sample(x, z, s);
        expect([B.SAND, B.MUD, B.GRAVEL]).toContain(s.topBlock);
      }
    }
    expect(water).toBeGreaterThan(12000); // ≥ 120 m²
    expect(water).toBeLessThan(32000); // ≤ 320 m²
    expect(maxDepth).toBeGreaterThanOrEqual(15);
    expect(maxDepth).toBeLessThanOrEqual(22);
    const long = Math.max(x1 - x0, z1 - z0);
    const short = Math.min(x1 - x0, z1 - z0);
    expect(long).toBeGreaterThan(150);
    expect(long).toBeLessThan(260);
    expect(short).toBeGreaterThan(100);
    // Sandy/muddy banks and a gravel patch around the water.
    const tops = new Set<number>();
    for (let a = 0; a < 64; a++) {
      for (let d = 0; d < reach; d++) {
        const x = Math.floor(p.x + Math.cos((a * Math.PI) / 32) * d);
        const z = Math.floor(p.z + Math.sin((a * Math.PI) / 32) * d);
        if (t.pondRho(x, z) > 1 && t.pondRho(x, z) < 1.2) tops.add(t.sample(x, z, s).topBlock);
      }
    }
    expect(tops.has(B.SAND)).toBe(true);
    expect(tops.has(B.MUD)).toBe(true);
    expect(tops.has(B.GRAVEL)).toBe(true);
  });

  test('sample() costs only a few µs', () => {
    const t = createTerrain(SEED);
    const s = createColumnSample();
    let acc = 0;
    for (let i = 0; i < 20000; i++) acc += t.sample(600 + (i % 400), 600 + Math.floor(i / 400) * 7, s).surfaceY;
    const t0 = performance.now();
    for (let i = 0; i < 40000; i++) acc += t.sample(500 + (i % 500), 500 + Math.floor(i / 500) * 9, s).surfaceY;
    const us = ((performance.now() - t0) * 1000) / 40000;
    console.info(`[gen] terrain.sample(): ${us.toFixed(2)} µs per column`);
    expect(acc).toBeGreaterThan(0);
    if (BENCH) expect(us).toBeLessThan(8);
  });
});

describe('fillColumn & decorateColumn', () => {
  const terrain = createTerrain(SEED);

  const cw = new ColumnWriter();
  const cs = createColumnSample();

  /** Fills and decorates one column into the shared single-column writer. */
  function column(x: number, z: number): { w: ColumnWriter; s: ColumnSample } {
    const w = cw.at(x, z);
    const s = terrain.sample(x, z, cs);
    fillColumn(w, terrain, x, z, s);
    decorateColumn(w, terrain, x, z, s);
    return { w, s };
  }

  test('plausible strata: top block, topsoil, subsoil/lenses only within 24 voxels, plain STONE below; no bedrock', () => {
    const w = new TileWriter();
    const seen = new Set<number>();
    for (const [x0, z0] of [[300, 300], [900, 300], [300, 1000], [1000, 1000]]) {
      w.reset(x0, z0);
      for (let i = 0; i < 64; i++) {
        const x = x0 + ((i * 37) % GEN_TILE);
        const z = z0 + ((i * 71) % GEN_TILE);
        const s = terrain.sample(x, z, createColumnSample());
        fillColumn(w, terrain, x, z, s);
        const top = s.surfaceY - 1;
        expect(w.get(x, top, z)).toBe(s.topBlock);
        expect(w.get(x, s.surfaceY, z)).toBe(s.waterY > 0 ? B.WATER : B.AIR);
        expect(w.get(x, 0, z)).toBe(B.STONE);
        for (let y = 0; y <= top; y++) {
          const id = w.get(x, y, z);
          expect(id).not.toBe(B.BEDROCK);
          expect(id).not.toBe(B.AIR);
          if (top - y > STRATA_DEPTH) expect(id).toBe(B.STONE);
          if (y < top) seen.add(id);
        }
        // Lowland columns: dark topsoil right below the grass/litter.
        if ((s.topBlock === B.GRASS || s.topBlock === B.LITTER) && s.weights[BIOME_HILLS] === 0) {
          expect(w.get(x, top - 1, z)).toBe(B.DIRT);
          expect(w.get(x, top - 3, z)).toBe(B.DIRT);
        }
        // Going down the column the ground never turns back into topsoil below the rock head.
        let rock = false;
        for (let y = top; y >= 0; y--) {
          const id = w.get(x, y, z);
          if (id === B.STONE || id === B.GRANITE) rock = true;
          else if (rock) expect([B.DIRT, B.GRASS, B.LITTER, B.MUD]).not.toContain(id);
        }
      }
    }
    // Digging reveals clay, gravel and granite somewhere across the biomes.
    expect(seen.has(B.CLAY)).toBe(true);
    expect(seen.has(B.GRAVEL)).toBe(true);
    expect(seen.has(B.GRANITE)).toBe(true);
  });

  test('pond columns hold water up to the surface; reeds only above shallow water or on mud/sand, never replacing water', () => {
    const t = createNaturalTerrain(SEED);
    const p = t.pond;
    let reeds = 0;
    for (let z = Math.floor(p.z - p.b * 1.6); z < p.z + p.b * 1.6; z += 2) {
      for (let x = Math.floor(p.x - p.a * 1.6); x < p.x + p.a * 1.6; x += 2) {
        const { w, s } = column(x, z);
        if (s.waterY > 0) {
          for (let y = s.surfaceY; y < s.waterY; y++) expect(w.get(x, y, z)).toBe(B.WATER);
          const above = w.get(x, s.waterY, z);
          if (above === B.REEDS) {
            reeds++;
            expect(s.waterY - s.surfaceY).toBeLessThanOrEqual(REED_MAX_DEPTH);
          } else expect(above).toBe(B.AIR);
        } else if (w.get(x, s.surfaceY, z) === B.REEDS) {
          reeds++;
          expect([B.MUD, B.SAND]).toContain(s.topBlock);
        }
      }
    }
    expect(reeds).toBeGreaterThan(20);
  });

  test('plants grow only on natural ground with air above, never on roads, floors or roofs', () => {
    let plants = 0;
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      const x = 50 + ((i * 7919) % 1180);
      const z = 50 + ((i * 104729) % 1180);
      const w = cw.at(x, z);
      const s = terrain.sample(x, z, cs);
      fillColumn(w, terrain, x, z, s);
      if (s.waterY > 0) continue;
      // Half of the columns get "paved" by a feature first: asphalt top, or a floor slab above.
      const variant = i % 3;
      if (variant === 1) w.set(x, s.surfaceY - 1, z, B.ASPHALT);
      if (variant === 2) w.set(x, s.surfaceY, z, B.PLANKS);
      decorateColumn(w, terrain, x, z, s);
      const id = w.get(x, s.surfaceY, z);
      if (variant === 0) {
        checked++;
        if (RENDER_KIND[id] === RK.PLANT) plants++;
        else expect(id).toBe(B.AIR);
      } else if (variant === 1) expect(id).toBe(B.AIR);
      else expect(id).toBe(B.PLANKS);
      for (let y = s.surfaceY + 1; y < WORLD_Y; y += 17) expect(w.get(x, y, z)).toBe(B.AIR);
    }
    expect(plants / checked).toBeGreaterThan(0.08);
    expect(plants / checked).toBeLessThan(0.6);
  });

  test('meadow is grassy with flower patches; forest has ferns; hills have dry grass', () => {
    const count = (x0: number, z0: number): Map<number, number> => {
      const m = new Map<number, number>();
      for (let z = z0; z < z0 + 96; z++) {
        for (let x = x0; x < x0 + 96; x++) {
          const { w, s } = column(x, z);
          const id = w.get(x, s.surfaceY, z);
          m.set(id, (m.get(id) ?? 0) + 1);
        }
      }
      return m;
    };
    const meadow = count(150, 1100);
    const grass = (meadow.get(B.TALL_GRASS) ?? 0) / (96 * 96);
    expect(grass).toBeGreaterThan(0.2);
    expect(grass).toBeLessThan(0.45);
    const flowers = (meadow.get(B.FLOWER_YELLOW) ?? 0) + (meadow.get(B.FLOWER_WHITE) ?? 0) + (meadow.get(B.FLOWER_BLUE) ?? 0);
    expect(flowers).toBeGreaterThan(20);
    expect(count(1000, 150).get(B.FERN) ?? 0).toBeGreaterThan(20);
    expect(count(1050, 1050).get(B.DRY_GRASS) ?? 0).toBeGreaterThan(10);
  });
});
