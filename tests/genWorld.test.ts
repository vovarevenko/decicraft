import { afterEach, describe, expect, test, vi } from 'vitest';
import { CHUNK_VOL, GEN_TILE, GEN_TILES_X, GEN_TILES_Z, WORLD_SEED, workerCount } from '../src/config';
import { generateWorld, tileOrder } from '../src/gen/generateWorld';
import type { GenRequest, GenResponse } from '../src/gen/nature/protocol';
import { CHUNKS_PER_TILE, TILE_CHUNKS } from '../src/gen/nature/tileGenerator';
import type { TownPlan } from '../src/gen/types';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';

vi.mock('../src/gen/town/index', () => ({
  planTown: (): TownPlan => ({ features: [], spawns: [], landmarks: [], entrance: { x: 585, z: 585, yaw: Math.PI / 4 } }),
}));

type Behaviour = 'ok' | 'tile-error' | 'crash';

/**
 * In-process stand-in for a generation worker: answers asynchronously with synthetic tiles —
 * stone below y 128, a marker chunk at cy 4 holding the tile index, air above.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  static behaviour: Behaviour = 'ok';
  static requests: GenRequest[] = [];
  onmessage: ((ev: MessageEvent<GenResponse>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  transfers = 0;

  constructor(readonly url: URL, readonly options: { type: string }) {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: GenRequest): void {
    FakeWorker.requests.push(msg);
    setTimeout(() => this.handle(msg), 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  private reply(msg: GenResponse): void {
    if (!this.terminated) this.onmessage?.({ data: msg } as MessageEvent<GenResponse>);
  }

  private handle(msg: GenRequest): void {
    if (msg.type === 'init') {
      this.reply({ type: 'ready' });
      return;
    }
    if (FakeWorker.behaviour === 'tile-error' && msg.tx === 3) {
      this.reply({ type: 'error', message: 'boom', tx: msg.tx, tz: msg.tz });
      return;
    }
    if (FakeWorker.behaviour === 'crash' && msg.tx === 2) {
      this.onerror?.({ message: 'kaput', filename: 'gen.worker.ts', lineno: 7, preventDefault: () => {} } as ErrorEvent);
      return;
    }
    const chunks: (number | Uint8Array)[] = [];
    for (let i = 0; i < CHUNKS_PER_TILE; i++) {
      const cy = Math.floor(i / (TILE_CHUNKS * TILE_CHUNKS));
      if (cy === 4 && i % (TILE_CHUNKS * TILE_CHUNKS) === 0) {
        const c = new Uint8Array(CHUNK_VOL);
        c[0] = B.GRASS;
        c[1] = 1 + msg.tx + msg.tz * GEN_TILES_X;
        chunks.push(c);
      } else chunks.push(cy < 4 ? B.STONE : B.AIR);
    }
    const sky = new Int16Array(GEN_TILE * GEN_TILE).fill(128 + msg.tx);
    const canopy = new Int16Array(GEN_TILE * GEN_TILE).fill(140 + msg.tz);
    this.transfers++;
    this.reply({ type: 'tile', tx: msg.tx, tz: msg.tz, chunks, sky, canopy });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
  FakeWorker.requests = [];
  FakeWorker.behaviour = 'ok';
});

describe('generateWorld (main-thread driver)', () => {
  test('tile order: every tile once, centre first', () => {
    const order = tileOrder();
    expect(order.length).toBe(GEN_TILES_X * GEN_TILES_Z);
    expect(new Set(order.map((t) => t.tx + t.tz * GEN_TILES_X)).size).toBe(order.length);
    const firstFour = order.slice(0, 4).map((t) => `${t.tx},${t.tz}`).sort();
    expect(firstFour).toEqual(['4,4', '4,5', '5,4', '5,5']);
    const corner = order.findIndex((t) => t.tx === 0 && t.tz === 0);
    expect(corner).toBeGreaterThan(90);
  });

  test('runs the worker pool, loads every tile into the world, reports progress, terminates the workers', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const world = World.create();
    const progress: number[] = [];
    await generateWorld(world, WORLD_SEED, (done, total) => {
      expect(total).toBe(GEN_TILES_X * GEN_TILES_Z);
      progress.push(done);
    });
    expect(FakeWorker.instances.length).toBe(workerCount('gen'));
    for (const w of FakeWorker.instances) {
      expect(w.options.type).toBe('module');
      expect(String(w.url)).toContain('gen.worker');
      expect(w.terminated).toBe(true);
    }
    expect(progress).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const inits = FakeWorker.requests.filter((r) => r.type === 'init');
    expect(inits.length).toBe(FakeWorker.instances.length);
    for (const r of inits) expect(r).toEqual({ type: 'init', seed: WORLD_SEED });
    const tiles = FakeWorker.requests.filter((r) => r.type === 'tile');
    expect(tiles.length).toBe(100);
    expect(tiles.slice(0, 4).map((r) => (r.type === 'tile' ? `${r.tx},${r.tz}` : '')).sort()).toEqual(['4,4', '4,5', '5,4', '5,5']);
    // Chunks and height maps landed where they belong.
    for (const [tx, tz] of [[0, 0], [3, 7], [9, 9]]) {
      const x = tx * GEN_TILE;
      const z = tz * GEN_TILE;
      expect(world.getBlock(x + 5, 10, z + 5)).toBe(B.STONE);
      expect(world.getBlock(x, 128, z)).toBe(B.GRASS);
      expect(world.getBlock(x + 1, 128, z)).toBe(1 + tx + tz * GEN_TILES_X);
      expect(world.getBlock(x + 40, 128, z + 40)).toBe(B.AIR);
      expect(world.getBlock(x + 5, 300, z + 5)).toBe(B.AIR);
      expect(world.skyHeight(x + 77, z + 3)).toBe(128 + tx);
      expect(world.canopyHeight(x + 3, z + 77)).toBe(140 + tz);
    }
    expect(world.allocatedChunks).toBe(100);
  });

  test('a tile error in a worker rejects with a clear message and stops every worker', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.behaviour = 'tile-error';
    await expect(generateWorld(World.create(), WORLD_SEED)).rejects.toThrow(/Генерация мира прервана: ошибка в тайле 3,\d: boom/);
    for (const w of FakeWorker.instances) expect(w.terminated).toBe(true);
  });

  test('a crashing worker rejects too', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.behaviour = 'crash';
    await expect(generateWorld(World.create(), WORLD_SEED)).rejects.toThrow(/сбой воркера генерации: kaput/);
    for (const w of FakeWorker.instances) expect(w.terminated).toBe(true);
  });
});

describe('gen.worker message protocol', () => {
  test('init builds the generator once; tiles come back with transferable buffers; errors are reported', async () => {
    const posted: { msg: GenResponse; transfer: Transferable[] }[] = [];
    const scope = {
      onmessage: null as ((ev: MessageEvent) => void) | null,
      postMessage: (msg: GenResponse, transfer: Transferable[] = []) => posted.push({ msg, transfer }),
      close: () => {},
    };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../src/gen/gen.worker');
    expect(scope.onmessage).toBeTypeOf('function');
    const send = (data: GenRequest): void => scope.onmessage!({ data } as MessageEvent);

    send({ type: 'tile', tx: 1, tz: 1 });
    expect(posted[0].msg.type).toBe('error');

    send({ type: 'init', seed: WORLD_SEED });
    expect(posted[1].msg).toEqual({ type: 'ready' });

    send({ type: 'tile', tx: 5, tz: 4 });
    const { msg, transfer } = posted[2];
    if (msg.type !== 'tile') throw new Error(`unexpected ${msg.type}`);
    expect(msg.tx).toBe(5);
    expect(msg.tz).toBe(4);
    expect(msg.chunks.length).toBe(CHUNKS_PER_TILE);
    expect(msg.sky.length).toBe(GEN_TILE * GEN_TILE);
    const arrays = msg.chunks.filter((c): c is Uint8Array => typeof c !== 'number');
    expect(arrays.length).toBeGreaterThan(0);
    expect(transfer).toContain(msg.sky.buffer);
    expect(transfer).toContain(msg.canopy.buffer);
    for (const a of arrays) expect(transfer).toContain(a.buffer);

    send({ type: 'tile', tx: 99, tz: 0 });
    const err = posted[3].msg;
    expect(err.type).toBe('error');
    if (err.type === 'error') expect(err.tx).toBe(99);
  });
});
