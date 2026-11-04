import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import { Container, CONTAINER_SLOTS } from '../src/game/entities/container';
import { makeAABB } from '../src/game/physics';
import type { ContainerSpawn, ContainerStyle, Facing, LootEntry } from '../src/gen/types';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  return {
    getContainerModel: (style: string) => ({
      body: new THREE.BoxGeometry(6, 4, 4),
      lid: style === 'cabinet' ? new THREE.BoxGeometry(6, 18, 0.2) : new THREE.BoxGeometry(6, 0.3, 4),
      lidPivot: [0, 4, -2],
      lidAxis: style === 'cabinet' ? 'y' : 'x',
      lidOpenAngle: style === 'cabinet' ? -1.8 : -1.9,
      size: [6, 4, 4],
    }),
  };
});
vi.mock('../src/render/voxelModel', async () => {
  const THREE = await import('three');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  return { getModelMaterial: () => material };
});
// A minimal slot inventory (stacks of ≤ 20), so these tests do not depend on the items-ui module.
vi.mock('../src/game/inventory', () => ({
  Inventory: class {
    readonly slots: ({ id: string; count: number } | null)[];
    constructor(size: number) {
      this.slots = new Array(size).fill(null);
    }
    add(id: string, count: number): number {
      let left = count;
      for (let i = 0; i < this.slots.length && left > 0; i++) {
        if (this.slots[i] !== null) continue;
        const n = Math.min(20, left);
        this.slots[i] = { id, count: n };
        left -= n;
      }
      return left;
    }
  },
}));

const spawn = (style: ContainerStyle, loot: LootEntry[] = [], facing: Facing = 0): ContainerSpawn => ({
  type: 'container',
  x: 50,
  y: 120,
  z: 70,
  facing,
  style,
  loot,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Container', () => {
  test('loot goes into its inventory; unknown items are skipped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = new Container(
      spawn('toolbox', [
        { item: 'shovel', count: 1 },
        { item: 'flashlight', count: 1 },
        { item: 'apple', count: 2 },
        { item: 'newspaper', count: 1 },
        { item: 'no_such_item', count: 3 },
      ]),
    );
    expect(c.inventory.slots).toHaveLength(CONTAINER_SLOTS);
    expect(c.inventory.slots.filter((s) => s !== null)).toEqual([
      { id: 'shovel', count: 1 },
      { id: 'flashlight', count: 1 },
      { id: 'apple', count: 2 },
      { id: 'newspaper', count: 1 },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(c.hint()).toBe('E — открыть ящик');
  });

  test('titles and hints per style; an empty container says so', () => {
    const cases: [ContainerStyle, string, string][] = [
      ['crate', 'Ящик', 'E — открыть ящик'],
      ['cabinet', 'Шкаф', 'E — открыть шкаф'],
      ['fridge', 'Холодильник', 'E — открыть холодильник'],
      ['toolbox', 'Ящик с инструментами', 'E — открыть ящик'],
    ];
    for (const [style, title, hint] of cases) {
      const c = new Container(spawn(style));
      expect(c.title).toBe(title);
      expect(c.displayName).toBe(title);
      expect(c.hint()).toBe(`${hint} (пусто)`);
      expect(c.solid).toBe(true);
    }
  });

  test('facing turns the model and the solid box', () => {
    for (const facing of [0, 1, 2, 3] as const) {
      const c = new Container(spawn('crate', [], facing));
      expect(c.object.rotation.y).toBeCloseTo((facing * Math.PI) / 2);
      const b = c.getBounds(makeAABB());
      const [hx, hz] = facing % 2 === 0 ? [3, 2] : [2, 3];
      expect(b).toEqual({ minX: 50 - hx, maxX: 50 + hx, minY: 120, maxY: 124, minZ: 70 - hz, maxZ: 70 + hz });
    }
  });

  test('E opens the container screen; the lid opens while it is shown and closes after', () => {
    const screen = { isOpen: false, open: vi.fn(() => (screen.isOpen = true)) };
    const audio = { play: vi.fn() };
    const ctx = { inventoryScreen: screen, audio } as unknown as GameContext;
    const c = new Container(spawn('crate', [{ item: 'cloth', count: 2 }]));
    const lid = c.object.children[1] as THREE.Mesh;
    expect(lid.position.toArray()).toEqual([0, 4, -2]);

    c.interact(ctx);
    expect(screen.open).toHaveBeenCalledWith(ctx, { title: 'Ящик', inventory: c.inventory });
    expect(audio.play).toHaveBeenCalledWith('container_open', expect.anything());
    for (let i = 0; i < 30; i++) c.update(1 / 60, ctx);
    expect(lid.rotation.x).toBeCloseTo(-1.9);

    c.interact(ctx); // already showing: ignored
    expect(screen.open).toHaveBeenCalledTimes(1);

    screen.isOpen = false;
    for (let i = 0; i < 30; i++) c.update(1 / 60, ctx);
    expect(lid.rotation.x).toBeCloseTo(0);
    expect(audio.play).toHaveBeenCalledWith('door_close', expect.anything());
  });

  test('cabinet doors swing about y', () => {
    const screen = { isOpen: false, open: vi.fn(() => (screen.isOpen = true)) };
    const ctx = { inventoryScreen: screen, audio: { play: vi.fn() } } as unknown as GameContext;
    const c = new Container(spawn('cabinet'));
    const door = c.object.children[1] as THREE.Mesh;
    c.interact(ctx);
    for (let i = 0; i < 30; i++) c.update(1 / 60, ctx);
    expect(door.rotation.y).toBeCloseTo(-1.8);
    expect(door.rotation.x).toBe(0);
  });
});
