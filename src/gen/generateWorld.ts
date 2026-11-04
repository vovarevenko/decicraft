/**
 * Main-thread driver of world generation. OWNER: agent "worldgen".
 * Spawns workerCount('gen') module workers (gen/gen.worker.ts), dispatches the GEN_TILES_X×GEN_TILES_Z
 * tiles (centre tiles first), loads results into the World (world.loadChunk / world.loadSky) as they
 * arrive, terminates the workers and resolves. Chunk arrays are transferred (not copied) to the main thread.
 */
import { GEN_TILE, GEN_TILES_X, GEN_TILES_Z, workerCount } from '../config';
import { chunkKey, type World } from '../world/world';
import type { GenRequest, GenResponse } from './nature/protocol';
import { TILE_CHUNKS, TILE_LAYERS, type TileResult } from './nature/tileGenerator';

/** Jobs kept queued per worker, so a worker never idles while the main thread loads its last tile. */
const IN_FLIGHT = 2;

/** All tiles, nearest to the map centre first (the player spawns there). */
export function tileOrder(): { tx: number; tz: number }[] {
  const tiles: { tx: number; tz: number }[] = [];
  for (let tz = 0; tz < GEN_TILES_Z; tz++) for (let tx = 0; tx < GEN_TILES_X; tx++) tiles.push({ tx, tz });
  const d = (t: { tx: number; tz: number }): number => (t.tx + 0.5 - GEN_TILES_X / 2) ** 2 + (t.tz + 0.5 - GEN_TILES_Z / 2) ** 2;
  return tiles.sort((a, b) => d(a) - d(b) || a.tz - b.tz || a.tx - b.tx);
}

/** Stores a generated tile in the world. */
export function loadTile(world: World, r: TileResult): void {
  const cx0 = r.tx * TILE_CHUNKS;
  const cz0 = r.tz * TILE_CHUNKS;
  for (let cy = 0; cy < TILE_LAYERS; cy++) {
    for (let cz = 0; cz < TILE_CHUNKS; cz++) {
      for (let cx = 0; cx < TILE_CHUNKS; cx++) {
        world.loadChunk(chunkKey(cx0 + cx, cy, cz0 + cz), r.chunks[cx + cz * TILE_CHUNKS + cy * TILE_CHUNKS * TILE_CHUNKS]);
      }
    }
  }
  world.loadSky(r.tx * GEN_TILE, r.tz * GEN_TILE, GEN_TILE, GEN_TILE, r.sky, r.canopy);
}

export async function generateWorld(
  world: World,
  seed: number,
  onProgress?: (doneTiles: number, totalTiles: number) => void,
): Promise<void> {
  const order = tileOrder();
  const total = order.length;
  const count = Math.max(1, Math.min(workerCount('gen'), total));
  const workers: Worker[] = [];
  let next = 0;
  let done = 0;
  let settled = false;

  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const w of workers) w.terminate();
      if (error) reject(error);
      else resolve();
    };
    const fail = (detail: string): void => finish(new Error(`Генерация мира прервана: ${detail}`));
    const dispatch = (w: Worker): void => {
      if (next >= total) return;
      const t = order[next++];
      const req: GenRequest = { type: 'tile', tx: t.tx, tz: t.tz };
      w.postMessage(req);
    };
    const onMessage = (w: Worker, msg: GenResponse): void => {
      if (msg.type === 'ready') {
        for (let i = 0; i < IN_FLIGHT; i++) dispatch(w);
        return;
      }
      if (msg.type === 'error') {
        fail(msg.tx !== undefined ? `ошибка в тайле ${msg.tx},${msg.tz}: ${msg.message}` : msg.message);
        return;
      }
      dispatch(w); // queue the next job before spending time on this result
      loadTile(world, msg);
      done++;
      onProgress?.(done, total);
      if (done === total) finish();
    };

    for (let i = 0; i < count && !settled; i++) {
      let w: Worker;
      try {
        w = new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' });
      } catch (e) {
        fail(`не удалось запустить воркер генерации: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      workers.push(w);
      w.onmessage = (ev: MessageEvent<GenResponse>) => {
        if (settled) return;
        try {
          onMessage(w, ev.data);
        } catch (e) {
          fail(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
        }
      };
      w.onerror = (ev: ErrorEvent) => {
        ev.preventDefault();
        fail(`сбой воркера генерации: ${ev.message || 'неизвестная ошибка'} (${ev.filename || '?'}:${ev.lineno || 0})`);
      };
      w.onmessageerror = () => fail('не удалось передать данные из воркера генерации');
      const init: GenRequest = { type: 'init', seed };
      w.postMessage(init);
    }
  });
}
