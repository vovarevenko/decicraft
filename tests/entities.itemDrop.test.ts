import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { GAMEPLAY } from '../src/config';
import type { GameContext } from '../src/game/context';
import { EntityManager } from '../src/game/entities/entityManager';
import { ItemDrop, pickupText } from '../src/game/entities/itemDrop';
import { makeAABB, type AABB, type Body } from '../src/game/physics';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  return {
    // Tools stand up (+Y) from the grip; small items sit on their bottom centre.
    getItemGeometry: (id: string) =>
      id === 'shovel' ? new THREE.BoxGeometry(0.6, 12, 0.3).translate(0, 6, 0) : new THREE.BoxGeometry(0.7, 0.7, 0.7).translate(0, 0.35, 0),
  };
});
vi.mock('../src/render/voxelModel', async () => {
  const THREE = await import('three');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  return { getModelMaterial: () => material };
});
// Fake physics: the world is solid below `floorY` (a flat ground plane).
vi.mock('../src/game/physics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game/physics')>();
  return {
    ...actual,
    moveBody: (world: { floorY: number }, body: Body, dx: number, dy: number, dz: number) => {
      body.position.x += dx;
      body.position.z += dz;
      const y = body.position.y + dy;
      const landed = y <= world.floorY;
      body.position.y = landed ? world.floorY : y;
      if (landed) body.velocity.y = 0;
      body.onGround = landed;
      return { hitX: false, hitY: landed, hitZ: false, stepped: 0 };
    },
    aabbHitsWorld: (world: { floorY: number }, box: AABB) => box.minY < world.floorY,
    waterFraction: () => 0,
  };
});

function makeCtx(added: (id: string, count: number) => number = () => 0) {
  const entities = new EntityManager(new THREE.Scene());
  const parts = {
    world: { floorY: 100 },
    entities,
    inventory: { add: vi.fn(added) },
    audio: { play: vi.fn() },
    hud: { toast: vi.fn() },
    input: { uiOpen: false },
    player: { position: new THREE.Vector3(500, 100, 500), height: 18 },
  };
  return { ...parts, ctx: parts as unknown as GameContext };
}

function run(ctx: GameContext, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) ctx.entities.update(dt, ctx);
}

describe('ItemDrop', () => {
  test('pickup toast text: count + name, materials in дм³', () => {
    expect(pickupText('apple', 3)).toBe('Яблоко +3');
    expect(pickupText('dirt', 25)).toBe('Земля +25 дм³');
    expect(pickupText('shovel', 1)).toBe('Лопата +1');
  });

  test('falls, slides to rest on the ground, then hovers and spins', () => {
    const { ctx, entities } = makeCtx();
    const drop = entities.add(new ItemDrop('apple', 1, { x: 100, y: 110, z: 100 }, { x: 20, y: 0, z: 0 }));
    expect(drop.displayName).toBe('Яблоко');
    run(ctx, 2);
    expect(drop.resting).toBe(true);
    expect(drop.position.y).toBe(100);
    expect(drop.position.x).toBeGreaterThan(102);
    expect(drop.velocity.length()).toBe(0);
    const spinner = drop.object.children[0];
    const y0 = spinner.position.y;
    const r0 = spinner.rotation.y;
    run(ctx, 0.5);
    expect(spinner.position.y).toBeGreaterThan(0.2);
    expect(spinner.position.y).not.toBe(y0);
    expect(spinner.rotation.y).not.toBe(r0);
    expect(drop.object.position.y).toBe(100);
  });

  test('long tools lie flat and get a picking box covering their sweep', () => {
    const drop = new ItemDrop('shovel', 1, { x: 0, y: 100, z: 0 });
    const mesh = drop.object.children[0].children[0] as THREE.Mesh;
    expect(mesh.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
    const b = drop.getBounds(makeAABB());
    expect(b.maxX - b.minX).toBeGreaterThanOrEqual(12);
    expect(b.minY).toBe(100);
    expect(b.maxY - b.minY).toBeLessThan(3);
    const apple = new ItemDrop('apple', 1, { x: 0, y: 100, z: 0 }).getBounds(makeAABB());
    expect(apple.maxX - apple.minX).toBe(3); // tiny items still get a 30 cm picking box
  });

  test('auto pickup only after the delay and within the radius', () => {
    const { ctx, entities, inventory, audio, hud, player } = makeCtx();
    const drop = entities.add(new ItemDrop('apple', 2, { x: 100, y: 100, z: 100 }));
    player.position.set(100 + GAMEPLAY.autoPickupRadius + 1, 100, 100);
    run(ctx, 1.5);
    expect(inventory.add).not.toHaveBeenCalled();

    player.position.set(100 + GAMEPLAY.autoPickupRadius - 1, 100, 100);
    run(ctx, 1 / 60);
    expect(inventory.add).toHaveBeenCalledWith('apple', 2);
    expect(hud.toast).toHaveBeenCalledWith('Яблоко +2');
    expect(audio.play).toHaveBeenCalledWith('pickup');
    expect(drop.removed).toBe(true);
    run(ctx, 1 / 60);
    expect(entities.all).not.toContain(drop);
  });

  test('a fresh drop waits for autoPickupDelayS even right at the player', () => {
    const { ctx, entities, inventory, player } = makeCtx();
    player.position.set(100, 100, 100);
    entities.add(new ItemDrop('apple', 1, { x: 100, y: 100, z: 100 }));
    run(ctx, GAMEPLAY.autoPickupDelayS - 0.1);
    expect(inventory.add).not.toHaveBeenCalled();
    run(ctx, 0.2);
    expect(inventory.add).toHaveBeenCalledTimes(1);
  });

  test('no auto pickup while a UI screen is open', () => {
    const { ctx, entities, inventory, player, input } = makeCtx();
    player.position.set(100, 100, 100);
    input.uiOpen = true;
    entities.add(new ItemDrop('apple', 1, { x: 100, y: 100, z: 100 }));
    run(ctx, 2);
    expect(inventory.add).not.toHaveBeenCalled();
  });

  test('what does not fit stays; E on a full inventory says so', () => {
    const { ctx, entities, hud } = makeCtx((_id, n) => n - 1);
    const drop = entities.add(new ItemDrop('dirt', 3, { x: 100, y: 100, z: 100 }));
    expect(drop.hint()).toBe('E — подобрать (3 дм³)');
    drop.interact(ctx);
    expect(hud.toast).toHaveBeenLastCalledWith('Земля +1 дм³');
    expect(drop.count).toBe(2);
    expect(drop.removed).toBe(false);
    expect(drop.hint()).toBe('E — подобрать (2 дм³)');

    const full = makeCtx((_id, n) => n);
    const stuck = full.entities.add(new ItemDrop('apple', 1, { x: 0, y: 100, z: 0 }));
    expect(stuck.hint()).toBe('E — подобрать');
    stuck.interact(full.ctx);
    expect(full.hud.toast).toHaveBeenCalledWith('Инвентарь полон');
    expect(full.audio.play).not.toHaveBeenCalled();
    expect(stuck.removed).toBe(false);
  });

  test('identical resting drops within 1 unit merge (up to the stack limit)', () => {
    const { ctx, entities } = makeCtx();
    const a = entities.add(new ItemDrop('apple', 2, { x: 100, y: 100, z: 100 }));
    run(ctx, 0.1);
    expect(a.resting).toBe(true);
    const b = entities.add(new ItemDrop('apple', 3, { x: 100.5, y: 104, z: 100.3 }));
    const other = entities.add(new ItemDrop('mushroom', 1, { x: 100.2, y: 104, z: 100 }));
    const farApple = entities.add(new ItemDrop('apple', 1, { x: 103, y: 104, z: 100 }));
    run(ctx, 1);
    expect(b.removed).toBe(true);
    expect(a.count).toBe(5);
    expect(other.removed).toBe(false);
    expect(farApple.removed).toBe(false);

    const s1 = entities.add(new ItemDrop('shovel', 1, { x: 200, y: 100, z: 200 }));
    const s2 = entities.add(new ItemDrop('shovel', 1, { x: 200.2, y: 103, z: 200 }));
    run(ctx, 1);
    expect(s1.removed || s2.removed).toBe(false); // tools stack to 1
  });

  test('wakes up and falls when the ground under it is dug away', () => {
    const { ctx, entities, world } = makeCtx();
    const drop = entities.add(new ItemDrop('apple', 1, { x: 100, y: 100, z: 100 }));
    run(ctx, 0.2);
    expect(drop.resting).toBe(true);
    world.floorY = 95;
    run(ctx, 1.5);
    expect(drop.resting).toBe(true);
    expect(drop.position.y).toBe(95);
  });

  test('climbs out of a block placed onto it', () => {
    const { ctx, entities, world } = makeCtx();
    const drop = entities.add(new ItemDrop('apple', 1, { x: 100, y: 100, z: 100 }));
    run(ctx, 0.2);
    world.floorY = 101;
    run(ctx, 0.5);
    expect(drop.position.y).toBe(101);
  });
});
