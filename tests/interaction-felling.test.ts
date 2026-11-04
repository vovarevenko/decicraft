import * as THREE from 'three';
import { afterAll, describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import { FallingBody, JOIN_SLICE_VOXELS, WRITE_SLICE_VOXELS } from '../src/game/fallingBody';
import { clearVoxels, collectBrush } from '../src/game/interaction/breaking';
import { Aftermath } from '../src/game/interaction/collapse';
import { fellingFor } from '../src/game/interaction/felling';
import {
  PiecePose,
  buildPieceGrid,
  joinSkeleton,
  planFall,
  revoxelize,
  scanLanding,
  touchedChunks,
  writeLanding,
  writeLandingCells,
  type PieceGrid,
} from '../src/game/interaction/fallingPiece';
import {
  detachTransferables,
  handleFellingMessage,
  runDetach,
  runLand,
  type DetachOutput,
  type DetachRequest,
  type FellingReply,
  type FellingRequest,
  type FellingState,
  type LandingScan,
  type LandRequest,
  type MeshRequest,
} from '../src/game/interaction/fellingJob';
import { buildPieceGeometry, dataToGeometry, geometryToData, type PieceMeshData } from '../src/game/interaction/pieceMeshJob';
import { TargetPicker } from '../src/game/interaction/targeting';
import { VoxelList, chunkOrder, sliceEnd, sortByChunk, type VoxelSet } from '../src/game/interaction/voxelList';
import { B, SOLID } from '../src/world/blocks';
import { findDetached, type DetachedPiece } from '../src/world/structure';
import { World, WorldData, chunkKey, chunkKeyAt } from '../src/world/world';

vi.mock('../src/game/entities/itemDrop', () => ({
  ItemDrop: class {
    readonly type = 'item';
    removed = false;
    constructor(
      public itemId: string,
      public count: number,
    ) {}
  },
}));

/**
 * Stands in for the module worker (node has no Worker): keeps what is posted and, on answer(), runs it through the
 * real handleFellingMessage against a WorldData built from the 'init' message — the real job code. Messages both
 * ways are structured clones with their transfer lists, as between threads: a buffer posted along is gone from the
 * sender (the shared world's buffers stay shared).
 */
class FakeWorker {
  static last: FakeWorker | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault(): void }) => void) | null = null;
  readonly inbox: FellingRequest[] = [];
  /** Every answer, as the client received it. */
  readonly replies: FellingReply[] = [];
  terminated = false;
  private readonly state: FellingState = { world: null };

  constructor(readonly url: URL) {
    FakeWorker.last = this;
  }

  postMessage(msg: FellingRequest, transfer: Transferable[] = []): void {
    this.inbox.push(structuredClone(msg, { transfer }));
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Jobs of this type posted and not answered yet. */
  pending(type: 'detach' | 'land' | 'mesh'): number {
    return this.inbox.filter((m) => m.type === type).length;
  }

  /** Handles the posted messages in order, answering at most `jobs` jobs. */
  answer(jobs = Infinity): void {
    while (this.inbox.length > 0) {
      const msg = this.inbox[0];
      if (msg.type !== 'init' && msg.type !== 'segment' && jobs-- <= 0) return;
      this.inbox.shift();
      handleFellingMessage(this.state, msg, (reply, transfer) => this.reply(structuredClone(reply, { transfer })));
    }
  }

  /** Answers the next job as one that threw. */
  fail(): void {
    const i = this.inbox.findIndex((m) => m.type !== 'init' && m.type !== 'segment');
    const job = this.inbox.splice(i, 1)[0] as DetachRequest | LandRequest | MeshRequest;
    this.reply({ type: job.type, id: job.id, ok: false, error: 'test failure' });
  }

  /** Dies like a worker that failed to load or crashed. */
  crash(): void {
    this.onerror?.({ message: 'test crash', preventDefault: () => {} });
  }

  private reply(reply: FellingReply): void {
    this.replies.push(reply);
    this.onmessage?.({ data: reply });
  }
}
vi.stubGlobal('Worker', FakeWorker);
afterAll(() => {
  vi.unstubAllGlobals();
});

const world = World.create();
const workers = new Map<World, FakeWorker>();

/** The fake worker of `w`'s felling client (started here). */
function connect(w: World): FakeWorker {
  let worker = workers.get(w);
  if (worker === undefined) {
    fellingFor(w).start();
    worker = FakeWorker.last!;
    workers.set(w, worker);
  }
  return worker;
}

/** The meshes of the worker's last answer to a mesh job. */
function meshesSent(worker: FakeWorker): PieceMeshData[] {
  const reply = worker.replies.filter((r) => r.type === 'mesh').at(-1);
  if (reply?.type !== 'mesh' || !reply.ok) throw new Error('no mesh answer');
  return reply.meshes;
}

/** The output of the worker's last answer to a detach job (its falls are what the bodies got). */
function detachSent(worker: FakeWorker): DetachOutput {
  const reply = worker.replies.filter((r) => r.type === 'detach').at(-1);
  if (reply?.type !== 'detach' || !reply.ok) throw new Error('no detach answer');
  return reply.out;
}

/** A 2×2 oak trunk with a leaf crown at (x, 100, z) on a dirt pad reaching 5 m east (where it lands when it topples that way). */
function plantTree(w: World, x: number, z: number): void {
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 50; dx++) w.setBlock(x + dx, 99, z + dz, B.DIRT);
  for (let y = 100; y < 140; y++) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) w.setBlock(x + dx, y, z + dz, B.OAK_LOG);
  for (let y = 134; y < 144; y++) {
    for (let dz = -4; dz <= 5; dz++) {
      for (let dx = -4; dx <= 5; dx++) if (w.getBlock(x + dx, y, z + dz) === B.AIR) w.setBlock(x + dx, y, z + dz, B.OAK_LEAVES);
    }
  }
}

/** Cuts the tree at (x, z) through at y = 101, just above the ground (its trunk `width` across); returns the emptied cells. */
function chop(w: World, x: number, z: number, y = 101, width = 2): VoxelList {
  const removed = new VoxelList();
  for (let dz = 0; dz < width; dz++) {
    for (let dx = 0; dx < width; dx++) {
      w.setBlock(x + dx, y, z + dz, B.AIR);
      removed.push(x + dx, y, z + dz, B.OAK_LOG);
    }
  }
  return removed;
}

/** plantTree, then chop: the emptied cells of the cut. */
function cutTree(w: World, x: number, z: number): VoxelList {
  plantTree(w, x, z);
  return chop(w, x, z);
}

/** Where the player stands when cutting the tree at (x, z): to its west, so it topples east. */
const westOf = (x: number, z: number) => ({ x: x - 10, y: 100, z: z + 1 });

/**
 * A big oak at (x, 100, z): a trunk 7 m tall, `trunk` voxels across, in a crown 1.2 m deep around its upper part (with
 * the 2×2 trunk ~26 k voxels: three write slices), on a dirt pad reaching 9.6 m east and south (where it lands).
 */
function plantBigTree(w: World, x: number, z: number, trunk = 2): void {
  for (let dz = -16; dz <= 96; dz++) for (let dx = -16; dx <= 96; dx++) w.setBlock(x + dx, 99, z + dz, B.DIRT);
  for (let y = 100; y < 170; y++) for (let dz = 0; dz < trunk; dz++) for (let dx = 0; dx < trunk; dx++) w.setBlock(x + dx, y, z + dz, B.OAK_LOG);
  for (let y = 130; y <= 170; y++) {
    for (let dz = -12; dz < trunk + 12; dz++) {
      for (let dx = -12; dx < trunk + 12; dx++) if (w.getBlock(x + dx, y, z + dz) === B.AIR) w.setBlock(x + dx, y, z + dz, B.OAK_LEAVES);
    }
  }
}

/** plantBigTree, then chop: the emptied cells of the cut. */
function cutBigTree(w: World, x: number, z: number, trunk = 2): VoxelList {
  plantBigTree(w, x, z, trunk);
  return chop(w, x, z, 101, trunk);
}

function makeCtx(w: World) {
  const pending: (() => void)[] = [];
  const added: { type: string }[] = [];
  /** Every ChunkRenderer.holdMeshes: the chunks held from the start, those added as the write went on, its releases. */
  const holds: { keys: Set<number>; added: Set<number>; releases: (() => void)[] }[] = [];
  const ctx = {
    world: w,
    chunks: {
      whenMeshed: vi.fn((_keys: Iterable<number>, cb: () => void) => void pending.push(cb)),
      // Released, a hold calls back like whenMeshed (once the meshes are current: flushMeshes).
      holdMeshes: vi.fn((keys: Iterable<number>) => {
        const hold = { keys: new Set(keys), added: new Set<number>(), releases: [] as (() => void)[] };
        holds.push(hold);
        return {
          add: (more: Iterable<number>): void => [...more].forEach((key) => hold.added.add(key)),
          release: (cb: () => void): void => {
            hold.releases.push(cb);
            pending.push(cb);
          },
        };
      }),
    },
    entities: {
      add: (e: { type: string }) => (added.push(e), e),
      remove: (e: { removed: boolean }) => void (e.removed = true),
      emitNoise: vi.fn(),
    },
    particles: { blockBreak: vi.fn(), splash: vi.fn(), dust: vi.fn() },
    audio: { play: vi.fn() },
    player: { position: new THREE.Vector3(10, 100, 10), halfWidth: 3, height: 18 },
  };
  return {
    ctx,
    game: ctx as unknown as GameContext,
    aftermath: new Aftermath(),
    added,
    holds,
    bodies: () => added.filter((e): e is FallingBody => e instanceof FallingBody),
    /** Runs the whenMeshed callbacks, as ChunkRenderer.update() does once meshes are applied. */
    flushMeshes: () => pending.splice(0).forEach((cb) => cb()),
  };
}

const mesh = (body: FallingBody): THREE.Mesh => body.object.children[0] as THREE.Mesh;
const positionsOf = (body: FallingBody): ArrayLike<number> => mesh(body).geometry.getAttribute('position').array;
/** Drawn (while syncing the mesh is rendered with an empty draw range: only its buffers upload). */
const drawn = (body: FallingBody): boolean => body.object.visible && mesh(body).geometry.drawRange.count > 0;

const cellsOf = (list: VoxelList, dx = 0): string[] =>
  Array.from({ length: list.count }, (_, i) => `${list.positions[i * 3] + dx},${list.positions[i * 3 + 1]},${list.positions[i * 3 + 2]}`).sort();

function countBlocks(w: World, id: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (w.getBlock(x, y, z) === id) n++;
  return n;
}

/** "x,y,z:id" of every voxel of `set`, sorted. */
const voxelsOf = (set: VoxelSet): string[] =>
  Array.from({ length: set.count }, (_, i) => `${set.positions[i * 3]},${set.positions[i * 3 + 1]},${set.positions[i * 3 + 2]}:${set.ids[i]}`).sort();

/** The voxels of `set` are in chunk order. */
function inChunkOrder(set: VoxelSet): boolean {
  const p = set.positions;
  for (let i = 1; i < set.count; i++) if (chunkOrder(p[i * 3 - 3], p[i * 3 - 2], p[i * 3 - 1]) > chunkOrder(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])) return false;
  return true;
}

/** Lengths of the chunk runs of `set`: maximal runs of consecutive voxels in one chunk. */
function chunkRuns(set: VoxelSet): number[] {
  const p = set.positions;
  const runs: number[] = [];
  for (let i = 0; i < set.count; ) {
    const key = chunkKeyAt(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    let j = i + 1;
    while (j < set.count && chunkKeyAt(p[j * 3], p[j * 3 + 1], p[j * 3 + 2]) === key) j++;
    runs.push(j - i);
    i = j;
  }
  return runs;
}

const sortedKeys = (keys: Iterable<number>): number[] => [...keys].sort((a, b) => a - b);

/** Every block of `a` and `b` in the box (x0, y0, z0 inclusive, x1, y1, z1 exclusive), `b` shifted by dx: equal. */
function expectSameBlocks(a: World, b: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, dx = 0): void {
  let differ = 0;
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) if (a.getBlock(x, y, z) !== b.getBlock(x + dx, y, z)) differ++;
  expect(differ).toBe(0);
}

/** One frame of the game loop: Aftermath first (Interaction.update), then the bodies (EntityManager.update). */
function frame(t: ReturnType<typeof makeCtx>, ...bodies: FallingBody[]): void {
  t.aftermath.update(t.game);
  for (const b of bodies) b.update(1 / 60, t.game);
}

/** Steps a body (drawn once re-meshed) until it asks the worker for its landing scan. */
function fallUntilLanding(t: ReturnType<typeof makeCtx>, body: FallingBody, worker: FakeWorker): void {
  for (let i = 0; i < 600 && worker.pending('land') === 0; i++) {
    body.update(1 / 60, t.game);
    t.flushMeshes();
  }
  expect(worker.pending('land')).toBe(1);
}

/** Cuts the tree at (x, z) and has its detach job fail: the client analyses it itself and posts a mesh job. */
function meshJobFor(t: ReturnType<typeof makeCtx>, worker: FakeWorker, x: number, z: number): void {
  t.aftermath.settle(t.game, cutTree(world, x, z), westOf(x, z));
  worker.answer(0); // init and segments only
  worker.fail();
  t.aftermath.update(t.game);
  expect(worker.pending('mesh')).toBe(1);
}

describe('felling in the worker', () => {
  test('a cut tree stays in the world until the answer is taken, then leaves it and is drawn once re-meshed', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    expect(String(worker.url)).toMatch(/felling\.worker\.ts$/);
    t.aftermath.settle(t.game, cutTree(world, 200, 200), westOf(200, 200));
    expect(worker.pending('detach')).toBe(1);
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(0);
    expect(world.getBlock(200, 120, 200)).toBe(B.OAK_LOG); // still standing: no gap

    worker.answer();
    expect(world.getBlock(200, 120, 200)).toBe(B.OAK_LOG); // answers are taken by update() only
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    expect(t.bodies()).toHaveLength(1);
    expect(world.getBlock(200, 120, 200)).toBe(B.AIR);
    expect(world.getBlock(200, 140, 201)).toBe(B.AIR); // the crown went with it
    expect(mesh(body).geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(body.object.visible).toBe(false); // not rendered in the frame that vacated the tree…
    body.update(1 / 60, t.game); // (its first update comes in that frame too)
    expect(body.object.visible).toBe(false);
    body.update(1 / 60, t.game);
    expect(body.object.visible).toBe(true); // …but from the next one on, for the GPU upload…
    expect(mesh(body).frustumCulled).toBe(false);
    expect(drawn(body)).toBe(false); // …with nothing drawn while the world still shows the tree
    expect(t.ctx.chunks.whenMeshed).toHaveBeenCalledTimes(1);
    t.flushMeshes();
    expect(drawn(body)).toBe(true);
    expect(mesh(body).frustumCulled).toBe(true);
  });

  test('small pieces come back as crumbles: item drops where they hung, and water floods their cells', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    for (let z = 600; z < 611; z++) for (let x = 1100; x < 1111; x++) world.setBlock(x, 115, z, B.STONE); // ceiling
    for (let y = 100; y < 108; y++) for (let z = 600; z < 611; z++) for (let x = 1100; x < 1111; x++) world.setBlock(x, y, z, B.WATER);
    for (let y = 105; y < 108; y++) for (let z = 604; z < 607; z++) for (let x = 1104; x < 1107; x++) world.setBlock(x, y, z, B.BRICK);
    for (let y = 108; y < 115; y++) world.setBlock(1105, y, 605, B.BRICK); // hangs from the ceiling
    world.setBlock(1105, 110, 605, B.AIR);
    const removed = new VoxelList();
    removed.push(1105, 110, 605, B.BRICK);
    t.aftermath.settle(t.game, removed, { x: 1090, y: 100, z: 605 });
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(0);
    expect(t.added.some((e) => e.type === 'item')).toBe(true);
    expect(world.getBlock(1105, 109, 605)).toBe(B.AIR); // above the water line
    expect(world.getBlock(1105, 106, 605)).toBe(B.WATER);
    expect(t.ctx.particles.splash).toHaveBeenCalledTimes(1);
  });

  test('geometry arrays survive the round trip through the worker message', () => {
    const ids = new Uint8Array(4 * 3 * 2);
    ids[0] = B.OAK_LOG;
    ids[5] = B.OAK_LEAVES;
    const geometry = buildPieceGeometry(4, 3, 2, ids);
    const back = dataToGeometry(geometryToData(geometry));
    expect(back.getAttribute('position').array).toEqual(geometry.getAttribute('position').array);
    expect(back.getAttribute('color').array).toEqual(geometry.getAttribute('color').array);
    expect(back.getIndex()!.array).toEqual(geometry.getIndex()!.array);
    expect(back.boundingBox).toEqual(geometry.boundingBox);
    expect(back.boundingSphere).toEqual(geometry.boundingSphere);
  });

  test('a detach answer transfers every buffer it holds, each once', () => {
    const removed = cutTree(world, 1000, 200);
    const out = runDetach(new WorldData(world.toShared()), removed.triples(), 400_000, 400_000, westOf(1000, 200));
    expect(out.falls).toHaveLength(1);
    const views: ArrayBufferView[] = [];
    const collect = (v: unknown): void => {
      if (ArrayBuffer.isView(v)) views.push(v);
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(collect);
    };
    collect(out);
    expect(views.length).toBeGreaterThan(10);
    structuredClone(out, { transfer: detachTransferables(out) }); // throws on a buffer listed twice
    for (const v of views) expect(v.byteLength).toBe(0); // detached: it was transferred
  });

  test('the read box holds every voxel the job reads, down to where a hanging piece looks for a stand', () => {
    // A brick column hanging from a stone ceiling, its foot 2 voxels above the chunk border at y = 96 with nothing
    // below: planFall looks for something to stand on 6 voxels down, into the chunk layer below the piece.
    for (let z = 300; z < 311; z++) for (let x = 300; x < 311; x++) world.setBlock(x, 128, z, B.STONE);
    for (let y = 98; y < 128; y++) for (let z = 305; z < 307; z++) for (let x = 305; x < 307; x++) world.setBlock(x, y, z, B.BRICK);
    const seeds: number[] = [];
    for (let z = 305; z < 307; z++) {
      for (let x = 305; x < 307; x++) {
        world.setBlock(x, 127, z, B.AIR);
        seeds.push(x, 127, z);
      }
    }
    const data = new WorldData(world.toShared());
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    const getBlock = data.getBlock.bind(data);
    data.getBlock = (x: number, y: number, z: number): number => {
      [x, y, z].forEach((c, a) => {
        lo[a] = Math.min(lo[a], c);
        hi[a] = Math.max(hi[a], c);
      });
      return getBlock(x, y, z);
    };
    const out = runDetach(data, seeds, 400_000, 400_000, { x: 290, y: 100, z: 305.5 });
    expect(out.falls).toHaveLength(1);
    expect(out.falls[0].plan.tree).toBe(false); // nothing to stand on: it drops
    expect(lo[1]).toBe(98 - 6);
    for (let a = 0; a < 3; a++) {
      expect(lo[a]).toBeGreaterThanOrEqual(out.readBox[a]);
      expect(hi[a]).toBeLessThan(out.readBox[a + 3]);
    }
  });
});

describe('water after a dig', () => {
  test('a dig beside water touching no STRUCT voxel: the cell floods at once, nothing goes to the worker', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    for (let y = 100; y < 105; y++) for (let z = 800; z < 806; z++) for (let x = 1100; x < 1112; x++) world.setBlock(x, y, z, x < 1106 ? B.WATER : B.DIRT);
    world.setBlock(1106, 103, 802, B.AIR); // the pond's shore
    const removed = new VoxelList();
    removed.push(1106, 103, 802, B.DIRT);
    const posted = worker.inbox.length;
    t.aftermath.settle(t.game, removed, { x: 1120, y: 100, z: 802 });
    expect(world.getBlock(1106, 103, 802)).toBe(B.WATER);
    expect(t.ctx.particles.splash).toHaveBeenCalledTimes(1);
    expect(worker.inbox.length).toBe(posted);
  });

  test('a dig beside water that cuts a piece loose: the dug cell floods at once, the crumbled cells when it crumbles', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    for (let z = 700; z < 711; z++) for (let x = 1100; x < 1111; x++) world.setBlock(x, 115, z, B.STONE); // ceiling
    for (let y = 100; y < 108; y++) for (let z = 700; z < 711; z++) for (let x = 1100; x < 1111; x++) world.setBlock(x, y, z, B.WATER);
    for (let y = 103; y < 106; y++) for (let z = 704; z < 707; z++) for (let x = 1104; x < 1107; x++) world.setBlock(x, y, z, B.BRICK);
    for (let y = 106; y < 115; y++) world.setBlock(1105, y, 705, B.BRICK); // hangs from the ceiling into the water
    world.setBlock(1105, 107, 705, B.AIR); // dug at the water's surface
    const removed = new VoxelList();
    removed.push(1105, 107, 705, B.BRICK);
    t.aftermath.settle(t.game, removed, { x: 1090, y: 100, z: 705 });
    expect(world.getBlock(1105, 107, 705)).toBe(B.WATER);
    expect(t.ctx.particles.splash).toHaveBeenCalledTimes(1);
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.added.some((e) => e.type === 'item')).toBe(true);
    expect(t.ctx.particles.splash).toHaveBeenCalledTimes(2);
    expect(world.getBlock(1105, 106, 705)).toBe(B.WATER);
    expect(world.getBlock(1105, 104, 705)).toBe(B.WATER);
    expect(world.getBlock(1105, 110, 705)).toBe(B.BRICK); // the part still hanging from the ceiling stays
  });
});

describe('staleness', () => {
  test('an edit inside the read box after the job ran: the answer is dropped, the re-run reflects the edit', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 300, 200), westOf(300, 200));
    worker.answer();
    world.setBlock(300, 144, 200, B.OAK_LEAVES); // a leaf put on the crown after the worker read it
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(0); // dropped…
    expect(world.getBlock(300, 120, 200)).toBe(B.OAK_LOG);
    expect(worker.pending('detach')).toBe(1); // …and asked again
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    expect(world.getBlock(300, 144, 200)).toBe(B.AIR); // the new leaf fell with the crown
  });

  test('the trunk cut through again after the job ran: asked again with that removal, both parts fall', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 400, 200), westOf(400, 200));
    worker.answer();
    t.aftermath.settle(t.game, chop(world, 400, 200, 120), westOf(400, 200)); // queued behind the job in flight
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(0);
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2); // the trunk between the cuts, and the rest with the crown
    expect(worker.pending('detach')).toBe(0);
    expect(world.getBlock(401, 110, 201)).toBe(B.AIR);
    expect(world.getBlock(401, 130, 201)).toBe(B.AIR);
  });

  test('an edit far outside the read box: the answer is applied as is', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 500, 200), westOf(500, 200));
    worker.answer();
    world.setBlock(1200, 300, 1200, B.STONE);
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    expect(worker.pending('detach')).toBe(0);
  });

  test('a tree cut while the job for another one runs, its cut inside that read box: asked again with it, both fall', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    plantTree(world, 212, 590); // in the chunks of the next one
    t.aftermath.settle(t.game, cutTree(world, 200, 600), westOf(200, 600));
    t.aftermath.settle(t.game, chop(world, 212, 590), westOf(212, 590)); // queued; the cut makes the answer stale
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(0);
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
    expect(world.getBlock(200, 120, 600)).toBe(B.AIR);
    expect(world.getBlock(212, 120, 590)).toBe(B.AIR);
    expect(worker.pending('detach')).toBe(0);
  });

  test('stale three times in a row: the batch is analysed here, the worker only meshes it', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 400, 600), westOf(400, 600));
    for (let i = 0; i < 3; i++) {
      expect(worker.pending('detach')).toBe(1);
      worker.answer();
      world.setBlock(396, 100, 605, i % 2 === 0 ? B.STONE : B.AIR); // placed or dug by the stump after every run
      t.aftermath.update(t.game);
      expect(t.bodies()).toHaveLength(0);
    }
    expect(worker.pending('detach')).toBe(0);
    expect(worker.pending('mesh')).toBe(1);
    expect(world.getBlock(400, 120, 600)).toBe(B.OAK_LOG); // standing until its mesh is made
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    const [body] = t.bodies();
    expect(world.getBlock(400, 120, 600)).toBe(B.AIR);
    expect(positionsOf(body)).toBe(meshesSent(worker)[0].position);
    // It lands like any other: the mesh job took a copy of its grid.
    const landed = (): number => countBlocks(world, B.OAK_LOG, 395, 99, 594, 450, 112, 607);
    const before = landed();
    fallUntilLanding(t, body, worker);
    worker.answer();
    body.update(1 / 60, t.game);
    expect(landed()).toBeGreaterThan(before + 60);
  });

  test('the read box edited while the falls are meshed: analysed again and applied at once, the same tree keeps its mesh', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    meshJobFor(t, worker, 600, 600);
    worker.answer();
    world.setBlock(596, 100, 605, B.STONE); // by the stump, after the analysis
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1); // no more waiting
    expect(worker.pending('detach') + worker.pending('mesh')).toBe(0);
    expect(world.getBlock(600, 120, 600)).toBe(B.AIR);
    expect(positionsOf(t.bodies()[0])).toBe(meshesSent(worker)[0].position);
    error.mockRestore();
  });

  test('a piece edited while it is meshed: analysed again without the gone voxel, its mesh made here', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    meshJobFor(t, worker, 800, 600);
    worker.answer();
    world.setBlock(801, 143, 601, B.AIR); // a leaf on top of the crown is gone
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    expect(worker.pending('detach') + worker.pending('mesh')).toBe(0);
    const sent = meshesSent(worker)[0].position;
    const made = positionsOf(t.bodies()[0]);
    expect(made).not.toBe(sent);
    expect(Array.from(made)).not.toEqual(Array.from(sent));
    expect(world.getBlock(801, 142, 601)).toBe(B.AIR); // the rest of the crown went
    error.mockRestore();
  });
});

describe('one job at a time', () => {
  test('a removal made while a job is in flight is posted only after its answer was applied', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 600, 200), westOf(600, 200));
    t.aftermath.settle(t.game, cutTree(world, 700, 200), westOf(700, 200));
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    expect(worker.pending('detach')).toBe(0);
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    expect(world.getBlock(600, 120, 200)).toBe(B.AIR);
    expect(world.getBlock(700, 120, 200)).toBe(B.OAK_LOG);
    expect(worker.pending('detach')).toBe(1); // the queued batch, posted right after the apply
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
    expect(world.getBlock(700, 120, 200)).toBe(B.AIR);
  });

  test('two more chops at a tree whose detach job is in flight: one job at a time, the tree falls once', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 800, 200), westOf(800, 200));
    for (const y of [110, 115]) {
      world.setBlock(800, y, 200, B.AIR);
      const chop = new VoxelList();
      chop.push(800, y, 200, B.OAK_LOG);
      t.aftermath.settle(t.game, chop, westOf(800, 200));
      expect(worker.pending('detach')).toBe(1);
    }
    for (let i = 0; i < 3 && worker.pending('detach') > 0; i++) {
      worker.answer();
      t.aftermath.update(t.game);
    }
    expect(t.bodies()).toHaveLength(1);
    expect(worker.pending('detach')).toBe(0);
    expect(world.getBlock(801, 120, 201)).toBe(B.AIR);
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
  });

  test('a removal made while the falls of an analysis made here are meshed waits for them', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    meshJobFor(t, worker, 200, 1000);
    t.aftermath.settle(t.game, cutTree(world, 400, 1000), westOf(400, 1000));
    expect(worker.pending('detach')).toBe(0); // queued
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    expect(world.getBlock(400, 120, 1000)).toBe(B.OAK_LOG);
    expect(worker.pending('detach')).toBe(1); // posted once the first tree left the world
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
    expect(world.getBlock(400, 120, 1000)).toBe(B.AIR);
    error.mockRestore();
  });
});

describe('fallbacks', () => {
  test('no Worker: settle() detaches and applies in the same call', () => {
    vi.stubGlobal('Worker', undefined);
    const w = World.create();
    try {
      const t = makeCtx(w);
      t.aftermath.settle(t.game, cutTree(w, 200, 200), westOf(200, 200));
      expect(t.bodies()).toHaveLength(1);
      expect(w.getBlock(200, 120, 200)).toBe(B.AIR);
    } finally {
      vi.stubGlobal('Worker', FakeWorker);
    }
  });

  test('an error answer: the batch is analysed here and meshed in the worker, which stays in use', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.aftermath.settle(t.game, cutTree(world, 900, 200), westOf(900, 200));
    worker.answer(0); // init and segments only
    worker.fail();
    t.aftermath.update(t.game);
    expect(error).toHaveBeenCalledTimes(1);
    expect(t.bodies()).toHaveLength(0);
    expect(worker.pending('mesh')).toBe(1);
    expect(world.getBlock(900, 120, 200)).toBe(B.OAK_LOG); // in the world until its mesh is made
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    expect(world.getBlock(900, 120, 200)).toBe(B.AIR);
    expect(positionsOf(t.bodies()[0])).toBe(meshesSent(worker)[0].position);
    t.aftermath.settle(t.game, cutTree(world, 1100, 200), westOf(1100, 200));
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
    error.mockRestore();
  });

  test('a mesh job that failed: the meshes are made here', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    meshJobFor(t, worker, 1000, 600);
    worker.fail();
    t.aftermath.update(t.game);
    expect(error).toHaveBeenCalledTimes(2);
    expect(t.bodies()).toHaveLength(1);
    expect(mesh(t.bodies()[0]).geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(world.getBlock(1000, 120, 600)).toBe(B.AIR);
    error.mockRestore();
  });

  test('a worker error: the batch in flight and the one queued behind it are detached at the next update, later ones at once', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.aftermath.settle(t.game, cutTree(w, 200, 200), westOf(200, 200));
    t.aftermath.settle(t.game, cutTree(w, 300, 200), westOf(300, 200));
    expect(worker.pending('detach')).toBe(1);
    worker.crash();
    expect(worker.terminated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(w.getBlock(200, 120, 200)).toBe(B.OAK_LOG);
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
    expect(w.getBlock(200, 120, 200)).toBe(B.AIR);
    expect(w.getBlock(300, 120, 200)).toBe(B.AIR);
    const posted = worker.inbox.length;
    t.aftermath.settle(t.game, cutTree(w, 400, 200), westOf(400, 200));
    expect(t.bodies()).toHaveLength(3);
    expect(worker.inbox.length).toBe(posted); // nothing goes to the dead worker
    warn.mockRestore();
  });

  test('a worker error with a landing scan and jobs in flight: the body lands at its next update, the next removal takes the jobs along', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.aftermath.settle(t.game, cutTree(w, 200, 200), westOf(200, 200));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    t.aftermath.settle(t.game, cutTree(w, 400, 200), westOf(400, 200)); // in flight
    t.aftermath.settle(t.game, cutTree(w, 600, 200), westOf(600, 200)); // queued
    const landed = (): number => countBlocks(w, B.OAK_LOG, 195, 99, 195, 250, 112, 207);
    const before = landed();
    worker.crash();
    body.update(1 / 60, t.game); // no answer can come: revoxelized now, not once LAND_WAIT_S ran out
    expect(landed()).toBeGreaterThan(before + 60);
    t.aftermath.settle(t.game, cutTree(w, 800, 200), westOf(800, 200)); // before the next update: all three go now
    expect(t.bodies()).toHaveLength(4);
    for (const x of [400, 600, 800]) expect(w.getBlock(x, 120, 200)).toBe(B.AIR);
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(4);
    warn.mockRestore();
  });
});

/**
 * A thin trunk with a small crown at x offset `ox`, tilted 70° towards +x+z (its skeleton needs joins) over dirt, with
 * a stone, a plant and water where it lies.
 */
function landingScene(ox: number): { grid: PieceGrid; pose: PiecePose } {
  for (let z = 40; z < 70; z++) for (let x = ox - 5; x < ox + 30; x++) world.setBlock(x, 99, z, B.DIRT);
  world.setBlock(ox + 2, 100, 51, B.STONE);
  world.setBlock(ox + 3, 100, 52, B.TALL_GRASS);
  world.setBlock(ox + 4, 101, 53, B.WATER);
  const voxels: [number, number, number, number][] = [];
  for (let y = 0; y < 26; y++) voxels.push([ox, 100 + y, 50, B.OAK_LOG]);
  for (let y = 22; y < 28; y++) for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) if (x !== 0 || z !== 0 || y >= 26) voxels.push([ox + x, 100 + y, 50 + z, B.OAK_LEAVES]);
  const piece: DetachedPiece = {
    positions: new Int32Array(voxels.flatMap(([x, y, z]) => [x, y, z])),
    ids: Uint8Array.from(voxels.map((v) => v[3])),
    count: voxels.length,
    min: [ox - 2, 100, 48],
    max: [ox + 3, 128, 53],
  };
  const pose = new PiecePose().setRotation(0.6, 0, -0.8, (70 * Math.PI) / 180);
  [pose.rest.x, pose.rest.y, pose.rest.z] = [ox + 1, 100, 50.5];
  [pose.pivot.x, pose.pivot.y, pose.pivot.z] = [ox + 1, 99.6, 50.5];
  return { grid: buildPieceGrid(piece), pose };
}

/** land() of `grid` at `pose`, answered by the worker: what the callback was handed. */
function landInWorker(worker: FakeWorker, grid: PieceGrid, pose: PiecePose): (LandingScan | null)[] {
  const scans: (LandingScan | null)[] = [];
  expect(fellingFor(world).land(grid, pose, (scan) => scans.push(scan))).toBe(true);
  expect(worker.pending('land')).toBe(1);
  worker.answer();
  expect(scans).toHaveLength(1);
  return scans;
}

describe('landing', () => {
  test('the worker scan plus writeLanding write what revoxelize writes', () => {
    const worker = connect(world);
    const a = landingScene(200);
    const b = landingScene(300);
    const [scan] = landInWorker(worker, a.grid, a.pose);
    expect(a.grid.ids.length).toBe(a.grid.sx * a.grid.sy * a.grid.sz); // the caller keeps its grid
    const { cells, touched } = scan!;
    expect([...touched].sort()).toEqual([...touchedChunks(cells)].sort());
    const scanned = cells.count;
    expect(writeLanding(world, a.grid, a.pose, cells, 0)).toBe(scanned); // nothing in the way
    const reference = new VoxelList();
    expect(revoxelize(world, b.grid, b.pose, reference)).toBe(cells.count);
    expect(cells.count).toBeGreaterThan(scanned); // the skeleton's joins follow the scanned cells
    expect(scanned).toBeGreaterThan(40);
    expect(cellsOf(cells, 100)).toEqual(cellsOf(reference));
    expect(world.getBlock(202, 100, 51)).toBe(B.STONE);
    expect(world.getBlock(203, 100, 52)).toBe(B.OAK_LOG); // over the plant
    expect(world.getBlock(204, 101, 53)).toBe(B.OAK_LOG); // and the water
  });

  test('a cell taken by something else between scan and write is skipped', () => {
    const worker = connect(world);
    const c = landingScene(400);
    const [scan] = landInWorker(worker, c.grid, c.pose);
    const { cells } = scan!;
    const i = Array.from(cells.ids.subarray(0, cells.count)).indexOf(B.OAK_LEAVES);
    const [x, y, z] = cells.positions.subarray(i * 3, i * 3 + 3);
    world.setBlock(x, y, z, B.BRICK);
    const scanned = cells.count;
    expect(writeLanding(world, c.grid, c.pose, cells, 0)).toBe(scanned - 1);
    expect(world.getBlock(x, y, z)).toBe(B.BRICK);
    expect(cellsOf(cells)).not.toContain(`${x},${y},${z}`);
  });

  test('the player standing in the landing spot by the time the cells are written keeps it empty', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 200, 400), westOf(200, 400));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    // The scan knows nothing of the player: it fills cells where the player then walks in.
    const request = worker.inbox.find((m): m is LandRequest => m.type === 'land')!;
    const { cells: scan } = runLand(new WorldData(world.toShared()), request);
    t.ctx.player.position.set(220, 100, 401);
    const inBox = (x: number, y: number, z: number): boolean => x >= 217 && x < 223 && y >= 100 && y < 118 && z >= 398 && z < 404;
    let scannedInBox = 0;
    for (let i = 0; i < scan.count; i++) {
      if (scan.ids[i] === B.OAK_LOG && inBox(scan.positions[i * 3], scan.positions[i * 3 + 1], scan.positions[i * 3 + 2])) scannedInBox++;
    }
    expect(scannedInBox).toBeGreaterThan(4);
    worker.answer();
    body.update(1 / 60, t.game);
    expect(countBlocks(world, B.OAK_LOG, 217, 100, 398, 223, 118, 404)).toBe(0);
    expect(countBlocks(world, B.OAK_LOG, 225, 99, 395, 250, 110, 407)).toBeGreaterThan(40); // the rest lies there
    t.flushMeshes();
    expect(body.removed).toBe(true);
  });

  test('the landing waits for every chunk written to: those the worker listed for the scanned cells, and the joins’', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    // It topples east into a hedge that fills the next chunk (x 224..255) above and below the dirt pad: the scan skips
    // foliage, so all written there are the trunk voxels joinSkeleton puts into the leaves.
    for (let y = 90; y < 116; y++) for (let z = 790; z < 811; z++) for (let x = 220; x < 256; x++) world.setBlock(x, y, z, B.OAK_LEAVES);
    t.aftermath.settle(t.game, cutTree(world, 196, 800), westOf(196, 800));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    worker.answer();
    const [x0, y0, z0, x1, y1, z1] = [186, 95, 790, 262, 150, 812];
    const before: number[] = [];
    for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) before.push(world.getBlock(x, y, z));
    body.update(1 / 60, t.game);
    const changed = new VoxelList();
    let i = 0;
    for (let y = y0; y < y1; y++) {
      for (let z = z0; z < z1; z++) {
        for (let x = x0; x < x1; x++) if (world.getBlock(x, y, z) !== before[i++]) changed.push(x, y, z, world.getBlock(x, y, z));
      }
    }
    expect(countBlocks(world, B.OAK_LOG, 224, 99, 794, 256, 112, 807)).toBeGreaterThan(0); // trunk voxels in the hedge
    expect(t.ctx.chunks.whenMeshed).toHaveBeenCalledTimes(2); // vacated, landed
    const waited = new Set(t.ctx.chunks.whenMeshed.mock.calls[1][0]);
    expect(waited.has(chunkKey(7, 3, 25))).toBe(true);
    for (const key of touchedChunks(changed)) expect(waited.has(key)).toBe(true);
  });

  test('a landing scan that failed: revoxelized at the next update, not once LAND_WAIT_S ran out', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    t.aftermath.settle(t.game, cutTree(world, 400, 800), westOf(400, 800));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    const landed = (): number => countBlocks(world, B.OAK_LOG, 395, 99, 795, 450, 112, 807);
    const before = landed();
    worker.fail();
    expect(error).toHaveBeenCalledTimes(1);
    body.update(1 / 60, t.game);
    expect(landed()).toBeGreaterThan(before + 60);
    error.mockRestore();
  });

  test('no answer within a second: revoxelized on the main thread, a late answer is ignored', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutTree(world, 400, 400), westOf(400, 400));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    const landed = (): number => countBlocks(world, B.OAK_LOG, 395, 99, 395, 450, 112, 407);
    const before = landed();
    for (let i = 0; i < 54; i++) body.update(1 / 60, t.game);
    expect(landed()).toBe(before); // still waiting
    for (let i = 0; i < 12; i++) body.update(1 / 60, t.game);
    const after = landed();
    expect(after).toBeGreaterThan(before + 60);
    expect(t.ctx.chunks.whenMeshed).toHaveBeenCalledTimes(2); // vacated, landed
    worker.answer();
    body.update(1 / 60, t.game);
    expect(landed()).toBe(after);
    expect(t.ctx.chunks.whenMeshed).toHaveBeenCalledTimes(2);
  });
});

describe('chunk order', () => {
  test('sortByChunk orders voxels by stacks of chunks (z, then x, each bottom-up), keeping their order within a chunk', () => {
    const chunks = [
      [1, 1, 1],
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
      [1, 2, 0],
    ];
    const positions: number[] = [];
    const ids: number[] = [];
    const seen = new Map<number, number>();
    for (let i = 0; i < 60; i++) {
      const c = chunks[(i * 7 + (i >> 2)) % chunks.length];
      const n = (seen.get(chunkKey(c[0], c[1], c[2])) ?? 0) + 1;
      seen.set(chunkKey(c[0], c[1], c[2]), n);
      positions.push(c[0] * 32 + ((i * 5) % 32), c[1] * 32 + ((i * 11) % 32), c[2] * 32 + ((i * 3) % 32));
      ids.push(n); // the n-th voxel of its chunk
    }
    const p = Int32Array.from(positions);
    const d = Uint8Array.from(ids);
    const sorted = sortByChunk(p, d, 60, 64);
    expect(sorted.ids.length).toBe(64);
    expect(sorted.positions.length).toBe(64 * 3);
    const list = VoxelList.wrap(sorted.positions, sorted.ids, 60);
    expect(voxelsOf(list)).toEqual(voxelsOf(VoxelList.wrap(p, d, 60)));
    const runs = chunkRuns(list);
    const order = runs.map((_, r) => {
      const i = runs.slice(0, r).reduce((a, b) => a + b, 0);
      return [list.positions[i * 3] >> 5, list.positions[i * 3 + 1] >> 5, list.positions[i * 3 + 2] >> 5];
    });
    expect(order).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 2, 0],
      [0, 0, 1],
      [1, 1, 1],
    ]);
    const keyOf = (i: number): number => chunkKeyAt(list.positions[i * 3], list.positions[i * 3 + 1], list.positions[i * 3 + 2]);
    for (let i = 1; i < 60; i++) if (keyOf(i) === keyOf(i - 1)) expect(list.ids[i]).toBe(list.ids[i - 1] + 1); // stable
    expect(Array.from(d)).toEqual(ids); // the input is left as it was
  });

  test('a write slice is whole chunk runs, added while it holds fewer voxels than the budget', () => {
    const list = new VoxelList();
    for (const [n, x] of [
      [5, 0],
      [3, 40],
      [4, 1],
      [6, 80],
    ]) {
      for (let i = 0; i < n; i++) list.push(x, i, 0, B.STONE); // 5 in chunk A, 3 in B, 4 in A again, 6 in C
    }
    expect(sliceEnd(list, 0, 6)).toBe(8);
    expect(sliceEnd(list, 0, 5)).toBe(5);
    expect(sliceEnd(list, 0, 1)).toBe(5); // at least one run
    expect(sliceEnd(list, 5, 3)).toBe(8);
    expect(sliceEnd(list, 5, 4)).toBe(12);
    expect(sliceEnd(list, 5, 100)).toBe(18);
    expect(sliceEnd(list, 18, 10)).toBe(18);
  });

  test('a detach job sends its falls in chunk order, planned in the order findDetached found them', () => {
    const removed = cutTree(world, 1055, 1000); // its trunk on the border of two chunk columns
    const data = new WorldData(world.toShared());
    const out = runDetach(data, removed.triples(), 400_000, 400_000, westOf(1055, 1000));
    const [found] = findDetached(data, removed.triples(), 400_000, 400_000);
    const [fall] = out.falls;
    expect(inChunkOrder(found)).toBe(false);
    expect(inChunkOrder(fall.piece)).toBe(true);
    expect(voxelsOf(fall.piece)).toEqual(voxelsOf(found));
    expect(fall.plan).toEqual(planFall(data, found, westOf(1055, 1000)));
    expect(fall.plan).not.toEqual(planFall(data, fall.piece, westOf(1055, 1000))); // its probes depend on the order
    expect(sortedKeys(fall.touched)).toEqual(sortedKeys(touchedChunks(found)));
  });

  test('a land job sends its cells in chunk order', () => {
    const worker = connect(world);
    const s = landingScene(500);
    s.pose.setRotation(0, 0, -1, (80 * Math.PI) / 180); // lying east across a chunk border: scanned rows cross it
    const [scan] = landInWorker(worker, s.grid, s.pose);
    const unsorted = new VoxelList();
    scanLanding(new WorldData(world.toShared()), s.grid, s.pose, unsorted);
    expect(inChunkOrder(unsorted)).toBe(false);
    expect(inChunkOrder(scan!.cells)).toBe(true);
    expect(voxelsOf(scan!.cells)).toEqual(voxelsOf(unsorted));
  });

  test('vacated in slices, a piece leaves the same world as vacated at once', () => {
    const [a, b] = [World.create(), World.create()];
    const removed = [a, b].map((w) => {
      plantTree(w, 1022, 1000);
      w.setBlock(1024, 120, 1000, B.OAK_LOG); // a branch stub with a plant on it
      w.setBlock(1024, 121, 1000, B.TALL_GRASS);
      return chop(w, 1022, 1000);
    });
    const piece = runDetach(new WorldData(a.toShared()), removed[0].triples(), 400_000, 400_000, westOf(1022, 1000)).falls[0].piece;
    const [found] = findDetached(new WorldData(b.toShared()), removed[1].triples(), 400_000, 400_000);
    const plantsA = new VoxelList();
    const plantsB = new VoxelList();
    let slices = 0;
    for (let i = 0; i < piece.count; slices++) {
      const end = sliceEnd(piece, i, 64);
      clearVoxels(a, piece, i, plantsA, end);
      i = end;
    }
    clearVoxels(b, found, 0, plantsB);
    expect(slices).toBeGreaterThanOrEqual(3);
    expect(plantsA.count).toBe(1);
    expect(voxelsOf(plantsA)).toEqual(voxelsOf(plantsB));
    expectSameBlocks(a, b, 1010, 95, 990, 1040, 150, 1010);
    expect(a.sky).toEqual(b.sky);
    expect(a.canopy).toEqual(b.canopy);
  });

  test('written in slices, a landing writes the same world as writeLanding at once', () => {
    const a = landingScene(600);
    const b = landingScene(700);
    const scanned = new VoxelList();
    scanLanding(world, a.grid, a.pose, scanned);
    const sorted = sortByChunk(scanned.positions, scanned.ids, scanned.count);
    const cells = VoxelList.wrap(sorted.positions, sorted.ids, scanned.count);
    let kept = 0;
    for (let i = 0; i < scanned.count; ) {
      const end = sliceEnd(cells, i, 8);
      kept = writeLandingCells(world, cells, i, end, kept);
      i = end;
    }
    cells.count = kept;
    const skeleton = a.grid.struct.length / 3;
    for (let j = 0; j < skeleton; j += 3) joinSkeleton(world, a.grid, a.pose, cells, undefined, j, Math.min(skeleton, j + 3));
    const reference = new VoxelList();
    expect(revoxelize(world, b.grid, b.pose, reference)).toBe(cells.count);
    expect(cells.count).toBeGreaterThan(kept); // joins included
    expect(cellsOf(cells, 100)).toEqual(cellsOf(reference));
    expectSameBlocks(world, world, 594, 95, 35, 632, 135, 75, 100);
  });
});

describe('world writes in slices', () => {
  test('a piece bigger than a slice is vacated a slice per frame, its meshes held until it is out of the world', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutBigTree(world, 200, 1150), westOf(200, 1150));
    worker.answer();
    const [fall] = detachSent(worker).falls;
    const { piece } = fall;
    expect(piece.count).toBeGreaterThan(2 * WRITE_SLICE_VOXELS);
    const longestRun = Math.max(...chunkRuns(piece));
    const setBlocks = vi.spyOn(world, 'setBlocks');
    let sizes: number[];
    let body: FallingBody;
    try {
      t.aftermath.update(t.game); // the frame that takes the answer: the body and its first slice…
      [body] = t.bodies();
      body.update(1 / 60, t.game); // …and the body's first update, in that frame too: no second one
      expect(setBlocks).toHaveBeenCalledTimes(1);
      expect(t.holds).toHaveLength(1);
      expect(sortedKeys(t.holds[0].keys)).toEqual(sortedKeys(fall.touched));
      expect(t.ctx.chunks.whenMeshed).not.toHaveBeenCalled();
      for (let frames = 1; t.holds[0].releases.length === 0; frames++) {
        expect(frames).toBeLessThan(10);
        t.flushMeshes(); // the world's meshes come in meanwhile: nothing calls back
        expect(drawn(body)).toBe(false);
        frame(t, body);
        expect(setBlocks).toHaveBeenCalledTimes(frames + 1); // a slice per frame
      }
      sizes = setBlocks.mock.calls.map(([, , end, start]) => end - (start ?? 0));
    } finally {
      setBlocks.mockRestore();
    }
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    for (const n of sizes) expect(n).toBeLessThan(WRITE_SLICE_VOXELS + longestRun);
    expect(sizes.reduce((sum, n) => sum + n, 0)).toBe(piece.count);
    const p = piece.positions;
    let left = 0;
    for (let i = 0; i < piece.count; i++) if (world.getBlock(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) !== B.AIR) left++;
    expect(left).toBe(0);
    // Released after the last slice: the body starts once the world's meshes are current, not before.
    expect(t.holds[0].releases).toHaveLength(1);
    expect(drawn(body)).toBe(false);
    t.flushMeshes();
    expect(drawn(body)).toBe(true);
    expect(t.ctx.chunks.whenMeshed).not.toHaveBeenCalled();
  });

  test('removals at a piece being vacated wait until it is out of the world: no second body', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutBigTree(world, 330, 1150), westOf(330, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    body.update(1 / 60, t.game);
    // After the first slice the top of its trunk is still in the world: it is cut through, and a small tree too.
    expect(world.getBlock(330, 165, 1150)).toBe(B.OAK_LOG);
    t.aftermath.settle(t.game, chop(world, 330, 1150, 165), westOf(330, 1150));
    t.aftermath.settle(t.game, cutTree(world, 800, 1000), westOf(800, 1000));
    expect(worker.pending('detach')).toBe(0);
    for (let i = 0; t.holds[0].releases.length === 0; i++) {
      expect(i).toBeLessThan(10);
      worker.answer();
      frame(t, body);
      expect(worker.pending('detach')).toBe(0);
      expect(t.bodies()).toHaveLength(1);
    }
    frame(t, body); // the first frame without a write in progress posts the batch
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    frame(t, body);
    expect(t.bodies()).toHaveLength(2); // the small tree only
    expect(world.getBlock(800, 120, 1000)).toBe(B.AIR);
  });

  test('removals at a piece being vacated wait until it is out of the world, without a worker too', () => {
    vi.stubGlobal('Worker', undefined);
    const w = World.create();
    try {
      const t = makeCtx(w);
      // Found here, the piece comes bottom-up (not in chunk order): a trunk 1.4 m thick is not out after one slice.
      for (let dz = -6; dz < 20; dz++) for (let dx = -6; dx < 90; dx++) w.setBlock(330 + dx, 99, 1150 + dz, B.DIRT);
      for (let y = 100; y < 170; y++) for (let dz = 0; dz < 14; dz++) for (let dx = 0; dx < 14; dx++) w.setBlock(330 + dx, y, 1150 + dz, B.OAK_LOG);
      t.aftermath.settle(t.game, chop(w, 330, 1150, 101, 14), westOf(330, 1150)); // analysed and applied at once
      const [body] = t.bodies();
      body.update(1 / 60, t.game);
      expect(t.holds).toHaveLength(1);
      expect(w.getBlock(330, 165, 1150)).toBe(B.OAK_LOG);
      t.aftermath.settle(t.game, chop(w, 330, 1150, 165), westOf(330, 1150));
      t.aftermath.settle(t.game, cutTree(w, 800, 1000), westOf(800, 1000));
      expect(t.bodies()).toHaveLength(1);
      for (let i = 0; t.holds[0].releases.length === 0; i++) {
        expect(i).toBeLessThan(10);
        frame(t, body);
        expect(t.bodies()).toHaveLength(1);
      }
      frame(t, body); // analysed now
      expect(t.bodies()).toHaveLength(2); // the small tree only
      expect(w.getBlock(800, 120, 1000)).toBe(B.AIR);
    } finally {
      vi.stubGlobal('Worker', FakeWorker);
    }
  });

  test('a stale answer taken while a landing is written in slices is asked again only once the write is done', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutBigTree(world, 460, 1150), westOf(460, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [big] = t.bodies();
    fallUntilLanding(t, big, worker); // vacated, drawn, fallen
    t.aftermath.settle(t.game, cutTree(world, 600, 1000), westOf(600, 1000));
    expect(worker.pending('detach')).toBe(1); // no write in progress: posted at once
    worker.answer(1); // the landing scan
    big.update(1 / 60, t.game); // its first slice
    expect(t.holds).toHaveLength(2);
    worker.answer(); // the detach job, which then goes stale
    world.setBlock(600, 144, 1000, B.OAK_LEAVES);
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(10);
      frame(t, big);
      expect(worker.pending('detach')).toBe(0);
      expect(t.bodies()).toHaveLength(1);
    }
    frame(t, big);
    expect(worker.pending('detach')).toBe(1); // asked again now
    worker.answer();
    frame(t, big);
    expect(t.bodies()).toHaveLength(2);
    expect(world.getBlock(600, 144, 1000)).toBe(B.AIR); // the new leaf fell with the crown
  });

  test('a fresh answer taken while a landing is written in slices is applied at once', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutBigTree(world, 1120, 500), westOf(1120, 500));
    worker.answer();
    t.aftermath.update(t.game);
    const [big] = t.bodies();
    fallUntilLanding(t, big, worker);
    t.aftermath.settle(t.game, cutTree(world, 900, 1000), westOf(900, 1000));
    worker.answer(1); // the landing scan
    big.update(1 / 60, t.game); // its first slice
    expect(t.holds).toHaveLength(2);
    expect(t.holds[1].releases).toHaveLength(0);
    worker.answer(); // the detach job: nothing it read is touched by the landing
    frame(t, big);
    expect(t.bodies()).toHaveLength(2);
    expect(world.getBlock(900, 120, 1000)).toBe(B.AIR);
    expect(t.holds[1].releases).toHaveLength(0); // still writing
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      big.update(1 / 60, t.game);
    }
  });

  test('a landing written in slices writes what writeLanding does at once, joins included, and waits for their chunks', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    // Cut from the north-west: it topples south-east, its skeleton tilted off both axes (joins). Its trunk is too thick
    // to be joined in one frame.
    const from = { x: 579, y: 100, z: 1143 };
    t.aftermath.settle(t.game, cutBigTree(world, 590, 1150, 6), from);
    worker.answer();
    const { grid } = detachSent(worker).falls[0].plan;
    expect(grid.struct.length / 3).toBeGreaterThan(JOIN_SLICE_VOXELS);
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    // The same world around the landing, and the same landing written there in one go.
    const ref = World.create();
    for (let cy = 2; cy <= 4; cy++) {
      for (let cz = 35; cz <= 39; cz++) {
        for (let cx = 17; cx <= 22; cx++) {
          const key = chunkKey(cx, cy, cz);
          const data = world.chunkArray(key);
          ref.loadChunk(key, data ?? world.chunkUniform(key));
        }
      }
    }
    const request = worker.inbox.find((m): m is LandRequest => m.type === 'land')!;
    const pose = new PiecePose();
    pose.m.set(request.m);
    [pose.rest.x, pose.rest.y, pose.rest.z] = request.rest;
    [pose.pivot.x, pose.pivot.y, pose.pivot.z] = request.pivot;
    const reference = runLand(new WorldData(ref.toShared()), request).cells;
    const scanned = writeLanding(ref, grid, pose, reference, 0);
    expect(scanned).toBeGreaterThan(2 * WRITE_SLICE_VOXELS);
    expect(reference.count).toBeGreaterThan(scanned); // with joins
    worker.answer();
    const sent = worker.replies.at(-1)!;
    if (sent.type !== 'land' || !sent.ok) throw new Error('no landing scan');
    const scan = VoxelList.wrap(sent.positions.slice(0, sent.count * 3), sent.ids.slice(0, sent.count), sent.count); // the body compacts its own
    let updates = 0;
    for (; t.holds.length < 2 || t.holds[1].releases.length === 0; updates++) {
      expect(updates).toBeLessThan(20);
      body.update(1 / 60, t.game);
    }
    // A slice of cells per update (the first in the one that takes the scan), then the joins, a range per update.
    let slices = 0;
    for (let i = 0; i < scan.count; i = sliceEnd(scan, i, WRITE_SLICE_VOXELS)) slices++;
    expect(updates).toBe(slices + Math.ceil(grid.struct.length / 3 / JOIN_SLICE_VOXELS));
    const box = [560, 80, 1125, 700, 140, 1240];
    let outside = 0;
    for (let i = 0; i < reference.count * 3; i++) if (reference.positions[i] < box[i % 3] || reference.positions[i] >= box[(i % 3) + 3]) outside++;
    expect(outside).toBe(0); // every cell written lies in the box compared
    expectSameBlocks(world, ref, box[0], box[1], box[2], box[3], box[4], box[5]);
    // Held: the scanned cells' chunks from the start, then every chunk a slice marked dirty — the joined cells' too.
    expect(sortedKeys(t.holds[1].keys)).toEqual(sortedKeys(sent.touched));
    const joined = touchedChunks(reference, new Set(), scanned);
    expect(joined.size).toBeGreaterThan(0);
    for (const key of joined) expect(t.holds[1].added.has(key)).toBe(true);
    t.flushMeshes();
    expect(body.removed).toBe(true);
  });

  test('each slice of a landing checks its cells against the world and the player as they are when it is written', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    // Cut from the north-west: it topples south-east, its trunk across chunk rows written in different slices.
    t.aftermath.settle(t.game, cutBigTree(world, 720, 1150), { x: 709, y: 100, z: 1143 });
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    worker.answer();
    const reply = worker.replies.at(-1)!;
    if (reply.type !== 'land' || !reply.ok) throw new Error('no landing scan');
    // A copy: the body compacts the list in place as it writes.
    const scan = VoxelList.wrap(reply.positions.slice(0, reply.count * 3), reply.ids.slice(0, reply.count), reply.count);
    const first = sliceEnd(scan, 0, WRITE_SLICE_VOXELS);
    const at = (i: number): [number, number, number] => [scan.positions[i * 3], scan.positions[i * 3 + 1], scan.positions[i * 3 + 2]];
    let log = scan.count - 1; // the trunk's last cell: a later slice's
    while (scan.ids[log] !== B.OAK_LOG) log--;
    expect(log).toBeGreaterThanOrEqual(first);
    const [lx, ly, lz] = at(log);
    const inBox = (x: number, y: number, z: number): boolean => x >= lx - 3 && x <= lx + 3 && y >= ly && y < ly + 18 && z >= lz - 3 && z <= lz + 3;
    const leaf = Array.from({ length: scan.count - first }, (_, k) => first + k).find((i) => scan.ids[i] === B.OAK_LEAVES && !inBox(...at(i)))!;
    body.update(1 / 60, t.game); // the first slice, the player far away
    expect(t.holds).toHaveLength(2);
    t.ctx.player.position.set(lx + 0.5, ly, lz + 0.5); // then the player walks in where a later slice lands…
    world.setBlock(...at(leaf), B.BRICK); // …and a brick is put where another one does
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      body.update(1 / 60, t.game);
    }
    expect(world.getBlock(...at(leaf))).toBe(B.BRICK);
    let vetoed = 0;
    for (let i = first; i < scan.count; i++) {
      const [x, y, z] = at(i);
      if (SOLID[scan.ids[i]] !== 1 || !inBox(x, y, z)) continue;
      vetoed++;
      expect(world.getBlock(x, y, z)).toBe(B.AIR);
    }
    expect(vetoed).toBeGreaterThan(5);
    t.ctx.player.position.set(10, 100, 10);
  });

  test('a landing written in slices that ends up writing nothing finishes at once', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutBigTree(world, 1120, 350), westOf(1120, 350));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    worker.answer();
    const reply = worker.replies.at(-1)!;
    if (reply.type !== 'land' || !reply.ok) throw new Error('no landing scan');
    // Before anything is written, stone fills the scanned cells and the cells around them (where joins could go).
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < reply.count * 3; i++) {
      lo[i % 3] = Math.min(lo[i % 3], reply.positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], reply.positions[i]);
    }
    for (let y = lo[1] - 1; y <= hi[1] + 1; y++) {
      for (let z = lo[2] - 1; z <= hi[2] + 1; z++) for (let x = lo[0] - 1; x <= hi[0] + 1; x++) world.setBlock(x, y, z, B.STONE);
    }
    for (let i = 0; !body.removed; i++) {
      expect(i).toBeLessThan(20);
      body.update(1 / 60, t.game);
    }
    expect(t.holds).toHaveLength(2);
    expect(t.holds[1].releases).toHaveLength(1); // let go
    expect(t.ctx.chunks.whenMeshed).not.toHaveBeenCalled();
  });

  test('a body removed in the middle of a write in slices ends the write guard and lets go of the meshes', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    t.aftermath.settle(t.game, cutBigTree(world, 850, 1150), westOf(850, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    body.update(1 / 60, t.game);
    t.aftermath.settle(t.game, cutTree(world, 1000, 1150), westOf(1000, 1150));
    expect(worker.pending('detach')).toBe(0); // waits for the write
    body.onRemove(); // as EntityManager does after an update threw
    expect(t.holds[0].releases).toHaveLength(1);
    t.flushMeshes();
    expect(drawn(body)).toBe(false); // let go, not started
    t.aftermath.update(t.game);
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
  });

  test('a write in slices holds the meshes of every chunk it marks dirty, the ground whose shade it changes too', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 330, 1150), westOf(330, 1150));
    worker.answer();
    w.flush();
    const dirty = new Set<number>();
    w.onChange((keys) => keys.forEach((key) => dirty.add(key))); // what the chunk renderer re-meshes
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    const { piece } = detachSent(worker).falls[0];
    body.update(1 / 60, t.game);
    w.flush();
    for (let i = 0; t.holds[0].releases.length === 0; i++) {
      expect(i).toBeLessThan(10);
      frame(t, body);
      w.flush();
    }
    // The crown's canopy shade is gone from the ground below it: chunks that hold none of the piece are dirty too.
    const touched = touchedChunks(piece);
    expect([...dirty].filter((key) => !touched.has(key)).length).toBeGreaterThan(0);
    const vacated = new Set([...t.holds[0].keys, ...t.holds[0].added]);
    expect([...dirty].filter((key) => !vacated.has(key))).toEqual([]);
    // Its landing likewise: the crown lying on the ground shades it now.
    t.flushMeshes();
    fallUntilLanding(t, body, worker);
    worker.answer();
    dirty.clear();
    for (let i = 0; t.holds.length < 2 || t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      body.update(1 / 60, t.game);
      w.flush();
    }
    expect(dirty.size).toBeGreaterThan(0);
    const landed = new Set([...t.holds[1].keys, ...t.holds[1].added]);
    expect([...dirty].filter((key) => !landed.has(key))).toEqual([]);
  });

  test('a piece vacated at once waits for the meshes of every chunk it marks dirty, the ground under its crown too', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    // Its crown's west edge at x = 224, the first column of a chunk: the ground across, in the chunk before, loses its
    // shade but holds none of the tree.
    t.aftermath.settle(t.game, cutTree(w, 228, 1000), westOf(228, 1000));
    worker.answer();
    w.flush();
    const dirty = new Set<number>();
    w.onChange((keys) => keys.forEach((key) => dirty.add(key)));
    t.aftermath.update(t.game);
    w.flush();
    expect(t.bodies()).toHaveLength(1);
    expect(t.holds).toHaveLength(0);
    expect(dirty.has(chunkKey(6, 3, 31))).toBe(true);
    expect(touchedChunks(detachSent(worker).falls[0].piece).has(chunkKey(6, 3, 31))).toBe(false);
    const waited = new Set(t.ctx.chunks.whenMeshed.mock.calls[0][0]);
    expect([...dirty].filter((key) => !waited.has(key))).toEqual([]);
  });

  test('the part of a piece not vacated yet is not there for the player: the crosshair passes it, no brush takes it', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 330, 1150), westOf(330, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    body.update(1 / 60, t.game);
    // After the first slice the top of the trunk is still in the world, and the crown around it; its foot is not.
    const felling = fellingFor(w);
    expect(w.getBlock(330, 165, 1150)).toBe(B.OAK_LOG);
    expect(w.getBlock(320, 165, 1150)).toBe(B.OAK_LEAVES);
    expect(felling.owned(330, 165, 1150)).toBe(true);
    expect(felling.owned(320, 165, 1150)).toBe(true);
    expect(w.getBlock(330, 120, 1150)).toBe(B.AIR);
    expect(felling.owned(330, 100, 1150)).toBe(false); // the stump
    expect(felling.owned(330, 99, 1150)).toBe(false); // the ground
    // Aimed at it from outside the crown, the crosshair passes leaves and trunk and stops at a post behind them…
    w.setBlock(350, 165, 1150, B.STONE);
    const view = {
      world: w,
      player: { eye: new THREE.Vector3(316.5, 165.5, 1150.5), getLookDir: (out: THREE.Vector3) => out.set(1, 0, 0) },
      entities: { raycast: () => null },
    } as unknown as GameContext;
    expect(new TargetPicker().pick(view)).toMatchObject({ kind: 'block', hit: { x: 350, y: 165, z: 1150, id: B.STONE } });
    // …and a brush swung at it takes none of it: dug now, it would come back with the landing, twice.
    const removed = new VoxelList();
    collectBrush(w, 330, 165, 1150, 1.6, removed, felling.owned);
    expect(removed.count).toBe(0);
    for (let i = 0; t.holds[0].releases.length === 0; i++) {
      expect(i).toBeLessThan(10);
      frame(t, body);
    }
    expect(w.getBlock(330, 165, 1150)).toBe(B.AIR);
    expect(felling.owned(350, 165, 1150)).toBe(false);
  });

  test('landing cells written but not joined yet are not there for the player either; the write done, they are', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 460, 1150), westOf(460, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    fallUntilLanding(t, body, worker);
    worker.answer();
    const reply = worker.replies.at(-1)!;
    if (reply.type !== 'land' || !reply.ok) throw new Error('no landing scan');
    const scan = VoxelList.wrap(reply.positions.slice(0, reply.count * 3), reply.ids.slice(0, reply.count), reply.count);
    body.update(1 / 60, t.game); // the first slice
    expect(t.holds).toHaveLength(2);
    const at = (i: number): [number, number, number] => [scan.positions[i * 3], scan.positions[i * 3 + 1], scan.positions[i * 3 + 2]];
    const logs = Array.from({ length: sliceEnd(scan, 0, WRITE_SLICE_VOXELS) }, (_, i) => i).filter((i) => w.getBlock(...at(i)) === B.OAK_LOG);
    expect(logs.length).toBeGreaterThan(10);
    const felling = fellingFor(w);
    expect(logs.filter((i) => !felling.owned(...at(i)))).toEqual([]);
    // Dug before the skeleton's joins, a trunk voxel would be written again by them.
    const removed = new VoxelList();
    collectBrush(w, ...at(logs[0]), 1.6, removed, felling.owned);
    expect(removed.count).toBe(0);
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      body.update(1 / 60, t.game);
    }
    expect(logs.filter((i) => felling.owned(...at(i)))).toEqual([]);
  });

  test('the batch queued behind a job whose answer begins a write in slices waits for the write', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 330, 1150), westOf(330, 1150));
    t.aftermath.settle(t.game, cutTree(w, 800, 1000), westOf(800, 1000)); // queued behind the job in flight
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    t.aftermath.update(t.game); // fresh: applied, and the big tree's vacate begins
    const [body] = t.bodies();
    body.update(1 / 60, t.game);
    expect(t.holds).toHaveLength(1);
    for (let i = 0; t.holds[0].releases.length === 0; i++) {
      expect(i).toBeLessThan(10);
      expect(worker.pending('detach')).toBe(0);
      frame(t, body);
    }
    frame(t, body);
    expect(worker.pending('detach')).toBe(1); // posted by the first frame without a write in progress
    worker.answer();
    frame(t, body);
    expect(t.bodies()).toHaveLength(2);
  });

  test('an error answer taken while a landing is written in slices: the batch is asked again only once the write is done', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 460, 1150), westOf(460, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [big] = t.bodies();
    fallUntilLanding(t, big, worker);
    t.aftermath.settle(t.game, cutTree(w, 600, 1000), westOf(600, 1000)); // posted behind the land job
    worker.answer(1); // the landing scan
    big.update(1 / 60, t.game); // its first slice
    expect(t.holds).toHaveLength(2);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.fail(); // the detach job threw
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      frame(t, big);
      expect(worker.pending('detach') + worker.pending('mesh')).toBe(0); // not analysed here meanwhile
      expect(t.bodies()).toHaveLength(1);
    }
    error.mockRestore();
    frame(t, big);
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    frame(t, big);
    expect(t.bodies()).toHaveLength(2);
  });

  test('a third stale answer in a row taken while a landing is written in slices is analysed only once the write is done', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 460, 1150), westOf(460, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [big] = t.bodies();
    for (let i = 0; i < 10 && !drawn(big); i++) {
      big.update(1 / 60, t.game);
      t.flushMeshes();
    }
    expect(drawn(big)).toBe(true); // vacated, falling
    t.aftermath.settle(t.game, cutTree(w, 600, 1000), westOf(600, 1000));
    for (let k = 0; k < 2; k++) {
      w.setBlock(600 + k, 144, 1000, B.OAK_LEAVES); // on its crown, while the worker runs the job: stale
      worker.answer(1);
      t.aftermath.update(t.game);
      expect(worker.pending('detach')).toBe(1); // asked again
    }
    fallUntilLanding(t, big, worker);
    w.setBlock(602, 144, 1000, B.OAK_LEAVES); // the third answer goes stale too…
    worker.answer(); // the detach job, then the landing scan
    big.update(1 / 60, t.game); // …and comes in while the landing is written in slices
    expect(t.holds).toHaveLength(2);
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      frame(t, big);
      expect(worker.pending('detach') + worker.pending('mesh')).toBe(0); // neither asked again nor analysed here
      expect(t.bodies()).toHaveLength(1);
    }
    frame(t, big);
    expect(worker.pending('detach')).toBe(1); // asked again once the write is done
    worker.answer();
    frame(t, big);
    expect(t.bodies()).toHaveLength(2);
    expect(w.getBlock(602, 144, 1000)).toBe(B.AIR); // the last leaf fell with the crown
  });

  test('a mesh answer gone stale while a landing is written in slices is analysed again only once the write is done', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 460, 1150), westOf(460, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [big] = t.bodies();
    for (let i = 0; i < 10 && !drawn(big); i++) {
      big.update(1 / 60, t.game);
      t.flushMeshes();
    }
    // While it falls, a small tree's detach job fails: analysed here, its fall goes to the worker to be meshed.
    t.aftermath.settle(t.game, cutTree(w, 600, 1000), westOf(600, 1000));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    worker.answer(0);
    worker.fail();
    t.aftermath.update(t.game);
    error.mockRestore();
    expect(worker.pending('mesh')).toBe(1);
    fallUntilLanding(t, big, worker);
    worker.answer(); // the mesh job, then the landing scan
    big.update(1 / 60, t.game); // its first slice
    expect(t.holds).toHaveLength(2);
    w.setBlock(600, 144, 1000, B.OAK_LEAVES); // in the analysis' read box: the mesh answer is stale
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      frame(t, big);
      expect(worker.pending('detach')).toBe(0);
      expect(t.bodies()).toHaveLength(1);
    }
    frame(t, big);
    expect(worker.pending('detach')).toBe(1);
    worker.answer();
    frame(t, big);
    expect(t.bodies()).toHaveLength(2);
    expect(w.getBlock(600, 144, 1000)).toBe(B.AIR);
  });

  test('a worker that dies while a landing is written in slices: the batch in flight runs here once the write is done', () => {
    const w = World.create();
    const t = makeCtx(w);
    const worker = connect(w);
    t.aftermath.settle(t.game, cutBigTree(w, 460, 1150), westOf(460, 1150));
    worker.answer();
    t.aftermath.update(t.game);
    const [big] = t.bodies();
    fallUntilLanding(t, big, worker);
    t.aftermath.settle(t.game, cutTree(w, 600, 1000), westOf(600, 1000)); // posted behind the land job
    worker.answer(1); // the landing scan
    big.update(1 / 60, t.game); // its first slice
    expect(t.holds).toHaveLength(2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    worker.crash();
    for (let i = 0; t.holds[1].releases.length === 0; i++) {
      expect(i).toBeLessThan(20);
      frame(t, big);
      expect(t.bodies()).toHaveLength(1);
    }
    frame(t, big);
    expect(t.bodies()).toHaveLength(2); // no worker left: analysed and applied here
    expect(w.getBlock(600, 120, 1000)).toBe(B.AIR);
    warn.mockRestore();
  });
});

describe('stall guard', () => {
  // Gives up the shared world's worker: keep this last.
  test('a job unanswered for 600 updates: the worker is given up, the batch runs here, a landing waiting behind it too', () => {
    const t = makeCtx(world);
    const worker = connect(world);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.aftermath.settle(t.game, cutTree(world, 800, 400), westOf(800, 400));
    worker.answer();
    t.aftermath.update(t.game);
    const [body] = t.bodies();
    t.aftermath.settle(t.game, cutTree(world, 600, 400), westOf(600, 400)); // the worker hangs on this one…
    fallUntilLanding(t, body, worker); // …and the landing scan waits behind it
    for (let i = 0; i < 600; i++) t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(1);
    const landed = (): number => countBlocks(world, B.OAK_LOG, 795, 99, 395, 850, 112, 407);
    const before = landed();
    t.aftermath.update(t.game);
    expect(t.bodies()).toHaveLength(2);
    expect(world.getBlock(600, 120, 400)).toBe(B.AIR);
    expect(worker.terminated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    body.update(1 / 60, t.game); // no answer can come: revoxelized now
    expect(landed()).toBeGreaterThan(before + 60);
    worker.answer(); // late answers are ignored
    t.aftermath.update(t.game);
    body.update(1 / 60, t.game);
    expect(t.bodies()).toHaveLength(2);
    expect(t.ctx.chunks.whenMeshed).toHaveBeenCalledTimes(3); // vacated twice, landed once
    warn.mockRestore();
  });
});
