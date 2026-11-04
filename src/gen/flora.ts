/**
 * Procedural trees and bushes at 10 cm resolution. OWNER: agent "worldgen".
 * The town planner (agent "town") also uses these for overgrown yards (apple trees, birch saplings).
 *
 * A tree is first built as a small deterministic model (trunk curve, limbs, branches, foliage
 * clusters, roots) from its own seed, then rasterised through the clipped writer. Every voxel
 * decision depends only on the model and the voxel's own column, so stamping the same tree into
 * different tiles always yields identical voxels.
 */
import { clamp, lerp, TAU } from '../core/math';
import { hash32, Rng } from '../core/rng';
import { B } from '../world/blocks';
import { anchorDown, clipBox, createBox, putBark, putRoot, rasterLimb, rasterLine } from './nature/raster';
import type { VoxelWriter } from './types';

export type TreeKind = 'oak' | 'birch' | 'pine' | 'apple' | 'sapling' | 'dead';

export interface TreeParams {
  kind: TreeKind;
  /** Trunk base: voxel coords of the first air voxel above ground at the trunk centre. */
  x: number;
  y: number;
  z: number;
  /** Per-tree variation seed. */
  seed: number;
  /** Size multiplier (1 = typical adult tree of the species). */
  scale?: number;
  /**
   * Max crown radius (voxels) from the trunk axis. The plan clamps it so neighbouring crowns keep
   * ≥ 0.3 m apart and ≥ 0.5 m from buildings/rocks ("crown shyness"); undefined = species default.
   */
  maxCrownRadius?: number;
  /**
   * Optional convex crown cell from the plan's crown shyness: half-planes flattened as
   * [ux, uz, s, …] relative to the trunk axis (x + 0.5, z + 0.5); every foliage voxel centre satisfies
   * dx·ux + dz·uz ≤ s. Lets a crown grow into the gaps between its neighbours (asymmetric crowns).
   */
  crownCell?: readonly number[];
}

type Bounds = { min: [number, number, number]; max: [number, number, number] };

/** Foliage clusters are deformed by ±this much (relative radius) — conservative for bounds. */
const LOBE_MIN = -0.22;
const LOBE_MAX = 0.38;
const LOBES = 8;
/** Clusters whose smallest semi-axis reaches this (Ø ≥ 2 m) are shells around an air core. */
const SHELL_MIN = 10;
/** Shell thickness along the smallest axis (≥ 4 voxels after voxelisation). */
const SHELL_T = 4.6;
/** Trunks reach this far below the base voxel; trunks, roots and logs then anchor through air for ≤ ANCHOR voxels. */
const BURY = 4;
const ANCHOR = 20;
/** Thinnest capsule radius that still voxelises 6-connected. */
const MIN_LIMB_R = 0.9;
/** Minimum horizontal distance between broadleaf crown clusters, relative to the sum of their radii. */
const SPACING_2D = 0.68;

interface Limb {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  ra: number;
  rb: number;
}

interface Cluster {
  x: number;
  y: number;
  z: number;
  r: number;
  sUp: number;
  sDown: number;
  /** LOBES × (ux, uy, uz, amplitude): bumps of the low-frequency deformation. */
  lobes: Float64Array;
  /** Max horizontal reach of the deformed surface, relative to r (computed on demand). */
  reach: number;
  /** Horizontal reach factor per REACH_DIRS sample (surface point = (r·q + 0.5)·(hx, hz)); null until needed. */
  q: Float32Array | null;
}

interface Root {
  dx: number;
  dz: number;
  len: number;
  h0: number;
  w0: number;
}

interface TreeModel {
  bark: number;
  leaves: number;
  /** Trunk axis at the base (float) and the base voxel row. */
  bx: number;
  bz: number;
  y: number;
  trunkTop: number;
  r0: number;
  r1: number;
  flare: number;
  /** Quadratic Bézier offsets of the trunk axis (control point, top), relative to the base. */
  c1x: number;
  c1z: number;
  c2x: number;
  c2z: number;
  /** Saplings: the trunk is a one-voxel line instead of discs. */
  thin: boolean;
  /** Crown cell half-planes (see TreeParams.crownCell); empty = round crown. */
  cell: Float64Array;
  limbs: Limb[];
  clusters: Cluster[];
  roots: Root[];
  bounds: Bounds;
}

/** Species' largest crown radius (voxels) at the given scale — what the plan starts from for crown shyness. */
export function treeCrownRadius(kind: TreeKind, scale = 1): number {
  const r = kind === 'oak' ? 54 : kind === 'birch' ? 32 : kind === 'pine' ? 36 : kind === 'apple' ? 30 : kind === 'sapling' ? 9 : 40;
  return r * scale;
}

/**
 * Vertical extent [bottom, top) of the tree's crown layer — its foliage, or the bare branches of a
 * dead tree — for height-aware crown shyness: crowns that do not share a height band cannot touch.
 */
export function treeCrownSpan(p: TreeParams): [number, number] {
  const m = buildTree(p);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of m.clusters) {
    const R = c.r * (1 + LOBE_MAX);
    lo = Math.min(lo, c.y - R * c.sDown);
    hi = Math.max(hi, c.y + R * c.sUp);
  }
  if (m.clusters.length === 0) {
    for (const l of m.limbs) {
      const r = Math.max(l.ra, l.rb, 0.5);
      lo = Math.min(lo, l.ay - r, l.by - r);
      hi = Math.max(hi, l.ay + r, l.by + r);
    }
  }
  if (lo > hi) return [m.y, m.y];
  return [Math.floor(lo), Math.ceil(hi)];
}

/** Conservative bounds (min inclusive, max exclusive) of everything stampTree may write. */
export function treeBounds(p: TreeParams): { min: [number, number, number]; max: [number, number, number] } {
  const b = buildTree(p).bounds;
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}

/**
 * Writes the tree: bark-covered trunk with WOOD core, roots flaring into the ground, tapered branches
 * visible under the crown, foliage as 6–14 clusters (Ø 1.5–3.5 m) around branch tips with
 * low-frequency deformation and gaps between clusters (~20–30 % of the crown envelope empty, so light
 * gets through); clusters ≥ 2 m are shells ≥ 4 voxels thick around an air core. No per-voxel random
 * holes (coherent surfaces keep meshes small). Foliage uses setSoft; trunk/branches use set.
 */
export function stampTree(w: VoxelWriter, p: TreeParams): void {
  const m = buildTree(p);
  if (!clipBox(w, m.bounds.min[0], m.bounds.min[1], m.bounds.min[2], m.bounds.max[0] - 1, m.bounds.max[1] - 1, m.bounds.max[2] - 1, scratchBox)) {
    return;
  }
  for (const r of m.roots) rasterRoot(w, m, r);
  for (const l of m.limbs) {
    if (l.ra >= MIN_LIMB_R && l.rb >= MIN_LIMB_R) rasterLimb(w, l.ax, l.ay, l.az, l.bx, l.by, l.bz, l.ra, l.rb, m.bark);
    else rasterLine(w, l.ax, l.ay, l.az, l.bx, l.by, l.bz, m.bark);
  }
  rasterTrunk(w, m);
  for (const c of m.clusters) rasterCluster(w, c, m.leaves);
}

/** Bounds of a bush of the given radius (voxels) at base (x, y, z). */
export function bushBounds(x: number, y: number, z: number, radius: number): { min: [number, number, number]; max: [number, number, number] } {
  // Blobs: radius ≤ 0.8·R, centres ≤ 0.45·R off-axis at 0.35–0.55 of their radius above the base.
  const blob = radius * 0.8 * (1 + LOBE_MAX);
  const up = Math.ceil(radius * 0.8 * 0.55 + blob * 0.9) + 2;
  const down = Math.ceil(blob * 0.75) + 2;
  const r = Math.ceil(radius * 0.45 + blob) + 2;
  return { min: [x - r, y - down, z - r], max: [x + r + 1, y + up, z + r + 1] };
}

/** A rounded BUSH clump with a few hidden twigs. */
export function stampBush(w: VoxelWriter, x: number, y: number, z: number, radius: number, seed: number): void {
  const rng = new Rng(hash32(seed ^ 0x4b05e5));
  const cx = x + 0.5;
  const cz = z + 0.5;
  const n = rng.int(2, 5);
  const blobs: Cluster[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, TAU);
    const d = i === 0 ? 0 : rng.range(0.2, 0.45) * radius;
    const r = radius * (i === 0 ? rng.range(0.65, 0.8) : rng.range(0.5, 0.7));
    blobs.push(makeCluster(rng, cx + Math.cos(a) * d, y + r * rng.range(0.35, 0.55), cz + Math.sin(a) * d, r, 0.9, 0.75));
  }
  // Twigs from the ground into the blobs (hidden inside the foliage).
  for (const b of blobs) rasterLine(w, cx, y - 1, cz, b.x, b.y, b.z, B.OAK_LOG);
  for (const b of blobs) rasterCluster(w, b, B.BUSH);
}

// ------------------------------------------------------------------------------------------ dead wood

export interface FallenLogParams {
  /** End points of the log axis on the ground (voxels; y = first air voxel above the ground there). */
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  /** Log radius in voxels (2–3.5). */
  radius: number;
  bark: number;
}

/** Conservative bounds of a fallen log. */
export function fallenLogBounds(p: FallenLogParams): Bounds {
  const r = p.radius + 1;
  return {
    min: [Math.floor(Math.min(p.ax, p.bx) - r), Math.floor(Math.min(p.ay, p.by) - 2), Math.floor(Math.min(p.az, p.bz) - r)],
    max: [Math.ceil(Math.max(p.ax, p.bx) + r) + 1, Math.ceil(Math.max(p.ay, p.by) + 2 * r) + 1, Math.ceil(Math.max(p.az, p.bz) + r) + 1],
  };
}

/** A horizontal trunk lying on the ground: bark skin, WOOD core showing at both cut ends, sunk ~1 voxel. */
export function stampFallenLog(w: VoxelWriter, p: FallenLogParams): void {
  const r = p.radius;
  const ax = p.ax;
  const ay = p.ay + r - 1;
  const az = p.az;
  const dx = p.bx - ax;
  const dy = p.by + r - 1 - ay;
  const dz = p.bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < 1) return;
  const box = scratchBox;
  if (!clipBox(w, Math.min(ax, p.bx) - r, Math.min(ay, ay + dy) - r, Math.min(az, p.bz) - r, Math.max(ax, p.bx) + r, Math.max(ay, ay + dy) + r, Math.max(az, p.bz) + r, box)) {
    return;
  }
  const inv = 1 / len2;
  for (let x = box.x0; x < box.x1; x++) {
    for (let z = box.z0; z < box.z1; z++) {
      for (let y = box.y0; y < box.y1; y++) {
        const px = x + 0.5 - ax;
        const py = y + 0.5 - ay;
        const pz = z + 0.5 - az;
        const t = (px * dx + py * dy + pz * dz) * inv;
        if (t < 0 || t > 1) continue; // flat cut ends
        const qx = px - dx * t;
        const qy = py - dy * t;
        const qz = pz - dz * t;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 > r * r) continue;
        w.set(x, y, z, d2 <= (r - 1) * (r - 1) ? B.WOOD : p.bark);
      }
    }
  }
}

export interface StumpParams {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  bark: number;
  seed: number;
}

/** Conservative bounds of a stump. */
export function stumpBounds(p: StumpParams): Bounds {
  const reach = Math.ceil(p.radius * 4.6 + 5);
  return { min: [p.x - reach, p.y - BURY - ANCHOR - 1, p.z - reach], max: [p.x + reach + 1, p.y + p.height + Math.ceil(p.radius) + 2, p.z + reach + 1] };
}

/** A cut stump: short flared trunk with a flat WOOD top and a few root ridges. */
export function stampStump(w: VoxelWriter, p: StumpParams): void {
  const rng = new Rng(hash32(p.seed ^ 0x57a3b));
  const m = emptyModel(p.x, p.y, p.z, p.bark, B.AIR);
  m.trunkTop = p.y + p.height;
  m.r0 = p.radius;
  m.r1 = p.radius * 0.92;
  m.flare = p.radius * 0.5;
  addRoots(m, rng, p.radius, rng.int(3, 6));
  for (const r of m.roots) rasterRoot(w, m, r);
  rasterTrunk(w, m);
}

// ------------------------------------------------------------------------------------------ model

const scratchBox = createBox();

function emptyModel(x: number, y: number, z: number, bark: number, leaves: number, cell: Float64Array = NO_CELL): TreeModel {
  return {
    bark,
    leaves,
    bx: x + 0.5,
    bz: z + 0.5,
    y,
    trunkTop: y,
    r0: 1,
    r1: 1,
    flare: 0,
    c1x: 0,
    c1z: 0,
    c2x: 0,
    c2z: 0,
    thin: false,
    cell,
    limbs: [],
    clusters: [],
    roots: [],
    bounds: { min: [x, y, z], max: [x + 1, y + 1, z + 1] },
  };
}

const cellOf = (p: TreeParams): Float64Array => (p.crownCell && p.crownCell.length >= 3 ? Float64Array.from(p.crownCell) : NO_CELL);

function buildTree(p: TreeParams): TreeModel {
  const scale = clamp(p.scale ?? 1, 0.25, 2);
  const rng = new Rng(hash32(p.seed ^ 0x7a3e5eed));
  const maxR = Math.max(4, p.maxCrownRadius ?? Infinity);
  let m: TreeModel;
  switch (p.kind) {
    case 'oak':
      m = buildBroadleaf(p, rng, scale, maxR, OAK);
      break;
    case 'apple':
      m = buildBroadleaf(p, rng, scale, maxR, APPLE);
      break;
    case 'birch':
      m = buildBirch(p, rng, scale, maxR);
      break;
    case 'pine':
      m = buildPine(p, rng, scale, maxR);
      break;
    case 'sapling':
      m = buildSapling(p, rng, scale, maxR);
      break;
    default:
      m = buildDead(p, rng, scale, maxR);
  }
  computeBounds(m);
  return m;
}

/** Trunk axis centre (x, z) at height yy → out[0], out[1]. */
function axisAt(m: TreeModel, yy: number, out: number[]): number[] {
  const t = clamp((yy - m.y) / Math.max(1, m.trunkTop - m.y), 0, 1);
  const a = 2 * t * (1 - t);
  const b = t * t;
  out[0] = m.bx + a * m.c1x + b * m.c2x;
  out[1] = m.bz + a * m.c1z + b * m.c2z;
  return out;
}

function trunkRadius(m: TreeModel, yy: number): number {
  const t = clamp((yy - m.y) / Math.max(1, m.trunkTop - m.y), 0, 1);
  const flare = m.flare * Math.exp(-Math.max(0, yy - m.y) / 5);
  return Math.max(0.95, lerp(m.r0, m.r1, t) + flare);
}

const axis = [0, 0];

function makeCluster(rng: Rng, x: number, y: number, z: number, r: number, sUp: number, sDown: number): Cluster {
  const lobes = new Float64Array(LOBES * 4);
  for (let k = 0; k < LOBES; k++) {
    const u = rng.range(-1, 1);
    const a = rng.range(0, TAU);
    const s = Math.sqrt(1 - u * u);
    lobes[k * 4] = s * Math.cos(a);
    lobes[k * 4 + 1] = u;
    lobes[k * 4 + 2] = s * Math.sin(a);
    lobes[k * 4 + 3] = rng.range(-0.18, 0.46);
  }
  return { x, y, z, r, sUp, sDown, lobes, reach: 0, q: null };
}

/**
 * Samples the horizontal reach of a cluster's deformed surface per direction (+5 % for the angles
 * between samples): lets crowns fill their cell without crossing it.
 */
function reachOf(c: Cluster): Float32Array {
  if (c.q) return c.q;
  const q = new Float32Array(REACH_SAMPLES);
  let reach = 0;
  for (let i = 0; i < REACH_SAMPLES; i++) {
    const d = i * 6;
    const e = (1 + lobeAt(c.lobes, REACH_DIRS[d], REACH_DIRS[d + 1], REACH_DIRS[d + 2])) * REACH_DIRS[d + 3] * 1.05;
    q[i] = e;
    if (e > reach) reach = e;
  }
  c.q = q;
  c.reach = reach;
  return q;
}

/** Sample directions for cluster reach (16 azimuths × 7 elevations): x, y, z, horizontal length, azimuth cos, sin. */
const REACH_DIRS: Float64Array = (() => {
  const out: number[] = [];
  for (const u of [-0.9, -0.6, -0.3, 0, 0.3, 0.6, 0.9]) {
    const s = Math.sqrt(1 - u * u);
    for (let k = 0; k < 16; k++) {
      const c = Math.cos((k * TAU) / 16);
      const n = Math.sin((k * TAU) / 16);
      out.push(s * c, u, s * n, s, c, n);
    }
  }
  return Float64Array.from(out);
})();
const REACH_SAMPLES = REACH_DIRS.length / 6;
const NO_CELL = new Float64Array(0);

/** Low-frequency deformation of a cluster in direction (nx, ny, nz) (unit, in normalised space). */
function lobeAt(lobes: Float64Array, nx: number, ny: number, nz: number): number {
  let f = 0;
  for (let k = 0; k < LOBES * 4; k += 4) {
    const d = nx * lobes[k] + ny * lobes[k + 1] + nz * lobes[k + 2];
    if (d > 0) f += lobes[k + 3] * d * d * d;
  }
  return f < LOBE_MIN ? LOBE_MIN : f > LOBE_MAX ? LOBE_MAX : f;
}

const isShell = (c: Cluster): boolean => c.r * Math.min(1, c.sUp, c.sDown) >= SHELL_MIN;

/** Horizontal reach of a cluster's surface from its centre (voxel centres included). */
function horizontalExtent(c: Cluster): number {
  reachOf(c);
  return c.r * c.reach + 0.5;
}

/** Max of the cluster's surface samples projected on horizontal direction (ux, uz). */
function support(c: Cluster, ux: number, uz: number): number {
  const q = reachOf(c);
  let h = -Infinity;
  for (let i = 0; i < REACH_SAMPLES; i++) {
    const d = i * 6;
    const v = (c.r * q[i] + 0.5) * (REACH_DIRS[d + 4] * ux + REACH_DIRS[d + 5] * uz);
    if (v > h) h = v;
  }
  return h;
}

/**
 * Largest t ∈ [0, 1] such that an object centred at axis + t·(ox, oz), with horizontal reach `rho`
 * and support h(ux, uz), stays inside the crown cell and the maxR disc; -1 if even the axis fails.
 */
function fitScale(m: TreeModel, ox: number, oz: number, maxR: number, rho: number, h: (ux: number, uz: number) => number): number {
  if (rho > maxR) return -1;
  let t = 1;
  const hd = Math.sqrt(ox * ox + oz * oz);
  if (hd + rho > maxR) t = (maxR - rho) / hd;
  const cell = m.cell;
  for (let j = 0; j < cell.length; j += 3) {
    const ux = cell[j];
    const uz = cell[j + 1];
    const s = cell[j + 2];
    const dot = ox * ux + oz * uz;
    // h ≤ rho: planes the object cannot reach anywhere on [axis, axis + (ox, oz)] need no support query.
    if (rho <= s && dot + rho <= s) continue;
    const room = s - h(ux, uz);
    if (room < 0) return -1;
    if (dot > room) t = Math.min(t, room / dot);
  }
  return Math.max(0, t);
}

/**
 * Pulls a cluster towards the trunk axis just enough for its whole deformed surface to stay inside
 * the crown cell and within maxR; shrinks it when it cannot fit even on the axis. Null if hopeless.
 */
function fitCluster(m: TreeModel, c: Cluster, maxR: number): Cluster | null {
  if (maxR === Infinity && m.cell.length === 0) return c; // unconstrained crown
  const h = (ux: number, uz: number): number => support(c, ux, uz);
  for (let iter = 0; iter < 8; iter++) {
    const ox = c.x - m.bx;
    const oz = c.z - m.bz;
    const t = fitScale(m, ox, oz, maxR, horizontalExtent(c), h);
    if (t >= 0) {
      c.x = m.bx + ox * t;
      c.z = m.bz + oz * t;
      return c;
    }
    c.r *= 0.82;
    if (c.r < 2) break;
  }
  return null;
}

/** Fits and adds a cluster (dropped if it cannot fit the crown at all). */
function pushFitted(m: TreeModel, c: Cluster, maxR: number): void {
  const f = fitCluster(m, c, maxR);
  if (f) m.clusters.push(f);
}

/** Typical relative reach, for trial positions before a cluster's lobes exist. */
const TRIAL_REACH = 1.15;

/**
 * Pulls (x, z) towards the base axis until a round object of horizontal reach `rho` centred there
 * fits the crown cell and the maxR disc (onto the axis when nothing fits); result in `trial`.
 */
function fitPoint(m: TreeModel, x: number, z: number, rho: number, maxR: number): number[] {
  const t = fitScale(m, x - m.bx, z - m.bz, maxR, rho, () => rho);
  const k = t < 0 ? 0 : t;
  trial[0] = m.bx + (x - m.bx) * k;
  trial[1] = m.bz + (z - m.bz) * k;
  return trial;
}

/** Trial centre (x, z) for a cluster of radius r → pulled inside the cell assuming TRIAL_REACH; result in `trial`. */
const trialFit = (m: TreeModel, x: number, z: number, r: number, maxR: number): number[] => fitPoint(m, x, z, r * TRIAL_REACH + 0.5, maxR);

const trial = [0, 0];

/**
 * Places up to n clusters in the crown envelope (centre c, horizontal radius rh, vertical rv), each
 * fitted into the crown cell and the maxR disc and kept `spacing`·(r₁ + r₂) apart from the others.
 */
function placeClusters(
  m: TreeModel,
  rng: Rng,
  n: number,
  cx: number,
  cy: number,
  cz: number,
  rh: number,
  rv: number,
  maxR: number,
  rMin: number,
  rMax: number,
  uMin: number,
  rhoMin: number,
  spacing: number,
  sUp: number,
  sDown: number,
): void {
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const r = rng.range(rMin, rMax);
      const a = rng.range(0, TAU);
      const u = rng.range(uMin, 1);
      const rho = rng.range(rhoMin, 1);
      const s = Math.sqrt(1 - u * u);
      const y = cy + rho * rv * u;
      const p = trialFit(m, cx + rho * rh * s * Math.cos(a), cz + rho * rh * s * Math.sin(a), r, maxR);
      let ok = true;
      for (const o of m.clusters) {
        const dx = o.x - p[0];
        const dy = o.y - y;
        const dz = o.z - p[1];
        const min = spacing * (o.r + r);
        if (dx * dx + dy * dy + dz * dz < min * min) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pushFitted(m, makeCluster(rng, p[0], y, p[1], r, sUp, sDown), maxR);
      break;
    }
  }
}

/**
 * Broadleaf crown: clusters spread over the crown disc (radius maxR around the base axis) with a
 * minimum horizontal spacing, so the crown covers its footprint with a few gaps; heights follow a
 * dome (centre high, rim low) with jitter, which keeps the silhouette irregular.
 */
function placeCrownLayer(
  m: TreeModel,
  rng: Rng,
  n: number,
  cx: number,
  cy: number,
  cz: number,
  maxR: number,
  rv: number,
  rMin: number,
  rMax: number,
  sUp: number,
  sDown: number,
): void {
  const first = m.clusters.length;
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const r = rng.range(rMin, rMax);
      const a = rng.range(0, TAU);
      const t = Math.sqrt(rng.next());
      const d = t * maxR;
      const y = cy + rv * (0.45 * (1 - t * t) - 0.3 * t + rng.range(-0.22, 0.22));
      const p = trialFit(m, cx + Math.cos(a) * d, cz + Math.sin(a) * d, r, maxR);
      let ok = true;
      for (let k = first; k < m.clusters.length; k++) {
        const o = m.clusters[k];
        const min = SPACING_2D * (o.r + r);
        if ((o.x - p[0]) * (o.x - p[0]) + (o.z - p[1]) * (o.z - p[1]) < min * min) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pushFitted(m, makeCluster(rng, p[0], y, p[1], r, sUp, sDown), maxR);
      break;
    }
  }
}

/** Branch from a (radius ra) to the cluster centre: a bowed two-segment limb ending thin. */
function addBranch(m: TreeModel, rng: Rng, ax: number, ay: number, az: number, c: Cluster, ra: number, bow: number, thinTip: boolean): void {
  const dx = c.x - ax;
  const dy = c.y - ay;
  const dz = c.z - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const j = 0.08 * len;
  const mx = ax + dx * 0.5 + rng.range(-j, j);
  const my = ay + dy * 0.5 + bow * len;
  const mz = az + dz * 0.5 + rng.range(-j, j);
  const rm = Math.max(MIN_LIMB_R, (ra + MIN_LIMB_R) * 0.5);
  m.limbs.push({ ax, ay, az, bx: mx, by: my, bz: mz, ra, rb: rm });
  m.limbs.push({ ax: mx, ay: my, az: mz, bx: c.x, by: c.y, bz: c.z, ra: thinTip ? 0 : rm, rb: thinTip ? 0 : MIN_LIMB_R });
  addInnerTwigs(m, rng, c);
}

/**
 * Twigs inside a cluster so every foliage voxel stays a few steps from wood (a felled tree takes its
 * whole crown along): 32 twigs from the centre into the middle of a shell cluster, or 6 short
 * horizontal ones through a large solid cluster (flat pine pads). Hidden inside the foliage.
 */
function addInnerTwigs(m: TreeModel, rng: Rng, c: Cluster): void {
  const rot = rng.range(0, TAU);
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  if (isShell(c)) {
    const tn = SHELL_T / Math.min(1, c.sUp, c.sDown);
    for (let k = 0; k < SHELL_TWIGS.length; k += 3) {
      const ix = SHELL_TWIGS[k];
      const iy = SHELL_TWIGS[k + 1];
      const iz = SHELL_TWIGS[k + 2];
      const nx = ix * cr - iz * sr;
      const nz = ix * sr + iz * cr;
      const q = c.r * (1 + lobeAt(c.lobes, nx, iy, nz)) - tn * 0.5;
      const s = iy > 0 ? c.sUp : c.sDown;
      m.limbs.push({ ax: c.x, ay: c.y, az: c.z, bx: c.x + nx * q, by: c.y + iy * q * s, bz: c.z + nz * q, ra: 0, rb: 0 });
    }
  } else if (c.r >= 7) {
    for (let k = 0; k < 6; k++) {
      const nx = Math.cos(rot + (k * TAU) / 6);
      const nz = Math.sin(rot + (k * TAU) / 6);
      const q = 0.62 * c.r * (1 + lobeAt(c.lobes, nx, 0, nz));
      m.limbs.push({ ax: c.x, ay: c.y, az: c.z, bx: c.x + nx * q, by: c.y, bz: c.z + nz * q, ra: 0, rb: 0 });
    }
  }
}

/** 32 well-spread unit directions (icosahedron + dodecahedron vertices), flattened. */
const SHELL_TWIGS: number[] = (() => {
  const g = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [
    [-1, g, 0], [1, g, 0], [-1, -g, 0], [1, -g, 0],
    [0, -1, g], [0, 1, g], [0, -1, -g], [0, 1, -g],
    [g, 0, -1], [g, 0, 1], [-g, 0, -1], [-g, 0, 1],
  ];
  for (const a of [-1, 1]) for (const b of [-1, 1]) for (const c of [-1, 1]) v.push([a, b, c]);
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) v.push([0, a / g, b * g], [a / g, b * g, 0], [a * g, 0, b / g]);
  }
  return v.flatMap((p) => {
    const n = Math.hypot(p[0], p[1], p[2]);
    return p.map((c) => c / n);
  });
})();

function addRoots(m: TreeModel, rng: Rng, rT: number, n: number): void {
  const a0 = rng.range(0, TAU);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i * TAU) / n + rng.range(-0.35, 0.35);
    m.roots.push({ dx: Math.cos(a), dz: Math.sin(a), len: rT * rng.range(2.2, 3.6) + 3, h0: rT * rng.range(0.7, 1), w0: rT * 0.5 + 0.6 });
  }
}

function setLean(m: TreeModel, rng: Rng, lean: number, bend: number): void {
  const a = rng.range(0, TAU);
  m.c2x = Math.cos(a) * lean;
  m.c2z = Math.sin(a) * lean;
  const b = rng.range(0, TAU);
  m.c1x = m.c2x * 0.5 + Math.cos(b) * bend;
  m.c1z = m.c2z * 0.5 + Math.sin(b) * bend;
}

interface BroadleafSpec {
  bark: number;
  leaves: number;
  height: [number, number];
  trunkR: [number, number];
  crownR: [number, number];
  fork: [number, number];
  leader: [number, number];
  limbs: [number, number];
  clusters: [number, number];
  clusterR: [number, number];
  sUp: number;
  sDown: number;
  bend: number;
}

const OAK: BroadleafSpec = {
  bark: B.OAK_LOG,
  leaves: B.OAK_LEAVES,
  height: [120, 180],
  trunkR: [2.1, 3.4],
  crownR: [44, 56],
  fork: [0.26, 0.34],
  leader: [0.6, 0.68],
  limbs: [3, 5],
  clusters: [11, 15],
  clusterR: [10.5, 17.5],
  sUp: 0.9,
  sDown: 0.68,
  bend: 0.012,
};

const APPLE: BroadleafSpec = {
  bark: B.OAK_LOG,
  leaves: B.OAK_LEAVES,
  height: [40, 60],
  trunkR: [1.3, 1.9],
  crownR: [22, 30],
  fork: [0.26, 0.36],
  leader: [0.36, 0.45],
  limbs: [3, 5],
  clusters: [6, 10],
  clusterR: [7, 10],
  sUp: 0.9,
  sDown: 0.72,
  bend: 0.05,
};

/** Oak and apple: a trunk forking into a few scaffold limbs that carry the foliage clusters. */
function buildBroadleaf(p: TreeParams, rng: Rng, scale: number, maxR: number, s: BroadleafSpec): TreeModel {
  const m = emptyModel(p.x, p.y, p.z, s.bark, s.leaves, cellOf(p));
  const H = rng.range(s.height[0], s.height[1]) * scale;
  const rT = rng.range(s.trunkR[0], s.trunkR[1]) * Math.sqrt(scale);
  const crownR = Math.min(rng.range(s.crownR[0], s.crownR[1]) * scale, maxR);
  const forkY = p.y + H * rng.range(s.fork[0], s.fork[1]);
  m.trunkTop = p.y + H * rng.range(s.leader[0], s.leader[1]);
  m.r0 = rT;
  m.r1 = Math.max(0.95, rT * 0.42);
  m.flare = rT * 0.55;
  setLean(m, rng, Math.min(rng.range(0, 0.035) * H, crownR * 0.22), s.bend * H);
  addRoots(m, rng, rT, rng.int(4, 7));

  axisAt(m, p.y + H * 0.6, axis);
  const ccx = axis[0];
  const ccz = axis[1];
  const ccy = p.y + H * 0.6;
  const rv = H * 0.37;
  const rMax = clamp(crownR * 0.5, s.clusterR[0], s.clusterR[1] * Math.max(1, scale));
  const rMin = Math.max(s.clusterR[0] * 0.75, rMax * 0.75);
  const n = rng.int(s.clusters[0], s.clusters[1]);
  placeCrownLayer(m, rng, n - 2, ccx, ccy, ccz, crownR, rv, rMin, rMax, s.sUp, s.sDown);
  // One or two clusters on top round off the dome.
  for (let i = 0; i < 2; i++) {
    const a = rng.range(0, TAU);
    const d = rng.range(0, 0.3) * crownR;
    const c = makeCluster(rng, ccx + Math.cos(a) * d, ccy + rv * rng.range(0.55, 0.75), ccz + Math.sin(a) * d, rng.range(rMin, rMax), s.sUp, s.sDown);
    pushFitted(m, c, crownR);
  }

  // Scaffold limbs from the fork, spread around the trunk.
  const nL = rng.int(s.limbs[0], s.limbs[1]);
  const a0 = rng.range(0, TAU);
  const limbEnds: number[] = [];
  for (let k = 0; k < nL; k++) {
    const a = a0 + (k * TAU) / nL + rng.range(-0.4, 0.4);
    const ay = forkY + rng.range(0, 0.08) * H;
    axisAt(m, ay, axis);
    const reach = crownR * rng.range(0.35, 0.52);
    const rb = Math.max(MIN_LIMB_R, rT * 0.3);
    const fit = Math.max(0, fitScale(m, Math.cos(a) * reach, Math.sin(a) * reach, crownR, rb + 1, () => rb + 1));
    const ex = m.bx + Math.cos(a) * reach * fit;
    const ez = m.bz + Math.sin(a) * reach * fit;
    const ey = p.y + H * rng.range(0.44, 0.56);
    const mx = (axis[0] + ex) * 0.5 + rng.range(-2, 2);
    const mz = (axis[1] + ez) * 0.5 + rng.range(-2, 2);
    const my = (ay + ey) * 0.5 + rng.range(1, 5);
    const ra = Math.max(MIN_LIMB_R, rT * 0.6);
    const rm = Math.max(MIN_LIMB_R, rT * 0.45);
    m.limbs.push({ ax: axis[0], ay, az: axis[1], bx: mx, by: my, bz: mz, ra, rb: rm });
    m.limbs.push({ ax: mx, ay: my, az: mz, bx: ex, by: ey, bz: ez, ra: rm, rb });
    limbEnds.push(ex, ey, ez, rb);
  }
  // Each cluster hangs on the nearest limb end, or on the leader when it sits above the trunk.
  axisAt(m, m.trunkTop, axis);
  const tx = axis[0];
  const tz = axis[1];
  for (const c of m.clusters) {
    let bx = tx;
    let by = m.trunkTop - 2;
    let bz = tz;
    let br = Math.max(MIN_LIMB_R, m.r1);
    let best = (c.x - tx) * (c.x - tx) + (c.z - tz) * (c.z - tz) + 0.25 * (c.y - by) * (c.y - by);
    for (let k = 0; k < limbEnds.length; k += 4) {
      const dx = c.x - limbEnds[k];
      const dy = c.y - limbEnds[k + 1];
      const dz = c.z - limbEnds[k + 2];
      const d = dx * dx + dz * dz + 0.25 * dy * dy;
      if (d < best) {
        best = d;
        bx = limbEnds[k];
        by = limbEnds[k + 1];
        bz = limbEnds[k + 2];
        br = limbEnds[k + 3];
      }
    }
    addBranch(m, rng, bx, by, bz, c, Math.max(MIN_LIMB_R, br * 0.8), 0.08, false);
  }
  return m;
}

/** Birch: tall slender white trunk, narrow airy crown of small clusters on thin arching branches. */
function buildBirch(p: TreeParams, rng: Rng, scale: number, maxR: number): TreeModel {
  const m = emptyModel(p.x, p.y, p.z, B.BIRCH_LOG, B.BIRCH_LEAVES, cellOf(p));
  const H = rng.range(140, 200) * scale;
  const rT = rng.range(1.1, 1.75) * Math.sqrt(scale);
  const crownR = Math.min(rng.range(22, 32) * scale, maxR);
  m.trunkTop = p.y + H * 0.9;
  m.r0 = rT;
  m.r1 = 0.95;
  m.flare = rT * 0.4;
  setLean(m, rng, Math.min(rng.range(0, 0.025) * H, crownR * 0.25), 0.015 * H);
  addRoots(m, rng, rT, rng.int(3, 5));
  const crownBase = p.y + H * rng.range(0.42, 0.52);
  const ccy = p.y + H * 0.72;
  const rMax = Math.min(10.5 * scale, crownR * 0.45);
  const rMin = Math.min(7.5 * scale, rMax);
  axisAt(m, m.trunkTop, axis);
  pushFitted(m, makeCluster(rng, axis[0], m.trunkTop + rMax * 0.5, axis[1], rMax, 0.9, 1.25), crownR);
  axisAt(m, ccy, axis);
  placeClusters(m, rng, rng.int(10, 15) - 1, axis[0], ccy, axis[1], crownR, H * 0.27, crownR, rMin, rMax, -0.7, 0.3, 0.92, 0.9, 1.25);
  for (const c of m.clusters) {
    const hd = Math.hypot(c.x - m.bx, c.z - m.bz);
    const ay = clamp(c.y - hd * 0.6 - rng.range(4, 12), crownBase, m.trunkTop - 3);
    axisAt(m, ay, axis);
    // Thin arching branches: up and out, then drooping into the cluster.
    addBranch(m, rng, axis[0], ay, axis[1], c, MIN_LIMB_R, 0.18, true);
  }
  return m;
}

/** Scots pine: straight reddish trunk, branches only in the upper half, layered flat needle pads. */
function buildPine(p: TreeParams, rng: Rng, scale: number, maxR: number): TreeModel {
  const m = emptyModel(p.x, p.y, p.z, B.PINE_LOG, B.PINE_NEEDLES, cellOf(p));
  const H = rng.range(150, 220) * scale;
  const rT = rng.range(1.5, 2.5) * Math.sqrt(scale);
  const crownR = Math.min(rng.range(26, 36) * scale, maxR);
  m.trunkTop = p.y + H * 0.97;
  m.r0 = rT;
  m.r1 = Math.max(0.95, rT * 0.38);
  m.flare = rT * 0.45;
  setLean(m, rng, Math.min(rng.range(0, 0.008) * H, 3), 0.004 * H);
  addRoots(m, rng, rT, rng.int(3, 6));
  const crownBase = p.y + H * rng.range(0.55, 0.62);
  const top = p.y + H * 0.93;
  const step = rng.range(10, 15) * Math.sqrt(scale);
  const levels = Math.max(2, Math.floor((top - crownBase) / step) + 1);
  const target = Math.min(13, rng.int(9, 14));
  let rot = rng.range(0, TAU);
  for (let l = 0; l < levels && m.clusters.length < target; l++) {
    const yl = crownBase + l * step + rng.range(-2, 2);
    const t = (yl - crownBase) / Math.max(1, top - crownBase);
    const width = (0.62 + 0.38 * Math.sin(Math.PI * (0.15 + 0.7 * t))) * (1 - 0.5 * t * t * t);
    const nb = Math.min(target - m.clusters.length, Math.max(1, Math.round((target / levels) * rng.range(0.8, 1.25))));
    axisAt(m, yl, axis);
    for (let k = 0; k < nb; k++) {
      const a = rot + (k * TAU) / nb + rng.range(-0.5, 0.5);
      const padR = Math.min(rng.range(9, 14) * (0.7 + 0.3 * width) * Math.sqrt(scale), crownR * 0.45);
      const reach = Math.max(4, (crownR - padR * (1 + LOBE_MAX)) * width * rng.range(0.75, 1));
      const ex = axis[0] + Math.cos(a) * reach;
      const ez = axis[1] + Math.sin(a) * reach;
      const ey = yl + reach * rng.range(-0.05, 0.2);
      const pad = fitCluster(m, makeCluster(rng, ex, ey + 2, ez, padR, 0.55, 0.38), crownR);
      if (!pad) continue;
      m.limbs.push({ ax: axis[0], ay: yl, az: axis[1], bx: pad.x, by: ey, bz: pad.z, ra: Math.max(MIN_LIMB_R, rT * 0.42), rb: MIN_LIMB_R });
      // The pad's own twigs start at its centre, two voxels above the branch end.
      m.limbs.push({ ax: pad.x, ay: ey, az: pad.z, bx: pad.x, by: pad.y, bz: pad.z, ra: 0, rb: 0 });
      addInnerTwigs(m, rng, pad);
      m.clusters.push(pad);
    }
    rot += 2.4; // golden-angle-ish whorl rotation
  }
  axisAt(m, m.trunkTop, axis);
  pushFitted(m, makeCluster(rng, axis[0], m.trunkTop + 2, axis[1], rng.range(7, 9) * Math.sqrt(scale), 0.9, 0.6), crownR);
  // Dead branch stubs on the lower trunk (self-pruned).
  const stubs = rng.int(3, 7);
  for (let i = 0; i < stubs; i++) {
    const ys = p.y + H * rng.range(0.22, 0.52);
    const a = rng.range(0, TAU);
    const len = rT + rng.range(3, 6);
    axisAt(m, ys, axis);
    m.limbs.push({ ax: axis[0], ay: ys, az: axis[1], bx: axis[0] + Math.cos(a) * len, by: ys - rng.range(0, 2), bz: axis[1] + Math.sin(a) * len, ra: 0, rb: 0 });
  }
  return m;
}

/** Young birch 1.5–3 m: one-voxel stem, a few twigs and small leaf clumps. */
function buildSapling(p: TreeParams, rng: Rng, scale: number, maxR: number): TreeModel {
  const m = emptyModel(p.x, p.y, p.z, B.BIRCH_LOG, B.BIRCH_LEAVES, cellOf(p));
  const H = rng.range(15, 30) * scale;
  m.thin = true;
  m.trunkTop = p.y + H * 0.85;
  setLean(m, rng, Math.min(rng.range(0, 0.08) * H, maxR * 0.3), 0.04 * H);
  const r = clamp(H / 6, 2.5, 4.5);
  const rc = Math.min(r, maxR / (1 + LOBE_MAX));
  axisAt(m, m.trunkTop, axis);
  pushFitted(m, makeCluster(rng, axis[0], m.trunkTop + rc * 0.4, axis[1], rc, 1, 0.85), maxR);
  const twigs = rng.int(2, 4);
  for (let i = 0; i < twigs; i++) {
    const ty = p.y + H * rng.range(0.45, 0.8);
    axisAt(m, ty, axis);
    const a = rng.range(0, TAU);
    const len = Math.min(rng.range(3, 7) * scale, Math.max(1, maxR - rc * (1 + LOBE_MAX)));
    const ex = axis[0] + Math.cos(a) * len;
    const ez = axis[1] + Math.sin(a) * len;
    const ey = ty + len * 0.6;
    const c = fitCluster(m, makeCluster(rng, ex, ey, ez, rc * rng.range(0.7, 0.95), 1, 0.85), maxR);
    if (!c) continue;
    m.limbs.push({ ax: axis[0], ay: ty, az: axis[1], bx: c.x, by: c.y, bz: c.z, ra: 0, rb: 0 });
    m.clusters.push(c);
  }
  return m;
}

/**
 * Dead tree: bare, partly broken limbs and a broken top showing WOOD. Branch and twig tips stay inside
 * the crown cell like foliage does, so the bare crown never touches a neighbour's wood.
 */
function buildDead(p: TreeParams, rng: Rng, scale: number, maxR: number): TreeModel {
  const m = emptyModel(p.x, p.y, p.z, rng.chance(0.5) ? B.OAK_LOG : B.PINE_LOG, B.AIR, cellOf(p));
  const H = rng.range(70, 130) * scale;
  const rT = rng.range(1.8, 3) * Math.sqrt(scale);
  m.trunkTop = p.y + H * rng.range(0.75, 0.95);
  m.r0 = rT;
  m.r1 = Math.max(0.95, rT * 0.6);
  m.flare = rT * 0.5;
  setLean(m, rng, rng.range(0, 0.04) * H, 0.02 * H);
  addRoots(m, rng, rT, rng.int(3, 6));
  const n = rng.int(4, 8);
  for (let i = 0; i < n; i++) {
    const ay = p.y + H * rng.range(0.35, 0.85);
    if (ay > m.trunkTop - 2) continue;
    axisAt(m, ay, axis);
    const a = rng.range(0, TAU);
    const elev = rng.range(0.25, 0.95);
    let len = H * rng.range(0.15, 0.4) * (rng.chance(0.3) ? 0.4 : 1);
    len = Math.min(len, Math.max(3, (maxR - 2) / Math.cos(elev)));
    const tip = fitPoint(m, axis[0] + Math.cos(a) * Math.cos(elev) * len, axis[1] + Math.sin(a) * Math.cos(elev) * len, MIN_LIMB_R + 1, maxR);
    const ex = tip[0];
    const ez = tip[1];
    const ey = ay + Math.sin(elev) * len;
    const ra = Math.max(MIN_LIMB_R, rT * 0.42);
    m.limbs.push({ ax: axis[0], ay, az: axis[1], bx: ex, by: ey, bz: ez, ra, rb: MIN_LIMB_R });
    const twigs = len > 12 ? rng.int(1, 3) : 0;
    for (let k = 0; k < twigs; k++) {
      const ta = a + rng.range(-0.9, 0.9);
      const tl = Math.min(rng.range(6, 16), Math.max(2, maxR - Math.hypot(ex - m.bx, ez - m.bz) - 1));
      const ty = ey + tl * rng.range(0.1, 0.7);
      const twigTip = fitPoint(m, ex + Math.cos(ta) * tl, ez + Math.sin(ta) * tl, 1, maxR);
      m.limbs.push({ ax: ex, ay: ey, az: ez, bx: twigTip[0], by: ty, bz: twigTip[1], ra: 0, rb: 0 });
    }
  }
  return m;
}

function computeBounds(m: TreeModel): void {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  const add = (ax: number, ay: number, az: number, bx: number, by: number, bz: number): void => {
    if (ax < x0) x0 = ax;
    if (ay < y0) y0 = ay;
    if (az < z0) z0 = az;
    if (bx > x1) x1 = bx;
    if (by > y1) y1 = by;
    if (bz > z1) z1 = bz;
  };
  // Trunk (all slices, incl. the buried part and its anchoring).
  const rMax = m.thin ? 0.5 : m.r0 + m.flare;
  for (let yy = m.y - BURY; yy <= m.trunkTop; yy += 4) {
    axisAt(m, yy, axis);
    add(axis[0] - rMax, yy, axis[1] - rMax, axis[0] + rMax, yy + 4, axis[1] + rMax);
  }
  if (!m.thin) add(m.bx - rMax, m.y - BURY - ANCHOR - 1, m.bz - rMax, m.bx + rMax, m.trunkTop, m.bz + rMax);
  for (const r of m.roots) {
    const reach = m.r0 + r.len + r.w0 + 1;
    add(m.bx - reach, m.y - 3 - ANCHOR - 1, m.bz - reach, m.bx + reach, m.y + r.h0 + 1, m.bz + reach);
  }
  for (const l of m.limbs) {
    const r = Math.max(l.ra, l.rb, 0.5);
    add(Math.min(l.ax, l.bx) - r, Math.min(l.ay, l.by) - r, Math.min(l.az, l.bz) - r, Math.max(l.ax, l.bx) + r, Math.max(l.ay, l.by) + r, Math.max(l.az, l.bz) + r);
  }
  for (const c of m.clusters) {
    const R = c.r * (1 + LOBE_MAX);
    add(c.x - R, c.y - R * c.sDown, c.z - R, c.x + R, c.y + R * c.sUp, c.z + R);
  }
  m.bounds.min[0] = Math.floor(x0) - 1;
  m.bounds.min[1] = Math.floor(y0) - 1;
  m.bounds.min[2] = Math.floor(z0) - 1;
  m.bounds.max[0] = Math.ceil(x1) + 2;
  m.bounds.max[1] = Math.ceil(y1) + 2;
  m.bounds.max[2] = Math.ceil(z1) + 2;
}

// ------------------------------------------------------------------------------------------ raster

/** Trunk as stacked discs (bark ring, WOOD core) from BURY voxels underground to the top; anchored below. */
function rasterTrunk(w: VoxelWriter, m: TreeModel): void {
  if (m.thin) {
    // A sapling roots one voxel into whatever it grows on (ground, gutter, roof) and never anchors
    // through air, so it cannot punch a log column through a thin roof.
    axisAt(m, m.trunkTop, axis);
    putRoot(w, Math.floor(m.bx), m.y - 1, Math.floor(m.bz), m.bark);
    rasterLine(w, m.bx, m.y, m.bz, axis[0], m.trunkTop, axis[1], m.bark);
    return;
  }
  const bottom = m.y - BURY;
  const rMax = m.r0 + m.flare + 1;
  const box = scratchBox;
  if (!clipBox(w, m.bx - rMax - Math.abs(m.c1x) - Math.abs(m.c2x), bottom, m.bz - rMax - Math.abs(m.c1z) - Math.abs(m.c2z), m.bx + rMax + Math.abs(m.c1x) + Math.abs(m.c2x), m.trunkTop, m.bz + rMax + Math.abs(m.c1z) + Math.abs(m.c2z), box)) {
    return;
  }
  const xa = box.x0;
  const xb = box.x1;
  const za = box.z0;
  const zb = box.z1;
  const top = Math.ceil(m.trunkTop);
  for (let yy = bottom; yy < top; yy++) {
    if (yy < 0) continue;
    axisAt(m, yy + 0.5, axis);
    const cx = axis[0];
    const cz = axis[1];
    const r = trunkRadius(m, yy + 0.5);
    const r2 = r * r;
    const core2 = r >= 1.4 ? (r - 1) * (r - 1) : -1;
    const x0 = Math.max(xa, Math.floor(cx - r));
    const x1 = Math.min(xb, Math.ceil(cx + r));
    const z0 = Math.max(za, Math.floor(cz - r));
    const z1 = Math.min(zb, Math.ceil(cz + r));
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      for (let z = z0; z < z1; z++) {
        const dz = z + 0.5 - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const id = d2 <= core2 ? B.WOOD : m.bark;
        if (yy < m.y) putRoot(w, x, yy, z, id); // the buried part never cuts into built materials
        else if (id === B.WOOD) w.set(x, yy, z, B.WOOD);
        else putBark(w, x, yy, z, m.bark);
        if (yy === bottom) anchorDown(w, x, yy - 1, z, m.bark, ANCHOR);
      }
    }
  }
}

/** Root ridge: a buttress tapering away from the trunk, embedded in the ground and anchored on slopes. */
function rasterRoot(w: VoxelWriter, m: TreeModel, r: Root): void {
  const reach = m.r0 + r.len;
  const box = scratchBox;
  if (!clipBox(w, m.bx - reach - r.w0, m.y - 3, m.bz - reach - r.w0, m.bx + reach + r.w0, m.y + r.h0, m.bz + reach + r.w0, box)) return;
  const xa = box.x0;
  const xb = box.x1;
  const za = box.z0;
  const zb = box.z1;
  for (let x = xa; x < xb; x++) {
    const px = x + 0.5 - m.bx;
    for (let z = za; z < zb; z++) {
      const pz = z + 0.5 - m.bz;
      const u = px * r.dx + pz * r.dz;
      if (u < m.r0 * 0.5 || u > reach) continue;
      const v = -px * r.dz + pz * r.dx;
      const s = Math.max(0, (u - m.r0) / r.len);
      const hw = Math.max(0.75, r.w0 * (1 - 0.55 * s)); // ≥ 1.5 voxels wide keeps diagonal ridges face-connected
      if (Math.abs(v) > hw) continue;
      const q = v / hw;
      const hr = r.h0 * Math.pow(1 - s, 1.6) * Math.sqrt(1 - q * q);
      const top = m.y - 1 + Math.round(hr);
      for (let y = top; y >= m.y - 3; y--) putRoot(w, x, y, z, m.bark);
      anchorDown(w, x, m.y - 4, z, m.bark, ANCHOR);
    }
  }
}

/** Foliage cluster: lobed ellipsoid (flatter below), a shell around an air core when large; setSoft only. */
function rasterCluster(w: VoxelWriter, c: Cluster, leaves: number): void {
  const R = c.r * (1 + LOBE_MAX);
  const box = scratchBox;
  if (!clipBox(w, c.x - R, c.y - R * c.sDown, c.z - R, c.x + R, c.y + R * c.sUp, c.z + R, box)) return;
  const shell = isShell(c);
  const tn = SHELL_T / Math.min(1, c.sUp, c.sDown);
  const core = shell ? c.r * (1 + LOBE_MIN) - tn : -1;
  const R2 = R * R;
  const core2 = core > 0 ? core * core : -1;
  const invUp = 1 / c.sUp;
  const invDown = 1 / c.sDown;
  const lobes = c.lobes;
  for (let x = box.x0; x < box.x1; x++) {
    const dx = x + 0.5 - c.x;
    for (let z = box.z0; z < box.z1; z++) {
      const dz = z + 0.5 - c.z;
      const h2 = dx * dx + dz * dz;
      if (h2 > R2) continue;
      // Vertical extent of the outer bound in this column, and of the air core to skip.
      const span = Math.sqrt(R2 - h2);
      const ya = Math.max(box.y0, Math.floor(c.y - span * c.sDown));
      const yb = Math.min(box.y1, Math.ceil(c.y + span * c.sUp));
      const cspan = core2 > h2 ? Math.sqrt(core2 - h2) : -1;
      const ca = cspan > 0 ? c.y - cspan * c.sDown : 0;
      const cb = cspan > 0 ? c.y + cspan * c.sUp : 0;
      for (let y = ya; y < yb; y++) {
        const cy = y + 0.5;
        if (cspan > 0 && cy > ca && cy < cb) continue;
        const dy = cy - c.y;
        const dyn = dy > 0 ? dy * invUp : dy * invDown;
        const q2 = h2 + dyn * dyn;
        if (q2 > R2 || q2 < core2) continue;
        const q = Math.sqrt(q2);
        const inv = q > 1e-6 ? 1 / q : 0;
        const re = c.r * (1 + lobeAt(lobes, dx * inv, dyn * inv, dz * inv));
        if (q > re) continue;
        if (shell && q < re - tn) continue;
        w.setSoft(x, y, z, leaves);
      }
    }
  }
}
