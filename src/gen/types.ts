/**
 * World-generation contracts (pure data/types — importable from workers).
 *
 * Pipeline (see ARCHITECTURE.md › Generation):
 *  1. `createWorldPlan(seed)` (gen/plan.ts) builds the deterministic world plan: features (trees,
 *     buildings, rocks, roads…) with bounding boxes, entity spawns and the player spawn. Every
 *     generation worker and the main thread call it independently and MUST get identical results.
 *  2. Each worker job generates one GEN_TILE×GEN_TILE tile over the full height: terrain columns →
 *     overlapping features sorted by `order` (each clipped to the tile by the VoxelWriter) →
 *     surface decoration (plants) → chunk extraction with uniform detection + sky heights.
 */
import type { BiomeId } from '../config';

/** Clipped voxel writer over the tile being generated (world coordinates). */
export interface VoxelWriter {
  /** Tile bounds in voxels; max exclusive. Writes outside [x0,x1)×[0,WORLD_Y)×[z0,z1) are ignored. */
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
  inTile(x: number, z: number): boolean;
  /** Block at (x,y,z): AIR outside the tile horizontally or above the world, BEDROCK below 0. */
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number): void;
  /** Writes only if the current block is AIR or a plant (keeps trees from overwriting buildings, etc.). */
  setSoft(x: number, y: number, z: number, id: number): void;
  /** Fills the box [x0,x1)×[y0,y1)×[z0,z1) (clipped). */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void;
}

export interface GenContext {
  seed: number;
  terrain: TerrainSampler;
}

/** Stamping order conventions (lower first). */
export const ORDER = {
  GROUND: 10, // roads, plazas, pond edits, town ground details
  BUILDING: 20,
  PROP: 30, // fences, car wrecks, lamp posts, rubble piles
  ROCK: 35,
  TREE: 40,
  DECOR: 50, // fallen logs, stumps, mushrooms, small details
} as const;

export interface Feature {
  /** Debug label, e.g. 'tree:oak', 'house:brick2', 'road'. */
  kind: string;
  /** Conservative bounding box (voxels, min inclusive, max exclusive) containing every voxel stamp() may write. */
  min: [number, number, number];
  max: [number, number, number];
  order: number;
  /** Writes the feature. Must be deterministic and only depend on its own parameters + ctx (never on tile bounds). */
  stamp(w: VoxelWriter, ctx: GenContext): void;
}

export interface ColumnSample {
  /** Dominant biome at this column. */
  biome: BiomeId;
  /** Blend weights [town, forest, meadow, hills]; sum = 1. */
  weights: [number, number, number, number];
  /** First air voxel above natural ground (top ground voxel is surfaceY - 1). In the town = TOWN_GROUND_Y. */
  surfaceY: number;
  /** First air voxel above the water surface, or 0 if this column has no water. */
  waterY: number;
  /** Block id of the top ground voxel (GRASS, LITTER, SAND, STONE, MUD…). */
  topBlock: number;
}

export interface TerrainSampler {
  sample(x: number, z: number, out: ColumnSample): ColumnSample;
  /** Shortcut: natural ground level (first air voxel) at integer column (x, z). */
  surfaceY(x: number, z: number): number;
  biomeAt(x: number, z: number): BiomeId;
}

export type Facing = 0 | 1 | 2 | 3; // 0: +Z (south), 1: +X (east), 2: -Z (north), 3: -X (west)
export type MobKind = 'deer' | 'dog';
export type DoorStyle = 'wood' | 'wood_painted' | 'metal';
export type ContainerStyle = 'crate' | 'cabinet' | 'fridge' | 'toolbox';

export interface LootEntry {
  item: string;
  count: number;
}

/**
 * A door in a doorway opening. The opening spans voxels
 *   along `axis`: [x, x+width) or [z, z+width), vertically [y, y+height),
 *   across the wall: `depth` voxels starting at z (axis 'x') or x (axis 'z').
 * The generator leaves the opening empty (AIR); the door entity fills it visually and blocks movement while closed.
 */
export interface DoorSpawn {
  type: 'door';
  x: number;
  y: number;
  z: number;
  axis: 'x' | 'z';
  width: number;
  height: number;
  depth: number;
  /** Hinge at the min or max end of the opening along `axis`. */
  hinge: 'min' | 'max';
  /** Side (+1 / -1 along the wall normal) into which the door swings when opened. */
  swing: 1 | -1;
  style: DoorStyle;
  open?: boolean;
}

/** A container (loot) entity standing on the floor. Position = bottom centre, world units. Its front faces `facing`: object.rotation.y = facing·π/2 (model front = +Z). */
export interface ContainerSpawn {
  type: 'container';
  x: number;
  y: number;
  z: number;
  facing: Facing;
  style: ContainerStyle;
  loot: LootEntry[];
}

/** A loose item lying in the world. Position = world units; y = the intended floor level (snapped with world.floorBelow, never topSolidY). */
export interface ItemSpawn {
  type: 'item';
  x: number;
  y: number;
  z: number;
  item: string;
  count: number;
}

/** y = the intended ground level (snapped with world.floorBelow). */
export interface MobSpawn {
  type: 'mob';
  mob: MobKind;
  x: number;
  y: number;
  z: number;
}

export type EntitySpawn = DoorSpawn | ContainerSpawn | ItemSpawn | MobSpawn;

export interface Landmark {
  name: string;
  x: number;
  z: number;
}

export interface WorldPlan {
  seed: number;
  features: Feature[];
  spawns: EntitySpawn[];
  /** Player feet position (world units) and initial yaw (radians, 0 = looking to -Z; for a look direction (dx, dz): yaw = atan2(-dx, -dz)). */
  playerSpawn: { x: number; y: number; z: number; yaw: number };
  /** Named places for the map screen. */
  landmarks: Landmark[];
}

/** What the town planner returns (gen/town). */
export interface TownPlan {
  features: Feature[];
  spawns: EntitySpawn[];
  landmarks: Landmark[];
  /**
   * Player spawn suggestion: a clear spot on the road at the town's south-east entrance (close to the
   * map centre where all four regions meet), y = TOWN_GROUND_Y, yaw facing into the town
   * (yaw = atan2(-dx, -dz) for look direction (dx, dz); 0 looks to -Z). The starter
   * toolbox container sits 2–4 m from it, in view.
   */
  entrance: { x: number; z: number; yaw: number };
}
