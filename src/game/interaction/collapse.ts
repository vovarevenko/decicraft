/**
 * What follows a removal (ARCHITECTURE.md §11.3): water flowing into the emptied cells, and structural collapse —
 * detached pieces smaller than MIN_FALLING_VOXELS crumble into item drops, larger ones become FallingBody entities
 * falling away from the player. OWNER: agent "interaction".
 *
 * Water flows into the dug cells at once. A removal next to STRUCT voxels is handed to the felling client
 * (felling.ts), which works out in its worker what came loose; the result is applied by update() in a later frame
 * (with no worker: in the same call, unless a FallingBody is writing in slices — then by the first update() after
 * the write) — crumbled pieces' cells then flood too. Cells vacated by a FallingBody are not checked for water
 * (detached pieces hang above the ground, away from water).
 */
import { GAMEPLAY } from '../../config';
import type { Vec3Like } from '../../core/math';
import { touchesStruct, type DetachedPiece } from '../../world/structure';
import type { GameContext } from '../context';
import { ItemDrop } from '../entities/itemDrop';
import { FallingBody } from '../fallingBody';
import { BREAK_SOUND, clearVoxels, tallyDrops } from './breaking';
import { fellingFor, type DetachResult } from './felling';
import { VoxelList } from './voxelList';
import { flowWater } from './water';

/** Debris particles per voxel of a crumbling piece (pieces are < 40 voxels). */
const CRUMBLE_DEBRIS = 3;
/** Horizontal scatter speed of a crumbled piece's item drops (world units/s). */
const SCATTER_SPEED = 6;

export class Aftermath {
  private readonly water = new VoxelList(256);
  private readonly plants = new VoxelList(32);
  /** Cells emptied by the pieces of one result that crumbled (and the plants that stood on them). */
  private readonly crumbled = new VoxelList(64);
  private readonly drops = new Map<string, number>();

  /**
   * Settles the world after the voxels in `removed` were emptied: water flows in, then — if they touched STRUCT
   * voxels — detached structures crumble or fall away from `from` (the player's position): right away without a
   * felling worker (once no write in slices is in progress: else at the first update() after it), otherwise once
   * update() takes the worker's answer. `removed` is not kept.
   */
  settle(ctx: GameContext, removed: VoxelList, from: Vec3Like): void {
    this.flood(ctx, removed.triples());
    if (!touchesStruct(ctx.world, removed.triples())) return;
    const result = fellingFor(ctx.world).detach(removed.triples(), from);
    if (result !== null) this.apply(ctx, result);
  }

  /** Once per frame (also while a screen is open): applies what the felling worker found came loose. */
  update(ctx: GameContext): void {
    fellingFor(ctx.world).update((result) => this.apply(ctx, result));
  }

  private apply(ctx: GameContext, result: DetachResult): void {
    const crumbled = this.crumbled;
    crumbled.clear();
    for (const piece of result.crumbles) this.crumble(ctx, piece, crumbled);
    for (const fall of result.falls) ctx.entities.add(new FallingBody(ctx, fall.piece, fall.plan, fall.geometry, fall.touched));
    this.flood(ctx, crumbled.triples());
  }

  /** Water flows into the emptied `cells` (packed triples) that touch it, with a splash. */
  private flood(ctx: GameContext, cells: ArrayLike<number>): void {
    const water = this.water;
    water.clear();
    if (flowWater(ctx.world, cells, GAMEPLAY.waterFillBudget, water) === 0) return;
    const pos = { x: water.positions[0] + 0.5, y: water.positions[1] + 1, z: water.positions[2] + 0.5 };
    ctx.particles.splash(pos, Math.min(1, 0.3 + water.count / 60));
    ctx.audio.play('splash', { pos, volume: 0.6 });
  }

  /** Removes a small detached piece and scatters its items where it hung; its cells and plants go to `emptied`. */
  private crumble(ctx: GameContext, piece: DetachedPiece, emptied: VoxelList): void {
    const { positions: p, ids } = piece;
    const plants = this.plants;
    plants.clear();
    clearVoxels(ctx.world, piece, 0, plants);
    for (let i = 0; i < piece.count; i++) {
      emptied.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], ids[i]);
      ctx.particles.blockBreak(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], ids[i], CRUMBLE_DEBRIS);
    }
    const plantPos = plants.positions;
    for (let i = 0; i < plants.count; i++) emptied.push(plantPos[i * 3], plantPos[i * 3 + 1], plantPos[i * 3 + 2], plants.ids[i]);

    // Drops start in the emptied voxel nearest the piece's centre, so never inside something solid.
    const c = nearestVoxel(piece, (piece.min[0] + piece.max[0]) / 2, (piece.min[1] + piece.max[1]) / 2, (piece.min[2] + piece.max[2]) / 2);
    const at = { x: p[c * 3] + 0.5, y: p[c * 3 + 1] + 0.1, z: p[c * 3 + 2] + 0.5 };
    const drops = this.drops;
    drops.clear();
    tallyDrops(piece, 0, drops);
    tallyDrops(plants, 0, drops);
    for (const [item, count] of drops) {
      const vel = { x: (Math.random() - 0.5) * SCATTER_SPEED, y: SCATTER_SPEED, z: (Math.random() - 0.5) * SCATTER_SPEED };
      ctx.entities.add(new ItemDrop(item, count, { ...at }, vel));
    }
    const sound = BREAK_SOUND[ids[0]];
    if (sound !== null) ctx.audio.play(sound, { pos: at });
    ctx.audio.play('impact', { pos: at, volume: 0.5 });
  }
}

/** Index of the piece voxel whose centre is nearest to (x, y, z). */
function nearestVoxel(piece: DetachedPiece, x: number, y: number, z: number): number {
  const p = piece.positions;
  let best = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < piece.count; i++) {
    const dx = p[i * 3] + 0.5 - x;
    const dy = p[i * 3 + 1] + 0.5 - y;
    const dz = p[i * 3 + 2] + 0.5 - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
