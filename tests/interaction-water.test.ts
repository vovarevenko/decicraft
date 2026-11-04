import { describe, expect, test } from 'vitest';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';
import { flowWater, sourceLevel } from '../src/game/interaction/water';
import { VoxelList } from '../src/game/interaction/voxelList';

const world = World.create();

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** Empties a box (digging) and returns its cells as packed triples. */
function dig(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const cells: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        world.setBlock(x, y, z, B.AIR);
        cells.push(x, y, z);
      }
    }
  }
  return cells;
}

/**
 * Solid stone around a 10×10 pool at (ox..ox+10, oz..oz+10): water y 100..105 (surface level 105),
 * open air above it up to y 110.
 */
function pool(ox: number, oz: number): void {
  fill(ox - 2, 90, oz - 2, ox + 30, 112, oz + 12, B.STONE);
  fill(ox, 100, oz, ox + 10, 106, oz + 10, B.WATER);
  fill(ox, 106, oz, ox + 10, 112, oz + 10, B.AIR);
}

describe('water flow into dug cells (§11.3)', () => {
  test('a trench dug from the pool fills up to the pool surface, never above', () => {
    pool(100, 100);
    expect(sourceLevel(world, 111, 103, 105)).toBe(-1); // walled in by stone
    const cells = dig(110, 98, 105, 118, 109, 107); // through the east wall, from below the floor to above the surface
    expect(sourceLevel(world, 110, 103, 105)).toBe(105);
    expect(sourceLevel(world, 110, 99, 105)).toBe(-1); // under the pool floor, no water beside or above
    const filled = new VoxelList();
    const n = flowWater(world, cells, 6000, filled);
    expect(n).toBe(8 * 2 * 8); // y 98..105 of the 8×2 trench
    expect(filled.count).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(filled.positions[i * 3 + 1]).toBeLessThanOrEqual(105);
      expect(filled.ids[i]).toBe(B.WATER);
    }
    for (let y = 98; y < 109; y++) expect(world.getBlock(114, y, 105)).toBe(y <= 105 ? B.WATER : B.AIR);
  });

  test('the fill stops at the budget', () => {
    pool(300, 100);
    const cells = dig(310, 95, 104, 325, 106, 108);
    const filled = new VoxelList();
    expect(flowWater(world, cells, 10, filled)).toBe(10);
    let water = 0;
    for (let i = 0; i < cells.length; i += 3) if (world.getBlock(cells[i], cells[i + 1], cells[i + 2]) === B.WATER) water++;
    expect(water).toBe(10);
  });

  test('water above an emptied cell pours down into the connected cave below', () => {
    pool(500, 100);
    fill(503, 94, 103, 507, 97, 107, B.AIR); // a sealed cave under the pool floor
    const cells = dig(505, 97, 105, 506, 100, 106); // a shaft from the cave up to the pool bottom
    const filled = new VoxelList();
    const n = flowWater(world, cells, 6000, filled);
    expect(n).toBe(3 + 4 * 3 * 4);
    expect(world.getBlock(503, 94, 103)).toBe(B.WATER);
  });

  test('cells that touch no water stay dry', () => {
    fill(700, 90, 100, 720, 112, 120, B.STONE);
    const cells = dig(705, 100, 105, 710, 105, 110);
    expect(flowWater(world, cells, 6000, new VoxelList())).toBe(0);
    expect(world.getBlock(707, 100, 107)).toBe(B.AIR);
  });

  test('water below an emptied cell does not rise into it', () => {
    fill(800, 90, 100, 810, 112, 110, B.STONE);
    world.setBlock(805, 100, 105, B.WATER);
    const cells = dig(805, 101, 105, 806, 102, 106);
    expect(flowWater(world, cells, 6000, new VoxelList())).toBe(0);
  });
});
