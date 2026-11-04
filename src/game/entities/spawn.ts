/**
 * Creates entities for the world plan's spawns. OWNER: agent "entities".
 */
import { hash32 } from '../../core/rng';
import type { EntitySpawn } from '../../gen/types';
import type { GameContext } from '../context';
import { ITEMS } from '../items';
import { Deer, DeerHerd } from '../mobs/deer';
import { Dog } from '../mobs/dog';
import { Container } from './container';
import { Door } from './door';
import type { Entity } from './entity';
import { ItemDrop } from './itemDrop';

/** Deer spawned within this distance (25 m) of a herd's first member join that herd. */
const HERD_JOIN_DIST = 250;

/**
 * Adds doors, containers, item drops and mobs to ctx.entities (snapping items/mobs onto the ground).
 * Items and mobs are snapped with world.floorBelow from the spawn's y (never topSolidY, which would put
 * them on roofs and tree tops); doors and containers are placed exactly. Nearby deer form herds. A spawn
 * that fails to build is logged and skipped.
 */
export function spawnFromPlan(ctx: GameContext, spawns: readonly EntitySpawn[]): void {
  const herds: DeerHerd[] = [];
  for (let i = 0; i < spawns.length; i++) {
    const spawn = spawns[i];
    try {
      const entity = createEntity(ctx, spawn, i, herds);
      if (entity) ctx.entities.add(entity);
    } catch (err) {
      console.error(`[entities] spawn #${i} (${spawn.type}) failed`, spawn, err);
    }
  }
}

function createEntity(ctx: GameContext, s: EntitySpawn, index: number, herds: DeerHerd[]): Entity | null {
  switch (s.type) {
    case 'door':
      return new Door(s);
    case 'container':
      return new Container(s);
    case 'item': {
      if (!ITEMS[s.item] || s.count <= 0) {
        console.warn(`[entities] item spawn skipped: ${s.count} × «${s.item}»`);
        return null;
      }
      return new ItemDrop(s.item, s.count, { x: s.x, y: ctx.world.floorBelow(s.x, s.y, s.z), z: s.z });
    }
    case 'mob': {
      const y = ctx.world.floorBelow(s.x, s.y, s.z);
      const seed = hash32(ctx.plan.seed ^ hash32(index + 1));
      return s.mob === 'deer' ? new Deer(s.x, y, s.z, seed, herdFor(herds, s.x, s.z)) : new Dog(s.x, y, s.z, seed);
    }
  }
}

/** The herd whose first member is within HERD_JOIN_DIST of (x, z), or a new one. */
function herdFor(herds: DeerHerd[], x: number, z: number): DeerHerd {
  for (const herd of herds) {
    const first = herd.members[0];
    if (first && Math.hypot(first.position.x - x, first.position.z - z) <= HERD_JOIN_DIST) return herd;
  }
  const herd = new DeerHerd();
  herds.push(herd);
  return herd;
}
