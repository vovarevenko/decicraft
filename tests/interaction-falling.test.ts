import { describe, expect, test } from 'vitest';
import { B, SUP, SUPPORT, isReplaceable } from '../src/world/blocks';
import { findDetached, type DetachedPiece } from '../src/world/structure';
import { World, chunkKey } from '../src/world/world';
import {
  PASS_WOOD_ABOVE,
  PiecePose,
  buildPieceGrid,
  gridBlock,
  hasContact,
  pickContactSamples,
  planFall,
  revoxelize,
  touchedChunks,
  type PieceGrid,
} from '../src/game/interaction/fallingPiece';
import { VoxelList } from '../src/game/interaction/voxelList';

const world = World.create();

function pieceOf(voxels: [number, number, number, number][]): DetachedPiece {
  const piece: DetachedPiece = {
    positions: new Int32Array(voxels.length * 3),
    ids: new Uint8Array(voxels.length),
    count: voxels.length,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  voxels.forEach(([x, y, z, id], i) => {
    piece.positions.set([x, y, z], i * 3);
    piece.ids[i] = id;
    [x, y, z].forEach((c, a) => {
      piece.min[a] = Math.min(piece.min[a], c);
      piece.max[a] = Math.max(piece.max[a], c + 1);
    });
  });
  return piece;
}

/** Ten logs standing at (x, y0..y0+9, z). */
const column = (x: number, y0: number, z: number): DetachedPiece =>
  pieceOf(Array.from({ length: 10 }, (_, k): [number, number, number, number] => [x, y0 + k, z, B.OAK_LOG]));

function pose(rest: [number, number, number], axis: [number, number, number], angle: number, drop = 0): PiecePose {
  const p = new PiecePose().setRotation(axis[0], axis[1], axis[2], angle);
  [p.rest.x, p.rest.y, p.rest.z] = rest;
  [p.pivot.x, p.pivot.y, p.pivot.z] = [rest[0], rest[1] - drop, rest[2]];
  return p;
}

const cellsOf = (list: VoxelList): string[] =>
  Array.from({ length: list.count }, (_, i) => [...list.positions.subarray(i * 3, i * 3 + 3)].join(',')).sort();

/** Number of 6-connected components among the STRUCT cells of `list` (as they are in the world now). */
function structComponents(list: VoxelList): number {
  const isStruct = (c: string): boolean => SUPPORT[world.getBlock(...(c.split(',').map(Number) as [number, number, number]))] === SUP.STRUCT;
  const cells = new Set(cellsOf(list).filter(isStruct));
  let components = 0;
  for (const start of cells) {
    components++;
    const stack = [start];
    cells.delete(start);
    while (stack.length > 0) {
      const [x, y, z] = stack.pop()!.split(',').map(Number);
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const key = `${x + dx},${y + dy},${z + dz}`;
        if (cells.delete(key)) stack.push(key);
      }
    }
  }
  return components;
}

/** revoxelize's sampling without the row clipping: every cell of the posed box (the reference). */
function sampleAllCells(grid: PieceGrid, p: PiecePose): string[] {
  const out: string[] = [];
  const c = { x: 0, y: 0, z: 0 };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    p.toWorld(grid.minX + (k & 1 ? grid.sx : 0), grid.minY + (k & 2 ? grid.sy : 0), grid.minZ + (k & 4 ? grid.sz : 0), c);
    [c.x, c.y, c.z].forEach((v, a) => ((lo[a] = Math.min(lo[a], v)), (hi[a] = Math.max(hi[a], v))));
  }
  const m = p.m;
  for (let z = Math.floor(lo[2]); z < Math.ceil(hi[2]); z++) {
    for (let y = Math.floor(lo[1]); y < Math.ceil(hi[1]); y++) {
      for (let x = Math.floor(lo[0]); x < Math.ceil(hi[0]); x++) {
        const dx = x + 0.5 - p.pivot.x;
        const dy = y + 0.5 - p.pivot.y;
        const dz = z + 0.5 - p.pivot.z;
        const id = gridBlock(
          grid,
          Math.floor(p.rest.x + m[0] * dx + m[3] * dy + m[6] * dz),
          Math.floor(p.rest.y + m[1] * dx + m[4] * dy + m[7] * dz),
          Math.floor(p.rest.z + m[2] * dx + m[5] * dy + m[8] * dz),
        );
        if (id !== 0 && isReplaceable(world.getBlock(x, y, z))) out.push(`${x},${y},${z}`);
      }
    }
  }
  return out.sort();
}

describe('falling piece geometry', () => {
  test('the piece grid holds every voxel at its rest position', () => {
    const piece = pieceOf([
      [10, 20, 30, B.OAK_LOG],
      [12, 21, 30, B.OAK_LEAVES],
    ]);
    const grid = buildPieceGrid(piece);
    expect([grid.sx, grid.sy, grid.sz]).toEqual([3, 2, 1]);
    expect(gridBlock(grid, 10, 20, 30)).toBe(B.OAK_LOG);
    expect(gridBlock(grid, 12, 21, 30)).toBe(B.OAK_LEAVES);
    expect(gridBlock(grid, 11, 20, 30)).toBe(0);
    expect(gridBlock(grid, 9, 20, 30)).toBe(0);
  });

  test('a column toppled 90° about its east bottom edge lands as a row running east', () => {
    const piece = column(50, 100, 50);
    // Push +X: axis = up × push = (0, 0, -1); pivot on the column's east bottom edge.
    const p = pose([51, 100, 50.5], [0, 0, -1], Math.PI / 2);
    const written = new VoxelList();
    expect(revoxelize(world, buildPieceGrid(piece), p, written)).toBe(10);
    expect(cellsOf(written)).toEqual(Array.from({ length: 10 }, (_, k) => `${51 + k},100,50`).sort());
    for (let k = 0; k < 10; k++) expect(world.getBlock(51 + k, 100, 50)).toBe(B.OAK_LOG);
  });

  test('toppled north (push −Z) the row runs north', () => {
    const piece = column(50, 200, 80);
    const p = pose([50.5, 200, 80], [-1, 0, 0], Math.PI / 2); // up × (0, 0, −1) = (−1, 0, 0)
    const written = new VoxelList();
    revoxelize(world, buildPieceGrid(piece), p, written);
    expect(cellsOf(written)).toEqual(Array.from({ length: 10 }, (_, k) => `50,200,${79 - k}`).sort());
  });

  test('a straight drop shifts the piece by the rounded distance', () => {
    const piece = column(70, 100, 70);
    const written = new VoxelList();
    revoxelize(world, buildPieceGrid(piece), pose([70.5, 100, 70.5], [0, 0, -1], 0, 3.4), written);
    expect(cellsOf(written)).toEqual(Array.from({ length: 10 }, (_, k) => `70,${97 + k},70`).sort());
  });

  test('only replaceable cells are written, and the veto is respected', () => {
    const piece = column(90, 300, 90);
    world.setBlock(95, 300, 90, B.STONE);
    world.setBlock(96, 300, 90, B.TALL_GRASS);
    world.setBlock(97, 300, 90, B.WATER);
    const written = new VoxelList();
    const n = revoxelize(world, buildPieceGrid(piece), pose([91, 300, 90.5], [0, 0, -1], Math.PI / 2), written, (x) => x === 98);
    expect(n).toBe(8);
    expect(world.getBlock(95, 300, 90)).toBe(B.STONE);
    expect(world.getBlock(96, 300, 90)).toBe(B.OAK_LOG);
    expect(world.getBlock(97, 300, 90)).toBe(B.OAK_LOG);
    expect(world.getBlock(98, 300, 90)).toBe(B.AIR);
  });

  test('a thick trunk at 45° keeps roughly its volume', () => {
    const voxels: [number, number, number, number][] = [];
    for (let y = 0; y < 20; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) voxels.push([300 + x, 400 + y, 300 + z, B.PINE_LOG]);
    const written = new VoxelList();
    revoxelize(world, buildPieceGrid(pieceOf(voxels)), pose([303, 400, 301.5], [0, 0, -1], Math.PI / 4), written);
    expect(written.count).toBeGreaterThan(voxels.length * 0.85);
    expect(written.count).toBeLessThan(voxels.length * 1.15);
  });

  test('contact: probes inside solid voxels at the pose', () => {
    const piece = column(120, 100, 120);
    for (let x = 118; x < 135; x++) world.setBlock(x, 99, 120, B.STONE);
    const grid = buildPieceGrid(piece);
    const rest = { x: 121, y: 100, z: 120.5 };
    const probes = pickContactSamples(piece, grid, rest, true, 200);
    expect(probes.length).toBe(30); // fewer voxels than probes: every voxel is one
    expect(hasContact(world, pose([121, 100, 120.5], [0, 0, -1], Math.PI / 2), probes)).toBe(false);
    expect(hasContact(world, pose([121, 100, 120.5], [0, 0, -1], Math.PI / 2, 1), probes)).toBe(true);
    expect(hasContact(world, pose([121, 100, 120.5], [0, 0, -1], 0, 0.4), probes)).toBe(false);
    expect(hasContact(world, pose([121, 100, 120.5], [0, 0, -1], 0, 0.6), probes)).toBe(true);
  });

  test('probes include the extremes and favour far voxels when toppling', () => {
    const voxels: [number, number, number, number][] = [];
    for (let y = 0; y < 100; y++) for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) voxels.push([500 + x, 100 + y, 500 + z, B.BIRCH_LOG]);
    const piece = pieceOf(voxels);
    const rest = { x: 503, y: 100, z: 501.5 };
    const heightsOf = (probes: Float32Array): number[] => Array.from({ length: probes.length / 3 }, (_, i) => probes[i * 3 + 1]);
    // Voxels heavier than one sampling step are picked once, so slightly fewer probes than asked for is normal.
    const heights = heightsOf(pickContactSamples(piece, buildPieceGrid(piece), rest, true, 40));
    expect(heights.length).toBeGreaterThan(32);
    expect(heights.length).toBeLessThanOrEqual(40);
    expect(Math.min(...heights)).toBe(0.5); // bottom layer (rests on the stump)…
    expect(heights.filter((h) => h === 0.5).length).toBeGreaterThanOrEqual(5); // …well covered
    expect(Math.max(...heights)).toBe(99.5); // top
    expect(heights.filter((h) => h > 50).length).toBeGreaterThan(heights.filter((h) => h > 5 && h <= 50).length);

    const falling = heightsOf(pickContactSamples(piece, buildPieceGrid(piece), rest, false, 40));
    expect(falling.filter((h) => h === 0.5).length).toBe(9); // the whole underside
  });

  test('a toppling tree passes through other trees\' wood more than 2 m above its base, nothing else', () => {
    const piece = column(700, 100, 700);
    const probes = pickContactSamples(piece, buildPieceGrid(piece), { x: 701, y: 100, z: 700.5 }, true, 200);
    // Toppled 90° east the column lies at y = 100…101; a neighbour's branch there, then the same 2.5 m higher.
    const lying = pose([701, 100 - PASS_WOOD_ABOVE - 5, 700.5], [0, 0, -1], Math.PI / 2);
    lying.rest.y = 100;
    world.setBlock(705, 100 - PASS_WOOD_ABOVE - 5, 700, B.OAK_LOG);
    expect(hasContact(world, lying, probes, true)).toBe(true); // 2.5 m below the base: a trunk near the ground
    const high = pose([701, 100 + PASS_WOOD_ABOVE + 5, 700.5], [0, 0, -1], Math.PI / 2);
    high.rest.y = 100;
    world.setBlock(705, 100 + PASS_WOOD_ABOVE + 5, 700, B.BIRCH_LOG);
    expect(hasContact(world, high, probes, true)).toBe(false); // crashes through a crown
    expect(hasContact(world, high, probes, false)).toBe(true); // other pieces still stop there
    world.setBlock(706, 100 + PASS_WOOD_ABOVE + 5, 700, B.BRICK);
    expect(hasContact(world, high, probes, true)).toBe(true); // a wall is no branch
  });

  test('probes come from the skeleton: a crown\'s leaves never hold a piece up', () => {
    const voxels: [number, number, number, number][] = [];
    for (let y = 0; y < 30; y++) voxels.push([800, 100 + y, 800, B.OAK_LOG]);
    for (let y = 20; y < 34; y++) {
      for (let z = -4; z <= 4; z++) {
        for (let x = -4; x <= 4; x++) if (x !== 0 || z !== 0 || y >= 30) voxels.push([800 + x, 100 + y, 800 + z, B.OAK_LEAVES]);
      }
    }
    const piece = pieceOf(voxels);
    const grid = buildPieceGrid(piece);
    expect(grid.struct.length).toBe(30 * 3);
    for (const topple of [true, false]) {
      const probes = pickContactSamples(piece, grid, { x: 801, y: 100, z: 800.5 }, topple, 200);
      expect(probes.length).toBeGreaterThan(20 * 3); // fewer voxels than probes: (nearly) every log is one
      for (let i = 0; i < probes.length; i += 3) {
        expect(gridBlock(grid, Math.floor(801 + probes[i]), Math.floor(100 + probes[i + 1]), Math.floor(800.5 + probes[i + 2]))).toBe(B.OAK_LOG);
      }
    }
  });

  test('a thin trunk landed at an angle stays one 6-connected skeleton (stays supported)', () => {
    for (const [i, deg] of [20, 30, 45, 60, 75].entries()) {
      const x = 900 + i * 40;
      const piece = column(x, 200, 900);
      const written = new VoxelList();
      revoxelize(world, buildPieceGrid(piece), pose([x + 1, 200, 900.5], [0, 0, -1], (deg * Math.PI) / 180), written);
      expect(structComponents(written)).toBe(1);
      expect(written.count).toBeLessThanOrEqual(20); // the joins add at most a cell per step
    }
    const diagonal = pose([1101, 260, 900.5], [Math.SQRT1_2, 0, -Math.SQRT1_2], Math.PI / 4); // tilted towards a corner
    const written = new VoxelList();
    revoxelize(world, buildPieceGrid(column(1100, 260, 900)), diagonal, written);
    expect(structComponents(written)).toBe(1);
  });

  test('row clipping writes exactly the cells of a full scan of the posed box', () => {
    const voxels: [number, number, number, number][] = [];
    for (let y = 0; y < 25; y++) {
      for (let z = 0; z < 4; z++) for (let x = 0; x < 3; x++) if ((x + y + z) % 3 !== 0) voxels.push([600 + x, 300 + y, 600 + z, B.PINE_NEEDLES]);
    }
    const grid = buildPieceGrid(pieceOf(voxels));
    expect(grid.struct.length).toBe(0); // foliage only: no skeleton joins, sampling alone
    const axes: [number, number, number][] = [[0, 0, -1], [1, 0, 0], [Math.SQRT1_2, 0, Math.SQRT1_2], [0.6, 0, -0.8]];
    for (const [k, axis] of axes.entries()) {
      for (const deg of [0, 17, 45, 63, 88, 90]) {
        const p = pose([601.5 + k * 0.25, 300, 602 - k * 0.3], axis, (deg * Math.PI) / 180, k * 1.7);
        const expected = sampleAllCells(grid, p);
        const written = new VoxelList();
        revoxelize(world, grid, p, written);
        expect(cellsOf(written)).toEqual(expected);
        world.setBlocks(written.positions, B.AIR, written.count); // clean up for the next pose
      }
    }
  });

  test('touched chunks include neighbours across borders', () => {
    const list = new VoxelList();
    list.push(32, 64, 5, B.STONE); // on the low-x and low-y borders of chunk (1, 2, 0)
    list.push(40, 70, 10, B.STONE); // inside the same chunk
    const keys = touchedChunks(list);
    expect([...keys].sort((a, b) => a - b)).toEqual([chunkKey(0, 2, 0), chunkKey(1, 1, 0), chunkKey(1, 2, 0)].sort((a, b) => a - b));
    // From the second voxel on, added to keys known already.
    expect([...touchedChunks(list, new Set([7]), 1)]).toEqual([7, chunkKey(1, 2, 0)]);
  });
});

/** Empties a box and returns its cells as seeds (packed triples). */
function carve(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const seeds: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        world.setBlock(x, y, z, B.AIR);
        seeds.push(x, y, z);
      }
    }
  }
  return seeds;
}

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** Order-sensitive digest of the probe offsets. */
function probeChecksum(probes: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < probes.length; i++) sum += probes[i] * ((i % 7) + 1);
  return sum;
}

describe('fall plan', () => {
  // Expected values were computed with the FallingBody constructor before its pure part moved here (same results).
  test('a cut tree standing on its stump topples away from the player about its base edge', () => {
    fill(194, 99, 194, 207, 100, 207, B.DIRT);
    fill(200, 100, 200, 202, 140, 202, B.OAK_LOG);
    fill(196, 134, 196, 206, 144, 206, B.OAK_LEAVES);
    fill(200, 134, 200, 202, 140, 202, B.OAK_LOG);
    const [piece] = findDetached(world, carve(200, 101, 200, 202, 102, 202), 100_000);
    expect([piece.count, ...piece.min, ...piece.max]).toEqual([1128, 196, 102, 196, 206, 144, 206]);
    const plan = planFall(world, piece, { x: 190.3, y: 100, z: 213.7 });
    expect([plan.grid.sx, plan.grid.sy, plan.grid.sz, plan.grid.struct.length / 3]).toEqual([10, 42, 10, 152]);
    expect(plan.tree).toBe(true);
    expect(plan.rest.x).toBeCloseTo(201.90789759953586, 9);
    expect(plan.rest.y).toBe(102);
    expect(plan.rest.z).toBeCloseTo(199.92240191456958, 9);
    expect(plan.axis.x).toBeCloseTo(-0.7647550215247213, 12);
    expect(plan.axis.y).toBe(0);
    expect(plan.axis.z).toBeCloseTo(-0.6443211598672848, 12);
    expect(plan.toppleRate).toBeCloseTo(3.503571428571428, 12);
    expect(plan.probes.length).toBe(104 * 3);
    expect(Array.from(plan.probes.subarray(0, 6))).toEqual([-1.4078975915908813, 0.5, 0.5775980949401855, -0.40789759159088135, 0.5, 0.5775980949401855]);
    expect(probeChecksum(plan.probes)).toBeCloseTo(9853.27051270008, 6);
    expect(plan.probeReach).toBeCloseTo(37.55956591039846, 9);
  });

  test('a squat wall cut from its foundation drops straight down', () => {
    fill(330, 9, 100, 340, 10, 103, B.STONE);
    fill(330, 10, 100, 340, 20, 103, B.BRICK);
    const [piece] = findDetached(world, carve(330, 10, 100, 340, 11, 103), 100_000);
    const plan = planFall(world, piece, { x: 335, y: 10, z: 90 });
    expect(plan.tree).toBe(false);
    expect(plan.rest).toEqual({ x: 335, y: 11, z: 101.5 });
    expect([plan.axis.x, plan.axis.y, Math.abs(plan.axis.z)]).toEqual([1, 0, 0]);
    expect(plan.toppleRate).toBeCloseTo(16.349999999999998, 12);
    expect(plan.probes.length).toBe(69 * 3);
    expect(Array.from(plan.probes.subarray(0, 6))).toEqual([-4.5, 0.5, -1, 4.5, 0.5, -1]);
    expect(probeChecksum(plan.probes)).toBeCloseTo(827.5, 6);
    expect(plan.probeReach).toBeCloseTo(9.246621004453463, 9);
  });

  test('a tall pole with nothing solid below it drops instead of toppling', () => {
    fill(400, 200, 400, 401, 245, 401, B.PINE_LOG);
    fill(400, 245, 400, 401, 246, 401, B.CONCRETE);
    const [piece] = findDetached(world, carve(400, 245, 400, 401, 246, 401), 100_000);
    const plan = planFall(world, piece, { x: 400.5, y: 200, z: 400.5 }); // right below: no direction, pushed east
    expect(plan.tree).toBe(false);
    expect(plan.rest).toEqual({ x: 400.5, y: 200, z: 400.5 });
    expect([Math.abs(plan.axis.x), plan.axis.y, plan.axis.z]).toEqual([0, 0, -1]);
    expect(plan.toppleRate).toBeCloseTo(3.2699999999999996, 12);
    expect(plan.probes.length).toBe(45 * 3);
    expect(Array.from(plan.probes.subarray(0, 6))).toEqual([0, 44.5, 0, 0, 0.5, 0]);
    expect(probeChecksum(plan.probes)).toBe(3915);
    expect(plan.probeReach).toBe(44.5);
  });
});
