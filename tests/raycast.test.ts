import { describe, expect, test } from 'vitest';
import { B, SOLID } from '../src/world/blocks';
import { makeVoxelHit, raycastVoxels } from '../src/world/raycast';
import { World } from '../src/world/world';

const world = World.create();
const at = (x: number, y: number, z: number) => ({ x, y, z });

describe('raycastVoxels', () => {
  test('axis-aligned rays hit the first voxel with the entered face normal, distance and point', () => {
    world.setBlock(20, 100, 10, B.STONE);
    const hit = raycastVoxels(world, at(10.5, 100.5, 10.5), at(1, 0, 0), 40);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([20, 100, 10]);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-1, 0, 0]);
    expect(hit!.id).toBe(B.STONE);
    expect(hit!.distance).toBeCloseTo(9.5, 9);
    expect([hit!.px, hit!.py, hit!.pz]).toEqual([20, 100.5, 10.5]);
  });

  test('normals for all six directions', () => {
    const c = { x: 40, y: 100, z: 40 };
    world.setBlock(c.x, c.y, c.z, B.BRICK);
    const cases: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of cases) {
      const origin = at(c.x + 0.5 - dx * 5, c.y + 0.5 - dy * 5, c.z + 0.5 - dz * 5);
      const hit = raycastVoxels(world, origin, at(dx, dy, dz), 10);
      expect(hit).not.toBeNull();
      expect([hit!.x, hit!.y, hit!.z]).toEqual([c.x, c.y, c.z]);
      expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-dx, -dy, -dz].map((v) => v + 0));
      expect(hit!.distance).toBeCloseTo(4.5, 9);
    }
  });

  test('diagonal rays visit the voxels a straight line crosses', () => {
    // A staircase of single voxels along the diagonal: the ray hits the first one it enters.
    world.setBlock(63, 103, 60, B.STONE);
    const dir = at(1 / Math.SQRT2, 1 / Math.SQRT2, 0);
    const hit = raycastVoxels(world, at(60.2, 100.5, 60.5), dir, 20);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([63, 103, 60]);
    // The ray rises above y = 103 (t = 2.5·√2) before it crosses x = 63 (t = 2.8·√2): entered through −X.
    expect(hit!.distance).toBeCloseTo(2.8 * Math.SQRT2, 9);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-1, 0, 0]);
    // The entry point lies on the entered face.
    expect(hit!.px).toBeCloseTo(60.2 + dir.x * hit!.distance, 9);
    expect(hit!.py).toBeCloseTo(100.5 + dir.y * hit!.distance, 9);

    // A 3D diagonal through a block of voxels gets the nearest one.
    for (let x = 80; x < 84; x++) for (let y = 104; y < 108; y++) for (let z = 80; z < 84; z++) world.setBlock(x, y, z, B.DIRT);
    const d3 = 1 / Math.sqrt(3);
    const hit3 = raycastVoxels(world, at(76.5, 100.5, 76.5), at(d3, d3, d3), 40);
    expect(hit3).not.toBeNull();
    expect([hit3!.x, hit3!.y, hit3!.z]).toEqual([80, 104, 80]);
    expect(Math.abs(hit3!.nx) + Math.abs(hit3!.ny) + Math.abs(hit3!.nz)).toBe(1);
  });

  test('maxDist bounds the search by entry distance', () => {
    world.setBlock(130, 100, 100, B.STONE);
    const origin = at(120.5, 100.5, 100.5);
    expect(raycastVoxels(world, origin, at(1, 0, 0), 9.4)).toBeNull();
    expect(raycastVoxels(world, origin, at(1, 0, 0), 9.5)?.x).toBe(130);
    expect(raycastVoxels(world, origin, at(-1, 0, 0), 1000)).toBeNull();
  });

  test('a ray starting inside a voxel hits it at distance 0 with a zero normal', () => {
    world.setBlock(150, 100, 100, B.GRANITE);
    const hit = raycastVoxels(world, at(150.3, 100.7, 100.2), at(0, 0, 1), 10);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z, hit!.distance]).toEqual([150, 100, 100, 0]);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([0, 0, 0]);
  });

  test('water is skipped by default; a custom accept skips foliage', () => {
    for (let x = 170; x < 175; x++) world.setBlock(x, 100, 100, B.WATER);
    world.setBlock(175, 100, 100, B.OAK_LEAVES);
    world.setBlock(177, 100, 100, B.STONE);
    const origin = at(168.5, 100.5, 100.5);
    expect(raycastVoxels(world, origin, at(1, 0, 0), 20)?.id).toBe(B.OAK_LEAVES);
    const solidOnly = (id: number) => SOLID[id] === 1;
    const hit = raycastVoxels(world, origin, at(1, 0, 0), 20, solidOnly);
    expect(hit?.id).toBe(B.STONE);
    expect(hit?.x).toBe(177);
  });

  test('accept gets the voxel as well: a ray passes the voxels it refuses by position', () => {
    for (let x = 180; x < 184; x++) world.setBlock(x, 110, 100, B.OAK_LOG);
    const seen: number[] = [];
    const hit = raycastVoxels(world, at(178.5, 110.5, 100.5), at(1, 0, 0), 20, (id, x, y, z) => {
      if (id !== B.AIR) seen.push(x, y, z);
      return id !== B.AIR && x >= 182;
    });
    expect(seen).toEqual([180, 110, 100, 181, 110, 100, 182, 110, 100]);
    expect([hit!.x, hit!.y, hit!.z, hit!.nx]).toEqual([182, 110, 100, -1]);
  });

  test('tall plants are hit through the air cells they are drawn into', () => {
    // Reeds (PLANT_HEIGHT 12) at y = 100 visually fill y = 100…111.
    world.setBlock(200, 100, 100, B.REEDS);
    const hit = raycastVoxels(world, at(195.5, 108.5, 100.5), at(1, 0, 0), 20);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z, hit!.id]).toEqual([200, 100, 100, B.REEDS]);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-1, 0, 0]);
    expect(hit!.distance).toBeCloseTo(4.5, 9);
    expect([hit!.px, hit!.py, hit!.pz]).toEqual([200, 108.5, 100.5]);
    expect(raycastVoxels(world, at(195.5, 111.5, 100.5), at(1, 0, 0), 20)?.y).toBe(100);
    expect(raycastVoxels(world, at(195.5, 112.5, 100.5), at(1, 0, 0), 20)).toBeNull();

    // Tall grass (3) reaches two cells above its own.
    world.setBlock(220, 100, 100, B.TALL_GRASS);
    expect(raycastVoxels(world, at(215.5, 102.5, 100.5), at(1, 0, 0), 20)?.id).toBe(B.TALL_GRASS);
    expect(raycastVoxels(world, at(215.5, 103.5, 100.5), at(1, 0, 0), 20)).toBeNull();

    // Plants do not count when accept() refuses them, nor through a non-air cell.
    expect(raycastVoxels(world, at(195.5, 108.5, 100.5), at(1, 0, 0), 20, (id) => SOLID[id] === 1)).toBeNull();
    world.setBlock(240, 100, 100, B.REEDS);
    world.setBlock(240, 103, 100, B.GLASS);
    const blocked = raycastVoxels(world, at(235.5, 106.5, 100.5), at(1, 0, 0), 20, (id) => id === B.REEDS);
    expect(blocked).toBeNull();
  });

  test('the start cell does not pick up a tall plant below it', () => {
    world.setBlock(260, 100, 100, B.REEDS);
    world.setBlock(264, 108, 100, B.STONE);
    const hit = raycastVoxels(world, at(260.5, 108.5, 100.5), at(1, 0, 0), 20);
    expect(hit?.id).toBe(B.STONE);
  });

  test('writes into `out`, handles zero direction components and zero directions', () => {
    world.setBlock(300, 100, 100, B.STONE);
    const out = makeVoxelHit();
    const hit = raycastVoxels(world, at(300.5, 110.5, 100.5), at(0, -1, 0), 20, undefined, out);
    expect(hit).toBe(out);
    expect([out.x, out.y, out.z, out.ny]).toEqual([300, 100, 100, 1]);
    expect(Number.isFinite(out.px) && Number.isFinite(out.pz)).toBe(true);

    expect(raycastVoxels(world, at(300.5, 110.5, 100.5), at(0, 0, 0), 20)).toBeNull();
    expect(raycastVoxels(world, at(300.5, 100.5, 100.5), at(0, 0, 0), 20)?.distance).toBe(0);
    // Not normalised: treated as the unit direction.
    expect(raycastVoxels(world, at(300.5, 110.5, 100.5), at(0, -7, 0), 20)?.distance).toBeCloseTo(9.5, 9);
  });

  test('rays leaving the world end at maxDist; below the world is bedrock', () => {
    expect(raycastVoxels(world, at(5.5, 300.5, 5.5), at(-1, 0, 0), 50)).toBeNull();
    const hit = raycastVoxels(world, at(1000.5, 3.5, 1000.5), at(0, -1, 0), 50);
    expect(hit?.id).toBe(B.BEDROCK);
    expect(hit?.y).toBe(-1);
    expect(hit?.ny).toBe(1);
  });
});
