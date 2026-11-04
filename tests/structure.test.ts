import { describe, expect, test } from 'vitest';
import { B } from '../src/world/blocks';
import { FOLIAGE_REACH, findDetached, touchesStruct, type DetachedPiece } from '../src/world/structure';
import { World } from '../src/world/world';

// One world for the file (each World allocates a 32 MB segment); every test builds in its own region.
const world = World.create();

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** Leaves in a ball of radius r around voxel (cx, cy, cz), never overwriting non-air voxels. */
function crown(cx: number, cy: number, cz: number, r: number, id: number): number {
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 > r * r || world.getBlock(x, y, z) !== B.AIR) continue;
        world.setBlock(x, y, z, id);
        n++;
      }
    }
  }
  return n;
}

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

function countIds(piece: DetachedPiece, id: number): number {
  let n = 0;
  for (let i = 0; i < piece.count; i++) if (piece.ids[i] === id) n++;
  return n;
}

function contains(piece: DetachedPiece, x: number, y: number, z: number): boolean {
  for (let i = 0; i < piece.count; i++) {
    if (piece.positions[i * 3] === x && piece.positions[i * 3 + 1] === y && piece.positions[i * 3 + 2] === z) return true;
  }
  return false;
}

/** A 3×3 oak trunk from y = 10 to `top` on a dirt patch, with a side branch and a ball crown on top. */
function plantOak(x: number, z: number, top: number, radius: number, leaves: number): { logs: number; leaves: number } {
  fill(x - 6, 9, z - 6, x + 7, 10, z + 7, B.DIRT);
  fill(x - 1, 10, z - 1, x + 2, top + 1, z + 2, B.OAK_LOG);
  fill(x + 2, top - 4, z, x + 7, top - 3, z + 1, B.OAK_LOG); // branch
  return { logs: 9 * (top - 9) + 5, leaves: crown(x, top, z, radius, leaves) };
}

describe('findDetached', () => {
  test('a cut tree falls as one piece with its whole crown', () => {
    const tree = plantOak(100, 100, 50, 9, B.OAK_LEAVES);
    const seeds = carve(99, 20, 99, 102, 21, 102); // chop through the trunk at y = 20
    const pieces = findDetached(world, seeds, 400_000);
    expect(pieces).toHaveLength(1);
    const [piece] = pieces;
    const logsAbove = tree.logs - 9 * 11; // y 10..20 stay (y = 20 was removed)
    expect(countIds(piece, B.OAK_LOG)).toBe(logsAbove);
    expect(countIds(piece, B.OAK_LEAVES)).toBe(tree.leaves);
    expect(piece.count).toBe(logsAbove + tree.leaves);
    expect(contains(piece, 100, 21, 100)).toBe(true);
    expect(contains(piece, 100, 19, 100)).toBe(false);
    expect(piece.min).toEqual([91, 21, 91]);
    expect(piece.max).toEqual([110, 60, 110]);
    for (let i = 0; i < piece.count; i++) expect(world.getBlock(piece.positions[i * 3], piece.positions[i * 3 + 1], piece.positions[i * 3 + 2])).toBe(piece.ids[i]);
    // The search state is reused between calls: a repeated call must not see the first call's marks.
    expect(findDetached(world, seeds, 400_000)).toEqual(pieces);
  });

  test('a touching neighbour crown is not dragged along', () => {
    // Crowns of radius 10 around trunk tops 21 voxels apart touch face to face (x 210 | 211).
    const a = plantOak(200, 100, 50, 10, B.OAK_LEAVES);
    const b = plantOak(221, 100, 50, 10, B.BIRCH_LEAVES);
    expect(world.getBlock(210, 50, 100)).toBe(B.OAK_LEAVES);
    expect(world.getBlock(211, 50, 100)).toBe(B.BIRCH_LEAVES);
    expect(b.leaves).toBeGreaterThan(0);
    const pieces = findDetached(world, carve(199, 20, 99, 202, 21, 102), 400_000);
    expect(pieces).toHaveLength(1);
    expect(countIds(pieces[0], B.BIRCH_LEAVES)).toBe(0);
    expect(countIds(pieces[0], B.OAK_LEAVES)).toBe(a.leaves);
  });

  test('a wall on its foundation stays when a hole is dug into it', () => {
    fill(300, 9, 100, 320, 10, 103, B.STONE); // ANCHOR foundation
    fill(300, 10, 100, 320, 40, 103, B.BRICK);
    expect(findDetached(world, carve(308, 18, 100, 312, 24, 103), 400_000)).toEqual([]);
    // A doorway right through the bottom: the wall still stands on both sides.
    expect(findDetached(world, carve(312, 10, 100, 315, 22, 103), 400_000)).toEqual([]);
  });

  test('a wall cut loose from its foundation falls whole', () => {
    fill(330, 9, 100, 340, 10, 103, B.STONE);
    fill(330, 10, 100, 340, 20, 103, B.BRICK);
    const pieces = findDetached(world, carve(330, 10, 100, 340, 11, 103), 400_000);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].count).toBe(10 * 9 * 3);
  });

  test('a search over budget assumes support', () => {
    fill(400, 50, 100, 410, 52, 110, B.BRICK); // 200 floating voxels
    const seeds = [405, 52, 105];
    expect(findDetached(world, seeds, 50)).toEqual([]);
    const pieces = findDetached(world, seeds, 1000);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].count).toBe(200);
  });

  test('cutting a floating bar in two gives two pieces', () => {
    fill(500, 50, 100, 521, 51, 101, B.PLANKS);
    const pieces = findDetached(world, carve(510, 50, 100, 511, 51, 101), 400_000);
    expect(pieces).toHaveLength(2);
    expect(pieces.map((p) => p.count)).toEqual([10, 10]);
    expect(pieces.map((p) => p.min[0]).sort((a, b) => a - b)).toEqual([500, 511]);
  });

  test('seeds of one component are analysed once', () => {
    fill(600, 50, 100, 606, 53, 106, B.CONCRETE);
    const seeds = [599, 51, 102, 606, 51, 102, 603, 53, 103, 603, 49, 103];
    const pieces = findDetached(world, seeds, 400_000);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].count).toBe(6 * 3 * 6);
  });

  test('foliage never supports, never seeds and never falls on its own', () => {
    crown(700, 60, 100, 4, B.BUSH);
    expect(findDetached(world, carve(700, 60, 100, 701, 61, 101), 400_000)).toEqual([]);
    // A log held only by leaves is detached: leaves carry no support.
    fill(700, 55, 100, 701, 56, 101, B.OAK_LOG);
    const pieces = findDetached(world, carve(700, 54, 100, 701, 55, 101), 400_000);
    expect(pieces).toHaveLength(1);
    expect(countIds(pieces[0], B.OAK_LOG)).toBe(1);
  });

  test('a hollow shell cluster with inner twigs (the worldgen crown) falls whole', () => {
    // 6-connected line of logs, stepping one axis at a time like the worldgen rasteriser.
    const twig = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
      let [x, y, z] = [ax, ay, az];
      world.setBlock(x, y, z, B.OAK_LOG);
      const n = 2 * Math.ceil(Math.hypot(bx - ax, by - ay, bz - az));
      for (let s = 1; s <= n; s++) {
        const [tx, ty, tz] = [ax + ((bx - ax) * s) / n, ay + ((by - ay) * s) / n, az + ((bz - az) * s) / n].map(Math.round);
        while (x !== tx) world.setBlock((x += Math.sign(tx - x)), y, z, B.OAK_LOG);
        while (y !== ty) world.setBlock(x, (y += Math.sign(ty - y)), z, B.OAK_LOG);
        while (z !== tz) world.setBlock(x, y, (z += Math.sign(tz - z)), B.OAK_LOG);
      }
    };
    const [cx, cy, cz] = [960, 80, 100];
    fill(925, 39, 95, 936, 40, 106, B.DIRT);
    fill(930, 40, 100, 931, 81, 101, B.OAK_LOG); // trunk
    twig(930, 70, 100, cx, cy, cz); // branch to the cluster centre
    const g = (1 + Math.sqrt(5)) / 2;
    for (const [a, b, c] of [[-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0], [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g], [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1]]) {
      const k = 9 / Math.hypot(a, b, c);
      twig(cx, cy, cz, cx + a * k, cy + b * k, cz + c * k); // to the inside of the shell
    }
    let leaves = 0;
    for (let y = cy - 14; y <= cy + 14; y++) {
      for (let z = cz - 14; z <= cz + 14; z++) {
        for (let x = cx - 14; x <= cx + 14; x++) {
          const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
          if (d2 > 14 * 14 || d2 < 10 * 10 || world.getBlock(x, y, z) !== B.AIR) continue;
          world.setBlock(x, y, z, B.OAK_LEAVES);
          leaves++;
        }
      }
    }
    const pieces = findDetached(world, carve(930, 50, 100, 931, 51, 101), 400_000);
    expect(pieces).toHaveLength(1);
    expect(countIds(pieces[0], B.OAK_LEAVES)).toBe(leaves);
  });

  test('foliage beyond the reach stays behind', () => {
    fill(800, 50, 100, 801, 51, 101, B.OAK_LOG);
    const reach = FOLIAGE_REACH;
    fill(801, 50, 100, 801 + reach + 5, 51, 101, B.OAK_LEAVES); // a long leafy strand
    const pieces = findDetached(world, carve(800, 49, 100, 801, 50, 101), 400_000);
    expect(pieces).toHaveLength(1);
    expect(countIds(pieces[0], B.OAK_LEAVES)).toBe(reach);
  });
});

/**
 * Runs findDetached with a read box through a view of the world whose getBlock records every coordinate read;
 * checks the box holds them all and that asking for the box changes nothing else. Returns the pieces and the box.
 */
function detachRecorded(seeds: number[], budget: number): { pieces: DetachedPiece[]; box: Int32Array } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const view = Object.create(world) as World;
  view.getBlock = (x: number, y: number, z: number): number => {
    [x, y, z].forEach((c, a) => {
      lo[a] = Math.min(lo[a], c);
      hi[a] = Math.max(hi[a], c);
    });
    return world.getBlock(x, y, z);
  };
  const box = new Int32Array(6);
  const pieces = findDetached(view, seeds, budget, undefined, box);
  expect(lo[0]).toBeLessThan(Infinity); // something was read
  for (let a = 0; a < 3; a++) {
    expect(lo[a]).toBeGreaterThanOrEqual(box[a]);
    expect(hi[a]).toBeLessThan(box[a + 3]);
  }
  expect(pieces).toEqual(findDetached(world, seeds, budget));
  return { pieces, box };
}

describe('findDetached read box', () => {
  test('a cut tree: the box holds the stump search, the trunk, the crown and the foliage scans', () => {
    plantOak(100, 300, 50, 9, B.OAK_LEAVES);
    const seeds = carve(99, 20, 299, 102, 21, 302);
    expect(touchesStruct(world, seeds)).toBe(true);
    const { pieces, box } = detachRecorded(seeds, 400_000);
    expect(pieces).toHaveLength(1);
    const [piece] = pieces;
    for (let a = 0; a < 3; a++) {
      expect(box[a]).toBeLessThanOrEqual(piece.min[a] - 1);
      expect(box[a + 3]).toBeGreaterThanOrEqual(piece.max[a] + 1);
    }
  });

  test('a wall with a hole (supported) and a wall cut loose (unsupported)', () => {
    fill(300, 9, 300, 320, 10, 303, B.STONE);
    fill(300, 10, 300, 320, 40, 303, B.BRICK);
    expect(detachRecorded(carve(308, 18, 300, 312, 24, 303), 400_000).pieces).toEqual([]);
    fill(330, 9, 300, 340, 10, 303, B.STONE);
    fill(330, 10, 300, 340, 20, 303, B.BRICK);
    expect(detachRecorded(carve(330, 10, 300, 340, 11, 303), 400_000).pieces).toHaveLength(1);
  });

  test('a search over budget', () => {
    fill(400, 50, 300, 410, 52, 310, B.BRICK);
    expect(detachRecorded([405, 52, 305], 50).pieces).toEqual([]);
  });

  test('foliage touching another trunk: the box holds the scan from that rival, which reaches beyond the piece’s own', () => {
    // A leafy strand runs east from the cut trunk's top over a second trunk 49 voxels away: the piece's own foliage scan
    // ends 2·FOLIAGE_REACH steps out (x 161), the rival's FOLIAGE_REACH steps past the second trunk (x 179).
    fill(94, 9, 494, 107, 10, 507, B.DIRT);
    fill(99, 10, 499, 102, 51, 502, B.OAK_LOG);
    fill(102, 50, 500, 230, 51, 501, B.OAK_LEAVES);
    fill(148, 9, 499, 153, 10, 504, B.DIRT);
    fill(150, 10, 500, 151, 50, 501, B.OAK_LOG);
    const { pieces, box } = detachRecorded(carve(99, 20, 499, 102, 21, 502), 400_000);
    expect(pieces).toHaveLength(1);
    expect(countIds(pieces[0], B.OAK_LEAVES)).toBe(24); // x 102..125: strictly nearer to the cut trunk
    expect(box[3]).toBeGreaterThan(150 + FOLIAGE_REACH);
  });

  test('a dig touching no STRUCT voxel reads only around the seeds', () => {
    fill(500, 5, 300, 510, 10, 310, B.DIRT);
    const seeds = carve(503, 8, 303, 505, 10, 304);
    expect(touchesStruct(world, seeds)).toBe(false);
    const { pieces, box } = detachRecorded(seeds, 400_000);
    expect(pieces).toEqual([]);
    expect(Array.from(box)).toEqual([502, 7, 302, 506, 11, 305]);
  });
});
