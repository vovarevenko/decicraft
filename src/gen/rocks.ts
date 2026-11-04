/**
 * Boulders and rock outcrops. OWNER: agent "worldgen".
 */
import { TAU } from '../core/math';
import { createNoise2D } from '../core/noise';
import { hash32, Rng } from '../core/rng';
import { B } from '../world/blocks';
import { anchorDown, clipBox, createBox } from './nature/raster';
import type { VoxelWriter } from './types';

type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Boulder shape limits relative to r (conservative, used by the bounds). */
const MAX_H = 1.3; // horizontal semi-axis factor
const MAX_V = 0.9; // vertical semi-axis factor
const MAX_LOBE = 0.22;
const ANCHOR = 20;
/** Moss patches on rocks: fixed, seed-independent pattern (pure function of the column). */
const mossNoise = createNoise2D(0x6d055);

interface RockBody {
  cx: number;
  cy: number;
  cz: number;
  /** Semi-axes in the rotated frame. */
  a: number;
  b: number;
  c: number;
  cos: number;
  sin: number;
  /** Rounded-box shape (L4 norm) instead of an ellipsoid. */
  boxy: boolean;
  /** Lobes: (ux, uy, uz, amp) × n, and cutting planes: (nx, ny, nz, d) × m (d relative to 1). */
  lobes: Float64Array;
  planes: Float64Array;
  /** World-space bounds of the body (float). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

const box = createBox();

function makeBody(rng: Rng, cx: number, cy: number, cz: number, a: number, b: number, c: number, boxy: boolean): RockBody {
  const angle = rng.range(0, TAU);
  const nl = 5;
  const lobes = new Float64Array(nl * 4);
  for (let k = 0; k < nl; k++) {
    const u = rng.range(-1, 1);
    const t = rng.range(0, TAU);
    const s = Math.sqrt(1 - u * u);
    lobes[k * 4] = s * Math.cos(t);
    lobes[k * 4 + 1] = u;
    lobes[k * 4 + 2] = s * Math.sin(t);
    lobes[k * 4 + 3] = rng.range(-0.18, 0.22);
  }
  // A few flat facets make the rock read as broken stone rather than a blob.
  const np = rng.int(3, 7);
  const planes = new Float64Array(np * 4);
  for (let k = 0; k < np; k++) {
    const u = rng.range(-0.3, 0.95);
    const t = rng.range(0, TAU);
    const s = Math.sqrt(1 - u * u);
    planes[k * 4] = s * Math.cos(t);
    planes[k * 4 + 1] = u;
    planes[k * 4 + 2] = s * Math.sin(t);
    planes[k * 4 + 3] = rng.range(0.62, 0.9);
  }
  const h = Math.max(a, c) * (1 + MAX_LOBE);
  const v = b * (1 + MAX_LOBE);
  return {
    cx, cy, cz, a, b, c, cos: Math.cos(angle), sin: Math.sin(angle), boxy, lobes, planes,
    x0: cx - h, x1: cx + h, y0: cy - v, y1: cy + v, z0: cz - h, z1: cz + h,
  };
}

/** Normalised "radius" of a point relative to the body surface: ≤ 1 inside. */
function bodyDistance(r: RockBody, px: number, py: number, pz: number): number {
  const dx = px - r.cx;
  const dy = py - r.cy;
  const dz = pz - r.cz;
  const u = (dx * r.cos + dz * r.sin) / r.a;
  const v = dy / r.b;
  const w = (-dx * r.sin + dz * r.cos) / r.c;
  const q2 = u * u + v * v + w * w;
  if (q2 < 1e-9) return 0;
  const q = Math.sqrt(q2);
  const rad = r.boxy ? Math.sqrt(Math.sqrt(u * u * u * u + v * v * v * v + w * w * w * w)) : q;
  const nx = u / q;
  const ny = v / q;
  const nz = w / q;
  let f = 0;
  const L = r.lobes;
  for (let k = 0; k < L.length; k += 4) {
    const d = nx * L[k] + ny * L[k + 1] + nz * L[k + 2];
    if (d > 0) f += L[k + 3] * d * d;
  }
  if (f > MAX_LOBE) f = MAX_LOBE;
  else if (f < -MAX_LOBE) f = -MAX_LOBE;
  let dist = rad / (1 + f);
  const P = r.planes;
  for (let k = 0; k < P.length; k += 4) {
    const pd = (u * P[k] + v * P[k + 1] + w * P[k + 2]) / P[k + 3];
    if (pd > dist) dist = pd;
  }
  return dist;
}

/** True on the upper cap of a body (normalised elevation above ~35°): where moss can settle. */
function facesUp(r: RockBody, px: number, py: number, pz: number): boolean {
  const dx = px - r.cx;
  const dz = pz - r.cz;
  const u = (dx * r.cos + dz * r.sin) / r.a;
  const v = (py - r.cy) / r.b;
  const w = (-dx * r.sin + dz * r.cos) / r.c;
  return v > 0 && v * v > 0.35 * (u * u + v * v + w * w);
}

/**
 * Rasterises rock bodies: voxels inside any body become rock (granite or stone), moss on
 * upward-facing surface voxels in patches; the lowest voxel of each column is anchored down so
 * rocks rest on slopes instead of floating.
 */
function rasterRocks(w: VoxelWriter, bodies: RockBody[], granite: boolean, moss: number, mossSalt: number): void {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const b of bodies) {
    x0 = Math.min(x0, b.x0);
    x1 = Math.max(x1, b.x1);
    y0 = Math.min(y0, b.y0);
    y1 = Math.max(y1, b.y1);
    z0 = Math.min(z0, b.z0);
    z1 = Math.max(z1, b.z1);
  }
  if (!clipBox(w, x0, y0, z0, x1, y1, z1, box)) return;
  const rock = granite ? B.GRANITE : B.STONE;
  for (let x = box.x0; x < box.x1; x++) {
    const px = x + 0.5;
    for (let z = box.z0; z < box.z1; z++) {
      const pz = z + 0.5;
      const mossy = moss > 0 && mossNoise(x * (1 / 9) + mossSalt, z * (1 / 9) - mossSalt) > 0.35 - moss;
      let lowest = -1;
      let above = false;
      for (let y = box.y1 - 1; y >= box.y0; y--) {
        const py = y + 0.5;
        let hit: RockBody | null = null;
        for (const b of bodies) {
          if (px < b.x0 || px > b.x1 || pz < b.z0 || pz > b.z1 || py < b.y0 || py > b.y1) continue;
          if (bodyDistance(b, px, py, pz) <= 1) {
            hit = b;
            break;
          }
        }
        if (hit === null) {
          above = false;
          continue;
        }
        w.set(x, y, z, !above && mossy && facesUp(hit, px, py, pz) ? B.MOSS : rock);
        above = true;
        lowest = y;
      }
      if (lowest > 0) anchorDown(w, x, lowest - 1, z, rock, ANCHOR);
    }
  }
}

/** Bounds of a boulder with radius r (voxels) whose base sits at (x, y, z). */
export function boulderBounds(x: number, y: number, z: number, r: number): { min: [number, number, number]; max: [number, number, number] } {
  const h = Math.ceil(r * MAX_H * (1 + MAX_LOBE)) + 2;
  const v = Math.ceil(r * MAX_V * (1 + MAX_LOBE)) + 2;
  return { min: [x - h, y - v - ANCHOR - 1, z - h], max: [x + h + 1, y + Math.ceil(0.3 * r * MAX_V) + v + 1, z + h + 1] };
}

/** Irregular (noise-deformed ellipsoid) STONE/GRANITE boulder, partly buried, optional MOSS on top. */
export function stampBoulder(w: VoxelWriter, x: number, y: number, z: number, r: number, seed: number): void {
  const rng = new Rng(hash32(seed ^ 0xb01d3));
  const a = r * rng.range(0.95, MAX_H);
  const c = r * rng.range(0.8, 1.15);
  const b = r * rng.range(0.65, MAX_V);
  // Centre between 30 % above and 15 % below ground level: 35–65 % of the height is buried.
  const cy = y + b * rng.range(-0.15, 0.3);
  const body = makeBody(rng, x + 0.5, cy, z + 0.5, a, b, c, rng.chance(0.35));
  const granite = rng.chance(0.4);
  const moss = rng.chance(0.65) ? rng.range(0.1, 0.5) : 0;
  rasterRocks(w, [body], granite, moss, rng.range(0, 1000));
}

export interface OutcropParams {
  /** Base centre: first air voxel above the ground. */
  x: number;
  y: number;
  z: number;
  /** Footprint radius of the bottom block (voxels, ≈ 12–25). */
  size: number;
  seed: number;
}

interface OutcropModel {
  bodies: RockBody[];
  bounds: Bounds;
}

function buildOutcrop(p: OutcropParams): OutcropModel {
  const rng = new Rng(hash32(p.seed ^ 0x70e5));
  const bodies: RockBody[] = [];
  const n = rng.int(2, 5);
  let a = p.size * rng.range(0.9, 1.1);
  let c = p.size * rng.range(0.7, 0.95);
  let b = p.size * rng.range(0.45, 0.6);
  let cx = p.x + 0.5;
  let cz = p.z + 0.5;
  let cy = p.y + b * 0.25; // bottom block sits a quarter of its height in the ground
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    bodies.push(makeBody(rng, cx, cy, cz, a, b, c, true));
    const ext = Math.max(a, c) * (1 + MAX_LOBE);
    x0 = Math.min(x0, cx - ext);
    x1 = Math.max(x1, cx + ext);
    z0 = Math.min(z0, cz - ext);
    z1 = Math.max(z1, cz + ext);
    top = Math.max(top, cy + b * (1 + MAX_LOBE));
    // Next block: smaller, resting on this one with a slight offset (weathered tor stack).
    const na = a * rng.range(0.6, 0.85);
    const nc = c * rng.range(0.6, 0.9);
    const nb = b * rng.range(0.7, 0.95);
    cx += rng.range(-0.25, 0.25) * a;
    cz += rng.range(-0.25, 0.25) * c;
    cy += b * 0.85 + nb * 0.85;
    a = na;
    b = nb;
    c = nc;
  }
  return {
    bodies,
    bounds: {
      min: [Math.floor(x0) - 2, Math.floor(p.y - p.size * 0.6 * (1 + MAX_LOBE)) - ANCHOR - 2, Math.floor(z0) - 2],
      max: [Math.ceil(x1) + 2, Math.ceil(top) + 2, Math.ceil(z1) + 2],
    },
  };
}

/** Conservative bounds of a rock outcrop. */
export function outcropBounds(p: OutcropParams): Bounds {
  const b = buildOutcrop(p).bounds;
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}

/** A tor: a stack of 2–4 rounded, faceted GRANITE blocks with moss on the tops. */
export function stampOutcrop(w: VoxelWriter, p: OutcropParams): void {
  const m = buildOutcrop(p);
  rasterRocks(w, m.bodies, true, 0.3, (p.seed & 1023) * 0.37);
}
