import { beforeAll, describe, expect, test, vi } from 'vitest';
import { PLAYER, TOWN_BUILD_RECT, TOWN_GROUND_Y } from '../src/config';
import { ITEMS } from '../src/game/items';
import { planTown } from '../src/gen/town/index';
import { MAIN_Z0, MAIN_Z1, SIDE_X0, SIDE_X1 } from '../src/gen/town/layout';
import type {
  ColumnSample,
  ContainerSpawn,
  DoorSpawn,
  Feature,
  GenContext,
  ItemSpawn,
  MobSpawn,
  TerrainSampler,
  TownPlan,
  VoxelWriter,
} from '../src/gen/types';
import { B, OPAQUE, RENDER_KIND, RK, SOLID, SUP, SUPPORT } from '../src/world/blocks';

// Small deterministic stand-ins for the worldgen flora that respect their bounds (tests/town.flora.test.ts runs the real one).
vi.mock('../src/gen/flora', async () => {
  const { B: blocks } = await import('../src/world/blocks');
  type P = { kind: string; x: number; y: number; z: number; seed: number; scale?: number; maxCrownRadius?: number };
  const crown = (p: P) => Math.min(p.maxCrownRadius ?? 26, p.kind === 'sapling' ? 8 : 26);
  const height = (p: P) => (p.kind === 'sapling' ? 22 : 48);
  const treeBounds = (p: P) => {
    const r = crown(p);
    return { min: [p.x - r, p.y - 4, p.z - r], max: [p.x + r + 1, p.y + height(p) + 1, p.z + r + 1] };
  };
  const stampTree = (w: VoxelWriter, p: P) => {
    const h = height(p);
    const r = crown(p);
    for (let y = p.y - 4; y < p.y + h - r / 2; y++) w.set(p.x, y, p.z, blocks.OAK_LOG);
    const cy = p.y + h - r;
    for (let dy = -r; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy * 4 + dz * dz > r * r || cy + dy < p.y + 6) continue;
          w.setSoft(p.x + dx, cy + dy, p.z + dz, blocks.OAK_LEAVES);
        }
  };
  const bushBounds = (x: number, y: number, z: number, r: number) => ({ min: [x - r, y - 1, z - r], max: [x + r + 1, y + r + 1, z + r + 1] });
  const stampBush = (w: VoxelWriter, x: number, y: number, z: number, r: number) => {
    for (let dy = 0; dy <= r; dy++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy + dz * dz <= r * r) w.setSoft(x + dx, y + dy, z + dz, blocks.BUSH);
  };
  return { treeBounds, stampTree, bushBounds, stampBush };
});

// ------------------------------------------------------------------ fake flat terrain & test world

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
/** World seed under test (override with TOWN_SEED=… to sweep seeds). */
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(env.TOWN_SEED ?? 20261103);
const CTX: GenContext = { seed: SEED, terrain: flatTerrain };
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean(env.BENCH);

const SX = 640;
const SZ = 640;
const Y0 = 100;
const SY = 160;
const idx = (x: number, y: number, z: number): number => ((y - Y0) * SZ + z) * SX + x;

interface Tile {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Clipped writer over one tile of a dense test buffer; records every write outside the feature's bounds. */
class TestWriter implements VoxelWriter {
  x0 = 0;
  z0 = 0;
  x1 = 0;
  z1 = 0;
  feature: Feature | null = null;
  readonly violations: string[] = [];

  constructor(private readonly buf: Uint8Array) {}

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
    if (!this.inTile(x, z) || y >= Y0 + SY) return B.AIR;
    if (y < Y0) return B.STONE;
    return this.buf[idx(x, y, z)];
  }

  private check(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const f = this.feature!;
    const ints = [x0, y0, z0, x1, y1, z1].every(Number.isInteger);
    const inside = x0 >= f.min[0] && y0 >= f.min[1] && z0 >= f.min[2] && x1 <= f.max[0] && y1 <= f.max[1] && z1 <= f.max[2];
    const inBuf = y0 >= Y0 && y1 <= Y0 + SY;
    if ((!ints || !inside || !inBuf) && this.violations.length < 20) {
      this.violations.push(`${f.kind}: [${x0},${y0},${z0}]–[${x1},${y1},${z1}) vs bounds [${f.min}]–[${f.max})`);
    }
  }

  set(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z, x + 1, y + 1, z + 1);
    if (this.inTile(x, z) && y >= Y0 && y < Y0 + SY) this.buf[idx(x, y, z)] = id;
  }

  setSoft(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z, x + 1, y + 1, z + 1);
    if (!this.inTile(x, z) || y < Y0 || y >= Y0 + SY) return;
    const cur = this.buf[idx(x, y, z)];
    if (cur === B.AIR || RENDER_KIND[cur] === RK.PLANT) this.buf[idx(x, y, z)] = id;
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    if (x1 <= x0 || y1 <= y0 || z1 <= z0) return;
    this.check(x0, y0, z0, x1, y1, z1);
    const ax = Math.max(x0, this.x0);
    const bx = Math.min(x1, this.x1);
    const az = Math.max(z0, this.z0);
    const bz = Math.min(z1, this.z1);
    const ay = Math.max(y0, Y0);
    const by = Math.min(y1, Y0 + SY);
    for (let y = ay; y < by; y++) for (let z = az; z < bz; z++) this.buf.fill(id, idx(ax, y, z), idx(ax, y, z) + Math.max(0, bx - ax));
  }
}

function tiling(size: number, offset: number): Tile[] {
  const tiles: Tile[] = [];
  for (let z = offset; z < SZ; z += size) {
    for (let x = offset; x < SX; x += size) {
      const t = { x0: Math.max(0, x), z0: Math.max(0, z), x1: Math.min(SX, x + size), z1: Math.min(SZ, z + size) };
      if (t.x1 > t.x0 && t.z1 > t.z0) tiles.push(t);
    }
  }
  return tiles;
}

/** Terrain + all features stamped tile by tile, features sorted by (order, index) per tile like the generator. */
function stampTown(plan: TownPlan, tiles: Tile[]): { buf: Uint8Array; violations: string[]; ms: number } {
  const buf = new Uint8Array(SX * SZ * SY);
  buf.fill(B.DIRT, 0, idx(0, TOWN_GROUND_Y - 1, 0));
  buf.fill(B.GRASS, idx(0, TOWN_GROUND_Y - 1, 0), idx(0, TOWN_GROUND_Y, 0));
  const w = new TestWriter(buf);
  const indexed = plan.features.map((f, i) => ({ f, i }));
  const t0 = performance.now();
  for (const t of tiles) {
    w.setTile(t);
    const list = indexed
      .filter(({ f }) => f.min[0] < t.x1 && f.max[0] > t.x0 && f.min[2] < t.z1 && f.max[2] > t.z0)
      .sort((a, b) => a.f.order - b.f.order || a.i - b.i);
    for (const { f } of list) {
      w.feature = f;
      f.stamp(w, CTX);
    }
  }
  return { buf, violations: w.violations, ms: performance.now() - t0 };
}

// ------------------------------------------------------------------ shared fixtures

let plan: TownPlan;
let world: Uint8Array;
let stampMs = 0;
let tilesIdentical = false;
let violations: string[] = [];
const at = (x: number, y: number, z: number): number => {
  x = Math.floor(x);
  y = Math.floor(y);
  z = Math.floor(z);
  if (x < 0 || z < 0 || x >= SX || z >= SZ || y >= Y0 + SY) return B.AIR;
  if (y < Y0) return B.STONE;
  return world[idx(x, y, z)];
};
const solid = (x: number, y: number, z: number): boolean => SOLID[at(x, y, z)] === 1;

beforeAll(() => {
  plan = planTown(CTX);
  const a = stampTown(plan, tiling(128, 0));
  const b = stampTown(plan, tiling(96, -40).reverse());
  stampMs = a.ms;
  violations = [...a.violations, ...b.violations];
  let diff = -1;
  for (let i = 0; i < a.buf.length; i++) {
    if (a.buf[i] !== b.buf[i]) {
      diff = i;
      break;
    }
  }
  tilesIdentical = diff < 0;
  if (diff >= 0) {
    const x = diff % SX;
    const z = Math.floor(diff / SX) % SZ;
    const y = Math.floor(diff / (SX * SZ)) + Y0;
    violations.push(`tilings differ first at (${x},${y},${z}): ${a.buf[diff]} vs ${b.buf[diff]}`);
  }
  world = a.buf;
}, 60_000);

const doors = (): DoorSpawn[] => plan.spawns.filter((s): s is DoorSpawn => s.type === 'door');
const containers = (): ContainerSpawn[] => plan.spawns.filter((s): s is ContainerSpawn => s.type === 'container');
const items = (): ItemSpawn[] => plan.spawns.filter((s): s is ItemSpawn => s.type === 'item');
const mobs = (): MobSpawn[] => plan.spawns.filter((s): s is MobSpawn => s.type === 'mob');

// ------------------------------------------------------------------ tests

describe('town plan', () => {
  test('is deterministic (planTown timing reported; < 30 ms asserted with BENCH)', () => {
    const snap = (p: TownPlan) => JSON.stringify({ f: p.features.map((f) => [f.kind, f.min, f.max, f.order]), s: p.spawns, l: p.landmarks, e: p.entrance });
    expect(snap(planTown(CTX))).toBe(snap(plan));
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      planTown(CTX);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    console.info(`[town] planTown median ${times[3].toFixed(2)} ms (min ${times[0].toFixed(2)}, max ${times[6].toFixed(2)})`);
    if (BENCH) expect(times[3]).toBeLessThan(30);
  });

  test('6–9 buildings of the required types, landmarks, features inside TOWN_BUILD_RECT', () => {
    const kinds = plan.features.map((f) => f.kind);
    const buildings = kinds.filter((k) => k.startsWith('building:'));
    expect(buildings.length).toBeGreaterThanOrEqual(6);
    expect(buildings.length).toBeLessThanOrEqual(9);
    for (const t of ['brick_house', 'shop', 'office', 'ruin']) expect(buildings).toContain(`building:${t}`);
    expect(buildings.filter((k) => k === 'building:wooden_house').length).toBeGreaterThanOrEqual(2);
    expect(buildings.some((k) => k === 'building:garage' || k === 'building:shed')).toBe(true);
    for (const k of ['street:main', 'street:side', 'prop:bus_stop', 'prop:bench', 'prop:car', 'prop:fence', 'prop:rubble', 'tree:apple', 'tree:sapling', 'bush'])
      expect(kinds).toContain(k);
    expect(kinds.filter((k) => k === 'prop:lamp').length).toBeGreaterThanOrEqual(2);
    const names = plan.landmarks.map((l) => l.name);
    for (const n of ['Магазин', 'Гараж', 'Остановка']) expect(names).toContain(n);
    const R = TOWN_BUILD_RECT;
    for (const f of plan.features) {
      expect(f.min[0], f.kind).toBeGreaterThanOrEqual(R.x0);
      expect(f.min[2], f.kind).toBeGreaterThanOrEqual(R.z0);
      expect(f.max[0], f.kind).toBeLessThanOrEqual(R.x1);
      expect(f.max[2], f.kind).toBeLessThanOrEqual(R.z1);
      expect(f.min[1], f.kind).toBeGreaterThanOrEqual(Y0);
      expect(f.max[1], f.kind).toBeLessThanOrEqual(Y0 + SY);
    }
  });

  test('plan invariants hold for many seeds', () => {
    const R = TOWN_BUILD_RECT;
    for (let seed = 1; seed <= 120; seed++) {
      const p = planTown({ seed: seed * 7919, terrain: flatTerrain });
      for (const f of p.features) {
        const inside = f.min[0] >= R.x0 && f.min[2] >= R.z0 && f.max[0] <= R.x1 && f.max[2] <= R.z1 && f.min[1] >= Y0 && f.max[1] <= Y0 + SY;
        expect(inside, `seed ${seed}: ${f.kind} [${f.min}]–[${f.max})`).toBe(true);
      }
      const buildings = p.features.filter((f) => f.kind.startsWith('building:')).length;
      expect(buildings >= 6 && buildings <= 9, `seed ${seed}: ${buildings} buildings`).toBe(true);
      const cs = p.spawns.filter((x): x is ContainerSpawn => x.type === 'container');
      const has = (style: string, id: string) => cs.some((c) => c.style === style && c.loot.some((l) => l.item === id));
      expect(has('toolbox', 'shovel') && has('cabinet', 'pickaxe') && has('crate', 'axe'), `seed ${seed}: tools`).toBe(true);
      for (const sp of p.spawns) {
        if (sp.type === 'container') for (const l of sp.loot) expect(ITEMS[l.item], `seed ${seed}: ${l.item}`).toBeDefined();
        if (sp.type === 'item') expect(ITEMS[sp.item], `seed ${seed}: ${sp.item}`).toBeDefined();
      }
      expect(p.spawns.filter((x) => x.type === 'door').length, `seed ${seed}: doors`).toBeGreaterThanOrEqual(15);
      expect(p.spawns.filter((x) => x.type === 'mob').length, `seed ${seed}: dogs`).toBe(2);
    }
  });

  test('stamping stays inside feature bounds and is identical for different tilings (timing reported; < 3 s asserted with BENCH)', () => {
    console.info(`[town] stamping all features (128-voxel tiles) ${stampMs.toFixed(0)} ms`);
    expect(violations).toEqual([]);
    expect(tilesIdentical).toBe(true);
    if (BENCH) expect(stampMs).toBeLessThan(3000);
  });
});

describe('spawns vs stamped voxels', () => {
  test('door openings are AIR, flanked by wall, with a lintel and a threshold', () => {
    const ds = doors();
    expect(ds.length).toBeGreaterThanOrEqual(15);
    const inOpening = (x: number, y: number, z: number) =>
      ds.some((d) => {
        const w = d.axis === 'x' ? d.width : d.depth;
        const l = d.axis === 'x' ? d.depth : d.width;
        return x >= d.x && x < d.x + w && z >= d.z && z < d.z + l && y >= d.y && y < d.y + d.height;
      });
    for (const d of ds) {
      expect(d.width === 9 || d.width === 12, 'door width').toBe(true);
      expect(d.height === 20 || d.height === 21, 'door height').toBe(true);
      const W = d.axis === 'x' ? d.width : d.depth;
      const L = d.axis === 'x' ? d.depth : d.width;
      for (let y = d.y; y < d.y + d.height; y++)
        for (let z = d.z; z < d.z + L; z++) for (let x = d.x; x < d.x + W; x++) expect(at(x, y, z), `door ${JSON.stringify(d)} at ${x},${y},${z}`).toBe(B.AIR);
      for (let k = 0; k < d.depth; k++) {
        for (let y = d.y; y < d.y + d.height; y++) {
          const a = d.axis === 'x' ? [d.x - 1, d.z + k] : [d.x + k, d.z - 1];
          const b = d.axis === 'x' ? [d.x + d.width, d.z + k] : [d.x + k, d.z + d.width];
          for (const [x, z] of [a, b]) if (!inOpening(x, y, z)) expect(solid(x, y, z), `flank of ${JSON.stringify(d)} at ${x},${y},${z}`).toBe(true);
        }
      }
      // Lintel above and a solid threshold below the middle of the opening.
      const mx = d.axis === 'x' ? d.x + (d.width >> 1) : d.x + (d.depth >> 1);
      const mz = d.axis === 'x' ? d.z + (d.depth >> 1) : d.z + (d.width >> 1);
      expect(solid(mx, d.y + d.height, mz), `lintel ${JSON.stringify(d)}`).toBe(true);
      expect(solid(mx, d.y - 1, mz), `threshold ${JSON.stringify(d)}`).toBe(true);
    }
  });

  test('containers stand on solid floor with headroom and free space in front', () => {
    const SIZE: Record<string, [number, number, number]> = { crate: [6, 4, 4], cabinet: [6, 18, 4], fridge: [6, 16, 6], toolbox: [5, 2.5, 2.5] };
    for (const c of containers()) {
      const [w, h, d] = SIZE[c.style];
      const rot = c.facing === 1 || c.facing === 3;
      const hx = (rot ? d : w) / 2;
      const hz = (rot ? w : d) / 2;
      const label = `${c.style} ${JSON.stringify(c.loot)} at ${c.x},${c.y},${c.z}`;
      for (let z = Math.floor(c.z - hz); z < Math.ceil(c.z + hz); z++) {
        for (let x = Math.floor(c.x - hx); x < Math.ceil(c.x + hx); x++) {
          expect(solid(x, c.y - 1, z), `floor under ${label}`).toBe(true);
          for (let y = c.y; y < c.y + Math.ceil(h) + 1; y++) expect(solid(x, y, z), `headroom of ${label} at ${x},${y},${z}`).toBe(false);
        }
      }
      // Two voxels in front of the box: walkable floor, 1.8 m clear.
      const fx = [0, 1, 0, -1][c.facing];
      const fz = [1, 0, -1, 0][c.facing];
      const reach = (c.facing === 0 || c.facing === 2 ? hz : hx) + 1.5;
      const px = c.x + fx * reach;
      const pz = c.z + fz * reach;
      expect(solid(px, c.y - 1, pz), `floor in front of ${label}`).toBe(true);
      for (let y = c.y; y < c.y + 18; y++) expect(solid(px, y, pz), `space in front of ${label}`).toBe(false);
    }
  });

  test('loose items rest on a solid surface', () => {
    const list = items();
    expect(list.length).toBeGreaterThan(10);
    for (const it of list) {
      expect(solid(it.x, it.y - 1, it.z), `${it.item} at ${it.x},${it.y},${it.z} has support`).toBe(true);
      expect(solid(it.x, it.y, it.z), `${it.item} at ${it.x},${it.y},${it.z} not buried`).toBe(false);
    }
  });

  test('entrance: on the road near the SE corner, 3 m clear, starter toolbox 2–4 m away in view', () => {
    const e = plan.entrance;
    const R = TOWN_BUILD_RECT;
    expect(Math.hypot(R.x1 - e.x, R.z1 - e.z)).toBeLessThan(100);
    expect(at(e.x, TOWN_GROUND_Y - 1, e.z)).toBe(B.ASPHALT);
    for (let dz = -30; dz <= 30; dz++)
      for (let dx = -30; dx <= 30; dx++) {
        if (dx * dx + dz * dz > 900) continue;
        expect(solid(e.x + dx, TOWN_GROUND_Y - 1, e.z + dz), 'ground').toBe(true);
        for (let y = TOWN_GROUND_Y + 1; y < TOWN_GROUND_Y + PLAYER.height + 2; y++) expect(solid(e.x + dx, y, e.z + dz), `clear at ${dx},${y},${dz}`).toBe(false);
      }
    for (let y = TOWN_GROUND_Y; y < TOWN_GROUND_Y + PLAYER.height; y++)
      for (let dz = -PLAYER.halfWidth; dz < PLAYER.halfWidth; dz++)
        for (let dx = -PLAYER.halfWidth; dx < PLAYER.halfWidth; dx++) expect(solid(e.x + dx, y, e.z + dz)).toBe(false);
    // Looking into the town (west-ish), towards the town centre.
    const lx = -Math.sin(e.yaw);
    const lz = -Math.cos(e.yaw);
    expect(lx).toBeLessThan(-0.5);
    const box = containers().find((c) => c.style === 'toolbox')!;
    const dx = box.x - e.x;
    const dz = box.z - e.z;
    const dist = Math.hypot(dx, dz);
    expect(dist).toBeGreaterThanOrEqual(20);
    expect(dist).toBeLessThanOrEqual(40);
    expect((dx * lx + dz * lz) / dist).toBeGreaterThan(Math.cos((35 * Math.PI) / 180));
    // Line of sight from the eye to the top of the toolbox.
    const ey = TOWN_GROUND_Y + PLAYER.eyeHeight;
    for (let i = 1; i < 100; i++) {
      const t = i / 100;
      expect(OPAQUE[at(e.x + dx * t, ey + (box.y + 2 - ey) * t, e.z + dz * t)], 'line of sight').toBe(0);
    }
  });

  test('required loot exists and every item id is valid', () => {
    const lootOf = (c: ContainerSpawn) => Object.fromEntries(c.loot.map((l) => [l.item, l.count]));
    const cs = containers();
    for (const c of cs) for (const l of c.loot) expect(ITEMS[l.item], l.item).toBeDefined();
    for (const it of items()) expect(ITEMS[it.item], it.item).toBeDefined();
    const starter = cs.filter((c) => c.style === 'toolbox');
    expect(starter.length).toBe(1);
    expect(lootOf(starter[0])).toEqual({ shovel: 1, flashlight: 1, apple: 2, newspaper: 1 });
    expect(cs.some((c) => c.style === 'cabinet' && lootOf(c).pickaxe === 1)).toBe(true);
    expect(cs.some((c) => c.style === 'crate' && lootOf(c).axe === 1)).toBe(true);
    const total = (id: string) => cs.reduce((n, c) => n + (lootOf(c)[id] ?? 0), 0) + items().filter((i) => i.item === id).reduce((n, i) => n + i.count, 0);
    const places = (id: string) => cs.filter((c) => lootOf(c)[id]).length + items().filter((i) => i.item === id).length;
    expect(total('cloth')).toBeGreaterThanOrEqual(2);
    expect(places('cloth')).toBeGreaterThanOrEqual(2);
    expect(total('torch')).toBe(2);
    expect(total('canned_food')).toBeGreaterThanOrEqual(3);
    expect(total('newspaper')).toBeGreaterThanOrEqual(3);
    expect(total('stick')).toBeGreaterThanOrEqual(3);
    expect(total('rope')).toBeGreaterThanOrEqual(1);
    expect(items().filter((i) => i.item === 'apple').length).toBeGreaterThanOrEqual(4);
    // Canned food sits in the shop: on its shelves or in its fridges.
    expect(cs.some((c) => c.style === 'fridge' && lootOf(c).canned_food > 0)).toBe(true);
  });

  test('two stray dogs on the streets', () => {
    const dogs = mobs().filter((m) => m.mob === 'dog');
    expect(dogs.length).toBe(2);
    for (const d of dogs) {
      const onMain = d.z >= MAIN_Z0 && d.z < MAIN_Z1;
      const onSide = d.x >= SIDE_X0 && d.x < SIDE_X1;
      expect(onMain || onSide).toBe(true);
      expect(d.y).toBe(TOWN_GROUND_Y);
      expect(solid(d.x, d.y, d.z)).toBe(false);
      expect(Math.hypot(d.x - plan.entrance.x, d.z - plan.entrance.z)).toBeGreaterThan(100);
    }
  });

  test('nothing floats: every structural voxel connects to the ground through STRUCT/ANCHOR voxels', () => {
    const R = TOWN_BUILD_RECT;
    const seen = new Uint8Array(world.length);
    const queue = new Int32Array(1 << 22);
    const floating: string[] = [];
    const plane = SX * SZ;
    for (let y = TOWN_GROUND_Y - 4; y < Y0 + SY; y++) {
      for (let z = R.z0; z < R.z1; z++) {
        for (let x = R.x0; x < R.x1; x++) {
          const start = idx(x, y, z);
          if (seen[start] || SUPPORT[world[start]] !== SUP.STRUCT) continue;
          // Flood the STRUCT component; it is supported if it touches an ANCHOR voxel.
          let head = 0;
          let tail = 0;
          let anchored = false;
          queue[tail++] = start;
          seen[start] = 1;
          while (head < tail) {
            const i = queue[head++];
            const ix = i % SX;
            const iz = Math.floor(i / SX) % SZ;
            const iy = Math.floor(i / plane);
            for (let k = 0; k < 6; k++) {
              const nx = ix + (k === 0 ? 1 : k === 1 ? -1 : 0);
              const nz = iz + (k === 2 ? 1 : k === 3 ? -1 : 0);
              const ny = iy + (k === 4 ? 1 : k === 5 ? -1 : 0);
              if (ny < 0) {
                anchored = true;
                continue;
              }
              if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ || ny >= SY) continue;
              const j = (ny * SZ + nz) * SX + nx;
              const sup = SUPPORT[world[j]];
              if (sup === SUP.ANCHOR) anchored = true;
              else if (sup === SUP.STRUCT && !seen[j]) {
                seen[j] = 1;
                queue[tail++] = j;
              }
            }
          }
          if (!anchored && floating.length < 10) floating.push(`${tail} voxels at ${x},${y},${z} (${world[start]})`);
        }
      }
    }
    expect(floating).toEqual([]);
  });

  test('ground materials stay on the ground: above the ground floors the only SUP.ANCHOR block is debris RUBBLE', () => {
    // An anchor on a roof, wall or piece of furniture would keep it standing after its support is gone.
    const R = TOWN_BUILD_RECT;
    const lifted: string[] = [];
    for (let y = TOWN_GROUND_Y + 4; y < Y0 + SY; y++) {
      for (let z = R.z0; z < R.z1; z++) {
        for (let x = R.x0; x < R.x1; x++) {
          const id = world[idx(x, y, z)];
          if (SUPPORT[id] === SUP.ANCHOR && id !== B.RUBBLE && lifted.length < 10) lifted.push(`block ${id} at ${x},${y},${z}`);
        }
      }
    }
    expect(lifted).toEqual([]);
  });

  test('glass is only ever set in panes, never as loose cubes', () => {
    const R = TOWN_BUILD_RECT;
    let panes = 0;
    for (let y = TOWN_GROUND_Y; y < Y0 + SY; y++) {
      for (let z = R.z0; z < R.z1; z++) {
        for (let x = R.x0; x < R.x1; x++) {
          if (world[idx(x, y, z)] !== B.GLASS) continue;
          panes++;
          const free = [at(x - 1, y, z), at(x + 1, y, z), at(x, y, z - 1), at(x, y, z + 1)].every((id) => id === B.AIR);
          expect(free && at(x, y - 1, z) === B.AIR ? 'loose' : 'held', `glass at ${x},${y},${z}`).toBe('held');
          expect(at(x, y - 1, z) !== B.AIR || at(x, y + 1, z) !== B.AIR || !free, `glass at ${x},${y},${z}`).toBe(true);
        }
      }
    }
    expect(panes).toBeGreaterThan(200);
  });

  test('a player-sized body (0.6 × 0.6 × 1.8 m) walks from the entrance with ≤ 4-voxel steps to every door, container and ground item', () => {
    const R = TOWN_BUILD_RECT;
    const x0 = R.x0 - 10;
    const z0 = R.z0 - 10;
    const nx = R.x1 - R.x0 + 20;
    const nz = R.z1 - R.z0 + 20;
    const H = PLAYER.height;
    const HW = PLAYER.halfWidth;
    const STEP = 4;
    // Air runs per column, top down: [floor, ceil) with floor = first air voxel above a solid one.
    const RUNS = 16;
    const runs = new Int16Array(nx * nz * RUNS * 2).fill(-1);
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const base = (z * nx + x) * RUNS * 2;
        let ceil = Y0 + SY + H;
        let n = 0;
        for (let y = Y0 + SY - 1; y >= Y0 && n < RUNS; y--) {
          if (!SOLID[at(x0 + x, y, z0 + z)]) continue;
          if (ceil > y + 1) {
            runs[base + 2 * n] = y + 1;
            runs[base + 2 * n + 1] = ceil;
            n++;
          }
          ceil = y;
        }
      }
    }
    const fits = (c: number, y: number): boolean => {
      for (let k = 0; k < RUNS; k++) {
        const f = runs[c * RUNS * 2 + 2 * k];
        if (f < 0) return false;
        if (f <= y && runs[c * RUNS * 2 + 2 * k + 1] >= y + H) return true;
      }
      return false;
    };
    // A body centred on the voxel corner (x, z) covers the columns [x − HW, x + HW) × [z − HW, z + HW).
    const clear = (x: number, z: number, y: number): boolean => {
      for (let dz = -HW; dz < HW; dz++) for (let dx = -HW; dx < HW; dx++) if (!fits((z + dz) * nx + x + dx, y)) return false;
      return true;
    };
    const supported = (x: number, z: number, y: number): boolean => {
      for (let dz = -HW; dz < HW; dz++) {
        for (let dx = -HW; dx < HW; dx++) {
          const c = (z + dz) * nx + x + dx;
          for (let k = 0; k < RUNS; k++) if (runs[c * RUNS * 2 + 2 * k] === y) return true;
        }
      }
      return false;
    };
    // Moving onto (x, z) from height y: step up onto the highest floor within reach, else drop to the highest one below.
    const landing = (x: number, z: number, y: number): number => {
      let best = -1;
      for (let dz = -HW; dz < HW; dz++) {
        for (let dx = -HW; dx < HW; dx++) {
          const c = (z + dz) * nx + x + dx;
          for (let k = 0; k < RUNS; k++) {
            const f = runs[c * RUNS * 2 + 2 * k];
            if (f < 0) break;
            if (f <= y + STEP && f > best) best = f;
          }
        }
      }
      return best;
    };
    const keyOf = (x: number, z: number, y: number) => (y * nz + z) * nx + x;
    const seen = new Set<number>();
    const stack: number[] = [];
    const e = plan.entrance;
    const ex = Math.round(e.x) - x0;
    const ez = Math.round(e.z) - z0;
    expect(clear(ex, ez, TOWN_GROUND_Y) && supported(ex, ez, TOWN_GROUND_Y), 'body fits at the entrance').toBe(true);
    seen.add(keyOf(ex, ez, TOWN_GROUND_Y));
    stack.push(ex, ez, TOWN_GROUND_Y);
    while (stack.length) {
      const y = stack.pop()!;
      const z = stack.pop()!;
      const x = stack.pop()!;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ax = x + dx;
        const az = z + dz;
        if (ax - HW < 0 || az - HW < 0 || ax + HW > nx || az + HW > nz) continue;
        const y2 = landing(ax, az, y);
        if (y2 < 0 || y - y2 > 12) continue;
        const k = keyOf(ax, az, y2);
        if (seen.has(k) || !clear(ax, az, y2) || !supported(ax, az, y2)) continue;
        // A step up lifts the body before it moves on: head room at the old spot too.
        if (y2 > y && !clear(x, z, y2)) continue;
        seen.add(k);
        stack.push(ax, az, y2);
      }
    }
    const near = (wx: number, wz: number, y: number, r: number): boolean => {
      const cx = Math.round(wx) - x0;
      const cz = Math.round(wz) - z0;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r && seen.has(keyOf(cx + dx, cz + dz, y))) return true;
      return false;
    };
    console.info(`[town] player-sized walk: ${seen.size} body positions reached`);
    for (const d of doors()) {
      const cx = d.axis === 'x' ? d.x + d.width / 2 : d.x + d.depth / 2;
      const cz = d.axis === 'x' ? d.z + d.depth / 2 : d.z + d.width / 2;
      expect(near(cx, cz, d.y, 0), `body passes door ${JSON.stringify(d)}`).toBe(true);
    }
    for (const c of containers()) {
      const fx = [0, 1, 0, -1][c.facing];
      const fz = [1, 0, -1, 0][c.facing];
      const half = c.style === 'fridge' ? 3 : c.style === 'toolbox' ? 1.25 : 2;
      expect(near(c.x + fx * (half + HW), c.z + fz * (half + HW), c.y, 6), `body reaches ${c.style} ${JSON.stringify(c.loot)} at ${c.x},${c.y},${c.z}`).toBe(true);
    }
    // Loose items on the ground (apples, sticks) lie within 0.6 m of where one can stand.
    for (const it of items()) if (it.y === TOWN_GROUND_Y) expect(near(it.x, it.z, it.y, 6), `body reaches ${it.item} at ${it.x},${it.z}`).toBe(true);
  });
});
