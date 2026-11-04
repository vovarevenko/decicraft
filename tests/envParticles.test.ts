import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { CubeSim, SPLAT_TIME, SpriteSim, makeCubeParams, makeSpriteParams } from '../src/render/env/particleSim';
import { Particles } from '../src/render/particles';
import { B } from '../src/world/blocks';
import type { WorldData } from '../src/world/world';

/** Stone below `groundY`, air above, plus explicit voxels. */
class FakeWorld {
  private readonly blocks = new Map<string, number>();
  constructor(private readonly groundY = 100) {}
  getBlock(x: number, y: number, z: number): number {
    const id = this.blocks.get(`${x},${y},${z}`);
    if (id !== undefined) return id;
    return y < this.groundY ? B.STONE : B.AIR;
  }
  set(x: number, y: number, z: number, id: number): void {
    this.blocks.set(`${x},${y},${z}`, id);
  }
}

const DT = 1 / 60;
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);

function run(sim: CubeSim, world: FakeWorld, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) sim.step(DT, world);
}

function cube(x: number, y: number, z: number, life = 5) {
  const p = makeCubeParams();
  p.x = x;
  p.y = y;
  p.z = z;
  p.life = life;
  return p;
}

describe('CubeSim bookkeeping', () => {
  test('expired particles are swap-removed, the others keep their state', () => {
    const sim = new CubeSim(8);
    const world = new FakeWorld(0);
    sim.spawn(cube(1, 50, 0, 1));
    sim.spawn(cube(2, 50, 0, 0.05));
    sim.spawn(cube(3, 50, 0, 1));
    expect(sim.count).toBe(3);
    sim.step(0.1, world);
    expect(sim.count).toBe(2);
    expect([sim.px[0], sim.px[1]].sort()).toEqual([1, 3]);
    expect(sim.maxLife[0]).toBe(1);
    expect(sim.maxLife[1]).toBe(1);
    run(sim, world, 1);
    expect(sim.count).toBe(0);
  });

  test('a full pool overwrites its oldest slots round-robin', () => {
    const sim = new CubeSim(4);
    for (let i = 0; i < 6; i++) sim.spawn(cube(i, 50, 0));
    expect(sim.count).toBe(4);
    expect(Array.from(sim.px.subarray(0, 4))).toEqual([4, 5, 2, 3]);
  });

  test('particles shrink out over the end of their life', () => {
    const sim = new CubeSim(1);
    sim.spawn(cube(0, 50, 0, 1));
    expect(sim.scale(0)).toBe(1);
    sim.step(0.5, new FakeWorld(0));
    expect(sim.scale(0)).toBe(1);
    sim.step(0.4, new FakeWorld(0));
    expect(sim.scale(0)).toBeGreaterThan(0);
    expect(sim.scale(0)).toBeLessThan(0.5);
  });
});

describe('CubeSim physics', () => {
  test('falls, bounces and comes to rest on top of the ground', () => {
    const sim = new CubeSim(1);
    const world = new FakeWorld(100);
    const p = cube(5.5, 108, 5.5);
    p.vy = -30;
    sim.spawn(p);
    let bounced = false;
    for (let t = 0; t < 3; t += DT) {
      const before = sim.vy[0];
      sim.step(DT, world);
      if (before < 0 && sim.vy[0] > 0) bounced = true;
      expect(sim.py[0]).toBeGreaterThanOrEqual(100);
    }
    expect(bounced).toBe(true);
    expect(sim.isResting(0)).toBe(true);
    expect(sim.py[0]).toBeCloseTo(100 + p.size / 2, 5);
  });

  test('foliage is not solid: debris falls through leaves onto the ground', () => {
    const sim = new CubeSim(1);
    const world = new FakeWorld(100);
    for (let y = 100; y < 106; y++) world.set(5, y, 5, B.OAK_LEAVES);
    sim.spawn(cube(5.5, 110, 5.5));
    run(sim, world, 3);
    expect(sim.isResting(0)).toBe(true);
    expect(sim.py[0]).toBeCloseTo(100 + 0.35 / 2, 5);
  });

  test('a resting particle falls again when the voxel under it disappears', () => {
    const sim = new CubeSim(1);
    const world = new FakeWorld(90);
    world.set(5, 100, 5, B.DIRT);
    sim.spawn(cube(5.5, 103, 5.5));
    run(sim, world, 2);
    expect(sim.isResting(0)).toBe(true);
    expect(sim.py[0]).toBeCloseTo(101 + 0.35 / 2, 5);
    world.set(5, 100, 5, B.AIR);
    run(sim, world, 2);
    expect(sim.py[0]).toBeCloseTo(90 + 0.35 / 2, 5);
  });

  test('bounces off walls', () => {
    const sim = new CubeSim(1);
    const world = new FakeWorld(0);
    world.set(5, 101, 5, B.BRICK);
    const p = cube(4.9, 101.5, 5.5);
    p.vx = 12;
    p.gravity = 0;
    sim.spawn(p);
    sim.step(DT, world);
    expect(sim.vx[0]).toBeLessThan(0);
    expect(sim.px[0]).toBeLessThan(5);
  });

  test('droplets vanish on landing and in water', () => {
    const sim = new CubeSim(2);
    const world = new FakeWorld(100);
    world.set(20, 101, 20, B.WATER);
    const ground = cube(5.5, 103, 5.5, 5);
    ground.diesOnLanding = true;
    sim.spawn(ground);
    const water = cube(20.5, 101.5, 20.5, 5);
    water.diesOnLanding = true;
    sim.spawn(water);
    sim.step(DT, world);
    expect(sim.count).toBe(2);
    run(sim, world, SPLAT_TIME + 0.05);
    expect(sim.count).toBe(1); // the one in water is gone
    run(sim, world, 1);
    expect(sim.count).toBe(0); // the other one landed and splatted long before its 5 s life
  });
});

describe('SpriteSim', () => {
  test('buoyancy, drag, age and removal', () => {
    const sim = new SpriteSim(4);
    const q = makeSpriteParams();
    q.life = 2;
    q.vx = 10;
    q.rise = 5;
    q.drag = 1;
    q.rot = 0.5;
    sim.spawn(q);
    expect(sim.rot[0]).toBe(0.5);
    for (let i = 0; i < 60; i++) sim.step(DT);
    expect(sim.vy[0]).toBeGreaterThan(0);
    expect(sim.vx[0]).toBeLessThan(10 * Math.exp(-0.9));
    expect(sim.py[0]).toBeGreaterThan(0);
    expect(sim.age(0)).toBeCloseTo(0.5, 3);
    for (let i = 0; i < 61; i++) sim.step(DT);
    expect(sim.count).toBe(0);
  });

  test('a full pool overwrites round-robin', () => {
    const sim = new SpriteSim(3);
    const q = makeSpriteParams();
    for (let i = 0; i < 5; i++) {
      q.x = i;
      sim.spawn(q);
    }
    expect(sim.count).toBe(3);
    expect(Array.from(sim.px.subarray(0, 3))).toEqual([3, 4, 2]);
  });
});

describe('Particles (no WebGL)', () => {
  function setup() {
    const scene = new THREE.Scene();
    const world = new FakeWorld(100);
    const particles = new Particles(scene, world as unknown as WorldData);
    const debris = scene.getObjectByName('particles-debris') as THREE.InstancedMesh;
    const clear = scene.getObjectByName('particles-clear') as THREE.InstancedMesh;
    const flames = scene.getObjectByName('particles-flames') as THREE.Mesh;
    const haze = scene.getObjectByName('particles-haze') as THREE.Mesh;
    return { scene, world, particles, debris, clear, flames, haze };
  }

  test('creates one hidden mesh per pool', () => {
    const { scene, debris, clear, flames, haze } = setup();
    expect(scene.children.length).toBe(4);
    for (const m of [debris, clear, flames, haze]) {
      expect(m).toBeDefined();
      expect(m.visible).toBe(false);
      expect(m.frustumCulled).toBe(false);
    }
    expect(debris.instanceColor).not.toBeNull();
    expect(clear.instanceColor).not.toBeNull();
  });

  test('a knock chips the hit face; a broken voxel scatters from its cell', () => {
    const { particles, debris } = setup();
    particles.blockBreak(10, 99, 10, B.GRASS, 6, { x: 0, y: 1, z: 0 });
    expect(particles.counts.debris).toBe(6);
    particles.update(0);
    expect(debris.visible).toBe(true);
    expect(debris.count).toBe(6);
    // Only the live prefix is uploaded.
    expect(debris.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 6 * 16 }]);
    expect(debris.instanceColor!.updateRanges).toEqual([{ start: 0, count: 6 * 3 }]);
    const m = debris.instanceMatrix.array;
    for (let i = 0; i < 6; i++) {
      expect(m[i * 16 + 13]).toBeGreaterThan(100); // above the (intact) top face
      expect(m[i * 16 + 12]).toBeGreaterThanOrEqual(10);
      expect(m[i * 16 + 12]).toBeLessThanOrEqual(11);
    }
    const c = debris.instanceColor!.array;
    for (let i = 0; i < 6 * 3; i++) {
      expect(c[i]).toBeGreaterThan(0);
      expect(c[i]).toBeLessThan(1);
    }

    particles.blockBreak(20, 110, 20, B.DIRT, 4);
    particles.update(0);
    expect(debris.count).toBe(10);
    for (let i = 6; i < 10; i++) {
      expect(m[i * 16 + 12]).toBeGreaterThan(20);
      expect(m[i * 16 + 12]).toBeLessThan(21);
      expect(m[i * 16 + 13]).toBeGreaterThan(110);
      expect(m[i * 16 + 13]).toBeLessThan(111);
    }
  });

  test('glass breaks into flat translucent shards; air, water and empty counts emit nothing', () => {
    const { particles, clear } = setup();
    particles.blockBreak(3, 110, 3, B.GLASS, 5, { x: 1, y: 0, z: 0 });
    particles.blockBreak(3, 110, 3, B.AIR, 5);
    particles.blockBreak(3, 110, 3, B.WATER, 5);
    particles.blockBreak(3, 110, 3, B.STONE, 0);
    expect(particles.counts).toEqual({ debris: 0, clear: 5, flames: 0, haze: 0 });
    particles.update(0);
    const m = clear.instanceMatrix.array;
    for (let i = 0; i < 5; i++) {
      const o = i * 16;
      const sx = Math.hypot(m[o], m[o + 1], m[o + 2]);
      const sy = Math.hypot(m[o + 4], m[o + 5], m[o + 6]);
      expect(sy).toBeLessThan(sx * 0.3);
    }
    const c = clear.instanceColor!.array;
    expect(Math.min(c[0], c[1], c[2])).toBeGreaterThan(0.4); // light, near white
  });

  test('splash, dust, fire and burst fill their pools; everything drains and hides again', () => {
    const { world, particles, debris, clear, flames, haze } = setup();
    world.set(50, 100, 50, B.WATER);
    world.set(50, 101, 50, B.WATER);
    particles.splash({ x: 50.5, y: 101.2, z: 50.5 }, 1);
    expect(particles.counts.clear).toBe(40);
    expect(particles.counts.haze).toBe(6);
    particles.update(0);
    const drops = clear.instanceMatrix.array;
    for (let i = 0; i < 40; i++) expect(drops[i * 16 + 13]).toBeGreaterThanOrEqual(102); // above the water surface

    particles.dust({ x: 30, y: 100, z: 30 }, 8);
    expect(particles.counts.haze).toBeGreaterThanOrEqual(6 + 4);
    expect(particles.counts.haze).toBeLessThanOrEqual(6 + 14);
    const specks = particles.counts.debris;
    expect(specks).toBeGreaterThanOrEqual(3);
    particles.update(0);
    const col = debris.instanceColor!.array;
    for (let i = 0; i < specks; i++) {
      // Specks of the stone the puff landed on: grey, no channel far from the others.
      expect(Math.max(col[i * 3], col[i * 3 + 1], col[i * 3 + 2]) - Math.min(col[i * 3], col[i * 3 + 1], col[i * 3 + 2])).toBeLessThan(0.05);
    }

    particles.burst({ x: 0, y: 120, z: 0 }, { color: [0xff0000, 0x00ff00], count: 12, dir: { x: 0, y: 0, z: 0 } });
    particles.burst({ x: 0, y: 120, z: 0 }, { color: [], count: 12 });
    expect(particles.counts.debris).toBe(specks + 12);
    particles.update(0);
    for (let i = specks; i < specks + 12; i++) {
      const rgb = [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]];
      expect(rgb).toSatisfy((v: number[]) => (v[0] === 1 && v[1] === 0) || (v[0] === 0 && v[1] === 1));
    }

    for (let f = 0; f < 120; f++) {
      particles.fire({ x: 10, y: 100.6, z: 10 }, DT);
      particles.update(DT);
    }
    const counts = particles.counts;
    expect(counts.flames).toBeGreaterThan(10);
    expect(counts.flames).toBeLessThan(200);
    expect(flames.visible).toBe(true);
    const flameGeometry = flames.geometry as THREE.InstancedBufferGeometry;
    expect(flameGeometry.instanceCount).toBe(counts.flames);
    const ps = flameGeometry.getAttribute('iPosSize').array;
    for (let i = 0; i < counts.flames; i++) {
      expect(ps[i * 4 + 1]).toBeGreaterThan(100); // above the fire's base, rising
      expect(ps[i * 4 + 3]).toBeGreaterThan(0);
    }
    particles.fire({ x: 10, y: 100.6, z: 10 }, 0);
    particles.fire({ x: 10, y: 100.6, z: 10 }, DT, 0);
    expect(particles.counts.flames).toBe(counts.flames);

    for (let f = 0; f < 60 * 8; f++) particles.update(DT);
    expect(particles.counts).toEqual({ debris: 0, clear: 0, flames: 0, haze: 0 });
    for (const m of [debris, clear, flames, haze]) expect(m.visible).toBe(false);
    expect((haze.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
  });

  test('update cost with full pools (timing reported; asserted only with BENCH)', () => {
    // A world as cheap to query as WorldData.getBlock (the Map-backed fake would dominate the timing).
    const flat = { getBlock: (_x: number, y: number) => (y < 100 ? B.STONE : B.AIR) };
    const particles = new Particles(new THREE.Scene(), flat as unknown as WorldData);
    for (let i = 0; i < 400; i++) particles.blockBreak(10 + (i % 20), 110, 10 + Math.floor(i / 20), B.DIRT, 8);
    for (let i = 0; i < 40; i++) particles.splash({ x: 5, y: 101, z: 5 }, 1);
    for (let i = 0; i < 50; i++) particles.fire({ x: 30, y: 100.5, z: 30 }, 0.25);
    const counts = particles.counts;
    expect(counts.debris).toBe(3000);
    const frames = 60;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) particles.update(DT);
    const ms = (performance.now() - t0) / frames;
    console.info(`[particles] update with ${JSON.stringify(counts)}: ${ms.toFixed(3)} ms/frame`);
    if (BENCH) expect(ms).toBeLessThan(1.5);
  });
});
