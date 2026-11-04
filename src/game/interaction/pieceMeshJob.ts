/**
 * Mesh of a falling piece (see game/fallingBody.ts): its block grid → the 10 cm voxel geometry with the blocks' side
 * colours, and the geometry ⇄ plain transferable arrays, so the felling worker (fellingJob.ts) can build it.
 * OWNER: agent "interaction".
 */
import * as THREE from 'three';
import { buildVoxelGeometry, VoxelGrid } from '../../render/voxelModel';
import { COLOR_SIDE } from '../../world/blocks';

/** A built geometry as arrays: attributes, index and the bounds (box min, box max, sphere centre, radius). */
export interface PieceMeshData {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint16Array | Uint32Array;
  bounds: Float64Array;
}

/** Side colour of each block id as a VoxelGrid cell (sRGB | 0xFF000000). */
const CELL_COLOR = new Uint32Array(256);
for (let id = 1; id < 256; id++) {
  CELL_COLOR[id] = (0xff000000 | (COLOR_SIDE[id * 3] << 16) | (COLOR_SIDE[id * 3 + 1] << 8) | COLOR_SIDE[id * 3 + 2]) >>> 0;
}

/** Geometry of a piece grid at scale 1 with its origin at the grid's min corner. */
export function buildPieceGeometry(sx: number, sy: number, sz: number, ids: Uint8Array): THREE.BufferGeometry {
  const colors = new VoxelGrid(sx, sy, sz);
  // Piece grids and colour grids share their cell order, x + sx·(y + sy·z).
  const cells = colors.data;
  for (let i = 0; i < ids.length; i++) if (ids[i] !== 0) cells[i] = CELL_COLOR[ids[i]];
  return buildVoxelGeometry(colors, { scale: 1, origin: [0, 0, 0] });
}

export function geometryToData(geometry: THREE.BufferGeometry): PieceMeshData {
  const box = geometry.boundingBox!;
  const sphere = geometry.boundingSphere!;
  return {
    position: geometry.getAttribute('position').array as Float32Array,
    normal: geometry.getAttribute('normal').array as Float32Array,
    color: geometry.getAttribute('color').array as Float32Array,
    index: geometry.getIndex()!.array as Uint16Array | Uint32Array,
    bounds: Float64Array.of(
      ...box.min.toArray(),
      ...box.max.toArray(),
      ...sphere.center.toArray(),
      sphere.radius,
    ),
  };
}

/** The buffers of the arrays (each its own), for transferring them. */
export const meshTransferables = (d: PieceMeshData): ArrayBuffer[] =>
  [d.position.buffer, d.normal.buffer, d.color.buffer, d.index.buffer, d.bounds.buffer] as ArrayBuffer[];

export function dataToGeometry(d: PieceMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(d.color, 3));
  geometry.setIndex(new THREE.BufferAttribute(d.index, 1));
  const b = d.bounds;
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(b[6], b[7], b[8]), b[9]);
  return geometry;
}
