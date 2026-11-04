/**
 * Deterministic world plan. OWNER: agent "worldgen".
 * Combines planTown() (agent "town") with natural features (trees, bushes, boulders, outcrops,
 * fallen logs, stumps), mob spawns, landmarks and the player spawn.
 */
import { TOWN_BUILD_RECT, TOWN_GROUND_Y } from '../config';
import { planNature } from './nature/placement';
import { createNaturalTerrain } from './terrain';
import { planTown } from './town/index';
import type { WorldPlan } from './types';

/**
 * Builds the plan. Called once on the main thread and once in every generation worker; the result
 * must be identical everywhere (use core/rng only, no Math.random, no Date). Target cost < 100 ms.
 */
export function createWorldPlan(seed: number): WorldPlan {
  const terrain = createNaturalTerrain(seed);
  const town = planTown({ seed, terrain });
  const playerSpawn = { x: town.entrance.x, y: TOWN_GROUND_Y, z: town.entrance.z, yaw: town.entrance.yaw };
  const townCentre = { x: (TOWN_BUILD_RECT.x0 + TOWN_BUILD_RECT.x1) >> 1, z: (TOWN_BUILD_RECT.z0 + TOWN_BUILD_RECT.z1) >> 1 };
  const nature = planNature(seed, terrain, town, playerSpawn, townCentre);
  return {
    seed,
    // Town features first: the tile generator stamps by (order, index), so ties favour the town.
    features: [...town.features, ...nature.features],
    spawns: [...town.spawns, ...nature.spawns],
    playerSpawn,
    landmarks: [...nature.landmarks, ...town.landmarks],
  };
}
