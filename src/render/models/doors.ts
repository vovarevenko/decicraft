/**
 * Door leaves at 1 cm per voxel for a doorway of widthVox × heightVox world voxels (10 cm each). Origin
 * at the hinge edge, bottom, centre of the 4 cm thickness: the leaf fills x ∈ [0, width) × y ∈ [0,
 * height) exactly (hinges and fittings stay inside that outline) and handles stick out of both faces
 * (±Z) at ~1 m near the free edge. Styles: weathered plank door with ledges and a brace on the back and
 * black strap hinges ('wood'); panelled door with peeling paint ('wood_painted'); rusty painted steel
 * door with a raised rim and ribs ('metal'). Large flat areas use coherent colour patterns and no
 * per-cell jitter so that they merge into few quads.
 */
import type * as THREE from 'three';
import type { DoorStyle } from '../../gen/types';
import { EMPTY } from '../voxelModel';
import { fbm3, grain, hash01, peel, rust, shade, type ColorFn } from './palette';
import { Sculpt } from './sculpt';

const IRON = 0x2a2a2c;
/** Darker, browner rust than the default palette: old paint on a door rusts in dull patches. */
const DOOR_RUST = [0x5e3422, 0x6e3e26, 0x46281a] as const;

export function buildDoor(widthVox: number, heightVox: number, style: DoorStyle): THREE.BufferGeometry {
  const w = Math.max(3, Math.round(widthVox * 10));
  const h = Math.max(10, Math.round(heightVox * 10));
  const s = new Sculpt(0, 0, -6, w, h, 6);
  const hx = w - Math.min(9, Math.round(w * 0.12) + 1);
  const hy = Math.min(100, Math.round(h * 0.5));
  if (style === 'wood') plankDoor(s, w, h, hx, hy);
  else if (style === 'wood_painted') panelDoor(s, w, h, hx, hy);
  else metalDoor(s, w, h, hx, hy);
  return s.build(0, [0, 0, 0]);
}

/** Vertical boards with grooved joints, ledges and a brace on the back, strap hinges, D-pull handles. */
function plankDoor(s: Sculpt, w: number, h: number, hx: number, hy: number): void {
  const n = Math.max(1, Math.round(w / 15));
  const edges: number[] = [];
  for (let i = 0; i <= n; i++) edges.push(Math.round((i * w) / n));
  const boards: ColorFn[] = [];
  for (let b = 0; b < n; b++) {
    boards.push(grain(shade(0x7a6650, 0.88 + hash01(b, 0, 0, 501) * 0.24), 'y', { amount: 0.08, streak: 40, width: 2, knots: 0.002, seed: 502 + b }));
  }
  const boardOf = (x: number): number => {
    let b = 0;
    while (b < n - 1 && x >= edges[b + 1]) b++;
    return b;
  };
  s.box(0, 0, -2, w, h, 2, (x, y, z) => {
    const b = boardOf(x);
    if (b > 0 && x === edges[b]) return 0x3b3127;
    const c = boards[b](x, y, z);
    return y < 24 ? shade(c, y < 8 ? 0.8 : y < 16 ? 0.87 : 0.94) : c; // damp, darker foot
  });
  for (let b = 1; b < n; b++) {
    s.box(edges[b], 0, -2, edges[b] + 1, h, -1, EMPTY);
    s.box(edges[b], 0, 1, edges[b] + 1, h, 2, EMPTY);
  }

  // Ledges and the brace (from the low hinge side up to the high latch side) on the back face.
  const ledge = grain(0x6e5c48, 'x', { amount: 0.06, streak: 30, width: 3, seed: 510 });
  const l0 = Math.round(h * 0.14);
  const l1 = Math.round(h * 0.8);
  const inset = Math.min(3, Math.floor(w / 6));
  s.box(inset, l0, -4, w - inset, l0 + 12, -2, ledge);
  s.box(inset, l1, -4, w - inset, l1 + 12, -2, ledge);
  const ax = inset + 4;
  const ay = l0 + 12;
  const bx = w - inset - 4;
  const by = l1;
  const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
  s.sdf(
    (x, y) => {
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
      return Math.hypot(x - ax - (bx - ax) * t, y - ay - (by - ay) * t) - 5.5;
    },
    0x675643,
    [inset, l0, -4, w - inset, l1 + 12, -2],
  );

  // Strap hinges on the front face, bolted through the ledges.
  const strap = Math.max(2, Math.round(w * 0.5));
  for (const y0 of [l0 + 4, l1 + 4]) {
    s.box(0, y0, 2, strap, y0 + 4, 3, IRON);
    s.ellipsoid(strap, y0 + 2, 2.5, 3, 3, 0.5, IRON);
  }
  // D-pull handles on both faces.
  for (const side of [1, -1]) {
    const z0 = side > 0 ? 2 : -5;
    const z1 = side > 0 ? 5 : -2;
    s.box(hx, hy - 7, z0, hx + 1, hy - 5, z1, IRON);
    s.box(hx, hy + 5, z0, hx + 1, hy + 7, z1, IRON);
    s.box(hx, hy - 7, side > 0 ? 4 : -5, hx + 1, hy + 7, side > 0 ? 5 : -4, IRON);
  }
}

/** Frame-and-panel door, recessed panels, old off-white paint peeling to blue and bare wood, lever handles. */
function panelDoor(s: Sculpt, w: number, h: number, hx: number, hy: number): void {
  const stile = Math.min(12, Math.max(2, Math.round(w * 0.13)));
  const rail = Math.min(12, Math.max(2, Math.round(h * 0.06)));
  const mid0 = Math.round(h * 0.45);
  const mid1 = mid0 + rail;
  const inPanel = (x: number, y: number): boolean =>
    x >= stile && x < w - stile && ((y >= rail && y < mid0) || (y >= mid1 && y < h - rail));
  const under: ColorFn = (x, y, z) => (fbm3(x, y, z, 4, 521) < 0.32 ? 0x86786a : 0x8fa7b3);
  const coat = peel(0xd8d4c8, under, 0.3, 522, 10);
  s.box(0, 0, -2, w, h, 2, (x, y, z) => {
    let c = coat(x, y, z);
    if (!inPanel(x, y) && (inPanel(x - 1, y) || inPanel(x + 1, y) || inPanel(x, y - 1) || inPanel(x, y + 1))) c = shade(c, 0.86);
    if (y < 18) c = shade(c, 0.86); // scuffed kick zone
    else if (Math.abs(x - hx) < 7 && Math.abs(y - hy) < 14) c = shade(c, 0.9); // grime round the handle
    return c;
  });
  // Recess the panels by 1 cm on both faces.
  s.sdf((x, y, z) => (Math.abs(z) > 1 && inPanel(Math.floor(x), Math.floor(y)) ? -1 : 1), EMPTY, [0, 0, -2, w, h, 2]);
  // Butt hinges on the hinge edge.
  for (const y0 of [20, h - 30]) s.box(0, y0, -2, 1, y0 + 10, 2, 0x6e6450);
  // Escutcheon with keyhole and a lever pointing to the hinge side, on both faces.
  const alu = 0xa3a7a9;
  for (const side of [1, -1]) {
    const zp = side > 0 ? 2 : -3;
    s.box(hx - 2, hy - 14, zp, hx + 2, hy + 6, zp + 1, alu);
    s.box(hx, hy - 11, zp, hx + 1, hy - 8, zp + 1, 0x262626);
    const zl = side > 0 ? 3 : -4;
    s.box(hx - 1, hy, zl, hx + 1, hy + 2, zl + 1, alu);
    s.box(Math.max(0, hx - 12), hy, side > 0 ? 4 : -5, hx + 1, hy + 2, side > 0 ? 5 : -4, alu);
  }
}

/** Painted steel sheet with a raised rim and ribs, rivets, rust blotches and streaks; angle-iron frame on the back. */
function metalDoor(s: Sculpt, w: number, h: number, hx: number, hy: number): void {
  const rim = Math.min(5, Math.max(1, Math.floor(w / 8)));
  const ribs = [Math.round(h / 3), Math.round((2 * h) / 3)];
  const blotchy = rust(0x4a5c4d, 0.3, 532, 10, DOOR_RUST, 0.003);
  // Rust runs down from the top rim and from each rib in some columns.
  const sources = [h - rim, ...ribs.map((r) => r - 2)];
  const streak = (x: number, y: number): boolean => {
    if (hash01(x, 0, 0, 533) > 0.12) return false;
    for (const e of sources) if (y < e && y >= e - 8 - hash01(x, e, 0, 534) * 30) return true;
    return false;
  };
  s.box(0, 0, -2, w, h, 2, (x, y, z) => (streak(x, y) && Math.abs(z + 0.5) > 1 ? 0x6a3c26 : blotchy(x, y, z)));

  // Raised rim and ribs on the front, rivets along the rim.
  const onRim = (x: number, y: number): boolean => x < rim || x >= w - rim || y < rim || y >= h - rim;
  s.sdf(
    (x, y) => {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      return onRim(cx, cy) || ribs.some((r) => cy >= r - 2 && cy < r + 2) ? -1 : 1;
    },
    blotchy,
    [0, 0, 2, w, h, 3],
  );
  const mid = Math.floor(rim / 2);
  for (let y = 8; y < h - 4; y += 15) {
    s.set(mid, y, 3, 0x5e6e5e);
    s.set(w - 1 - mid, y, 3, 0x5e6e5e);
  }
  for (let x = 8; x < w - 4; x += 15) {
    s.set(x, mid, 3, 0x5e6e5e);
    s.set(x, h - 1 - mid, 3, 0x5e6e5e);
  }

  // Angle-iron frame and a diagonal on the back.
  const frame = rust(0x3e4a40, 0.3, 535, 5, DOOR_RUST, 0.004);
  const band = Math.min(4, Math.max(1, Math.floor(w / 10)));
  s.sdf(
    (x, y) => {
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      if (cx < band || cx >= w - band || cy < band || cy >= h - band) return -1;
      const t = cy / h;
      return Math.abs(cx - (band + t * (w - 2 * band))) - band / 2;
    },
    frame,
    [0, 0, -4, w, h, -2],
  );

  // Lever handle with a round rose on both faces.
  const steel = 0x2e3032;
  for (const side of [1, -1]) {
    const zr = side > 0 ? 2 : -3; // the layer against the face
    s.ellipsoid(hx + 0.5, hy + 0.5, zr + 0.5, 2.6, 2.6, 0.5, steel);
    s.box(hx, hy, zr + side, hx + 1, hy + 1, zr + side + 1, steel);
    s.box(Math.max(0, hx - 11), hy, zr + 2 * side, hx + 1, hy + 2, zr + 2 * side + 1, steel);
  }
}
