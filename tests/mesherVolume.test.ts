import { describe, expect, test } from 'vitest';
import { CHUNK_VOL } from '../src/config';
import { COLS, SKY_REACH, padIndex } from '../src/render/voxel/layout';
import { VolumeBuilder } from '../src/render/voxel/volume';
import { B } from '../src/world/blocks';
import { World, chunkKey } from '../src/world/world';

describe('volume: level 0', () => {
  test('copies every padded voxel (arrays, uniform chunks, bedrock below the world)', () => {
    const w = World.create();
    w.loadChunk(chunkKey(1, 0, 1), B.STONE);
    w.loadChunk(chunkKey(2, 0, 1), B.DIRT);
    const arr = new Uint8Array(CHUNK_VOL);
    for (let i = 0; i < arr.length; i++) arr[i] = i % 7 === 0 ? B.GRASS : i % 5 === 0 ? B.WATER : B.AIR;
    w.loadChunk(chunkKey(1, 1, 1), arr);
    w.setBlock(64, 40, 40, B.BRICK);
    const b = new VolumeBuilder();
    b.build(w, 0, 0, 0, 0);
    for (let y = -1; y <= 64; y++) {
      for (let z = -1; z <= 64; z++) {
        for (let x = -1; x <= 64; x++) {
          expect(b.volume[padIndex(x, y, z)]).toBe(w.getBlock(x, y, z));
        }
      }
    }
  });

  test('outside the world reads as air, column samples as open sky', () => {
    const w = World.create();
    w.setBlock(1279, 10, 5, B.STONE);
    w.setBlock(1216 - 1 - SKY_REACH, 20, 5, B.STONE); // the first column of the grid
    const b = new VolumeBuilder();
    b.build(w, 0, 1216, 0, 0);
    expect(b.volume[padIndex(63, 10, 5)]).toBe(B.STONE);
    expect(b.volume[padIndex(64, 10, 5)]).toBe(B.AIR);
    // Column k ↔ x = ox − 1 − SKY_REACH + k, COLS of them: x = 1279 is the last one inside the world.
    const at = (x: number, z: number) => b.colSky[x - 1216 + 1 + SKY_REACH + (z + 1 + SKY_REACH) * COLS];
    expect(b.colSky.length).toBe(COLS * COLS);
    expect(at(1216 - 1 - SKY_REACH, 5)).toBe(21);
    expect(at(1279, 5)).toBe(11);
    expect(at(1280, 5)).toBe(0);
    expect(at(1216 - 1 - SKY_REACH, -1)).toBe(0);
  });
});

describe('volume: downsampling', () => {
  /** Downsampled cell of the level-L node at the origin whose 2^L block starts at voxel (x, y, z). */
  function cell(w: World, level: number, x: number, y: number, z: number): number {
    const b = new VolumeBuilder();
    b.build(w, level, 0, 0, 0);
    return b.volume[padIndex(x >> level, y >> level, z >> level)];
  }

  function fill(w: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) w.setBlock(x, y, z, id);
  }

  test('3/8 opaque → opaque, less → air (non-structural)', () => {
    const w = World.create();
    fill(w, 10, 20, 10, 12, 21, 11, B.STONE); // 2 of 8
    w.setBlock(10, 21, 10, B.STONE); // 3 of 8
    expect(cell(w, 1, 10, 20, 10)).toBe(B.STONE);
    w.setBlock(10, 21, 10, B.AIR);
    expect(cell(w, 1, 10, 20, 10)).toBe(B.AIR);
  });

  test('mostly STRUCT blocks need only 1/4 (thin walls and trunks thicken instead of vanishing)', () => {
    const w = World.create();
    fill(w, 20, 20, 20, 22, 21, 21, B.BRICK); // 2 of 8, structural
    expect(cell(w, 1, 20, 20, 20)).toBe(B.BRICK);
    // Level 2: a 1-voxel wall slice = 16 of 64.
    fill(w, 40, 40, 40, 41, 44, 44, B.OAK_LOG);
    expect(cell(w, 2, 40, 40, 40)).toBe(B.OAK_LOG);
    fill(w, 60, 40, 40, 61, 44, 44, B.STONE);
    expect(cell(w, 2, 60, 40, 40)).toBe(B.AIR);
  });

  test('the most frequent exposed opaque type wins over the most frequent one', () => {
    const w = World.create();
    fill(w, 30, 30, 30, 32, 31, 32, B.DIRT); // bottom layer: 4 dirt
    w.setBlock(30, 31, 30, B.GRASS);
    w.setBlock(31, 31, 30, B.GRASS);
    w.setBlock(30, 31, 31, B.DIRT);
    w.setBlock(31, 31, 31, B.DIRT);
    // Cover the two top dirt voxels from above (in the next block) so only the grass is exposed.
    w.setBlock(30, 32, 31, B.DIRT);
    w.setBlock(31, 32, 31, B.DIRT);
    expect(cell(w, 1, 30, 30, 30)).toBe(B.GRASS);
    // Without exposed voxels the most frequent opaque type is used.
    fill(w, 30, 32, 30, 32, 33, 32, B.STONE);
    expect(cell(w, 1, 30, 30, 30)).toBe(B.DIRT);
  });

  test('water and glass at 1/4, plants dropped', () => {
    const w = World.create();
    fill(w, 50, 50, 50, 52, 51, 51, B.WATER);
    expect(cell(w, 1, 50, 50, 50)).toBe(B.WATER);
    fill(w, 54, 50, 50, 56, 51, 51, B.GLASS);
    expect(cell(w, 1, 54, 50, 50)).toBe(B.GLASS);
    fill(w, 58, 50, 50, 60, 52, 52, B.TALL_GRASS);
    expect(cell(w, 1, 58, 50, 50)).toBe(B.AIR);
  });

  test('exposure looks into the chunk above for a block on a chunk top', () => {
    const w = World.create();
    fill(w, 0, 30, 0, 2, 32, 2, B.DIRT); // block y 30..31 (top layer at chunk-local y = 31)
    w.setBlock(0, 31, 0, B.GRASS);
    w.setBlock(1, 31, 0, B.GRASS);
    fill(w, 0, 32, 1, 2, 33, 2, B.STONE); // in the chunk above: covers the top dirt voxels
    expect(cell(w, 1, 0, 30, 0)).toBe(B.GRASS);
  });

  test('uniform chunks downsample in O(1) per cell', () => {
    const w = World.create();
    w.loadChunk(chunkKey(0, 0, 0), B.GRANITE);
    w.loadChunk(chunkKey(1, 0, 0), B.WATER);
    w.loadChunk(chunkKey(2, 0, 0), B.FERN);
    const b = new VolumeBuilder();
    b.build(w, 2, 0, 0, 0);
    expect(b.volume[padIndex(3, 3, 3)]).toBe(B.GRANITE);
    expect(b.volume[padIndex(8 + 3, 3, 3)]).toBe(B.WATER);
    expect(b.volume[padIndex(16 + 3, 3, 3)]).toBe(B.AIR);
    expect(b.volume[padIndex(3, -1, 3)]).toBe(B.BEDROCK);
  });

  test('padding cells cover the neighbouring blocks', () => {
    const w = World.create();
    fill(w, 128, 4, 4, 130, 6, 6, B.CONCRETE); // just beyond the +x face of the level-1 node at x 0..127
    const b = new VolumeBuilder();
    b.build(w, 1, 0, 0, 0);
    expect(b.volume[padIndex(64, 2, 2)]).toBe(B.CONCRETE);
  });
});

describe('volume: input hash', () => {
  test('equal inputs hash equal; voxels, padding and the sky map all count', () => {
    const w = World.create();
    w.setBlock(70, 70, 70, B.STONE);
    const b = new VolumeBuilder();
    const hashOf = (): number => {
      b.build(w, 0, 64, 64, 64);
      return b.hash(0);
    };
    const h0 = hashOf();
    expect(hashOf()).toBe(h0);
    expect(Number.isSafeInteger(h0)).toBe(true);
    w.setBlock(63, 70, 70, B.DIRT); // padding layer of the node (sky map changes too)
    const h1 = hashOf();
    expect(h1).not.toBe(h0);
    w.setBlock(70, 140, 70, B.OAK_LEAVES); // above the node: only the canopy map changes
    const h2 = hashOf();
    expect(h2).not.toBe(h1);
    w.setBlock(40, 70, 70, B.DIRT); // outside the node, its padding and its sampled columns
    expect(hashOf()).toBe(h2);
  });
});
