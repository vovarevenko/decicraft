/**
 * Felling-worker protocol and jobs (see felling.ts; pure TypeScript, no DOM: used by felling.worker.ts, by the
 * client's main-thread fallback and by tests). OWNER: agent "interaction".
 * detach: the support analysis of removed voxels (findDetached); pieces < MIN_FALLING_VOXELS come back as crumbles,
 * every other one as a prepared fall — its FallPlan, its mesh as arrays and the chunks it touches, its voxels in chunk
 * order — together with the box of every voxel the job read (the client checks the answer against edits made
 * meanwhile).
 * mesh: the meshes of pieces whose support analysis the client ran itself (its fallback; the job reads no world).
 * land: the landing cells of a landed piece (scanLanding) in chunk order and the chunks they touch; the main thread
 * writes them.
 * Chunk order (sortByChunk) lets the main thread write a big list chunk by chunk, in slices over several frames.
 * Every job is answered exactly once, failures included (ok: false), with all result buffers transferred.
 */
import type { Vec3Like } from '../../core/math';
import { findDetached, type DetachedPiece } from '../../world/structure';
import { WorldData, type WorldShared } from '../../world/world';
import { MIN_FALLING_VOXELS, PiecePose, planFall, planReadBox, scanLanding, touchedChunks, type BlockGrid, type FallPlan } from './fallingPiece';
import { buildPieceGeometry, geometryToData, meshTransferables, type PieceMeshData } from './pieceMeshJob';
import { sortByChunk, VoxelList } from './voxelList';

export interface FellingInit {
  type: 'init';
  shared: WorldShared;
}

export interface FellingSegment {
  type: 'segment';
  sab: SharedArrayBuffer;
  index: number;
}

export interface DetachRequest {
  type: 'detach';
  id: number;
  /** Removed voxels, packed xyz triples (transferred). */
  seeds: Int32Array;
  budget: number;
  maxVoxels: number;
  /** Where the pieces fall away from (the player). */
  from: [number, number, number];
}

export interface LandRequest {
  type: 'land';
  id: number;
  /** The landed piece's block grid (ids transferred: a copy of the body's). */
  grid: BlockGrid;
  /** PiecePose parts: rotation (row-major 3×3), pivot at rest, pivot now. */
  m: Float64Array;
  rest: [number, number, number];
  pivot: [number, number, number];
}

export interface MeshRequest {
  type: 'mesh';
  id: number;
  /** Block grids of the pieces (ids transferred: copies of the client's). */
  grids: BlockGrid[];
}

export type FellingRequest = FellingInit | FellingSegment | DetachRequest | LandRequest | MeshRequest;

/** A piece that falls, prepared for a FallingBody. */
export interface PreparedFall {
  /** In chunk order (planFall saw findDetached's: its probes depend on the order). */
  piece: DetachedPiece;
  plan: FallPlan;
  /** touchedChunks(piece). */
  touched: Int32Array;
  mesh: PieceMeshData;
}

export interface DetachOutput {
  /** Pieces below MIN_FALLING_VOXELS: they crumble into item drops. */
  crumbles: DetachedPiece[];
  falls: PreparedFall[];
  /** Box of every voxel the job read: x0, y0, z0 inclusive, x1, y1, z1 exclusive. */
  readBox: Int32Array;
}

/** A land job's result: the landing cells in chunk order, and touchedChunks of them all (writeLanding may still drop some). */
export interface LandingScan {
  cells: VoxelList;
  touched: Int32Array;
}

/** A job that threw: answered with the error instead. */
export interface FellingFailure {
  type: 'detach' | 'land' | 'mesh';
  id: number;
  ok: false;
  error: string;
}

export type DetachReply = { type: 'detach'; id: number; ok: true; out: DetachOutput } | FellingFailure;
/** A LandingScan, its cells as `count` voxels in the arrays of a VoxelList (all transferred). */
export type LandReply =
  | { type: 'land'; id: number; ok: true; positions: Int32Array; ids: Uint8Array; count: number; touched: Int32Array }
  | FellingFailure;
/** The meshes in the order of the request's grids. */
export type MeshReply = { type: 'mesh'; id: number; ok: true; meshes: PieceMeshData[] } | FellingFailure;
export type FellingReply = DetachReply | LandReply | MeshReply;

/** A felling worker's state: its read-only view of the shared world, once 'init' arrived. */
export interface FellingState {
  world: WorldData | null;
}

/**
 * The analysis part of a detach job, shared with the main-thread fallback (which meshes on its own): the pieces the
 * removal of `seeds` detached, split into crumbles and falls with their plans. With `readBox`, findDetached's box
 * grown by what planFall read.
 */
export function detachPieces(
  world: WorldData,
  seeds: ArrayLike<number>,
  budget: number,
  maxVoxels: number,
  from: Vec3Like,
  readBox?: Int32Array,
): { crumbles: DetachedPiece[]; falls: { piece: DetachedPiece; plan: FallPlan }[] } {
  const crumbles: DetachedPiece[] = [];
  const falls: { piece: DetachedPiece; plan: FallPlan }[] = [];
  for (const piece of findDetached(world, seeds, budget, maxVoxels, readBox)) {
    if (piece.count < MIN_FALLING_VOXELS) {
      crumbles.push(piece);
      continue;
    }
    falls.push({ piece, plan: planFall(world, piece, from) });
    if (readBox !== undefined) planReadBox(piece, readBox);
  }
  return { crumbles, falls };
}

/** The whole detach job: detachPieces plus each fall's mesh and touched chunks, its voxels put in chunk order, and the read box. */
export function runDetach(world: WorldData, seeds: ArrayLike<number>, budget: number, maxVoxels: number, from: Vec3Like): DetachOutput {
  const readBox = new Int32Array(6);
  const { crumbles, falls } = detachPieces(world, seeds, budget, maxVoxels, from, readBox);
  return {
    crumbles,
    falls: falls.map(({ piece, plan }) => {
      const sorted = { ...piece, ...sortByChunk(piece.positions, piece.ids, piece.count) };
      return { piece: sorted, plan, touched: Int32Array.from(touchedChunks(sorted)), mesh: meshData(plan.grid) };
    }),
    readBox,
  };
}

/** A piece grid's mesh as arrays (the mesh job, and part of the detach job). */
function meshData(g: BlockGrid): PieceMeshData {
  return geometryToData(buildPieceGeometry(g.sx, g.sy, g.sz, g.ids));
}

/** Every typed-array buffer of a detach job's output (each its own buffer), for transferring it. */
export function detachTransferables(out: DetachOutput): ArrayBuffer[] {
  const buffers: ArrayBufferLike[] = [out.readBox.buffer];
  for (const piece of out.crumbles) buffers.push(piece.positions.buffer, piece.ids.buffer);
  for (const { piece, plan, touched, mesh } of out.falls) {
    buffers.push(piece.positions.buffer, piece.ids.buffer, plan.grid.ids.buffer, plan.grid.struct.buffer, plan.probes.buffer, touched.buffer);
    buffers.push(...meshTransferables(mesh));
  }
  return buffers as ArrayBuffer[];
}

/** The land job: scanLanding of the posed grid in the worker's world, its cells put in chunk order, and their chunks. */
export function runLand(world: WorldData, job: LandRequest): LandingScan {
  const pose = new PiecePose();
  pose.m.set(job.m);
  [pose.rest.x, pose.rest.y, pose.rest.z] = job.rest;
  [pose.pivot.x, pose.pivot.y, pose.pivot.z] = job.pivot;
  const scanned = new VoxelList(Math.min(job.grid.ids.length, 1 << 16));
  scanLanding(world, job.grid, pose, scanned);
  // The list keeps its spare room: the skeleton's joins are appended to it on the main thread.
  const { positions, ids } = sortByChunk(scanned.positions, scanned.ids, scanned.count, scanned.ids.length);
  const cells = VoxelList.wrap(positions, ids, scanned.count);
  return { cells, touched: Int32Array.from(touchedChunks(cells)) };
}

/** Handles one message of the protocol (felling.worker.ts, and tests' fake workers); `post` sends a reply. */
export function handleFellingMessage(
  state: FellingState,
  msg: FellingRequest,
  post: (reply: FellingReply, transfer: ArrayBuffer[]) => void,
): void {
  switch (msg.type) {
    case 'init':
      state.world = new WorldData(msg.shared);
      return;
    case 'segment':
      if (state.world === null) throw new Error('felling worker: segment before init');
      state.world.attachSegment(msg.sab, msg.index);
      return;
    case 'detach':
    case 'land':
    case 'mesh':
      try {
        const world = state.world;
        if (world === null) throw new Error('felling worker: job before init');
        if (msg.type === 'detach') {
          const [x, y, z] = msg.from;
          const out = runDetach(world, msg.seeds, msg.budget, msg.maxVoxels, { x, y, z });
          post({ type: 'detach', id: msg.id, ok: true, out }, detachTransferables(out));
        } else if (msg.type === 'land') {
          const { cells, touched } = runLand(world, msg);
          const { positions, ids, count } = cells;
          post({ type: 'land', id: msg.id, ok: true, positions, ids, count, touched }, [positions.buffer, ids.buffer, touched.buffer] as ArrayBuffer[]);
        } else {
          const meshes = msg.grids.map(meshData);
          post({ type: 'mesh', id: msg.id, ok: true, meshes }, meshes.flatMap(meshTransferables));
        }
      } catch (e) {
        post({ type: msg.type, id: msg.id, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }, []);
      }
  }
}
