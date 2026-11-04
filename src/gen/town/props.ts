/**
 * Street furniture and yard props, each one Feature with tight bounds: concrete lamp posts, a bench,
 * the bus stop «Остановка», a rusted car wreck, wooden picket fences (partly fallen) and rubble piles.
 * Random choices are made at plan time (props are small); per-voxel variation (rust) is hashed.
 */
import { hash3, type Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import { ORDER, type Facing, type Feature, type VoxelWriter } from '../types';
import { GROUND_TOP, GROUND_Y, moundHeight, PAVED_TOP, patchNoise, rnd2 } from './common';
import { BoxList, Frame, LocalBounds, LocalWriter, type Rect } from './frame';
import { forEachTextCell, GLYPH_H } from './glyphs';

/** Feature made of an ordered list of local boxes in a frame. */
function boxFeature(kind: string, frame: Frame, build: (L: BoxList) => void): Feature {
  const bounds = new LocalBounds();
  const list = new BoxList(bounds);
  build(list);
  const bb = bounds.toWorld(frame);
  return { kind, min: bb.min, max: bb.max, order: ORDER.PROP, stamp: (w) => list.stamp(new LocalWriter(w, frame)) };
}

/**
 * Concrete street lamp: a 2×2 pole at (x, z) with a steel arm reaching over the road towards `dir`
 * and a lamp head (glass underneath). A broken one has lost its head.
 */
export function lampPost(x: number, z: number, dir: Facing, rng: Rng): Feature {
  const f = new Frame(x, z, 2, 2, dir);
  const top = GROUND_Y + rng.int(62, 70);
  const arm = rng.int(11, 15);
  const broken = rng.chance(0.3);
  return boxFeature('prop:lamp', f, (L) => {
    L.add(0, GROUND_TOP - 1, 0, 2, top, 2, B.CONCRETE);
    L.add(0, top - 4, -2, 1, top - 2, 0, B.METAL);
    L.add(0, top - 2, -arm, 1, top - 1, -1, B.METAL);
    if (!broken) {
      L.add(-1, top - 4, -arm - 1, 2, top - 1, -arm + 4, B.PAINTED_METAL);
      L.add(0, top - 5, -arm, 1, top - 4, -arm + 3, B.GLASS);
    }
  });
}

/** Park bench on a paved surface (concrete legs, plank seat and back); the sitter looks towards `facing`. */
export function bench(x0: number, z0: number, facing: Facing): Feature {
  const f = new Frame(x0, z0, 16, 6, facing);
  return boxFeature('prop:bench', f, (L) => {
    const y = PAVED_TOP + 1;
    for (const u of [1, 13]) L.add(u, GROUND_TOP, 0, u + 2, y + 4, 5, B.CONCRETE);
    L.add(0, y + 4, 0, 16, y + 5, 4, B.PLANKS);
    L.add(0, y + 6, 4, 16, y + 7, 5, B.PLANKS);
    L.add(0, y + 8, 4, 16, y + 9, 5, B.PLANKS);
    for (const u of [1, 14]) L.add(u, y + 4, 4, u + 1, y + 10, 6, B.METAL);
  });
}

/**
 * Soviet bus stop: concrete back wall with a tile mosaic, glazed side walls (mostly broken), a roof
 * slab overhanging the front, a bench inside, and a sign pole with the letter «А» at the curb.
 * `facing` is the open front (towards the road); (x0, z0) is the shelter's footprint corner.
 */
export function busStop(x0: number, z0: number, facing: Facing, rng: Rng): Feature {
  const W = 32;
  const D = 14;
  const f = new Frame(x0, z0, W, D, facing);
  return boxFeature('prop:bus_stop', f, (L) => {
    const y = PAVED_TOP + 1;
    L.add(-3, GROUND_TOP, 0, W + 3, PAVED_TOP + 1, D + 1, B.PAVING);
    // Back wall with a mosaic band, side walls with windows.
    L.add(0, y, D - 2, W, y + 24, D, B.CONCRETE);
    const mosaic = [B.TILES, B.PAINTED_METAL, B.BRICK, B.TILES, B.PLASTER_BLUE];
    for (let u = 2, i = 0; u + 4 <= W - 2; u += 4, i++) L.add(u, y + 9, D - 3, u + 4, y + 15, D - 2, mosaic[(i * 3 + 1) % mosaic.length]);
    for (const u of [0, W - 2]) {
      L.add(u, y, 3, u + 2, y + 24, D - 2, B.PAINTED_METAL);
      L.add(u, y + 7, 5, u + 2, y + 19, D - 3, B.AIR);
      for (let v = 5; v < D - 3; v += 4) {
        if (rng.chance(0.35)) L.add(u + (u === 0 ? 0 : 1), y + 7, v, u + (u === 0 ? 1 : 2), y + 19, Math.min(v + 4, D - 3), B.GLASS);
      }
    }
    L.add(-2, y + 24, -3, W + 2, y + 26, D + 1, B.CONCRETE);
    // Bench inside.
    for (const u of [4, W - 7]) L.add(u, y, D - 6, u + 3, y + 4, D - 2, B.CONCRETE);
    L.add(3, y + 4, D - 6, W - 3, y + 5, D - 2, B.PLANKS);
    // Sign pole at the curb: a blue plate across the road direction with «А» on both faces.
    const pu = W + 3;
    const pv = -4;
    L.add(pu, GROUND_TOP - 1, pv, pu + 1, y + 26, pv + 1, B.METAL);
    const py = y + 15;
    L.add(pu, py, pv - 3, pu + 1, py + GLYPH_H + 2, pv + 4, B.PAINTED_METAL);
    forEachTextCell('А', (col, row) => {
      const vv = pv - 2 + col;
      const yy = py + GLYPH_H - row;
      L.add(pu - 1, yy, vv, pu, yy + 1, vv + 1, B.PAINTED_WOOD);
      L.add(pu + 1, yy, vv, pu + 2, yy + 1, vv + 1, B.PAINTED_WOOD);
    });
  });
}

/**
 * Rusted Soviet saloon car (~4 × 1.6 × 1.4 m) facing `facing`: rusty paint, broken windows, seats,
 * one wheel gone and the corner propped on bricks. (x0, z0) is the footprint corner (16 × 40 voxels).
 */
export function carWreck(x0: number, z0: number, facing: Facing, rng: Rng, seed: number): Feature {
  const W = 16;
  const D = 40;
  const f = new Frame(x0, z0, W, D, facing);
  const y0 = GROUND_Y;
  const missing = rng.int(0, 4);
  const panes: boolean[] = [];
  for (let i = 0; i < 8; i++) panes.push(rng.chance(0.3));
  const paint = rng.pick([B.PAINTED_METAL, B.PAINTED_METAL, B.PLASTER_GREEN]);
  // Glass panes in the cabin: [u0, v0, u1, v1] at y ∈ [y0 + 9, y0 + 13).
  const glass: [number, number, number, number][] = [
    [3, 11, 13, 12], // windscreen
    [3, 29, 13, 30], // rear window
    [2, 12, 3, 20],
    [2, 21, 3, 29],
    [13, 12, 14, 20],
    [13, 21, 14, 29],
  ];
  const stamp = (w: VoxelWriter) => {
    const lw = new LocalWriter(w, f);
    // Painted steel with rust patches (hashed per world voxel).
    const steel = (u0: number, y0b: number, v0: number, u1: number, y1: number, v1: number) => {
      for (let v = v0; v < v1; v++) {
        for (let u = u0; u < u1; u++) {
          const wx = f.wx(u, v);
          const wz = f.wz(u, v);
          for (let y = y0b; y < y1; y++) {
            const rust = patchNoise(wx + y * 3, wz - y * 2, 5, seed) > 0.52 || (hash3(wx, y, wz, seed) & 7) === 0;
            lw.set(u, y, v, rust ? B.METAL : paint);
          }
        }
      }
    };
    steel(1, y0 + 2, 1, 15, y0 + 8, 39);
    // Cabin pillars and roof.
    for (const [u, v] of [
      [2, 11],
      [13, 11],
      [2, 20],
      [13, 20],
      [2, 29],
      [13, 29],
    ])
      steel(u, y0 + 8, v, u + 1, y0 + 14, v + 1);
    steel(2, y0 + 14, 11, 14, y0 + 15, 30);
    lw.fill(1, y0 + 2, 0, 15, y0 + 4, 1, B.METAL);
    lw.fill(1, y0 + 2, 39, 15, y0 + 4, 40, B.METAL);
    lw.fill(2, y0 + 5, 1, 4, y0 + 6, 2, B.GLASS);
    lw.fill(12, y0 + 5, 1, 14, y0 + 6, 2, B.GLASS);
    // Dashboard with the steering wheel, seats with backrests down to the floor.
    lw.fill(3, y0 + 8, 12, 13, y0 + 11, 13, paint);
    lw.fill(4, y0 + 10, 13, 7, y0 + 12, 14, B.METAL);
    lw.fill(3, y0 + 8, 15, 7, y0 + 10, 19, B.FABRIC);
    lw.fill(9, y0 + 8, 15, 13, y0 + 10, 19, B.FABRIC);
    lw.fill(3, y0 + 8, 19, 7, y0 + 13, 20, B.FABRIC);
    lw.fill(9, y0 + 8, 19, 13, y0 + 13, 20, B.FABRIC);
    lw.fill(3, y0 + 8, 23, 13, y0 + 10, 27, B.FABRIC);
    lw.fill(3, y0 + 8, 27, 13, y0 + 13, 28, B.FABRIC);
    glass.forEach((g, i) => {
      if (panes[i]) lw.fill(g[0], y0 + 9, g[1], g[2], y0 + 13, g[3], B.GLASS);
    });
    // Wheels (discs of radius 3 in the u = const planes); one is gone, its corner rests on bricks.
    const wheels: [number, number][] = [
      [0, 7],
      [14, 7],
      [0, 32],
      [14, 32],
    ];
    wheels.forEach(([u, vc], i) => {
      if (i === missing) {
        lw.fill(u === 0 ? 2 : 11, y0, vc - 2, u === 0 ? 5 : 14, y0 + 2, vc + 2, B.BRICK);
        return;
      }
      for (let dv = -3; dv <= 3; dv++) {
        for (let dy = -3; dy <= 3; dy++) {
          if (dv * dv + dy * dy > 10) continue;
          lw.fill(u, y0 + 3 + dy, vc + dv, u + 2, y0 + 4 + dy, vc + dv + 1, B.RUBBER);
        }
      }
    });
  };
  const r = f.rect;
  return { kind: 'prop:car', min: [r.x0, y0, r.z0], max: [r.x1, y0 + 16, r.z1], order: ORDER.PROP, stamp };
}

/**
 * Wooden picket fence along the street edge of a lot: `f` spans the fence line (u along it, v = 0 on
 * the street side). Posts every 2–2.5 m, pickets with gaps, two rails on the yard side; `gates` are
 * u-ranges left open; some sections have fallen flat into the yard, some pickets are missing.
 */
export function picketFence(f: Frame, gates: readonly [number, number][], rng: Rng): Feature {
  const len = f.W;
  const paint = rng.pick([B.PAINTED_WOOD, B.PLANKS, B.PLANKS, B.DARK_WOOD]);
  const inGate = (u: number) => gates.some(([a, b]) => u >= a && u < b);
  return boxFeature('prop:fence', f, (L) => {
    const y = GROUND_Y;
    // Post positions: regular spacing plus both sides of every gate.
    const posts = new Set<number>();
    for (let u = 0; u + 2 <= len; u += rng.int(20, 26)) posts.add(u);
    posts.add(len - 2);
    for (const [a, b] of gates) {
      posts.add(a - 2);
      posts.add(b);
    }
    const sorted = [...posts].filter((u) => u >= 0 && u + 2 <= len && !inGate(u) && !inGate(u + 1)).sort((a, b) => a - b);
    for (const u of sorted) L.add(u, GROUND_TOP - 1, 0, u + 2, y + 13, 2, B.DARK_WOOD);
    for (let i = 0; i + 1 < sorted.length; i++) {
      const s0 = sorted[i] + 2;
      const s1 = sorted[i + 1];
      if (s1 <= s0 || inGate(s0)) continue;
      const fallen = rng.chance(0.18);
      const sparse = rng.chance(0.35);
      if (fallen) {
        // The section lies flat in the yard: pickets point away from the line, rails across them.
        for (let u = s0; u < s1; u += 2) if (!sparse || rng.chance(0.7)) L.add(u, y, 2, u + 1, y + 1, 12, paint);
        L.add(s0, y, 4, s1, y + 1, 5, paint);
        L.add(s0, y, 9, s1, y + 1, 10, paint);
        continue;
      }
      L.add(s0, y + 3, 1, s1, y + 4, 2, paint);
      L.add(s0, y + 9, 1, s1, y + 10, 2, paint);
      for (let u = s0; u < s1; u += 2) {
        if (sparse && rng.chance(0.3)) continue;
        L.add(u, y + 1, 0, u + 1, y + 11 + (u & 2 ? 0 : 1), 1, paint);
      }
    }
  });
}

/** Mound of rubble and bricks with a few boards and weeds on top. */
export function rubblePile(cx: number, cz: number, r: number, h: number, seed: number): Feature {
  const stamp = (w: VoxelWriter) => {
    for (let z = cz - r - 1; z <= cz + r + 1; z++) {
      for (let x = cx - r - 1; x <= cx + r + 1; x++) {
        const hh = moundHeight(x - cx, z - cz, r, h, seed);
        if (hh <= 0) continue;
        for (let y = GROUND_Y; y < GROUND_Y + hh; y++) {
          const k = hash3(x, y, z, seed) & 15;
          w.set(x, y, z, k < 3 ? B.BRICK : k === 3 ? B.CONCRETE : k === 4 ? B.PLANKS : B.RUBBLE);
        }
        if (rnd2(x, z, seed) < 0.18) w.setSoft(x, GROUND_Y + hh, z, B.DRY_GRASS);
      }
    }
  };
  return { kind: 'prop:rubble', min: [cx - r - 1, GROUND_Y, cz - r - 1], max: [cx + r + 2, GROUND_Y + h + 2, cz + r + 2], order: ORDER.PROP, stamp };
}

/** World rect of a feature's footprint (for keep-out bookkeeping). */
export const featureRect = (ft: Feature): Rect => ({ x0: ft.min[0], z0: ft.min[2], x1: ft.max[0], z1: ft.max[2] });
