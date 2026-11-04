import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import { Entity } from '../src/game/entities/entity';
import { EntityManager, rayBox } from '../src/game/entities/entityManager';
import { makeAABB, type AABB } from '../src/game/physics';

class Thing extends Entity {
  readonly type: string;
  updates = 0;
  removals = 0;
  noises = 0;
  onUpdate: ((ctx: GameContext) => void) | null = null;

  constructor(type: string, x: number, y: number, z: number, opts: { name?: string; solid?: boolean; hw?: number; h?: number } = {}) {
    super();
    this.type = type;
    this.position.set(x, y, z);
    this.displayName = opts.name ?? '';
    this.solid = opts.solid ?? false;
    this.halfWidth = opts.hw ?? 2;
    this.height = opts.h ?? 4;
  }

  update(_dt: number, ctx: GameContext): void {
    this.updates++;
    this.onUpdate?.(ctx);
  }

  onRemove(): void {
    this.removals++;
  }

  onNoise(): void {
    this.noises++;
  }
}

const ctx = {} as GameContext;

function box(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EntityManager lifecycle', () => {
  test('add attaches to the scene; update copies position; remove detaches once with onRemove', () => {
    const scene = new THREE.Scene();
    const m = new EntityManager(scene);
    const a = m.add(new Thing('a', 1, 2, 3));
    expect(scene.children).toContain(a.object);
    expect(a.object.position.toArray()).toEqual([1, 2, 3]);

    a.onUpdate = () => a.position.set(4, 5, 6);
    m.update(0.016, ctx);
    expect(a.updates).toBe(1);
    expect(a.object.position.toArray()).toEqual([4, 5, 6]);

    m.remove(a);
    expect(m.queryRadius({ x: 4, y: 5, z: 6 }, 10)).toEqual([]);
    m.update(0.016, ctx);
    expect(a.updates).toBe(1);
    expect(a.removals).toBe(1);
    expect(scene.children).not.toContain(a.object);
    expect(m.all.length).toBe(0);
    m.update(0.016, ctx);
    expect(a.removals).toBe(1);
  });

  test('entities added during update run in the same frame', () => {
    const m = new EntityManager(new THREE.Scene());
    const spawner = m.add(new Thing('spawner', 0, 0, 0));
    const child = new Thing('child', 0, 0, 0);
    spawner.onUpdate = () => {
      if (child.updates === 0 && !m.all.includes(child)) m.add(child);
    };
    m.update(0.016, ctx);
    expect(child.updates).toBe(1);
    expect(m.all).toContain(child);
  });

  test('an entity that throws is logged and removed; the others keep running', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = new EntityManager(new THREE.Scene());
    const bad = m.add(new Thing('bad', 0, 0, 0));
    const good = m.add(new Thing('good', 0, 0, 0));
    bad.onUpdate = () => {
      throw new Error('boom');
    };
    m.update(0.016, ctx);
    expect(err).toHaveBeenCalledTimes(1);
    expect(bad.removed).toBe(true);
    expect(bad.removals).toBe(1);
    expect(good.updates).toBe(1);
    expect(m.all).toEqual([good]);
  });

  test('entities beyond their viewDistance from the player are hidden', () => {
    const m = new EntityManager(new THREE.Scene());
    const player = { position: new THREE.Vector3(0, 0, 0) };
    const withPlayer = { player } as unknown as GameContext;
    const near = m.add(new Thing('near', 40, 0, 0));
    const far = m.add(new Thing('far', 60, 0, 0));
    const always = m.add(new Thing('always', 5000, 0, 0));
    near.viewDistance = 50;
    far.viewDistance = 50;
    m.update(0.016, withPlayer);
    expect([near.object.visible, far.object.visible, always.object.visible]).toEqual([true, false, true]);
    player.position.set(30, 0, 0);
    m.update(0.016, withPlayer);
    expect(far.object.visible).toBe(true);
  });

  test('byType returns live entities of a type', () => {
    const m = new EntityManager(new THREE.Scene());
    const a = m.add(new Thing('item', 0, 0, 0));
    const b = m.add(new Thing('item', 0, 0, 0));
    m.add(new Thing('door', 0, 0, 0));
    m.remove(b);
    expect(m.byType('item')).toEqual([a]);
  });
});

describe('EntityManager queries', () => {
  test('queryRadius is 3D, inclusive, and reuses `out`', () => {
    const m = new EntityManager(new THREE.Scene());
    const a = m.add(new Thing('a', 10, 0, 0));
    const b = m.add(new Thing('b', 0, 10.5, 0));
    const c = m.add(new Thing('c', 3, 4, 0)); // distance exactly 5
    const out: Entity[] = [b];
    expect(m.queryRadius({ x: 0, y: 0, z: 0 }, 5, out)).toBe(out);
    expect(out).toEqual([c]);
    expect(m.queryRadius({ x: 0, y: 0, z: 0 }, 10)).toEqual([a, c]);
  });

  test('raycast picks the nearest named box within reach', () => {
    const m = new EntityManager(new THREE.Scene());
    const far = m.add(new Thing('far', 30, 0, 0, { name: 'Far', hw: 2, h: 4 }));
    const near = m.add(new Thing('near', 10, 0, 0, { name: 'Near', hw: 2, h: 4 }));
    m.add(new Thing('nameless', 5, 0, 0, { hw: 2, h: 4 }));
    const o = { x: 0, y: 1, z: 0 };
    const d = { x: 1, y: 0, z: 0 };

    const hit = m.raycast(o, d, 40);
    expect(hit?.entity).toBe(near);
    expect(hit?.distance).toBeCloseTo(8);
    expect(m.raycast(o, d, 7.9)).toBeNull();
    expect(m.raycast(o, d, 40, (e) => e !== near)?.entity).toBe(far);
    expect(m.raycast(o, { x: -1, y: 0, z: 0 }, 40)).toBeNull();
    expect(m.raycast({ x: 10, y: 1, z: 0 }, d, 40)).toEqual({ entity: near, distance: 0 });
  });

  test('solidBoxes returns overlapping solid boxes only (touching faces excluded)', () => {
    const m = new EntityManager(new THREE.Scene());
    m.add(new Thing('crate', 0, 0, 0, { solid: true, hw: 2, h: 4 }));
    m.add(new Thing('ghost', 0, 0, 0, { solid: false, hw: 2, h: 4 }));
    const far = m.add(new Thing('far', 20, 0, 0, { solid: true, hw: 2, h: 4 }));
    const out: AABB[] = [];

    const res = m.solidBoxes(box(-1, 0, -1, 1, 1, 1), out);
    expect(res).toBe(out);
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual(box(-2, 0, -2, 2, 4, 2));

    expect(m.solidBoxes(box(2, 0, -1, 3, 1, 1))).toHaveLength(0); // touches x = 2
    expect(m.solidBoxes(box(-1, 4, -1, 1, 5, 1))).toHaveLength(0); // touches the top
    expect(m.solidBoxes(box(-100, -1, -100, 100, 10, 100))).toHaveLength(2);

    far.solid = false;
    expect(m.solidBoxes(box(-100, -1, -100, 100, 10, 100))).toHaveLength(1);
  });

  test('emitNoise reaches entities within the radius', () => {
    const m = new EntityManager(new THREE.Scene());
    const close = m.add(new Thing('close', 10, 0, 0));
    const far = m.add(new Thing('far', 50, 0, 0));
    m.emitNoise(ctx, { x: 0, y: 0, z: 0 }, 20);
    expect(close.noises).toBe(1);
    expect(far.noises).toBe(0);
  });
});

describe('rayBox', () => {
  const b = box(0, 0, 0, 2, 2, 2);

  test('entry distance along each axis and diagonals', () => {
    expect(rayBox({ x: -3, y: 1, z: 1 }, { x: 1, y: 0, z: 0 }, b)).toBeCloseTo(3);
    expect(rayBox({ x: 1, y: 5, z: 1 }, { x: 0, y: -1, z: 0 }, b)).toBeCloseTo(3);
    expect(rayBox({ x: 1, y: 1, z: -2 }, { x: 0, y: 0, z: 1 }, b)).toBeCloseTo(2);
    const s = Math.SQRT1_2;
    expect(rayBox({ x: -1, y: -1, z: 1 }, { x: s, y: s, z: 0 }, b)).toBeCloseTo(Math.SQRT2);
  });

  test('misses, rays pointing away, parallel rays outside, origin inside', () => {
    expect(rayBox({ x: -3, y: 3, z: 1 }, { x: 1, y: 0, z: 0 }, b)).toBeNull();
    expect(rayBox({ x: -3, y: 1, z: 1 }, { x: -1, y: 0, z: 0 }, b)).toBeNull();
    expect(rayBox({ x: 1, y: 1, z: 5 }, { x: 1, y: 0, z: 0 }, b)).toBeNull();
    expect(rayBox({ x: 1, y: 1, z: 1 }, { x: 0, y: 1, z: 0 }, b)).toBe(0);
  });

  test('works with a reused box (no hidden state between calls)', () => {
    const other = makeAABB();
    other.maxX = other.maxY = other.maxZ = 1;
    expect(rayBox({ x: 5, y: 0.5, z: 0.5 }, { x: -1, y: 0, z: 0 }, other)).toBeCloseTo(4);
    expect(rayBox({ x: -3, y: 1, z: 1 }, { x: 1, y: 0, z: 0 }, b)).toBeCloseTo(3);
  });
});
