import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import type { GameContext } from '../src/game/context';
import { EntityManager } from '../src/game/entities/entityManager';
import { ItemDrop } from '../src/game/entities/itemDrop';
import { Inventory } from '../src/game/inventory';
import { FAR_MOB_DIST, Mob } from '../src/game/mobs/mob';
import { makeGroundProbe, MOB_MAX_DROP, probeGround } from '../src/game/mobs/probe';
import { makeAABB, type Body, type MoveOptions } from '../src/game/physics';
import type { LootEntry } from '../src/gen/types';
import { B } from '../src/world/blocks';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  const box = () => new THREE.BoxGeometry(1, 1, 1);
  return {
    getItemGeometry: () => new THREE.BoxGeometry(0.7, 0.7, 0.7),
    getMobRig: () => ({
      size: { width: 2.5, height: 6.5, length: 7 },
      parts: [
        // Listed child-first on purpose: the hierarchy must not depend on the order.
        { name: 'jaw', geometry: box(), pivot: [0, -0.5, 1], parent: 'head' },
        { name: 'head', geometry: box(), pivot: [0, 1, 3.5], parent: 'body' },
        { name: 'body', geometry: box(), pivot: [0, 4, 0], parent: null },
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
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `// model\n${shader.vertexShader}`;
  };
  material.customProgramCacheKey = () => 'voxel-model';
  return { getModelMaterial: () => material };
});

/** Test terrain: `ground(x, z)` = first air voxel; `waterTop(x, z)` = first air above water (0 = none). */
interface FakeWorld {
  ground: (x: number, z: number) => number;
  waterTop: (x: number, z: number) => number;
  getBlock(x: number, y: number, z: number): number;
}

function fakeWorld(ground: FakeWorld['ground'], waterTop: FakeWorld['waterTop'] = () => 0): FakeWorld {
  return {
    ground,
    waterTop,
    getBlock(x, y, z) {
      if (y < ground(x, z)) return B.STONE;
      return y < waterTop(x, z) ? B.WATER : B.AIR;
    },
  };
}

// Fake physics: the centre column decides; ledges up to stepHeight are climbed on the ground.
vi.mock('../src/game/physics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/game/physics')>();
  return {
    ...actual,
    moveBody: (world: FakeWorld, body: Body, dx: number, dy: number, dz: number, opts?: MoveOptions) => {
      const p = body.position;
      const step = body.onGround ? (opts?.stepHeight ?? 0) : 0;
      const enter = (x: number, z: number): boolean => {
        const g = world.ground(Math.floor(x), Math.floor(z));
        if (g > p.y + step + 1e-6) return false;
        if (g > p.y) p.y = g;
        return true;
      };
      let hitX = false;
      let hitZ = false;
      if (dx !== 0) {
        if (enter(p.x + dx, p.z)) p.x += dx;
        else {
          hitX = true;
          body.velocity.x = 0;
        }
      }
      if (dz !== 0) {
        if (enter(p.x, p.z + dz)) p.z += dz;
        else {
          hitZ = true;
          body.velocity.z = 0;
        }
      }
      const g = world.ground(Math.floor(p.x), Math.floor(p.z));
      const y = p.y + dy;
      body.onGround = y <= g;
      p.y = Math.max(g, y);
      if (body.onGround) body.velocity.y = 0;
      return { hitX, hitY: body.onGround, hitZ, stepped: 0 };
    },
    waterFraction: () => 0,
  };
});

class TestMob extends Mob {
  readonly type = 'mob';
  readonly kind = 'dog' as const;
  thinks = 0;
  readonly dts: number[] = [];
  dirX = 1;
  dirZ = 0;
  speed = 0;
  /** allowedAt() refuses x below this (stands in for the deer's town check). */
  forbidBelowX = -Infinity;
  maxY = -Infinity;
  minY = Infinity;

  constructor(x: number, y: number, z: number, loot: readonly LootEntry[] = []) {
    super();
    this.init(x, y, z, 7);
    this.loot = loot;
  }

  protected think(dt: number): void {
    this.thinks++;
    this.dts.push(dt);
    if (this.speed > 0) this.moveAlong(this.dirX, this.dirZ, this.speed);
    else this.stand();
  }

  protected animatePose(): void {
    this.maxY = Math.max(this.maxY, this.position.y);
    this.minY = Math.min(this.minY, this.position.y);
  }

  protected allowedAt(_ctx: GameContext, x: number): boolean {
    return x >= this.forbidBelowX;
  }

  get gaitAmplitude(): number {
    return this.gaitAmp;
  }
}

function makeCtx(world: FakeWorld) {
  const parts = {
    world,
    entities: new EntityManager(new THREE.Scene()),
    player: { position: new THREE.Vector3(300, 100, 300), height: 18 },
    input: { active: true, uiOpen: false },
    inventory: new Inventory(),
    hud: { toast: vi.fn() },
    audio: { play: vi.fn() },
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

function run(ctx: GameContext, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) ctx.entities.update(dt, ctx);
}

const flat = () => fakeWorld(() => 100);

describe('probeGround', () => {
  const at = (ground: number, water = 0) => probeGround(fakeWorld(() => ground, () => water), 5.5, 5.5, 100, makeGroundProbe());

  test('level ground, steps and safe drops are walkable', () => {
    expect(at(100)).toEqual({ kind: 'ok', dy: 0 });
    expect(at(103)).toEqual({ kind: 'ok', dy: 3 });
    expect(at(105)).toEqual({ kind: 'ok', dy: 5 });
    expect(at(90)).toEqual({ kind: 'ok', dy: -10 });
    expect(at(100 - MOB_MAX_DROP)).toEqual({ kind: 'ok', dy: -MOB_MAX_DROP });
  });

  test('ledges of 6–10 voxels need a jump, higher ones are walls', () => {
    expect(at(106)).toEqual({ kind: 'jump', dy: 6 });
    expect(at(110)).toEqual({ kind: 'jump', dy: 10 });
    expect(at(111).kind).toBe('wall');
    expect(at(200).kind).toBe('wall');
  });

  test('drops deeper than 1.5 m are cliffs; water before the floor is water', () => {
    expect(at(100 - MOB_MAX_DROP - 1).kind).toBe('cliff');
    expect(at(0).kind).toBe('cliff');
    expect(at(95, 100)).toEqual({ kind: 'water', dy: -1 });
    expect(at(80, 99)).toEqual({ kind: 'water', dy: -2 });
    expect(at(98, 101)).toEqual({ kind: 'water', dy: 0 });
  });
});

describe('Mob base', () => {
  test('rig: one group per part at its pivot, parented per the rig; shadows; own material copy', async () => {
    const { getModelMaterial } = await import('../src/render/voxelModel');
    const mob = new TestMob(100, 100, 100);
    const rig = mob.object.children[0];
    const body = rig.children.find((c) => c.name === 'body')!;
    expect(body.position.toArray()).toEqual([0, 4, 0]);
    expect(body.children.map((c) => c.name).filter(Boolean).sort()).toEqual(['head', 'legBL', 'legBR', 'legFL', 'legFR', 'tail']);
    const head = body.children.find((c) => c.name === 'head')!;
    expect(head.children.some((c) => c.name === 'jaw')).toBe(true);
    const mesh = head.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh;
    expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
    const shared = getModelMaterial();
    const own = mesh.material as THREE.MeshStandardMaterial;
    expect(own).not.toBe(shared);
    expect(own.onBeforeCompile).toBe(shared.onBeforeCompile);
    expect(own.customProgramCacheKey()).toBe('voxel-model');
    expect(mob.halfWidth).toBeCloseTo(2.1); // max(width / 2, length · 0.3)
    expect(mob.height).toBe(6.5);
  });

  test('walks along its heading and faces it: rotation.y = atan2(dir.x, dir.z)', () => {
    const { ctx, entities } = makeCtx(flat());
    const mob = entities.add(new TestMob(100, 100, 100));
    mob.yaw = -Math.PI / 2; // facing -X: it has to turn around first
    mob.speed = 12;
    run(ctx, 1);
    expect(mob.object.rotation.y).toBeCloseTo(Math.PI / 2);
    const x = mob.position.x;
    const z = mob.position.z;
    run(ctx, 1);
    expect(mob.position.x - x).toBeCloseTo(12, 0);
    expect(mob.position.z).toBeCloseTo(z, 5);
    expect(mob.object.rotation.y).toBeCloseTo(Math.atan2(1, 0));
    expect(mob.gaitAmplitude).toBeGreaterThan(0.2);
    mob.speed = 0;
    run(ctx, 1);
    expect(mob.gaitAmplitude).toBeLessThan(0.05);
  });

  test('does not walk off a 2 m drop', () => {
    const { ctx, entities } = makeCtx(fakeWorld((x) => (x < 130 ? 100 : 80)));
    const mob = entities.add(new TestMob(110, 100, 100));
    mob.speed = 20;
    run(ctx, 6);
    expect(mob.minY).toBe(100);
    expect(mob.position.x).toBeLessThan(130);
  });

  test('walks down a safe 1 m drop', () => {
    const { ctx, entities } = makeCtx(fakeWorld((x) => (x < 130 ? 100 : 90)));
    const mob = entities.add(new TestMob(110, 100, 100));
    mob.speed = 20;
    run(ctx, 3);
    expect(mob.position.x).toBeGreaterThan(130);
    expect(mob.position.y).toBe(90);
  });

  test('keeps out of water', () => {
    const { ctx, entities } = makeCtx(fakeWorld((x) => (x < 130 ? 100 : 90), (x) => (x < 130 ? 0 : 100)));
    const mob = entities.add(new TestMob(110, 100, 100));
    mob.speed = 20;
    run(ctx, 6);
    expect(mob.position.x).toBeLessThan(130);
  });

  test('jumps onto a 70 cm ledge but turns away from a 1.2 m wall', () => {
    const ledge = makeCtx(fakeWorld((x) => (x < 120 ? 100 : 107)));
    const jumper = ledge.entities.add(new TestMob(110, 100, 100));
    jumper.speed = 12;
    run(ledge.ctx, 3);
    expect(jumper.position.x).toBeGreaterThan(125);
    expect(jumper.position.y).toBe(107);

    const wall = makeCtx(fakeWorld((x) => (x < 120 ? 100 : 112)));
    const blocked = wall.entities.add(new TestMob(110, 100, 100));
    blocked.speed = 12;
    run(wall.ctx, 3);
    expect(blocked.position.x).toBeLessThan(120);
    expect(blocked.maxY).toBe(100);
    expect(Math.abs(blocked.position.z - 100)).toBeGreaterThan(5); // went around along the wall
  });

  test('never steps into an area allowedAt() refuses', () => {
    const { ctx, entities } = makeCtx(flat());
    const mob = entities.add(new TestMob(110, 100, 100));
    mob.forbidBelowX = 100;
    mob.dirX = -1;
    mob.speed = 15;
    run(ctx, 4);
    expect(mob.position.x).toBeGreaterThanOrEqual(100);
  });

  test('far mobs think every 4th frame with the accumulated time', () => {
    const { ctx, entities, player } = makeCtx(flat());
    const mob = entities.add(new TestMob(100, 100, 100));
    player.position.set(100 + FAR_MOB_DIST + 50, 100, 100);
    run(ctx, 40 / 60);
    expect(mob.thinks).toBe(10);
    // The first update carries 1–4 frames (phase); after that exactly four.
    for (const dt of mob.dts.slice(1)) expect(dt).toBeCloseTo(4 / 60);
    expect(mob.dts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(40 / 60 + 1e-9);
    player.position.set(110, 100, 100);
    mob.thinks = 0;
    run(ctx, 10 / 60);
    expect(mob.thinks).toBeGreaterThanOrEqual(9);
  });

  test('picking box follows the facing (length × width)', () => {
    const mob = new TestMob(0, 100, 0);
    mob.yaw = 0;
    let b = mob.getBounds(makeAABB());
    expect(b.maxX - b.minX).toBeCloseTo(2.5);
    expect(b.maxZ - b.minZ).toBeCloseTo(7);
    mob.yaw = Math.PI / 2;
    b = mob.getBounds(makeAABB());
    expect(b.maxX - b.minX).toBeCloseTo(7);
    expect(b.maxZ - b.minZ).toBeCloseTo(2.5);
  });

  test('a hit flashes red and knocks back', () => {
    const { ctx, entities } = makeCtx(flat());
    const mob = entities.add(new TestMob(100, 100, 100));
    run(ctx, 0.1);
    mob.onHit(ctx, { damage: 1, dir: new THREE.Vector3(1, -0.5, 0).normalize(), tool: 'hand' });
    expect(mob.health).toBe(9);
    expect(mob.velocity.x).toBeGreaterThan(20);
    expect(mob.velocity.y).toBeGreaterThan(0);
    run(ctx, 1 / 60);
    const rig = mob.object.children[0];
    const mesh = rig.children.find((c) => c.name === 'body')!.children[0] as THREE.Mesh;
    const emissive = (mesh.material as THREE.MeshStandardMaterial).emissive;
    expect(emissive.r).toBeGreaterThan(0.5);
    run(ctx, 0.4);
    expect(emissive.r).toBe(0);
  });

  test('death: loot drops, rolls on its side, sinks and is removed', () => {
    const { ctx, entities } = makeCtx(flat());
    const mob = entities.add(new TestMob(100, 100, 100, [{ item: 'meat_raw', count: 2 }, { item: 'hide', count: 1 }]));
    mob.displayName = 'Тест';
    run(ctx, 0.1);
    mob.onHit(ctx, { damage: 25, dir: new THREE.Vector3(0, 0, 1), tool: 'axe' });
    expect(mob.dead).toBe(true);
    expect(mob.displayName).toBe('');
    const drops = entities.all.filter((e): e is ItemDrop => e instanceof ItemDrop);
    expect(drops.map((d) => [d.itemId, d.count])).toEqual([
      ['meat_raw', 2],
      ['hide', 1],
    ]);
    mob.onHit(ctx, { damage: 25, dir: new THREE.Vector3(0, 0, 1), tool: 'axe' }); // corpses ignore hits
    expect(entities.all.length).toBe(3);

    run(ctx, 2);
    expect(drops.every((d) => !d.removed && entities.all.includes(d))).toBe(true); // the loot stays (far from the player)
    const rig = mob.object.children[0];
    expect(Math.abs(rig.rotation.z)).toBeCloseTo(Math.PI / 2);
    expect(rig.position.y).toBeCloseTo(1.25); // half the body width: lying on its side
    run(ctx, 9);
    expect(rig.position.y).toBeLessThan(0);
    expect(mob.removed).toBe(false);
    run(ctx, 2);
    expect(mob.removed || !entities.all.includes(mob)).toBe(true);
  });
});
