import { describe, expect, test } from 'vitest';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';
import { makeAABB } from '../src/game/physics';
import { MAX_PLACE_SIZE, cellsBounds, filterPlaceable, placementCells, type FaceHit } from '../src/game/interaction/placement';

const NORMALS: [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** A hit on voxel (50, 60, 70) through the face with normal n, at fraction `f` across the face (0.5 = centre). */
function faceHit(n: [number, number, number], f = 0.5): FaceHit {
  const [nx, ny, nz] = n;
  const v = [50, 60, 70];
  const p = v.map((c, a) => (n[a] !== 0 ? c + 0.5 + n[a] * 0.5 : c + f));
  return { x: v[0], y: v[1], z: v[2], nx, ny, nz, px: p[0], py: p[1], pz: p[2] };
}

function cellsOf(out: Int32Array, count: number): [number, number, number][] {
  const cells: [number, number, number][] = [];
  for (let i = 0; i < count; i++) cells.push([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
  return cells;
}

const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, i) => from + i);

describe('placement cells (§11.2)', () => {
  const out = new Int32Array(MAX_PLACE_SIZE ** 3 * 3);

  for (const normal of NORMALS) {
    for (let size = 1; size <= MAX_PLACE_SIZE; size++) {
      for (const inPlace of [false, true]) {
        test(`normal ${normal.join(',')}, size ${size}${inPlace ? ', plant target' : ''}`, () => {
          const hit = faceHit(normal);
          const count = placementCells(hit, size, inPlace, out);
          expect(count).toBe(size ** 3);
          const cells = cellsOf(out, count);
          expect(new Set(cells.map((c) => c.join())).size).toBe(count);
          const axis = normal.findIndex((c) => c !== 0);
          const anchor = [hit.x, hit.y, hit.z].map((c, a) => (inPlace ? c : c + normal[a]));
          for (let a = 0; a < 3; a++) {
            const offsets = [...new Set(cells.map((c) => c[a] - anchor[a]))].sort((p, q) => p - q);
            if (a === axis) {
              // From the anchor away from the clicked face.
              expect(offsets).toEqual(range(0, size).map((k) => k * normal[a] + 0).sort((p, q) => p - q)); // + 0: no -0
            } else {
              // Centred on the anchor: symmetric for odd sizes, one extra cell on one side for even ones.
              expect(offsets).toEqual(range(offsets[0], size));
              expect(offsets).toContain(0);
              if (size % 2 === 1) expect(offsets[0]).toBe((1 - size) / 2);
            }
          }
          // Nearest to the hit point first, starting with the anchor cell.
          expect(cells[0]).toEqual(anchor);
          const dist = cells.map(([x, y, z]) => Math.hypot(x + 0.5 - hit.px, y + 0.5 - hit.py, z + 0.5 - hit.pz));
          for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1] - 1e-9);
        });
      }
    }
  }

  test('even sizes lean towards the hit point', () => {
    const near = cellsOf(out, placementCells(faceHit([0, 1, 0], 0.2), 2, false, out));
    expect([...new Set(near.map((c) => c[0]))].sort()).toEqual([49, 50]);
    const far = cellsOf(out, placementCells(faceHit([0, 1, 0], 0.8), 2, false, out));
    expect([...new Set(far.map((c) => c[0]))].sort()).toEqual([50, 51]);
  });

  test('a hit without a face normal places nothing; sizes are clamped', () => {
    expect(placementCells({ ...faceHit([0, 1, 0]), ny: 0 }, 3, false, out)).toBe(0);
    expect(placementCells(faceHit([0, 1, 0]), 9, false, out)).toBe(MAX_PLACE_SIZE ** 3);
    expect(placementCells(faceHit([0, 1, 0]), 0, false, out)).toBe(1);
  });
});

describe('placement filter', () => {
  const world = World.create();

  test('keeps replaceable cells inside the world that no blocker overlaps, in order', () => {
    world.setBlock(10, 20, 10, B.STONE);
    world.setBlock(11, 20, 10, B.TALL_GRASS);
    world.setBlock(12, 20, 10, B.WATER);
    world.setBlock(13, 20, 10, B.OAK_LEAVES);
    const cells = new Int32Array([
      10, 20, 10, // stone: no
      11, 20, 10, // plant: yes
      12, 20, 10, // water: yes
      13, 20, 10, // foliage: no
      14, 20, 10, // air, but inside the player: no
      15, 20, 10, // air, touching the player's side: yes
      -1, 20, 10, // outside the world: no
      16, 20, 10, // air: yes
    ]);
    const player = { minX: 13.7, minY: 19, minZ: 9.7, maxX: 15, maxY: 37, maxZ: 10.3 };
    const kept = filterPlaceable(world, cells, 8, [player]);
    expect(cellsOf(cells, kept)).toEqual([
      [11, 20, 10],
      [12, 20, 10],
      [15, 20, 10],
      [16, 20, 10],
    ]);
  });

  test('cellsBounds covers every cell', () => {
    const cells = new Int32Array([3, 4, 5, 1, 9, 2, 7, 4, 4]);
    expect(cellsBounds(cells, 3, makeAABB())).toEqual({ minX: 1, minY: 4, minZ: 2, maxX: 8, maxY: 10, maxZ: 6 });
  });
});
