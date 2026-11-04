/**
 * Loot planner: fills the containers planned by the buildings and scatters loose items on furniture
 * surfaces and under the apple trees. Guarantees the required loot of ARCHITECTURE.md §5.5:
 * the starter toolbox (shovel, flashlight, apple ×2, newspaper), the garage cabinet's pickaxe, the
 * shed crate's axe, cloth in several places, two torches, canned food in the shop, newspapers, sticks
 * and rope. Only item ids from game/items.ts are used.
 */
import type { Rng } from '../../core/rng';
import type { ContainerSpawn, ItemSpawn, LootEntry } from '../types';
import type { ContainerRole, PlannedContainer, Surface, SurfaceKind } from './building';
import { GROUND_Y } from './common';
import { distToRect, type Rect } from './frame';

export const STARTER_LOOT: readonly LootEntry[] = [
  { item: 'shovel', count: 1 },
  { item: 'flashlight', count: 1 },
  { item: 'apple', count: 2 },
  { item: 'newspaper', count: 1 },
];

/** An apple tree in a yard: trunk position and how far its crown reaches. */
export interface OrchardTree {
  x: number;
  z: number;
  crown: number;
}

const add = (c: ContainerSpawn, item: string, count: number) => {
  const e = c.loot.find((l) => l.item === item);
  if (e) e.count += count;
  else c.loot.push({ item, count });
};

const item = (s: { x: number; y: number; z: number }, id: string, count: number): ItemSpawn => ({ type: 'item', x: s.x, y: s.y, z: s.z, item: id, count });

/**
 * Fills `containers` in place and returns loose item spawns. Required loot always lands somewhere:
 * when a building lacks the preferred container role, the next best container takes it.
 */
export function planLoot(rng: Rng, containers: readonly PlannedContainer[], surfaces: readonly Surface[]): ItemSpawn[] {
  const items: ItemSpawn[] = [];
  const byRole = (role: ContainerRole) => containers.filter((c) => c.role === role).map((c) => c.spawn);
  const any = containers.filter((c) => c.role !== 'starter').map((c) => c.spawn);
  const pick = (roles: ContainerRole[]): ContainerSpawn => {
    for (const r of roles) {
      const list = byRole(r);
      if (list.length) return list[0];
    }
    return any[0];
  };
  const used = new Set<Surface>();
  const surface = (kinds: SurfaceKind[], filter: (s: Surface) => boolean = () => true): Surface | null => {
    const list = rng.shuffle(surfaces.filter((s) => kinds.includes(s.kind) && !used.has(s) && filter(s)));
    const s = list[0] ?? null;
    if (s) used.add(s);
    return s;
  };

  for (const c of byRole('starter')) for (const e of STARTER_LOOT) add(c, e.item, e.count);

  // Tools.
  add(pick(['garage_cabinet', 'office_cabinet', 'storage_crate']), 'pickaxe', 1);
  add(pick(['shed_crate', 'storage_crate', 'hall_cabinet']), 'axe', 1);

  // Torches ×2: the garage and a kitchen.
  add(pick(['garage_cabinet', 'hall_cabinet']), 'torch', 1);
  add(pick(['kitchen_cabinet', 'hall_cabinet', 'wardrobe']), 'torch', 1);

  // Rope: the shed (or garage) and a hall cabinet.
  add(pick(['shed_crate', 'garage_cabinet']), 'rope', 1);
  const hall = byRole('hall_cabinet');
  if (hall.length) add(hall[0], 'rope', 1);

  // Cloth ×3 in three places: two wardrobes and a rag left on a bed.
  const wardrobes = rng.shuffle(byRole('wardrobe'));
  add(wardrobes[0] ?? pick(['storage_crate', 'hall_cabinet', 'kitchen_cabinet']), 'cloth', 1);
  add(wardrobes[1] ?? pick(['hall_cabinet', 'kitchen_cabinet', 'office_cabinet']), 'cloth', 1);
  const bed = surface(['bed']);
  if (bed) items.push(item(bed, 'cloth', 1));
  else add(pick(['storage_crate', 'office_cabinet', 'kitchen_cabinet']), 'cloth', 1);
  for (let i = 2; i < wardrobes.length; i++) if (rng.chance(0.4)) add(wardrobes[i], 'newspaper', 1);

  // Canned food: shop fridges, the back room, shelves; kitchens may have a can.
  for (const f of byRole('shop_fridge')) add(f, 'canned_food', rng.int(2, 4));
  for (const c of byRole('storage_crate')) add(c, 'canned_food', rng.int(1, 3));
  if (!byRole('shop_fridge').length && !byRole('storage_crate').length) add(pick(['kitchen_cabinet']), 'canned_food', 2);
  for (let i = 0; i < 3; i++) {
    const s = surface(['shelf'], (x) => x.building === 'shop');
    if (s) items.push(item(s, 'canned_food', 1));
  }
  for (const c of byRole('kitchen_cabinet')) if (rng.chance(0.5)) add(c, 'canned_food', 1);

  // Newspapers: the post office, tables and counters around town.
  for (const c of byRole('post_crate')) add(c, 'newspaper', rng.int(2, 4));
  for (const c of byRole('office_cabinet')) add(c, 'newspaper', 1);
  for (let i = 0; i < 3; i++) {
    const s = surface(['table', 'counter']);
    if (s) items.push(item(s, 'newspaper', 1));
  }

  // Sticks in the shed crate (more lie under the apple trees), a coil of rope left on a workbench.
  add(pick(['shed_crate', 'hall_cabinet']), 'stick', 3);
  const bench = surface(['workbench']);
  if (bench) items.push(item(bench, 'rope', 1));

  return items;
}

/**
 * Windfall apples (2–3 per tree) and fallen twigs under the apple trees, on open ground: never on
 * paths, fences, props or bushes, never against the trunk.
 */
export function orchardItems(rng: Rng, trees: readonly OrchardTree[], blocked: readonly Rect[]): ItemSpawn[] {
  const items: ItemSpawn[] = [];
  const spot = (t: OrchardTree, reach: number): { x: number; y: number; z: number } | null => {
    for (let tries = 0; tries < 12; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(6, Math.max(7, t.crown * reach));
      const x = Math.floor(t.x + Math.cos(a) * d) + 0.5;
      const z = Math.floor(t.z + Math.sin(a) * d) + 0.5;
      if (blocked.some((r) => distToRect(x, z, r) < 1.5)) continue;
      if (trees.some((o) => Math.hypot(o.x + 0.5 - x, o.z + 0.5 - z) < 5)) continue;
      return { x, y: GROUND_Y, z };
    }
    return null;
  };
  trees.forEach((t, i) => {
    const n = rng.int(2, 4);
    for (let k = 0; k < n; k++) {
      const s = spot(t, 0.7);
      if (s) items.push(item(s, 'apple', 1));
    }
    if (i % 2 === 0) {
      const s = spot(t, 0.8);
      if (s) items.push(item(s, 'stick', rng.int(1, 3)));
    }
  });
  return items;
}
