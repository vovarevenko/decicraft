/**
 * A detached voxel piece (cut tree, broken wall chunk) that falls and settles back into the world.
 * OWNER: agent "interaction".
 * What it starts from comes from the felling client (interaction/felling.ts): the piece, its FallPlan
 * (interaction/fallingPiece.ts: grid, toppling decision, pivot, axis, contact probes) and its mesh — the voxels at
 * 10 cm scale with block colours (pieceMeshJob.ts). The felling worker prepares them all; when the client has to
 * analyse a removal itself (no worker, or the worker's answers keep going stale or fail) the plan is made on the main
 * thread, and the mesh too only without a worker or when the worker cannot make it.
 * The constructor vacates the piece's voxels: at once when they fit in one write slice, else a slice per frame from then
 * on ('vacating', see WRITES IN SLICES). The mesh is hidden in the constructor's frame (its first update runs in it
 * too); from the next one on, until it starts moving, it is rendered with an empty draw range and no frustum culling,
 * which draws nothing but makes three.js upload its buffers then. Once the piece is out of the world ('syncing') it
 * waits for ctx.chunks.whenMeshed of every chunk the vacate marked dirty (World.recordMarks: the piece's chunks, their
 * neighbours and those whose skylight changed — the ground under the crown loses its shade in the same frame) — then it
 * is drawn and starts moving (no doubled or missing tree, and a felled oak's ~8 MB of vertex data goes to the GPU
 * neither in the vacate frame nor in the one in which the world's meshes swap, unless they swap the very next frame).
 * SYNC_TIMEOUT_S counts from the end of the vacate.
 * Tall pieces (trees) topple around their base edge on the side facing away from the player with pendulum-like
 * angular acceleration; others fall straight down.
 * Contact = sampled centres of the piece's STRUCT voxels (trunk, branches) hit SOLID world voxels (foliage of other
 * trees is passable, and so is their wood more than 2 m above a toppling tree's base: it breaks through
 * neighbouring crowns). On contact or after ~88° it lands: dust puffs + 'tree_fall'/'impact' at once, while the
 * felling worker scans the cells the posed piece fills and the chunks they touch ('landing'; inverse-transform
 * sampling, only into replaceable cells). The next update after the answer writes them (writeLanding: each cell
 * checked against the world again, none into the player's box as it is then; the STRUCT skeleton kept connected so
 * it stays supported) — a big landing a slice per frame ('writing'; each cell checked, and the player's box taken, in
 * the frame that writes it; then the skeleton's joins, JOIN_SLICE_VOXELS of its voxels per frame) — on the main thread
 * at once without a worker, as soon as no answer can come (the scan failed, the worker was given up), or if none came
 * within LAND_WAIT_S. The entity stays visible until ctx.chunks.whenMeshed(every chunk the landing marked dirty) fires
 * ('settling'), then removes itself (no gap).
 * Small pieces (< MIN_FALLING_VOXELS) turn into item drops instead (interaction/collapse.ts).
 *
 * WRITES IN SLICES (ARCHITECTURE.md §11.3): written in one go, a felled oak (~150 k voxels) would cost a frame
 * 10–20 ms twice, vacated and landed. A write of more than WRITE_SLICE_VOXELS is spread over frames, one slice each:
 * whole chunk runs up to that budget (sliceEnd; the worker sends pieces and landing cells in chunk order, so each
 * chunk is written in one slice). Nothing half written may show, be analysed or be touched by the player:
 * - ctx.chunks.holdMeshes keeps the meshes of every chunk a slice marks dirty (World.recordMarks, skylight changes
 *   included) as they were until the write is complete, when they swap together, as for whenMeshed. Held nodes get no
 *   mesh jobs meanwhile, so each is meshed once, against the whole write (a render node spans 2×2×2 chunks: several
 *   slices dirty it). The hold times out in game time only: a paused game stops the write and its hold alike.
 * - The felling client's write guard keeps every support analysis off the world (one would detach fragments of the
 *   piece being vacated: a second body for the same voxels), and the voxels the body still owns — the piece not
 *   vacated yet, the landing cells not joined yet (blockAt) — are not there for the player (FellingClient.owned):
 *   dug, they would come back with the landing; built against, a block would hang in the air.
 * A body removed mid-write (or whose update threw) ends the guard and releases the hold in onRemove.
 *
 * Motion: a toppling piece obeys θ'' = (3g / 2h)·sin(θ + θ₀) about the bottom edge of its base (h = piece
 * height, θ₀ = 0.05 so it starts leaning at once without a visible jump), while gravity drops it until its
 * base rests on something (the stump). Past 88° it stops turning and just falls. Integration is sub-stepped
 * so no probe moves more than half a voxel per step; on contact the last free pose is kept. Cells of the
 * landing pose that overlap the player stay empty, so a falling tree never traps the player.
 */
import * as THREE from 'three';
import { GRAVITY } from '../config';
import type { Vec3Like } from '../core/math';
import { SOLID } from '../world/blocks';
import type { DetachedPiece } from '../world/structure';
import type { WorldData } from '../world/world';
import type { MeshHold } from '../render/voxel/chunkRenderer';
import { getModelMaterial } from '../render/voxelModel';
import type { GameContext } from './context';
import { Entity } from './entities/entity';
import { clearVoxels } from './interaction/breaking';
import { fellingFor, type FellingClient, type WorldWriter } from './interaction/felling';
import type { LandingScan } from './interaction/fellingJob';
import {
  gridBlock,
  hasContact,
  joinSkeleton,
  PiecePose,
  revoxelize,
  writeLanding,
  writeLandingCells,
  type FallPlan,
  type PieceGrid,
  type WriteVeto,
} from './interaction/fallingPiece';
import { sliceEnd, VoxelList } from './interaction/voxelList';
import { bodyAABB, makeAABB } from './physics';

const TOPPLE_KICK = 0.05;
const MAX_TILT = (88 * Math.PI) / 180;
const FALL_TIMEOUT_S = 6;
/** Fallback in case a whenMeshed callback never arrives (it has its own 2 s timeout). */
const SYNC_TIMEOUT_S = 3;
/** Longest wait for the felling worker's landing scan before revoxelizing on the main thread. */
const LAND_WAIT_S = 1;
/** Max travel of any probe per integration sub-step (world units). */
const MAX_STEP = 0.5;
const MAX_SUBSTEPS = 48;
const DUST_PUFFS = 3;
/** A landing tree / piece startles animals this far away (world units). */
const TREE_NOISE_RADIUS = 300;
const IMPACT_NOISE_RADIUS = 200;
/**
 * Voxels a body writes into the world per frame (vacating its piece, writing its landing), plus at most one chunk run:
 * a bigger write is spread over several frames.
 */
export const WRITE_SLICE_VOXELS = 10_000;
/** Skeleton voxels a body joins per frame (joinSkeleton) after the cells of a landing written in slices. */
export const JOIN_SLICE_VOXELS = 2_000;

type Phase = 'vacating' | 'syncing' | 'moving' | 'landing' | 'writing' | 'settling';

const noop = (): void => {};

export class FallingBody extends Entity implements WorldWriter {
  readonly type = 'falling';
  private phase: Phase = 'syncing';
  private elapsed = 0;
  /** update() calls so far: the first one runs in the frame of the vacate. */
  private updates = 0;
  /** The felling worker's landing scan, written by the next update; undefined: no answer yet, null: none can come. */
  private scan: LandingScan | null | undefined;
  /** While 'vacating': the piece, its voxels [0, vacated) out of the world. */
  private piece: DetachedPiece | null = null;
  private vacated = 0;
  /** The plants that stood on the vacated voxels. */
  private readonly plants = new VoxelList(64);
  /**
   * While 'writing': the landing cells, the scanned ones [next, scanned) still to check and [0, kept) written (the list
   * is compacted in place); then the skeleton voxels [0, joined) of the grid are joined.
   */
  private landing: VoxelList | null = null;
  private scanned = 0;
  private next = 0;
  private kept = 0;
  private joined = 0;
  /** During a write in slices: the chunk renderer's hold on the meshes and the client whose guard it holds. */
  private hold: MeshHold | null = null;
  private felling: FellingClient | null = null;
  /** The chunks the slice being written marks dirty (World.recordMarks). */
  private readonly marked = new Set<number>();
  /** blockAt scratch. */
  private readonly atRest = { x: 0, y: 0, z: 0 };
  /** The player's box when the current slice is written, and the landing veto that keeps solid blocks out of it. */
  private readonly playerBox = makeAABB();
  private readonly blocked: WriteVeto = (x, y, z, id) => {
    const box = this.playerBox;
    return SOLID[id] === 1 && x < box.maxX && x + 1 > box.minX && y < box.maxY && y + 1 > box.minY && z < box.maxZ && z + 1 > box.minZ;
  };
  private readonly grid: PieceGrid;
  private readonly pose = new PiecePose();
  private readonly probes: Float32Array;
  /** Largest distance of a probe from the pivot (bounds how far probes sweep per radian). */
  private readonly probeReach: number;
  private readonly mesh: THREE.Mesh;
  /** Horizontal rotation axis (up × push direction). */
  private readonly axis = new THREE.Vector3();
  /** 3g / 2h. */
  private readonly toppleRate: number;
  /** Chosen to topple (a tree); keeps the 'tree_fall' sound even after it stopped turning. */
  private readonly tree: boolean;
  private toppling: boolean;
  /** The base rests on something: no more free fall while toppling. */
  private resting = false;
  private angle = 0;
  private spin = 0;
  private fallSpeed = 0;
  private drop = 0;
  private readonly voxels: number;

  /**
   * `plan` and `geometry` (the piece's mesh, origin at the grid's min corner) come from the felling client;
   * `touched` = touchedChunks(piece) when worked out ahead (held from the start of a write in slices; the chunks each
   * slice marks dirty are added as it goes). Vacates the piece's voxels (a big piece's first slice).
   */
  constructor(ctx: GameContext, piece: DetachedPiece, plan: FallPlan, geometry: THREE.BufferGeometry, touched?: Iterable<number>) {
    super();
    const [x0, y0, z0] = piece.min;
    const [x1, y1, z1] = piece.max;
    this.voxels = piece.count;
    this.grid = plan.grid;
    this.tree = this.toppling = plan.tree;
    const rest = this.pose.rest;
    rest.x = plan.rest.x;
    rest.y = plan.rest.y;
    rest.z = plan.rest.z;
    this.axis.set(plan.axis.x, plan.axis.y, plan.axis.z);
    this.toppleRate = plan.toppleRate;
    this.probes = plan.probes;
    this.probeReach = plan.probeReach;
    this.syncPose();

    // Rendered until it starts (from the frame after this one: see update()), but with nothing to draw: three.js uploads
    // the buffers of a mesh it renders even with an empty draw range, so they reach the GPU before the frame in which
    // the world's meshes swap — and not in this frame, which vacates the piece.
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geometry, getModelMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.position.set(x0 - rest.x, y0 - rest.y, z0 - rest.z);
    this.object.add(this.mesh);
    this.object.visible = false;
    this.position.set(rest.x, rest.y, rest.z);
    this.halfWidth = Math.max(x1 - x0, z1 - z0) / 2;
    this.height = y1 - y0;

    // The piece leaves the world now; the mesh is drawn once the world's meshes no longer show it.
    if (sliceEnd(piece, 0, WRITE_SLICE_VOXELS) === piece.count) {
      const vacated = new Set(touched);
      ctx.world.recordMarks(vacated, () => clearVoxels(ctx.world, piece, 0, this.plants));
      ctx.chunks.whenMeshed(vacated, () => this.start());
      return;
    }
    // Too big for one frame: this slice now, then one per update from the next frame on.
    this.phase = 'vacating';
    this.piece = piece;
    this.beginWrite(ctx, touched ?? []);
    this.vacateSlice(ctx);
  }

  update(dt: number, ctx: GameContext): void {
    this.elapsed += dt;
    this.updates++;
    switch (this.phase) {
      case 'vacating':
        if (this.updates === 2) this.object.visible = true; // the frame after the first slice: upload
        if (this.updates > 1) this.vacateSlice(ctx); // the first update runs in the constructor's frame
        return;
      case 'syncing':
        if (this.updates === 2) this.object.visible = true; // the frame after the vacate: upload
        if (this.elapsed > SYNC_TIMEOUT_S) this.start();
        return;
      case 'moving':
        if (this.advance(dt, ctx.world) || this.elapsed > FALL_TIMEOUT_S) this.land(ctx);
        this.position.set(this.pose.pivot.x, this.pose.pivot.y, this.pose.pivot.z);
        this.object.quaternion.setFromAxisAngle(this.axis, this.angle);
        return;
      case 'landing':
        if (this.scan !== undefined || this.elapsed > LAND_WAIT_S) this.settle(ctx);
        return;
      case 'writing':
        this.writeSlice(ctx);
        return;
      case 'settling':
        if (this.elapsed > SYNC_TIMEOUT_S) this.finish(ctx);
        return;
    }
  }

  onRemove(): void {
    // Removed in the middle of a write in slices (its update threw): felling goes on, the world's meshes are let go.
    this.endWrite(noop);
    this.mesh.geometry.dispose();
  }

  /**
   * WorldWriter: the block of the grid that world cell (x, y, z)'s centre falls in at the body's pose — the piece's own
   * voxel at rest while vacating it, the block scanLanding gave the cell while writing the landing — or 0.
   */
  blockAt(x: number, y: number, z: number): number {
    const q = this.pose.toRest(x + 0.5, y + 0.5, z + 0.5, this.atRest);
    return gridBlock(this.grid, Math.floor(q.x), Math.floor(q.y), Math.floor(q.z));
  }

  /** Vacates the next slice of the piece; after the last one the body waits for the world's meshes ('syncing'). */
  private vacateSlice(ctx: GameContext): void {
    const piece = this.piece as DetachedPiece;
    const from = this.vacated;
    const end = sliceEnd(piece, from, WRITE_SLICE_VOXELS);
    this.writeHeld(ctx, () => clearVoxels(ctx.world, piece, from, this.plants, end));
    this.vacated = end;
    if (end < piece.count) return;
    this.piece = null;
    this.phase = 'syncing';
    this.elapsed = 0;
    this.endWrite(() => this.start());
  }

  /** A write in slices begins: the meshes of `chunks` are held back and no support analysis reads the world. */
  private beginWrite(ctx: GameContext, chunks: Iterable<number>): void {
    this.hold = ctx.chunks.holdMeshes(chunks);
    this.felling = fellingFor(ctx.world);
    this.felling.beginWrite(this);
  }

  /** Writes one slice of the write in slices: the meshes of every chunk it marks dirty are held back with the others. */
  private writeHeld(ctx: GameContext, write: () => void): void {
    const marked = this.marked;
    marked.clear();
    ctx.world.recordMarks(marked, write);
    this.hold?.add(marked);
  }

  /** The write in slices (if any) is over: felling goes on; `done` once the world's meshes of all it wrote are current. */
  private endWrite(done: () => void): void {
    this.felling?.endWrite(this);
    this.felling = null;
    const hold = this.hold;
    this.hold = null;
    hold?.release(done);
  }

  /** The world no longer shows the piece: draw our mesh in its place and let it go. */
  private start(): void {
    if (this.phase !== 'syncing') return;
    this.phase = 'moving';
    this.elapsed = 0;
    this.object.visible = true;
    this.mesh.geometry.setDrawRange(0, Infinity);
    this.mesh.frustumCulled = true;
  }

  /** Integrates dt in sub-steps; returns true once the piece came to rest (the pose is the last free one). */
  private advance(dt: number, world: WorldData): boolean {
    const fall = this.resting ? 0 : (this.fallSpeed + GRAVITY * dt) * dt;
    const turn = this.toppling ? (Math.abs(this.spin) + this.toppleRate * dt) * dt * this.probeReach : 0;
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil((fall + turn) / MAX_STEP)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      if (!this.resting) {
        const before = this.drop;
        this.fallSpeed += GRAVITY * h;
        this.drop += this.fallSpeed * h;
        this.syncPose();
        if (hasContact(world, this.pose, this.probes, this.tree)) {
          this.drop = before;
          this.fallSpeed = 0;
          this.syncPose();
          if (!this.toppling) return true;
          this.resting = true;
        }
      }
      if (this.toppling) {
        const before = this.angle;
        this.spin += this.toppleRate * Math.sin(this.angle + TOPPLE_KICK) * h;
        this.angle = Math.min(MAX_TILT, this.angle + this.spin * h);
        this.syncPose();
        if (hasContact(world, this.pose, this.probes, this.tree)) {
          this.angle = before;
          this.syncPose();
          return true;
        }
        if (this.angle >= MAX_TILT) {
          this.toppling = false;
          this.resting = false;
          this.spin = 0;
        }
      }
    }
    return false;
  }

  private syncPose(): void {
    const pose = this.pose;
    pose.setRotation(this.axis.x, this.axis.y, this.axis.z, this.angle);
    pose.pivot.x = pose.rest.x;
    pose.pivot.y = pose.rest.y - this.drop;
    pose.pivot.z = pose.rest.z;
  }

  /** Came to rest: dust and sound now, and the felling worker scans the cells the piece fills at its pose. */
  private land(ctx: GameContext): void {
    this.phase = 'landing';
    this.elapsed = 0;
    this.landingEffects(ctx);
    // Called between frames: only kept here, the next update writes it.
    const scanning = fellingFor(ctx.world).land(this.grid, this.pose, (scan) => {
      if (this.phase === 'landing') this.scan = scan;
    });
    if (!scanning) this.settle(ctx);
  }

  /**
   * Re-voxelises the piece at its pose — the worker's scanned cells (a big landing in slices, see writeSlice), or here
   * on the main thread without them — never into the player's box; removes the entity once the world shows it.
   */
  private settle(ctx: GameContext): void {
    const scan = this.scan ?? null;
    this.scan = undefined;
    this.elapsed = 0;
    const world = ctx.world;
    let written: VoxelList;
    // Every chunk the landing marks dirty: those of its cells and their neighbours, and those whose skylight it changes.
    const chunks = new Set<number>();
    if (scan !== null) {
      written = scan.cells;
      const end = sliceEnd(written, 0, WRITE_SLICE_VOXELS);
      if (end < written.count || this.grid.struct.length > 3 * JOIN_SLICE_VOXELS) {
        // Too big for one frame: this slice now, then one per update; the meshes of the scanned chunks are held back.
        this.phase = 'writing';
        this.landing = written;
        this.scanned = written.count;
        this.kept = this.joined = 0;
        this.beginWrite(ctx, scan.touched);
        this.writeCells(ctx, 0, end);
        return;
      }
      world.recordMarks(chunks, () => writeLanding(world, this.grid, this.pose, written, 0, this.vetoNow(ctx)));
    } else {
      written = new VoxelList(Math.min(this.voxels, 1 << 16));
      world.recordMarks(chunks, () => revoxelize(world, this.grid, this.pose, written, this.vetoNow(ctx)));
    }
    this.phase = 'settling';
    if (written.count === 0) this.finish(ctx);
    else ctx.chunks.whenMeshed(chunks, () => this.finish(ctx));
  }

  /**
   * The next slice of a landing written in slices: cells checked against the world and the player's box now, and once
   * they are all written the skeleton's joins (they need every cell in place), a range of skeleton voxels per update.
   * Then the body waits for the world's meshes of every chunk written ('settling') — or finishes at once if none was.
   */
  private writeSlice(ctx: GameContext): void {
    if (this.next < this.scanned) {
      this.writeCells(ctx, this.next, sliceEnd(this.landing as VoxelList, this.next, WRITE_SLICE_VOXELS));
      return;
    }
    const cells = this.landing as VoxelList;
    const skeleton = this.grid.struct.length / 3;
    const from = this.joined;
    const end = Math.min(skeleton, from + JOIN_SLICE_VOXELS);
    this.writeHeld(ctx, () => joinSkeleton(ctx.world, this.grid, this.pose, cells, this.vetoNow(ctx), from, end));
    this.joined = end;
    if (end < skeleton) return;
    this.landing = null;
    this.phase = 'settling';
    this.elapsed = 0;
    if (cells.count > 0) {
      this.endWrite(() => this.finish(ctx));
      return;
    }
    this.endWrite(noop);
    this.finish(ctx);
  }

  /** Checks and writes landing cells [from, end); after the last scanned one, the written cells are the whole list. */
  private writeCells(ctx: GameContext, from: number, end: number): void {
    const cells = this.landing as VoxelList;
    this.writeHeld(ctx, () => {
      this.kept = writeLandingCells(ctx.world, cells, from, end, this.kept, this.vetoNow(ctx));
    });
    this.next = end;
    if (end === this.scanned) cells.count = this.kept; // the joins append theirs after them
  }

  /** The landing veto as of now: no solid block into the player's box where it is at this moment. */
  private vetoNow(ctx: GameContext): WriteVeto {
    bodyAABB(ctx.player, this.playerBox);
    return this.blocked;
  }

  /** Dust where the lowest probes ended up (where it hit the ground) and a crash at the piece's centre. */
  private landingEffects(ctx: GameContext): void {
    const { pose, probes } = this;
    const { rest } = pose;
    const landed: Vec3Like[] = [];
    for (let i = 0; i < probes.length; i += 3) {
      landed.push(pose.toWorld(rest.x + probes[i], rest.y + probes[i + 1], rest.z + probes[i + 2], { x: 0, y: 0, z: 0 }));
    }
    landed.sort((a, b) => a.y - b.y);
    const radius = Math.min(14, Math.max(3, Math.cbrt(this.voxels) * 0.6));
    for (const at of landed.slice(0, DUST_PUFFS)) ctx.particles.dust(at, radius);
    const g = this.grid;
    const centre = pose.toWorld(g.minX + g.sx / 2, g.minY + g.sy / 2, g.minZ + g.sz / 2, { x: 0, y: 0, z: 0 });
    ctx.audio.play(this.tree ? 'tree_fall' : 'impact', { pos: centre });
    ctx.entities.emitNoise(ctx, centre, this.tree ? TREE_NOISE_RADIUS : IMPACT_NOISE_RADIUS);
  }

  private finish(ctx: GameContext): void {
    if (this.removed) return;
    this.object.visible = false;
    ctx.entities.remove(this);
  }
}
