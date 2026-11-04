import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { BIOME_FOREST, BIOME_HILLS, BIOME_TOWN } from '../src/config';
import { Rng } from '../src/core/rng';
import type { GameContext } from '../src/game/context';
import { EntityManager } from '../src/game/entities/entityManager';
import { ItemDrop } from '../src/game/entities/itemDrop';
import { Deer, DeerHerd } from '../src/game/mobs/deer';
import {
  createDeerBrain,
  DEER,
  deerFleeDistance,
  deerNoticeDistance,
  stepDeerBrain,
  type DeerBrain,
  type DeerSenses,
} from '../src/game/mobs/deerBrain';
import type { Body } from '../src/game/physics';
import type { ColumnSample } from '../src/gen/types';
import { B } from '../src/world/blocks';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  const box = () => new THREE.BoxGeometry(1, 1, 1);
  return {
    getItemGeometry: () => new THREE.BoxGeometry(0.7, 0.7, 0.7),
    getMobRig: () => ({
      size: { width: 3, height: 11, length: 11 },
      parts: [
        { name: 'body', geometry: box(), pivot: [0, 7, 0], parent: null },
        { name: 'neck', geometry: box(), pivot: [0, 1.5, 4.5], parent: 'body' },
        { name: 'head', geometry: box(), pivot: [0, 3, 1], parent: 'neck' },
        { name: 'earL', geometry: box(), pivot: [-0.8, 1, 0], parent: 'head' },
        { name: 'earR', geometry: box(), pivot: [0.8, 1, 0], parent: 'head' },
        { name: 'legFL', geometry: box(), pivot: [-1, -1, 4], parent: 'body' },
        { name: 'legFR', geometry: box(), pivot: [1, -1, 4], parent: 'body' },
        { name: 'legBL', geometry: box(), pivot: [-1, -1, -4], parent: 'body' },
        { name: 'legBR', geometry: box(), pivot: [1, -1, -4], parent: 'body' },
        { name: 'tail', geometry: box(), pivot: [0, 0.5, -5.5], parent: 'body' },
      ],
    }),
  };
});
vi.mock('../src/render/voxelModel', async () => {
  const THREE = await import('three');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  return { getModelMaterial: () => material };
});
// Flat ground at y = 100 everywhere.
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

const senses = (o: Partial<DeerSenses> = {}): DeerSenses => ({
  dist: 1000,
  crouching: false,
  sprinting: false,
  moving: true,
  hit: false,
  noise: false,
  herd: 'none',
  moved: 0,
  ...o,
});
const half = () => 0.5;

function steps(b: DeerBrain, s: DeerSenses, seconds: number, dt = 0.05): string[] {
  const events: string[] = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const e = stepDeerBrain(b, s, dt, half);
    if (e !== 'none') events.push(e);
  }
  return events;
}

describe('deer brain: noticing and fleeing distances (deer.ts JSDoc)', () => {
  test('notice: 15 m walking or standing, 25 m sprinting, 5 m crouch-walking, never crouching still', () => {
    expect(deerNoticeDistance({ crouching: false, sprinting: false, moving: true })).toBe(150);
    expect(deerNoticeDistance({ crouching: false, sprinting: false, moving: false })).toBe(150);
    expect(deerNoticeDistance({ crouching: false, sprinting: true, moving: true })).toBe(250);
    expect(deerNoticeDistance({ crouching: true, sprinting: false, moving: true })).toBe(50);
    expect(deerNoticeDistance({ crouching: true, sprinting: false, moving: false })).toBe(0);
  });

  test('flee: 8 m, 2.5 m crouching', () => {
    expect(deerFleeDistance({ crouching: false })).toBe(80);
    expect(deerFleeDistance({ crouching: true })).toBe(25);
  });

  test('idle → alert exactly at the notice distance', () => {
    const b = createDeerBrain();
    expect(stepDeerBrain(b, senses({ dist: 151 }), 0.05, half)).toBe('none');
    expect(b.state).toBe('idle');
    expect(stepDeerBrain(b, senses({ dist: 150 }), 0.05, half)).toBe('alert');
    expect(b.state).toBe('alert');

    const sprint = createDeerBrain();
    expect(stepDeerBrain(sprint, senses({ dist: 249, sprinting: true }), 0.05, half)).toBe('alert');
    const crouch = createDeerBrain();
    expect(stepDeerBrain(crouch, senses({ dist: 51, crouching: true }), 0.05, half)).toBe('none');
    expect(stepDeerBrain(crouch, senses({ dist: 49, crouching: true }), 0.05, half)).toBe('alert');
    const still = createDeerBrain();
    expect(steps(still, senses({ dist: 30, crouching: true, moving: false }), 5)).toEqual([]);
    expect(still.state).toBe('idle');
  });

  test('a crouching player who stands still ~3 s lets an alert deer relax', () => {
    const b = createDeerBrain();
    stepDeerBrain(b, senses({ dist: 45, crouching: true }), 0.05, half);
    expect(b.state).toBe('alert');
    const still = senses({ dist: 45, crouching: true, moving: false });
    expect(steps(b, still, 2.9)).toEqual([]);
    expect(b.state).toBe('alert');
    expect(steps(b, still, 0.15)).toEqual(['relax']);
    expect(b.state).toBe('idle');
    // Creeping on (crouch-walking) inside 5 m alerts it again.
    expect(stepDeerBrain(b, senses({ dist: 40, crouching: true }), 0.05, half)).toBe('alert');
  });

  test('an alert deer relaxes 3 s after the player walked out of range', () => {
    const b = createDeerBrain();
    stepDeerBrain(b, senses({ dist: 120 }), 0.05, half);
    expect(steps(b, senses({ dist: 140 }), 5)).toEqual([]);
    expect(b.state).toBe('alert');
    expect(steps(b, senses({ dist: 160 }), 3.1)).toEqual(['relax']);
  });

  test('flees within 8 m upright, within 2.5 m crouching', () => {
    const walk = createDeerBrain();
    expect(stepDeerBrain(walk, senses({ dist: 81 }), 0.05, half)).toBe('alert');
    expect(stepDeerBrain(walk, senses({ dist: 80 }), 0.05, half)).toBe('flee');
    expect(walk.state).toBe('flee');

    const crouch = createDeerBrain();
    expect(stepDeerBrain(crouch, senses({ dist: 26, crouching: true }), 0.05, half)).toBe('alert');
    expect(stepDeerBrain(crouch, senses({ dist: 25, crouching: true }), 0.05, half)).toBe('flee');

    const sprint = createDeerBrain();
    expect(stepDeerBrain(sprint, senses({ dist: 70, sprinting: true }), 0.05, half)).toBe('flee');
  });

  test('a hit staggers it for 0.4 s, then it runs', () => {
    const b = createDeerBrain();
    expect(stepDeerBrain(b, senses({ hit: true, dist: 30 }), 0.05, half)).toBe('none');
    expect(b.state).toBe('stagger');
    expect(steps(b, senses({ dist: 30 }), 0.3)).toEqual([]);
    expect(b.state).toBe('stagger');
    expect(steps(b, senses({ dist: 30 }), 0.15)).toEqual(['flee']);
    expect(b.state).toBe('flee');
  });

  test('a loud noise or a fleeing herd mate starts a flight; a herd alert only raises the head', () => {
    const noise = createDeerBrain();
    expect(stepDeerBrain(noise, senses({ noise: true }), 0.05, half)).toBe('flee');
    const herdFlee = createDeerBrain();
    expect(stepDeerBrain(herdFlee, senses({ herd: 'flee' }), 0.05, half)).toBe('flee');
    const herdAlert = createDeerBrain();
    expect(stepDeerBrain(herdAlert, senses({ herd: 'alert' }), 0.05, half)).toBe('none');
    expect(herdAlert.state).toBe('alert');
    expect(steps(herdAlert, senses(), 3.1)).toEqual(['relax']);
  });

  test('runs 25–35 m, calms down within 8–12 s, then grazes again', () => {
    for (const r of [0, 0.5, 0.999]) {
      const b = createDeerBrain();
      stepDeerBrain(b, senses({ noise: true }), 0.05, () => r);
      expect(b.fleeLeft).toBeGreaterThanOrEqual(DEER.fleeRunMin);
      expect(b.fleeLeft).toBeLessThanOrEqual(DEER.fleeRunMax);
      let run = 0;
      while (b.state === 'flee') {
        stepDeerBrain(b, senses({ moved: 4.5 }), 0.05, () => r); // 9 m/s
        run += 4.5;
      }
      expect(run).toBeGreaterThanOrEqual(250);
      expect(run).toBeLessThanOrEqual(355);
      expect(b.state).toBe('recover');
      expect(b.timer).toBeGreaterThanOrEqual(8);
      expect(b.timer).toBeLessThanOrEqual(12);
      const calm = b.timer;
      expect(steps(b, senses(), calm - 0.1)).toEqual([]);
      expect(b.state).toBe('recover');
      expect(steps(b, senses(), 0.2)).toEqual(['relax']);
      expect(b.state).toBe('idle');
    }
  });

  test('keeps running while chased; gives up a blocked flight after 8 s', () => {
    const chased = createDeerBrain();
    stepDeerBrain(chased, senses({ dist: 50 }), 0.05, half);
    for (let i = 0; i < 100; i++) stepDeerBrain(chased, senses({ dist: 50, moved: 4.5 }), 0.05, half);
    expect(chased.state).toBe('flee');
    expect(chased.fleeLeft).toBeGreaterThanOrEqual(DEER.fleeChase - 4.5);

    const stuck = createDeerBrain();
    stepDeerBrain(stuck, senses({ noise: true }), 0.05, half);
    expect(steps(stuck, senses({ moved: 0 }), 7.9)).toEqual([]);
    expect(stuck.state).toBe('flee');
    steps(stuck, senses({ moved: 0 }), 0.15);
    expect(stuck.state).toBe('recover');
  });

  test('recovering: bolts again when approached; ends alert if the player is still noticeable', () => {
    const b = createDeerBrain();
    b.state = 'recover';
    b.timer = 10;
    expect(stepDeerBrain(b, senses({ dist: 70 }), 0.05, half)).toBe('flee');
    const watchful = createDeerBrain();
    watchful.state = 'recover';
    watchful.timer = 1;
    expect(steps(watchful, senses({ dist: 120 }), 1.1)).toEqual(['alert']);
    expect(watchful.state).toBe('alert');
  });
});

// ------------------------------------------------------------------ the Deer entity

const flatWorld = { getBlock: (_x: number, y: number) => (y < 100 ? B.STONE : B.AIR) };

function makeCtx(biomeAt = (x: number, _z: number): number => (x < 640 ? BIOME_TOWN : BIOME_FOREST)) {
  const terrain = {
    biomeAt,
    surfaceY: () => 100,
    sample: (x: number, z: number, out: ColumnSample) => {
      out.waterY = x > 900 && z > 900 ? 101 : 0; // a lake in the far corner
      return out;
    },
  };
  const parts = {
    world: flatWorld,
    terrain,
    entities: new EntityManager(new THREE.Scene()),
    player: { position: new THREE.Vector3(800, 100, 400), crouching: false, sprinting: false, flying: false, horizontalSpeed: 0, height: 18 },
    input: { active: true, uiOpen: false },
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

function run(ctx: GameContext, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    ctx.time.elapsed += dt;
    ctx.entities.update(dt, ctx);
  }
}

describe('Deer', () => {
  test('health 9: three tool hits kill it; it drops meat ×2 and a hide', () => {
    const { ctx, entities } = makeCtx();
    const deer = entities.add(new Deer(800, 100, 800, 1));
    expect(deer.health).toBe(9);
    expect(deer.maxHealth).toBe(9);
    expect(deer.displayName).toBe('Косуля');
    const hit = { damage: 3, dir: new THREE.Vector3(1, 0, 0), tool: 'shovel' };
    deer.onHit(ctx, hit);
    deer.onHit(ctx, hit);
    expect(deer.dead).toBe(false);
    deer.onHit(ctx, hit);
    expect(deer.dead).toBe(true);
    expect(deer.displayName).toBe('');
    const drops = entities.all.filter((e): e is ItemDrop => e instanceof ItemDrop);
    expect(drops.map((d) => `${d.itemId}×${d.count}`).sort()).toEqual(['hide×1', 'meat_raw×2']);
  });

  test('bare hands need nine hits', () => {
    const { ctx } = makeCtx();
    const deer = new Deer(800, 100, 800, 1);
    for (let i = 0; i < 8; i++) deer.onHit(ctx, { damage: 1, dir: new THREE.Vector3(0, 0, 1), tool: 'hand' });
    expect(deer.dead).toBe(false);
    deer.onHit(ctx, { damage: 1, dir: new THREE.Vector3(0, 0, 1), tool: 'hand' });
    expect(deer.dead).toBe(true);
  });

  test('notices a walking player at 15 m (alarm call), bolts at 8 m and runs away', () => {
    const { ctx, entities, player, audio } = makeCtx();
    const deer = entities.add(new Deer(800, 100, 800, 2));
    player.horizontalSpeed = 38;
    player.position.set(800, 100, 800 - 160);
    run(ctx, 0.5);
    expect(deer.brain.state).toBe('idle');
    player.position.set(deer.position.x, 100, deer.position.z - 140);
    run(ctx, 0.1);
    expect(deer.brain.state).toBe('alert');
    expect(audio.play).toHaveBeenCalledWith('deer_alert', expect.anything());

    player.position.set(deer.position.x, 100, deer.position.z - 70);
    const start = deer.position.clone();
    run(ctx, 0.1);
    expect(deer.brain.state).toBe('flee');
    run(ctx, 2);
    expect(deer.position.z - start.z).toBeGreaterThan(100); // away from the player (who is at -z)
    expect(deer.velocity.length()).toBeGreaterThan(60);
  });

  test('a hit staggers it, then it flees from the hunter; herd mates run too', () => {
    const { ctx, entities, player } = makeCtx();
    const herd = new DeerHerd();
    const a = entities.add(new Deer(800, 100, 800, 3, herd));
    const b = entities.add(new Deer(830, 100, 810, 4, herd));
    player.position.set(800, 100, 780);
    a.onHit(ctx, { damage: 3, dir: new THREE.Vector3(0, 0, 1), tool: 'axe' });
    run(ctx, 0.2);
    expect(a.brain.state).toBe('stagger');
    run(ctx, 0.3);
    expect(a.brain.state).toBe('flee');
    run(ctx, 0.1);
    expect(b.brain.state).toBe('flee');
    run(ctx, 1.5);
    expect(a.position.z).toBeGreaterThan(830);
    expect(b.position.z).toBeGreaterThan(830);
  });

  test('a loud noise (e.g. a bark) makes it flee from the source', () => {
    const { ctx, entities } = makeCtx();
    const deer = entities.add(new Deer(800, 100, 800, 5));
    entities.emitNoise(ctx, { x: 780, y: 100, z: 800 }, 200);
    run(ctx, 0.1);
    expect(deer.brain.state).toBe('flee');
    run(ctx, 1.5);
    expect(deer.position.x).toBeGreaterThan(850);
  });

  test('herd targets stay in natural biomes and out of water', () => {
    const { ctx } = makeCtx();
    const herd = new DeerHerd();
    new Deer(700, 100, 950, 6, herd);
    const rng = new Rng(9);
    for (let i = 0; i < 200; i++) {
      herd.pickTarget(ctx, rng);
      expect(herd.targetX).toBeGreaterThanOrEqual(640);
      expect(herd.targetX > 900 && herd.targetZ > 900).toBe(false);
      expect(Math.hypot(herd.targetX - 700, herd.targetZ - 950)).toBeLessThanOrEqual(250);
    }
  });

  // Town west of x = 64 m, forest up to x = 100 m, hills beyond.
  const forestThenHills = (x: number): number => (x < 640 ? BIOME_TOWN : x < 1000 ? BIOME_FOREST : BIOME_HILLS);

  test('herd targets stay within 30 m of home and in the home biome', () => {
    const { ctx } = makeCtx(forestThenHills);
    const herd = new DeerHerd();
    const deer = new Deer(950, 100, 600, 10, herd);
    expect([herd.homeX, herd.homeZ]).toEqual([950, 600]);
    const rng = new Rng(11);
    for (let i = 0; i < 200; i++) {
      // The herd drifts around its home range: each pick starts where the last one went.
      deer.position.set(herd.targetX || 950, 100, herd.targetZ || 600);
      herd.pickTarget(ctx, rng);
      expect(herd.homeDistance(herd.targetX, herd.targetZ)).toBeLessThanOrEqual(300);
      expect(herd.targetX).toBeLessThan(1000);
    }
  });

  test('a herd outside its home range heads back home, even through another biome', () => {
    const { ctx } = makeCtx(forestThenHills);
    const herd = new DeerHerd();
    const deer = new Deer(900, 100, 600, 12, herd);
    deer.position.set(1300, 100, 700); // 32 m away, in the hills
    const rng = new Rng(13);
    for (let i = 0; i < 50; i++) {
      herd.pickTarget(ctx, rng);
      expect(herd.homeDistance(herd.targetX, herd.targetZ)).toBeLessThan(herd.homeDistance(1300, 700) - 30);
    }
  });

  test('driven into the hills by noises, the herd walks back to its home range', () => {
    const { ctx, entities, player } = makeCtx(forestThenHills);
    player.position.set(50, 100, 50); // deep in the town, far out of sight
    const herd = new DeerHerd();
    const a = entities.add(new Deer(900, 100, 600, 14, herd));
    const b = entities.add(new Deer(910, 100, 610, 15, herd));
    const centre = { x: 0, z: 0 };
    for (let i = 0; i < 4; i++) {
      herd.centre(centre);
      entities.emitNoise(ctx, { x: centre.x - 30, y: 100, z: centre.z }, 200);
      run(ctx, 15);
    }
    herd.centre(centre);
    expect(centre.x).toBeGreaterThan(1000); // the flights carried it east, out of the forest
    run(ctx, 600);
    expect(herd.homeDistance(herd.targetX, herd.targetZ)).toBeLessThanOrEqual(300);
    expect(herd.targetX).toBeLessThan(1000);
    for (const deer of [a, b]) {
      expect(deer.brain.state).toBe('idle');
      expect(Math.hypot(deer.position.x - herd.targetX, deer.position.z - herd.targetZ)).toBeLessThan(100);
    }
  });

  test('never wanders into the town, even towards a target there', () => {
    const { ctx, entities } = makeCtx();
    const herd = new DeerHerd();
    const deer = entities.add(new Deer(700, 100, 500, 7, herd));
    herd.setTarget(500, 500);
    herd.nextMoveAt = 1e9;
    run(ctx, 20);
    expect(deer.position.x).toBeGreaterThanOrEqual(640);
  });

  test('grazes and wanders while undisturbed (cheap, no alarm)', () => {
    const { ctx, entities, audio, player } = makeCtx();
    player.position.set(50, 100, 50); // deep in the town, far out of sight
    const herd = new DeerHerd();
    const a = entities.add(new Deer(900, 100, 600, 8, herd));
    const b = entities.add(new Deer(910, 100, 610, 9, herd));
    const start = a.position.clone();
    run(ctx, 120);
    expect(a.brain.state).toBe('idle');
    expect(audio.play).not.toHaveBeenCalled();
    expect(a.position.distanceTo(start)).toBeGreaterThan(5);
    expect(a.position.distanceTo(b.position)).toBeLessThan(120); // the herd stays together
  });
});
