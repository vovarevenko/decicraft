import { describe, expect, test } from 'vitest';
import { COLS, DIR, PAD3, PLANT_POS_SCALE, PLANT_TILE, padIndex } from '../src/render/voxel/layout';
import { EMPTY_MESH_HASH, MeshJobRunner } from '../src/render/voxel/meshJob';
import { Mesher, columnLight, type MeshOutput, type MeshParams } from '../src/render/voxel/mesher';
import { VolumeBuilder } from '../src/render/voxel/volume';
import { B, PLANT_HEIGHT } from '../src/world/blocks';
import { World } from '../src/world/world';

interface Vert {
  x: number;
  y: number;
  z: number;
  normal: number;
  ao: number;
  sky: number;
  id: number;
}

/** Quads of an opaque/glass/water layer as 4-vertex arrays. */
function quads(bytes: Uint8Array | null): Vert[][] {
  const out: Vert[][] = [];
  if (bytes === null) return out;
  for (let q = 0; q < bytes.length / 32; q++) {
    const quad: Vert[] = [];
    for (let v = 0; v < 4; v++) {
      const o = q * 32 + v * 8;
      quad.push({ x: bytes[o], y: bytes[o + 1], z: bytes[o + 2], normal: bytes[o + 4], ao: bytes[o + 5], sky: bytes[o + 6], id: bytes[o + 7] });
    }
    out.push(quad);
  }
  return out;
}

const openSky = (): Int16Array => new Int16Array(COLS * COLS);

function meshVolume(vol: Uint8Array, params: Partial<MeshParams> = {}, sky = openSky(), canopy = openSky()): MeshOutput {
  return new Mesher().mesh(vol, sky, canopy, { level: 0, ox: 0, oy: 0, oz: 0, boundary: 0, seed: -1, ...params });
}

function volumeWith(cells: [number, number, number, number][]): Uint8Array {
  const vol = new Uint8Array(PAD3);
  for (const [x, y, z, id] of cells) vol[padIndex(x, y, z)] = id;
  return vol;
}

function fillBox(vol: Uint8Array, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) vol[padIndex(x, y, z)] = id;
}

const span = (quad: Vert[], axis: 'x' | 'y' | 'z'): [number, number] => [Math.min(...quad.map((v) => v[axis])), Math.max(...quad.map((v) => v[axis]))];

describe('mesher: faces', () => {
  test('a single voxel gives 6 quads, one per direction, forming a unit cube', () => {
    const out = meshVolume(volumeWith([[10, 20, 30, B.STONE]]));
    expect(out.opaqueQuads).toBe(6);
    expect(out.glass).toBeNull();
    expect(out.water).toBeNull();
    expect(out.plantPos).toBeNull();
    const qs = quads(out.opaque);
    expect(qs.map((q) => q[0].normal).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    const lo = { x: 10, y: 20, z: 30 };
    for (const q of qs) {
      for (const v of q) {
        expect(v.id).toBe(B.STONE);
        expect(v.ao).toBe(3);
        expect(v.sky).toBe(15);
      }
      const n = q[0].normal;
      const planeAxis = n < 2 ? 'x' : n < 4 ? 'y' : 'z';
      for (const axis of ['x', 'y', 'z'] as const) {
        const plane = lo[axis] + (n % 2 === 0 ? 1 : 0);
        expect(span(q, axis)).toEqual(axis === planeAxis ? [plane, plane] : [lo[axis], lo[axis] + 1]);
      }
    }
  });

  test('quads wind counter-clockwise seen from outside', () => {
    for (const q of quads(meshVolume(volumeWith([[5, 5, 5, B.STONE]])).opaque)) {
      const [a, b, c] = q;
      const e1 = [b.x - a.x, b.y - a.y, b.z - a.z];
      const e2 = [c.x - a.x, c.y - a.y, c.z - a.z];
      const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const n = q[0].normal;
      const expected = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ][n];
      expect(cross[0] * expected[0] + cross[1] * expected[1] + cross[2] * expected[2]).toBeGreaterThan(0);
    }
  });

  test('adjacent equal blocks merge; different blocks do not', () => {
    const row = meshVolume(volumeWith([0, 1, 2, 3].map((i): [number, number, number, number] => [10 + i, 10, 10, B.STONE])));
    expect(row.opaqueQuads).toBe(6);
    const top = quads(row.opaque).find((q) => q[0].normal === DIR.PY)!;
    expect(span(top, 'x')).toEqual([10, 14]);

    const mixed = meshVolume(
      volumeWith([
        [10, 10, 10, B.STONE],
        [11, 10, 10, B.STONE],
        [12, 10, 10, B.BRICK],
        [13, 10, 10, B.BRICK],
      ]),
    );
    // Top, bottom and both long sides split by material; the end caps stay single.
    expect(mixed.opaqueQuads).toBe(10);
  });

  test('interior faces are culled', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 20, 20, 20, 23, 23, 23, B.GRANITE);
    const out = meshVolume(vol);
    expect(out.opaqueQuads).toBe(6);
    for (const q of quads(out.opaque)) {
      const axes = (['x', 'y', 'z'] as const).filter((a) => span(q, a)[1] - span(q, a)[0] === 3);
      expect(axes.length).toBe(2);
    }
  });

  test('foliage is opaque: faces between leaves are culled, leaves hide stone faces', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 10, 10, 10, 14, 11, 11, B.OAK_LEAVES);
    vol[padIndex(14, 10, 10)] = B.STONE;
    const out = meshVolume(vol);
    // Leaves: 4 long faces + one end cap; stone: 4 long faces + one end cap.
    expect(out.opaqueQuads).toBe(10);
  });

  test('AO: 3-neighbour rule with a fully dark concave corner', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 0, 10, 0, 5, 11, 5, B.STONE); // floor, top at y = 11
    vol[padIndex(2, 11, 2)] = B.STONE; // +x of the face of cell (1, 10, 2)
    vol[padIndex(1, 11, 3)] = B.STONE; // +z of the same face
    const tops = quads(meshVolume(vol).opaque).filter((q) => q[0].normal === DIR.PY && q[0].y === 11);
    const at = (x: number, z: number) => tops.flatMap((q) => q.filter((v) => v.x === x && v.z === z));
    // Corner (2, 3) touches both walls of the face of cell (1, 10, 2): AO 0.
    expect(at(2, 3).some((v) => v.ao === 0)).toBe(true);
    // A corner touching one wall only: 3 - 1 - (diagonal) — e.g. (2, 2) has the (2,11,2) side.
    expect(Math.min(...at(2, 2).map((v) => v.ao))).toBeLessThan(3);
    // Far from the walls everything is fully lit.
    expect(at(0, 0).every((v) => v.ao === 3)).toBe(true);
  });

  test('the diagonal avoids an isolated dark corner (vertex order rotation)', () => {
    const vol = new Uint8Array(PAD3);
    vol[padIndex(5, 10, 5)] = B.STONE;
    vol[padIndex(4, 11, 4)] = B.STONE; // only the corner neighbour of the top face's (x−, z−) vertex
    const top = quads(meshVolume(vol).opaque).find((q) => q[0].normal === DIR.PY && q[0].y === 11 && span(q, 'x')[0] === 5)!;
    const dark = top.findIndex((v) => v.ao < 3);
    expect(top[dark].ao).toBe(2);
    expect(top[dark].x).toBe(5);
    expect(top[dark].z).toBe(5);
    // Triangles (0,1,2) and (0,2,3) share the diagonal 0–2: the dark vertex must not be on it.
    expect(dark % 2).toBe(1);
  });

  test('levels above 0 omit AO', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 0, 10, 0, 5, 11, 5, B.STONE);
    vol[padIndex(2, 11, 2)] = B.STONE;
    for (const q of quads(meshVolume(vol, { level: 1 }).opaque)) for (const v of q) expect(v.ao).toBe(3);
  });

  test('routing: glass, water and plants get their own layers', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 0, 9, 0, 20, 10, 20, B.STONE);
    vol[padIndex(2, 10, 2)] = B.GLASS;
    vol[padIndex(6, 10, 6)] = B.WATER;
    vol[padIndex(10, 10, 10)] = B.TALL_GRASS;
    const out = meshVolume(vol);
    expect(out.glassQuads).toBe(5); // bottom face rests on stone
    expect(out.waterQuads).toBe(5);
    expect(out.plantQuads).toBe(2);
    for (const q of quads(out.glass)) expect(q[0].id).toBe(B.GLASS);
    for (const q of quads(out.water)) expect(q[0].id).toBe(B.WATER);
    // None of them is opaque: the ground stays visible under the plant, the glass and the water.
    const groundTops = quads(out.opaque).filter((q) => q[0].normal === DIR.PY);
    const covered = (x: number, z: number) => groundTops.some((q) => span(q, 'x')[0] <= x && span(q, 'x')[1] > x && span(q, 'z')[0] <= z && span(q, 'z')[1] > z);
    expect(covered(10, 10)).toBe(true);
    expect(covered(2, 2)).toBe(true);
    expect(covered(6, 6)).toBe(true);
  });

  test('glass faces between glass voxels are culled; water shows only against air and plants', () => {
    const vol = new Uint8Array(PAD3);
    vol[padIndex(10, 10, 10)] = B.GLASS;
    vol[padIndex(11, 10, 10)] = B.GLASS;
    vol[padIndex(20, 10, 20)] = B.WATER;
    vol[padIndex(21, 10, 20)] = B.GLASS; // water–glass: water face hidden, glass face shown
    vol[padIndex(20, 11, 20)] = B.REEDS; // water under a plant: top face shown
    const out = meshVolume(vol);
    expect(out.glassQuads).toBe(6 + 6);
    expect(out.waterQuads).toBe(5);
  });

  test('water surfaces are lowered: top face fully, side faces at the top edge only', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 10, 10, 10, 11, 12, 11, B.WATER); // a 2-high water column
    const water = quads(meshVolume(vol).water);
    const top = water.find((q) => q[0].normal === DIR.PY)!;
    expect(top.every((v) => v.ao === 1)).toBe(true);
    const bottom = water.find((q) => q[0].normal === DIR.NY)!;
    expect(bottom.every((v) => v.ao === 0)).toBe(true);
    for (const q of water.filter((q) => q[0].normal !== DIR.PY && q[0].normal !== DIR.NY)) {
      for (const v of q) expect(v.ao).toBe(v.y === 12 ? 1 : 0);
    }
  });

  test('world side planes emit no outward faces', () => {
    const vol = volumeWith([[0, 5, 5, B.STONE]]);
    const out = meshVolume(vol, { boundary: 1 << DIR.NX });
    expect(out.opaqueQuads).toBe(5);
    expect(quads(out.opaque).some((q) => q[0].normal === DIR.NX)).toBe(false);
  });
});

describe('mesher: plants', () => {
  test('two crossed quads with hashed height, offset and tile', () => {
    const out = meshVolume(volumeWith([[10, 10, 10, B.REEDS]]), { ox: 64, oz: 128 });
    expect(out.plantQuads).toBe(2);
    const pos = out.plantPos!;
    const data = out.plantData!;
    let top = -Infinity;
    for (let v = 0; v < 8; v++) {
      const x = pos[v * 4] / PLANT_POS_SCALE;
      const y = pos[v * 4 + 1] / PLANT_POS_SCALE;
      const z = pos[v * 4 + 2] / PLANT_POS_SCALE;
      top = Math.max(top, y);
      expect(data[v * 4]).toBe(PLANT_TILE[B.REEDS]);
      expect(Math.abs(x - 10.5)).toBeLessThanOrEqual(0.25 + 0.61);
      expect(Math.abs(z - 10.5)).toBeLessThanOrEqual(0.25 + 0.61);
      const corner = data[v * 4 + 1];
      expect(y).toBeCloseTo(10 + ((corner >> 1) & 1) * ((corner >> 2) / 4), 5);
    }
    expect(top - 10).toBeGreaterThanOrEqual(PLANT_HEIGHT[B.REEDS] * 0.7 - 0.13);
    expect(top - 10).toBeLessThanOrEqual(PLANT_HEIGHT[B.REEDS] * 1.2 + 0.13);
    // Deterministic per world position.
    expect(meshVolume(volumeWith([[10, 10, 10, B.REEDS]]), { ox: 64, oz: 128 }).plantPos).toEqual(pos);
  });

  test('no plants above level 0', () => {
    const out = meshVolume(volumeWith([[10, 10, 10, B.TALL_GRASS]]), { level: 1 });
    expect(out.plantQuads).toBe(0);
    expect(out.plantPos).toBeNull();
  });
});

describe('mesher: skirts', () => {
  const ground = (): Uint8Array => {
    const vol = new Uint8Array(PAD3);
    for (let y = -1; y <= 30; y++) for (let z = -1; z <= 64; z++) for (let x = -1; x <= 64; x++) vol[padIndex(x, y, z)] = B.STONE;
    return vol;
  };

  test('border planes emit outward faces of opaque cells within 2 cells of air', () => {
    const plus = quads(meshVolume(ground()).opaque).filter((q) => q[0].normal === DIR.PX && q[0].x === 64);
    expect(plus.length).toBe(1);
    expect(span(plus[0], 'y')).toEqual([29, 31]);
    expect(span(plus[0], 'z')).toEqual([0, 64]);
    expect(plus[0].every((v) => v.ao === 3)).toBe(true);
    // The same on every side plane with a neighbour, nothing deeper than 2 cells.
    const all = quads(meshVolume(ground()).opaque);
    for (const d of [DIR.NX, DIR.PZ, DIR.NZ]) {
      const skirt = all.filter((q) => q[0].normal === d && (d === DIR.NX ? q[0].x === 0 : q[0].z === (d === DIR.PZ ? 64 : 0)));
      expect(skirt.length).toBe(1);
      expect(span(skirt[0], 'y')).toEqual([29, 31]);
    }
  });

  test('no skirts on world-boundary planes or far from open cells', () => {
    const out = meshVolume(ground(), { boundary: 1 << DIR.PX });
    expect(quads(out.opaque).some((q) => q[0].normal === DIR.PX)).toBe(false);
    const deep = new Uint8Array(PAD3).fill(B.STONE);
    expect(meshVolume(deep).opaqueQuads).toBe(0);
  });
});

describe('mesher: sealed pockets', () => {
  const hollowBox = (): Uint8Array => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 10, 10, 10, 20, 20, 20, B.OAK_LEAVES);
    fillBox(vol, 13, 13, 13, 17, 17, 17, B.AIR);
    return vol;
  };

  test('faces towards a sealed air core are culled and the pocket is reported', () => {
    const out = meshVolume(hollowBox());
    expect(out.opaqueQuads).toBe(6);
    expect(Array.from(out.cavities!)).toEqual([13, 13, 13, 17, 17, 17]);
  });

  test('a seed inside the pocket keeps its faces', () => {
    const out = meshVolume(hollowBox(), { seed: padIndex(15, 15, 15) });
    const inner = quads(out.opaque).filter((q) => (['x', 'y', 'z'] as const).every((a) => span(q, a)[0] >= 13 && span(q, a)[1] <= 17));
    expect(out.opaqueQuads).toBe(6 + inner.length);
    expect(new Set(inner.map((q) => q[0].normal)).size).toBe(6);
    expect(out.cavities).toBeNull();
  });

  test('a pocket open to the padding is not sealed', () => {
    const vol = new Uint8Array(PAD3);
    fillBox(vol, 0, 10, 10, 6, 16, 16, B.STONE);
    fillBox(vol, 0, 12, 12, 3, 14, 14, B.AIR); // tunnel ending at the node face x = 0
    vol[padIndex(-1, 12, 12)] = B.AIR;
    expect(meshVolume(vol).cavities).toBeNull();
  });
});

describe('mesher: skylight', () => {
  test('columnLight: roof falloff and canopy shade', () => {
    expect(columnLight(100, 100, 100)).toBe(1);
    expect(columnLight(100, 124, 100)).toBeCloseTo(0.5);
    expect(columnLight(100, 200, 100)).toBe(0.25);
    expect(columnLight(100, 100, 130)).toBeCloseTo(0.6);
    expect(columnLight(100, 0, 0)).toBe(1);
  });

  test('vertices under a roof and under a canopy are darker, quantised to 16 levels', () => {
    const w = World.create();
    for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) w.setBlock(x, 100, z, B.STONE);
    for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) w.setBlock(x, 120, z, B.PLANKS); // roof: sky = 121
    for (let x = 40; x < 60; x++) for (let z = 40; z < 60; z++) w.setBlock(x, 130, z, B.OAK_LEAVES); // canopy = 131
    const b = new VolumeBuilder();
    b.build(w, 0, 0, 64, 0);
    const out = new Mesher().mesh(b.volume, b.colSky, b.colCanopy, { level: 0, ox: 0, oy: 64, oz: 0, boundary: 0, seed: -1 });
    const tops = quads(out.opaque).filter((q) => q[0].normal === DIR.PY && q[0].y === 101 - 64);
    // Corner skylight of the merged quad covering voxel column (x, z).
    const skyAt = (x: number, z: number) => {
      const q = tops.find((t) => span(t, 'x')[0] <= x && span(t, 'x')[1] > x && span(t, 'z')[0] <= z && span(t, 'z')[1] > z)!;
      return q.map((v) => v.sky);
    };
    // Roofed: roof · leaf, since the canopy map counts every opaque block (roofs included).
    expect(skyAt(10, 10)).toEqual(Array(4).fill(Math.round(15 * (1 - 20 / 48) * 0.6)));
    expect(skyAt(50, 50)).toEqual([9, 9, 9, 9]); // canopy: 0.6
    expect(skyAt(30, 30)).toEqual([15, 15, 15, 15]); // open sky
  });

  test('vertical faces take their skylight from the columns in front of them, past the eaves', () => {
    const w = World.create();
    for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) w.setBlock(x, 100, z, B.STONE);
    // A house: walls x, z = 20..29 up to y = 119 with a door, roof at y = 120 with 3-voxel eaves (sky = canopy = 121).
    for (let y = 101; y < 120; y++) {
      for (let x = 20; x < 30; x++) {
        for (let z = 20; z < 30; z++) {
          const door = z === 20 && x >= 24 && x < 26 && y < 104;
          if ((x === 20 || x === 29 || z === 20 || z === 29) && !door) w.setBlock(x, y, z, B.BRICK);
        }
      }
    }
    for (let x = 17; x < 33; x++) for (let z = 17; z < 33; z++) w.setBlock(x, 120, z, B.PLANKS);
    // A free-standing wall in the open.
    for (let y = 101; y < 110; y++) for (let z = 40; z < 50; z++) w.setBlock(45, y, z, B.BRICK);
    const b = new VolumeBuilder();
    const mesher = new Mesher();
    /** Checks the corner skylight of the `normal` faces on the plane `axis` = c (voxels) within [lo, hi] of the other axis. */
    const check = (level: number, oy: number, normal: number, c: number, lo: number, hi: number, expected: (y: number) => number) => {
      b.build(w, level, 0, oy, 0);
      const out = mesher.mesh(b.volume, b.colSky, b.colCanopy, { level, ox: 0, oy, oz: 0, boundary: 0, seed: -1 });
      const [axis, other] = normal === DIR.PX || normal === DIR.NX ? (['x', 'z'] as const) : (['z', 'x'] as const);
      const cell = 1 << level;
      const vs = quads(out.opaque)
        .filter((q) => q[0].normal === normal && q.every((v) => v[axis] * cell === c && v[other] * cell >= lo && v[other] * cell <= hi))
        .flat();
      expect(vs.length).toBeGreaterThanOrEqual(4);
      for (const v of vs) expect(Math.abs(v.sky - 15 * expected(oy + v.y * cell))).toBeLessThanOrEqual(0.5 + 1e-9);
    };
    const under = (y: number) => columnLight(y, 121, 121);
    // Outside walls: the rows 0 and 2 voxels out are under the eaves, the row 5 out is open (it was the eaves alone).
    // Level 1 samples one column per 2-voxel cell, with rows that give these walls the same light.
    const outside = (y: number) => (4 * under(y) + 2) / 6;
    for (const [level, oy] of [[0, 64], [1, 0]]) {
      check(level, oy, DIR.PX, 30, 20, 30, outside);
      check(level, oy, DIR.NX, 20, 20, 30, outside);
      check(level, oy, DIR.PZ, 30, 20, 30, outside);
      check(level, oy, DIR.NZ, 20, 20, 30, outside);
    }
    // Inside walls: everything in front is under the roof.
    check(0, 64, DIR.NX, 29, 21, 29, under);
    check(0, 64, DIR.PX, 21, 21, 29, under);
    check(0, 64, DIR.NZ, 29, 21, 29, under);
    check(0, 64, DIR.PZ, 21, 21, 29, under);
    // A wall in the open is lit by the open sky on both sides, not darkened by its own column.
    check(0, 64, DIR.PX, 46, 40, 50, () => 1);
    check(0, 64, DIR.NX, 45, 40, 50, () => 1);
  });
});

describe('mesh jobs', () => {
  test('a job answers "unchanged" exactly when its inputs hash to prevHash; −1 forces meshing', () => {
    const w = World.create();
    w.setBlock(70, 70, 70, B.BRICK);
    const r = new MeshJobRunner();
    r.init(w.toShared());
    const job = { type: 'job' as const, id: 1, level: 0, ox: 64, oy: 64, oz: 64, boundary: 0, prevHash: -1, camX: 1000, camY: 300, camZ: 1000 };
    const first = r.run(job).response;
    expect(first.unchanged).toBe(false);
    expect(first.mesh!.opaqueQuads).toBe(6);
    expect(r.run({ ...job, id: 2, prevHash: first.hash }).response.unchanged).toBe(true);
    // The camera seed is not an input: the renderer forces re-seeds with prevHash −1.
    expect(r.run({ ...job, id: 3, prevHash: first.hash, camX: 70, camY: 72, camZ: 70 }).response.unchanged).toBe(true);
    const forced = r.run({ ...job, id: 4, camX: 70, camY: 72, camZ: 70 }).response;
    expect(forced.unchanged).toBe(false);
    expect(forced.hash).toBe(first.hash);
    w.setBlock(64 + 64, 70, 70, B.BRICK); // in the +x padding layer
    expect(r.run({ ...job, id: 5, prevHash: first.hash }).response.unchanged).toBe(false);
  });

  test('results carry a geometry hash: equal for equal geometry, EMPTY_MESH_HASH without any', () => {
    const w = World.create();
    w.setBlock(0, 0, 0, B.STONE); // allocates the first shared segment before the runner attaches
    const r = new MeshJobRunner();
    r.init(w.toShared());
    const job = { type: 'job' as const, id: 1, level: 0, ox: 64, oy: 64, oz: 64, boundary: 0, prevHash: -1, camX: 1000, camY: 300, camZ: 1000 };
    expect(r.run(job).response.meshHash).toBe(EMPTY_MESH_HASH);
    w.setBlock(70, 70, 70, B.BRICK);
    const brick = r.run({ ...job, id: 2 }).response;
    expect(brick.meshHash).not.toBe(EMPTY_MESH_HASH);
    // A roof high above a sampled column far from the brick: new inputs, same geometry.
    w.setBlock(120, 200, 120, B.STONE);
    const roofed = r.run({ ...job, id: 3, prevHash: brick.hash }).response;
    expect(roofed.unchanged).toBe(false);
    expect(roofed.meshHash).toBe(brick.meshHash);
    w.setBlock(71, 70, 70, B.BRICK);
    expect(r.run({ ...job, id: 4 }).response.meshHash).not.toBe(brick.meshHash);
  });

  test('the camera cell seeds the mesher: a sealed pocket around the camera stays open', () => {
    const w = World.create();
    for (let y = 80; y < 90; y++) for (let z = 80; z < 90; z++) for (let x = 80; x < 90; x++) w.setBlock(x, y, z, B.OAK_LEAVES);
    for (let y = 83; y < 87; y++) for (let z = 83; z < 87; z++) for (let x = 83; x < 87; x++) w.setBlock(x, y, z, B.AIR);
    const r = new MeshJobRunner();
    r.init(w.toShared());
    const job = { type: 'job' as const, id: 1, level: 0, ox: 64, oy: 64, oz: 64, boundary: 0, prevHash: -1, camX: 1000, camY: 300, camZ: 1000 };
    const outside = r.run(job).response.mesh!;
    expect(Array.from(outside.cavities!)).toEqual([19, 19, 19, 23, 23, 23]);
    const inside = r.run({ ...job, id: 2, camX: 85.5, camY: 85.2, camZ: 85.5 }).response.mesh!;
    expect(inside.cavities).toBeNull();
    // The outer shell is meshed identically; the extra quads are exactly the pocket's walls.
    const inner = quads(inside.opaque).filter((q) => (['x', 'y', 'z'] as const).every((a) => span(q, a)[0] >= 19 && span(q, a)[1] <= 23));
    expect(inside.opaqueQuads).toBe(outside.opaqueQuads + inner.length);
    expect(new Set(inner.map((q) => q[0].normal)).size).toBe(6);
  });
});
