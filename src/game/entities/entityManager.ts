/**
 * Owns all entities: update loop, scene membership, spatial queries, ray picking, noise events.
 * OWNER: agent "entities".
 *
 * An entity whose update() throws is logged and removed, so one broken entity cannot stop the game
 * loop. Queries skip entities marked as removed.
 */
import type * as THREE from 'three';
import type { Vec3Like } from '../../core/math';
import type { GameContext } from '../context';
import { makeAABB, type AABB } from '../physics';
import type { Entity } from './entity';

export interface EntityRayHit {
  entity: Entity;
  distance: number;
}

export class EntityManager {
  private readonly list: Entity[] = [];
  private readonly tmp: AABB = makeAABB();
  private readonly boxPool: AABB[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  get all(): readonly Entity[] {
    return this.list;
  }

  add<T extends Entity>(e: T): T {
    this.list.push(e);
    e.object.position.copy(e.position);
    this.scene.add(e.object);
    return e;
  }

  /** Marks for removal; detached at the end of the current/next update. */
  remove(e: Entity): void {
    e.removed = true;
  }

  update(dt: number, ctx: GameContext): void {
    const list = this.list;
    // Entities added during the loop (loot, thrown items) are updated in the same frame.
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.removed) continue;
      try {
        e.update(dt, ctx);
      } catch (err) {
        console.error(`[entities] ${e.type} #${e.id} failed in update() and was removed`, err);
        e.removed = true;
      }
      e.object.position.copy(e.position);
      if (e.viewDistance !== Infinity) {
        const p = ctx.player.position;
        const dx = e.position.x - p.x;
        const dy = e.position.y - p.y;
        const dz = e.position.z - p.z;
        e.object.visible = dx * dx + dy * dy + dz * dz <= e.viewDistance * e.viewDistance;
      }
    }
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.removed) {
        list[w++] = e;
        continue;
      }
      this.scene.remove(e.object);
      try {
        e.onRemove?.(ctx);
      } catch (err) {
        console.error(`[entities] ${e.type} #${e.id} failed in onRemove()`, err);
      }
    }
    list.length = w;
  }

  byType<T extends Entity>(type: string): T[] {
    return this.list.filter((e) => e.type === type && !e.removed) as T[];
  }

  /** Entities whose bottom-centre is within `radius` of `center`. */
  queryRadius(center: Vec3Like, radius: number, out: Entity[] = []): Entity[] {
    out.length = 0;
    const r2 = radius * radius;
    for (const e of this.list) {
      if (e.removed) continue;
      const dx = e.position.x - center.x;
      const dy = e.position.y - center.y;
      const dz = e.position.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2) out.push(e);
    }
    return out;
  }

  /** Nearest entity with a displayName whose box the ray hits within maxDist (slab test). */
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number, filter?: (e: Entity) => boolean): EntityRayHit | null {
    let best: Entity | null = null;
    let bestT = Infinity;
    const b = this.tmp;
    for (const e of this.list) {
      if (e.removed || !e.displayName || (filter && !filter(e))) continue;
      const t = rayBox(origin, dir, e.getBounds(b));
      if (t !== null && t <= maxDist && t < bestT) {
        best = e;
        bestT = t;
      }
    }
    return best ? { entity: best, distance: bestT } : null;
  }

  /** Boxes of solid entities overlapping `region`. Returned boxes are pooled: valid until the next call. */
  solidBoxes(region: AABB, out: AABB[] = []): AABB[] {
    out.length = 0;
    let n = 0;
    for (const e of this.list) {
      if (e.removed || !e.solid) continue;
      if (n >= this.boxPool.length) this.boxPool.push(makeAABB());
      const b = e.getBounds(this.boxPool[n]);
      if (b.maxX <= region.minX || b.minX >= region.maxX) continue;
      if (b.maxY <= region.minY || b.minY >= region.maxY) continue;
      if (b.maxZ <= region.minZ || b.minZ >= region.maxZ) continue;
      out.push(b);
      n++;
    }
    return out;
  }

  /**
   * A loud noise at `pos` (barking, a falling tree, breaking glass): every entity whose bottom-centre
   * is within `radius` gets onNoise(). Deer flee from noises.
   */
  emitNoise(ctx: GameContext, pos: Vec3Like, radius: number): void {
    const near = this.queryRadius(pos, radius);
    for (let i = 0; i < near.length; i++) near[i].onNoise?.(ctx, pos);
  }
}

/** Parametric span [enter, exit] of the ray inside the box, narrowed slab by slab (see rayBox). */
const span = new Float64Array(2);

function clipSlab(o: number, d: number, lo: number, hi: number): boolean {
  if (Math.abs(d) < 1e-9) return o >= lo && o <= hi;
  let t1 = (lo - o) / d;
  let t2 = (hi - o) / d;
  if (t1 > t2) {
    const t = t1;
    t1 = t2;
    t2 = t;
  }
  if (t1 > span[0]) span[0] = t1;
  if (t2 < span[1]) span[1] = t2;
  return span[0] <= span[1];
}

/** Ray vs AABB; returns entry distance (0 if the origin is inside) or null. */
export function rayBox(o: Vec3Like, d: Vec3Like, b: AABB): number | null {
  span[0] = 0;
  span[1] = Infinity;
  if (!clipSlab(o.x, d.x, b.minX, b.maxX)) return null;
  if (!clipSlab(o.y, d.y, b.minY, b.maxY)) return null;
  if (!clipSlab(o.z, d.z, b.minZ, b.maxZ)) return null;
  return span[0];
}
