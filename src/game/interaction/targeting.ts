/**
 * Crosshair targeting: the nearer of the voxel hit (tall plants included) and the entity hit along the view
 * ray within PLAYER.reach (keeping the voxel behind a picked entity), plus the HUD hint for block targets.
 * The ray passes the voxels a falling body's write in slices still owns (FellingClient.owned).
 * OWNER: agent "interaction".
 */
import * as THREE from 'three';
import { PLAYER } from '../../config';
import { B } from '../../world/blocks';
import { makeVoxelHit, raycastVoxels, type VoxelHit } from '../../world/raycast';
import type { GameContext } from '../context';
import type { Target } from '../interaction';
import type { ItemDef, ToolStats } from '../items';
import { breakHint } from './breaking';
import { fellingFor, type FellingClient } from './felling';

type BlockTarget = Extract<Target, { kind: 'block' }>;
type EntityTarget = Extract<Target, { kind: 'entity' }>;

export function copyVoxelHit(src: VoxelHit, dst: VoxelHit): VoxelHit {
  dst.x = src.x;
  dst.y = src.y;
  dst.z = src.z;
  dst.nx = src.nx;
  dst.ny = src.ny;
  dst.nz = src.nz;
  dst.id = src.id;
  dst.distance = src.distance;
  dst.px = src.px;
  dst.py = src.py;
  dst.pz = src.pz;
  return dst;
}

/** Ray picking without per-frame garbage: the returned target objects are reused while they stay the same kind. */
export class TargetPicker {
  /** View direction of the last pick (unit vector). */
  readonly dir = new THREE.Vector3();
  /** The voxel hit behind the entity of the last pick (null if none, or a block was picked). */
  behind: VoxelHit | null = null;
  private readonly scratch = makeVoxelHit();
  private readonly behindHit = makeVoxelHit();
  private readonly block: BlockTarget = { kind: 'block', hit: makeVoxelHit() };
  private entity: EntityTarget | null = null;
  private felling: FellingClient | null = null;
  /** The voxels the ray stops at: visible ones (as raycastVoxels' default) that no write in progress owns. */
  private readonly accept = (id: number, x: number, y: number, z: number): boolean =>
    id !== B.AIR && id !== B.WATER && !(this.felling as FellingClient).owned(x, y, z);

  pick(ctx: GameContext): Target | null {
    const eye = ctx.player.eye;
    const dir = ctx.player.getLookDir(this.dir);
    this.felling = fellingFor(ctx.world);
    const voxel = raycastVoxels(ctx.world, eye, dir, PLAYER.reach, this.accept, this.scratch);
    const ent = ctx.entities.raycast(eye, dir, PLAYER.reach);
    if (ent !== null && (voxel === null || ent.distance < voxel.distance)) {
      if (this.entity === null || this.entity.entity !== ent.entity) this.entity = { kind: 'entity', entity: ent.entity, distance: ent.distance };
      else this.entity.distance = ent.distance;
      this.behind = voxel === null ? null : copyVoxelHit(voxel, this.behindHit);
      return this.entity;
    }
    this.behind = null;
    if (voxel === null) return null;
    copyVoxelHit(voxel, this.block.hit);
    return this.block;
  }
}

/**
 * HUD hint for a block target: the break hint (§11.1) plus what RMB does with the selected item —
 * «ПКМ — поставить» for materials, «ПКМ — поставить костёр» where a campfire can stand (`campfireFits`).
 */
export function blockHint(id: number, stats: ToolStats, item: ItemDef | null, campfireFits: boolean): string {
  const hint = breakHint(id, stats);
  if (item?.kind === 'material') return `${hint} · ПКМ — поставить`;
  if (item?.placeEntity === 'campfire' && campfireFits) return `${hint} · ПКМ — поставить костёр`;
  return hint;
}
