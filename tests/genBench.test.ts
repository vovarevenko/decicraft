import { describe, expect, test, vi } from 'vitest';
import { GEN_TILE, GEN_TILES_X, GEN_TILES_Z, WORLD_SEED } from '../src/config';
import { TileGenerator, type TileResult } from '../src/gen/nature/tileGenerator';
import type { TownPlan } from '../src/gen/types';

vi.mock('../src/gen/town/index', () => ({
  planTown: (): TownPlan => ({ features: [], spawns: [], landmarks: [], entrance: { x: 585, z: 585, yaw: Math.PI / 4 } }),
}));

/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);

const nonUniform = (r: TileResult): number => r.chunks.reduce<number>((n, c) => n + (typeof c === 'number' ? 0 : 1), 0);

/**
 * Single-threaded generation benchmark (node). Targets: ≤ 500 ms per tile on average (the browser runs
 * workerCount('gen') of these in parallel for < 8 s in total) and ≤ 6000 non-uniform chunks for the
 * whole world (≈ 190 MB). The town is mocked empty here, so town tiles are terrain-only. Expect slower
 * timings than in the browser: vitest's module loader reads imported bindings through getters.
 */
describe('generation benchmark', () => {
  test('the whole world: time per tile and non-uniform chunks', { timeout: 180_000 }, () => {
    const t0 = performance.now();
    const gen = new TileGenerator(WORLD_SEED);
    const initMs = performance.now() - t0;
    gen.generate(5, 5); // warm-up (JIT)
    const ms = new Float64Array(GEN_TILES_X * GEN_TILES_Z);
    const counts = new Int32Array(GEN_TILES_X * GEN_TILES_Z);
    for (let tz = 0; tz < GEN_TILES_Z; tz++) {
      for (let tx = 0; tx < GEN_TILES_X; tx++) {
        const ts = performance.now();
        const r = gen.generate(tx, tz);
        ms[tx + tz * GEN_TILES_X] = performance.now() - ts;
        counts[tx + tz * GEN_TILES_X] = nonUniform(r);
      }
    }
    const total = ms.reduce((a, b) => a + b, 0);
    const avg = total / ms.length;
    const chunks = counts.reduce((a, b) => a + b, 0);
    const pond = gen.terrain.pond;
    const tiles: [string, number, number][] = [
      ['forest', 7, 2],
      ['forest/hills fringe', 8, 4],
      ['hills', 8, 8],
      ['meadow + pond', Math.floor(pond.x / GEN_TILE), Math.floor(pond.z / GEN_TILE)],
      ['town edge', 4, 4],
      ['centre', 5, 5],
    ];
    const lines = [`[gen] worker init (terrain + plan + index): ${initMs.toFixed(0)} ms`];
    for (const [name, tx, tz] of tiles) {
      const i = tx + tz * GEN_TILES_X;
      lines.push(`[gen] ${name.padEnd(20)} tile ${tx},${tz}: ${ms[i].toFixed(0).padStart(4)} ms, ${counts[i]} non-uniform chunks`);
    }
    lines.push(
      `[gen] whole world: ${ms.length} tiles in ${total.toFixed(0)} ms (avg ${avg.toFixed(0)} ms, worst ${Math.max(...ms).toFixed(0)} ms), ` +
        `${chunks} non-uniform chunks ≈ ${((chunks * 32768) / 2 ** 20).toFixed(0)} MB`,
    );
    console.info(lines.join('\n'));
    // The memory budget is deterministic, so it holds in every run.
    expect(chunks).toBeLessThan(6000);
    if (BENCH) expect(avg).toBeLessThan(500);
  });
});
