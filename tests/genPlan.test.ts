import { describe, expect, test, vi } from 'vitest';
import { BIOME_FOREST, BIOME_MEADOW, TOWN_GROUND_Y, WORLD_SEED, WORLD_X, WORLD_Z } from '../src/config';
import { treeCrownSpan } from '../src/gen/flora';
import { planNature } from '../src/gen/nature/placement';
import { createWorldPlan } from '../src/gen/plan';
import { createNaturalTerrain, TOWN_FLAT_RECT } from '../src/gen/terrain';
import { ORDER, type MobSpawn, type TownPlan, type WorldPlan } from '../src/gen/types';

vi.mock('../src/gen/town/index', () => ({
  planTown: (): TownPlan => ({ features: [], spawns: [], landmarks: [], entrance: { x: 585, z: 585, yaw: Math.PI / 4 } }),
}));

const SEED = WORLD_SEED;
const ENTRANCE = { x: 585, z: 585 };
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);

/** Everything observable about a plan, minus the stamp closures. */
function snapshot(p: WorldPlan): string {
  return JSON.stringify({
    seed: p.seed,
    features: p.features.map((f) => [f.kind, f.min, f.max, f.order]),
    spawns: p.spawns,
    landmarks: p.landmarks,
    playerSpawn: p.playerSpawn,
  });
}

describe('world plan', () => {
  test('deterministic for a seed, different across seeds', () => {
    const a = createWorldPlan(SEED);
    const b = createWorldPlan(SEED);
    expect(snapshot(b)).toBe(snapshot(a));
    expect(snapshot(createWorldPlan(SEED + 1))).not.toBe(snapshot(a));
  });

  test('builds in well under 100 ms', () => {
    createWorldPlan(SEED);
    const t0 = performance.now();
    for (let i = 0; i < 3; i++) createWorldPlan(SEED + i);
    const ms = (performance.now() - t0) / 3;
    console.info(`[gen] createWorldPlan: ${ms.toFixed(1)} ms`);
    if (BENCH) expect(ms).toBeLessThan(100);
  });

  test('player spawn at the town entrance on the town ground; landmarks named', () => {
    const p = createWorldPlan(SEED);
    expect(p.playerSpawn).toEqual({ x: 585, y: TOWN_GROUND_Y, z: 585, yaw: Math.PI / 4 });
    const names = p.landmarks.map((l) => l.name);
    for (const n of ['Городок', 'Лес', 'Пруд', 'Холмы']) expect(names).toContain(n);
    for (const l of p.landmarks) {
      expect(l.x).toBeGreaterThanOrEqual(0);
      expect(l.x).toBeLessThan(WORLD_X);
      expect(l.z).toBeGreaterThanOrEqual(0);
      expect(l.z).toBeLessThan(WORLD_Z);
    }
  });

  test('features: valid bounds and orders; trees, rocks, bushes, logs and stumps all present', () => {
    const p = createWorldPlan(SEED);
    const kinds = new Map<string, number>();
    const orders = new Set<number>(Object.values(ORDER));
    for (const f of p.features) {
      for (let i = 0; i < 3; i++) expect(f.max[i]).toBeGreaterThan(f.min[i]);
      expect(orders.has(f.order)).toBe(true);
      expect(typeof f.stamp).toBe('function');
      const k = f.kind.split(':')[0];
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    expect(kinds.get('tree') ?? 0).toBeGreaterThan(60);
    expect(kinds.get('boulder') ?? 0).toBeGreaterThan(10);
    expect(kinds.get('outcrop') ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds.get('bush') ?? 0).toBeGreaterThan(5);
    expect((kinds.get('log') ?? 0) + (kinds.get('stump') ?? 0)).toBeGreaterThan(3);
  });

  test('deer: a forest herd of 3 and a meadow herd of 2, ≥ 25 m from the spawn, on the ground, apart from each other', () => {
    const p = createWorldPlan(SEED);
    const t = createNaturalTerrain(SEED);
    const deer = p.spawns.filter((s): s is MobSpawn => s.type === 'mob' && s.mob === 'deer');
    expect(deer.length).toBe(5);
    const byBiome = new Map<number, MobSpawn[]>();
    for (const d of deer) {
      expect(Math.hypot(d.x - p.playerSpawn.x, d.z - p.playerSpawn.z)).toBeGreaterThanOrEqual(250);
      expect(d.y).toBe(t.surfaceY(Math.floor(d.x), Math.floor(d.z)));
      expect(t.pondRho(Math.floor(d.x), Math.floor(d.z))).toBeGreaterThan(1.5);
      const b = t.biomeAt(Math.floor(d.x), Math.floor(d.z));
      byBiome.set(b, [...(byBiome.get(b) ?? []), d]);
    }
    expect(byBiome.get(BIOME_FOREST)?.length).toBe(3);
    expect(byBiome.get(BIOME_MEADOW)?.length).toBe(2);
    for (const herd of byBiome.values()) {
      for (const d of herd) expect(Math.hypot(d.x - herd[0].x, d.z - herd[0].z)).toBeLessThan(80);
    }
    const f = byBiome.get(BIOME_FOREST)![0];
    const m = byBiome.get(BIOME_MEADOW)![0];
    expect(Math.hypot(f.x - m.x, f.z - m.z)).toBeGreaterThan(250);
  });
});

describe('nature placement', () => {
  const terrain = createNaturalTerrain(SEED);
  const town: TownPlan = { features: [], spawns: [], landmarks: [], entrance: { ...ENTRANCE, yaw: 0 } };
  const nature = planNature(SEED, terrain, town, ENTRANCE, { x: 315, z: 315 });

  test('no trees in water, in the town flat zone, on steep slopes or near the spawn', () => {
    expect(nature.trees.length).toBeGreaterThan(60);
    for (const p of nature.trees) {
      expect(p.x >= TOWN_FLAT_RECT.x1 + 20 || p.z >= TOWN_FLAT_RECT.z1 + 20, `tree in town at ${p.x},${p.z}`).toBe(true);
      expect(terrain.pondRho(p.x, p.z), `tree in the pond at ${p.x},${p.z}`).toBeGreaterThan(1.3);
      expect(terrain.slopeAt(p.x, p.z, 2)).toBeLessThanOrEqual(1.0);
      expect(Math.hypot(p.x - ENTRANCE.x, p.z - ENTRANCE.z)).toBeGreaterThanOrEqual(60);
      expect(p.y).toBe(terrain.surfaceY(p.x, p.z));
    }
  });

  test('crown shyness: the cells of neighbouring crowns that share a height band leave ≥ 0.3 m between them', () => {
    const spans = nature.trees.map((p) => treeCrownSpan(p));
    let pairs = 0;
    for (let i = 0; i < nature.trees.length; i++) {
      const a = nature.trees[i];
      const ca = a.crownCell ?? [];
      expect(a.maxCrownRadius).toBeGreaterThan(0);
      for (let j = i + 1; j < nature.trees.length; j++) {
        const b = nature.trees[j];
        if (spans[i][0] >= spans[j][1] + 3 || spans[j][0] >= spans[i][1] + 3) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= (a.maxCrownRadius ?? 0) + (b.maxCrownRadius ?? 0) + 3) continue;
        pairs++;
        // Each tree's reach towards the other (its tightest half-plane in that direction) …
        const reach = (cell: readonly number[], ux: number, uz: number, cap: number): number => {
          let r = cap;
          for (let k = 0; k < cell.length; k += 3) {
            const c = cell[k] * ux + cell[k + 1] * uz;
            if (c > 0.999) r = Math.min(r, cell[k + 2] / c);
          }
          return r;
        };
        const ra = reach(ca, dx / d, dz / d, a.maxCrownRadius ?? Infinity);
        const rb = reach(b.crownCell ?? [], -dx / d, -dz / d, b.maxCrownRadius ?? Infinity);
        // … leaves the 0.3 m gap on the line between the trunks.
        expect(ra + rb, `trees ${i} and ${j}`).toBeLessThanOrEqual(d - 3 + 1e-6);
      }
    }
    expect(pairs).toBeGreaterThan(30);
  });

  test('keeps features clear of buildings handed in by the town', () => {
    // A fake building just inside the town's east edge: no natural feature may come near it.
    const building = { kind: 'house:test', min: [560, 120, 300] as [number, number, number], max: [590, 160, 340] as [number, number, number], order: ORDER.BUILDING, stamp: () => {} };
    const withHouse = planNature(SEED, terrain, { ...town, features: [building] }, ENTRANCE, { x: 315, z: 315 });
    for (const p of withHouse.trees) {
      for (let k = 0; k < (p.crownCell ?? []).length; k += 3) expect(Number.isFinite(p.crownCell![k + 2])).toBe(true);
      const qx = Math.min(Math.max(p.x + 0.5, 560), 590) - (p.x + 0.5);
      const qz = Math.min(Math.max(p.z + 0.5, 300), 340) - (p.z + 0.5);
      const d = Math.hypot(qx, qz);
      if (d >= (p.maxCrownRadius ?? 0) + 5) continue;
      // A half-plane facing the house must cap the crown 0.5 m short of it.
      let ok = false;
      for (let k = 0; k < p.crownCell!.length; k += 3) {
        if (Math.abs(p.crownCell![k] - qx / d) < 1e-9 && Math.abs(p.crownCell![k + 1] - qz / d) < 1e-9 && p.crownCell![k + 2] <= d - 5 + 1e-9) ok = true;
      }
      expect(ok).toBe(true);
    }
  });
});
