import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import { Container } from '../src/game/entities/container';
import { Door } from '../src/game/entities/door';
import { EntityManager } from '../src/game/entities/entityManager';
import { ItemDrop } from '../src/game/entities/itemDrop';
import { spawnFromPlan } from '../src/game/entities/spawn';
import { Deer } from '../src/game/mobs/deer';
import { Dog } from '../src/game/mobs/dog';
import type { EntitySpawn } from '../src/gen/types';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  const box = () => new THREE.BoxGeometry(1, 1, 1);
  return {
    getItemGeometry: () => new THREE.BoxGeometry(0.7, 0.7, 0.7),
    getDoorGeometry: (w: number, h: number) => new THREE.BoxGeometry(w, h, 0.4),
    getContainerModel: (style: string) => {
      if (style === 'fridge') throw new Error('model not ready');
      return { body: box(), lid: box(), lidPivot: [0, 4, -2], lidAxis: 'x', lidOpenAngle: -1.9, size: [6, 4, 4] };
    },
    getMobRig: () => ({
      size: { width: 3, height: 10, length: 10 },
      parts: [{ name: 'body', geometry: box(), pivot: [0, 6, 0], parent: null }],
    }),
  };
});
vi.mock('../src/render/voxelModel', async () => {
  const THREE = await import('three');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  return { getModelMaterial: () => material };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx() {
  const world = {
    // Floors are 3 voxels under the requested y (a roof would be at y + 40: topSolidY must never be used).
    floorBelow: vi.fn((_x: number, y: number) => y - 3),
    topSolidY: vi.fn(() => {
      throw new Error('topSolidY must not be used for spawning');
    }),
  };
  const parts = { world, entities: new EntityManager(new THREE.Scene()), plan: { seed: 42 } };
  return { ...parts, ctx: parts as unknown as GameContext };
}

const plan: EntitySpawn[] = [
  { type: 'door', x: 100, y: 120, z: 100, axis: 'x', width: 9, height: 20, depth: 3, hinge: 'min', swing: 1, style: 'wood' },
  { type: 'container', x: 120, y: 123, z: 130, facing: 1, style: 'crate', loot: [] },
  { type: 'item', x: 150.5, y: 124, z: 160.5, item: 'apple', count: 2 },
  { type: 'item', x: 150.5, y: 124, z: 160.5, item: 'no_such_item', count: 1 },
  { type: 'mob', mob: 'dog', x: 200, y: 121, z: 200 },
  { type: 'mob', mob: 'deer', x: 900, y: 140, z: 300 },
  { type: 'mob', mob: 'deer', x: 920, y: 140, z: 310 },
  { type: 'mob', mob: 'deer', x: 940, y: 140, z: 290 },
  { type: 'mob', mob: 'deer', x: 400, y: 125, z: 1000 },
  { type: 'mob', mob: 'deer', x: 410, y: 125, z: 1010 },
];

describe('spawnFromPlan', () => {
  test('creates every entity; items and mobs are snapped with floorBelow from the spawn y', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx, entities, world } = makeCtx();
    spawnFromPlan(ctx, plan);
    const all = entities.all;
    expect(all.filter((e) => e instanceof Door)).toHaveLength(1);
    expect(all.filter((e) => e instanceof Container)).toHaveLength(1);
    expect(all.filter((e) => e instanceof Dog)).toHaveLength(1);
    expect(all.filter((e) => e instanceof Deer)).toHaveLength(5);
    const items = all.filter((e): e is ItemDrop => e instanceof ItemDrop);
    expect(items.map((i) => [i.itemId, i.count])).toEqual([['apple', 2]]);
    expect(console.warn).toHaveBeenCalledTimes(1);

    expect(world.floorBelow).toHaveBeenCalledWith(150.5, 124, 160.5);
    expect(items[0].position.toArray()).toEqual([150.5, 121, 160.5]);
    const dog = all.find((e) => e instanceof Dog)!;
    expect(dog.position.toArray()).toEqual([200, 118, 200]);
    expect(world.topSolidY).not.toHaveBeenCalled();

    // Doors and containers are placed exactly.
    const crate = all.find((e) => e instanceof Container)!;
    expect(crate.position.toArray()).toEqual([120, 123, 130]);
    const door = all.find((e) => e instanceof Door)!;
    expect(door.position.toArray()).toEqual([104.5, 120, 101.5]);
  });

  test('nearby deer form herds', () => {
    const { ctx, entities } = makeCtx();
    spawnFromPlan(ctx, plan.filter((s) => s.type === 'mob'));
    const deer = entities.all.filter((e): e is Deer => e instanceof Deer);
    const forest = deer.filter((d) => d.position.x > 800);
    const meadow = deer.filter((d) => d.position.x < 800);
    expect(new Set(forest.map((d) => d.herd)).size).toBe(1);
    expect(new Set(meadow.map((d) => d.herd)).size).toBe(1);
    expect(forest[0].herd).not.toBe(meadow[0].herd);
    expect(forest[0].herd.members).toHaveLength(3);
    expect(meadow[0].herd.members).toHaveLength(2);
  });

  test('a spawn that fails to build is logged and skipped', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, entities } = makeCtx();
    spawnFromPlan(ctx, [
      { type: 'container', x: 0, y: 120, z: 0, facing: 0, style: 'fridge', loot: [] },
      { type: 'container', x: 10, y: 120, z: 0, facing: 0, style: 'cabinet', loot: [] },
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(entities.all).toHaveLength(1);
  });
});
