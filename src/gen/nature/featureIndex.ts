/**
 * Per-tile spatial index of plan features. OWNER: agent "worldgen".
 * Built once per worker; each tile lists the features whose bounds overlap it, already sorted in
 * stamping order (order, then plan index).
 */
import { GEN_TILE, GEN_TILES_X, GEN_TILES_Z, WORLD_X, WORLD_Y, WORLD_Z } from '../../config';
import type { Feature } from '../types';

export class FeatureIndex {
  private readonly tiles: Int32Array[];

  constructor(readonly features: readonly Feature[]) {
    const lists: number[][] = [];
    for (let i = 0; i < GEN_TILES_X * GEN_TILES_Z; i++) lists.push([]);
    features.forEach((f, i) => {
      if (f.max[0] <= 0 || f.max[2] <= 0 || f.max[1] <= 0 || f.min[0] >= WORLD_X || f.min[2] >= WORLD_Z || f.min[1] >= WORLD_Y) return;
      if (f.max[0] <= f.min[0] || f.max[2] <= f.min[2]) return;
      const tx0 = Math.max(0, Math.floor(f.min[0] / GEN_TILE));
      const tx1 = Math.min(GEN_TILES_X - 1, Math.floor((f.max[0] - 1) / GEN_TILE));
      const tz0 = Math.max(0, Math.floor(f.min[2] / GEN_TILE));
      const tz1 = Math.min(GEN_TILES_Z - 1, Math.floor((f.max[2] - 1) / GEN_TILE));
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) lists[tx + tz * GEN_TILES_X].push(i);
      }
    });
    this.tiles = lists.map((l) => Int32Array.from(l.sort((a, b) => features[a].order - features[b].order || a - b)));
  }

  /** Plan indices of the features overlapping tile (tx, tz), in stamping order. */
  featuresIn(tx: number, tz: number): Int32Array {
    return this.tiles[tx + tz * GEN_TILES_X];
  }
}
