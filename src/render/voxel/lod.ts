/**
 * Octree of mesh nodes (pure TypeScript). A level-L node covers (64·2^L)³ voxels meshed as 64³ cells
 * of 2^L voxels; roots are level RENDER.lodLevels − 1 (the world is 5×2×5 roots). Spec: ARCHITECTURE.md
 * §6.1 and the JSDoc of chunkRenderer.ts.
 */
import { CHUNK, CHUNK_BITS, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, RENDER, WORLD_X, WORLD_Y, WORLD_Z } from '../../config';
import { OPAQUE, RENDER_KIND, RK } from '../../world/blocks';
import type { World, WorldData } from '../../world/world';
import { DIR, NODE_CELLS } from './layout';

export const ROOT_LEVEL = RENDER.lodLevels - 1;
const PLANE = CHUNKS_X * CHUNKS_Z;
const NODE_BITS = Math.log2(NODE_CELLS);

export class LodNode {
  /** Index in LodTree.nodes. */
  id = 0;
  parent: this | null = null;
  readonly children: this[] = [];
  /** Edge in voxels. */
  readonly size: number;
  /** Cell edge in voxels (2^level). */
  readonly cell: number;
  /** DIR bits of the node faces lying on the world boundary. */
  readonly boundary: number;

  constructor(
    readonly level: number,
    readonly x0: number,
    readonly y0: number,
    readonly z0: number,
  ) {
    this.cell = 1 << level;
    this.size = NODE_CELLS << level;
    const s = this.size;
    this.boundary =
      (x0 + s >= WORLD_X ? 1 << DIR.PX : 0) |
      (x0 <= 0 ? 1 << DIR.NX : 0) |
      (y0 + s >= WORLD_Y ? 1 << DIR.PY : 0) |
      (y0 <= 0 ? 1 << DIR.NY : 0) |
      (z0 + s >= WORLD_Z ? 1 << DIR.PZ : 0) |
      (z0 <= 0 ? 1 << DIR.NZ : 0);
  }

  /** Euclidean distance from point (x, y, z) to the node's box (0 inside). */
  distanceTo(x: number, y: number, z: number): number {
    const dx = Math.max(this.x0 - x, 0, x - this.x0 - this.size);
    const dy = Math.max(this.y0 - y, 0, y - this.y0 - this.size);
    const dz = Math.max(this.z0 - z, 0, z - this.z0 - this.size);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  contains(x: number, y: number, z: number): boolean {
    return x >= this.x0 && y >= this.y0 && z >= this.z0 && x < this.x0 + this.size && y < this.y0 + this.size && z < this.z0 + this.size;
  }
}

/** Distance below which a node of `level` (≥ 1) wants its children. */
export const splitDistance = (level: number): number => RENDER.lodSplitDist[level - 1];

export class LodTree<T extends LodNode> {
  /** All nodes, roots first (level descending). */
  readonly nodes: T[] = [];
  readonly roots: T[] = [];
  /** Per level: nodes indexed ix + iz·nx + iy·nx·nz. */
  private readonly grids: T[][] = [];
  private readonly dims: [number, number, number][] = [];

  constructor(create: (level: number, x0: number, y0: number, z0: number) => T) {
    for (let level = 0; level <= ROOT_LEVEL; level++) {
      const size = NODE_CELLS << level;
      this.dims[level] = [WORLD_X / size, WORLD_Y / size, WORLD_Z / size];
      this.grids[level] = [];
    }
    for (let level = ROOT_LEVEL; level >= 0; level--) {
      const [nx, ny, nz] = this.dims[level];
      const size = NODE_CELLS << level;
      const grid = this.grids[level];
      for (let iy = 0; iy < ny; iy++) {
        for (let iz = 0; iz < nz; iz++) {
          for (let ix = 0; ix < nx; ix++) {
            const node = create(level, ix * size, iy * size, iz * size);
            node.id = this.nodes.length;
            this.nodes.push(node);
            grid[ix + iz * nx + iy * nx * nz] = node;
            if (level === ROOT_LEVEL) {
              this.roots.push(node);
            } else {
              const parent = this.nodeAt(level + 1, node.x0, node.y0, node.z0) as T;
              node.parent = parent;
              parent.children.push(node);
            }
          }
        }
      }
    }
  }

  /** Node of `level` containing voxel (x, y, z), or null outside the world. */
  nodeAt(level: number, x: number, y: number, z: number): T | null {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD_X || y >= WORLD_Y || z >= WORLD_Z) return null;
    const shift = NODE_BITS + level;
    const [nx, , nz] = this.dims[level];
    return this.grids[level][(x >> shift) + (z >> shift) * nx + (y >> shift) * nx * nz];
  }

  /**
   * The cut the split rule asks for at camera (x, y, z), without hysteresis: a node of level ≥ 1 is
   * replaced by its children while the camera is closer than splitDistance(level) to its box.
   */
  desiredCut(x: number, y: number, z: number, out: T[] = []): T[] {
    const visit = (n: T): void => {
      if (n.level > 0 && n.distanceTo(x, y, z) < splitDistance(n.level)) {
        for (const c of n.children) visit(c);
      } else {
        out.push(n);
      }
    };
    for (const r of this.roots) visit(r);
    return out;
  }

  /**
   * Calls fn for every node (all levels) whose padded bounds (1 cell = 2^level voxels of padding)
   * intersect chunk (cx, cy, cz); `inside` is true for the node that contains the chunk.
   */
  forEachNodeTouchingChunk(cx: number, cy: number, cz: number, fn: (node: T, inside: boolean) => void): void {
    const ax = cx << CHUNK_BITS;
    const ay = cy << CHUNK_BITS;
    const az = cz << CHUNK_BITS;
    for (let level = 0; level <= ROOT_LEVEL; level++) {
      const size = NODE_CELLS << level;
      const pad = 1 << level;
      const [nx, ny, nz] = this.dims[level];
      const grid = this.grids[level];
      const x0 = Math.max(0, Math.floor((ax - pad) / size));
      const x1 = Math.min(nx - 1, Math.floor((ax + CHUNK - 1 + pad) / size));
      const y0 = Math.max(0, Math.floor((ay - pad) / size));
      const y1 = Math.min(ny - 1, Math.floor((ay + CHUNK - 1 + pad) / size));
      const z0 = Math.max(0, Math.floor((az - pad) / size));
      const z1 = Math.min(nz - 1, Math.floor((az + CHUNK - 1 + pad) / size));
      const hx = Math.floor(ax / size);
      const hy = Math.floor(ay / size);
      const hz = Math.floor(az / size);
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          for (let ix = x0; ix <= x1; ix++) {
            fn(grid[ix + iz * nx + iy * nx * nz], ix === hx && iy === hy && iz === hz);
          }
        }
      }
    }
  }
}

/**
 * True when meshing the node cannot produce geometry: every chunk overlapping the node and its padding
 * is uniform and they are all air, or all opaque (with no open air above the world's top). Virtual
 * bedrock lies below the world; the world's side planes emit no faces.
 */
export function nodeIsEmpty(world: WorldData, n: LodNode): boolean {
  const pad = n.cell;
  const cx0 = Math.max(0, (n.x0 - pad) >> CHUNK_BITS);
  const cy0 = Math.max(0, (n.y0 - pad) >> CHUNK_BITS);
  const cz0 = Math.max(0, (n.z0 - pad) >> CHUNK_BITS);
  const cx1 = Math.min(CHUNKS_X - 1, (n.x0 + n.size + pad - 1) >> CHUNK_BITS);
  const cy1 = Math.min(CHUNKS_Y - 1, (n.y0 + n.size + pad - 1) >> CHUNK_BITS);
  const cz1 = Math.min(CHUNKS_Z - 1, (n.z0 + n.size + pad - 1) >> CHUNK_BITS);
  let allAir = true;
  let allOpaque = n.y0 + n.size < WORLD_Y;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const t = world.table[cx + cz * CHUNKS_X + cy * PLANE];
        if (t >= 0) return false;
        const id = -1 - t;
        if (RENDER_KIND[id] !== RK.NONE) allAir = false;
        if (OPAQUE[id] === 0) allOpaque = false;
        if (!allAir && !allOpaque) return false;
      }
    }
  }
  return true;
}

/**
 * Sum of `world.chunkVersion` over the chunks a mesh of the node is built from (those overlapping its
 * padded bounds). Versions only grow, so a mesh built from a world state with stamp ≥ S includes every
 * edit made to those chunks before the moment the stamp was S.
 */
export function coveredStamp(world: World, n: LodNode): number {
  const pad = n.cell;
  const cx0 = Math.max(0, (n.x0 - pad) >> CHUNK_BITS);
  const cy0 = Math.max(0, (n.y0 - pad) >> CHUNK_BITS);
  const cz0 = Math.max(0, (n.z0 - pad) >> CHUNK_BITS);
  const cx1 = Math.min(CHUNKS_X - 1, (n.x0 + n.size + pad - 1) >> CHUNK_BITS);
  const cy1 = Math.min(CHUNKS_Y - 1, (n.y0 + n.size + pad - 1) >> CHUNK_BITS);
  const cz1 = Math.min(CHUNKS_Z - 1, (n.z0 + n.size + pad - 1) >> CHUNK_BITS);
  const versions = world.chunkVersion;
  let sum = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * CHUNKS_X + cy * PLANE;
      for (let cx = cx0; cx <= cx1; cx++) sum += versions[cx + row];
    }
  }
  return sum;
}
