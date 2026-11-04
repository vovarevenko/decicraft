/**
 * Modelling toolkit for the centimetre models: sRGB colour math, cell hashing, smooth value noise
 * and colour functions (wood grain, end-grain rings, rust, peeling paint, fur shading) plus grid
 * post-processes (worn edges). Colour functions return sRGB 0xRRGGBB for an integer grid cell and
 * quantise their variation to a few tones so that the greedy mesher can still merge faces.
 */
import type { VoxelGrid } from '../voxelModel';

/** Colour of a grid cell (sRGB 0xRRGGBB; negative clears the cell). */
export type ColorFn = (x: number, y: number, z: number) => number;
export type Axis = 'x' | 'y' | 'z';

const clampByte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** Packs 0..255 channels (clamped, rounded) into 0xRRGGBB. */
export function rgb(r: number, g: number, b: number): number {
  return (clampByte(r) << 16) | (clampByte(g) << 8) | clampByte(b);
}

/** Linear blend of two sRGB colours (t = 0 → a, 1 → b). */
export function mix(a: number, b: number, t: number): number {
  return rgb(
    ((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t,
    ((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t,
    (a & 255) + ((b & 255) - (a & 255)) * t,
  );
}

/** Brightness multiplied by `f` (f < 1 darker, f > 1 lighter). */
export function shade(c: number, f: number): number {
  return rgb(((c >> 16) & 255) * f, ((c >> 8) & 255) * f, (c & 255) * f);
}

/** Deterministic hash of an integer cell (+ seed) → [0, 1). */
export function hash01(x: number, y: number, z: number, seed = 0): number {
  let h = Math.imul((x | 0) ^ Math.imul(seed | 0, 0x27d4eb2d), 0x85ebca6b);
  h ^= Math.imul((y | 0) + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= Math.imul((z | 0) + 0x5bd1e995, 0x297a2d39);
  h = Math.imul(h ^ (h >>> 12), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Smooth 3D value noise in [0, 1) with lattice spacing `cell` (in grid cells). */
export function noise3(x: number, y: number, z: number, cell: number, seed = 0): number {
  const fx = x / cell;
  const fy = y / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  const tx = smooth(fx - ix);
  const ty = smooth(fy - iy);
  const tz = smooth(fz - iz);
  const c000 = hash01(ix, iy, iz, seed);
  const c100 = hash01(ix + 1, iy, iz, seed);
  const c010 = hash01(ix, iy + 1, iz, seed);
  const c110 = hash01(ix + 1, iy + 1, iz, seed);
  const c001 = hash01(ix, iy, iz + 1, seed);
  const c101 = hash01(ix + 1, iy, iz + 1, seed);
  const c011 = hash01(ix, iy + 1, iz + 1, seed);
  const c111 = hash01(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * tx;
  const x10 = c010 + (c110 - c010) * tx;
  const x01 = c001 + (c101 - c001) * tx;
  const x11 = c011 + (c111 - c011) * tx;
  const y0 = x00 + (x10 - x00) * ty;
  const y1 = x01 + (x11 - x01) * ty;
  return y0 + (y1 - y0) * tz;
}

/** Two-octave value noise in [0, 1). */
export function fbm3(x: number, y: number, z: number, cell: number, seed = 0): number {
  return noise3(x, y, z, cell, seed) * 0.65 + noise3(x, y, z, cell * 0.45, seed + 101) * 0.35;
}

/**
 * Picks one of `tones` per cell by hash (the tone list doubles as a weighted palette: repeat a
 * colour to make it more frequent).
 */
export function speckle(tones: readonly number[], seed = 0): ColorFn {
  const n = tones.length;
  return (x, y, z) => tones[Math.floor(hash01(x, y, z, seed) * n)];
}

/** Base colour with per-cell brightness variation quantised to dark / base / light (±amount). */
export function vary(base: number, amount: number, seed = 0): ColorFn {
  return speckle([shade(base, 1 - amount), base, base, shade(base, 1 + amount)], seed);
}

export interface GrainOptions {
  /** Streak tone spread (fraction of brightness, default 0.08). */
  amount?: number;
  /** Mean streak length along the grain in cells (default 7). */
  streak?: number;
  /** Probability of a dark knot cell per cell (default 0). */
  knots?: number;
  /** Fibre width across the grain in cells (default 1); wider fibres merge into fewer faces. */
  width?: number;
  seed?: number;
}

/**
 * Long wood grain: streaks along `axis` whose tone is constant over a run of cells (so faces merge
 * along the grain), varying between neighbouring fibres across it.
 */
export function grain(base: number, axis: Axis, opts: GrainOptions = {}): ColorFn {
  const amount = opts.amount ?? 0.08;
  const streak = Math.max(1, opts.streak ?? 7);
  const knots = opts.knots ?? 0;
  const width = Math.max(1, opts.width ?? 1);
  const seed = opts.seed ?? 0;
  const tones = [shade(base, 1 - amount * 1.4), shade(base, 1 - amount * 0.5), base, base, shade(base, 1 + amount * 0.6)];
  const knot = shade(base, 0.62);
  return (x, y, z) => {
    const along = axis === 'x' ? x : axis === 'y' ? y : z;
    const a = Math.floor((axis === 'x' ? y : x) / width);
    const b = Math.floor((axis === 'z' ? y : z) / width);
    // Fibres get a random phase so their run boundaries do not line up.
    const phase = Math.floor(hash01(a, b, 7, seed) * streak);
    const run = Math.floor((along + phase) / streak);
    if (knots > 0 && hash01(x, y, z, seed + 31) < knots) return knot;
    return tones[Math.floor(hash01(a, b, run, seed) * tones.length)];
  };
}

/**
 * End-grain rings around an axis through (ca, cb) (cross-section coordinates in axis order:
 * x → (y, z), y → (x, z), z → (x, y)): alternating early/late wood every `width` cells.
 */
export function rings(light: number, dark: number, axis: Axis, ca: number, cb: number, width = 1.6): ColorFn {
  return (x, y, z) => {
    const a = (axis === 'x' ? y : x) + 0.5 - ca;
    const b = (axis === 'z' ? y : z) + 0.5 - cb;
    const r = Math.sqrt(a * a + b * b);
    return Math.floor(r / width) % 2 === 0 ? light : dark;
  };
}

/**
 * Rust over a base: blotches (noise above 1 − coverage) in two rust tones, plus scattered dark
 * pits (a fraction `pits` of the remaining cells). `scale` = blotch size in cells.
 */
export function rust(
  base: ColorFn | number,
  coverage: number,
  seed = 0,
  scale = 4,
  tones: readonly number[] = RUST,
  pits = coverage * 0.12,
): ColorFn {
  const under = typeof base === 'number' ? () => base : base;
  return (x, y, z) => {
    const n = fbm3(x, y, z, scale, seed);
    const edge = 1 - coverage;
    if (n > edge) return n > edge + coverage * 0.45 ? tones[0] : tones[1];
    if (pits > 0 && hash01(x, y, z, seed + 7) < pits) return tones[2];
    return under(x, y, z);
  };
}

/** Rust tones: deep, orange, dark pit. */
export const RUST = [0x6e3a22, 0x93512b, 0x4a2a1c] as const;

/** Peeling paint: `paint` with blotches (noise below `bare`) where `under` shows through. */
export function peel(paint: ColorFn | number, under: ColorFn | number, bare: number, seed = 0, scale = 5): ColorFn {
  const top = typeof paint === 'number' ? () => paint : paint;
  const below = typeof under === 'number' ? () => under : under;
  return (x, y, z) => (fbm3(x, y, z, scale, seed) < bare ? below(x, y, z) : top(x, y, z));
}

/**
 * Wears the exposed edges of a model: every filled cell with at least `minOpen` empty face
 * neighbours (2 = edges and corners) for which `match(rgb)` holds becomes `worn(rgb)` with
 * probability `chance`. Cells are chosen against the grid as it is before any of them changes.
 */
export function wearEdges(
  grid: VoxelGrid,
  worn: (rgb: number) => number,
  chance: number,
  seed = 0,
  match: (rgb: number) => boolean = () => true,
  minOpen = 2,
): void {
  const { sx, sy, sz, data } = grid;
  const sxy = sx * sy;
  const picked: number[] = [];
  let i = 0;
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0; x < sx; x++, i++) {
        const v = data[i];
        // Cheapest tests first: most cells fail the dice roll.
        if (v === 0 || hash01(x, y, z, seed) >= chance || !match(v & 0xffffff)) continue;
        const open =
          (x === 0 || data[i - 1] === 0 ? 1 : 0) +
          (x === sx - 1 || data[i + 1] === 0 ? 1 : 0) +
          (y === 0 || data[i - sx] === 0 ? 1 : 0) +
          (y === sy - 1 || data[i + sx] === 0 ? 1 : 0) +
          (z === 0 || data[i - sxy] === 0 ? 1 : 0) +
          (z === sz - 1 || data[i + sxy] === 0 ? 1 : 0);
        if (open >= minOpen) picked.push(i);
      }
    }
  }
  for (const j of picked) {
    const c = worn(data[j] & 0xffffff);
    data[j] = c < 0 ? 0 : (c | 0xff000000) >>> 0;
  }
}

/**
 * Fur shading for an animal part: a vertical gradient from `back` (top, y ≥ yTop) to `belly`
 * (y ≤ yBottom) through `side`, with wavy band borders and soft streaks of ±`streak` brightness
 * running along `along` (the length of the part). Both come from smooth noise, so neighbouring cells
 * mostly share a tone and faces merge.
 */
export function furShade(
  back: number,
  side: number,
  belly: number,
  yBottom: number,
  yTop: number,
  streak = 0.05,
  seed = 0,
  along: Axis = 'z',
): ColorFn {
  const bands = [belly, mix(side, belly, 0.5), side, mix(side, back, 0.5), back].map((c) => [shade(c, 1 - streak), c, shade(c, 1 + streak)]);
  const span = Math.max(1, yTop - yBottom);
  const sx = along === 'x' ? 0.3 : 1.4;
  const sy = along === 'y' ? 0.3 : 1.4;
  const sz = along === 'z' ? 0.3 : 1.4;
  return (x, y, z) => {
    const t = (y + 0.5 - yBottom) / span + (noise3(x, y, z, 3, seed + 3) - 0.5) * 0.18;
    const band = t > 0.86 ? 4 : t > 0.7 ? 3 : t > 0.3 ? 2 : t > 0.16 ? 1 : 0;
    const n = noise3(x * sx, y * sy, z * sz, 3, seed);
    return bands[band][n < 0.36 ? 0 : n > 0.64 ? 2 : 1];
  };
}
