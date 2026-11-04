import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { CHUNKS_X, CHUNKS_Y, CHUNKS_Z, CHUNK_BITS, RENDER, WORLD_X, WORLD_Y, WORLD_Z } from '../src/config';
import { ChunkRenderer, type CutNodeInfo, type MeshWorkerLike } from '../src/render/voxel/chunkRenderer';
import { LodNode, LodTree, ROOT_LEVEL, nodeIsEmpty } from '../src/render/voxel/lod';
import { getVoxelMaterials } from '../src/render/voxel/materials';
import { buildNodeMesh } from '../src/render/voxel/nodeMesh';
import {
  MeshJobRunner,
  handleMeshMessage,
  type MeshJob,
  type MeshJobSuccess,
  type MeshWorkerRequest,
  type MeshWorkerResponse,
} from '../src/render/voxel/meshJob';
import { B } from '../src/world/blocks';
import { World, chunkKey, chunkKeyAt } from '../src/world/world';

vi.mock('../src/render/voxel/plantAtlas', async () => {
  const three = await import('three');
  return {
    PLANT_ATLAS_TILE_W: 64,
    PLANT_ATLAS_TILE_H: 256,
    createPlantAtlas: () => new three.DataTexture(new Uint8Array(4), 1, 1),
  };
});

/** Mesh worker double: runs the real job code, but only when the test says so. */
class FakeWorker implements MeshWorkerLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  readonly jobs: MeshJob[] = [];
  private readonly runner = new MeshJobRunner();

  /** `history` and `answers` are shared by the pool, in global order. */
  constructor(
    private readonly history: MeshJob[],
    private readonly answers: MeshWorkerResponse[],
  ) {}

  postMessage(message: unknown): void {
    const msg = message as MeshWorkerRequest;
    if (msg.type === 'job') {
      this.jobs.push(msg);
      this.history.push(msg);
    } else {
      handleMeshMessage(this.runner, msg, () => {});
    }
  }

  terminate(): void {}

  /** Answers the oldest pending job accepted by `which`; returns false if there was none. */
  answer(which: (job: MeshJob) => boolean = () => true): boolean {
    const i = this.jobs.findIndex(which);
    if (i < 0) return false;
    const [job] = this.jobs.splice(i, 1);
    handleMeshMessage(this.runner, job, (response) => {
      this.answers.push(response);
      this.onmessage?.(new MessageEvent('message', { data: response }));
    });
    return true;
  }
}

class FakePool {
  readonly workers: FakeWorker[] = [];
  private readonly log: MeshJob[] = [];
  private readonly results: MeshWorkerResponse[] = [];
  readonly create = (): MeshWorkerLike => {
    const w = new FakeWorker(this.log, this.results);
    this.workers.push(w);
    return w;
  };

  get pending(): number {
    return this.workers.reduce((n, w) => n + w.jobs.length, 0);
  }

  answerOne(which?: (job: MeshJob) => boolean): boolean {
    return this.workers.some((w) => w.answer(which));
  }

  answerAll(): number {
    let n = 0;
    while (this.answerOne()) n++;
    return n;
  }

  /** Every job posted so far, in order. */
  history(): MeshJob[] {
    return this.log;
  }

  /** Every answer so far, in order. */
  answers(): MeshWorkerResponse[] {
    return this.results;
  }
}

/**
 * Runs frames, answering every job, until nothing is left to do: no job was posted and the cut did not
 * change (splits and merges deferred by the upload budget dispatch no jobs).
 */
function settle(chunks: ChunkRenderer, pool: FakePool, cam: THREE.PerspectiveCamera): void {
  let last = '';
  for (let frame = 0; frame < 200; frame++) {
    chunks.update(cam, 1 / 60);
    const answered = pool.answerAll();
    const cut = JSON.stringify(chunks.debugCut());
    if (answered === 0 && cut === last) return;
    last = cut;
  }
  throw new Error('renderer did not settle');
}

/** Ground: uniform stone chunks under a 128 × 128 voxel area, a bumpy grass top, a small tower. */
function makeWorld(): World {
  const w = World.create();
  for (let cz = 16; cz < 20; cz++) for (let cx = 16; cx < 20; cx++) for (let cy = 0; cy < 3; cy++) w.loadChunk(chunkKey(cx, cy, cz), B.STONE);
  for (let z = 512; z < 640; z++) for (let x = 512; x < 640; x++) if ((x * 7 + z * 3) % 5 === 0) w.setBlock(x, 96, z, B.GRASS);
  for (let y = 96; y < 140; y++) for (let z = 570; z < 574; z++) for (let x = 570; x < 574; x++) w.setBlock(x, y, z, B.BRICK);
  w.flush(); // generation-time edits are not reported
  return w;
}

function camera(x: number, y: number, z: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(75, 1.6, 0.5, 4000);
  c.position.set(x, y, z);
  c.updateMatrixWorld();
  return c;
}

/** The cut covers every chunk of the world exactly once and nothing is missing a mesh. */
function expectHoleFreeCut(cut: CutNodeInfo[]): void {
  const covered = new Uint8Array(CHUNKS_X * CHUNKS_Y * CHUNKS_Z);
  for (const n of cut) {
    expect(n.shows).not.toBe('none');
    const c0 = [n.x >> CHUNK_BITS, n.y >> CHUNK_BITS, n.z >> CHUNK_BITS];
    const span = n.size >> CHUNK_BITS;
    for (let cy = c0[1]; cy < c0[1] + span; cy++)
      for (let cz = c0[2]; cz < c0[2] + span; cz++) for (let cx = c0[0]; cx < c0[0] + span; cx++) covered[chunkKey(cx, cy, cz)]++;
  }
  expect(covered.every((c) => c === 1)).toBe(true);
}

/** The clock is frozen unless a test drives it: debounces and timeouts never depend on machine speed. */
function setup(cam = { x: 100, y: 300, z: 100 }, now: () => number = () => 0, workers = 2) {
  const world = makeWorld();
  const scene = new THREE.Scene();
  const pool = new FakePool();
  const chunks = new ChunkRenderer(scene, world, { createWorker: pool.create, workers, now });
  return { world, scene, pool, chunks, cam };
}

async function prewarmed(at: { x: number; y: number; z: number }, now?: () => number, workers?: number) {
  const s = setup(at, now, workers);
  const done = s.chunks.prewarm({ x: at.x, y: at.y - 16.5, z: at.z });
  s.pool.answerAll();
  await done;
  return s;
}

describe('octree', () => {
  test('5×2×5 level-2 roots, children tile their parents', () => {
    const tree = new LodTree((l, x, y, z) => new LodNode(l, x, y, z));
    expect(tree.roots.length).toBe(50);
    expect(tree.nodes.length).toBe(50 + 400 + 3200);
    for (const n of tree.nodes) {
      if (n.level === 0) {
        expect(n.children.length).toBe(0);
        continue;
      }
      expect(n.children.length).toBe(8);
      for (const c of n.children) {
        expect(c.parent).toBe(n);
        expect(c.size * 2).toBe(n.size);
        expect(n.contains(c.x0, c.y0, c.z0)).toBe(true);
      }
    }
    expect(tree.nodeAt(0, 640, 100, 70)!.x0).toBe(640);
    expect(tree.nodeAt(ROOT_LEVEL, WORLD_X, 0, 0)).toBeNull();
  });

  test('the desired cut covers the world exactly once and follows the split distances', () => {
    const tree = new LodTree((l, x, y, z) => new LodNode(l, x, y, z));
    for (const p of [
      [640, 130, 640],
      [5, 500, 1270],
      [-300, 50, 2000],
    ]) {
      const cut = tree.desiredCut(p[0], p[1], p[2]);
      let volume = 0;
      for (const n of cut) {
        volume += n.size ** 3;
        if (n.level > 0) expect(n.distanceTo(p[0], p[1], p[2])).toBeGreaterThanOrEqual(RENDER.lodSplitDist[n.level - 1]);
        if (n.parent) expect(n.parent.distanceTo(p[0], p[1], p[2])).toBeLessThan(RENDER.lodSplitDist[n.parent.level - 1]);
      }
      expect(volume).toBe(WORLD_X * WORLD_Y * WORLD_Z);
    }
  });

  test('chunk → nodes mapping includes padded neighbours at every level', () => {
    const tree = new LodTree((l, x, y, z) => new LodNode(l, x, y, z));
    const hits: [number, number, number, number, boolean][] = [];
    // Chunk (20, 2, 18): x 640..671 is the first chunk of level-0 node x 640 → also the −x neighbour's padding.
    tree.forEachNodeTouchingChunk(20, 2, 18, (n, inside) => hits.push([n.level, n.x0, n.y0, n.z0, inside]));
    const l0 = hits.filter((h) => h[0] === 0);
    expect(l0.filter((h) => h[4]).map((h) => [h[1], h[2], h[3]])).toEqual([[640, 64, 576]]);
    expect(l0.some((h) => h[1] === 576 && h[2] === 64 && h[3] === 576 && !h[4])).toBe(true);
    expect(hits.filter((h) => h[4]).length).toBe(3); // one containing node per level
  });

  test('empty nodes: uniform air, or uniform opaque incl. padding', () => {
    const w = World.create();
    const tree = new LodTree((l, x, y, z) => new LodNode(l, x, y, z));
    expect(nodeIsEmpty(w, tree.nodeAt(0, 300, 300, 300)!)).toBe(true);
    for (let cy = 0; cy < 4; cy++) for (let cz = 0; cz < 6; cz++) for (let cx = 0; cx < 6; cx++) w.loadChunk(chunkKey(cx, cy, cz), B.STONE);
    expect(nodeIsEmpty(w, tree.nodeAt(0, 64, 0, 64)!)).toBe(true); // stone with stone padding (bedrock below)
    expect(nodeIsEmpty(w, tree.nodeAt(0, 64, 64, 64)!)).toBe(false); // padding reaches the air above
    w.setBlock(70, 10, 70, B.DIRT);
    expect(nodeIsEmpty(w, tree.nodeAt(0, 64, 0, 64)!)).toBe(false);
  });
});

describe('ChunkRenderer', () => {
  test('prewarm resolves with a complete, hole-free cut and puts its meshes in the scene', async () => {
    const at = { x: 576, y: 112, z: 576 };
    const { chunks, scene, pool } = await prewarmed(at);
    expect(pool.pending).toBe(0);
    const cut = chunks.debugCut();
    expectHoleFreeCut(cut);
    expect(cut.some((n) => n.level === 0 && n.shows === 'mesh')).toBe(true);
    const stats = chunks.stats();
    expect(stats.visibleNodes).toBe(cut.filter((n) => n.shows === 'mesh').length);
    expect(stats.triangles).toBeGreaterThan(0);
    const root = scene.getObjectByName('voxel-world')!;
    expect(root.children.filter((c) => c.visible).length).toBe(stats.visibleNodes);
    // The first frame draws new meshes unculled (upload in the budgeted frame), then culling returns.
    const mesh = root.children.find((c) => c.visible)!.children[0];
    expect(mesh.frustumCulled).toBe(false);
    chunks.update(camera(at.x, at.y, at.z), 1 / 60);
    expect(mesh.frustumCulled).toBe(true);
  });

  test('only opaque level-0 meshes cast shadows; opaque meshes and plants receive them', async () => {
    const { scene } = await prewarmed({ x: 576, y: 112, z: 576 });
    const root = scene.getObjectByName('voxel-world')!;
    const meshes = root.children.filter((g) => g.visible).flatMap((g) => g.children) as THREE.Mesh[];
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      const level = Number(m.parent!.name.slice(-1));
      const name = (m.material as THREE.Material).name;
      const opaque = name === 'voxel-opaque';
      expect(m.castShadow).toBe(opaque && level === 0);
      expect(m.receiveShadow).toBe(opaque || name === 'voxel-plants');
      expect(m.geometry.boundingSphere).not.toBeNull();
    }
    // The test world has no plants: build a one-plant node directly.
    const plants = { plantPos: new Int16Array(16), plantData: new Uint8Array(16), plantQuads: 1 };
    const empty = { opaque: null, opaqueQuads: 0, glass: null, glassQuads: 0, water: null, waterQuads: 0, cavities: null };
    const plant = buildNodeMesh({ ...empty, ...plants }, 0, 0, 0, 0, getVoxelMaterials())!.group.children[0] as THREE.Mesh;
    expect((plant.material as THREE.Material).name).toBe('voxel-plants');
    expect(plant.castShadow).toBe(false);
    expect(plant.receiveShadow).toBe(true);
  });

  test('ready-gating: a parent stays until all 8 children have meshes, never a hole', async () => {
    const far = { x: 120, y: 300, z: 120 };
    const { chunks, pool } = await prewarmed(far);
    expectHoleFreeCut(chunks.debugCut());
    const near = camera(576, 112, 576);
    const levelAt = () => chunks.debugCut().find((n) => n.x <= 576 && n.x + n.size > 576 && n.y <= 112 && n.y + n.size > 112 && n.z <= 576 && n.z + n.size > 576)!.level;
    expect(levelAt()).toBe(2);
    let sawPartial = false;
    for (let frame = 0; frame < 400; frame++) {
      chunks.update(near, 1 / 60);
      expectHoleFreeCut(chunks.debugCut());
      if (pool.pending > 0 && levelAt() > 0) sawPartial = true;
      if (!pool.answerOne() && levelAt() === 0) break;
    }
    expect(sawPartial).toBe(true);
    expect(levelAt()).toBe(0);
    // Back far away: children merge into current parents again (hysteresis margin passed).
    for (let frame = 0; frame < 50; frame++) {
      chunks.update(camera(far.x, far.y, far.z), 1 / 60);
      pool.answerAll();
      expectHoleFreeCut(chunks.debugCut());
    }
    expect(levelAt()).toBe(2);
  });

  test('edits re-mesh nodes whose padding holds the chunk; unchanged inputs skip meshing', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at);
    const cam = camera(at.x, at.y, at.z);
    settle(chunks, pool, cam);
    const jobFor = (j: MeshJob, x: number, y: number, z: number) => j.level === 0 && j.ox === x && j.oy === y && j.oz === z;
    // Voxel (640, 97, 600): first voxel of the node at x 640, padding layer of the node at x 576.
    let seen = pool.history().length;
    world.setBlock(640, 97, 600, B.PLANKS);
    world.flush();
    settle(chunks, pool, cam);
    let jobs = pool.history().slice(seen);
    expect(jobs.some((j) => jobFor(j, 640, 64, 576))).toBe(true);
    expect(jobs.some((j) => jobFor(j, 576, 64, 576))).toBe(true);
    // Voxel (650, 97, 600) lies in a chunk touching that padding, but not in the padding layer itself.
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    seen = pool.history().length;
    const answered = pool.answers().length;
    world.setBlock(650, 97, 600, B.PLANKS);
    world.flush();
    settle(chunks, pool, cam);
    jobs = pool.history().slice(seen);
    expect(jobs.some((j) => jobFor(j, 576, 64, 576))).toBe(true);
    expect(pool.answers().slice(answered).some((a) => a.ok && a.unchanged)).toBe(true);
    // Only the edited node got a new group; the node at x 576 kept its mesh.
    expect(root.children.filter((g) => !groupsBefore.has(g)).length).toBe(1);
    expectHoleFreeCut(chunks.debugCut());
    expect(chunks.debugCut().every((n) => n.current)).toBe(true);
  });

  test('hidden ancestors dirtied by edits re-mesh lazily, one at a time, never blocking level 0', async () => {
    let t = 0;
    const farAt = { x: 120, y: 300, z: 120 };
    const { chunks, world, pool } = await prewarmed(farAt, () => t);
    const near = camera(600, 112, 600);
    settle(chunks, pool, near); // splits down to level 0 here; the root and level-1 parents keep hidden meshes
    const ancestors = [
      [2, 512, 0, 512],
      [1, 512, 0, 512],
      [1, 512, 128, 512], // its 2-voxel padding reaches down into the edited chunk
    ];
    const isAncestor = (j: MeshJob) => ancestors.some(([l, x, y, z]) => j.level === l && j.ox === x && j.oy === y && j.oz === z);
    let seen = pool.history().length;
    world.setBlock(600, 97, 600, B.PLANKS);
    world.flush();
    settle(chunks, pool, near);
    // Level 0 re-meshes at once; the ancestors wait for the debounce.
    expect(pool.history().slice(seen).every((j) => j.level === 0)).toBe(true);

    t += 1600;
    chunks.update(near, 1 / 60);
    expect(pool.pending).toBe(1); // one lazy job; the other worker stays free
    expect(isAncestor(pool.history().at(-1)!)).toBe(true);
    world.setBlock(601, 97, 600, B.PLANKS);
    world.flush();
    chunks.update(near, 1 / 60);
    expect(pool.pending).toBe(2);
    expect(pool.history().at(-1)!).toMatchObject({ level: 0, ox: 576, oy: 64, oz: 576 });

    // That edit restarted the debounce; afterwards each ancestor is re-meshed once, one at a time.
    settle(chunks, pool, near);
    t += 1600;
    seen = pool.history().length;
    for (let frame = 0; frame < 20; frame++) {
      chunks.update(near, 1 / 60);
      expect(pool.pending).toBeLessThanOrEqual(1);
      if (!pool.answerOne()) break;
    }
    const lazy = pool.history().slice(seen);
    expect(lazy.length).toBe(3);
    expect(lazy.every(isAncestor)).toBe(true);

    // Walking away merges back into the refreshed ancestors without waiting for their jobs.
    seen = pool.history().length;
    const far = camera(farAt.x, farAt.y, farAt.z);
    for (let frame = 0; frame < 5; frame++) chunks.update(far, 1 / 60);
    expect(pool.history().slice(seen).some(isAncestor)).toBe(false);
    expect(chunks.debugCut().find((n) => n.level === 2 && n.x === 512 && n.y === 0 && n.z === 512)).toMatchObject({ shows: 'mesh', current: true });
    expectHoleFreeCut(chunks.debugCut());
  });

  test('a camera inside a culled sealed pocket re-meshes its node with the camera as an open seed', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool } = await prewarmed(at);
    const outside = camera(at.x, at.y, at.z);
    // A hollow foliage blob (passable, so the camera can get inside) in level-0 node (576, 64, 576).
    for (let y = 100; y < 110; y++) for (let z = 620; z < 630; z++) for (let x = 590; x < 600; x++) world.setBlock(x, y, z, B.OAK_LEAVES);
    for (let y = 103; y < 107; y++) for (let z = 623; z < 627; z++) for (let x = 593; x < 597; x++) world.setBlock(x, y, z, B.AIR);
    world.flush();
    settle(chunks, pool, outside);
    const isNode = (j: MeshJob) => j.level === 0 && j.ox === 576 && j.oy === 64 && j.oz === 576;
    const answerTo = (j: MeshJob): MeshJobSuccess => {
      const a = pool.answers().find((r) => r.id === j.id)!;
      if (!a.ok) throw new Error(a.error);
      return a;
    };
    const before = answerTo(pool.history().filter(isNode).at(-1)!).mesh!;
    expect(before.cavities).toEqual(new Int16Array([17, 39, 47, 21, 43, 51]));

    const inPocket = camera(595.5, 105.2, 625.5);
    let seen = pool.history().length;
    settle(chunks, pool, inPocket);
    const reseeds = pool.history().slice(seen).filter(isNode);
    expect(reseeds.length).toBe(1);
    expect(reseeds[0].prevHash).toBe(-1); // forced: the seed is not part of the input hash
    const after = answerTo(reseeds[0]);
    expect(after.unchanged).toBe(false);
    expect(after.mesh!.cavities).toBeNull();
    expect(after.mesh!.opaqueQuads).toBeGreaterThan(before.opaqueQuads);

    // Staying in the pocket asks for nothing more; edits around it reuse the open-pocket mesh.
    seen = pool.history().length;
    for (let i = 0; i < 5; i++) chunks.update(inPocket, 1 / 60);
    expect(pool.pending).toBe(0);
    // Chunk (17, 3, 18) touches the node's padding only; x = 569 is also beyond the columns whose
    // skylight the node samples (SKY_REACH + 1 = 6 columns out).
    world.setBlock(569, 97, 600, B.PLANKS);
    world.flush();
    settle(chunks, pool, inPocket);
    const followUps = pool.history().slice(seen).filter(isNode);
    expect(followUps.length).toBe(1);
    expect(followUps[0].prevHash).toBe(after.hash);
    expect(answerTo(followUps[0]).unchanged).toBe(true);
    expect(chunks.debugCut().every((n) => n.current)).toBe(true);
  });

  test('whenMeshed fires inside update() in the frame the new mesh is applied', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at);
    const cam = camera(at.x, at.y, at.z);
    settle(chunks, pool, cam);
    const root = scene.getObjectByName('voxel-world')!;
    const order: string[] = [];
    // Edits made before the call and not flushed yet, like FallingBody removing a tree.
    world.setBlock(600, 95, 600, B.AIR);
    world.setBlock(601, 95, 600, B.AIR);
    const groupsBefore = new Set(root.children);
    let newMeshShown = false;
    chunks.whenMeshed([chunkKeyAt(600, 95, 600)], () => {
      order.push('meshed');
      newMeshShown = root.children.some((g) => !groupsBefore.has(g));
    });
    world.flush();
    chunks.update(cam, 1 / 60);
    order.push('frame 1');
    pool.answerAll();
    order.push('answered');
    chunks.update(cam, 1 / 60);
    order.push('frame 2');
    expect(order).toEqual(['frame 1', 'answered', 'meshed', 'frame 2']);
    expect(newMeshShown).toBe(true);

    // Nothing changed in these chunks: called back on the next update().
    let quiet = 0;
    chunks.whenMeshed([chunkKeyAt(900, 300, 900)], () => quiet++);
    expect(quiet).toBe(0);
    chunks.update(cam, 1 / 60);
    expect(quiet).toBe(1);
  });

  test('nodes of a whenMeshed request swap together, in the frame of the callback', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at);
    const cam = camera(at.x, at.y, at.z);
    // A log across the border of level-0 nodes x 512..575 and x 576..639, like a felled trunk.
    for (let x = 566; x < 586; x++) world.setBlock(x, 100, 600, B.OAK_LOG);
    world.flush();
    settle(chunks, pool, cam);
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    /** Origins (x, y, z) of node groups that were not in the scene before the removal. */
    const newGroups = () => root.children.filter((g) => !groupsBefore.has(g)).map((g) => g.position.toArray().join());
    for (let x = 566; x < 586; x++) world.setBlock(x, 100, 600, B.AIR);
    let calls = 0;
    let groupsAtCallback: string[] = [];
    chunks.whenMeshed([chunkKeyAt(566, 100, 600), chunkKeyAt(585, 100, 600)], () => {
      calls++;
      groupsAtCallback = newGroups();
    });
    world.flush();
    chunks.update(cam, 1 / 60);
    const west = (j: MeshJob) => j.level === 0 && j.ox === 512 && j.oy === 64 && j.oz === 576;
    expect(pool.answerOne(west)).toBe(true);
    chunks.update(cam, 1 / 60);
    // The west half's new mesh waits for the east half's: no part of the log vanishes early.
    expect(newGroups()).toEqual([]);
    expect(calls).toBe(0);
    pool.answerAll();
    chunks.update(cam, 1 / 60);
    expect(calls).toBe(1);
    // Both halves change in the callback's frame. The nodes below were re-meshed too (their sky
    // samples changed) but produced the same geometry, so they kept their meshes.
    expect(groupsAtCallback.sort()).toEqual(['512,64,576', '576,64,576']);
    expect(chunks.debugCut().every((n) => n.current)).toBe(true);
  });

  test('requests sharing a node swap together: one whose meshes are all in waits for a hold on a node of it', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at, undefined, 16); // a job for every dirtied node at once
    const cam = camera(at.x, at.y, at.z);
    for (let x = 566; x < 586; x++) world.setBlock(x, 100, 600, B.OAK_LOG);
    world.flush();
    settle(chunks, pool, cam);
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    const newGroups = () =>
      root.children
        .filter((g) => !groupsBefore.has(g))
        .map((g) => g.position.toArray().join())
        .sort();
    // Tree S, a log across the border of level-0 nodes A (x 512..575) and C (x 576..639), leaves the world at once…
    for (let x = 566; x < 586; x++) world.setBlock(x, 100, 600, B.AIR);
    let calls = 0;
    let groupsAtCallback: string[] = [];
    chunks.whenMeshed([chunkKeyAt(566, 100, 600), chunkKeyAt(585, 100, 600)], () => {
      calls++;
      groupsAtCallback = newGroups();
    });
    world.flush();
    chunks.update(cam, 1 / 60); // the jobs of its nodes go out
    // …and body B begins a write in slices in a chunk of C (x 608..639) that no padding of A reaches.
    const hold = chunks.holdMeshes([chunkKeyAt(620, 100, 600)]);
    for (let frame = 0; frame < 5; frame++) {
      pool.answerAll();
      chunks.update(cam, 1 / 60);
    }
    // S's meshes are all in, but C's is held for B: A's waits with it (no half tree), and so does S's callback.
    expect(newGroups()).toEqual([]);
    expect(calls).toBe(0);
    let released = 0;
    hold.release(() => released++);
    chunks.update(cam, 1 / 60);
    expect([calls, released]).toEqual([1, 1]);
    expect(groupsAtCallback).toEqual(['512,64,576', '576,64,576']);
  });

  test('no LOD split or merge involves a node a request holds back: it would show the meshes held back', async () => {
    // The camera 190 voxels east of the level-1 node P (x 512..639): P is in the cut, its children are meshed ahead.
    const far = { x: 830, y: 112, z: 576 };
    const { chunks, world, pool } = await prewarmed(far);
    settle(chunks, pool, camera(far.x, far.y, far.z));
    const inCut = (level: number, x: number, y: number, z: number): boolean =>
      chunks.debugCut().some((n) => n.level === level && n.x === x && n.y === y && n.z === z);
    expect(inCut(1, 512, 0, 512)).toBe(true);
    expect(inCut(0, 768, 64, 576)).toBe(true); // Q, around the camera
    // One write, in P's child (576, 64, 576) and in Q, waits for its meshes; Q's is late.
    world.setBlock(601, 95, 600, B.AIR);
    world.setBlock(800, 96, 600, B.STONE);
    let calls = 0;
    chunks.whenMeshed([chunkKeyAt(601, 95, 600), chunkKeyAt(800, 96, 600)], () => calls++);
    world.flush();
    const isQ = (j: MeshJob): boolean => j.level === 0 && j.ox === 768 && j.oy === 64 && j.oz === 576;
    // The player walks 20 voxels towards P: within 180 of it, P would split as soon as its children are current.
    const near = camera(810, far.y, far.z);
    for (let frame = 0; frame < 12; frame++) {
      chunks.update(near, 1 / 60);
      let answered = true;
      while (answered) answered = pool.answerOne((j) => !isQ(j));
    }
    expect(inCut(1, 512, 0, 512)).toBe(true); // not replaced by children showing the edit before Q does
    expect(calls).toBe(0);
    pool.answerAll(); // Q's mesh: the request is met, and P splits in the frame of the callback
    chunks.update(near, 1 / 60);
    expect(calls).toBe(1);
    expect(inCut(1, 512, 0, 512)).toBe(false);
    expect(inCut(0, 576, 64, 576)).toBe(true);
  });

  test('a node a pending request holds keeps its place in frames without any mesh to swap too', async () => {
    const far = { x: 830, y: 112, z: 576 };
    const { chunks, world, pool } = await prewarmed(far);
    settle(chunks, pool, camera(far.x, far.y, far.z));
    const inCut = (level: number, x: number, y: number, z: number): boolean =>
      chunks.debugCut().some((n) => n.level === level && n.x === x && n.y === y && n.z === z);
    // Glass for stone deep inside P (x 512..639): only P, in the cut, and its 8 children, meshed ahead, are dirtied.
    world.setBlock(590, 80, 590, B.GLASS);
    let calls = 0;
    chunks.whenMeshed([chunkKeyAt(590, 80, 590)], () => calls++);
    world.flush();
    const near = camera(810, far.y, far.z);
    for (let frame = 0; frame < 12; frame++) {
      chunks.update(near, 1 / 60);
      let answered = true;
      while (answered) answered = pool.answerOne((j) => j.level === 0); // the children's meshes, not P's: no swap
    }
    expect(inCut(1, 512, 0, 512)).toBe(true);
    expect(calls).toBe(0);
    pool.answerAll();
    chunks.update(near, 1 / 60);
    expect(calls).toBe(1);
    expect(inCut(1, 512, 0, 512)).toBe(false);
  });

  test('whenMeshed gives up after 2 s if the mesh never arrives', async () => {
    let t = 0;
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world } = await prewarmed(at, () => t);
    const cam = camera(at.x, at.y, at.z);
    let called = 0;
    world.setBlock(600, 95, 600, B.AIR);
    chunks.whenMeshed([chunkKeyAt(600, 95, 600)], () => called++);
    world.flush();
    for (t = 0; t < 1900; t += 100) chunks.update(cam, 0.1);
    expect(called).toBe(0);
    t = 2100;
    chunks.update(cam, 0.1);
    expect(called).toBe(1);
  });

  test('a hold keeps a write spread over several frames off screen; released, its nodes swap in the callback frame', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at);
    const cam = camera(at.x, at.y, at.z);
    // A log across the border of level-0 nodes x 512..575 and x 576..639, and two bricks in the node x 640..703, in a
    // chunk (x 672..703) no padding of those two reaches.
    for (let x = 566; x < 586; x++) world.setBlock(x, 100, 600, B.OAK_LOG);
    world.setBlock(680, 100, 600, B.BRICK);
    world.setBlock(690, 100, 600, B.BRICK);
    world.flush();
    settle(chunks, pool, cam);
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    const newGroups = () =>
      root.children
        .filter((g) => !groupsBefore.has(g))
        .map((g) => g.position.toArray().join())
        .sort();
    const hold = chunks.holdMeshes([chunkKeyAt(566, 100, 600), chunkKeyAt(585, 100, 600)]);
    const jobs = (x: number): number => pool.history().filter((j) => j.level === 0 && j.ox === x && j.oy === 64 && j.oz === 576).length;
    const before = [512, 576, 640].map(jobs);
    // Removed in two slices, a frame each, every job answered in between: nothing shows yet, and the held nodes are not
    // even meshed (no mesh of theirs could show before the release).
    for (const [x0, x1] of [
      [566, 576],
      [576, 586],
    ]) {
      for (let x = x0; x < x1; x++) world.setBlock(x, 100, 600, B.AIR);
      world.flush();
      chunks.update(cam, 1 / 60);
      pool.answerAll();
      chunks.update(cam, 1 / 60);
      expect(newGroups()).toEqual([]);
    }
    // The write ends with a cell outside the held chunks, added to the hold: its node is held as well.
    world.setBlock(680, 100, 600, B.AIR);
    hold.add([chunkKeyAt(680, 100, 600)]);
    world.flush();
    chunks.update(cam, 1 / 60);
    pool.answerAll();
    chunks.update(cam, 1 / 60);
    expect(newGroups()).toEqual([]);
    expect([512, 576, 640].map(jobs)).toEqual(before);
    let calls = 0;
    let groupsAtCallback: string[] = [];
    hold.release(() => {
      calls++;
      groupsAtCallback = newGroups();
    });
    chunks.update(cam, 1 / 60);
    expect(calls).toBe(0);
    expect(newGroups()).toEqual([]);
    pool.answerAll();
    chunks.update(cam, 1 / 60);
    expect(calls).toBe(1);
    expect(groupsAtCallback).toEqual(['512,64,576', '576,64,576', '640,64,576']);
    expect(chunks.debugCut().every((n) => n.current)).toBe(true);
    // Each held node was meshed once, against the whole write.
    expect([512, 576, 640].map(jobs)).toEqual(before.map((n) => n + 1));
  });

  test('a hold never released stops holding after 2 s of game time; released after that, it calls back once the meshes are current', async () => {
    let t = 0;
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at, () => t);
    const cam = camera(at.x, at.y, at.z);
    world.setBlock(690, 100, 600, B.BRICK); // in node x 640..703, which no padding of the held chunk's nodes reaches
    world.flush();
    settle(chunks, pool, cam);
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    const hold = chunks.holdMeshes([chunkKeyAt(601, 95, 600)]);
    world.setBlock(601, 95, 600, B.AIR); // open to the air above (no grass there): the mesh changes
    world.flush();
    for (t = 0; t < 1900; t += 100) {
      chunks.update(cam, 0.1);
      pool.answerAll();
    }
    expect(root.children.filter((g) => !groupsBefore.has(g))).toHaveLength(0);
    chunks.update(cam, 0.1); // 2 s: it stops holding, and its node is meshed from the next frame on
    chunks.update(cam, 0.1);
    pool.answerAll();
    chunks.update(cam, 0.1);
    expect(root.children.filter((g) => !groupsBefore.has(g))).toHaveLength(1); // no longer held
    // The write's last slices: one where it began, one in a chunk added since. The release waits for both.
    let calls = 0;
    world.setBlock(602, 95, 600, B.AIR);
    world.setBlock(690, 100, 600, B.AIR);
    hold.add([chunkKeyAt(690, 100, 600)]);
    hold.release(() => calls++);
    world.flush();
    chunks.update(cam, 0.1);
    expect(calls).toBe(0);
    const added = (j: MeshJob): boolean => j.level === 0 && j.ox === 640 && j.oy === 64 && j.oz === 576;
    let answered = true;
    while (answered) answered = pool.answerOne((j) => !added(j));
    chunks.update(cam, 0.1);
    expect(calls).toBe(0);
    pool.answerAll();
    chunks.update(cam, 0.1);
    expect(calls).toBe(1);
  });

  test('a hold that holds no node yet is never met: it holds what is added later', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at);
    const cam = camera(at.x, at.y, at.z);
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    const hold = chunks.holdMeshes([]); // a write whose first slice changed nothing
    chunks.update(cam, 1 / 60);
    world.setBlock(601, 95, 600, B.AIR); // the next one
    hold.add([chunkKeyAt(601, 95, 600)]);
    world.flush();
    for (let frame = 0; frame < 3; frame++) {
      chunks.update(cam, 1 / 60);
      pool.answerAll();
    }
    expect(root.children.filter((g) => !groupsBefore.has(g))).toHaveLength(0);
    let calls = 0;
    hold.release(() => calls++);
    settle(chunks, pool, cam);
    expect(calls).toBe(1);
    expect(root.children.filter((g) => !groupsBefore.has(g))).toHaveLength(1);
  });

  test('a hold taken between frames stops the jobs of its nodes that were waiting for a worker', async () => {
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool } = await prewarmed(at);
    const cam = camera(at.x, at.y, at.z);
    settle(chunks, pool, cam);
    // An edit dirties the nodes around (601, 95, 600), down to where its skylight reaches: two jobs go out, the others
    // wait for a free worker…
    world.setBlock(601, 95, 600, B.AIR);
    world.flush();
    chunks.update(cam, 1 / 60);
    expect(pool.pending).toBe(2);
    const sent = pool.history().length;
    // …when a write in slices holds them all (taken between two frames, as a falling body does): none of them is sent.
    const hold = chunks.holdMeshes([chunkKeyAt(601, 40, 600), chunkKeyAt(601, 80, 600), chunkKeyAt(601, 100, 600)]);
    pool.answerAll();
    expect(pool.history().length).toBe(sent);
    let calls = 0;
    hold.release(() => calls++);
    settle(chunks, pool, cam);
    expect(calls).toBe(1);
    expect(pool.history().length).toBeGreaterThan(sent);
  });

  test('a hold does not time out while the game is paused (dt 0): its holder writes nothing meanwhile either', async () => {
    let t = 0;
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool, scene } = await prewarmed(at, () => t);
    const cam = camera(at.x, at.y, at.z);
    const root = scene.getObjectByName('voxel-world')!;
    const groupsBefore = new Set(root.children);
    const hold = chunks.holdMeshes([chunkKeyAt(601, 95, 600)]);
    world.setBlock(601, 95, 600, B.AIR); // the write's first slice
    world.flush();
    chunks.update(cam, 1 / 60);
    for (let i = 0; i < 300; i++) {
      t += 100; // 30 s in the pause menu: the frames go on (and so does meshing), the game time does not
      chunks.update(cam, 0);
      pool.answerAll();
    }
    expect(root.children.filter((g) => !groupsBefore.has(g))).toHaveLength(0); // still held
    world.setBlock(602, 95, 600, B.AIR); // resumed: the last slice
    let calls = 0;
    hold.release(() => calls++);
    world.flush();
    chunks.update(cam, 1 / 60);
    pool.answerAll();
    chunks.update(cam, 1 / 60);
    expect(calls).toBe(1);
    expect(root.children.filter((g) => !groupsBefore.has(g))).toHaveLength(1);
  });

  test('a release waits its own 2 s for the meshes, and releasing twice calls back once', async () => {
    let t = 0;
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool } = await prewarmed(at, () => t);
    const cam = camera(at.x, at.y, at.z);
    const hold = chunks.holdMeshes([chunkKeyAt(601, 95, 600)]);
    world.setBlock(601, 95, 600, B.AIR);
    world.flush();
    for (t = 0; t < 1900; t += 100) chunks.update(cam, 0.1); // its node gets no mesh job meanwhile
    let first = 0;
    let second = 0;
    hold.release(() => first++);
    hold.release(() => second++);
    t = 2100; // past the hold's deadline, not the release's
    chunks.update(cam, 0.1);
    expect(first).toBe(0);
    pool.answerAll();
    chunks.update(cam, 0.1);
    chunks.update(cam, 0.1);
    expect([first, second]).toEqual([1, 0]);
  });

  test('a worker is replaced after 15 s of frames without an answer, but a long pause between frames does not count', async () => {
    let t = 0;
    const at = { x: 600, y: 112, z: 600 };
    const { chunks, world, pool } = await prewarmed(at, () => t);
    const cam = camera(at.x, at.y, at.z);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    world.setBlock(600, 95, 600, B.AIR);
    world.flush();
    chunks.update(cam, 0.1); // posts a job that nobody answers
    expect(pool.pending).toBeGreaterThan(0);
    const workers = pool.workers.length;
    t += 60_000; // the tab was hidden for a minute: no frames, the job is still running
    chunks.update(cam, 0.1);
    for (let i = 0; i < 100; i++) {
      t += 100;
      chunks.update(cam, 0.1);
    }
    expect(pool.workers.length).toBe(workers);
    expect(errors).not.toHaveBeenCalled();
    for (let i = 0; i < 60; i++) {
      t += 100; // 16 s of frames in all
      chunks.update(cam, 0.1);
    }
    expect(pool.workers.length).toBeGreaterThan(workers);
    expect(errors).toHaveBeenCalledWith('[chunks] mesh worker stalled; replacing it');
    errors.mockRestore();
  });

  test('dispose removes everything from the scene', async () => {
    const { chunks, scene } = await prewarmed({ x: 576, y: 112, z: 576 });
    chunks.dispose();
    expect(scene.getObjectByName('voxel-world')).toBeUndefined();
    expect(chunks.stats().cachedNodes).toBe(0);
  });
});
