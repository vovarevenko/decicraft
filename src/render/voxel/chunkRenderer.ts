/**
 * Voxel world rendering with an octree LOD. OWNER: agent "render-core". Spec: ARCHITECTURE.md §6.1.
 *
 * NODES: a level-L node covers (RENDER.meshNode·2^L)³ voxels meshed as 64³ cells of 2^L voxels
 * (level 0 = full resolution). Roots are level-2 nodes (5×2×5). A level-L node (L ≥ 1) is split when
 * the camera is within RENDER.lodSplitDist[L-1] of its AABB and merged back only beyond that distance
 * + RENDER.lodMergeMargin. READY-GATING per level: a node is replaced by its children only once all 8
 * children have a mesh of their own (or are known empty); each child then decides independently.
 * Coarsening requires a parent mesh of the current epoch (otherwise keep the children). Never holes.
 *
 * MESHING runs in workerCount('mesh') module workers that read the shared world memory
 * (world.toShared(); new segments forwarded from world.onSegmentAdded before newer jobs). Each job is
 * wrapped in try/catch and always answers (an error answer re-queues the job; worker.onerror re-queues
 * that worker's job too). Uniform chunks are handled in O(1) (chunkUniform()). Empty nodes (all chunks
 * of node + padding uniform and all AIR, or all OPAQUE) get no job.
 *
 * STALENESS: each node has an epoch, incremented when world.onChange reports a chunk inside the node
 * or inside its padded bounds (padding is 1 cell = 2^L voxels deep). A job carries the epoch it was
 * dispatched with; a result older than the current epoch is still shown if it is newer than what is on
 * screen, and the node is re-queued (no livelock). Level-0 nodes dirtied by edits re-mesh at top
 * priority; dirtied ancestors (L ≥ 1) re-mesh lazily (debounced ~1.5 s, lowest priority, at most one in
 * flight, so at least one worker always serves level 0).
 *
 * MEMORY: compact vertex formats (e.g. opaque/glass: `position` Uint8×4 in cell units with
 * mesh.scale = 2^L and mesh.position = node origin, + one packed Uint8×4 attribute: normal index, AO,
 * sky, block id; 4-byte aligned strides; one shared quad index buffer + drawRange, detached with
 * setIndex(null) before dispose). Bounding volumes from node bounds; CPU arrays freed after upload
 * (attribute.onUpload). LRU cache of non-displayed meshes within RENDER.meshCacheBytes. Newly shown
 * geometry per frame ≤ RENDER.uploadBytesPerFrame (edit re-meshes exempt).
 *
 * SHADOWS: only opaque level-0 meshes cast shadows; all opaque meshes and the plants receive them; glass
 * and water do neither.
 *
 * Implementation notes: displayed nodes are the "cut" (an exact cover of the world). A job also skips
 * meshing when its input hash equals that of the node's current mesh (common for padding-only and
 * skylight-only dirt), and a new mesh whose geometry hash equals the held one's is dropped (no upload,
 * no swap). Faces towards sealed air pockets are culled by the mesher; if the camera enters
 * a reported pocket, the node is re-meshed with the camera as an open seed. A mesh is drawn with
 * frustum culling off in the frame it first appears, so its GPU upload happens in the budgeted frame.
 */
import * as THREE from 'three';
import { PLAYER, RENDER, workerCount } from '../../config';
import type { Vec3Like } from '../../core/math';
import { chunkCoords, type World } from '../../world/world';
import { LodNode, LodTree, ROOT_LEVEL, coveredStamp, nodeIsEmpty, splitDistance } from './lod';
import { getVoxelMaterials, type VoxelMaterials } from './materials';
import {
  EMPTY_MESH_HASH,
  MeshJobRunner,
  handleMeshMessage,
  type MeshJob,
  type MeshWorkerRequest,
  type MeshWorkerResponse,
} from './meshJob';
import { buildNodeMesh, buildWarmupGroup, disposeNodeMesh } from './nodeMesh';

export interface ChunkRenderStats {
  /** Meshes currently in the scene. */
  visibleNodes: number;
  /** Triangles of visible voxel meshes. */
  triangles: number;
  /** Mesh jobs queued + running. */
  pendingJobs: number;
  /** Total cached node meshes (GPU). */
  cachedNodes: number;
}

/** One node of the displayed cut (see ChunkRenderer.debugCut). */
export interface CutNodeInfo {
  level: number;
  /** Voxel origin and edge. */
  x: number;
  y: number;
  z: number;
  size: number;
  shows: 'mesh' | 'empty' | 'none';
  /** The shown mesh includes every reported edit. */
  current: boolean;
}

/** What the renderer needs from a mesh worker: a module Worker, the main-thread fallback, or a test double. */
export interface MeshWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export interface ChunkRendererOptions {
  /** Creates one mesh worker (default: a module worker running mesh.worker.ts). */
  createWorker?: () => MeshWorkerLike;
  /** Pool size (default workerCount('mesh')). */
  workers?: number;
  /** Clock in milliseconds (default performance.now). */
  now?: () => number;
}

/** A hold on the meshes of a world write spread over several frames (ChunkRenderer.holdMeshes). */
export interface MeshHold {
  /** Holds back the meshes of every node touching `chunkKeys` too (the chunks a later slice of the write marked dirty). */
  add(chunkKeys: Iterable<number>): void;
  /** The write is complete: whenMeshed(every chunk held, cb) for the edits made until now. Releasing again does nothing. */
  release(cb: () => void): void;
}

/** Job classes in priority order. */
const JOB_EDIT = 0; // displayed nodes whose mesh is stale or missing
const JOB_LOD = 1; // children of a wanted split, parents of a wanted merge
const JOB_PREFETCH = 2; // children of nodes the camera is approaching
const JOB_LAZY = 3; // hidden ancestors dirtied by edits

const LAZY_DELAY_MS = 1500;
const WHEN_MESHED_TIMEOUT_MS = 2000;
/** A worker that has not answered for this long (counting only time while frames run) is replaced and its job re-queued. */
const JOB_TIMEOUT_MS = 15000;
/** A longer gap between two update() calls (hidden tab, frozen page, debugger) is not counted as worker time. */
const FRAME_GAP_MS = 1000;
/** After this many worker replacements, meshing falls back to the main thread. */
const MAX_WORKER_FAILURES = 3;
/** prewarm() stops waiting for a node that failed this many times. */
const PREWARM_MAX_FAILURES = 3;
/** Children are meshed ahead while the camera is within splitDistance(L) + PREFETCH_MARGIN[L − 1]. */
const PREFETCH_MARGIN = [32, 64];
/** Re-seeding a node for a camera inside a sealed pocket is retried at most this often. */
const RESEED_INTERVAL_MS = 500;

const SPLIT = 0;
const MERGE = 1;

/** One mesh result held by the renderer (displayed and/or cached). */
interface NodeRecord {
  /** Node epoch the job was dispatched with. */
  epoch: number;
  /** coveredStamp() at dispatch (whenMeshed). */
  stamp: number;
  /** Input hash from the worker, −1 for main-thread empty records. */
  hash: number;
  /** Hash of the geometry (hashMeshOutput; EMPTY_MESH_HASH without any). */
  meshHash: number;
  /** Null when the node has no geometry. */
  group: THREE.Group | null;
  bytes: number;
  triangles: number;
  /** Shown at least once (its GPU upload has been requested). */
  uploaded: boolean;
  /** Tick of the last use (LRU). */
  lastUsed: number;
  /** Culled sealed pockets of the mesh (MeshOutput.cavities). */
  cavities: Int16Array | null;
  /** Camera voxel key the mesh was built with (a sealed pocket containing it is open), −1 if none. */
  seedKey: number;
}

class RenderNode extends LodNode {
  epoch = 0;
  /** Part of the displayed cut. */
  inCut = false;
  /** Replaced by its children (an ancestor of the cut). */
  split = false;
  /** Newest accepted result. */
  result: NodeRecord | null = null;
  /** Record whose group is in the scene (cut nodes only). */
  shown: NodeRecord | null = null;
  /** Epoch of the job in flight, −1 if none. */
  jobEpoch = -1;
  jobStamp = 0;
  /** Edits inside the node's own bounds since the last dispatch. */
  contentDirty = false;
  /** The next job must mesh fully (an "unchanged" answer did not match the held mesh). */
  noShortcut = false;
  /** Epoch at which the main-thread emptiness test last ran. */
  emptyEpoch = -1;
  lazyDue = 0;
  failures = 0;
  retryAt = 0;
  /** The camera sits in a sealed pocket of the displayed mesh: re-mesh with it as a seed. */
  cameraReseed = false;
  reseedAt = 0;
  /** Camera voxel key of the job in flight (its cavity seed). */
  jobSeedKey = -1;
  wantTick = -1;
  wantClass = 0;
  wantPrio = 0;
  mergeTick = -1;
  requestMark = 0;
  /** Tick in which a pending whenMeshed request holds back this node's new mesh. */
  holdTick = -1;
  /** Unreleased holds covering the node (holdMeshes): no mesh of it could show before they end, so it gets no job meanwhile. */
  holds = 0;
  transKind = SPLIT;
  transDist = 0;
}

interface WorkerSlot {
  worker: MeshWorkerLike;
  /** Node of the job in flight. */
  node: RenderNode | null;
  jobId: number;
  jobClass: number;
  jobStart: number;
}

interface MeshRequest {
  nodes: RenderNode[];
  /** Required coveredStamp per node (+Infinity while it is an unreleased hold: never met). */
  stamps: number[];
  cb: () => void;
  /** Clock time it gives up at — game time while it is an unreleased hold (see update()). */
  deadline: number;
  /** An unreleased hold (holdMeshes): its nodes count it in RenderNode.holds. */
  hold: boolean;
  /** Tick in which it holds its nodes back (applySwaps). */
  holdTick: number;
}

interface PrewarmState {
  desired: RenderNode[];
  pending: RenderNode[];
  done: number;
  t0: number;
  onProgress: ((done: number, total: number) => void) | undefined;
  resolve: () => void;
  promise: Promise<void>;
}

function createModuleWorker(): MeshWorkerLike {
  return new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
}

/** Runs mesh jobs on the main thread between frames (fallback when module workers are unavailable). */
class InlineMeshWorker implements MeshWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  private readonly runner = new MeshJobRunner();
  private closed = false;

  postMessage(message: unknown): void {
    const msg = message as MeshWorkerRequest;
    const reply = (response: MeshWorkerResponse): void => {
      if (!this.closed) this.onmessage?.(new MessageEvent('message', { data: response }));
    };
    if (msg.type === 'job') setTimeout(() => !this.closed && handleMeshMessage(this.runner, msg, reply), 0);
    else handleMeshMessage(this.runner, msg, reply);
  }

  terminate(): void {
    this.closed = true;
  }
}

const byTransitionDistance = (a: RenderNode, b: RenderNode): number => a.transDist - b.transDist;
const byWant = (a: RenderNode, b: RenderNode): number => a.wantClass - b.wantClass || a.wantPrio - b.wantPrio;
const byLastUse = (a: RenderNode, b: RenderNode): number => (a.result as NodeRecord).lastUsed - (b.result as NodeRecord).lastUsed;

export class ChunkRenderer {
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private readonly materials: VoxelMaterials;
  private readonly tree: LodTree<RenderNode>;
  private readonly root = new THREE.Group();
  private readonly warmup: THREE.Group;
  private readonly createWorker: () => MeshWorkerLike;
  private readonly clock: () => number;
  private readonly slots: WorkerSlot[] = [];
  private workerFailures = 0;

  /** Displayed cut, an exact cover of the world. */
  private readonly cut: RenderNode[] = [];
  private cutDirty = false;
  private readonly transitions: RenderNode[] = [];
  /** Nodes wanting a job this frame, sorted by (class, priority); dispatch resumes at wantedPos. */
  private readonly wanted: RenderNode[] = [];
  private wantedPos = 0;
  private readonly swaps = new Set<RenderNode>();
  private readonly lazy = new Set<RenderNode>();
  private readonly evictable: RenderNode[] = [];
  private requests: MeshRequest[] = [];
  private readonly forced: THREE.Object3D[] = [];
  private prewarmState: PrewarmState | null = null;

  private readonly cam = new THREE.Vector3();
  private readonly camDir = new THREE.Vector3(0, 0, -1);
  private readonly coords: [number, number, number] = [0, 0, 0];
  private tick = 0;
  private nowMs = 0;
  /** Game time (ms): the sum of update()'s dt, which stands still while the game is paused. */
  private gameMs = 0;
  /** Clock at the previous update() (-1 before the first): long gaps shift job start times, see FRAME_GAP_MS. */
  private lastUpdateMs = -1;
  private jobSeq = 0;
  private requestSeq = 0;
  private inFlight = 0;
  private lazyInFlight = 0;
  private cacheBytes = 0;
  private cachedMeshes = 0;
  private visibleMeshes = 0;
  private visibleTriangles = 0;
  private loggedErrors = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, world: World, options: ChunkRendererOptions = {}) {
    this.scene = scene;
    this.world = world;
    this.clock = options.now ?? (() => performance.now());
    this.createWorker = options.createWorker ?? createModuleWorker;
    this.materials = getVoxelMaterials();
    this.tree = new LodTree((level, x, y, z) => new RenderNode(level, x, y, z));
    this.root.name = 'voxel-world';
    this.root.matrixAutoUpdate = false;
    this.warmup = buildWarmupGroup(this.materials);
    this.root.add(this.warmup);
    scene.add(this.root);
    for (const r of this.tree.roots) {
      r.inCut = true;
      this.cut.push(r);
    }
    const count = Math.max(1, options.workers ?? workerCount('mesh'));
    for (let i = 0; i < count; i++) {
      const slot: WorkerSlot = { worker: this.spawnWorker(), node: null, jobId: 0, jobClass: 0, jobStart: 0 };
      this.attachWorker(slot);
      this.slots.push(slot);
    }
    world.onSegmentAdded((sab, index) => {
      if (this.disposed) return;
      const msg: MeshWorkerRequest = { type: 'segment', sab, index };
      for (const s of this.slots) s.worker.postMessage(msg, []);
    });
    world.onChange((keys) => this.markDirty(keys));
  }

  /**
   * Meshes everything needed for a hole-free view from `center` (+ eye height) at every LOD level per
   * the split rule before gameplay starts. Resolves when the desired cut is complete; reports progress
   * in jobs. Logs the resulting triangle count.
   */
  prewarm(center: Vec3Like, onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.prewarmState !== null) return this.prewarmState.promise;
    this.nowMs = this.clock();
    this.cam.set(center.x, center.y + PLAYER.eyeHeight, center.z);
    const desired = this.tree.desiredCut(this.cam.x, this.cam.y, this.cam.z);
    const pending: RenderNode[] = [];
    for (const n of desired) {
      if (!this.isCurrent(n) && !this.markIfEmpty(n)) pending.push(n);
    }
    pending.sort((a, b) => a.distanceTo(this.cam.x, this.cam.y, this.cam.z) - b.distanceTo(this.cam.x, this.cam.y, this.cam.z));
    let resolve: () => void = () => {};
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.prewarmState = { desired, pending, done: 0, t0: this.nowMs, onProgress, resolve, promise };
    onProgress?.(0, pending.length);
    this.pumpPrewarm();
    return promise;
  }

  /**
   * Per-frame: LOD selection around the camera, job dispatch, applying finished meshes (budgeted), whenMeshed callbacks.
   * `dt`: game seconds since the previous frame, 0 while the game is paused — a hold times out in game time, as its
   * holder writes only while the game runs (holdMeshes).
   */
  update(camera: THREE.PerspectiveCamera, dt: number): void {
    if (this.disposed) return;
    this.tick++;
    this.nowMs = this.clock();
    this.gameMs += dt * 1000;
    const gap = this.lastUpdateMs < 0 ? 0 : this.nowMs - this.lastUpdateMs;
    if (gap > FRAME_GAP_MS) for (const slot of this.slots) slot.jobStart += gap;
    this.lastUpdateMs = this.nowMs;
    for (const o of this.forced) o.frustumCulled = true;
    this.forced.length = 0;
    this.cam.copy(camera.position);
    camera.getWorldDirection(this.camDir);
    this.replaceStalledWorkers();
    if (this.prewarmState === null) {
      this.applySwaps();
      this.checkCameraPocket();
      this.wanted.length = 0;
      this.updateLod();
      this.schedule();
      this.evict();
    }
    this.flushRequests();
  }

  /** Marks nodes covering these chunks (cells or padding, every level) dirty. Wired to world.onChange in the constructor. */
  markDirty(chunkKeys: Iterable<number>): void {
    if (this.disposed) return;
    this.nowMs = this.clock();
    for (const key of chunkKeys) {
      const c = chunkCoords(key, this.coords);
      this.tree.forEachNodeTouchingChunk(c[0], c[1], c[2], this.bumpEpoch);
    }
  }

  /**
   * Calls `cb` (inside update(), in the frame the meshes are applied) once every currently displayed
   * node covering any of `chunkKeys` shows a mesh that includes all edits made before this call. If no
   * displayed node covers them, calls back on the next update(). Safety timeout: 2 s.
   * Used by FallingBody to swap its own mesh with the world meshes without flicker or doubling.
   *
   * "Covering" includes neighbours whose 1-cell padding reaches into the chunks (their faces next to
   * the edits change too). The displayed nodes of a pending request swap their new meshes together:
   * each holds its new mesh back until every one of them has its own, so the world changes in one
   * frame — the frame of the callback. Requests sharing a node swap together too (each holds its
   * nodes while another one holds a node of it), and no LOD split or merge involves a held node.
   */
  whenMeshed(chunkKeys: Iterable<number>, cb: () => void): void {
    const req: MeshRequest = { nodes: [], stamps: [], cb, deadline: this.clock() + WHEN_MESHED_TIMEOUT_MS, hold: false, holdTick: -1 };
    this.addNodes(req, chunkKeys, false);
    this.requests.push(req);
  }

  /**
   * Holds back the new meshes of every node touching `chunkKeys`, as a pending whenMeshed request does, while a world
   * write spans several frames; `add` holds those of more chunks (what each later slice marks dirty). The held nodes get
   * no mesh job meanwhile — no mesh of theirs could show before the write is complete — so each is meshed once, against
   * all of it. `release(cb)` turns the hold into whenMeshed(every chunk held, cb) for the edits made until then. A hold
   * not released within WHEN_MESHED_TIMEOUT_MS of game time (update()'s dt: it stands still while the game is paused,
   * as its holder does) stops holding; a later release then acts as a plain whenMeshed. Releasing again does nothing.
   */
  holdMeshes(chunkKeys: Iterable<number>): MeshHold {
    const keys = new Set(chunkKeys);
    let released = false;
    // Never met (stamps +Infinity): its nodes are held until it is released, or flushRequests drops it via `cb` once it
    // timed out.
    const req: MeshRequest = {
      nodes: [],
      stamps: [],
      cb: () => this.unhold(req),
      deadline: this.gameMs + WHEN_MESHED_TIMEOUT_MS,
      hold: true,
      holdTick: -1,
    };
    this.addNodes(req, keys, true);
    this.requests.push(req);
    return {
      add: (chunks) => {
        const more = Array.from(chunks);
        for (const key of more) keys.add(key);
        if (req.hold) this.addNodes(req, more, true);
      },
      release: (cb) => {
        if (released) return;
        released = true;
        if (!req.hold) {
          this.whenMeshed(keys, cb); // it timed out and was dropped
          return;
        }
        this.unhold(req);
        for (let i = 0; i < req.nodes.length; i++) req.stamps[i] = coveredStamp(this.world, req.nodes[i]);
        req.cb = cb;
        req.deadline = this.clock() + WHEN_MESHED_TIMEOUT_MS;
      },
    };
  }

  stats(): ChunkRenderStats {
    return {
      visibleNodes: this.visibleMeshes,
      triangles: this.visibleTriangles,
      pendingJobs: this.inFlight + Math.max(0, this.wanted.length - this.wantedPos),
      cachedNodes: this.cachedMeshes,
    };
  }

  /**
   * Snapshot of the displayed cut for QA and tests: every node with its voxel bounds and what it shows
   * ('mesh', 'empty' = known to have no geometry, 'none' = nothing yet, only before the first meshes).
   */
  debugCut(): CutNodeInfo[] {
    return this.cut.map((n) => ({
      level: n.level,
      x: n.x0,
      y: n.y0,
      z: n.z0,
      size: n.size,
      shows: n.shown === null ? 'none' : n.shown.group === null ? 'empty' : 'mesh',
      current: n.shown !== null && n.shown.epoch === n.epoch,
    }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.slots) this.detachWorker(s);
    this.slots.length = 0;
    for (const n of this.tree.nodes) {
      if (n.shown !== null && n.shown !== n.result) this.disposeRecord(n.shown);
      if (n.result !== null) this.disposeRecord(n.result);
      n.shown = null;
      n.result = null;
    }
    disposeNodeMesh(this.warmup);
    this.root.clear();
    this.scene.remove(this.root);
    this.swaps.clear();
    this.lazy.clear();
    this.wanted.length = 0;
    this.requests = [];
    if (this.prewarmState !== null) {
      this.prewarmState.resolve();
      this.prewarmState = null;
    }
  }

  // ------------------------------------------------------------------ LOD

  private isCurrent(n: RenderNode): boolean {
    return n.result !== null && n.result.epoch === n.epoch;
  }

  /**
   * Marks the nodes held back this frame — those of every pending request whose meshes are not all in yet (a hold until
   * it is released), and of every request sharing a held node, so that overlapping requests swap together (updateLod
   * leaves them all alone too) — then shows the newly accepted meshes of the other cut nodes.
   */
  private applySwaps(): void {
    let holding = false;
    for (const req of this.requests) {
      if (this.expired(req) || (!req.hold && this.resultsReady(req))) continue;
      this.holdNodes(req);
      holding = true;
    }
    for (let grew = holding; grew; ) {
      grew = false;
      for (const req of this.requests) {
        if (req.holdTick === this.tick || this.expired(req) || !this.sharesHeldNode(req)) continue;
        this.holdNodes(req);
        grew = true;
      }
    }
    for (const n of this.swaps) {
      if (n.holdTick === this.tick) continue;
      this.swaps.delete(n);
      if (n.inCut && n.result !== null && n.result !== n.shown) this.show(n, n.result);
    }
  }

  private holdNodes(req: MeshRequest): void {
    req.holdTick = this.tick;
    for (const n of req.nodes) {
      n.holdTick = this.tick;
      if (n.result !== null) n.result.lastUsed = this.tick; // a held mesh is not evictable
    }
  }

  private sharesHeldNode(req: MeshRequest): boolean {
    for (const n of req.nodes) if (n.holdTick === this.tick) return true;
    return false;
  }

  /** Split / merge decisions for the cut; transitions are applied nearest first within the upload budget. */
  private updateLod(): void {
    const { x, y, z } = this.cam;
    const tr = this.transitions;
    tr.length = 0;
    for (const n of this.cut) {
      const d = n.distanceTo(x, y, z);
      if (n.level > 0 && d < splitDistance(n.level)) {
        let ready = true;
        for (const c of n.children) {
          if (this.isCurrent(c)) {
            (c.result as NodeRecord).lastUsed = this.tick;
          } else {
            ready = false;
            this.want(c, JOB_LOD, this.priority(c));
          }
        }
        if (ready) {
          n.transKind = SPLIT;
          n.transDist = d;
          tr.push(n);
        }
        continue;
      }
      if (n.level > 0 && d < splitDistance(n.level) + PREFETCH_MARGIN[n.level - 1]) {
        for (const c of n.children) if (!this.isCurrent(c)) this.want(c, JOB_PREFETCH, this.priority(c));
      }
      const p = n.parent;
      if (p === null || p.mergeTick === this.tick) continue;
      p.mergeTick = this.tick;
      const pd = p.distanceTo(x, y, z);
      if (pd <= splitDistance(p.level) + RENDER.lodMergeMargin || !allChildrenInCut(p)) continue;
      if (this.isCurrent(p)) {
        (p.result as NodeRecord).lastUsed = this.tick;
        p.transKind = MERGE;
        p.transDist = pd;
        tr.push(p);
      } else {
        this.want(p, JOB_LOD, this.priority(p));
      }
    }
    if (tr.length === 0) return;
    tr.sort(byTransitionDistance);
    let used = 0;
    for (const n of tr) {
      // A held node keeps its place, and so do its children: the transition would show meshes held back. (A request
      // holds every node touching its chunks, at every level: a held child has a held parent.)
      if (n.holdTick === this.tick) continue;
      const bytes = n.transKind === SPLIT ? this.uploadBytesOfChildren(n) : this.uploadBytes(n);
      if (used > 0 && used + bytes > RENDER.uploadBytesPerFrame) continue;
      used += bytes;
      if (n.transKind === SPLIT) {
        this.leaveCut(n);
        n.split = true;
        for (const c of n.children) this.enterCut(c);
      } else {
        for (const c of n.children) this.leaveCut(c);
        n.split = false;
        this.enterCut(n);
      }
      this.cutDirty = true;
    }
    this.rebuildCut();
  }

  private uploadBytes(n: RenderNode): number {
    const r = n.result;
    return r !== null && r.group !== null && !r.uploaded ? r.bytes : 0;
  }

  private uploadBytesOfChildren(n: RenderNode): number {
    let sum = 0;
    for (const c of n.children) sum += this.uploadBytes(c);
    return sum;
  }

  private enterCut(n: RenderNode): void {
    n.inCut = true;
    if (n.result !== null) this.show(n, n.result);
  }

  private leaveCut(n: RenderNode): void {
    n.inCut = false;
    if (n.shown !== null) {
      this.hide(n, n.shown);
      n.shown = null;
    }
  }

  /** Puts `rec` on screen for cut node n (replacing what it showed). */
  private show(n: RenderNode, rec: NodeRecord): void {
    if (n.shown !== null) this.hide(n, n.shown);
    n.shown = rec;
    rec.lastUsed = this.tick;
    if (rec.group === null) return;
    this.root.add(rec.group);
    this.visibleMeshes++;
    this.visibleTriangles += rec.triangles;
    if (!rec.uploaded) {
      // Drawn unculled for one frame so the upload happens now, inside the frame's budget.
      rec.uploaded = true;
      for (const m of rec.group.children) {
        m.frustumCulled = false;
        this.forced.push(m);
      }
    }
  }

  private hide(n: RenderNode, rec: NodeRecord): void {
    if (rec.group !== null) {
      this.root.remove(rec.group);
      this.visibleMeshes--;
      this.visibleTriangles -= rec.triangles;
    }
    if (rec !== n.result) this.disposeRecord(rec);
    else rec.lastUsed = this.tick;
  }

  private rebuildCut(): void {
    if (!this.cutDirty) return;
    this.cutDirty = false;
    this.cut.length = 0;
    for (const r of this.tree.roots) this.collectCut(r);
  }

  private collectCut(n: RenderNode): void {
    if (n.inCut) this.cut.push(n);
    else if (n.split) for (const c of n.children) this.collectCut(c);
  }

  /** Re-meshes the node under the camera if the camera entered one of its culled sealed pockets. */
  private checkCameraPocket(): void {
    const { x, y, z } = this.cam;
    let n = this.tree.nodeAt(ROOT_LEVEL, x, y, z);
    while (n !== null && n.split && n.level > 0) n = this.tree.nodeAt(n.level - 1, x, y, z);
    if (n === null || !n.inCut || n.cameraReseed || n.jobEpoch >= 0 || this.nowMs < n.reseedAt) return;
    const shown = n.shown;
    if (shown === null || shown.cavities === null) return;
    // Built with the camera in this very voxel: a pocket around it is already open.
    if (this.cameraKey() === shown.seedKey) return;
    const boxes = shown.cavities;
    const cx = (x - n.x0) / n.cell;
    const cy = (y - n.y0) / n.cell;
    const cz = (z - n.z0) / n.cell;
    for (let i = 0; i < boxes.length; i += 6) {
      if (cx >= boxes[i] && cy >= boxes[i + 1] && cz >= boxes[i + 2] && cx < boxes[i + 3] && cy < boxes[i + 4] && cz < boxes[i + 5]) {
        n.cameraReseed = true;
        n.reseedAt = this.nowMs + RESEED_INTERVAL_MS;
        return;
      }
    }
  }

  private cameraKey(): number {
    return Math.floor(this.cam.x) + Math.floor(this.cam.z) * 4096 + Math.floor(this.cam.y) * 16777216;
  }

  // ------------------------------------------------------------------ dirt

  private readonly bumpEpoch = (n: RenderNode, inside: boolean): void => {
    n.epoch++;
    if (inside) n.contentDirty = true;
    // Hidden ancestors holding a mesh refresh it lazily, so walking back merges without waiting.
    if (n.split && !n.inCut && n.result !== null) {
      n.lazyDue = this.nowMs + LAZY_DELAY_MS;
      this.lazy.add(n);
    }
  };

  // ------------------------------------------------------------------ jobs

  /** Distance to the camera, pushed back for nodes behind it. */
  private priority(n: RenderNode): number {
    const { x, y, z } = this.cam;
    const d = n.distanceTo(x, y, z);
    const half = n.size / 2;
    const ahead = (n.x0 + half - x) * this.camDir.x + (n.y0 + half - y) * this.camDir.y + (n.z0 + half - z) * this.camDir.z;
    return ahead < -1.8 * half ? d * 1.5 + 64 : d;
  }

  /** Main-thread empty test, once per epoch; empty nodes get an empty record instead of a job. */
  private markIfEmpty(n: RenderNode): boolean {
    if (n.emptyEpoch === n.epoch) return false;
    n.emptyEpoch = n.epoch;
    if (!nodeIsEmpty(this.world, n)) return false;
    this.accept(n, {
      epoch: n.epoch,
      stamp: coveredStamp(this.world, n),
      hash: -1,
      meshHash: EMPTY_MESH_HASH,
      group: null,
      bytes: 0,
      triangles: 0,
      uploaded: true,
      lastUsed: this.tick,
      cavities: null,
      seedKey: -1,
    });
    return true;
  }

  private want(n: RenderNode, cls: number, prio: number): void {
    if (n.wantTick === this.tick) {
      if (cls < n.wantClass || (cls === n.wantClass && prio < n.wantPrio)) {
        n.wantClass = cls;
        n.wantPrio = prio;
      }
      return;
    }
    if (n.result !== null) n.result.lastUsed = this.tick;
    if (n.jobEpoch >= 0 || this.nowMs < n.retryAt) return;
    if (this.isCurrent(n) && !n.cameraReseed) return;
    if (this.markIfEmpty(n)) return;
    n.wantTick = this.tick;
    n.wantClass = cls;
    n.wantPrio = prio;
    this.wanted.push(n);
  }

  private schedule(): void {
    for (const n of this.cut) {
      if (this.isCurrent(n) && !n.cameraReseed) continue;
      // Level 0 first, then nodes whose own cells changed (or that show nothing yet), then the rest.
      const urgent = n.contentDirty || n.shown === null || n.cameraReseed ? 0 : 400;
      this.want(n, JOB_EDIT, n.level * 1000 + urgent + this.priority(n));
    }
    for (const n of this.lazy) {
      if (!n.split || n.inCut || n.result === null || this.isCurrent(n)) this.lazy.delete(n);
      else if (this.nowMs >= n.lazyDue) this.want(n, JOB_LAZY, this.priority(n));
    }
    this.wanted.sort(byWant);
    this.wantedPos = 0;
    this.dispatch();
  }

  /** Hands the best wanted nodes to idle workers (also called whenever a worker answers). */
  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.node !== null) continue;
      const n = this.nextWanted();
      if (n === null) return;
      this.send(slot, n);
    }
  }

  private nextWanted(): RenderNode | null {
    while (this.wantedPos < this.wanted.length) {
      const n = this.wanted[this.wantedPos];
      // Lazy entries sort last; at most one of them runs at a time.
      if (n.wantClass === JOB_LAZY && this.lazyInFlight > 0) return null;
      this.wantedPos++;
      // Not under a hold (also one taken since the list was made): its mesh could not show before the write is
      // complete, so it waits for the release and is meshed once, against all of it.
      if (n.holds === 0 && n.jobEpoch < 0 && (!this.isCurrent(n) || n.cameraReseed)) return n;
    }
    return null;
  }

  private send(slot: WorkerSlot, n: RenderNode): void {
    const job: MeshJob = {
      type: 'job',
      id: ++this.jobSeq,
      level: n.level,
      ox: n.x0,
      oy: n.y0,
      oz: n.z0,
      boundary: n.boundary,
      // A re-seed must mesh even with unchanged inputs: the camera seed is not part of the hash.
      prevHash: n.result !== null && !n.noShortcut && !n.cameraReseed ? n.result.hash : -1,
      camX: this.cam.x,
      camY: this.cam.y,
      camZ: this.cam.z,
    };
    n.jobEpoch = n.epoch;
    n.jobStamp = coveredStamp(this.world, n);
    n.jobSeedKey = this.cameraKey();
    n.contentDirty = false;
    n.noShortcut = false;
    n.cameraReseed = false;
    slot.node = n;
    slot.jobId = job.id;
    slot.jobClass = n.wantClass;
    slot.jobStart = this.clock();
    this.inFlight++;
    if (slot.jobClass === JOB_LAZY) this.lazyInFlight++;
    slot.worker.postMessage(job, []);
  }

  /** Clears the slot's job; returns its node with jobEpoch/jobStamp still describing the job. */
  private finishJob(slot: WorkerSlot): RenderNode {
    const n = slot.node as RenderNode;
    slot.node = null;
    this.inFlight--;
    if (slot.jobClass === JOB_LAZY) this.lazyInFlight--;
    return n;
  }

  private onWorkerMessage(slot: WorkerSlot, msg: MeshWorkerResponse): void {
    if (this.disposed || msg.type !== 'result' || slot.node === null || msg.id !== slot.jobId) return;
    const n = this.finishJob(slot);
    const epoch = n.jobEpoch;
    const stamp = n.jobStamp;
    n.jobEpoch = -1;
    if (!msg.ok) {
      this.jobFailed(n, msg.error);
    } else if (msg.unchanged || msg.mesh === null) {
      const rec = n.result;
      if (rec !== null && rec.hash === msg.hash) {
        rec.epoch = Math.max(rec.epoch, epoch);
        rec.stamp = Math.max(rec.stamp, stamp);
        n.failures = 0;
      } else {
        n.noShortcut = true;
      }
    } else if (n.result !== null && n.result.meshHash === msg.meshHash) {
      // New inputs, same geometry (e.g. only skylight samples away from any face changed): keep the
      // held mesh, no upload; it now stands for these inputs.
      const rec = n.result;
      rec.epoch = Math.max(rec.epoch, epoch);
      rec.stamp = Math.max(rec.stamp, stamp);
      rec.hash = msg.hash;
      rec.cavities = msg.mesh.cavities;
      rec.seedKey = n.jobSeedKey;
      n.failures = 0;
    } else {
      const built = buildNodeMesh(msg.mesh, n.level, n.x0, n.y0, n.z0, this.materials);
      if (built !== null) {
        this.cacheBytes += built.bytes;
        this.cachedMeshes++;
      }
      this.accept(n, {
        epoch,
        stamp,
        hash: msg.hash,
        meshHash: msg.meshHash,
        group: built === null ? null : built.group,
        bytes: built === null ? 0 : built.bytes,
        triangles: built === null ? 0 : built.triangles,
        uploaded: built === null,
        lastUsed: this.tick,
        cavities: msg.mesh.cavities,
        seedKey: n.jobSeedKey,
      });
    }
    if (this.prewarmState !== null) this.pumpPrewarm();
    else this.dispatch();
  }

  /** Takes a result unless something newer is held; displayed nodes swap in the next update(). */
  private accept(n: RenderNode, rec: NodeRecord): void {
    const old = n.result;
    if (old !== null && old.epoch > rec.epoch) {
      this.disposeRecord(rec);
      return;
    }
    n.result = rec;
    n.failures = 0;
    if (old !== null && old !== n.shown) this.disposeRecord(old);
    if (n.inCut) this.swaps.add(n);
  }

  private disposeRecord(rec: NodeRecord): void {
    if (rec.group === null) return;
    disposeNodeMesh(rec.group);
    rec.group = null;
    this.cacheBytes -= rec.bytes;
    this.cachedMeshes--;
  }

  private jobFailed(n: RenderNode, error: string): void {
    n.failures++;
    n.retryAt = this.clock() + Math.min(30000, 250 * 2 ** n.failures);
    if (this.loggedErrors < 20) {
      this.loggedErrors++;
      console.error(`[chunks] mesh job failed (L${n.level} node at ${n.x0},${n.y0},${n.z0}):`, error);
    }
  }

  // ------------------------------------------------------------------ workers

  private spawnWorker(): MeshWorkerLike {
    if (this.workerFailures < MAX_WORKER_FAILURES) {
      try {
        return this.createWorker();
      } catch (e) {
        console.warn('[chunks] mesh workers unavailable, meshing on the main thread:', e);
        this.workerFailures = MAX_WORKER_FAILURES;
      }
    }
    return new InlineMeshWorker();
  }

  private attachWorker(slot: WorkerSlot): void {
    const w = slot.worker;
    w.onmessage = (ev) => this.onWorkerMessage(slot, ev.data as MeshWorkerResponse);
    w.onerror = (ev) => this.onWorkerError(slot, ev);
    w.postMessage({ type: 'init', shared: this.world.toShared() } satisfies MeshWorkerRequest, []);
  }

  private detachWorker(slot: WorkerSlot): void {
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.terminate();
  }

  /**
   * Jobs never throw out of a worker, so an error event means the worker itself is broken (failed to
   * load, crashed): its job is re-queued and the worker replaced.
   */
  private onWorkerError(slot: WorkerSlot, ev: ErrorEvent): void {
    ev.preventDefault();
    if (this.disposed) return;
    console.error('[chunks] mesh worker error:', ev.message);
    this.replaceWorker(slot);
  }

  private replaceWorker(slot: WorkerSlot): void {
    if (slot.node !== null) this.finishJob(slot).jobEpoch = -1;
    this.detachWorker(slot);
    this.workerFailures++;
    slot.worker = this.spawnWorker();
    this.attachWorker(slot);
    if (this.prewarmState !== null) this.pumpPrewarm();
    else this.dispatch();
  }

  private replaceStalledWorkers(): void {
    for (const slot of this.slots) {
      if (slot.node !== null && this.nowMs - slot.jobStart > JOB_TIMEOUT_MS) {
        console.error('[chunks] mesh worker stalled; replacing it');
        this.replaceWorker(slot);
      }
    }
  }

  // ------------------------------------------------------------------ prewarm, whenMeshed, cache

  /** Dispatches the prewarm cut's missing meshes; installs the cut when complete. */
  private pumpPrewarm(): void {
    const pw = this.prewarmState as PrewarmState;
    let done = 0;
    this.wanted.length = 0;
    for (const n of pw.pending) {
      if (this.isCurrent(n) || n.failures >= PREWARM_MAX_FAILURES) {
        done++;
      } else if (n.jobEpoch < 0) {
        n.wantTick = this.tick;
        n.wantClass = JOB_LOD;
        this.wanted.push(n);
      }
    }
    this.wantedPos = 0;
    if (done !== pw.done) {
      pw.done = done;
      pw.onProgress?.(done, pw.pending.length);
    }
    if (done < pw.pending.length) {
      this.dispatch();
      return;
    }
    this.prewarmState = null;
    for (const n of this.cut) this.leaveCut(n);
    for (const n of this.tree.nodes) n.split = false;
    for (const n of pw.desired) {
      for (let p = n.parent; p !== null && !p.split; p = p.parent) p.split = true;
      this.enterCut(n);
    }
    this.swaps.clear();
    this.cutDirty = true;
    this.rebuildCut();
    console.info(
      `[chunks] prewarm: ${pw.desired.length} nodes in the cut, ${pw.pending.length} jobs, ` +
        `${this.visibleMeshes} meshes, ${this.visibleTriangles} triangles, ${(this.clock() - pw.t0).toFixed(0)} ms`,
    );
    pw.resolve();
  }

  private flushRequests(): void {
    if (this.requests.length === 0) return;
    const pending = this.requests;
    this.requests = [];
    for (const req of pending) {
      // An unreleased hold is never met: it ends with its release, or here once it timed out (its `cb` drops it).
      if (!this.expired(req) && (req.hold || !this.meshedFor(req))) {
        this.requests.push(req);
        continue;
      }
      try {
        req.cb();
      } catch (e) {
        console.error('[chunks] whenMeshed callback failed:', e);
      }
    }
  }

  /** The request gave up waiting: its deadline passed (in game time while it is an unreleased hold). */
  private expired(req: MeshRequest): boolean {
    return (req.hold ? this.gameMs : this.nowMs) >= req.deadline;
  }

  /** An unreleased hold ends (released, or dropped once timed out): its nodes may get mesh jobs again. */
  private unhold(req: MeshRequest): void {
    if (!req.hold) return;
    req.hold = false;
    for (const n of req.nodes) n.holds--;
  }

  /**
   * Adds every node covering any of `chunkKeys` (see whenMeshed) that `req` does not hold yet, requiring its
   * coveredStamp now — or +Infinity (`held`: an unreleased hold, never met, which the node counts in `holds`).
   */
  private addNodes(req: MeshRequest, chunkKeys: Iterable<number>, held: boolean): void {
    const mark = ++this.requestSeq;
    for (const n of req.nodes) n.requestMark = mark;
    const add = (n: RenderNode): void => {
      if (n.requestMark === mark) return;
      n.requestMark = mark;
      req.nodes.push(n);
      req.stamps.push(held ? Infinity : coveredStamp(this.world, n));
      if (held) n.holds++;
    };
    for (const key of chunkKeys) {
      const c = chunkCoords(key, this.coords);
      this.tree.forEachNodeTouchingChunk(c[0], c[1], c[2], add);
    }
  }

  /** Every cut node of the request holds a mesh (shown, or waiting to swap) built after its edits. */
  private resultsReady(req: MeshRequest): boolean {
    for (let i = 0; i < req.nodes.length; i++) {
      const n = req.nodes[i];
      const rec = n.result ?? n.shown;
      if (n.inCut && (rec === null || rec.stamp < req.stamps[i])) return false;
    }
    return true;
  }

  /** Every cut node of the request shows a mesh built after the request's edits. */
  private meshedFor(req: MeshRequest): boolean {
    for (let i = 0; i < req.nodes.length; i++) {
      const n = req.nodes[i];
      if (n.inCut && (n.shown === null || n.shown.stamp < req.stamps[i])) return false;
    }
    return true;
  }

  /** Drops least recently used hidden meshes while the cache exceeds RENDER.meshCacheBytes. */
  private evict(): void {
    if (this.cacheBytes <= RENDER.meshCacheBytes) return;
    const list = this.evictable;
    list.length = 0;
    for (const n of this.tree.nodes) {
      const r = n.result;
      if (r !== null && r.group !== null && r !== n.shown && n.jobEpoch < 0 && r.lastUsed < this.tick) list.push(n);
    }
    list.sort(byLastUse);
    const target = RENDER.meshCacheBytes * 0.9;
    for (const n of list) {
      if (this.cacheBytes <= target) break;
      this.disposeRecord(n.result as NodeRecord);
      n.result = null;
    }
    list.length = 0;
  }
}

function allChildrenInCut(n: RenderNode): boolean {
  for (const c of n.children) if (!c.inCut) return false;
  return true;
}
