/**
 * Small items at 1 cm per voxel, in real sizes: stick, rope coil, cloth, roe deer hide, grass bundle,
 * flower, reed bundle, mushroom, apple, can of stew, raw and cooked meat, folded newspaper. Origin at
 * the bottom centre; long items stand upright (+Y). Odd-width shapes are centred on the cell column
 * x = z = C, even-width ones on x = z = 0; colour functions get integer cells.
 */
import type * as THREE from 'three';
import { fbm3, grain, hash01, mix, noise3, speckle } from './palette';
import { Sculpt } from './sculpt';

const C = 0.5;
const CENTRE: readonly [number, number, number] = [C, 0, C];

/** Smooth minimum (union with a fillet of radius k) of two distances. */
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Distance from point (px, pz) to segment (ax, az)–(bx, bz) minus a radius tapering ra → rb. */
function segment2(px: number, pz: number, ax: number, az: number, bx: number, bz: number, ra: number, rb: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - ax - dx * t, pz - az - dz * t) - (ra + (rb - ra) * t);
}

/** Палка: a 45 cm branch, Ø 3 cm, grey-brown bark, two side-shoot stubs, light cut ends. */
export function buildStick(): THREE.BufferGeometry {
  const s = new Sculpt(-3, 0, -3, 6, 46, 5);
  const bark = grain(0x675544, 'y', { amount: 0.1, streak: 4, knots: 0.02, seed: 101 });
  const cut = 0xcaa977;
  s.capsule([C, 0, C], [C, 45, C], 1.55, 1.35, (x, y, z) => (y === 0 || y === 44 ? cut : bark(x, y, z)), true);
  s.capsule([C, 15, C], [C + 3.6, 19.5, C + 0.4], 0.75, 0.6, bark);
  s.set(4, 19, 0, cut);
  s.capsule([C, 31, C], [C - 0.4, 34, C - 3], 0.7, 0.6, bark);
  s.set(0, 33, -3, cut);
  return s.build(0.04, CENTRE);
}

/** Верёвка: a coil of twisted grass rope (Ø 19 cm) with a binding and a loose end. */
export function buildRope(): THREE.BufferGeometry {
  const s = new Sculpt(-10, 0, -10, 14, 5, 13);
  const light = 0xbba26b;
  const mid = 0xa48b5a;
  const groove = 0x7d6843;
  const R = 7.2;
  s.sdf(
    (x, y, z) => {
      const q = Math.hypot(x - C, z - C) - R;
      return Math.hypot(q / 2.5, (y - 2.2) / 2) - 1;
    },
    (x, y, z) => {
      const a = Math.atan2(z, x);
      if (a > 0.35 && a < 0.8) return y & 1 ? groove : 0x8f7a50; // binding turns
      const q = (Math.hypot(x, z) - R) / 1.65 + 0.5;
      if (Math.abs(q - Math.round(q)) < 0.12) return groove; // gaps between the turns
      return Math.floor(a * 6 + y * 0.9 + Math.round(q) * 0.7) & 1 ? light : mid; // twisted strands
    },
    [-10, 0, -10, 11, 5, 11],
  );
  s.capsule([C + 8.5, 1.5, C + 2], [C + 12.5, 0.8, C + 10.5], 0.85, 0.8, (x, y, z) => ((x + z) & 1 ? light : mid));
  return s.build(0.03, CENTRE);
}

/** Тряпка: a folded rag of faded red checked flannel, layers visible at the edges, a corner turned up. */
export function buildCloth(): THREE.BufferGeometry {
  const s = new Sculpt(-12, 0, -9, 12, 4, 9);
  const plaid = (x: number, y: number, z: number): number => {
    const sx = (x + 40) % 6 < 2;
    const sz = (z + 40) % 6 < 2;
    if ((x + 40) % 12 === 4 || (z + 40) % 12 === 4) return 0xc29a76; // thin light thread
    return sx && sz ? 0x5a2f2a : sx || sz ? 0x7d4239 : 0x9b5a4a;
  };
  const back = 0xb07c68; // the paler reverse side of the fabric
  s.box(-11, 0, -8, 11, 1, 8, plaid);
  s.box(-11, 1, -8, 11, 2, 7, (x, y, z) => (z >= 6 ? back : plaid(x, y, z)));
  s.box(-10, 2, -7, 11, 3, 8, plaid);
  // Dog-eared corner, showing the reverse side.
  s.sdf((x, y, z) => (y < 3 || y > 4 ? 1 : x - z - 13), back, [4, 3, -7, 11, 4, 1]);
  return s.build(0.03, [0, 0, 0]);
}

/** Шкура: a stretched roe deer hide (62 × 46 cm): fur on top, darker along the spine, pale leather below. */
export function buildHide(): THREE.BufferGeometry {
  const s = new Sculpt(-32, 0, -24, 32, 3, 25);
  const outline = (x: number, z: number): number => {
    let d = Math.hypot(x / 22, z / 16.5) * 16.5 - 16.5;
    for (const sx of [-1, 1]) {
      d = smin(d, segment2(x, z, sx * 13, 9, sx * 29, 21, 4.2, 2), 4);
      d = smin(d, segment2(x, z, sx * 13, -9, sx * 30, -21, 4.6, 2.2), 4);
    }
    d = smin(d, segment2(x, z, 0, 14, 0, 23, 6, 3.6), 4); // neck
    d = smin(d, segment2(x, z, 0, -15, 0, -21, 2.5, 1.5), 2); // tail
    return d + (noise3(x, 0, z, 3, 111) - 0.5) * 1.6;
  };
  // Coherent tones (noise, not per-cell), so the large flat pelt merges into few faces.
  const tone = (light: number, dark: number, seed: number) => (x: number, y: number, z: number): number =>
    noise3(x, y, z, 3, seed) < 0.42 ? dark : light;
  const fur = tone(0x9a5a32, 0x8c512c, 112);
  const spine = tone(0x77452a, 0x6e3e22, 113);
  const pale = tone(0xc9a47a, 0xbf9970, 114);
  const leather = tone(0xd8c3a0, 0xcdb592, 115);
  s.sdf(
    (x, y, z) => {
      const d = outline(x, z);
      if (d > 0) return 1;
      const lift = noise3(x, 0, z, 9, 116) > 0.62 ? 1 : 0; // a gentle crumple
      return y >= lift && y < lift + 2 ? -1 : 1;
    },
    (x, y, z) => {
      const lift = noise3(x + 0.5, 0, z + 0.5, 9, 116) > 0.62 ? 1 : 0;
      if (y === lift) return leather(x, y, z);
      const d = outline(x + 0.5, z + 0.5);
      if (d > -2.5) return pale(x, y, z);
      return Math.abs(x + 0.5) < 3.2 && z > -16 ? spine(x, y, z) : fur(x, y, z);
    },
    [-32, 0, -24, 32, 3, 25],
  );
  return s.build(0, [0, 0, 0]);
}

/** Трава: a 30 cm sheaf of grass stalks tied in the middle, seed heads at the top. */
export function buildGrassFiber(): THREE.BufferGeometry {
  const s = new Sculpt(-6, 0, -6, 7, 32, 7);
  const greens = [0x7a9a42, 0x8fa64e, 0x6b8a3a, 0xa8a85a, 0x86a046] as const;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + hash01(i, 0, 0, 121) * 0.4;
    const rb = 1.6 + hash01(i, 1, 0, 121) * 1.4;
    const rt = 3.2 + hash01(i, 2, 0, 121) * 2.2;
    const top = 26 + hash01(i, 3, 0, 121) * 5;
    const tie: [number, number, number] = [C + Math.cos(a) * 0.9, 12, C + Math.sin(a) * 0.9];
    const col = greens[i % greens.length];
    s.capsule([C + Math.cos(a) * rb, 0, C + Math.sin(a) * rb], tie, 0.55, 0.55, col);
    const end: [number, number, number] = [C + Math.cos(a + 0.3) * rt, top, C + Math.sin(a + 0.3) * rt];
    s.capsule(tie, end, 0.55, 0.5, col);
    if (i % 2 === 0) s.capsule([end[0], end[1] - 3, end[2]], end, 0.7, 0.6, i % 4 === 0 ? 0xb39a5c : 0x9c8a50);
  }
  s.capsule([C, 11, C], [C, 13.5, C], 1.9, 1.9, (x, y, z) => ((x + y + z) & 1 ? 0x5d6b33 : 0x6c7a3c), true);
  return s.build(0.03, CENTRE);
}

/** Цветок: a chamomile — 25 cm stem with two leaves, white petals around a raised yellow disc. */
export function buildFlower(): THREE.BufferGeometry {
  const s = new Sculpt(-6, 0, -6, 7, 30, 7);
  const stem = 0x5b8a33;
  s.capsule([C, 0, C], [C + 0.6, 12, C + 0.3], 0.55, 0.55, stem);
  s.capsule([C + 0.6, 12, C + 0.3], [C + 1.4, 23.5, C + 1.2], 0.55, 0.55, stem);
  s.capsule([C + 0.4, 7, C], [C - 3.5, 11, C - 1], 0.6, 0.45, 0x4f7d2c);
  s.capsule([C + 0.9, 15, C + 0.6], [C + 4.5, 18.5, C - 0.5], 0.6, 0.45, 0x4f7d2c);
  // Head: a disc tilted towards the viewer (+X+Z) by ~35°.
  const hc = [C + 1.6, 25, C + 1.4] as const;
  const n = [0.4, 0.82, 0.4] as const; // head normal (unit)
  s.sdf(
    (x, y, z) => {
      const dx = x - hc[0];
      const dy = y - hc[1];
      const dz = z - hc[2];
      const h = dx * n[0] + dy * n[1] + dz * n[2];
      const r = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - h * h));
      if (r < 1.6) return Math.abs(h - 0.7) - 0.75; // the raised disc
      return Math.max(Math.abs(h) - 0.55, r - 3.9);
    },
    (x, y, z) => {
      const dx = x + 0.5 - hc[0];
      const dy = y + 0.5 - hc[1];
      const dz = z + 0.5 - hc[2];
      const h = dx * n[0] + dy * n[1] + dz * n[2];
      const r = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - h * h));
      if (r < 1.6) return (x + y + z) & 1 ? 0xe8b828 : 0xd9a21e;
      return r > 3.1 && hash01(x, y, z, 131) < 0.3 ? 0xe2ded2 : 0xf4f2ea;
    },
    [-5, 20, -5, 7, 30, 7],
  );
  return s.build(0.02, CENTRE);
}

/** Камыш: a 72 cm bundle of reed stems tied together, two brown cattail heads, a few long leaves. */
export function buildReed(): THREE.BufferGeometry {
  const s = new Sculpt(-7, 0, -7, 8, 76, 8);
  const greens = [0x7c8a46, 0x8e9a52, 0x6f7d3c] as const;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const rt = 2 + hash01(i, 0, 0, 141) * 2.5;
    const top = 58 + hash01(i, 1, 0, 141) * 10;
    const mid: [number, number, number] = [C + Math.cos(a) * 0.8, 20, C + Math.sin(a) * 0.8];
    const end: [number, number, number] = [C + Math.cos(a) * rt, top, C + Math.sin(a) * rt];
    s.capsule([C + Math.cos(a) * 1.6, 0, C + Math.sin(a) * 1.6], mid, 0.55, 0.55, greens[i % 3]);
    s.capsule(mid, end, 0.55, 0.5, greens[i % 3]);
    if (i === 1 || i === 4) {
      // Cattail: a velvety brown spike with a thin tip.
      const k = 0.82;
      const base: [number, number, number] = [mid[0] + (end[0] - mid[0]) * k, mid[1] + (end[1] - mid[1]) * k, mid[2] + (end[2] - mid[2]) * k];
      s.capsule(base, [end[0], end[1] + 1, end[2]], 1.5, 1.4, (x, y, z) => (hash01(x, y, z, 142) < 0.3 ? 0x6e4a2c : 0x5c3c22));
      s.capsule([end[0], end[1] + 1, end[2]], [end[0], end[1] + 5, end[2]], 0.5, 0.5, 0xa89466);
    }
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.6;
    s.capsule(
      [C + Math.cos(a) * 1.2, 22, C + Math.sin(a) * 1.2],
      [C + Math.cos(a) * 6, 48 + i * 4, C + Math.sin(a) * 6],
      0.55,
      0.5,
      i & 1 ? 0x93a256 : 0xa3a862,
    );
  }
  s.capsule([C, 18.5, C], [C, 21.5, C], 2.2, 2.2, (x, y, z) => ((x + y + z) & 1 ? 0x8a7a4e : 0x9e8c5a), true);
  return s.build(0.03, CENTRE);
}

/** Гриб: a porcini — bulbous pale stem with a fine net, broad brown cap with pale pores underneath. */
export function buildMushroom(): THREE.BufferGeometry {
  const s = new Sculpt(-6, 0, -6, 6, 11, 6);
  s.sdf(
    (x, y, z) => {
      if (y > 7.5) return 1;
      const t = y / 7.5;
      const r = 2.3 + 0.9 * Math.sin(Math.PI * Math.min(1, t * 1.6)) * (1 - t) - 0.5 * t;
      return Math.hypot(x, z) - r;
    },
    (x, y, z) => (y === 0 ? 0x8a7a5c : hash01(x, y, z, 151) < 0.22 ? 0xd3c6a8 : 0xe6dcc4),
    [-4, 0, -4, 4, 8, 4],
  );
  s.sdf(
    (x, y, z) => {
      if (y < 6.5) return 1;
      return Math.hypot(x / 5.3, (y - 6.5) / 3.3, z / 5.3) - 1;
    },
    (x, y, z) => {
      if (y === 6) return (x + z) & 1 ? 0xd8c78c : 0xcbb97e; // pores
      const r = Math.hypot(x + 0.5, z + 0.5);
      if (r > 4.2) return 0x9a6236; // paler rim
      return hash01(x, y, z, 152) < 0.18 ? 0x86522b : 0x7a4826;
    },
    [-6, 6, -6, 6, 10, 6],
  );
  return s.build(0.02, [0, 0, 0]);
}

/** Яблоко: Ø 7 cm, yellow-green with a red blush on one side, a stalk and a leaf. */
export function buildApple(): THREE.BufferGeometry {
  const s = new Sculpt(-4, 0, -4, 5, 9, 5);
  s.ellipsoid(C, 3.5, C, 3.55, 3.35, 3.55, (x, y, z) => {
    if (y === 0 && x === 0 && z === 0) return 0x5d5a2e; // calyx
    const blush = x * 0.55 + z * 0.4 + (y - 3) * 0.15 + (hash01(x, y, z, 161) - 0.5) * 0.9;
    const base = blush > 0.9 ? 0xb3402c : blush > 0.1 ? 0xc0703a : 0xa9b845;
    return hash01(x, y, z, 162) < 0.08 ? mix(base, 0xe8e0a0, 0.4) : base;
  });
  s.set(0, 6, 0, -1); // the dimple round the stalk
  s.box(0, 6, 0, 1, 9, 1, 0x4a3322);
  s.box(1, 8, 0, 3, 9, 1, 0x4e7d2a);
  return s.build(0.03, CENTRE);
}

/** Консервы: a Ø 10 × 8 cm tin of stew — tinned rims and lid, faded cream label with red bands. */
export function buildCannedFood(): THREE.BufferGeometry {
  const s = new Sculpt(-5, 0, -5, 5, 8, 5);
  const tin = (x: number, y: number, z: number): number => {
    const r = Math.hypot(x + 0.5, z + 0.5);
    if (hash01(x, y, z, 171) < 0.04) return 0x96643e; // rust specks
    return y === 7 && r < 3.6 ? (Math.floor(r * 1.4) & 1 ? 0xb4b8ba : 0x9a9ea1) : 0xa9adb0;
  };
  const label = (x: number, y: number, z: number): number => {
    if (y === 1 || y === 6) return 0xa8322a;
    const a = Math.atan2(z + 0.5, x + 0.5);
    if (Math.abs(a - 0.8) < 0.45 && y >= 2 && y <= 4) return y === 4 ? 0x6e4a32 : 0x8a5e3e; // the cow picture
    if (y === 3 && Math.abs(a + 2) < 0.9 && (x + z) & 1) return 0x2e2a26; // printed text
    return hash01(x, y, z, 172) < 0.12 ? 0xc8b88e : 0xd8cba3;
  };
  s.capsule([0, 0, 0], [0, 8, 0], 5, 5, (x, y, z) => (y === 0 || y === 7 ? tin(x, y, z) : label(x, y, z)), true);
  return s.build(0.02, [0, 0, 0]);
}

/**
 * A cut of meat: rounded slab with a fat cap on −Z and a bone end on +X. `flesh` also learns whether
 * the cell is on the top surface.
 */
function meatSlab(
  s: Sculpt,
  k: number,
  flesh: (x: number, y: number, z: number, top: boolean) => number,
  fat: number,
  bone: number,
  marrow: number,
): void {
  const ax = 7.2 * k;
  const az = 5.2 * k;
  const height = (x: number, z: number): number => {
    const m = Math.pow(Math.abs(x / ax) ** 3 + Math.abs(z / az) ** 3, 1 / 3) + (noise3(x, 0, z, 4, 181) - 0.5) * 0.12;
    return m > 1 ? -1 : 4.6 * k * Math.sqrt(1 - m * m * m);
  };
  s.sdf(
    (x, y, z) => y - height(x, z),
    (x, y, z) => {
      const cx = x + 0.5;
      const cz = z + 0.5;
      const b = Math.hypot(cx - 4.2 * k, cz - 0.6 * k);
      if (b < 1.7 * k) return b < 0.8 * k ? marrow : bone;
      if (cz < -3.4 * k) return fat;
      return flesh(x, y, z, y + 1.5 > height(cx, cz));
    },
    [-8, 0, -6, 8, 5, 6],
  );
}

/** Сырое мясо: deep red with pale marbling, a white fat cap and a bone end. */
export function buildMeatRaw(): THREE.BufferGeometry {
  const s = new Sculpt(-8, 0, -6, 8, 5, 6);
  const red = speckle([0xa23a32, 0x8c2e2a, 0xb4483c, 0xa23a32], 182);
  meatSlab(s, 1, (x, y, z) => (Math.abs(fbm3(x * 1.6, y, z * 0.7, 4, 183) - 0.5) < 0.05 ? 0xdc9a90 : red(x, y, z)), 0xe6d0bd, 0xe8e0cc, 0x8a3a2c);
  return s.build(0.02, [0, 0, 0]);
}

/** Жареное мясо: the same cut browned — a crust with grill marks, golden fat, a browned bone end. */
export function buildMeatCooked(): THREE.BufferGeometry {
  const s = new Sculpt(-8, 0, -6, 8, 5, 6);
  meatSlab(
    s,
    0.9,
    (x, y, z, top) => {
      if (top && ((z + 40) & 3) === 0) return 0x40220f; // grill bars
      const n = fbm3(x, y, z, 3, 184);
      return y === 0 ? 0x5a3018 : n > 0.6 ? 0x95592f : n < 0.38 ? 0x6c3b1f : 0x7d4626;
    },
    0xc49052,
    0xd8c8a8,
    0x6a3a22,
  );
  return s.build(0.02, [0, 0, 0]);
}

/** Старая газета: a folded yellowed newspaper (30 × 21 cm): masthead, text columns, a photo. */
export function buildNewspaper(): THREE.BufferGeometry {
  const s = new Sculpt(-15, 0, -11, 15, 2, 10);
  const paper = 0xdcd3b0;
  const page = (x: number, z: number): number => {
    if (z <= -8) {
      // Masthead: blocky 3×3 glyphs with 1 cm spacing.
      const lx = (x + 13) % 4;
      if (z === -11 || x < -13 || x > 10 || lx === 3) return paper;
      return hash01(Math.floor((x + 13) / 4), lx, z, 191) < 0.62 ? 0x9a2a22 : paper;
    }
    if (z === -7) return 0x4a463e; // rule
    const col = Math.floor((x + 15) / 10);
    const cx = (x + 15) % 10;
    if (cx === 0 || cx === 9) return paper; // gutters
    if (col === 1 && z >= -5 && z <= 1) return hash01(x, 1, z, 192) < 0.3 ? 0x6e695e : 0x8a8478; // photo
    return (z & 1) === 0 && (x + z * 7 + 60) % 5 !== 0 ? 0x7a7466 : paper; // lines of words
  };
  s.box(-15, 1, -11, 15, 2, 10, (x, y, z) => page(x, z));
  s.box(-15, 0, -11, 15, 1, 10, (x) => (x === 14 ? 0xcfc6a2 : hash01(x, 0, 0, 194) < 0.5 ? 0xc9bf98 : 0xd6cca8));
  return s.build(0.01, [0, 0, 0]);
}

/** Item ids of this family → builders. */
export const ITEM_MODELS: Readonly<Record<string, () => THREE.BufferGeometry>> = {
  stick: buildStick,
  rope: buildRope,
  cloth: buildCloth,
  hide: buildHide,
  grass_fiber: buildGrassFiber,
  flower: buildFlower,
  reed: buildReed,
  mushroom: buildMushroom,
  apple: buildApple,
  canned_food: buildCannedFood,
  meat_raw: buildMeatRaw,
  meat_cooked: buildMeatCooked,
  newspaper: buildNewspaper,
};
