/**
 * Local authoring frames for town structures.
 *
 * Buildings and oriented props are authored in local coordinates (u, y, v): `u` runs along the front
 * facade (left → right as seen from the street), `v` runs from the front face into the structure.
 * A frame is a proper rotation (never a mirror) of that local grid onto the world grid, so text on a
 * sign authored with increasing `u` reads correctly from outside and furniture keeps its handedness.
 */
import type { Facing, VoxelWriter } from '../types';

/** Local horizontal direction: 0 = +v (inwards), 1 = +u, 2 = −v (towards the front), 3 = −u. */
export type LocalDir = 0 | 1 | 2 | 3;

/** Axis-aligned world rectangle in voxels (max exclusive). */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export const DIR_DU: readonly number[] = [0, 1, 0, -1];
export const DIR_DV: readonly number[] = [1, 0, -1, 0];

export const opposite = (d: LocalDir): LocalDir => ((d + 2) & 3) as LocalDir;

/** Facing of a world direction vector (dominant axis). */
export function facingOfVector(dx: number, dz: number): Facing {
  if (Math.abs(dz) >= Math.abs(dx)) return dz >= 0 ? 0 : 2;
  return dx > 0 ? 1 : 3;
}

export const rectsOverlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

/** Distance from a point to a rectangle (0 inside). */
export function distToRect(x: number, z: number, r: Rect): number {
  const dx = x < r.x0 ? r.x0 - x : x > r.x1 ? x - r.x1 : 0;
  const dz = z < r.z0 ? r.z0 - z : z > r.z1 ? z - r.z1 : 0;
  return Math.hypot(dx, dz);
}

/**
 * Maps a local W×D footprint (u ∈ [0, W), v ∈ [0, D)) onto the world. `facing` is the outward normal
 * of the local front (v = 0); (x0, z0) is the world minimum corner of the footprint.
 */
export class Frame {
  readonly x1: number;
  readonly z1: number;
  /** World direction of +u. */
  readonly ux: number;
  readonly uz: number;
  /** World direction of +v. */
  readonly vx: number;
  readonly vz: number;
  /** World point of the local corner (u, v) = (0, 0). */
  readonly ox: number;
  readonly oz: number;
  private readonly cx: number;
  private readonly cz: number;

  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly W: number,
    readonly D: number,
    readonly facing: Facing,
  ) {
    const alongX = facing === 0 || facing === 2;
    this.x1 = x0 + (alongX ? W : D);
    this.z1 = z0 + (alongX ? D : W);
    let ux: number, uz: number, vx: number, vz: number, ox: number, oz: number;
    switch (facing) {
      case 0:
        [ux, uz, vx, vz, ox, oz] = [1, 0, 0, -1, x0, this.z1];
        break;
      case 1:
        [ux, uz, vx, vz, ox, oz] = [0, -1, -1, 0, this.x1, this.z1];
        break;
      case 2:
        [ux, uz, vx, vz, ox, oz] = [-1, 0, 0, 1, this.x1, z0];
        break;
      default:
        [ux, uz, vx, vz, ox, oz] = [0, 1, 1, 0, x0, z0];
    }
    this.ux = ux;
    this.uz = uz;
    this.vx = vx;
    this.vz = vz;
    this.ox = ox;
    this.oz = oz;
    this.cx = ux + vx < 0 ? -1 : 0;
    this.cz = uz + vz < 0 ? -1 : 0;
  }

  /** World footprint. */
  get rect(): Rect {
    return { x0: this.x0, z0: this.z0, x1: this.x1, z1: this.z1 };
  }

  /** World voxel x of local voxel (u, v). */
  wx(u: number, v: number): number {
    return this.ox + u * this.ux + v * this.vx + this.cx;
  }

  /** World voxel z of local voxel (u, v). */
  wz(u: number, v: number): number {
    return this.oz + u * this.uz + v * this.vz + this.cz;
  }

  /** World x of a continuous local point. */
  px(u: number, v: number): number {
    return this.ox + u * this.ux + v * this.vx;
  }

  /** World z of a continuous local point. */
  pz(u: number, v: number): number {
    return this.oz + u * this.uz + v * this.vz;
  }

  /** Local u of a continuous world point (inverse of px/pz along u). */
  lu(x: number, z: number): number {
    return (x - this.ox) * this.ux + (z - this.oz) * this.uz;
  }

  /** World rectangle covered by the local box [u0, u1) × [v0, v1). */
  box(u0: number, v0: number, u1: number, v1: number): Rect {
    const ax = this.px(u0, v0);
    const az = this.pz(u0, v0);
    const bx = this.px(u1, v1);
    const bz = this.pz(u1, v1);
    return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
  }

  /** World direction (x component) of a local direction. */
  dirX(d: LocalDir): number {
    return DIR_DU[d] * this.ux + DIR_DV[d] * this.vx;
  }

  /** World direction (z component) of a local direction. */
  dirZ(d: LocalDir): number {
    return DIR_DU[d] * this.uz + DIR_DV[d] * this.vz;
  }

  /** World facing of a local direction. */
  facingOf(d: LocalDir): Facing {
    return facingOfVector(this.dirX(d), this.dirZ(d));
  }

  /** World axis a local axis runs along. */
  axisOf(alongU: boolean): 'x' | 'z' {
    return (alongU ? this.ux : this.vx) !== 0 ? 'x' : 'z';
  }

  /** True when the local axis points towards increasing world coordinates. */
  axisPositive(alongU: boolean): boolean {
    return alongU ? this.ux + this.uz > 0 : this.vx + this.vz > 0;
  }
}

/** VoxelWriter adapter addressing voxels in a frame's local coordinates. */
export class LocalWriter {
  constructor(
    private readonly w: VoxelWriter,
    readonly f: Frame,
  ) {}

  set(u: number, y: number, v: number, id: number): void {
    this.w.set(this.f.wx(u, v), y, this.f.wz(u, v), id);
  }

  setSoft(u: number, y: number, v: number, id: number): void {
    this.w.setSoft(this.f.wx(u, v), y, this.f.wz(u, v), id);
  }

  /** Fills the local box [u0, u1) × [y0, y1) × [v0, v1). */
  fill(u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, id: number): void {
    if (u1 <= u0 || y1 <= y0 || v1 <= v0) return;
    const f = this.f;
    const ax = f.px(u0, v0);
    const az = f.pz(u0, v0);
    const bx = f.px(u1, v1);
    const bz = f.pz(u1, v1);
    this.w.fill(Math.min(ax, bx), y0, Math.min(az, bz), Math.max(ax, bx), y1, Math.max(az, bz), id);
  }
}

/** Conservative local bounds accumulator (max exclusive). */
export class LocalBounds {
  u0 = Infinity;
  y0 = Infinity;
  v0 = Infinity;
  u1 = -Infinity;
  y1 = -Infinity;
  v1 = -Infinity;

  add(u0: number, y0: number, v0: number, u1: number, y1: number, v1: number): void {
    if (u0 < this.u0) this.u0 = u0;
    if (y0 < this.y0) this.y0 = y0;
    if (v0 < this.v0) this.v0 = v0;
    if (u1 > this.u1) this.u1 = u1;
    if (y1 > this.y1) this.y1 = y1;
    if (v1 > this.v1) this.v1 = v1;
  }

  /** World feature bounds of the accumulated local box. */
  toWorld(f: Frame): { min: [number, number, number]; max: [number, number, number] } {
    const r = f.box(this.u0, this.v0, this.u1, this.v1);
    return { min: [r.x0, this.y0, r.z0], max: [r.x1, this.y1, r.z1] };
  }
}

/** Ordered list of local boxes, each filled with one block id; keeps the bounds up to date. */
export class BoxList {
  private readonly data: number[] = [];

  constructor(private readonly bounds: LocalBounds) {}

  add(u0: number, y0: number, v0: number, u1: number, y1: number, v1: number, id: number): void {
    if (u1 <= u0 || y1 <= y0 || v1 <= v0) return;
    this.data.push(u0, y0, v0, u1, y1, v1, id);
    this.bounds.add(u0, y0, v0, u1, y1, v1);
  }

  stamp(lw: LocalWriter): void {
    const d = this.data;
    for (let i = 0; i < d.length; i += 7) lw.fill(d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6]);
  }
}
