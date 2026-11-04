/**
 * Messages between generateWorld (main thread) and gen.worker.ts. OWNER: agent "worldgen".
 */
import type { TileResult } from './tileGenerator';

export type GenRequest = { type: 'init'; seed: number } | { type: 'tile'; tx: number; tz: number };

export type GenResponse =
  | { type: 'ready' }
  | ({ type: 'tile' } & TileResult)
  | { type: 'error'; message: string; tx?: number; tz?: number };

/** Buffers of a tile result to transfer (not copy) to the main thread. */
export function tileTransferables(r: TileResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [r.sky.buffer as ArrayBuffer, r.canopy.buffer as ArrayBuffer];
  for (const c of r.chunks) if (typeof c !== 'number') out.push(c.buffer as ArrayBuffer);
  return out;
}
