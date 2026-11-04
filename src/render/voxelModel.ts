/**
 * Small voxel models ("centimetre" models for tools, items, mobs, doors; also 10 cm models built
 * from world voxels for falling bodies). OWNER: agent "art".
 */
import * as THREE from 'three';
import { srgbToLinear } from '../core/math';

/**
 * Fill colour of the VoxelGrid shapes: a constant sRGB 0xRRGGBB or a function of the integer cell.
 * A negative value clears the cell instead (carving), exactly like `VoxelGrid.set`.
 */
export type CellColor = number | ((x: number, y: number, z: number) => number);

/** Fill colour that carves: shapes drawn with it clear the cells they cover. */
export const EMPTY = -1;

/** Dense colour grid. A cell holds 0 (empty) or an sRGB colour 0xRRGGBB stored as (rgb | 0xFF000000). */
export class VoxelGrid {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly data: Uint32Array;

  constructor(sx: number, sy: number, sz: number) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.data = new Uint32Array(sx * sy * sz);
  }

  index(x: number, y: number, z: number): number {
    return x + this.sx * (y + this.sy * z);
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  /** Sets a cell to sRGB colour `rgb` (0xRRGGBB); `rgb < 0` clears it. Out-of-bounds writes are ignored. */
  set(x: number, y: number, z: number, rgb: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.index(x, y, z)] = rgb < 0 ? 0 : (rgb | 0xff000000) >>> 0;
  }

  /** 0 if empty, otherwise the sRGB colour 0xRRGGBB. */
  get(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return 0;
    const v = this.data[this.index(x, y, z)];
    return v === 0 ? 0 : v & 0xffffff;
  }

  filled(x: number, y: number, z: number): boolean {
    return this.inBounds(x, y, z) && this.data[this.index(x, y, z)] !== 0;
  }

  /** Box [x0,x1)×[y0,y1)×[z0,z1). Colour may be a function of the cell for texture-like detail. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: CellColor): void {
    // Cells whose centre lies inside the half-open box: exact for integer bounds.
    const xa = Math.max(0, Math.ceil(x0 - 0.5));
    const xb = Math.min(this.sx, Math.ceil(x1 - 0.5));
    const ya = Math.max(0, Math.ceil(y0 - 0.5));
    const yb = Math.min(this.sy, Math.ceil(y1 - 0.5));
    const za = Math.max(0, Math.ceil(z0 - 0.5));
    const zb = Math.min(this.sz, Math.ceil(z1 - 0.5));
    for (let z = za; z < zb; z++) {
      for (let y = ya; y < yb; y++) {
        let i = this.index(xa, y, z);
        for (let x = xa; x < xb; x++, i++) this.paint(i, x, y, z, color);
      }
    }
  }

  /** Cells whose centre is within the ellipsoid (centre, radii). */
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: CellColor): void {
    const [xa, xb] = span(cx - rx, cx + rx, this.sx);
    const [ya, yb] = span(cy - ry, cy + ry, this.sy);
    const [za, zb] = span(cz - rz, cz + rz, this.sz);
    for (let z = za; z < zb; z++) {
      const dz = (z + 0.5 - cz) / rz;
      const dz2 = dz * dz;
      if (dz2 > 1) continue;
      for (let y = ya; y < yb; y++) {
        const dy = (y + 0.5 - cy) / ry;
        const dyz = dz2 + dy * dy;
        if (dyz > 1) continue;
        let i = this.index(xa, y, z);
        for (let x = xa; x < xb; x++, i++) {
          const dx = (x + 0.5 - cx) / rx;
          if (dx * dx + dyz <= 1) this.paint(i, x, y, z, color);
        }
      }
    }
  }

  /**
   * Capsule/cylinder between two points with radii r0 → r1 (tapered). Round ends by default;
   * `flat` cuts the ends off square to the axis (a cylinder / cone frustum).
   */
  capsule(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r0: number,
    r1: number,
    color: CellColor,
    flat = false,
  ): void {
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const len2 = abx * abx + aby * aby + abz * abz;
    const inv = len2 > 0 ? 1 / len2 : 0;
    const r = Math.max(r0, r1);
    const [xa, xb] = span(Math.min(ax, bx) - r, Math.max(ax, bx) + r, this.sx);
    const [ya, yb] = span(Math.min(ay, by) - r, Math.max(ay, by) + r, this.sy);
    const [za, zb] = span(Math.min(az, bz) - r, Math.max(az, bz) + r, this.sz);
    for (let z = za; z < zb; z++) {
      const pz = z + 0.5 - az;
      for (let y = ya; y < yb; y++) {
        const py = y + 0.5 - ay;
        let i = this.index(xa, y, z);
        for (let x = xa; x < xb; x++, i++) {
          const px = x + 0.5 - ax;
          let t = (px * abx + py * aby + pz * abz) * inv;
          if (t < 0 || t > 1) {
            if (flat) continue;
            t = t < 0 ? 0 : 1;
          }
          const rt = r0 + (r1 - r0) * t;
          const qx = abx * t - px;
          const qy = aby * t - py;
          const qz = abz * t - pz;
          if (qx * qx + qy * qy + qz * qz <= rt * rt) this.paint(i, x, y, z, color);
        }
      }
    }
  }

  /**
   * Fills every cell where `sdf(cellCentre) <= 0`. `bounds` [x0, y0, z0, x1, y1, z1] (cells, max
   * exclusive) limits the scan; the whole grid by default.
   */
  sdf(
    fn: (x: number, y: number, z: number) => number,
    color: CellColor,
    bounds?: readonly [number, number, number, number, number, number],
  ): void {
    const xa = Math.max(0, Math.floor(bounds?.[0] ?? 0));
    const ya = Math.max(0, Math.floor(bounds?.[1] ?? 0));
    const za = Math.max(0, Math.floor(bounds?.[2] ?? 0));
    const xb = Math.min(this.sx, Math.ceil(bounds?.[3] ?? this.sx));
    const yb = Math.min(this.sy, Math.ceil(bounds?.[4] ?? this.sy));
    const zb = Math.min(this.sz, Math.ceil(bounds?.[5] ?? this.sz));
    for (let z = za; z < zb; z++) {
      for (let y = ya; y < yb; y++) {
        let i = this.index(xa, y, z);
        for (let x = xa; x < xb; x++, i++) {
          if (fn(x + 0.5, y + 0.5, z + 0.5) <= 0) this.paint(i, x, y, z, color);
        }
      }
    }
  }

  /** Re-colours every filled cell: `fn(rgb, x, y, z)` returns the new sRGB colour (negative clears). */
  recolor(fn: (rgb: number, x: number, y: number, z: number) => number): void {
    const { sx, sy, sz, data } = this;
    let i = 0;
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++, i++) {
          const v = data[i];
          if (v === 0) continue;
          const c = fn(v & 0xffffff, x, y, z);
          data[i] = c < 0 ? 0 : (c | 0xff000000) >>> 0;
        }
      }
    }
  }

  /** Number of filled cells. */
  count(): number {
    let n = 0;
    const data = this.data;
    for (let i = 0; i < data.length; i++) if (data[i] !== 0) n++;
    return n;
  }

  private paint(i: number, x: number, y: number, z: number, color: CellColor): void {
    const c = typeof color === 'number' ? color : color(x, y, z);
    this.data[i] = c < 0 ? 0 : (c | 0xff000000) >>> 0;
  }
}

/** Cells [start, end) of an axis of length n whose centres lie within [lo, hi]. */
function span(lo: number, hi: number, n: number): [number, number] {
  return [Math.max(0, Math.ceil(lo - 0.5)), Math.min(n, Math.floor(hi - 0.5) + 1)];
}

export interface BuildOptions {
  /** World units per grid cell (default 0.1 = 1 cm). Use 1 for 10 cm (world-voxel) models. */
  scale?: number;
  /** Grid-space point that becomes the geometry origin (default: bottom centre [sx/2, 0, sz/2]). */
  origin?: [number, number, number];
  /** Bake per-vertex ambient occlusion (default true). */
  ao?: boolean;
  /**
   * Per-cell brightness jitter amplitude for a natural look (default 0.05). Every cell is darkened,
   * kept or brightened by this fraction (hash of the cell), and faces only merge between cells of
   * equal final colour — large flat models that should mesh into few quads pass 0 and get their
   * detail from coherent colour functions instead.
   */
  jitter?: number;
}

/** Vertex brightness by AO level (0 = both sides and the corner occluded … 3 = open). */
const AO_CURVE = [0.58, 0.72, 0.86, 1] as const;
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR[i] = srgbToLinear(i / 255);

// Scratch reused by every build (grown on demand, never shrunk; no per-face allocations).
let occ = new Uint8Array(0);
/**
 * Filled-cell extents of every grid line, per axis: [lo, hi] (hi < lo = empty line). Axis 0: x-range
 * of row (y, z) at y + sy·z; axis 1: y-range of column (x, z) at x + sx·z; axis 2: z-range of (x, y)
 * at x + sx·y. Slice sweeps only visit cells inside these extents.
 */
const extLo: [Int32Array, Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0), new Int32Array(0)];
const extHi: [Int32Array, Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0), new Int32Array(0)];
/** Face masks of the current slice for the +d and −d directions: colour key (0 = no face) + packed AO. */
let keyPos = new Uint32Array(0);
let keyNeg = new Uint32Array(0);
let aoPos = new Uint8Array(0);
let aoNeg = new Uint8Array(0);
/** Extent of every mask row of the current slice (the rows' filled-cell range along u). */
let rowLo = new Int32Array(0);
let rowHi = new Int32Array(0);
/** 8 ints per quad: dir, slice, u0, v0, width, height, colour key, packed AO. */
let quadBuf = new Int32Array(8 * 1024);
let quadCount = 0;
const jitterDark = new Uint8Array(256);
const jitterBright = new Uint8Array(256);

/**
 * Greedy-meshes the grid (faces merged only when colour and AO match) into an indexed BufferGeometry
 * with `position`, `normal` and linear-space `color` attributes plus bounding box/sphere.
 *
 * Per visible face: classic 3-neighbour vertex AO (4 levels, baked into the vertex colour, quads
 * split along the brighter diagonal), per-cell brightness jitter by a hash of the cell, sRGB → linear.
 * Cost: one pass over the grid (padded occupancy + per-line filled extents), then per axis one sweep
 * of the slices that visits only the filled extent of every line (both face directions at once), plus
 * the faces — a felled tree (~95×145×93 cells, ~110k filled) meshes at scale 1 in a few tens of ms.
 */
export function buildVoxelGeometry(grid: VoxelGrid, opts?: BuildOptions): THREE.BufferGeometry {
  const scale = opts?.scale ?? 0.1;
  const origin = opts?.origin ?? [grid.sx / 2, 0, grid.sz / 2];
  const useAo = opts?.ao ?? true;
  const jitter = Math.min(0.5, Math.max(0, opts?.jitter ?? 0.05));
  if (jitter > 0) {
    for (let i = 0; i < 256; i++) {
      jitterDark[i] = Math.round(i * (1 - jitter));
      jitterBright[i] = Math.min(255, Math.round(i * (1 + jitter)));
    }
  }
  prepareOccupancy(grid);
  quadCount = 0;
  for (let d = 0; d < 3; d++) sweepAxis(grid, d, useAo, jitter > 0);
  return emitGeometry(quadCount, scale, origin);
}

/** Fills the padded occupancy copy (one empty cell around the grid) and the per-line extents. */
function prepareOccupancy(grid: VoxelGrid): void {
  const { sx, sy, sz, data } = grid;
  const px = sx + 2;
  const py = sy + 2;
  const pVol = px * py * (sz + 2);
  if (occ.length < pVol) occ = new Uint8Array(pVol);
  occ.fill(0, 0, pVol);
  const sizes = [sy * sz, sx * sz, sx * sy];
  for (let a = 0; a < 3; a++) {
    if (extLo[a].length < sizes[a]) {
      extLo[a] = new Int32Array(sizes[a]);
      extHi[a] = new Int32Array(sizes[a]);
    }
    extLo[a].fill(0x7fffffff, 0, sizes[a]);
    extHi[a].fill(-1, 0, sizes[a]);
  }
  const [xLo, yLo, zLo] = extLo;
  const [xHi, yHi, zHi] = extHi;
  let gi = 0;
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const p = 1 + px * (y + 1 + py * (z + 1));
      let first = -1;
      let last = -1;
      for (let x = 0; x < sx; x++, gi++) {
        if (data[gi] === 0) continue;
        occ[p + x] = 1;
        if (first < 0) first = x;
        last = x;
        // y and z only grow in this loop order: the first hit sets lo, every hit moves hi.
        const xz = x + sx * z;
        if (yHi[xz] < 0) yLo[xz] = y;
        yHi[xz] = y;
        const xy = x + sx * y;
        if (zHi[xy] < 0) zLo[xy] = z;
        zHi[xy] = z;
      }
      if (first >= 0) {
        xLo[y + sy * z] = first;
        xHi[y + sy * z] = last;
      }
    }
  }
}

/**
 * Faces of both directions along axis `d`, slice by slice: builds the +d and −d masks of a slice in
 * one pass over its cells (only inside the lines' filled extents), then greedy-merges each mask.
 */
function sweepAxis(grid: VoxelGrid, d: number, useAo: boolean, jitter: boolean): void {
  const { sx, sy, sz, data } = grid;
  const u = (d + 1) % 3;
  const v = (d + 2) % 3;
  const dims = [sx, sy, sz];
  const gStride = [1, sx, sx * sy];
  const pStride = [1, sx + 2, (sx + 2) * (sy + 2)];
  const nd = dims[d];
  const nu = dims[u];
  const nv = dims[v];
  const gsd = gStride[d];
  const gsu = gStride[u];
  const gsv = gStride[v];
  const psd = pStride[d];
  const psu = pStride[u];
  const psv = pStride[v];
  // Mask rows run along u at (slice k, row vv): extents of the matching grid line (see extLo).
  const lo = extLo[u];
  const hi = extHi[u];
  const extK = d === 0 ? 1 : d === 1 ? sx : sy;
  const extV = d === 0 ? sx : 1;

  const area = nu * nv;
  if (keyPos.length < area) {
    keyPos = new Uint32Array(area);
    keyNeg = new Uint32Array(area);
    aoPos = new Uint8Array(area);
    aoNeg = new Uint8Array(area);
  }
  if (rowLo.length < nv) {
    rowLo = new Int32Array(nv);
    rowHi = new Int32Array(nv);
  }
  const kp = keyPos;
  const kn = keyNeg;
  const ap = aoPos;
  const an = aoNeg;

  for (let k = 0; k < nd; k++) {
    let anyPos = false;
    let anyNeg = false;
    for (let vv = 0; vv < nv; vv++) {
      const e = k * extK + vv * extV;
      const u0 = lo[e];
      const u1 = hi[e];
      rowLo[vv] = u0;
      rowHi[vv] = u1;
      if (u1 < u0) continue;
      let gi = k * gsd + vv * gsv + u0 * gsu;
      let pi = (k + 1) * psd + (vv + 1) * psv + (u0 + 1) * psu;
      let mi = vv * nu + u0;
      for (let uu = u0; uu <= u1; uu++, gi += gsu, pi += psu, mi++) {
        const front = occ[pi] === 0 ? 1 : occ[pi + psd];
        const back = occ[pi] === 0 ? 1 : occ[pi - psd];
        if (front !== 0 && back !== 0) {
          kp[mi] = 0;
          kn[mi] = 0;
          continue;
        }
        let c = data[gi];
        if (jitter) {
          let h = Math.imul(gi ^ 0x5bd1e995, 0x85ebca6b);
          h ^= h >>> 13;
          h = Math.imul(h, 0xc2b2ae35);
          h ^= h >>> 16;
          const level = (h >>> 0) % 3;
          if (level !== 1) {
            const lut = level === 0 ? jitterDark : jitterBright;
            c = (0xff000000 | (lut[(c >>> 16) & 255] << 16) | (lut[(c >>> 8) & 255] << 8) | lut[c & 255]) >>> 0;
          }
        }
        if (front === 0) {
          kp[mi] = c;
          ap[mi] = useAo ? cornerAo(pi + psd, psu, psv) : 0xff;
          anyPos = true;
        } else {
          kp[mi] = 0;
        }
        if (back === 0) {
          kn[mi] = c;
          an[mi] = useAo ? cornerAo(pi - psd, psu, psv) : 0xff;
          anyNeg = true;
        } else {
          kn[mi] = 0;
        }
      }
    }
    if (anyPos) mergeSlice(kp, ap, nu, nv, d * 2, k);
    if (anyNeg) mergeSlice(kn, an, nu, nv, d * 2 + 1, k);
  }
}

/** Packed AO of the 4 face corners (2 bits each: (u0,v0) (u1,v0) (u1,v1) (u0,v1)); `b` = the empty cell in front. */
function cornerAo(b: number, psu: number, psv: number): number {
  const su0 = occ[b - psu];
  const su1 = occ[b + psu];
  const sv0 = occ[b - psv];
  const sv1 = occ[b + psv];
  const a00 = su0 && sv0 ? 0 : 3 - su0 - sv0 - occ[b - psu - psv];
  const a10 = su1 && sv0 ? 0 : 3 - su1 - sv0 - occ[b + psu - psv];
  const a11 = su1 && sv1 ? 0 : 3 - su1 - sv1 - occ[b + psu + psv];
  const a01 = su0 && sv1 ? 0 : 3 - su0 - sv1 - occ[b - psu + psv];
  return a00 | (a10 << 2) | (a11 << 4) | (a01 << 6);
}

/**
 * Greedy merge of one slice mask: widest run along u, then as many equal rows along v as possible.
 * Only cells inside the rows' extents (rowLo/rowHi) hold valid mask values.
 */
function mergeSlice(keys: Uint32Array, aos: Uint8Array, nu: number, nv: number, dir: number, k: number): void {
  for (let vv = 0; vv < nv; vv++) {
    const end = rowHi[vv];
    let uu = rowLo[vv];
    let mi = vv * nu + uu;
    while (uu <= end) {
      const key = keys[mi];
      if (key === 0) {
        uu++;
        mi++;
        continue;
      }
      const a = aos[mi];
      let w = 1;
      while (uu + w <= end && keys[mi + w] === key && aos[mi + w] === a) w++;
      let h = 1;
      grow: while (vv + h < nv) {
        if (rowLo[vv + h] > uu || rowHi[vv + h] < uu + w - 1) break;
        const row = mi + h * nu;
        for (let q = 0; q < w; q++) if (keys[row + q] !== key || aos[row + q] !== a) break grow;
        h++;
      }
      for (let r = 0; r < h; r++) keys.fill(0, mi + r * nu, mi + r * nu + w);
      if ((quadCount + 1) * 8 > quadBuf.length) {
        const grown = new Int32Array(quadBuf.length * 2);
        grown.set(quadBuf);
        quadBuf = grown;
      }
      const o = quadCount * 8;
      quadBuf[o] = dir;
      quadBuf[o + 1] = k;
      quadBuf[o + 2] = uu;
      quadBuf[o + 3] = vv;
      quadBuf[o + 4] = w;
      quadBuf[o + 5] = h;
      quadBuf[o + 6] = key | 0;
      quadBuf[o + 7] = a;
      quadCount++;
      uu += w;
      mi += w;
    }
  }
}

/** Turns the first `quads` records of the quad buffer into an indexed BufferGeometry with bounds. */
function emitGeometry(quads: number, scale: number, origin: readonly [number, number, number]): THREE.BufferGeometry {
  const vertices = quads * 4;
  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const color = new Float32Array(vertices * 3);
  const index = vertices > 65535 ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  const [ox, oy, oz] = origin;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let q = 0; q < quads; q++) {
    const o = q * 8;
    const dir = quadBuf[o];
    const d = dir >> 1;
    const s = dir & 1 ? -1 : 1;
    const plane = quadBuf[o + 1] + (s > 0 ? 1 : 0);
    const u0 = quadBuf[o + 2];
    const v0 = quadBuf[o + 3];
    const w = quadBuf[o + 4] * scale;
    const h = quadBuf[o + 5] * scale;
    const key = quadBuf[o + 6];
    const a = quadBuf[o + 7];
    const r = LINEAR[(key >>> 16) & 255];
    const g = LINEAR[(key >>> 8) & 255];
    const b = LINEAR[key & 255];

    // Corner 0 (u0, v0) and the steps along u (width) and v (height); u = (d+1)%3, v = (d+2)%3.
    let x0: number, y0: number, z0: number;
    let ux = 0, uy = 0, uz = 0, vx = 0, vy = 0, vz = 0;
    if (d === 0) {
      x0 = plane;
      y0 = u0;
      z0 = v0;
      uy = w;
      vz = h;
    } else if (d === 1) {
      x0 = v0;
      y0 = plane;
      z0 = u0;
      uz = w;
      vx = h;
    } else {
      x0 = u0;
      y0 = v0;
      z0 = plane;
      ux = w;
      vy = h;
    }
    x0 = (x0 - ox) * scale;
    y0 = (y0 - oy) * scale;
    z0 = (z0 - oz) * scale;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (z0 < minZ) minZ = z0;
    if (x0 + ux + vx > maxX) maxX = x0 + ux + vx;
    if (y0 + uy + vy > maxY) maxY = y0 + uy + vy;
    if (z0 + uz + vz > maxZ) maxZ = z0 + uz + vz;

    // Corners 0..3 = (u0,v0) (u1,v0) (u1,v1) (u0,v1): counter-clockwise seen from +d.
    let vi = q * 12;
    for (let c = 0; c < 4; c++, vi += 3) {
      const cu = c === 1 || c === 2 ? 1 : 0;
      const cv = c >= 2 ? 1 : 0;
      position[vi] = x0 + ux * cu + vx * cv;
      position[vi + 1] = y0 + uy * cu + vy * cv;
      position[vi + 2] = z0 + uz * cu + vz * cv;
      normal[vi + d] = s;
      const f = AO_CURVE[(a >> (c * 2)) & 3];
      color[vi] = r * f;
      color[vi + 1] = g * f;
      color[vi + 2] = b * f;
    }

    // Split along the brighter diagonal so AO gradients stay symmetric; reverse the winding for -d.
    const base = q * 4;
    const ii = q * 6;
    const diag02 = (a & 3) + ((a >> 4) & 3) >= ((a >> 2) & 3) + ((a >> 6) & 3);
    const c1 = s > 0 ? base + 1 : base + 3;
    const c3 = s > 0 ? base + 3 : base + 1;
    if (diag02) {
      index[ii] = base;
      index[ii + 1] = c1;
      index[ii + 2] = base + 2;
      index[ii + 3] = base;
      index[ii + 4] = base + 2;
      index[ii + 5] = c3;
    } else {
      index[ii] = c1;
      index[ii + 1] = base + 2;
      index[ii + 2] = c3;
      index[ii + 3] = c1;
      index[ii + 4] = c3;
      index[ii + 5] = base;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  if (quads === 0) {
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0);
    return geometry;
  }
  // Same bounds as computeBoundingBox/Sphere (from the float32 positions; sphere centred on the box),
  // without their extra passes.
  minX = Math.fround(minX);
  minY = Math.fround(minY);
  minZ = Math.fround(minZ);
  maxX = Math.fround(maxX);
  maxY = Math.fround(maxY);
  maxZ = Math.fround(maxZ);
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(minX, minY, minZ), new THREE.Vector3(maxX, maxY, maxZ));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  let r2 = 0;
  for (let i = 0; i < position.length; i += 3) {
    const dx = position[i] - cx;
    const dy = position[i + 1] - cy;
    const dz = position[i + 2] - cz;
    const dd = dx * dx + dy * dy + dz * dz;
    if (dd > r2) r2 = dd;
  }
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.sqrt(r2));
  return geometry;
}

let material: THREE.MeshLambertMaterial | null = null;

/** Shared lit material for every voxel model (vertex colours, receives & casts shadows). */
export function getModelMaterial(): THREE.Material {
  if (material === null) {
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.name = 'voxel-model';
  }
  return material;
}
