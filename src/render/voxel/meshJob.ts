/**
 * Mesh-worker protocol and job execution (pure TypeScript: used by mesh.worker.ts, by the main-thread
 * fallback executor and by tests). A job extracts the node's padded volume from shared world memory,
 * hashes it, and either answers "unchanged" (same inputs as the mesh the renderer already has) or runs
 * the mesher and transfers the vertex arrays back with a hash of them (so the renderer can keep its
 * mesh when changed inputs still give the same geometry).
 */
import type { WorldShared } from '../../world/world';
import { WorldData } from '../../world/world';
import { WordHash } from './hash';
import { NODE_CELLS, padIndex } from './layout';
import { Mesher, type MeshOutput } from './mesher';
import { VolumeBuilder } from './volume';

export interface MeshInitMessage {
  type: 'init';
  shared: WorldShared;
}

export interface MeshSegmentMessage {
  type: 'segment';
  sab: SharedArrayBuffer;
  index: number;
}

export interface MeshJob {
  type: 'job';
  /** Unique per dispatch; echoed in the answer. */
  id: number;
  level: number;
  /** Node origin in voxels. */
  ox: number;
  oy: number;
  oz: number;
  /** DIR bits of node faces on the world boundary. */
  boundary: number;
  /**
   * Input hash of the mesh the renderer holds for this node, or −1 to force meshing (the renderer
   * forces it to re-seed sealed pockets around the camera: the seed is not part of the hash).
   */
  prevHash: number;
  /** Camera position (voxels) at dispatch: a sealed air pocket containing it is meshed as open space. */
  camX: number;
  camY: number;
  camZ: number;
}

export type MeshWorkerRequest = MeshInitMessage | MeshSegmentMessage | MeshJob;

export interface MeshJobSuccess {
  type: 'result';
  id: number;
  ok: true;
  /** True when the inputs hash to `prevHash`: the renderer's current mesh is still exact. */
  unchanged: boolean;
  /** Input hash of this job (volume + column samples). */
  hash: number;
  /** Null when unchanged. */
  mesh: MeshOutput | null;
  /** hashMeshOutput(mesh), −1 when unchanged. */
  meshHash: number;
  /** Milliseconds spent extracting the volume and meshing. */
  volumeMs: number;
  meshMs: number;
}

export interface MeshJobFailure {
  type: 'result';
  id: number;
  ok: false;
  error: string;
}

export type MeshWorkerResponse = MeshJobSuccess | MeshJobFailure;

export interface MeshJobOutput {
  response: MeshJobSuccess;
  transfer: ArrayBuffer[];
}

const N = NODE_CELLS;

/** Hash of a mesh's vertex data: equal for identical geometry, EMPTY_MESH_HASH when there is none. */
export function hashMeshOutput(mesh: MeshOutput, h: WordHash = new WordHash()): number {
  h.reset(0x5e7);
  for (const arr of [mesh.opaque, mesh.glass, mesh.water, mesh.plantPos, mesh.plantData]) {
    // Every layer is a whole number of 4-byte words (32 bytes per quad; plant data 16).
    if (arr === null) h.word(0xffffffff);
    else h.word(arr.byteLength).words(new Uint32Array(arr.buffer, arr.byteOffset, arr.byteLength >> 2));
  }
  return h.digest();
}

/** hashMeshOutput() of a node without geometry. */
export const EMPTY_MESH_HASH = hashMeshOutput({
  opaque: null,
  opaqueQuads: 0,
  glass: null,
  glassQuads: 0,
  water: null,
  waterQuads: 0,
  plantPos: null,
  plantData: null,
  plantQuads: 0,
  cavities: null,
});

/** Executes mesh jobs against a read-only view of the shared world. One instance per worker. */
export class MeshJobRunner {
  private world: WorldData | null = null;
  private readonly builder = new VolumeBuilder();
  private readonly mesher = new Mesher();
  private readonly outputHash = new WordHash();

  init(shared: WorldShared): void {
    this.world = new WorldData(shared);
  }

  attachSegment(sab: SharedArrayBuffer, index: number): void {
    if (this.world === null) throw new Error('mesh worker: segment before init');
    this.world.attachSegment(sab, index);
  }

  run(job: MeshJob): MeshJobOutput {
    const world = this.world;
    if (world === null) throw new Error('mesh worker: job before init');
    const t0 = performance.now();
    const b = this.builder;
    b.build(world, job.level, job.ox, job.oy, job.oz);
    const hash = b.hash(job.level);
    const t1 = performance.now();
    if (job.prevHash === hash) {
      return {
        response: { type: 'result', id: job.id, ok: true, unchanged: true, hash, mesh: null, meshHash: -1, volumeMs: t1 - t0, meshMs: 0 },
        transfer: [],
      };
    }
    const cell = 1 << job.level;
    const cx = Math.floor((job.camX - job.ox) / cell);
    const cy = Math.floor((job.camY - job.oy) / cell);
    const cz = Math.floor((job.camZ - job.oz) / cell);
    const inside = cx >= 0 && cy >= 0 && cz >= 0 && cx < N && cy < N && cz < N;
    const mesh = this.mesher.mesh(b.volume, b.colSky, b.colCanopy, {
      level: job.level,
      ox: job.ox,
      oy: job.oy,
      oz: job.oz,
      boundary: job.boundary,
      seed: inside ? padIndex(cx, cy, cz) : -1,
    });
    const meshHash = hashMeshOutput(mesh, this.outputHash);
    const t2 = performance.now();
    const transfer: ArrayBuffer[] = [];
    for (const arr of [mesh.opaque, mesh.glass, mesh.water, mesh.plantPos, mesh.plantData, mesh.cavities]) {
      if (arr !== null) transfer.push(arr.buffer as ArrayBuffer);
    }
    return {
      response: { type: 'result', id: job.id, ok: true, unchanged: false, hash, mesh, meshHash, volumeMs: t1 - t0, meshMs: t2 - t1 },
      transfer,
    };
  }
}

/**
 * Handles one message of the worker protocol. Every job is answered exactly once — failures included,
 * so the renderer can re-queue the node.
 */
export function handleMeshMessage(
  runner: MeshJobRunner,
  msg: MeshWorkerRequest,
  reply: (response: MeshWorkerResponse, transfer: ArrayBuffer[]) => void,
): void {
  switch (msg.type) {
    case 'init':
      runner.init(msg.shared);
      return;
    case 'segment':
      runner.attachSegment(msg.sab, msg.index);
      return;
    case 'job': {
      let out: MeshJobOutput;
      try {
        out = runner.run(msg);
      } catch (e) {
        reply({ type: 'result', id: msg.id, ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }, []);
        return;
      }
      reply(out.response, out.transfer);
    }
  }
}
