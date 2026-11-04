/**
 * Clipping VoxelWriter over a dense GEN_TILE × WORLD_Y × GEN_TILE tile buffer. OWNER: agent "worldgen".
 * Layout is column-major — index = (lx + lz·GEN_TILE)·WORLD_Y + y — so column fills, column scans
 * (sky heights) and chunk extraction all walk contiguous memory.
 */
import { GEN_TILE, WORLD_Y } from '../../config';
import { B, RENDER_KIND, RK } from '../../world/blocks';
import type { VoxelWriter } from '../types';

/** Bytes of one tile buffer (8 MB). */
export const TILE_BYTES = GEN_TILE * GEN_TILE * WORLD_Y;

export class TileWriter implements VoxelWriter {
  x0 = 0;
  z0 = 0;
  x1 = GEN_TILE;
  z1 = GEN_TILE;

  constructor(readonly data: Uint8Array = new Uint8Array(TILE_BYTES)) {
    if (data.length !== TILE_BYTES) throw new Error(`tile buffer must hold ${TILE_BYTES} bytes`);
  }

  /** Moves the window to the tile whose min corner is (x0, z0) and clears it to AIR. */
  reset(x0: number, z0: number): void {
    this.x0 = x0;
    this.z0 = z0;
    this.x1 = x0 + GEN_TILE;
    this.z1 = z0 + GEN_TILE;
    this.data.fill(B.AIR);
  }

  inTile(x: number, z: number): boolean {
    return x >= this.x0 && x < this.x1 && z >= this.z0 && z < this.z1;
  }

  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= WORLD_Y || x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1) return B.AIR;
    return this.data[(((x - this.x0) | 0) + ((z - this.z0) | 0) * GEN_TILE) * WORLD_Y + (y | 0)];
  }

  set(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= WORLD_Y || x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1) return;
    this.data[(((x - this.x0) | 0) + ((z - this.z0) | 0) * GEN_TILE) * WORLD_Y + (y | 0)] = id;
  }

  setSoft(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= WORLD_Y || x < this.x0 || x >= this.x1 || z < this.z0 || z >= this.z1) return;
    const i = (((x - this.x0) | 0) + ((z - this.z0) | 0) * GEN_TILE) * WORLD_Y + (y | 0);
    const cur = this.data[i];
    if (cur === B.AIR || RENDER_KIND[cur] === RK.PLANT) this.data[i] = id;
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    const xa = Math.max(this.x0, Math.ceil(x0));
    const xb = Math.min(this.x1, Math.ceil(x1));
    const za = Math.max(this.z0, Math.ceil(z0));
    const zb = Math.min(this.z1, Math.ceil(z1));
    const ya = Math.max(0, Math.ceil(y0));
    const yb = Math.min(WORLD_Y, Math.ceil(y1));
    if (xa >= xb || za >= zb || ya >= yb) return;
    for (let z = za; z < zb; z++) {
      for (let x = xa; x < xb; x++) {
        const base = (x - this.x0 + (z - this.z0) * GEN_TILE) * WORLD_Y;
        this.data.fill(id, base + ya, base + yb);
      }
    }
  }
}
