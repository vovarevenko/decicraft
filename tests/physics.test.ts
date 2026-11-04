import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { GRAVITY, PLAYER } from '../src/config';
import {
  aabbHitsWorld,
  blockUnder,
  bodyAABB,
  boxBlocked,
  makeAABB,
  moveBody,
  waterFraction,
  type AABB,
  type Body,
  type MoveOptions,
} from '../src/game/physics';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';

/** Ground: solid up to y = FLOOR (the first air voxel). Every test builds in its own strip of x. */
const FLOOR = 100;
const world = World.create();

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** A flat test pad: stone floor (one layer under FLOOR) over [x0, x1) × [z0, z1). */
function pad(x0: number, x1: number, z0 = 0, z1 = 40): void {
  fill(x0, FLOOR - 1, z0, x1, FLOOR, z1, B.STONE);
}

function makeBody(x: number, y: number, z: number, halfWidth: number = PLAYER.halfWidth, height: number = PLAYER.height): Body {
  return { position: new THREE.Vector3(x, y, z), velocity: new THREE.Vector3(), halfWidth, height, onGround: false };
}

const DT = 1 / 60;
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);

/** Integrates gravity + a constant horizontal velocity for `frames` frames. */
function simulate(body: Body, frames: number, vx: number, vz: number, opts?: MoveOptions, dt = DT): void {
  for (let i = 0; i < frames; i++) {
    body.velocity.x = vx;
    body.velocity.z = vz;
    const dy = (body.velocity.y - 0.5 * GRAVITY * dt) * dt;
    body.velocity.y -= GRAVITY * dt;
    moveBody(world, body, vx * dt, dy, vz * dt, opts);
  }
}

const box = makeAABB();
const inside = (body: Body, solids: readonly AABB[] = []): boolean => boxBlocked(world, bodyAABB(body, box), solids);

describe('moveBody: falling and landing', () => {
  test('a falling body lands on the floor with onGround and zero vertical velocity', () => {
    pad(0, 40);
    const body = makeBody(20, FLOOR + 30, 20);
    simulate(body, 120, 0, 0);
    expect(body.onGround).toBe(true);
    expect(body.velocity.y).toBe(0);
    expect(body.position.y).toBeGreaterThanOrEqual(FLOOR);
    expect(body.position.y).toBeLessThan(FLOOR + 0.01);
    expect(inside(body)).toBe(false);
    expect(aabbHitsWorld(world, bodyAABB(body, box))).toBe(false);
  });

  test('dy = -50 in one call does not tunnel through a 1-voxel floor', () => {
    fill(40, 60, 0, 80, 61, 40, B.STONE); // thin slab floating at y = 60
    const body = makeBody(60, 61 + 30, 20);
    const r = moveBody(world, body, 0, -50, 0);
    expect(r.hitY).toBe(true);
    expect(body.onGround).toBe(true);
    expect(body.position.y).toBeCloseTo(61, 2);
    expect(body.position.y).toBeGreaterThanOrEqual(61);
  });

  test('glass carries a body; foliage, plants and water do not', () => {
    pad(80, 120);
    fill(85, FLOOR + 5, 15, 95, FLOOR + 6, 25, B.GLASS);
    fill(100, FLOOR, 15, 110, FLOOR + 8, 25, B.OAK_LEAVES);
    fill(100, FLOOR + 8, 15, 110, FLOOR + 9, 25, B.TALL_GRASS);
    const onGlass = makeBody(90, FLOOR + 20, 20);
    simulate(onGlass, 90, 0, 0);
    expect(onGlass.onGround).toBe(true);
    expect(onGlass.position.y).toBeCloseTo(FLOOR + 6, 2);

    const throughLeaves = makeBody(105, FLOOR + 20, 20);
    simulate(throughLeaves, 120, 0, 0);
    expect(throughLeaves.onGround).toBe(true);
    expect(throughLeaves.position.y).toBeCloseTo(FLOOR, 2);
  });

  test('ceilings stop jumps: velocity zeroed, the head stays below', () => {
    pad(120, 160);
    fill(120, FLOOR + 20, 0, 160, FLOOR + 21, 40, B.CONCRETE); // ceiling 2 m above the floor
    const body = makeBody(140, FLOOR, 20);
    simulate(body, 5, 0, 0);
    body.velocity.y = PLAYER.jumpSpeed;
    let hitCeiling = false;
    let maxTop = 0;
    for (let i = 0; i < 60; i++) {
      const dy = (body.velocity.y - 0.5 * GRAVITY * DT) * DT;
      body.velocity.y -= GRAVITY * DT;
      const r = moveBody(world, body, 0, dy, 0);
      if (r.hitY && dy > 0) {
        hitCeiling = true;
        expect(body.velocity.y).toBe(0);
      }
      maxTop = Math.max(maxTop, body.position.y + body.height);
    }
    expect(hitCeiling).toBe(true);
    expect(maxTop).toBeLessThanOrEqual(FLOOR + 20);
    expect(body.onGround).toBe(true);
  });
});

describe('moveBody: walls and step-up', () => {
  const stepOpts: MoveOptions = { stepHeight: PLAYER.stepHeight };

  test.each([1, 2, 3, 4])('a %i-voxel step is climbed while walking', (h) => {
    const x0 = 160 + (h - 1) * 40;
    pad(x0, x0 + 40);
    fill(x0 + 20, FLOOR, 0, x0 + 40, FLOOR + h, 40, B.STONE);
    const body = makeBody(x0 + 10, FLOOR, 20);
    simulate(body, 5, 0, 0, stepOpts);
    let stepped = 0;
    for (let i = 0; i < 30; i++) {
      body.velocity.x = PLAYER.walkSpeed;
      const dy = (body.velocity.y - 0.5 * GRAVITY * DT) * DT;
      body.velocity.y -= GRAVITY * DT;
      stepped += moveBody(world, body, PLAYER.walkSpeed * DT, dy, 0, stepOpts).stepped;
    }
    expect(body.position.x).toBeGreaterThan(x0 + 25);
    expect(body.position.y).toBeCloseTo(FLOOR + h, 2);
    expect(stepped).toBeCloseTo(h, 2);
    expect(body.onGround).toBe(true);
    expect(inside(body)).toBe(false);
  });

  test('a 5-voxel step stops the body without penetration', () => {
    const x0 = 320;
    pad(x0, x0 + 40);
    fill(x0 + 20, FLOOR, 0, x0 + 40, FLOOR + 5, 40, B.STONE);
    const body = makeBody(x0 + 10, FLOOR, 20);
    let hitX = false;
    for (let i = 0; i < 60; i++) {
      body.velocity.x = PLAYER.walkSpeed;
      const dy = (body.velocity.y - 0.5 * GRAVITY * DT) * DT;
      body.velocity.y -= GRAVITY * DT;
      hitX = moveBody(world, body, PLAYER.walkSpeed * DT, dy, 0, stepOpts).hitX || hitX;
    }
    expect(hitX).toBe(true);
    expect(body.velocity.x).toBe(0);
    expect(body.position.y).toBeCloseTo(FLOOR, 2);
    expect(body.position.x + body.halfWidth).toBeLessThanOrEqual(x0 + 20);
    expect(body.position.x + body.halfWidth).toBeGreaterThan(x0 + 20 - 0.01);
  });

  test('no step-up without head room, and none while airborne', () => {
    const x0 = 360;
    pad(x0, x0 + 40);
    fill(x0 + 20, FLOOR, 0, x0 + 40, FLOOR + 2, 40, B.STONE);
    fill(x0, FLOOR + 19, 0, x0 + 40, FLOOR + 20, 40, B.STONE); // 1.9 m ceiling: 2 voxels too low on the step
    const body = makeBody(x0 + 10, FLOOR, 20);
    simulate(body, 60, PLAYER.walkSpeed, 0, stepOpts);
    expect(body.position.y).toBeCloseTo(FLOOR, 2);
    expect(body.position.x + body.halfWidth).toBeLessThanOrEqual(x0 + 20);

    const airborne = makeBody(x0 + 16.9, FLOOR + 0.5, 20);
    airborne.onGround = false;
    const r = moveBody(world, airborne, 1, -0.1, 0, stepOpts);
    expect(r.stepped).toBe(0);
    expect(r.hitX).toBe(true);
  });

  test('walls stop fast bodies without penetration from every side', () => {
    const x0 = 400;
    pad(x0, x0 + 60, 0, 60);
    fill(x0 + 29, FLOOR, 29, x0 + 31, FLOOR + 30, 31, B.BRICK); // 2×2 pillar
    const cases: [number, number, number, number][] = [
      [x0 + 10, 30, 70, 0],
      [x0 + 50, 30, -70, 0],
      [x0 + 30, 10, 0, 70],
      [x0 + 30, 50, 0, -70],
    ];
    for (const [x, z, vx, vz] of cases) {
      const body = makeBody(x, FLOOR, z);
      simulate(body, 40, vx, vz, undefined, 0.05);
      expect(inside(body)).toBe(false);
      expect(aabbHitsWorld(world, bodyAABB(body, box))).toBe(false);
      const b = bodyAABB(body, box);
      const gap = vx > 0 ? x0 + 29 - b.maxX : vx < 0 ? b.minX - (x0 + 31) : vz > 0 ? 29 - b.maxZ : b.minZ - 31;
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThan(0.01);
    }
  });

  test('sliding: a diagonal move into a wall keeps the parallel component', () => {
    const x0 = 460;
    pad(x0, x0 + 40);
    fill(x0 + 20, FLOOR, 0, x0 + 21, FLOOR + 30, 40, B.STONE);
    const body = makeBody(x0 + 16, FLOOR, 10);
    simulate(body, 30, 30, 30);
    expect(body.position.x + body.halfWidth).toBeLessThanOrEqual(x0 + 20);
    expect(body.position.z).toBeGreaterThan(10 + 30 * 30 * DT * 0.9);
  });
});

describe('moveBody: extra solid boxes', () => {
  test('a 0.4-unit-thick box (door leaf) is not tunnelled at 70 units/s', () => {
    const x0 = 500;
    pad(x0, x0 + 60);
    const door: AABB = { minX: x0 + 30, maxX: x0 + 30.4, minY: FLOOR, maxY: FLOOR + 20, minZ: 10, maxZ: 30 };
    for (const dt of [1 / 60, 0.05]) {
      const body = makeBody(x0 + 10, FLOOR, 20);
      simulate(body, 30, 70, 0, { solids: [door] }, dt);
      expect(body.position.x + body.halfWidth).toBeLessThanOrEqual(door.minX);
      expect(body.position.x + body.halfWidth).toBeGreaterThan(door.minX - 0.01);
      expect(body.velocity.x).toBe(0);
    }
    // In one huge move as well, from the other side too.
    const body = makeBody(x0 + 50, FLOOR + 0.001, 20);
    body.onGround = true;
    moveBody(world, body, -400, 0, 0, { solids: [door] });
    expect(body.position.x - body.halfWidth).toBeGreaterThanOrEqual(door.maxX);
  });

  test('bodies stand on boxes, step onto low ones and can leave a box they are inside', () => {
    const x0 = 560;
    pad(x0, x0 + 60);
    const crate: AABB = { minX: x0 + 20, maxX: x0 + 26, minY: FLOOR, maxY: FLOOR + 4, minZ: 16, maxZ: 24 };
    const onTop = makeBody(x0 + 23, FLOOR + 10, 20, 2, 10);
    simulate(onTop, 60, 0, 0, { solids: [crate] });
    expect(onTop.onGround).toBe(true);
    expect(onTop.position.y).toBeCloseTo(FLOOR + 4, 2);

    const walker = makeBody(x0 + 10, FLOOR, 20);
    simulate(walker, 24, PLAYER.walkSpeed, 0, { solids: [crate], stepHeight: PLAYER.stepHeight });
    expect(walker.position.x).toBeGreaterThan(x0 + 20);
    expect(walker.position.y).toBeCloseTo(FLOOR + 4, 2);

    const stuck = makeBody(x0 + 23, FLOOR, 20, 1, 2); // inside the crate
    simulate(stuck, 30, 0, 30, { solids: [crate] });
    expect(stuck.position.z).toBeGreaterThan(25);
  });
});

describe('moveBody: snapping, edge guard, noclip', () => {
  test('snapDown walks down a 3-voxel drop on the ground and reports it', () => {
    const x0 = 620;
    pad(x0, x0 + 40);
    fill(x0, FLOOR, 0, x0 + 20, FLOOR + 3, 40, B.STONE); // upper level
    const body = makeBody(x0 + 15, FLOOR + 3, 20);
    simulate(body, 3, 0, 0);
    let snapped = 0;
    let airborne = false;
    for (let i = 0; i < 30; i++) {
      const dy = (body.velocity.y - 0.5 * GRAVITY * DT) * DT;
      body.velocity.y -= GRAVITY * DT;
      snapped += moveBody(world, body, PLAYER.walkSpeed * DT, dy, 0, { stepHeight: PLAYER.stepHeight, snapDown: PLAYER.stepHeight }).snapped;
      if (!body.onGround) airborne = true;
    }
    expect(airborne).toBe(false);
    expect(snapped).toBeCloseTo(3, 2);
    expect(body.position.y).toBeCloseTo(FLOOR, 2);
  });

  test('the edge guard stops a body at a deep drop but lets it walk down a shallow one', () => {
    const x0 = 660;
    fill(x0, FLOOR + 9, 0, x0 + 20, FLOOR + 10, 40, B.STONE); // a ledge 10 voxels above the pad
    pad(x0, x0 + 40);
    const guard: MoveOptions = { stepHeight: PLAYER.stepHeight, snapDown: PLAYER.stepHeight, edgeGuard: PLAYER.stepHeight + 0.5 };
    const body = makeBody(x0 + 10, FLOOR + 10, 20, 3, 14);
    simulate(body, 3, 0, 0, guard);
    simulate(body, 60, 20, 0, guard);
    expect(body.onGround).toBe(true);
    expect(body.position.y).toBeCloseTo(FLOOR + 10, 2);
    expect(body.position.x - body.halfWidth).toBeLessThan(x0 + 20);
    expect(body.position.x).toBeGreaterThan(x0 + 18); // reached the edge

    fill(x0 + 20, FLOOR + 7, 0, x0 + 40, FLOOR + 8, 40, B.STONE); // now only a 2-voxel drop
    simulate(body, 30, 20, 0, guard);
    expect(body.onGround).toBe(true);
    expect(body.position.x).toBeGreaterThan(x0 + 25);
    expect(body.position.y).toBeCloseTo(FLOOR + 8, 2);
  });

  test('noClip moves through everything and is never on the ground', () => {
    const body = makeBody(20, FLOOR + 5, 20);
    const r = moveBody(world, body, 0, -50, 0, { noClip: true });
    expect(body.position.y).toBeCloseTo(FLOOR - 45, 6);
    expect(body.onGround).toBe(false);
    expect(r.hitY).toBe(false);
  });
});

describe('queries', () => {
  test('aabbHitsWorld uses min-inclusive / max-exclusive voxel ranges', () => {
    world.setBlock(700, 200, 700, B.STONE);
    const b: AABB = { minX: 699, minY: 199, minZ: 699, maxX: 700, maxY: 200, maxZ: 700 };
    expect(aabbHitsWorld(world, b)).toBe(false); // touches the voxel's min corner
    b.maxX = 700.01;
    b.maxY = 200.01;
    b.maxZ = 700.01;
    expect(aabbHitsWorld(world, b)).toBe(true);
    const above: AABB = { minX: 700, minY: 201, minZ: 700, maxX: 701, maxY: 202, maxZ: 701 };
    expect(aabbHitsWorld(world, above)).toBe(false);
    above.minY = 200.99;
    expect(aabbHitsWorld(world, above)).toBe(true);
    // Below y = 0 is bedrock.
    expect(aabbHitsWorld(world, { minX: 5, minY: -0.5, minZ: 5, maxX: 6, maxY: 0.5, maxZ: 6 })).toBe(true);
  });

  test('waterFraction measures the submerged share of the height', () => {
    fill(720, FLOOR - 1, 0, 740, FLOOR, 20, B.STONE);
    fill(720, FLOOR, 0, 740, FLOOR + 9, 20, B.WATER);
    expect(waterFraction(world, makeBody(730, FLOOR, 10))).toBeCloseTo(0.5, 6);
    expect(waterFraction(world, makeBody(730, FLOOR + 4.5, 10))).toBeCloseTo(0.25, 6);
    expect(waterFraction(world, makeBody(730, FLOOR + 9, 10))).toBe(0);
    expect(waterFraction(world, makeBody(730, FLOOR, 10, 3, 4))).toBe(1);
  });

  test('blockUnder reads the voxel under the feet', () => {
    fill(750, FLOOR - 1, 0, 760, FLOOR, 10, B.GRAVEL);
    const body = makeBody(755.5, FLOOR + 0.001, 5.5);
    expect(blockUnder(world, body)).toBe(B.GRAVEL);
    body.position.y = FLOOR;
    expect(blockUnder(world, body)).toBe(B.GRAVEL);
    body.position.y = FLOOR + 3;
    expect(blockUnder(world, body)).toBe(B.AIR);
  });

  test('boxBlocked treats touching as free and overlap as blocked', () => {
    world.setBlock(780, 300, 780, B.STONE);
    expect(boxBlocked(world, { minX: 781, minY: 300, minZ: 780, maxX: 782, maxY: 301, maxZ: 781 })).toBe(false);
    expect(boxBlocked(world, { minX: 780.5, minY: 300, minZ: 780, maxX: 782, maxY: 301, maxZ: 781 })).toBe(true);
    const solid: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    expect(boxBlocked(world, { minX: 1, minY: 0, minZ: 0, maxX: 2, maxY: 1, maxZ: 1 }, [solid])).toBe(false);
    expect(boxBlocked(world, { minX: 0.9, minY: 0, minZ: 0, maxX: 2, maxY: 1, maxZ: 1 }, [solid])).toBe(true);
  });
});

test('performance: player-sized moves (reported; asserted only with BENCH)', () => {
  const x0 = 800;
  pad(x0, x0 + 100, 0, 100);
  for (let i = 0; i < 40; i++) fill(x0 + 5 + ((i * 37) % 90), FLOOR, 5 + ((i * 53) % 90), x0 + 7 + ((i * 37) % 90), FLOOR + 1 + (i % 5), 7 + ((i * 53) % 90), B.STONE);
  const body = makeBody(x0 + 50, FLOOR, 50);
  const opts: MoveOptions = { stepHeight: PLAYER.stepHeight, snapDown: PLAYER.stepHeight };
  const frames = 6000;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    const a = i * 0.01;
    const vx = Math.cos(a) * PLAYER.sprintSpeed;
    const vz = Math.sin(a * 1.3) * PLAYER.sprintSpeed;
    const dy = (body.velocity.y - 0.5 * GRAVITY * DT) * DT;
    body.velocity.y -= GRAVITY * DT;
    moveBody(world, body, vx * DT, dy, vz * DT, opts);
  }
  const usPerMove = ((performance.now() - t0) * 1000) / frames;
  console.info(`[physics] sprinting moveBody: ${usPerMove.toFixed(1)} µs per frame`);
  expect(inside(body)).toBe(false);
  if (BENCH) expect(usPerMove).toBeLessThan(100);
});
