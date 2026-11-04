/**
 * Build timings of the voxel models. Timings are reported on the console; hard targets are asserted
 * only with BENCH=1 (the full suite runs test files in parallel on a loaded machine).
 *   BENCH=1 npx vitest run tests/modelsBench.test.ts
 */
import { describe, expect, test } from 'vitest';
import { ITEM_LIST } from '../src/game/items';
import { CONTAINER_MODELS } from '../src/render/models/containers';
import { buildDeerRig } from '../src/render/models/deer';
import { buildDogRig } from '../src/render/models/dog';
import { buildDoor } from '../src/render/models/doors';
import { noise3 } from '../src/render/models/palette';
import { getItemGeometry } from '../src/render/models';
import { buildVoxelGeometry, VoxelGrid } from '../src/render/voxelModel';
import { B, COLOR_SIDE } from '../src/world/blocks';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BENCH = env.BENCH !== undefined && env.BENCH !== '' && env.BENCH !== '0';

const color = (id: number): number => (COLOR_SIDE[id * 3] << 16) | (COLOR_SIDE[id * 3 + 1] << 8) | COLOR_SIDE[id * 3 + 2];

/**
 * The FallingBody case: a felled oak at 10 cm voxels in a 95×145×93 grid — trunk (bark around wood),
 * thirteen tapered branches and noise-deformed foliage clusters, the big ones hollow shells around an
 * air core (as the worldgen builds crowns): ~110k filled cells.
 */
function felledOak(): VoxelGrid {
  const g = new VoxelGrid(95, 145, 93);
  const bark = color(B.OAK_LOG);
  const leaves = color(B.OAK_LEAVES);
  const cx = 47;
  const cz = 46;
  g.capsule(cx, 0, cz, cx, 95, cz, 3.4, 2.2, bark, true);
  g.capsule(cx, 0, cz, cx, 95, cz, 2.2, 1.2, color(B.WOOD), true);
  let seed = 7;
  const rnd = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const clusters: [number, number, number, number][] = [];
  for (let i = 0; i < 13; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 14 + rnd() * 20;
    const y = 85 + rnd() * 40;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const radius = 12.3 + rnd() * 7;
    clusters.push([x, y, z, radius]);
    g.capsule(cx, 60 + rnd() * 30, cz, x, y - radius * 0.3, z, 1.6, 0.8, bark);
  }
  for (const [x, y, z, radius] of clusters) {
    const shell = radius >= 10 ? 5.5 : radius;
    g.sdf(
      (px, py, pz) => {
        const d = Math.hypot(px - x, (py - y) * 1.3, pz - z) + (noise3(px, py, pz, 6, 3) - 0.5) * 5 - radius;
        return Math.max(d, -(d + shell));
      },
      leaves,
      [x - radius - 4, y - radius - 4, z - radius - 4, x + radius + 4, y + radius + 4, z + radius + 4],
    );
  }
  return g;
}

function time<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

describe('model build timings (reported; asserted only with BENCH=1)', () => {
  // First in the file: the first build runs before the mesher is warm, as a tree felled early would.
  test('felled oak at 10 cm voxels (FallingBody): target ≤ 100 ms', () => {
    const grid = felledOak();
    const filled = grid.count();
    expect(filled).toBeGreaterThan(100_000);
    expect(filled).toBeLessThan(125_000);
    const opts = { scale: 1, origin: [0, 0, 0] as [number, number, number] };
    const [geo, first] = time(() => buildVoxelGeometry(grid, opts));
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) runs.push(time(() => buildVoxelGeometry(grid, opts))[1]);
    const quads = geo.index!.count / 6;
    console.log(
      `[models] felled oak ${grid.sx}×${grid.sy}×${grid.sz}, ${filled} cells → ${quads} quads: ` +
        `first build ${first.toFixed(1)} ms, median of 5 ${median(runs).toFixed(1)} ms`,
    );
    expect(quads).toBeGreaterThan(10_000);
    if (BENCH) {
      expect(first).toBeLessThan(100);
      expect(median(runs)).toBeLessThan(100);
    }
  });

  test('mob rigs: target < 150 ms each', () => {
    for (const [kind, build] of [
      ['deer', buildDeerRig],
      ['dog', buildDogRig],
    ] as const) {
      const [rig, first] = time(build);
      const again = time(build)[1];
      const tris = rig.parts.reduce((s, p) => s + p.geometry.index!.count / 3, 0);
      console.log(`[models] ${kind} rig: ${tris} triangles, first build ${first.toFixed(1)} ms, again ${again.toFixed(1)} ms`);
      if (BENCH) expect(Math.min(first, again)).toBeLessThan(150);
    }
  });

  test('items, doors and containers', () => {
    const [, items] = time(() => {
      for (const def of ITEM_LIST) getItemGeometry(def.id);
    });
    const [, doors] = time(() => {
      for (const style of ['wood', 'wood_painted', 'metal'] as const) buildDoor(9, 20, style);
    });
    const containers: string[] = [];
    for (const [style, build] of Object.entries(CONTAINER_MODELS)) containers.push(`${style} ${time(build)[1].toFixed(1)}`);
    console.log(
      `[models] all ${ITEM_LIST.length} items ${items.toFixed(1)} ms; three 9×20 doors ${doors.toFixed(1)} ms; ` +
        `containers (ms): ${containers.join(', ')}`,
    );
    if (BENCH) expect(items).toBeLessThan(500);
  });
});
