/**
 * Mesh-job benchmark on a synthetic 25.6 m region (one level-2 root): rolling grass/dirt/stone terrain,
 * an oak-like tree (trunk, branches, 8 hollow blobby foliage shells), a brick wall with glazed windows,
 * a pond with reeds and tall grass. Reports ms per level-0/1/2 job (volume + mesh), quads and bytes
 * per node. Timings depend on machine load (the suite runs files in parallel), so the ≤ 25 ms level-0
 * budget is asserted only in dedicated runs: `BENCH=1 npx vitest run tests/mesherBench.test.ts`.
 */
import { describe, expect, test } from 'vitest';
import { createNoise3D } from '../src/core/noise';
import { rand2 } from '../src/core/rng';
import { MeshJobRunner, type MeshJob, type MeshJobSuccess } from '../src/render/voxel/meshJob';
import { B } from '../src/world/blocks';
import { World, chunkKey } from '../src/world/world';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const BENCH = env.BENCH !== undefined && env.BENCH !== '' && env.BENCH !== '0';
/** Level-0 job budget on an M1 (ARCHITECTURE.md §6.1). */
const LEVEL0_BUDGET_MS = 25;

const X0 = 512;
const Z0 = 512;
const SIZE = 256;
const POND = { x: 560, z: 690, rx: 26, rz: 18, surface: 118 };
const TREE = { x: 600, z: 600 };
const WALL = { x0: 650, x1: 710, z0: 560, z1: 563, height: 32 };

function terrainHeight(x: number, z: number): number {
  return Math.round(122 + 5 * Math.sin(x * 0.045) * Math.cos(z * 0.037) + 2.5 * Math.sin(x * 0.11 + z * 0.07) + 1.2 * Math.sin(x * 0.31 - z * 0.23));
}

function buildRegion(): World {
  const w = World.create();
  for (let cz = X0 >> 5; cz < (Z0 + SIZE) >> 5; cz++) {
    for (let cx = X0 >> 5; cx < (X0 + SIZE) >> 5; cx++) {
      for (let cy = 0; cy < 2; cy++) w.loadChunk(chunkKey(cx, cy, cz), B.STONE);
    }
  }
  for (let z = Z0; z < Z0 + SIZE; z++) {
    for (let x = X0; x < X0 + SIZE; x++) {
      const pdx = (x - POND.x) / POND.rx;
      const pdz = (z - POND.z) / POND.rz;
      const pr = pdx * pdx + pdz * pdz;
      let h = terrainHeight(x, z);
      let top: number = B.GRASS;
      if (pr < 1) {
        h = Math.min(h, POND.surface - Math.max(1, Math.round(18 * (1 - pr))));
        top = B.SAND;
      } else if (pr < 1.3) {
        h = Math.min(h, POND.surface + 1);
      }
      for (let y = 64; y < h; y++) w.setBlock(x, y, z, y === h - 1 ? top : y >= h - 5 ? B.DIRT : B.STONE);
      if (pr < 1) {
        for (let y = h; y < POND.surface; y++) w.setBlock(x, y, z, B.WATER);
        if (POND.surface - h <= 3 && rand2(x, z, 7) < 0.4) w.setBlock(x, POND.surface, z, B.REEDS);
      } else if (rand2(x, z, 3) < 0.3) {
        w.setBlock(x, h, z, rand2(x, z, 4) < 0.1 ? B.FLOWER_WHITE : B.TALL_GRASS);
      }
    }
  }
  buildTree(w, TREE.x, terrainHeight(TREE.x, TREE.z), TREE.z);
  buildWall(w);
  return w;
}

/** Trunk Ø 60 cm (bark ring, wood core), four branches, eight hollow noise-deformed foliage shells. */
function buildTree(w: World, cx: number, base: number, cz: number): void {
  const top = base + 95;
  for (let y = base - 3; y < top; y++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = Math.hypot(dx, dz);
        if (d <= 3.2) w.setBlock(cx + dx, y, cz + dz, d > 2.2 ? B.OAK_LOG : B.WOOD);
      }
    }
  }
  const branches: [number, number][] = [
    [1, 0],
    [-1, 0.3],
    [0.2, 1],
    [-0.4, -1],
  ];
  for (const [bx, bz] of branches) {
    for (let t = 0; t < 32; t++) {
      const x = Math.round(cx + bx * t);
      const z = Math.round(cz + bz * t);
      const y = base + 60 + Math.round(t * 0.8);
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) w.setBlock(x + dx, y + dy, z + dz, B.OAK_LOG);
    }
  }
  const noise = createNoise3D(11);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const ring = i % 2 === 0 ? 22 : 12;
    const ox = Math.round(cx + Math.cos(a) * ring);
    const oz = Math.round(cz + Math.sin(a) * ring);
    const oy = base + 85 + (i % 3) * 12;
    const r = 12 + (i % 4) * 1.6;
    for (let y = -r - 3; y <= r + 3; y++) {
      for (let z = -r - 3; z <= r + 3; z++) {
        for (let x = -r - 3; x <= r + 3; x++) {
          const d = Math.hypot(x, y * 1.25, z);
          const rr = r * (1 + 0.22 * noise((ox + x) * 0.08, (oy + y) * 0.08, (oz + z) * 0.08));
          if (d <= rr && d > rr - 4.5) w.setBlock(ox + x, oy + y, oz + z, B.OAK_LEAVES);
        }
      }
    }
  }
}

/** Brick wall 3 voxels thick with 12 × 14 windows (glass panes in the middle layer). */
function buildWall(w: World): void {
  const base = terrainHeight(WALL.x0, WALL.z0) - 2;
  for (let x = WALL.x0; x < WALL.x1; x++) {
    for (let y = base; y < base + WALL.height; y++) {
      const wx = (x - WALL.x0) % 20;
      const window = wx >= 4 && wx < 16 && y >= base + 9 && y < base + 23;
      for (let z = WALL.z0; z < WALL.z1; z++) {
        if (!window) w.setBlock(x, y, z, B.BRICK);
        else if (z === WALL.z0 + 1) w.setBlock(x, y, z, B.GLASS);
      }
    }
  }
}

interface Sample {
  label: string;
  level: number;
  volumeMs: number;
  meshMs: number;
  totalMs: number;
  opaque: number;
  glass: number;
  water: number;
  plants: number;
  bytes: number;
}

function measure(runner: MeshJobRunner, label: string, level: number, ox: number, oy: number, oz: number): Sample {
  const job: MeshJob = { type: 'job', id: 0, level, ox, oy, oz, boundary: 0, prevHash: -1, camX: -1000, camY: -1000, camZ: -1000 };
  const runs: MeshJobSuccess[] = [];
  for (let i = 0; i < 7; i++) runs.push(runner.run({ ...job, id: i }).response);
  runs.sort((a, b) => a.volumeMs + a.meshMs - (b.volumeMs + b.meshMs));
  const r = runs[3];
  const m = r.mesh!;
  const bytes =
    (m.opaque?.byteLength ?? 0) + (m.glass?.byteLength ?? 0) + (m.water?.byteLength ?? 0) + (m.plantPos?.byteLength ?? 0) + (m.plantData?.byteLength ?? 0);
  return {
    label,
    level,
    volumeMs: r.volumeMs,
    meshMs: r.meshMs,
    totalMs: r.volumeMs + r.meshMs,
    opaque: m.opaqueQuads,
    glass: m.glassQuads,
    water: m.waterQuads,
    plants: m.plantQuads,
    bytes,
  };
}

describe('mesh job benchmark', () => {
  test('synthetic region: timings, quads and bytes per node', () => {
    const t0 = performance.now();
    const world = buildRegion();
    const buildMs = performance.now() - t0;
    const runner = new MeshJobRunner();
    runner.init(world.toShared());
    const groundY = 64;
    const samples: Sample[] = [
      measure(runner, 'L0 trunk + ground', 0, 576, groundY, 576),
      measure(runner, 'L0 crown (shells)', 0, 576, 192, 576),
      measure(runner, 'L0 trunk + branches', 0, 576, 128, 576),
      measure(runner, 'L0 wall base', 0, 640, groundY, 512),
      measure(runner, 'L0 wall windows', 0, 640, 128, 512),
      measure(runner, 'L0 pond + reeds', 0, 512, groundY, 640),
      measure(runner, 'L0 meadow', 0, 704, groundY, 704),
      measure(runner, 'L1 tree', 1, 512, 128, 512),
      measure(runner, 'L1 ground', 1, 512, 0, 512),
      measure(runner, 'L1 pond', 1, 512, 0, 640),
      measure(runner, 'L2 root', 2, 512, 0, 512),
    ];
    const lines = samples.map(
      (s) =>
        `${s.label.padEnd(20)} L${s.level}  ${s.totalMs.toFixed(1).padStart(6)} ms (volume ${s.volumeMs.toFixed(1)}, mesh ${s.meshMs.toFixed(1)})` +
        `  quads opaque ${s.opaque} glass ${s.glass} water ${s.water} plants ${s.plants}  ${(s.bytes / 1024).toFixed(0)} KB`,
    );
    const level0 = samples.filter((s) => s.level === 0);
    const worst0 = Math.max(...level0.map((s) => s.totalMs));
    lines.push(`worst level-0 job ${worst0.toFixed(1)} ms (budget ${LEVEL0_BUDGET_MS} ms on an M1${BENCH ? ', asserted' : '; set BENCH=1 to assert'})`);
    console.log(`[bench] region built in ${buildMs.toFixed(0)} ms\n${lines.join('\n')}`);

    for (const s of samples) {
      // Compact formats: 32 bytes per opaque/glass/water quad, 48 per plant quad.
      expect(s.bytes).toBe((s.opaque + s.glass + s.water) * 32 + s.plants * 48);
    }
    expect(level0.every((s) => s.opaque > 0)).toBe(true);
    expect(samples.find((s) => s.label === 'L0 wall windows')!.glass).toBeGreaterThan(0);
    const pond = samples.find((s) => s.label.startsWith('L0 pond'))!;
    expect(pond.water).toBeGreaterThan(0);
    expect(pond.plants).toBeGreaterThan(0);
    if (BENCH) expect(worst0).toBeLessThanOrEqual(LEVEL0_BUDGET_MS);
  });
});
