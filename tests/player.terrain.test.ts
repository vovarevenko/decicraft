/**
 * The player on real generated terrain: the 2×2 tiles around the map centre, where the town, the
 * forest, the meadow and the hills meet. Assertions are content-independent invariants (never inside
 * solids, smooth camera on the ground); speeds and timings are reported.
 */
import { describe, expect, test, vi } from 'vitest';
import { WORLD_SEED } from '../src/config';
import type { GameContext } from '../src/game/context';
import { bodyAABB, boxBlocked, makeAABB, type AABB } from '../src/game/physics';
import { Player } from '../src/game/player';
import { loadTile } from '../src/gen/generateWorld';
import { TileGenerator } from '../src/gen/nature/tileGenerator';
import { World } from '../src/world/world';

const DT = 1 / 60;
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);

const world = World.create();
const gen = new TileGenerator(WORLD_SEED);
for (const [tx, tz] of [
  [4, 4],
  [5, 4],
  [4, 5],
  [5, 5],
]) {
  loadTile(world, gen.generate(tx, tz));
}

function makeCtx() {
  const held = new Set<string>();
  const presses = new Set<string>();
  const input = {
    active: true,
    uiOpen: false,
    mouseDX: 0,
    mouseDY: 0,
    isDown: (code: string) => held.has(code),
    pressed: (code: string) => presses.has(code),
    consume: (code: string) => presses.delete(code),
  };
  const noSolids = (_region: AABB, out: AABB[] = []) => ((out.length = 0), out);
  const ctx = {
    world,
    input,
    audio: { play: vi.fn() },
    particles: { splash: vi.fn() },
    hud: { toast: vi.fn() },
    entities: { solidBoxes: noSolids },
  } as unknown as GameContext;
  return { ctx, held, presses };
}

interface Walk {
  /** Largest per-frame eye movement while on the ground in consecutive frames. */
  maxEyeStep: number;
  airborneShare: number;
  speed: number;
  embedded: number;
}

/** Walks from (x, z) along `yaw` with `keys` held; checks the body never ends a frame inside solids. */
function walk(x: number, z: number, yaw: number, seconds: number, keys: string[], jumpEvery = 0): Walk {
  const { ctx, held, presses } = makeCtx();
  const player = new Player({ x, y: world.floorBelow(x, 400, z, 400), z, yaw });
  for (let i = 0; i < 12; i++) player.update(DT, ctx);
  keys.forEach((k) => held.add(k));
  const box = makeAABB();
  const x0 = player.position.x;
  const z0 = player.position.z;
  const frames = Math.round(seconds / DT);
  let maxEyeStep = 0;
  let airborne = 0;
  let embedded = 0;
  let wasGrounded = player.onGround;
  let lastEye = player.eye.y;
  for (let i = 0; i < frames; i++) {
    if (jumpEvery > 0 && i % jumpEvery === 0) presses.add('Space');
    player.update(DT, ctx);
    presses.clear();
    if (boxBlocked(world, bodyAABB(player, box))) embedded++;
    if (player.onGround && wasGrounded) maxEyeStep = Math.max(maxEyeStep, Math.abs(player.eye.y - lastEye));
    if (!player.onGround) airborne++;
    wasGrounded = player.onGround;
    lastEye = player.eye.y;
  }
  const dx = player.position.x - x0;
  const dz = player.position.z - z0;
  return { maxEyeStep, airborneShare: airborne / frames, speed: Math.sqrt(dx * dx + dz * dz) / seconds, embedded };
}

describe('player on generated terrain', () => {
  test('stands still at the town entrance without drifting', () => {
    const { ctx } = makeCtx();
    const s = gen.plan.playerSpawn;
    const player = new Player({ ...s, y: world.floorBelow(s.x, s.y, s.z) });
    player.update(DT, ctx);
    const y = player.position.y;
    const eye = player.eye.y;
    for (let i = 0; i < 120; i++) player.update(DT, ctx);
    expect(player.onGround).toBe(true);
    expect(player.position.y).toBe(y);
    expect(player.eye.y).toBeCloseTo(eye, 6);
    expect(player.horizontalSpeed).toBe(0);
  });

  test('walking and sprinting in 8 directions from the map centre: never embedded, smooth camera', () => {
    const lines: string[] = [];
    for (const keys of [['KeyW'], ['KeyW', 'ShiftLeft']]) {
      for (let k = 0; k < 8; k++) {
        const yaw = (k * Math.PI) / 4;
        // ~100 units per run: every run stays on the generated tiles (x, z ∈ [512, 768)).
        const r = walk(640, 640, yaw, keys.length > 1 ? 1.4 : 2.5, keys);
        lines.push(`${keys.join('+')} yaw ${k * 45}°: ${r.speed.toFixed(1)} u/s, airborne ${(r.airborneShare * 100).toFixed(0)} %, eye step ≤ ${r.maxEyeStep.toFixed(2)}`);
        expect(r.embedded).toBe(0);
        expect(r.maxEyeStep).toBeLessThanOrEqual(1);
      }
    }
    console.info(`[player terrain]\n  ${lines.join('\n  ')}`);
  });

  test('jumping and mantling through the terrain (Space every 0.4 s) never embeds the body', () => {
    for (let k = 0; k < 4; k++) {
      const r = walk(600 + k * 25, 680 - k * 25, (k * Math.PI) / 2 + 0.3, 3, ['KeyW', 'Space'], 24);
      expect(r.embedded).toBe(0);
    }
  });

  test('cost of a sprinting frame on real terrain (reported; asserted only with BENCH)', () => {
    const { ctx, held } = makeCtx();
    const player = new Player({ x: 650, y: world.floorBelow(650, 400, 650, 400), z: 650, yaw: 0 });
    held.add('KeyW');
    held.add('ShiftLeft');
    // Turning 3 rad/s at sprint speed runs ~2.3 m circles: the run stays on the generated tiles.
    const frames = 2400;
    const step = () => {
      player.yaw += 0.05;
      player.update(DT, ctx);
    };
    for (let i = 0; i < 300; i++) step();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) step();
    const us = ((performance.now() - t0) * 1000) / frames;
    expect(Math.hypot(player.position.x - 650, player.position.z - 650)).toBeLessThan(60);
    console.info(`[player terrain] ${us.toFixed(1)} µs per sprinting frame`);
    expect(boxBlocked(world, bodyAABB(player, makeAABB()))).toBe(false);
    if (BENCH) expect(us).toBeLessThan(100);
  });
});
