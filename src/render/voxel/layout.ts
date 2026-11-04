/**
 * Shared layout of the voxel render pipeline: node / padded-volume geometry, face directions and the
 * compact vertex formats. Pure data — imported by the mesh workers, the mesher, the renderer and the
 * materials, so every side agrees on the byte layout.
 */
import { RENDER } from '../../config';
import { B } from '../../world/blocks';

/** Cells per node edge: every LOD level meshes 64³ cells (a level-L cell is 2^L voxels). */
export const NODE_CELLS = RENDER.meshNode;
/** Edge of the padded cell volume handed to the mesher (one cell of padding on each side). */
export const PAD = NODE_CELLS + 2;
export const PAD2 = PAD * PAD;
export const PAD3 = PAD2 * PAD;
/** Edge of the vertex grid of a node (corners of 64 cells). */
export const VERTS = NODE_CELLS + 1;
/**
 * Vertical faces take their skylight from the columns up to this many cells in front of them (past
 * eaves), so the sky/canopy column samples reach this far beyond the columns around the vertex grid.
 * That is at most 7 voxels from the face's cell at any level (mesher.ts SKY_ROWS): less than a chunk,
 * so a sky change that dirties its own chunk also re-meshes every node it can affect (nodes are
 * re-meshed when a dirty chunk touches them or their padding).
 */
export const SKY_REACH = 5;
/**
 * Edge of the column-sample grid (VolumeBuilder.colSky / colCanopy): the VERTS + 1 columns around the
 * vertex grid plus SKY_REACH more on each side. Vertex i lies between columns i + SKY_REACH and i + SKY_REACH + 1.
 */
export const COLS = VERTS + 1 + 2 * SKY_REACH;

/**
 * Index of padded cell (x, y, z), each coordinate in −1..NODE_CELLS. Same x-fastest, then z, then y
 * order as chunk arrays, so horizontal rows are contiguous.
 */
export const padIndex = (x: number, y: number, z: number): number => x + 1 + (z + 1) * PAD + (y + 1) * PAD2;

/** Face directions. The index doubles as the normal id stored in vertices and as the bit in boundary masks. */
export const DIR = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const;

/**
 * Opaque / glass / water vertex: 8 interleaved bytes.
 *  - bytes 0–3 `position`: x, y, z in cell units (0..64; mesh.scale = cell size), 0.
 *  - bytes 4–7 `vdata`: normal id (DIR), AO 0..3 (water: 1 = vertex lowered to the surface level),
 *    skylight 0..15, block id.
 */
export const VOXEL_VERTEX_BYTES = 8;
/** Name of the packed per-vertex data attribute of opaque / glass / water meshes. */
export const VOXEL_DATA_ATTR = 'vdata';

/** Plant positions are Int16 in 1/PLANT_POS_SCALE voxel units, node-local. */
export const PLANT_POS_SCALE = 32;
/**
 * Plant vertex: `position` Int16×4 (x, y, z, 0) + `pdata` Uint8×4: atlas tile, corner bits
 * (bit 0 = right edge, bit 1 = top edge, bits 2–7 = plant height in quarter voxels), skylight 0..15,
 * per-plant hash.
 */
export const PLANT_VERTEX_BYTES = 12;
export const PLANT_DATA_ATTR = 'pdata';

/** Plant blocks in atlas tile order. */
export const PLANT_TILE_BLOCKS: readonly number[] = [
  B.TALL_GRASS,
  B.FLOWER_YELLOW,
  B.FLOWER_WHITE,
  B.FLOWER_BLUE,
  B.FERN,
  B.REEDS,
  B.MUSHROOM,
  B.DRY_GRASS,
];
export const PLANT_TILE_COUNT = PLANT_TILE_BLOCKS.length;

/** Atlas tile of every block id; plant blocks without a dedicated tile use the grass tile. */
export const PLANT_TILE = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  const tile = PLANT_TILE_BLOCKS.indexOf(id);
  PLANT_TILE[id] = tile >= 0 ? tile : 0;
}
/** Plants never exceed this height (voxels): bounds of plant meshes and the 6-bit height field. */
export const PLANT_MAX_HEIGHT = 15.75;
/** Half width of a plant quad in voxels (each of the two crossed quads is 1.2 voxels wide). */
export const PLANT_HALF_WIDTH = 0.6;
