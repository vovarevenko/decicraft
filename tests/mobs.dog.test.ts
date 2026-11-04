import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import type { GameContext } from '../src/game/context';
import { EntityManager } from '../src/game/entities/entityManager';
import type { ItemStack } from '../src/game/inventory';
import { Deer } from '../src/game/mobs/deer';
import { Dog } from '../src/game/mobs/dog';
import { createDogBrain, DOG, dogFoodOf, stepDogBrain, type DogBrain, type DogSenses } from '../src/game/mobs/dogBrain';
import type { Body } from '../src/game/physics';
import { B } from '../src/world/blocks';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  const box = () => new THREE.BoxGeometry(1, 1, 1);
  return {
    getMobRig: (kind: string) => ({
      size: kind === 'dog' ? { width: 2.5, height: 6.5, length: 7 } : { width: 3, height: 11, length: 11 },
      parts: [
        { name: 'body', geometry: box(), pivot: [0, 4, 0], parent: null },
        { name: 'head', geometry: box(), pivot: [0, 1, 3.5], parent: 'body' },
        { name: 'jaw', geometry: box(), pivot: [0, -0.5, 1], parent: 'head' },
        { name: 'earL', geometry: box(), pivot: [-0.6, 0.8, 0], parent: 'head' },
        { name: 'earR', geometry: box(), pivot: [0.6, 0.8, 0], parent: 'head' },
        { name: 'legFL', geometry: box(), pivot: [-0.8, -0.5, 2.5], parent: 'body' },
        { name: 'legFR', geometry: box(), pivot: [0.8, -0.5, 2.5], parent: 'body' },
        { name: 'legBL', geometry: box(), pivot: [-0.8, -0.5, -2.5], parent: 'body' },
        { name: 'legBR', geometry: box(), pivot: [0.8, -0.5, -2.5], parent: 'body' },
        { name: 'tail', geometry: box(), pivot: [0, 0.5, -3], parent: 'body' },
      ],
    }),
  };
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
    moveBody: (_world: unknown, body: Body, dx: number, dy: number, dz: number) => {
      body.position.x += dx;
      body.position.z += dz;
      const y = body.position.y + dy;
      body.onGround = y <= 100;
      body.position.y = Math.max(100, y);
      if (body.onGround) body.velocity.y = 0;
      return { hitX: false, hitY: body.onGround, hitZ: false, stepped: 0 };
    },
    waterFraction: () => 0,
  };
});

// ------------------------------------------------------------------ the pure state machine

const senses = (o: Partial<DogSenses> = {}): DogSenses => ({
  dist: 1000,
  playerIdle: 0,
  food: 'none',
  friendly: false,
  hit: false,
  deerDist: Infinity,
  ...o,
});

function steps(b: DogBrain, s: DogSenses, seconds: number, rand = () => 0.5, dt = 0.05): string[] {
  const events: string[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const e = stepDogBrain(b, s, dt, rand);
    if (e !== 'none') events.push(e);
  }
  return events;
}

describe('dog brain', () => {
  test('roams while the player is far, turns wary within 25 m and barks within 15 m', () => {
    const b = createDogBrain();
    expect(steps(b, senses({ dist: 400 }), 5)).toEqual([]);
    expect(b.state).toBe('roam');
    expect(steps(b, senses({ dist: 200 }), 5)).toEqual([]);
    expect(b.state).toBe('wary');
    const barks = steps(b, senses({ dist: 120 }), 30);
    expect(barks.length).toBeGreaterThanOrEqual(5);
    expect(new Set(barks)).toEqual(new Set(['bark']));
    steps(b, senses({ dist: 280 }), 1); // between interest and forget: still wary
    expect(b.state).toBe('wary');
    steps(b, senses({ dist: 320 }), 1);
    expect(b.state).toBe('roam');
  });

  test('comes begging while the player holds food it likes; loses interest otherwise', () => {
    const b = createDogBrain();
    steps(b, senses({ dist: 150, food: 'liked' }), 0.5);
    expect(b.state).toBe('beg');
    expect(steps(b, senses({ dist: 20, food: 'liked' }), 10)).toEqual([]); // no barking at the hand that feeds
    steps(b, senses({ dist: 20, food: 'other' }), 0.1);
    expect(b.state).toBe('wary');
    steps(b, senses({ dist: 250, food: 'liked' }), 0.1);
    expect(b.state).toBe('wary'); // too far to smell it
  });

  test('friendly: follows, sits when the player idles > 2 s nearby, gets up when they move', () => {
    const b = createDogBrain();
    steps(b, senses({ friendly: true, dist: 60 }), 0.1);
    expect(b.state).toBe('follow');
    steps(b, senses({ friendly: true, dist: 25, playerIdle: 1.5 }), 0.1);
    expect(b.state).toBe('follow');
    steps(b, senses({ friendly: true, dist: 25, playerIdle: 2.1 }), 0.1);
    expect(b.state).toBe('sit');
    steps(b, senses({ friendly: true, dist: 25, playerIdle: 0 }), 0.1);
    expect(b.state).toBe('follow');
    steps(b, senses({ friendly: true, dist: 60, playerIdle: 5 }), 0.1);
    expect(b.state).toBe('follow'); // too far away to sit
  });

  test('friendly: sometimes barks at deer within 15 m, never otherwise', () => {
    const b = createDogBrain();
    expect(steps(b, senses({ friendly: true, dist: 20 }), 60, () => 0.1)).toEqual([]);
    const events = steps(b, senses({ friendly: true, dist: 20, deerDist: 120 }), 60, () => 0.1);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(new Set(events)).toEqual(new Set(['barkAtDeer']));
    expect(steps(b, senses({ friendly: true, dist: 20, deerDist: 160 }), 60, () => 0.1)).toEqual([]);
    expect(steps(b, senses({ friendly: true, dist: 20, deerDist: 120 }), 60, () => 0.9)).toEqual([]);
  });

  test('a hit makes it flee for 4–6 s, then it is wary again', () => {
    const b = createDogBrain();
    stepDogBrain(b, senses({ hit: true, dist: 30, friendly: true }), 0.05, () => 0.5);
    expect(b.state).toBe('flee');
    expect(b.timer).toBeCloseTo(5);
    steps(b, senses({ dist: 30 }), 4.9);
    expect(b.state).toBe('flee');
    steps(b, senses({ dist: 30 }), 0.2);
    expect(b.state).toBe('wary');
  });

  test('dogFoodOf: liked / other / none', () => {
    const inv = (id: string | null) => ({ selectedStack: () => (id ? { id, count: 1 } : null) });
    expect(dogFoodOf(inv('canned_food'))).toBe('liked');
    expect(dogFoodOf(inv('meat_raw'))).toBe('liked');
    expect(dogFoodOf(inv('meat_cooked'))).toBe('liked');
    expect(dogFoodOf(inv('apple'))).toBe('other');
    expect(dogFoodOf(inv('mushroom'))).toBe('other');
    expect(dogFoodOf(inv('shovel'))).toBe('none');
    expect(dogFoodOf(inv(null))).toBe('none');
  });
});

// ------------------------------------------------------------------ the Dog entity with a fake context

function fakeInventory(stack: ItemStack | null) {
  const slots: (ItemStack | null)[] = [stack];
  return {
    slots,
    selected: 0,
    selectedStack: () => slots[0],
    takeFromSlot: vi.fn((index: number, count: number) => {
      const s = slots[index];
      if (!s) return null;
      const n = Math.min(count, s.count);
      s.count -= n;
      if (s.count === 0) slots[index] = null;
      return { id: s.id, count: n };
    }),
  };
}

function makeCtx(stack: ItemStack | null = null) {
  const parts = {
    world: { getBlock: (_x: number, y: number) => (y < 100 ? B.STONE : B.AIR) },
    terrain: { biomeAt: () => 1 },
    entities: new EntityManager(new THREE.Scene()),
    inventory: fakeInventory(stack),
    player: { position: new THREE.Vector3(300, 100, 300), crouching: false, sprinting: false, flying: false, horizontalSpeed: 0, height: 18 },
    input: { active: true, uiOpen: false },
    audio: { play: vi.fn() },
    hud: { toast: vi.fn() },
    time: { elapsed: 0 },
  };
  return { ...parts, ctx: parts as unknown as GameContext };
}

// The EntityManager logs and removes an entity whose update() throws: in tests that must fail loudly.
let consoleError: MockInstance;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error');
});
afterEach(() => {
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
});

function run(ctx: GameContext, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    ctx.time.elapsed += dt;
    ctx.entities.update(dt, ctx);
  }
}

describe('Dog', () => {
  test('E with food it likes: eats one, becomes a friend', () => {
    const { ctx, entities, inventory, audio, hud } = makeCtx({ id: 'canned_food', count: 3 });
    const dog = entities.add(new Dog(310, 100, 300, 1));
    expect(dog.displayName).toBe('Собака');
    expect(dog.hint(ctx)).toBe('E — покормить');
    dog.interact(ctx);
    expect(inventory.takeFromSlot).toHaveBeenCalledWith(0, 1);
    expect(inventory.slots[0]).toEqual({ id: 'canned_food', count: 2 });
    expect(dog.friendly).toBe(true);
    expect(dog.displayName).toBe('Дружок');
    expect(audio.play).toHaveBeenCalledWith('dog_whine', expect.anything());
    expect(hud.toast).toHaveBeenCalledWith('Собака теперь ваш друг');
    expect(dog.hint(ctx)).toBe('E — угостить');

    dog.interact(ctx);
    expect(inventory.slots[0]).toEqual({ id: 'canned_food', count: 1 });
    expect(hud.toast).toHaveBeenLastCalledWith('Дружок доволен');
  });

  test('food it does not like is refused; without food it keeps its distance', () => {
    const apple = makeCtx({ id: 'apple', count: 2 });
    const dog = new Dog(310, 100, 300, 2);
    expect(dog.hint(apple.ctx)).toBe('Такое собака не ест');
    dog.interact(apple.ctx);
    expect(apple.inventory.takeFromSlot).not.toHaveBeenCalled();
    expect(dog.friendly).toBe(false);

    const empty = makeCtx();
    expect(dog.hint(empty.ctx)).toBe('Не подпускает — приманите едой');
    dog.interact(empty.ctx);
    expect(dog.friendly).toBe(false);
    expect(empty.audio.play).not.toHaveBeenCalled();
  });

  test('a friend without food gets petted', () => {
    const { ctx, inventory, audio } = makeCtx({ id: 'canned_food', count: 1 });
    const dog = new Dog(310, 100, 300, 3);
    dog.interact(ctx);
    expect(inventory.slots[0]).toBeNull();
    expect(dog.hint(ctx)).toBe('E — погладить');
    dog.interact(ctx);
    expect(audio.play).toHaveBeenLastCalledWith('dog_whine', expect.objectContaining({ volume: 0.6 }));
  });

  test('a hit: yelp, flight, friendship forgotten — but it never dies', () => {
    const { ctx, entities, audio } = makeCtx({ id: 'meat_raw', count: 2 });
    const dog = entities.add(new Dog(310, 100, 300, 4));
    dog.interact(ctx);
    expect(dog.friendly).toBe(true);
    dog.onHit(ctx, { damage: 4, dir: new THREE.Vector3(1, 0, 0), tool: 'axe' });
    expect(audio.play).toHaveBeenCalledWith('dog_yelp', expect.anything());
    expect(dog.friendly).toBe(false);
    expect(dog.displayName).toBe('Собака');
    run(ctx, 0.1);
    expect(dog.brain.state).toBe('flee');
    expect(dog.hint(ctx)).toBe('Напугана');
    dog.interact(ctx); // a fleeing dog cannot be fed
    expect(dog.friendly).toBe(false);
    for (let i = 0; i < 20; i++) dog.onHit(ctx, { damage: 100, dir: new THREE.Vector3(1, 0, 0), tool: 'axe' });
    expect(dog.dead).toBe(false);
    expect(dog.health).toBe(dog.maxHealth);
    run(ctx, 2);
    expect(dog.position.distanceTo(ctx.player.position)).toBeGreaterThan(60);
  });

  test('a friend follows the player and sits when they stand still', () => {
    const { ctx, entities, player } = makeCtx({ id: 'canned_food', count: 1 });
    const dog = entities.add(new Dog(310, 100, 300, 5));
    dog.interact(ctx);
    player.horizontalSpeed = 38;
    player.position.set(500, 100, 300);
    run(ctx, 6);
    const d = dog.position.distanceTo(player.position);
    expect(d).toBeLessThanOrEqual(DOG.followFar + 2);
    expect(d).toBeGreaterThanOrEqual(DOG.followNear - 6);
    player.horizontalSpeed = 0;
    run(ctx, 3);
    expect(dog.brain.state).toBe('sit');
    const rig = dog.object.children[0];
    expect(rig.rotation.x).toBeLessThan(-0.4); // body pitched up: sitting
  });

  test('a wary dog keeps 6–10 m away and barks', () => {
    const { ctx, entities, player, audio } = makeCtx();
    const dog = entities.add(new Dog(330, 100, 300, 6));
    player.position.set(300, 100, 300);
    run(ctx, 6);
    expect(dog.brain.state).toBe('wary');
    const d = dog.position.distanceTo(player.position);
    expect(d).toBeGreaterThan(DOG.waryMin - 2);
    expect(d).toBeLessThan(DOG.waryMax + 2);
    expect(audio.play).toHaveBeenCalledWith('dog_bark', expect.anything());
  });

  test('barking at deer scares them off', () => {
    const { ctx, entities } = makeCtx({ id: 'canned_food', count: 1 });
    const dog = entities.add(new Dog(310, 100, 300, 7));
    dog.interact(ctx);
    const deer = entities.add(new Deer(400, 100, 300, 8));
    let fled = false;
    for (let i = 0; i < 60 * 30 && !fled; i++) {
      run(ctx, 1 / 30);
      fled = deer.brain.state === 'flee';
    }
    expect(fled).toBe(true);
  });
});
