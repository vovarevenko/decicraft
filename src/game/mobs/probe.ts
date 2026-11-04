/**
 * Cheap voxel probes for mob steering: what is the ground like a little way ahead? Pure functions
 * over WorldData (testable with a fake world). OWNER: agent "entities".
 */
import { B, SOLID } from '../../world/blocks';
import type { WorldData } from '../../world/world';

/** Ledges up to this many voxels are climbed by moveBody's step-up. */
export const MOB_STEP_HEIGHT = 5;
/** Ledges up to this many voxels are jumped onto. */
export const MOB_MAX_JUMP = 10;
/** Mobs never walk off an edge deeper than this (1.5 m). */
export const MOB_MAX_DROP = 15;

/**
 * - 'ok': walkable; `dy` = floor level relative to the feet (≤ MOB_STEP_HEIGHT up, or a drop ≤ MOB_MAX_DROP down);
 * - 'jump': a ledge `dy` voxels high (MOB_STEP_HEIGHT < dy ≤ MOB_MAX_JUMP);
 * - 'wall': higher than a jump;
 * - 'cliff': a drop deeper than MOB_MAX_DROP;
 * - 'water': water at or below the feet before any floor (`dy` = −depth of its surface below the feet).
 */
export type ProbeKind = 'ok' | 'jump' | 'wall' | 'cliff' | 'water';

export interface GroundProbe {
  kind: ProbeKind;
  dy: number;
}

export const makeGroundProbe = (): GroundProbe => ({ kind: 'ok', dy: 0 });

/** Classifies column (x, z) for a body whose feet are at `feetY` (reads at most ~17 voxels). */
export function probeGround(
  world: Pick<WorldData, 'getBlock'>,
  x: number,
  z: number,
  feetY: number,
  out: GroundProbe,
): GroundProbe {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const y0 = Math.floor(feetY + 0.01);
  let id = world.getBlock(xi, y0, zi);
  if (SOLID[id]) {
    let rise = 1;
    while (rise <= MOB_MAX_JUMP && SOLID[world.getBlock(xi, y0 + rise, zi)]) rise++;
    out.dy = rise;
    out.kind = rise <= MOB_STEP_HEIGHT ? 'ok' : rise <= MOB_MAX_JUMP ? 'jump' : 'wall';
    return out;
  }
  for (let d = 0; d <= MOB_MAX_DROP; d++) {
    if (id === B.WATER) {
      out.kind = 'water';
      out.dy = d > 0 ? -d : 0;
      return out;
    }
    id = world.getBlock(xi, y0 - d - 1, zi);
    if (SOLID[id]) {
      out.kind = 'ok';
      out.dy = d > 0 ? -d : 0;
      return out;
    }
  }
  out.kind = 'cliff';
  out.dy = -(MOB_MAX_DROP + 1);
  return out;
}
