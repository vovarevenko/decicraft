/**
 * Builds and disposes the THREE objects of one meshed octree node: a Group (positioned at the node
 * origin) with up to four meshes — opaque, glass, water, plants. Geometries use the compact vertex
 * formats of layout.ts, share one quad index buffer (drawRange limits each mesh), carry bounding
 * volumes from the node bounds and drop their CPU arrays once uploaded.
 */
import * as THREE from 'three';
import {
  NODE_CELLS,
  PLANT_DATA_ATTR,
  PLANT_MAX_HEIGHT,
  PLANT_VERTEX_BYTES,
  VOXEL_DATA_ATTR,
  VOXEL_VERTEX_BYTES,
} from './layout';
import type { MeshOutput } from './mesher';
import type { VoxelMaterials } from './materials';

/** Built node: the group plus its accounting. */
export interface NodeMeshObjects {
  group: THREE.Group;
  /** Vertex bytes held by the GPU (the shared index buffer is not counted). */
  bytes: number;
  triangles: number;
}

let quadIndex: THREE.BufferAttribute | null = null;
let quadCapacity = 0;

/** Shared index buffer for `quads` quads with the pattern (0,1,2)(0,2,3); grows by doubling. */
function quadIndexFor(quads: number): THREE.BufferAttribute {
  if (quadIndex === null || quadCapacity < quads) {
    let cap = Math.max(1 << 16, quadCapacity * 2);
    while (cap < quads) cap *= 2;
    const idx = new Uint32Array(cap * 6);
    for (let q = 0, v = 0, i = 0; q < cap; q++, v += 4, i += 6) {
      idx[i] = v;
      idx[i + 1] = v + 1;
      idx[i + 2] = v + 2;
      idx[i + 3] = v;
      idx[i + 4] = v + 2;
      idx[i + 5] = v + 3;
    }
    quadIndex = new THREE.BufferAttribute(idx, 1);
    quadCapacity = cap;
  }
  return quadIndex;
}

/** Bounds of opaque / glass / water geometry in local cell units. */
const CELL_BOX = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(NODE_CELLS, NODE_CELLS, NODE_CELLS));
const CELL_SPHERE = CELL_BOX.getBoundingSphere(new THREE.Sphere());

const noRaycast = (): void => {};

/** Anything three uploads with an upload callback (InterleavedBuffer has onUpload at runtime, but @types/three 0.170 omits it). */
interface Uploadable {
  onUpload(callback: () => void): unknown;
  array: unknown;
}

/** Frees a buffer's CPU copy once three has uploaded it. */
function releaseAfterUpload(buffer: Uploadable): void {
  buffer.onUpload(() => {
    buffer.array = null;
  });
}

function voxelMesh(bytes: Uint8Array, quads: number, material: THREE.Material, cell: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const buffer = new THREE.InterleavedBuffer(bytes, VOXEL_VERTEX_BYTES);
  releaseAfterUpload(buffer as unknown as Uploadable);
  geometry.setAttribute('position', new THREE.InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute(VOXEL_DATA_ATTR, new THREE.InterleavedBufferAttribute(buffer, 4, 4));
  geometry.setIndex(quadIndexFor(quads));
  geometry.setDrawRange(0, quads * 6);
  geometry.boundingBox = CELL_BOX;
  geometry.boundingSphere = CELL_SPHERE;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(cell);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.raycast = noRaycast;
  return mesh;
}

function plantMesh(pos: Int16Array, data: Uint8Array, quads: number, material: THREE.Material, size: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(pos, 4);
  const pdata = new THREE.BufferAttribute(data, 4);
  releaseAfterUpload(position);
  releaseAfterUpload(pdata);
  geometry.setAttribute('position', position);
  geometry.setAttribute(PLANT_DATA_ATTR, pdata);
  geometry.setIndex(quadIndexFor(quads));
  geometry.setDrawRange(0, quads * 6);
  // Positions are Int16 in 1/32 voxel; the shader scales them, so bounds are in voxels (node-local).
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(size + 1, size + PLANT_MAX_HEIGHT + 1, size + 1));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.raycast = noRaycast;
  return mesh;
}

/**
 * Builds the node group, or returns null when the mesh output has no geometry. Only level-0 opaque
 * meshes cast shadows; opaque and plant meshes receive them; glass and water do neither.
 */
export function buildNodeMesh(
  out: MeshOutput,
  level: number,
  x0: number,
  y0: number,
  z0: number,
  materials: VoxelMaterials,
): NodeMeshObjects | null {
  const quads = out.opaqueQuads + out.glassQuads + out.waterQuads + out.plantQuads;
  if (quads === 0) return null;
  const cell = 1 << level;
  const group = new THREE.Group();
  group.name = `voxel-node-L${level}`;
  group.position.set(x0, y0, z0);
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  let bytes = 0;
  if (out.opaque !== null) {
    const m = voxelMesh(out.opaque, out.opaqueQuads, materials.opaque, cell);
    m.castShadow = level === 0;
    m.receiveShadow = true;
    group.add(m);
    bytes += out.opaque.byteLength;
  }
  if (out.glass !== null) {
    group.add(voxelMesh(out.glass, out.glassQuads, materials.glass, cell));
    bytes += out.glass.byteLength;
  }
  if (out.water !== null) {
    group.add(voxelMesh(out.water, out.waterQuads, materials.water, cell));
    bytes += out.water.byteLength;
  }
  if (out.plantPos !== null && out.plantData !== null) {
    // Plants show only within RENDER.plantFadeEnd of the camera, always inside the shadow box.
    const m = plantMesh(out.plantPos, out.plantData, out.plantQuads, materials.plants, NODE_CELLS << level);
    m.receiveShadow = true;
    group.add(m);
    bytes += out.plantQuads * 4 * PLANT_VERTEX_BYTES;
  }
  return { group, bytes, triangles: quads * 2 };
}

/** Disposes the node's geometries (the shared index is detached first so it stays on the GPU). */
export function disposeNodeMesh(group: THREE.Group): void {
  for (const child of group.children) {
    const geometry = (child as THREE.Mesh).geometry;
    geometry.setIndex(null);
    geometry.dispose();
  }
  group.clear();
}

/**
 * One invisible single-quad mesh per material with the real attribute layout. They are never drawn,
 * but renderer.compile() visits invisible objects too, so every voxel program is compiled up front.
 */
export function buildWarmupGroup(materials: VoxelMaterials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'voxel-warmup';
  group.visible = false;
  const quad = new Uint8Array(4 * VOXEL_VERTEX_BYTES);
  group.add(voxelMesh(quad.slice(), 1, materials.opaque, 1));
  group.add(voxelMesh(quad.slice(), 1, materials.glass, 1));
  group.add(voxelMesh(quad.slice(), 1, materials.water, 1));
  group.add(plantMesh(new Int16Array(16), new Uint8Array(16), 1, materials.plants, NODE_CELLS));
  return group;
}
