import { describe, expect, test } from 'vitest';
import { CHUNK_VOL, WORLD_X, WORLD_Y } from '../src/config';
import { createNoise2D, createNoise3D } from '../src/core/noise';
import { Rng, hash2 } from '../src/core/rng';
import { B, OPAQUE, SKY_OPAQUE } from '../src/world/blocks';
import { World, WorldData, chunkCoords, chunkKey, chunkKeyAt } from '../src/world/world';

/** A column map recomputed from the voxels: first voxel above the topmost voxel set in `table`, 0 if none. */
function columnTop(w: WorldData, table: Uint8Array, x: number, z: number): number {
  for (let y = WORLD_Y - 1; y >= 0; y--) if (table[w.getBlock(x, y, z)]) return y + 1;
  return 0;
}

/**
 * Ground with a tree: bark and wood columns and a leaf ball crossing chunk borders. West of x = 80 the ground's top
 * voxel is y = 96, the bottom layer of a chunk.
 */
function treeScene(w: World): void {
  for (let x = 50; x < 110; x++) for (let z = 50; z < 110; z++) {
    const top = x < 80 ? 96 : 99;
    for (let y = 90; y <= top; y++) w.setBlock(x, y, z, y === top ? B.GRASS : B.DIRT);
  }
  for (let y = 100; y < 140; y++) w.setBlock(80, y, 80, B.OAK_LOG); // bark: canopy map only
  for (let y = 97; y < 140; y++) w.setBlock(79, y, 80, B.WOOD); // core: sky map too
  for (let x = 68; x <= 92; x++) for (let y = 125; y <= 149; y++) for (let z = 68; z <= 92; z++) {
    if ((x - 80) ** 2 + (y - 137) ** 2 + (z - 80) ** 2 <= 144 && w.getBlock(x, y, z) === B.AIR) w.setBlock(x, y, z, B.OAK_LEAVES);
  }
}

describe('World store', () => {
  test('uniform chunks, set/get, out-of-bounds', () => {
    const w = World.create();
    expect(w.getBlock(10, 10, 10)).toBe(B.AIR);
    expect(w.getBlock(-1, 10, 10)).toBe(B.AIR);
    expect(w.getBlock(10, -1, 10)).toBe(B.BEDROCK);
    expect(w.getBlock(10, WORLD_Y, 10)).toBe(B.AIR);
    w.loadChunk(chunkKey(0, 0, 0), B.STONE);
    expect(w.getBlock(31, 31, 31)).toBe(B.STONE);
    expect(w.allocatedChunks).toBe(0);
    expect(w.setBlock(5, 6, 7, B.DIRT)).toBe(true);
    expect(w.allocatedChunks).toBe(1);
    expect(w.getBlock(5, 6, 7)).toBe(B.DIRT);
    expect(w.getBlock(5, 6, 8)).toBe(B.STONE);
    expect(w.setBlock(5, 6, 7, B.DIRT)).toBe(false);
    expect(w.setBlock(WORLD_X, 0, 0, B.DIRT)).toBe(false);
  });

  test('loadChunk copies arrays, workers see the same memory', () => {
    const w = World.create();
    const arr = new Uint8Array(CHUNK_VOL);
    arr[0] = B.GRASS;
    arr[CHUNK_VOL - 1] = B.SAND;
    w.loadChunk(chunkKey(3, 2, 1), arr);
    expect(w.getBlock(96, 64, 32)).toBe(B.GRASS);
    expect(w.getBlock(127, 95, 63)).toBe(B.SAND);
    const view = new WorldData(w.toShared());
    expect(view.getBlock(96, 64, 32)).toBe(B.GRASS);
    w.setBlock(97, 64, 32, B.BRICK);
    expect(view.getBlock(97, 64, 32)).toBe(B.BRICK);
  });

  test('dirty set includes neighbours on chunk borders', () => {
    const w = World.create();
    let got: number[] = [];
    w.onChange((s) => (got = [...s]));
    w.setBlock(32, 40, 40, B.STONE); // lx = 0 → also chunk cx-1
    w.flush();
    expect(got).toContain(chunkKeyAt(32, 40, 40));
    expect(got).toContain(chunkKeyAt(31, 40, 40));
    got = [];
    w.flush();
    expect(got).toEqual([]);
  });

  test('sky and canopy heights follow opaque edits', () => {
    const w = World.create();
    w.setBlock(50, 100, 50, B.STONE);
    expect(w.skyHeight(50, 50)).toBe(101);
    expect(w.canopyHeight(50, 50)).toBe(101);
    w.setBlock(50, 120, 50, B.PLANKS);
    expect(w.skyHeight(50, 50)).toBe(121);
    w.setBlock(50, 120, 50, B.AIR);
    expect(w.skyHeight(50, 50)).toBe(101);
    w.setBlock(50, 130, 50, B.GLASS); // not opaque
    expect(w.skyHeight(50, 50)).toBe(101);
    expect(w.topSolidY(50, 50)).toBe(131);
    w.setBlock(50, 150, 50, B.OAK_LEAVES); // foliage: canopy only, not solid
    expect(w.skyHeight(50, 50)).toBe(101);
    expect(w.canopyHeight(50, 50)).toBe(151);
    expect(w.topSolidY(50, 50)).toBe(131);
    w.setBlock(50, 150, 50, B.AIR);
    expect(w.canopyHeight(50, 50)).toBe(101);
    w.setBlock(50, 140, 50, B.OAK_LOG); // tree bark: canopy only, like foliage
    expect(w.skyHeight(50, 50)).toBe(101);
    expect(w.canopyHeight(50, 50)).toBe(141);
    w.setBlock(50, 140, 50, B.WOOD); // trunk cores and placed wood roof
    expect(w.skyHeight(50, 50)).toBe(141);
    expect(w.canopyHeight(50, 50)).toBe(141);
  });

  test('edits bump versions of every dirtied chunk', () => {
    const w = World.create();
    const before = w.chunkVersion[chunkKeyAt(31, 40, 40)];
    w.setBlock(32, 40, 40, B.STONE);
    expect(w.chunkVersion[chunkKeyAt(31, 40, 40)]).toBeGreaterThan(before);
  });

  test('floorBelow finds the floor under roofs and canopies', () => {
    const w = World.create();
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) {
      w.setBlock(x, 99, z, B.STONE); // ground, top voxel y = 99
      w.setBlock(x, 130, z, B.PLANKS); // roof
    }
    expect(w.topSolidY(5, 5)).toBe(131);
    expect(w.floorBelow(5, 120, 5)).toBe(100);
    expect(w.floorBelow(5, 99, 5)).toBe(100); // starts inside the ground → steps up
    expect(w.floorBelow(5.7, 125.2, 5.1)).toBe(100);
  });

  test('setBlocks matches per-voxel setBlock: voxels, sky/canopy maps, dirty chunks', () => {
    // A bulk edit mixing removals and placements in treeScene, applied voxel by voxel to `a` and in one setBlocks
    // call to `b`.
    const a = World.create();
    const b = World.create();
    treeScene(a);
    treeScene(b);
    a.flush();
    b.flush();
    const rng = new Rng(5);
    const pos: number[] = [];
    const ids: number[] = [];
    for (let x = 66; x <= 94; x++) for (let y = 96; y <= 151; y++) for (let z = 66; z <= 94; z++) {
      const id = a.getBlock(x, y, z);
      if (id === B.OAK_LOG || id === B.WOOD || id === B.OAK_LEAVES) {
        pos.push(x, y, z);
        ids.push(B.AIR);
      } else if (rng.chance(0.002)) {
        pos.push(x, y, z);
        ids.push(rng.pick([B.PLANKS, B.GLASS, B.BIRCH_LEAVES, B.AIR]));
      }
    }
    pos.push(80, 160, 80, 80, 160, 80, -1, 5, 5); // a duplicate and an out-of-world voxel
    ids.push(B.STONE, B.AIR, B.STONE);
    const n = ids.length;
    let changedA = 0;
    for (let i = 0; i < n; i++) if (a.setBlock(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], ids[i])) changedA++;
    expect(b.setBlocks(pos, ids, n)).toBe(changedA);
    const dirtyA = new Set<number>();
    const dirtyB = new Set<number>();
    a.onChange((s) => s.forEach((k) => dirtyA.add(k)));
    b.onChange((s) => s.forEach((k) => dirtyB.add(k)));
    a.flush();
    b.flush();
    for (let x = 40; x < 120; x++) for (let y = 85; y < 170; y++) for (let z = 40; z < 120; z++) {
      if (a.getBlock(x, y, z) !== b.getBlock(x, y, z)) throw new Error(`voxel ${x},${y},${z} differs`);
    }
    expect(b.sky).toEqual(a.sky);
    expect(b.canopy).toEqual(a.canopy);
    for (let x = 40; x < 120; x++) for (let z = 40; z < 120; z++) {
      if (b.skyHeight(x, z) !== columnTop(b, SKY_OPAQUE, x, z) || b.canopyHeight(x, z) !== columnTop(b, OPAQUE, x, z)) {
        throw new Error(`column maps of ${x},${z} differ from the voxels`);
      }
    }
    // Bulk marking may skip column changes that cancel out, but never misses a chunk with a changed voxel.
    for (const k of dirtyB) expect(dirtyA.has(k)).toBe(true);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      if (x >= 0) expect(dirtyB.has(chunkKeyAt(x, y, z))).toBe(true);
    }
    expect(b.skyHeight(80, 80)).toBe(100);
    expect(b.canopyHeight(80, 80)).toBe(100);
    expect(b.skyHeight(79, 80)).toBe(97);
  });

  test('a bulk write marks exactly the chunks per-voxel writes mark, each with one version bump', () => {
    // A felled tree: it leaves the world (removals only), then lies on the ground across chunk borders (placements
    // only), as a falling body vacates and lands. Column heights only fall, then only rise: no change cancels out. Two
    // buried voxels on chunk borders (x = 64, y = 95) go and come back too: they change no column height, so only the
    // marks of their border neighbours reach the chunks across.
    const a = World.create();
    const b = World.create();
    treeScene(a);
    treeScene(b);
    const dirtyA = new Set<number>();
    const dirtyB = new Set<number>();
    a.onChange((s) => s.forEach((k) => dirtyA.add(k)));
    b.onChange((s) => s.forEach((k) => dirtyB.add(k)));
    a.flush();
    b.flush();
    const buried = [64, 92, 70, 60, 95, 72];
    const vacate: number[] = [...buried];
    for (let x = 66; x <= 94; x++) for (let y = 97; y <= 151; y++) for (let z = 66; z <= 94; z++) {
      const id = a.getBlock(x, y, z);
      if (id === B.OAK_LOG || id === B.WOOD || id === B.OAK_LEAVES) vacate.push(x, y, z);
    }
    const land: number[] = [...buried];
    const landIds: number[] = [B.STONE, B.STONE];
    for (let x = 58; x < 102; x++) {
      land.push(x, 100, 80, x, 101, 80, x, 100, 85);
      landIds.push(B.OAK_LOG, B.OAK_LEAVES, B.WOOD);
    }
    for (let y = 124; y < 132; y++) {
      land.push(70, y, 63); // across chunk borders in y and z
      landIds.push(B.WOOD);
    }
    const sorted = (s: Set<number>): number[] => [...s].sort((p, q) => p - q);
    const bumped = (w: World, before: Uint32Array): number[] => [...w.chunkVersion.keys()].filter((k) => w.chunkVersion[k] !== before[k]);
    for (const [pos, ids] of [
      [vacate, B.AIR],
      [land, landIds],
    ] as const) {
      const n = pos.length / 3;
      const versionsA = a.chunkVersion.slice();
      const versionsB = b.chunkVersion.slice();
      dirtyA.clear();
      dirtyB.clear();
      for (let i = 0; i < n; i++) a.setBlock(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], typeof ids === 'number' ? ids : ids[i]);
      expect(b.setBlocks(pos, ids, n)).toBe(n);
      a.flush();
      b.flush();
      expect(dirtyA.has(chunkKey(2, 1, 2))).toBe(true); // only skylight changed there: a column change marked it
      expect(dirtyA.has(chunkKey(1, 3, 2))).toBe(true); // only the buried voxel at y = 95 below it marked it
      expect(sorted(dirtyB)).toEqual(sorted(dirtyA));
      expect(bumped(b, versionsB)).toEqual(bumped(a, versionsA));
      expect(bumped(b, versionsB)).toEqual(sorted(dirtyB));
      for (const k of dirtyB) expect(b.chunkVersion[k] - versionsB[k]).toBe(1);
    }
    expect(b.sky).toEqual(a.sky);
    expect(b.canopy).toEqual(a.canopy);
  });

  test('recordMarks reports what a write marks dirty, exactly what the next flush reports for it', () => {
    const w = World.create();
    treeScene(w);
    const reported = new Set<number>();
    w.onChange((s) => s.forEach((k) => reported.add(k)));
    w.flush();
    reported.clear();
    const recorded = new Set<number>();
    const core: number[] = [];
    for (let y = 97; y < 140; y++) core.push(79, y, 80);
    w.recordMarks(recorded, () => {
      w.setBlocks(core, B.AIR, core.length / 3); // the trunk's core, in bulk: the sky map drops far below it
      w.setBlock(64, 92, 70, B.STONE); // a buried voxel on a chunk border, on its own
    });
    w.flush();
    expect(recorded.has(chunkKey(2, 1, 2))).toBe(true); // only its skylight changed
    expect(recorded.has(chunkKey(1, 2, 2))).toBe(true); // across the border from the buried voxel
    expect([...recorded].sort((p, q) => p - q)).toEqual([...reported].sort((p, q) => p - q));
    const size = recorded.size;
    w.setBlock(70, 120, 63, B.WOOD); // after the write: not recorded
    expect(recorded.size).toBe(size);
  });

  test('chunkCoords round-trip', () => {
    const k = chunkKey(7, 11, 39);
    expect(chunkCoords(k)).toEqual([7, 11, 39]);
  });
});

describe('determinism', () => {
  test('rng and noise are seed-stable', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 10; i++) expect(a.next()).toBe(b.next());
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    const n1 = createNoise2D(7);
    const n2 = createNoise2D(7);
    expect(n1(1.23, 4.56)).toBe(n2(1.23, 4.56));
    let lo = Infinity;
    let hi = -Infinity;
    const n3 = createNoise3D(9);
    for (let i = 0; i < 2000; i++) {
      const v = n1(i * 0.37, i * 0.11);
      const u = n3(i * 0.21, i * 0.07, i * 0.13);
      lo = Math.min(lo, v, u);
      hi = Math.max(hi, v, u);
    }
    expect(lo).toBeGreaterThan(-1.05);
    expect(hi).toBeLessThan(1.05);
    expect(hi - lo).toBeGreaterThan(1);
  });
});
