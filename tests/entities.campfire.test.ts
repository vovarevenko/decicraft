import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import { Campfire } from '../src/game/entities/campfire';
import { EntityManager } from '../src/game/entities/entityManager';
import type { AABB, Body } from '../src/game/physics';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  return { getCampfireGeometry: () => new THREE.BoxGeometry(6, 3, 6).translate(0, 1.5, 0) };
});
vi.mock('../src/render/voxelModel', async () => {
  const THREE = await import('three');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  return { getModelMaterial: () => material };
});
vi.mock('../src/game/physics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game/physics')>();
  return {
    ...actual,
    moveBody: (world: { floorY: number }, body: Body, _dx: number, dy: number) => {
      const y = body.position.y + dy;
      body.onGround = y <= world.floorY;
      body.position.y = Math.max(world.floorY, y);
      return { hitX: false, hitY: body.onGround, hitZ: false, stepped: 0 };
    },
    aabbHitsWorld: (world: { floorY: number }, box: AABB) => box.minY < world.floorY,
  };
});

function makeCtx(poolSize = 1) {
  let free = poolSize;
  const handles: { light: THREE.PointLight; release: ReturnType<typeof vi.fn> }[] = [];
  const loop = { setVolume: vi.fn(), setPosition: vi.fn(), stop: vi.fn() };
  const parts = {
    world: { floorY: 100 },
    entities: new EntityManager(new THREE.Scene()),
    renderer: {
      lights: {
        acquire: vi.fn(() => {
          if (free === 0) return null;
          free--;
          const h = { light: new THREE.PointLight(), release: vi.fn(() => free++) };
          handles.push(h);
          return h;
        }),
      },
    },
    particles: { fire: vi.fn() },
    audio: { play: vi.fn(), startLoop: vi.fn(() => loop) },
    inventory: { add: vi.fn(() => 0) },
    hud: { toast: vi.fn() },
    player: { position: new THREE.Vector3(105, 100, 100) },
  };
  return { ...parts, handles, loop, ctx: parts as unknown as GameContext };
}

describe('Campfire', () => {
  test('burns: flames every frame, a crackle loop fading with distance', () => {
    const { ctx, entities, particles, audio, loop, player } = makeCtx();
    const fire = entities.add(new Campfire({ x: 100, y: 100, z: 100 }));
    entities.update(1 / 60, ctx);
    entities.update(1 / 60, ctx);
    expect(particles.fire).toHaveBeenCalledTimes(2);
    expect(particles.fire.mock.calls[0][0]).toMatchObject({ x: 100, z: 100 });
    expect(audio.startLoop).toHaveBeenCalledTimes(1);
    expect(audio.startLoop.mock.calls[0]).toEqual(['fire', expect.objectContaining({ volume: expect.closeTo(0.95, 2) })]);
    player.position.set(100, 100, 300);
    entities.update(1 / 60, ctx);
    expect(loop.setVolume).toHaveBeenLastCalledWith(0);
    expect(fire.hint()).toBe('Рядом можно жарить мясо (Tab) · E — забрать');
    expect(fire.hint()).toContain('E — забрать');
    expect(fire.solid).toBe(false);
  });

  test('holds a pooled light only within ~25 m', () => {
    const { ctx, entities, renderer, handles, player } = makeCtx();
    entities.add(new Campfire({ x: 100, y: 100, z: 100 }));
    entities.update(1 / 60, ctx);
    expect(renderer.lights.acquire).toHaveBeenCalledWith('campfire');
    expect(handles[0].light.position.toArray()).toEqual([100, 103, 100]);

    player.position.set(100, 100, 100 + 280);
    entities.update(1 / 60, ctx);
    expect(handles[0].release).toHaveBeenCalledTimes(1);

    player.position.set(100, 100, 100 + 260); // hysteresis band: stays released
    entities.update(1 / 60, ctx);
    expect(renderer.lights.acquire).toHaveBeenCalledTimes(1);
    player.position.set(100, 100, 100 + 200);
    entities.update(1 / 60, ctx);
    expect(renderer.lights.acquire).toHaveBeenCalledTimes(2);
  });

  test('an exhausted pool is retried about once a second, not every frame', () => {
    const { ctx, entities, renderer } = makeCtx(0);
    entities.add(new Campfire({ x: 100, y: 100, z: 100 }));
    for (let i = 0; i < 30; i++) entities.update(1 / 60, ctx);
    expect(renderer.lights.acquire).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 40; i++) entities.update(1 / 60, ctx);
    expect(renderer.lights.acquire).toHaveBeenCalledTimes(2);
  });

  test('E picks it up; removal releases the light and stops the loop', () => {
    const { ctx, entities, inventory, hud, handles, loop } = makeCtx();
    const fire = entities.add(new Campfire({ x: 100, y: 100, z: 100 }));
    entities.update(1 / 60, ctx);
    fire.interact(ctx);
    expect(inventory.add).toHaveBeenCalledWith('campfire', 1);
    expect(hud.toast).toHaveBeenCalledWith('Костёр +1');
    entities.update(1 / 60, ctx);
    expect(entities.all).not.toContain(fire);
    expect(handles[0].release).toHaveBeenCalledTimes(1);
    expect(loop.stop).toHaveBeenCalledTimes(1);
  });

  test('stays when the inventory is full', () => {
    const { ctx, entities, inventory, hud } = makeCtx();
    inventory.add.mockReturnValue(1);
    const fire = entities.add(new Campfire({ x: 100, y: 100, z: 100 }));
    fire.interact(ctx);
    expect(hud.toast).toHaveBeenCalledWith('Инвентарь полон');
    expect(fire.removed).toBe(false);
  });

  test('drops onto the next floor when the ground under it is dug away', () => {
    const { ctx, entities, world, loop } = makeCtx();
    const fire = entities.add(new Campfire({ x: 100, y: 100, z: 100 }));
    entities.update(1 / 60, ctx);
    world.floorY = 90;
    for (let i = 0; i < 90; i++) entities.update(1 / 60, ctx);
    expect(fire.position.y).toBe(90);
    expect(loop.setPosition).toHaveBeenCalled();
  });
});
