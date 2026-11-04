/**
 * Base class for everything that is not a voxel: item drops, doors, containers, campfires, mobs,
 * falling voxel bodies. OWNER: agent "entities" (may extend; must keep this public API).
 */
import * as THREE from 'three';
import type { Vec3Like } from '../../core/math';
import type { GameContext } from '../context';
import type { AABB } from '../physics';

export interface HitInfo {
  /** Damage points (see ToolStats.damage). */
  damage: number;
  /** Normalised direction from the attacker to the target. */
  dir: THREE.Vector3;
  /** Tool type used: 'hand' | 'axe' | 'shovel' | 'pickaxe'. */
  tool: string;
}

export abstract class Entity {
  private static nextId = 1;
  readonly id = Entity.nextId++;
  abstract readonly type: string;
  /** Bottom-centre position (world units). The manager copies it to `object.position` after update(). */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Scene-graph root, added to / removed from the scene by the EntityManager. */
  readonly object = new THREE.Group();
  /** Collision & raycast box: half width (x and z) and height, world units. Override getBounds() for non-square boxes (doors, rotated containers). */
  halfWidth = 2;
  height = 4;
  /** If true, the player and mobs collide with getBounds(). */
  solid = false;
  /** Set by EntityManager.remove(); the entity is detached at the end of the current update. */
  removed = false;
  /** Russian name shown on the HUD when targeted (e.g. «Косуля»). Empty = not targetable by the crosshair. */
  displayName = '';
  /** The manager hides `object` farther than this from the player (world units) to save draw calls. */
  viewDistance = Infinity;

  update(_dt: number, _ctx: GameContext): void {}

  getBounds(out: AABB): AABB {
    out.minX = this.position.x - this.halfWidth;
    out.maxX = this.position.x + this.halfWidth;
    out.minY = this.position.y;
    out.maxY = this.position.y + this.height;
    out.minZ = this.position.z - this.halfWidth;
    out.maxZ = this.position.z + this.halfWidth;
    return out;
  }

  /** E key while targeted. */
  interact?(ctx: GameContext): void;
  /** HUD hint while targeted, e.g. «E — открыть дверь». Return null when there is nothing to do. */
  hint?(ctx: GameContext): string | null;
  /** Player hit with LMB. */
  onHit?(ctx: GameContext, hit: HitInfo): void;
  /** Called once after the entity left the manager (release lights, sounds…). */
  onRemove?(ctx: GameContext): void;
  /**
   * A loud noise at `pos` within earshot (EntityManager.emitNoise: barking, a falling tree, breaking
   * glass…). Handlers only record it; they must not emit noises themselves.
   */
  onNoise?(ctx: GameContext, pos: Vec3Like): void;
}
