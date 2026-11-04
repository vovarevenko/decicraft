/**
 * Clipped voxel rasterisation helpers shared by trees, bushes, logs and rocks. OWNER: agent "worldgen".
 *
 * Every helper iterates only over the part of a primitive that lies inside the writer's tile, and
 * decides each voxel from its own position (plus reads of that same column), so a feature stamped
 * once per overlapping tile always produces identical voxels (ARCHITECTURE.md §5.1 tile independence).
 */
import { WORLD_Y } from '../../config';
import { B, RENDER_KIND, RK } from '../../world/blocks';
import type { VoxelWriter } from '../types';

/** Integer box [x0,x1)×[y0,y1)×[z0,z1); scratch output of `clipBox`. */
export interface IBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

/** A fresh scratch box. */
export const createBox = (): IBox => ({ x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0 });

/**
 * Voxels whose centres may lie in the float box [minX,maxX]×[minY,maxY]×[minZ,maxZ], clipped to the
 * writer's tile and the world height. Returns false when nothing remains.
 */
export function clipBox(
  w: VoxelWriter,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  out: IBox,
): boolean {
  out.x0 = Math.max(w.x0, Math.floor(minX - 0.5));
  out.x1 = Math.min(w.x1, Math.ceil(maxX + 0.5));
  out.z0 = Math.max(w.z0, Math.floor(minZ - 0.5));
  out.z1 = Math.min(w.z1, Math.ceil(maxZ + 0.5));
  out.y0 = Math.max(0, Math.floor(minY - 0.5));
  out.y1 = Math.min(WORLD_Y, Math.ceil(maxY + 0.5));
  return out.x0 < out.x1 && out.z0 < out.z1 && out.y0 < out.y1;
}

/** Air or a plant: cells that roots/anchors may grow through. */
export const isOpenCell = (id: number): boolean => id === B.AIR || RENDER_KIND[id] === RK.PLANT;

/** Cells roots may displace: open cells, natural ground and rock, bark (never WOOD cores or built materials). */
const ROOTABLE = new Uint8Array(256);
for (let id = 0; id < 256; id++) if (isOpenCell(id)) ROOTABLE[id] = 1;
for (const id of [B.GRASS, B.DIRT, B.SAND, B.GRAVEL, B.CLAY, B.MUD, B.MOSS, B.LITTER, B.STONE, B.GRANITE, B.OAK_LOG, B.BIRCH_LOG, B.PINE_LOG]) {
  ROOTABLE[id] = 1;
}

/** Writes an underground part of a tree (roots, buried trunk) only into soil, rock or open cells. */
export function putRoot(w: VoxelWriter, x: number, y: number, z: number, id: number): void {
  if (ROOTABLE[w.get(x, y, z)] === 1) w.set(x, y, z, id);
}

/** Writes bark unless the cell holds a WOOD core (another limb's core stays enclosed, never covered). */
export function putBark(w: VoxelWriter, x: number, y: number, z: number, bark: number): void {
  if (w.get(x, y, z) !== B.WOOD) w.set(x, y, z, bark);
}

/**
 * Extends a structure down from (x, y, z) through open cells (max `limit` voxels) until it rests on
 * something, so trunks, roots and rocks never float on slopes. Reads stay within the column.
 */
export function anchorDown(w: VoxelWriter, x: number, y: number, z: number, id: number, limit: number): void {
  if (!w.inTile(x, z)) return;
  for (let i = 0; i < limit && y >= 0; i++, y--) {
    if (!isOpenCell(w.get(x, y, z))) return;
    w.set(x, y, z, id);
  }
}

const scratch = createBox();

/**
 * Tapered capsule from a (radius ra) to b (radius rb): bark skin, WOOD core where the local radius
 * is ≥ 1.5. Radii must be ≥ 0.85 so the voxel set stays 6-connected (thinner parts: `rasterLine`).
 */
export function rasterLimb(
  w: VoxelWriter,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  ra: number,
  rb: number,
  bark: number,
): void {
  const r = Math.max(ra, rb);
  const box = scratch;
  if (!clipBox(w, Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.min(az, bz) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r, Math.max(az, bz) + r, box)) {
    return;
  }
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const len2 = abx * abx + aby * aby + abz * abz;
  const inv = len2 > 1e-9 ? 1 / len2 : 0;
  const dr = rb - ra;
  for (let x = box.x0; x < box.x1; x++) {
    const px = x + 0.5 - ax;
    for (let z = box.z0; z < box.z1; z++) {
      const pz = z + 0.5 - az;
      for (let y = box.y0; y < box.y1; y++) {
        const py = y + 0.5 - ay;
        let t = (px * abx + py * aby + pz * abz) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const rr = ra + dr * t;
        const dx = px - abx * t;
        const dy = py - aby * t;
        const dz = pz - abz * t;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > rr * rr) continue;
        if (rr >= 1.5 && d2 <= (rr - 1) * (rr - 1)) w.set(x, y, z, B.WOOD);
        else putBark(w, x, y, z, bark);
      }
    }
  }
}

/**
 * One-voxel-thick, 6-connected (face-adjacent) line of bark from the voxel containing a to the voxel
 * containing b (3D DDA that steps one axis at a time).
 */
export function rasterLine(w: VoxelWriter, ax: number, ay: number, az: number, bx: number, by: number, bz: number, bark: number): void {
  let x = Math.floor(ax);
  let y = Math.floor(ay);
  let z = Math.floor(az);
  const ex = Math.floor(bx);
  const ey = Math.floor(by);
  const ez = Math.floor(bz);
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tx = dx !== 0 ? (sx > 0 ? x + 1 - ax : ax - x) * tdx : Infinity;
  let ty = dy !== 0 ? (sy > 0 ? y + 1 - ay : ay - y) * tdy : Infinity;
  let tz = dz !== 0 ? (sz > 0 ? z + 1 - az : az - z) * tdz : Infinity;
  let rx = Math.abs(ex - x);
  let ry = Math.abs(ey - y);
  let rz = Math.abs(ez - z);
  putBark(w, x, y, z, bark);
  while (rx + ry + rz > 0) {
    // Step the axis whose next boundary comes first among those with steps left.
    if (rx > 0 && (ry === 0 || tx <= ty) && (rz === 0 || tx <= tz)) {
      x += sx;
      tx += tdx;
      rx--;
    } else if (ry > 0 && (rz === 0 || ty <= tz)) {
      y += sy;
      ty += tdy;
      ry--;
    } else {
      z += sz;
      tz += tdz;
      rz--;
    }
    putBark(w, x, y, z, bark);
  }
}
