/**
 * Sculpt: a VoxelGrid addressed in model space — integer cells (centimetres for the cm models)
 * relative to the model's origin (the grip of a tool, the bottom centre of an item, the joint of a rig
 * part), so model code can use real dimensions and negative coordinates. Colour functions receive
 * model coordinates too.
 */
import type * as THREE from 'three';
import { buildVoxelGeometry, VoxelGrid, type CellColor } from '../voxelModel';

export type Vec3 = readonly [number, number, number];

export class Sculpt {
  readonly grid: VoxelGrid;
  /** Grid cell of model cell (0, 0, 0). */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;

  /** Model-space cell bounds [min, max) along each axis. */
  constructor(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number) {
    this.ox = -minX;
    this.oy = -minY;
    this.oz = -minZ;
    this.grid = new VoxelGrid(maxX - minX, maxY - minY, maxZ - minZ);
  }

  set(x: number, y: number, z: number, rgb: number): void {
    this.grid.set(x + this.ox, y + this.oy, z + this.oz, rgb);
  }

  /** 0 if empty, otherwise the sRGB colour. */
  get(x: number, y: number, z: number): number {
    return this.grid.get(x + this.ox, y + this.oy, z + this.oz);
  }

  filled(x: number, y: number, z: number): boolean {
    return this.grid.filled(x + this.ox, y + this.oy, z + this.oz);
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: CellColor): void {
    const { ox, oy, oz } = this;
    this.grid.box(x0 + ox, y0 + oy, z0 + oz, x1 + ox, y1 + oy, z1 + oz, this.local(color));
  }

  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: CellColor): void {
    this.grid.ellipsoid(cx + this.ox, cy + this.oy, cz + this.oz, rx, ry, rz, this.local(color));
  }

  capsule(a: Vec3, b: Vec3, r0: number, r1: number, color: CellColor, flat = false): void {
    const { ox, oy, oz } = this;
    this.grid.capsule(a[0] + ox, a[1] + oy, a[2] + oz, b[0] + ox, b[1] + oy, b[2] + oz, r0, r1, this.local(color), flat);
  }

  /** Fills cells where `fn(model-space cell centre) <= 0`, scanning only the model-space box `bounds`. */
  sdf(
    fn: (x: number, y: number, z: number) => number,
    color: CellColor,
    bounds?: readonly [number, number, number, number, number, number],
  ): void {
    const { ox, oy, oz } = this;
    this.grid.sdf(
      (x, y, z) => fn(x - ox, y - oy, z - oz),
      this.local(color),
      bounds && [bounds[0] + ox, bounds[1] + oy, bounds[2] + oz, bounds[3] + ox, bounds[4] + oy, bounds[5] + oz],
    );
  }

  /** Re-colours every filled cell (`fn` gets model coordinates; negative clears). */
  recolor(fn: (rgb: number, x: number, y: number, z: number) => number): void {
    const { ox, oy, oz } = this;
    this.grid.recolor((c, x, y, z) => fn(c, x - ox, y - oy, z - oz));
  }

  /**
   * Meshes the sculpt with `scale` world units per cell (default 0.1 = 1 cm). The geometry origin is
   * model point `origin` (default (0, 0, 0)); `jitter` as in BuildOptions.
   */
  build(jitter: number, origin: Vec3 = [0, 0, 0], scale = 0.1): THREE.BufferGeometry {
    return buildVoxelGeometry(this.grid, {
      scale,
      jitter,
      origin: [origin[0] + this.ox, origin[1] + this.oy, origin[2] + this.oz],
    });
  }

  private local(color: CellColor): CellColor {
    if (typeof color === 'number') return color;
    const { ox, oy, oz } = this;
    return (x, y, z) => color(x - ox, y - oy, z - oz);
  }
}
