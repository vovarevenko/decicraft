/**
 * Felling off the main thread (ARCHITECTURE.md §11.3): the main-thread client of the felling worker
 * (felling.worker.ts; protocol and jobs in fellingJob.ts), one per World (fellingFor). OWNER: agent "interaction".
 *
 * DETACH: after a removal next to STRUCT voxels, Aftermath hands its cells to detach(); the worker runs the support
 * analysis and prepares every falling piece (plan, mesh, touched chunks). At most one job is in flight: removals made
 * meanwhile are merged into one queued batch, posted only after the answer was applied — its world edits (crumbled
 * and vacated pieces) made — so two jobs never detach the same piece. update() (every frame) applies an answer only
 * if no chunk overlapping the job's read box changed its world.chunkVersion since the job was posted (snapshot taken
 * right before posting); a stale answer is dropped and its seeds are re-posted together with the queued batch.
 * After MAX_STALE_RETRIES stale answers in a row, or an answer with an error, the batch is analysed on the main thread
 * instead (fresh by construction, so it needs no asking again) and the worker only meshes its falling pieces: a mesh
 * job, which reads no world. The pieces stay in the world until the meshes arrive; if something the analysis read was
 * edited by then, it runs here once more and is applied at once, pieces that came out the same keeping their meshes.
 *
 * LAND: the landing scan of a FallingBody (scanLanding) and the chunks of its cells, or null once none can come (the
 * job failed, the worker was given up); the body writes the cells itself (writeLanding checks every cell against the
 * world at that time), or revoxelizes on the main thread.
 *
 * WRITE GUARD: a FallingBody that writes a big piece over several frames (vacating it, or writing its landing) holds
 * it from its first slice to its last (beginWrite / endWrite). Meanwhile no support analysis may read the world: it is
 * half vacated or half landed between those frames (a landing's skeleton joins come last), and an analysis of that
 * would detach fragments of a piece that is already falling — a second body for the same voxels — or of a landing not
 * joined yet. So detach() only queues its batch, and update() still applies a fresh answer to the job in flight (it
 * read nothing the writes touched: every slice bumps the versions of the chunks it writes) but leaves everything that
 * would read the world — asking again, analysing here, posting or running the queued batch — to the first update()
 * with no write in progress, the batch merged back into the queue. Land jobs are not affected (their cells are checked
 * again when written). Until its write is complete the voxels holding a writer's blocks where it puts them — the piece
 * it has not vacated yet, the landing cells it has written but not joined yet — are its own (owned()): for the player
 * they are not there, as when such a write took one frame. Dug, they would come back with the landing (in the world and
 * in the inventory); built against, a block would hang in the air once they are gone.
 *
 * Without a worker — none in this environment (node tests), a failed start, an error event, or a job left unanswered
 * for JOB_TIMEOUT_FRAMES updates — everything runs on the main thread for good: detach() returns the result to apply
 * at once and a batch caught in flight runs at the next update (while the write guard is held both wait for the first
 * update() without writers), and land() returns false (a landing scan caught in flight is answered with null at once).
 */
import type * as THREE from 'three';
import { CHUNK_BITS, CHUNK_COUNT, CHUNKS_X, CHUNKS_Y, CHUNKS_Z, GAMEPLAY } from '../../config';
import type { Vec3Like } from '../../core/math';
import { B } from '../../world/blocks';
import type { DetachedPiece } from '../../world/structure';
import { chunkKey, type World } from '../../world/world';
import { touchedChunks, type BlockGrid, type FallPlan, type PieceGrid, type PiecePose } from './fallingPiece';
import {
  detachPieces,
  type DetachOutput,
  type DetachReply,
  type DetachRequest,
  type FellingInit,
  type FellingReply,
  type FellingSegment,
  type LandingScan,
  type LandRequest,
  type MeshReply,
  type MeshRequest,
} from './fellingJob';
import { buildPieceGeometry, dataToGeometry } from './pieceMeshJob';
import { VoxelList } from './voxelList';

/** Stale answers in a row after which a batch is analysed on the main thread instead. */
const MAX_STALE_RETRIES = 3;
/** update() calls a job may go unanswered before the worker is given up as stalled. */
const JOB_TIMEOUT_FRAMES = 600;

/** A piece that falls: the arguments of new FallingBody(ctx, piece, plan, geometry, touched). */
export interface DetachedFall {
  piece: DetachedPiece;
  plan: FallPlan;
  /** Chunks the piece touches, worked out ahead (undefined: the body works them out). */
  touched?: Int32Array;
  geometry: THREE.BufferGeometry;
}

/** What a removal detached: small pieces crumble, the others fall. */
export interface DetachResult {
  crumbles: DetachedPiece[];
  falls: DetachedFall[];
}

/** A FallingBody writing the world in slices (beginWrite), as the write guard and owned() see it. */
export interface WorldWriter {
  /** The block it puts into world cell (x, y, z) — its piece at rest while vacating it, its landing at its pose — or 0. */
  blockAt(x: number, y: number, z: number): number;
}

/** Removed voxels waiting for their support analysis (packed xyz triples) and where pieces fall away from. */
interface Batch {
  seeds: number[];
  from: Vec3Like;
}

/** A batch's support analysis made on the main thread, its falls waiting for their meshes. */
interface Analysis {
  crumbles: DetachedPiece[];
  falls: { piece: DetachedPiece; plan: FallPlan; touched: Int32Array }[];
  /** Box of every voxel it read, as a detach job's. */
  readBox: Int32Array;
}

/** The job in flight for a batch: a detach job, or a mesh job for the falls of an analysis made here. */
interface Job extends Batch {
  id: number;
  /** Stale answers in a row before this one was posted. */
  stale: number;
  /** update() calls since it was posted. */
  frames: number;
  /** The analysis whose falls a mesh job meshes; null for a detach job. */
  analysis: Analysis | null;
  reply: DetachReply | MeshReply | null;
}

const clients = new WeakMap<World, FellingClient>();

/** The felling client of `world` (its worker starts with the first call that needs it). */
export function fellingFor(world: World): FellingClient {
  let client = clients.get(world);
  if (client === undefined) {
    client = new FellingClient(world);
    clients.set(world, client);
  }
  return client;
}

export class FellingClient {
  /** undefined: not started yet; null: none, everything runs on the main thread. */
  private worker: Worker | null | undefined;
  private nextId = 1;
  /** The job in flight. */
  private job: Job | null = null;
  /** Removals made while it is in flight, merged into one batch. */
  private queued: Batch | null = null;
  /** world.chunkVersion right before the job in flight was posted. */
  private readonly snapshot = new Uint32Array(CHUNK_COUNT);
  /** Callbacks of the land jobs in flight, by id. */
  private readonly landings = new Map<number, (scan: LandingScan | null) => void>();
  /** Holders of the write guard (beginWrite): while there is one, nothing reads the world for an analysis. */
  private readonly writers = new Set<WorldWriter>();

  constructor(private readonly world: World) {}

  /** Starts the worker if possible (Aftermath.update calls this every frame, so the worker is warm early). */
  start(): void {
    if (this.worker !== undefined) return;
    this.worker = null;
    if (typeof Worker === 'undefined') return;
    let worker: Worker;
    try {
      worker = new Worker(new URL('./felling.worker.ts', import.meta.url), { type: 'module' });
    } catch (err) {
      console.warn('[felling] no worker, felled trees are prepared on the main thread', err);
      return;
    }
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent) => this.onReply(ev.data as FellingReply);
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault();
      if (this.worker === worker) this.stop(`failed (${ev.message || 'unknown error'})`);
    };
    worker.postMessage({ type: 'init', shared: this.world.toShared() } satisfies FellingInit);
    // A new segment reaches the worker before any job posted after it (messages keep their order).
    this.world.onSegmentAdded((sab, index) => {
      if (this.worker === worker) worker.postMessage({ type: 'segment', sab, index } satisfies FellingSegment);
    });
  }

  /**
   * The removal of `seeds` (packed xyz triples, copied) may have detached pieces, which fall away from `from`.
   * Without a worker returns what to apply now; otherwise null: the job is posted (or queued behind the one in
   * flight) and its result is handed to update()'s `apply` in a later frame. Also null, with or without a worker,
   * while the write guard is held: the batch waits in the queue.
   */
  detach(seeds: ArrayLike<number>, from: Vec3Like): DetachResult | null {
    this.start();
    this.enqueue({ seeds: Array.from(seeds), from: { x: from.x, y: from.y, z: from.z } });
    if (this.writers.size > 0 || (this.worker !== null && this.job !== null)) return null;
    if (this.worker !== null) {
      this.post(this.takePending(null), 0);
      return null;
    }
    // A batch left over by a worker that just failed (update() normally takes it first) goes along.
    return this.runHere(this.takePending(this.job));
  }

  /**
   * `writer` writes the world in slices over several frames from now on: until endWrite(writer), no support analysis
   * reads it and its blocks in the world are its own (see WRITE GUARD in the header). Idempotent.
   */
  beginWrite(writer: WorldWriter): void {
    this.writers.add(writer);
  }

  /** `writer`'s write is complete (or given up); the first update() without writers takes on what waited. Idempotent. */
  endWrite(writer: WorldWriter): void {
    this.writers.delete(writer);
  }

  /**
   * Voxel (x, y, z) belongs to a write in progress: it holds the block a writer puts there (see WRITE GUARD in the
   * header). The player's crosshair passes it and no brush takes it (TargetPicker, collectBrush).
   */
  readonly owned = (x: number, y: number, z: number): boolean => {
    if (this.writers.size === 0) return false;
    const id = this.world.getBlock(x, y, z);
    if (id === B.AIR) return false;
    for (const writer of this.writers) if (writer.blockAt(x, y, z) === id) return true;
    return false;
  };

  /**
   * Once per frame: takes the answer to the job in flight if it arrived and passes the result to `apply` (which makes
   * its world edits) while it is fresh, else asks again or analyses the batch here; then posts the queued batch. Runs
   * the batches here once the worker is gone. While the write guard is held, only a fresh answer is applied: the rest
   * waits, the batch back in the queue, for the first update() without writers.
   */
  update(apply: (result: DetachResult) => void): void {
    this.start();
    const job = this.job;
    if (job === null) {
      this.postQueued(apply);
      return;
    }
    const reply = job.reply;
    if (reply === null) {
      if (this.worker !== null && ++job.frames <= JOB_TIMEOUT_FRAMES) return;
      if (this.worker !== null) this.stop(`left a job unanswered for ${JOB_TIMEOUT_FRAMES} frames`);
      // Its batch runs here, as soon as nothing is half written.
      this.queued = this.takePending(job);
      this.postQueued(apply);
      return;
    }
    this.job = null;
    // A fresh answer read nothing edited since it was posted, nor anything a write in progress has touched.
    const fresh = reply.type === 'mesh' ? this.isFresh(job.analysis!.readBox) : reply.ok && this.isFresh(reply.out.readBox);
    if (!fresh && this.writers.size > 0) {
      // Whatever comes next would read the world, half written now: the batch waits in the queue.
      this.queued = this.takePending(job);
      return;
    }
    let result: DetachResult | null;
    if (reply.type === 'mesh') {
      result = this.meshed(job, job.analysis!, reply, fresh);
    } else if (!reply.ok) {
      console.error('[felling] detach job failed, analysing its batch on the main thread:', reply.error);
      result = this.analyseHere(job);
    } else if (fresh) {
      result = received(reply.out);
    } else if (this.worker !== null && job.stale + 1 < MAX_STALE_RETRIES) {
      // Something the job read was edited meanwhile: ask again, with the removals made since.
      this.post(this.takePending(job), job.stale + 1);
      return;
    } else {
      // Stale once too often (or no worker left to ask): analysed here, where nothing is edited while it runs.
      result = this.analyseHere(this.takePending(job));
    }
    // A mesh job for its falls is in flight now: the queued batch waits for it.
    if (result === null) return;
    apply(result);
    // The answer's world edits are made: the queued batch may go now (unless they began a write).
    this.postQueued(apply);
  }

  /**
   * Scans the landing cells of `grid` at `pose` (scanLanding) in the worker and hands them with their chunks to
   * `done` (from onmessage, between frames) — or null as soon as no answer can come (the scan failed, or the worker
   * was given up). False when there is no worker: the caller revoxelizes on the main thread.
   */
  land(grid: PieceGrid, pose: PiecePose, done: (scan: LandingScan | null) => void): boolean {
    this.start();
    const worker = this.worker;
    if (!worker) return false;
    const id = this.nextId++;
    const ids = grid.ids.slice(); // the body keeps its own grid
    const m = pose.m.slice();
    const { rest, pivot } = pose;
    const request: LandRequest = {
      type: 'land',
      id,
      grid: { minX: grid.minX, minY: grid.minY, minZ: grid.minZ, sx: grid.sx, sy: grid.sy, sz: grid.sz, ids },
      m,
      rest: [rest.x, rest.y, rest.z],
      pivot: [pivot.x, pivot.y, pivot.z],
    };
    this.landings.set(id, done);
    worker.postMessage(request, [ids.buffer, m.buffer]);
    return true;
  }

  private post(batch: Batch, stale: number): void {
    const seeds = Int32Array.from(batch.seeds);
    const { x, y, z } = batch.from;
    const request: DetachRequest = {
      type: 'detach',
      id: this.nextId++,
      seeds,
      budget: GAMEPLAY.supportSearchBudget,
      maxVoxels: GAMEPLAY.maxFallingBodyVoxels,
      from: [x, y, z],
    };
    this.send(batch, request, [seeds.buffer], stale, null);
  }

  /** Posts the mesh job for the falls of `analysis`, just made here for `batch`. */
  private postMesh(batch: Batch, analysis: Analysis): void {
    const transfer: ArrayBuffer[] = [];
    const grids = analysis.falls.map(({ plan: { grid: g } }): BlockGrid => {
      const ids = g.ids.slice(); // a falling body keeps its grid until it has landed
      transfer.push(ids.buffer);
      return { minX: g.minX, minY: g.minY, minZ: g.minZ, sx: g.sx, sy: g.sy, sz: g.sz, ids };
    });
    this.send(batch, { type: 'mesh', id: this.nextId++, grids } satisfies MeshRequest, transfer, 0, analysis);
  }

  /** Makes `request` the job in flight for `batch` and posts it. */
  private send(batch: Batch, request: DetachRequest | MeshRequest, transfer: ArrayBuffer[], stale: number, analysis: Analysis | null): void {
    // After all of this frame's edits so far; every later edit bumps a version that isFresh() compares.
    this.snapshot.set(this.world.chunkVersion);
    this.job = { seeds: batch.seeds, from: batch.from, id: request.id, stale, frames: 0, analysis, reply: null };
    (this.worker as Worker).postMessage(request, transfer);
  }

  /** No chunk overlapping `box` (x0, y0, z0 inclusive, x1, y1, z1 exclusive) changed since the job was posted. */
  private isFresh(box: Int32Array): boolean {
    if (box[3] <= box[0] || box[4] <= box[1] || box[5] <= box[2]) return true;
    const cx0 = Math.max(0, box[0] >> CHUNK_BITS);
    const cy0 = Math.max(0, box[1] >> CHUNK_BITS);
    const cz0 = Math.max(0, box[2] >> CHUNK_BITS);
    const cx1 = Math.min(CHUNKS_X - 1, (box[3] - 1) >> CHUNK_BITS);
    const cy1 = Math.min(CHUNKS_Y - 1, (box[4] - 1) >> CHUNK_BITS);
    const cz1 = Math.min(CHUNKS_Z - 1, (box[5] - 1) >> CHUNK_BITS);
    const version = this.world.chunkVersion;
    const snapshot = this.snapshot;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = chunkKey(cx, cy, cz);
          if (version[key] !== snapshot[key]) return false;
        }
      }
    }
    return true;
  }

  /**
   * The support analysis of `batch` here and now, so it is fresh. Its falls are meshed in the worker: a mesh job is
   * posted and null returned (update() applies the result once the meshes are in). Without falls, or without a
   * worker (then meshed here), returns the result to apply now.
   */
  private analyseHere(batch: Batch): DetachResult | null {
    if (this.worker === null) return this.runHere(batch);
    const readBox = new Int32Array(6);
    const { crumbles, falls } = detachPieces(this.world, batch.seeds, GAMEPLAY.supportSearchBudget, GAMEPLAY.maxFallingBodyVoxels, batch.from, readBox);
    if (falls.length === 0) return { crumbles, falls: [] };
    // Worked out in this frame already, not in the one that vacates the pieces.
    const prepared = falls.map(({ piece, plan }) => ({ piece, plan, touched: Int32Array.from(touchedChunks(piece)) }));
    this.postMesh(batch, { crumbles, falls: prepared, readBox });
    return null;
  }

  /**
   * The answer to the mesh job for `analysis` (`job`'s batch): the analysis with the worker's meshes (made here if the
   * job failed) while nothing it read has been edited (`fresh`). Otherwise the batch is analysed once more and applied
   * at once, no more waiting; a fall that came out the same keeps its mesh.
   */
  private meshed(job: Job, analysis: Analysis, reply: MeshReply, fresh: boolean): DetachResult {
    if (!reply.ok) console.error('[felling] mesh job failed, meshing on the main thread:', reply.error);
    const meshes = reply.ok ? reply.meshes : null;
    const meshOf = (grid: PieceGrid, i: number): THREE.BufferGeometry => (meshes !== null && i >= 0 ? dataToGeometry(meshes[i]) : meshHere(grid));
    if (fresh) {
      return { crumbles: analysis.crumbles, falls: analysis.falls.map((fall, i) => ({ ...fall, geometry: meshOf(fall.plan.grid, i) })) };
    }
    const { crumbles, falls } = detachPieces(this.world, job.seeds, GAMEPLAY.supportSearchBudget, GAMEPLAY.maxFallingBodyVoxels, job.from);
    return {
      crumbles,
      falls: falls.map(({ piece, plan }) => {
        const i = analysis.falls.findIndex((fall) => sameBlocks(fall.plan.grid, plan.grid));
        return { piece, plan, geometry: meshOf(plan.grid, i) };
      }),
    };
  }

  /** The detach job on the main thread, meshes included (no worker to make them). */
  private runHere(batch: Batch): DetachResult {
    const { crumbles, falls } = detachPieces(this.world, batch.seeds, GAMEPLAY.supportSearchBudget, GAMEPLAY.maxFallingBodyVoxels, batch.from);
    return { crumbles, falls: falls.map(({ piece, plan }) => ({ piece, plan, geometry: meshHere(plan.grid) })) };
  }

  /** Posts the queued batch, or runs it here without a worker — unless the write guard is held. */
  private postQueued(apply: (result: DetachResult) => void): void {
    if (this.queued === null || this.writers.size > 0) return;
    const batch = this.takePending(null);
    if (this.worker !== null) this.post(batch, 0);
    else apply(this.runHere(batch));
  }

  /** Adds a later removal to the queued batch (its `from` wins). */
  private enqueue(batch: Batch): void {
    const q = this.queued;
    this.queued = q === null ? batch : { seeds: q.seeds.concat(batch.seeds), from: batch.from };
  }

  /** `job`'s batch (if any) merged with the queued one, which comes later (its `from` wins); neither is pending any more. */
  private takePending(job: Batch | null): Batch {
    const q = this.queued;
    this.job = null;
    this.queued = null;
    if (job === null) return q as Batch;
    return q === null ? job : { seeds: job.seeds.concat(q.seeds), from: q.from };
  }

  private onReply(reply: FellingReply): void {
    if (reply.type !== 'land') {
      // An answer to a job given up meanwhile has another id.
      if (this.job !== null && this.job.id === reply.id) this.job.reply = reply;
      return;
    }
    const done = this.landings.get(reply.id);
    this.landings.delete(reply.id);
    if (reply.ok) {
      done?.({ cells: VoxelList.wrap(reply.positions, reply.ids, reply.count), touched: reply.touched });
    } else {
      console.error('[felling] landing scan failed:', reply.error);
      done?.(null);
    }
  }

  /** Gives the worker up: from now on everything runs on the main thread. */
  private stop(reason: string): void {
    console.warn(`[felling] worker ${reason}, felled trees are prepared on the main thread from now on`);
    this.worker?.terminate();
    this.worker = null;
    // No answer comes for the landing scans in flight: their bodies revoxelize at their next update.
    for (const done of this.landings.values()) done(null);
    this.landings.clear();
  }
}

/** A worker's detach output, its meshes turned into geometries. */
function received(out: DetachOutput): DetachResult {
  return {
    crumbles: out.crumbles,
    falls: out.falls.map(({ piece, plan, touched, mesh }) => ({ piece, plan, touched, geometry: dataToGeometry(mesh) })),
  };
}

/** A piece grid's mesh, made on the main thread. */
function meshHere(g: BlockGrid): THREE.BufferGeometry {
  return buildPieceGeometry(g.sx, g.sy, g.sz, g.ids);
}

/** Same box, same blocks: the same mesh. */
function sameBlocks(a: BlockGrid, b: BlockGrid): boolean {
  if (a.minX !== b.minX || a.minY !== b.minY || a.minZ !== b.minZ || a.sx !== b.sx || a.sy !== b.sy || a.sz !== b.sz) return false;
  const x = a.ids;
  const y = b.ids;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
