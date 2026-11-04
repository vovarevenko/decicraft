/**
 * Hand tools and hand lights at 1 cm per voxel, in real sizes: stone axe, carpenter's axe, Russian
 * bayonet shovel, pickaxe, flashlight and torch. Each points up (+Y) with the grip — where the hand
 * holds it — at the origin; blades and picks face +X. Shapes are centred on the cell column
 * x = z = C (a cell centre) so that odd thicknesses (a 1 cm edge, a 3 cm haft) stay symmetric; the
 * builds put that column on the geometry origin. Shape functions get cell centres, colour functions
 * integer cells — so in a colour function `x` is directly the offset of the cell from the axis.
 */
import type * as THREE from 'three';
import { fbm3, grain, hash01, rust, vary } from './palette';
import { Sculpt } from './sculpt';

/** Model-space coordinate of the handle axis (a cell centre). */
const C = 0.5;
const AXIS: readonly [number, number, number] = [C, 0, C];

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Handle of oval cross-section (half-widths rx, rz) along y ∈ [y0, y1), swelling below `swellBelow`. */
function handle(
  s: Sculpt,
  y0: number,
  y1: number,
  rx: number,
  rz: number,
  swellBelow: number,
  color: (x: number, y: number, z: number) => number,
): void {
  const r = Math.ceil(Math.max(rx, rz) + 3);
  s.sdf(
    (x, y, z) => {
      const swell = y < swellBelow ? (swellBelow - y) * 0.3 : 0;
      return Math.hypot((x - C) / (rx + swell), (z - C) / (rz + swell * 0.6)) - 1;
    },
    color,
    [-r, y0, -r, r + 1, y1, r + 1],
  );
}

/** Каменный топор: 45 cm peeled haft, knapped stone head lashed with grass rope. */
export function buildStoneAxe(): THREE.BufferGeometry {
  const s = new Sculpt(-8, -8, -4, 15, 41, 5);
  const wood = grain(0xae8a5c, 'y', { amount: 0.1, streak: 6, seed: 3 });
  const bark = vary(0x5b4936, 0.1, 4);
  const crook = (y: number): number => 0.5 * Math.sin((y + 7) * 0.06);
  s.sdf(
    (x, y, z) => Math.hypot(x - C - crook(y), z - C) - (y < -5 ? 1.75 : 1.55),
    (x, y, z) => (fbm3(x, y, z, 4, 11) > 0.6 ? bark(x, y, z) : wood(x, y, z)),
    [-3, -7, -2, 4, 39, 3],
  );

  // Knapped flint: flares into the blade and thins to a ground edge; facets are coherent patches.
  s.sdf(
    (x, y, z) => {
      const hx = x - C;
      const t = clamp01((hx + 5) / 17);
      const halfH = 3.8 + 2.2 * t;
      const halfT = 2.2 - 1.6 * t;
      const ex = (hx - 3.5) / 8.5;
      const hy = (y - 32) / halfH;
      return Math.max(ex * ex + hy * hy - 1, Math.abs(z - C) - halfT);
    },
    (x, y, z) => {
      if (x > 9.6) return 0xbab5a9;
      const n = fbm3(x, y, z, 3, 17);
      return n < 0.4 ? 0x67645e : n > 0.62 ? 0x9c988f : 0x86837b;
    },
    [-6, 25, -2, 13, 39, 3],
  );

  // Lashing: a band below and above the head and an X over both faces of the stone next to the haft.
  const rope = (x: number, y: number, z: number): number => ((x + y + z) & 1 ? 0x9e8456 : 0xb79d6a);
  s.capsule([C, 25.5, C], [C, 27.5, C], 2.2, 2.2, rope, true);
  s.capsule([C, 36.5, C], [C, 38.5, C], 2.1, 2.1, rope, true);
  for (const side of [-1, 1]) {
    const zc = C + side * 2.3;
    s.capsule([C - 2, 27, zc], [C + 2.2, 37, zc], 0.55, 0.55, rope);
    s.capsule([C + 2.2, 27, zc], [C - 2, 37, zc], 0.55, 0.55, rope);
  }
  return s.build(0.04, AXIS);
}

/** Топор: carpenter's axe — 60 cm birch handle, forged head with a flat poll and a bearded blade. */
export function buildAxe(): THREE.BufferGeometry {
  const s = new Sculpt(-7, -11, -3, 16, 53, 4);
  const birch = grain(0xc9a06a, 'y', { amount: 0.07, streak: 10, seed: 21 });
  const grimy = grain(0xa58055, 'y', { amount: 0.08, streak: 8, seed: 22 });
  handle(s, -10, 52, 1.9, 1.45, -6, (x, y, z) => (y < 10 ? grimy(x, y, z) : birch(x, y, z)));

  const steel = rust(vary(0x4f5559, 0.05, 5), 0.1, 31, 3);
  const edgeX = (y: number): number => 14.2 - 1.6 * ((y - 43) / 7.5) ** 2;
  const bottom = (hx: number): number => (hx < 2.5 ? 42.5 : 42.5 - (hx - 2.5) * 0.72);
  s.sdf(
    (x, y, z) => {
      const hx = x - C;
      if (y > 50.5 || y < bottom(hx) || hx < -4.5 || hx > edgeX(y)) return 1;
      const halfT = hx < 2.5 ? 2 : Math.max(0.5, 2 - (hx - 2.5) * 0.15);
      return Math.abs(z - C) - halfT;
    },
    (x, y, z) => {
      if (x > edgeX(y + 0.5) - 1.8) return 0xb4b9bc; // honed bevel
      if (x < -3.5) return 0x6f7375; // battered poll
      return steel(x, y, z);
    },
    [-6, 34, -3, 16, 51, 4],
  );
  // Wedge driven into the handle top.
  s.box(-1, 51, 0, 2, 52, 1, 0x3b332c);
  return s.build(0.03, AXIS);
}

/** Лопата штыковая: 120 cm pine handle, steel socket, pointed scoop blade 20 × 28 cm with foot steps. */
export function buildShovel(): THREE.BufferGeometry {
  const s = new Sculpt(-11, -106, -5, 12, 47, 5);
  const pine = grain(0xd2b483, 'y', { amount: 0.06, streak: 14, seed: 41 });
  const handled = grain(0xae8e62, 'y', { amount: 0.07, streak: 10, seed: 42 });
  s.capsule(
    [C, -105, C],
    [C, 14, C],
    1.95,
    1.95,
    (x, y, z) => (y === -105 ? 0xc29f6c : y > -14 && y < 8 ? handled(x, y, z) : pine(x, y, z)),
    true,
  );

  // Socket (тулейка) with a nail.
  s.capsule([C, 5, C], [C, 19, C], 2.25, 2.9, rust(0x3d4144, 0.18, 51, 2.5), true);
  s.set(0, 10, 3, 0x9a9ea0);

  // Blade: edges forward (+Z), centre 1.6 cm back; elliptical point; worn bright rim around the point.
  const blade = rust(vary(0x4b5055, 0.04, 6), 0.28, 61, 3.5);
  const halfW = (y: number): number => (y < 32 ? 10 : 10 * Math.sqrt(Math.max(0, 1 - ((y - 32) / 14) ** 2)));
  const curve = (xx: number): number => -1.6 * (1 - (xx / 10) ** 2);
  s.sdf(
    (x, y, z) => {
      const xx = x - C;
      if (y < 18 || y > 46 || Math.abs(xx) > halfW(y) + 0.5) return 1;
      const slope = 0.032 * xx;
      return Math.abs(z - C - curve(xx)) / Math.sqrt(1 + slope * slope) - 0.51;
    },
    (x, y, z) => (y > 33 && halfW(y + 0.5) - Math.abs(x) < 1.6 ? 0xa4a9ac : blade(x, y, z)),
    [-11, 18, -4, 12, 47, 3],
  );
  // Foot steps (наступ): the shoulders bent back 3 cm.
  s.sdf(
    (x, y, z) => {
      const xx = Math.abs(x - C);
      if (y > 19 || xx < 3 || xx > 10.5) return 1;
      const zc = curve(xx);
      return z - C < zc - 3.2 || z - C > zc + 0.5 ? 1 : -1;
    },
    blade,
    [-11, 18, -5, 12, 19, 2],
  );
  // Stiffening rib down the back of the blade.
  s.capsule([C, 17, C - 2.6], [C, 30, C - 2.0], 1, 0.7, blade);
  return s.build(0.03, AXIS);
}

/** Кирка: 80 cm ash handle; head with a pick (−X) and a chisel (+X), arms drooping slightly. */
export function buildPickaxe(): THREE.BufferGeometry {
  const s = new Sculpt(-24, -9, -3, 25, 72, 4);
  const ash = grain(0xb98f5a, 'y', { amount: 0.08, streak: 9, seed: 71 });
  const grimy = grain(0x987246, 'y', { amount: 0.08, streak: 7, seed: 72 });
  handle(s, -8, 71, 2.1, 1.7, -5, (x, y, z) => (y < 10 ? grimy(x, y, z) : ash(x, y, z)));

  const steel = rust(vary(0x3f4244, 0.05, 8), 0.22, 81, 3);
  const yc = (xx: number): number => 65.5 - 0.007 * xx * xx;
  s.sdf(
    (x, y, z) => {
      const xx = x - C;
      const ax = Math.abs(xx);
      if (ax > 22.5) return 1;
      const t = ax / 22;
      let halfY: number;
      let halfZ: number;
      if (ax < 3) {
        halfY = 4.2;
        halfZ = 2.4;
      } else if (xx < 0) {
        halfY = 2.4 * (1 - t) + 0.6;
        halfZ = 1.9 * (1 - t) + 0.6;
      } else {
        halfY = 2.4 + 0.3 * t;
        halfZ = 1.9 * (1 - t) + 0.55;
      }
      return Math.max(Math.abs(y - yc(xx)) - halfY, Math.abs(z - C) - halfZ);
    },
    (x, y, z) => (Math.abs(x) > 19 ? 0x9da1a3 : steel(x, y, z)),
    [-24, 58, -3, 25, 71, 4],
  );
  return s.build(0.03, AXIS);
}

/** Фонарик: 21 cm — black body with knurled rings, chrome reflector head and bezel, lens on top (+Y). */
export function buildFlashlight(): THREE.BufferGeometry {
  const s = new Sculpt(-3, -11, -3, 4, 12, 4);
  s.capsule([C, -10, C], [C, 5, C], 1.8, 1.8, (x, y) => (y >= -8 && y <= -1 && (y & 1) === 0 ? 0x222428 : 0x2e3135), true);
  s.capsule([C, -11, C], [C, -9, C], 1.95, 1.95, 0x1d1f22, true);
  s.sdf(
    (x, y, z) => {
      if (y < 5 || y > 12) return 1;
      const r = y < 8 ? 1.8 + (y - 5) * 0.28 : 2.65;
      return Math.hypot(x - C, z - C) - r;
    },
    (x, y, z) => {
      if (y >= 11 && Math.hypot(x, z) < 1.95) return 0xfff3cf; // lens
      return y >= 10 ? 0xbfc5ca : y >= 8 ? 0x8b9196 : 0x2e3135;
    },
    [-3, 5, -3, 4, 12, 4],
  );
  s.box(0, 0, 2, 1, 3, 3, 0xa3362a); // slide switch
  return s.build(0.02, AXIS);
}

/** Факел: 50 cm stick with tarred rags wrapped round the top, charred, embers glowing on top. */
export function buildTorch(): THREE.BufferGeometry {
  const s = new Sculpt(-4, -16, -4, 5, 39, 5);
  const wood = grain(0x7a6048, 'y', { amount: 0.1, streak: 7, seed: 91 });
  s.capsule([C, -15, C], [C, 30, C], 1.5, 1.4, wood, true);

  const embers = [0xff8a24, 0xffc04d, 0xd84a1a, 0xff6a1a] as const;
  s.sdf(
    (x, y, z) => {
      if (y < 24 || y > 38) return 1;
      const t = (y - 24) / 14;
      const r = 2.1 + 1.2 * Math.sin(Math.PI * Math.min(1, t * 1.1));
      return Math.hypot(x - C, z - C) - r;
    },
    (x, y, z) => {
      const a = Math.atan2(z, x);
      const strip = Math.floor(y * 0.5 + a * 1.3) & 1;
      if (y >= 34) {
        const h = hash01(x, y, z, 93);
        return h < 0.5 ? embers[Math.floor(h * 8) & 3] : 0x241c17;
      }
      if (y >= 31) return hash01(x, y, z, 94) < 0.18 ? embers[0] : strip ? 0x2b221b : 0x3a2c22;
      return strip ? 0x4a3524 : 0x5c4330;
    },
    [-4, 24, -4, 5, 39, 5],
  );
  return s.build(0.03, AXIS);
}

/** Item ids of this family → builders. */
export const TOOL_MODELS: Readonly<Record<string, () => THREE.BufferGeometry>> = {
  stone_axe: buildStoneAxe,
  axe: buildAxe,
  shovel: buildShovel,
  pickaxe: buildPickaxe,
  flashlight: buildFlashlight,
  torch: buildTorch,
};
