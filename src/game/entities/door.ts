/**
 * Hinged door filling a doorway (DoorSpawn). OWNER: agent "entities".
 * E toggles with a smooth swing (~0.4 s) and door_open/door_close sounds; hint «E — открыть дверь» /
 * «E — закрыть дверь». While closed or closing, the solid box (getBounds override) is the whole opening:
 * width × height × wall depth; fully open → not solid. The leaf sits in the middle of the wall depth.
 *
 * Leaf frame (getDoorGeometry): origin at the hinge edge, bottom, centre of thickness; width along
 * local +X. A rotation by yaw θ about +Y maps local +X to world (cos θ, 0, −sin θ). The leaf turns 90°
 * from lying along the opening (pointing away from the hinge) to pointing into the `swing` side.
 */
import * as THREE from 'three';
import { angleDelta, smoothstep } from '../../core/math';
import type { DoorSpawn } from '../../gen/types';
import { getDoorGeometry } from '../../render/models';
import { getModelMaterial } from '../../render/voxelModel';
import type { GameContext } from '../context';
import { bodyAABB, makeAABB, type AABB } from '../physics';
import { Entity } from './entity';

/** Seconds for a full swing. */
export const DOOR_SWING_S = 0.4;
/** Half thickness of the picking box around an open leaf (the leaf itself is ~4 cm thick). */
const OPEN_PICK_HALF = 0.5;

export type DoorGeometry = Pick<DoorSpawn, 'x' | 'y' | 'z' | 'axis' | 'width' | 'height' | 'depth' | 'hinge' | 'swing'>;

/** Where the leaf turns: the hinge line (x, z) and the leaf yaw when closed and the signed turn (±π/2) to open. */
export interface DoorHinge {
  x: number;
  z: number;
  closedYaw: number;
  openTurn: number;
}

/** Yaw that points the leaf's local +X along world direction (dx, dz). */
const leafYaw = (dx: number, dz: number): number => Math.atan2(-dz, dx);

/** Hinge line and swing of a door (pure; see the file comment for the leaf frame). */
export function doorHinge(s: DoorGeometry, out: DoorHinge = { x: 0, z: 0, closedYaw: 0, openTurn: 0 }): DoorHinge {
  const alongX = s.axis === 'x';
  const hingeOffset = s.hinge === 'min' ? 0 : s.width;
  // Closed: the leaf runs from the hinge across the opening; open: it points into the swing side.
  const closedDir = s.hinge === 'min' ? 1 : -1;
  if (alongX) {
    out.x = s.x + hingeOffset;
    out.z = s.z + s.depth / 2;
    out.closedYaw = leafYaw(closedDir, 0);
    out.openTurn = angleDelta(out.closedYaw, leafYaw(0, s.swing));
  } else {
    out.x = s.x + s.depth / 2;
    out.z = s.z + hingeOffset;
    out.closedYaw = leafYaw(0, closedDir);
    out.openTurn = angleDelta(out.closedYaw, leafYaw(s.swing, 0));
  }
  return out;
}

/** Leaf yaw for opening amount t ∈ [0, 1] (eased). */
export function doorLeafYaw(h: DoorHinge, t: number): number {
  return h.closedYaw + smoothstep(0, 1, t) * h.openTurn;
}

/** The whole doorway: width along the axis × height × wall depth. */
export function doorOpeningBox(s: DoorGeometry, out: AABB): AABB {
  const alongX = s.axis === 'x';
  out.minX = s.x;
  out.maxX = s.x + (alongX ? s.width : s.depth);
  out.minY = s.y;
  out.maxY = s.y + s.height;
  out.minZ = s.z;
  out.maxZ = s.z + (alongX ? s.depth : s.width);
  return out;
}

/** Box around the leaf at `yaw` (picking an open door), OPEN_PICK_HALF thick. */
export function doorLeafBox(s: DoorGeometry, h: DoorHinge, yaw: number, out: AABB): AABB {
  const ex = h.x + Math.cos(yaw) * s.width;
  const ez = h.z - Math.sin(yaw) * s.width;
  out.minX = Math.min(h.x, ex) - OPEN_PICK_HALF;
  out.maxX = Math.max(h.x, ex) + OPEN_PICK_HALF;
  out.minY = s.y;
  out.maxY = s.y + s.height;
  out.minZ = Math.min(h.z, ez) - OPEN_PICK_HALF;
  out.maxZ = Math.max(h.z, ez) + OPEN_PICK_HALF;
  return out;
}

const opening = makeAABB();
const other = makeAABB();
const near: Entity[] = [];

const overlaps = (a: AABB, b: AABB): boolean =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;

export class Door extends Entity {
  readonly type = 'door';
  open = false;

  private readonly spawn: DoorSpawn;
  private readonly hinge: DoorHinge;
  /** Rotates the leaf about the hinge line. */
  private readonly pivot = new THREE.Group();
  /** Opening amount: 0 closed … 1 open (eased when applied). */
  private t = 0;

  constructor(spawn: DoorSpawn) {
    super();
    this.spawn = spawn;
    this.hinge = doorHinge(spawn);
    const box = doorOpeningBox(spawn, makeAABB());
    this.position.set((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
    this.halfWidth = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) / 2;
    this.height = spawn.height;
    this.displayName = 'Дверь';

    const leaf = new THREE.Mesh(getDoorGeometry(spawn.width, spawn.height, spawn.style), getModelMaterial());
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    this.pivot.position.set(this.hinge.x - this.position.x, 0, this.hinge.z - this.position.z);
    this.pivot.add(leaf);
    this.object.add(this.pivot);

    this.open = spawn.open === true;
    this.t = this.open ? 1 : 0;
    this.applySwing();
  }

  update(dt: number, ctx: GameContext): void {
    const target = this.open ? 1 : 0;
    if (this.t === target) return;
    const step = dt / DOOR_SWING_S;
    this.t = target > this.t ? Math.min(1, this.t + step) : Math.max(0, this.t - step);
    this.applySwing();
    if (this.t === 0) ctx.audio.play('door_close', { pos: this.position });
  }

  interact(ctx: GameContext): void {
    if (this.open) {
      if (this.doorwayOccupied(ctx)) {
        ctx.hud.toast('Не закрыть: проём занят');
        return;
      }
      this.open = false; // the close sound plays when the leaf reaches the frame
    } else {
      this.open = true;
      ctx.audio.play('door_open', { pos: this.position });
    }
    this.applySwing();
  }

  hint(): string {
    return this.open ? 'E — закрыть дверь' : 'E — открыть дверь';
  }

  /** Closed, opening or closing: the whole doorway (solid). Fully open: the leaf (picking only). */
  getBounds(out: AABB): AABB {
    if (this.solid) return doorOpeningBox(this.spawn, out);
    return doorLeafBox(this.spawn, this.hinge, this.hinge.closedYaw + this.hinge.openTurn, out);
  }

  private applySwing(): void {
    this.pivot.rotation.y = doorLeafYaw(this.hinge, this.t);
    this.solid = !(this.open && this.t >= 1);
  }

  /** The player or a mob stands in the doorway (closing would trap them inside the solid box). */
  private doorwayOccupied(ctx: GameContext): boolean {
    doorOpeningBox(this.spawn, opening);
    if (overlaps(opening, bodyAABB(ctx.player, other))) return true;
    const list = ctx.entities.queryRadius(this.position, this.spawn.width + this.spawn.height, near);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.type !== 'mob') continue;
      other.minX = e.position.x - e.halfWidth;
      other.maxX = e.position.x + e.halfWidth;
      other.minY = e.position.y;
      other.maxY = e.position.y + e.height;
      other.minZ = e.position.z - e.halfWidth;
      other.maxZ = e.position.z + e.halfWidth;
      if (overlaps(opening, other)) return true;
    }
    return false;
  }
}
