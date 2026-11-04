/**
 * Water flowing into dug cells (ARCHITECTURE.md §11.3). OWNER: agent "interaction".
 * An emptied cell with WATER beside or above it fills with water, and the fill spreads (6-neighbourhood BFS)
 * into connected AIR cells at or below the source's surface level — water finds its level but never climbs
 * above it. The source is not drained (ponds are large next to a dig).
 */
import { WORLD_X, WORLD_Y, WORLD_Z } from '../../config';
import { B } from '../../world/blocks';
import type { World, WorldData } from '../../world/world';
import type { VoxelList } from './voxelList';

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];
/** Neighbours that can feed an emptied cell: the four sides and above (indices into DX/DY/DZ). */
const FEEDERS = [0, 1, 2, 4, 5];

/** y of the topmost WATER voxel of the water column containing (x, y, z). */
function surfaceOf(world: WorldData, x: number, y: number, z: number): number {
  while (y + 1 < WORLD_Y && world.getBlock(x, y + 1, z) === B.WATER) y++;
  return y;
}

/** Surface level (y of the top water voxel) of the highest WATER neighbour beside or above (x, y, z); -1 if none. */
export function sourceLevel(world: WorldData, x: number, y: number, z: number): number {
  let level = -1;
  for (let f = 0; f < FEEDERS.length; f++) {
    const k = FEEDERS[f];
    const nx = x + DX[k];
    const ny = y + DY[k];
    const nz = z + DZ[k];
    if (world.getBlock(nx, ny, nz) === B.WATER) level = Math.max(level, surfaceOf(world, nx, ny, nz));
  }
  return level;
}

/**
 * Floods water from the emptied `cells` (packed triples) that touch water, filling at most `budget` cells.
 * Every filled cell is appended to `filled` (which doubles as the BFS queue). Returns the number filled.
 */
export function flowWater(world: World, cells: ArrayLike<number>, budget: number, filled: VoxelList): number {
  const start = filled.count;
  const n = Math.floor(cells.length / 3);
  for (let i = 0; i < n; i++) {
    const x = cells[i * 3];
    const y = cells[i * 3 + 1];
    const z = cells[i * 3 + 2];
    if (world.getBlock(x, y, z) !== B.AIR) continue;
    const level = sourceLevel(world, x, y, z);
    if (level < 0) continue;
    if (filled.count - start >= budget) break;
    let head = filled.count;
    world.setBlock(x, y, z, B.WATER);
    filled.push(x, y, z, B.WATER);
    while (head < filled.count) {
      const px = filled.positions[head * 3];
      const py = filled.positions[head * 3 + 1];
      const pz = filled.positions[head * 3 + 2];
      head++;
      for (let k = 0; k < 6; k++) {
        const qx = px + DX[k];
        const qy = py + DY[k];
        const qz = pz + DZ[k];
        if (qy > level || qy < 0 || qx < 0 || qz < 0 || qx >= WORLD_X || qz >= WORLD_Z) continue;
        if (world.getBlock(qx, qy, qz) !== B.AIR) continue;
        if (filled.count - start >= budget) return filled.count - start;
        world.setBlock(qx, qy, qz, B.WATER);
        filled.push(qx, qy, qz, B.WATER);
      }
    }
  }
  return filled.count - start;
}
