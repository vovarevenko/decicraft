/**
 * Global constants for «Дециметр».
 *
 * UNITS: 1 world unit = 1 voxel = 1 decimetre (0.1 m). Every position, size, velocity and
 * distance in game code is in world units unless the identifier says otherwise (`…M` = metres,
 * `…Cm` = centimetres). Small "centimetre" models (tools, mobs) are built from 1 cm voxels,
 * i.e. 0.1 world units per model voxel.
 *
 * AXES: +X = east, +Y = up, +Z = south (three.js convention: a camera with yaw 0 looks to -Z).
 * The world spans [0, WORLD_X) × [0, WORLD_Y) × [0, WORLD_Z) voxels. Voxel (x, y, z) occupies the
 * unit cube [x, x+1) × [y, y+1) × [z, z+1).
 */

export const VOXEL_M = 0.1;
export const UNITS_PER_M = 10;
/** Metres → world units. */
export const M = (metres: number): number => metres * UNITS_PER_M;

// ---------------------------------------------------------------- chunks
export const CHUNK_BITS = 5;
/** Chunk edge in voxels (32 voxels = 3.2 m). */
export const CHUNK = 1 << CHUNK_BITS;
export const CHUNK_MASK = CHUNK - 1;
export const CHUNK_VOL = CHUNK * CHUNK * CHUNK; // 32768

// ---------------------------------------------------------------- world
export const WORLD_X = 1280; // 128 m
export const WORLD_Y = 512; // 51.2 m
export const WORLD_Z = 1280; // 128 m
export const CHUNKS_X = WORLD_X / CHUNK; // 40
export const CHUNKS_Y = WORLD_Y / CHUNK; // 16
export const CHUNKS_Z = WORLD_Z / CHUNK; // 40
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z; // 25600
export const WORLD_SEED = 20261103;

// ---------------------------------------------------------------- generation
/** Horizontal size (voxels) of one generation job. A job generates the full world height. */
export const GEN_TILE = 128;
export const GEN_TILES_X = WORLD_X / GEN_TILE; // 10
export const GEN_TILES_Z = WORLD_Z / GEN_TILE; // 10

// ---------------------------------------------------------------- biomes
export const BIOME_TOWN = 0;
export const BIOME_FOREST = 1;
export const BIOME_MEADOW = 2;
export const BIOME_HILLS = 3;
export type BiomeId = 0 | 1 | 2 | 3;
export const BIOME_NAMES: readonly string[] = [
  'Заброшенный городок',
  'Лиственный лес',
  'Луг с прудом',
  'Скалистые холмы',
];
/**
 * Quadrant layout (x and z split at QUADRANT_SPLIT; borders between natural biomes are
 * noise-warped and blended, the town border is mostly straight):
 *   NW (x < 640, z < 640)  = town      NE (x ≥ 640, z < 640) = forest
 *   SW (x < 640, z ≥ 640)  = meadow    SE (x ≥ 640, z ≥ 640) = rocky hills
 */
export const QUADRANT_SPLIT = 640;
export const TOWN_RECT = { x0: 0, z0: 0, x1: 640, z1: 640 } as const;
/** Buildings, roads and props must stay inside this rect; terrain is exactly flat inside it (+2 m margin). */
export const TOWN_BUILD_RECT = { x0: 40, z0: 40, x1: 590, z1: 590 } as const;
/** First air voxel above the flat town ground (the ground's top voxel is at TOWN_GROUND_Y - 1). */
export const TOWN_GROUND_Y = 120;
/** Typical natural ground level (first air voxel) around the map centre. */
export const BASE_GROUND_Y = 120;

// ---------------------------------------------------------------- physics & player
export const GRAVITY = 98.1; // 9.81 m/s² in units/s²
export const MOUSE_SENSITIVITY = 0.0022; // radians per pixel
export const PLAYER = {
  halfWidth: 3, // 0.6 m wide body
  height: 18, // 1.8 m
  crouchHeight: 14,
  eyeHeight: 16.5,
  crouchEyeHeight: 12.5,
  walkSpeed: 38, // 3.8 m/s
  sprintSpeed: 70,
  crouchSpeed: 15,
  swimSpeed: 22,
  flySpeed: 120,
  flySprintSpeed: 300,
  jumpSpeed: 34, // ≈ 0.6 m standing jump
  stepHeight: 4.2, // automatic step-up of up to 4 voxels (40 cm)
  /** Max ledge height (above the feet) the player can climb onto by holding Space against it. */
  mantleHeight: 12,
  /** Seconds a mantle (climb onto a ledge) takes. */
  mantleTime: 0.35,
  reach: 40, // 4 m interaction reach
} as const;

// ---------------------------------------------------------------- rendering
export const RENDER = {
  /** Device pixel ratio cap (target hardware: Apple M1 / 8 GB). */
  pixelRatioCap: 1,
  fov: 75,
  near: 0.5,
  far: 4000,
  /** Level-0 mesh node edge in voxels (2×2×2 chunks). A level-L node covers MESH_NODE·2^L voxels with 2^L-voxel cells. */
  meshNode: 64,
  /** Number of LOD levels (0..2). Level-2 nodes are 256³ voxels; the world is 5×2×5 of them. */
  lodLevels: 3,
  /** A level-L node (L ≥ 1) is replaced by its 8 children when the camera is closer than lodSplitDist[L-1] to its AABB. */
  lodSplitDist: [180, 400] as readonly number[],
  /** Children merge back into their parent only beyond lodSplitDist + this margin (prevents flip-flopping). */
  lodMergeMargin: 20,
  /** Plants fade out completely by this camera distance (must be < lodSplitDist[0]). */
  plantFadeEnd: 150,
  /** LRU budget for cached (displayed + nearby) voxel meshes, bytes. */
  meshCacheBytes: 150 * 1024 * 1024,
  /** Bytes of newly shown voxel geometry per frame (edit re-meshes are exempt). */
  uploadBytesPerFrame: 1.5 * 1024 * 1024,
  shadowMapSize: 2048,
  /** Half-extent (world units) of the sun shadow box that follows the player. */
  shadowExtent: 200,
  maxPointLights: 4,
} as const;

// ---------------------------------------------------------------- time
export const TIME = {
  /** Real seconds per in-game day at normal speed. */
  dayLengthS: 1800,
  startHour: 9.5,
  /** Multiplier while the fast-forward key (T) is held. */
  fastForwardMult: 60,
  /** Deep night (nightStartHour → nightEndHour) runs this many times faster, so sessions stay mostly in daylight. */
  nightSpeedMult: 4,
  nightStartHour: 21.5,
  nightEndHour: 4.5,
} as const;

// ---------------------------------------------------------------- gameplay
export const GAMEPLAY = {
  /** Cube edge sizes (voxels) selectable for placing materials with [ and ]. */
  placeSizes: [1, 2, 3, 4, 5] as readonly number[],
  /** Max voxels in one detached piece that may become a falling body (trees, wall chunks). */
  maxFallingBodyVoxels: 400_000,
  /** Max voxels visited by one structural-support search before assuming "supported". */
  supportSearchBudget: 400_000,
  /** Max voxels filled by one water-flow step after digging next to water. */
  waterFillBudget: 6000,
  /** Radius (world units) in which a campfire counts as "nearby" for cooking recipes. */
  campfireRadius: 30,
  /** Item drops are auto-collected within this distance after `autoPickupDelayS`. */
  autoPickupRadius: 12,
  autoPickupDelayS: 0.8,
} as const;

/** Worker pool sizes; leaves room for the main thread and the browser on an 8-core M1. */
export function workerCount(kind: 'gen' | 'mesh'): number {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return kind === 'gen' ? Math.max(2, Math.min(7, hc - 1)) : Math.max(2, Math.min(4, hc - 2));
}
