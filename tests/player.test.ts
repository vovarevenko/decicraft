import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { MOUSE_SENSITIVITY, PLAYER } from '../src/config';
import type { GameContext } from '../src/game/context';
import { bodyAABB, boxBlocked, makeAABB, type AABB } from '../src/game/physics';
import { Player } from '../src/game/player';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';

/** First air voxel above every test pad. */
const FLOOR = 100;
const DT = 1 / 60;
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.BENCH);
const world = World.create();

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** Grass pad (one voxel layer under FLOOR). Each test uses its own area. */
function pad(x0: number, z0: number, x1: number, z1: number, id: number = B.GRASS): void {
  fill(x0, FLOOR - 1, z0, x1, FLOOR, z1, id);
}

function makeCtx(solids: AABB[] = []) {
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
  const audio = { play: vi.fn() };
  const particles = { splash: vi.fn() };
  const hud = { toast: vi.fn() };
  const entities = {
    solidBoxes: (_region: AABB, out: AABB[] = []) => {
      out.length = 0;
      out.push(...solids);
      return out;
    },
  };
  const ctx = { world, input, audio, particles, hud, entities } as unknown as GameContext;
  /** Holds keys; `press` also makes them pressed this frame. */
  const hold = (...codes: string[]) => codes.forEach((c) => held.add(c));
  const release = (...codes: string[]) => codes.forEach((c) => held.delete(c));
  const press = (...codes: string[]) => codes.forEach((c) => (held.add(c), presses.add(c)));
  const tap = (code: string) => presses.add(code);
  const run = (player: Player, seconds: number, each?: (frame: number) => void) => {
    const frames = Math.round(seconds / DT);
    for (let i = 0; i < frames; i++) {
      player.update(DT, ctx);
      presses.clear();
      input.mouseDX = 0;
      input.mouseDY = 0;
      each?.(i);
    }
  };
  const sounds = (prefix: string) => audio.play.mock.calls.map((c) => c[0] as string).filter((s) => s.startsWith(prefix));
  return { ctx, input, audio, particles, hud, hold, release, press, tap, run, sounds };
}

/** A player standing on the floor at (x, z), settled. */
function standing(t: ReturnType<typeof makeCtx>, x: number, z: number, yaw = 0): Player {
  const player = new Player({ x, y: FLOOR, z, yaw });
  t.run(player, 0.2);
  expect(player.onGround).toBe(true);
  return player;
}

describe('Player basics', () => {
  test('the constructor places the body and the eye; applyToCamera copies them (Euler YXZ)', () => {
    const player = new Player({ x: 300, y: 120, z: 400, yaw: 1.2 });
    expect(player.position.toArray()).toEqual([300, 120, 400]);
    expect(player.yaw).toBe(1.2);
    expect(player.eye.toArray()).toEqual([300, 120 + PLAYER.eyeHeight, 400]);
    player.pitch = -0.3;
    const camera = new THREE.PerspectiveCamera();
    player.applyToCamera(camera);
    expect(camera.position.toArray()).toEqual(player.eye.toArray());
    expect(camera.rotation.order).toBe('YXZ');
    expect(camera.rotation.y).toBeCloseTo(1.2, 9);
    expect(camera.rotation.x).toBeCloseTo(-0.3, 9);
    // The camera looks where getLookDir says.
    camera.updateMatrixWorld();
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const look = player.getLookDir(new THREE.Vector3());
    expect(look.length()).toBeCloseTo(1, 9);
    expect(camDir.distanceTo(look)).toBeLessThan(1e-9);
  });

  test('mouse look: yaw −= dx·sensitivity, pitch −= dy·sensitivity clamped to ±89°', () => {
    pad(100, 100, 140, 140);
    const t = makeCtx();
    const player = standing(t, 120, 120);
    t.input.mouseDX = 100;
    t.input.mouseDY = -50;
    t.run(player, DT);
    expect(player.yaw).toBeCloseTo(-100 * MOUSE_SENSITIVITY, 9);
    expect(player.pitch).toBeCloseTo(50 * MOUSE_SENSITIVITY, 9);
    t.input.mouseDY = -100000;
    t.run(player, DT);
    expect(player.pitch).toBeCloseTo((89 * Math.PI) / 180, 9);
    t.input.active = false;
    t.input.mouseDX = 500;
    const yaw = player.yaw;
    t.run(player, DT);
    expect(player.yaw).toBe(yaw);
  });
});

describe('walking', () => {
  test('walks at walkSpeed ± 10 % on flat ground, with grass footsteps every ~0.55 m', () => {
    pad(100, 150, 140, 300);
    const t = makeCtx();
    const player = standing(t, 120, 290); // yaw 0: forward is −Z
    t.hold('KeyW');
    t.run(player, 0.5);
    const z0 = player.position.z;
    t.audio.play.mockClear();
    t.run(player, 1.5);
    const speed = (z0 - player.position.z) / 1.5;
    expect(speed).toBeGreaterThan(PLAYER.walkSpeed * 0.9);
    expect(speed).toBeLessThan(PLAYER.walkSpeed * 1.1);
    expect(player.horizontalSpeed).toBeCloseTo(PLAYER.walkSpeed, 1);
    expect(Math.abs(player.position.x - 120)).toBeLessThan(1e-6);
    const steps = t.sounds('step_');
    expect(steps.length).toBeGreaterThanOrEqual(Math.floor((speed * 1.5) / 5.5) - 1);
    expect(steps.length).toBeLessThanOrEqual(Math.ceil((speed * 1.5) / 5.5) + 1);
    expect(new Set(steps)).toEqual(new Set(['step_grass']));
    // Releasing the key stops quickly.
    t.release('KeyW');
    t.run(player, 0.3);
    expect(player.horizontalSpeed).toBe(0);
  });

  test('sprinting with ShiftLeft + W, footsteps match the surface', () => {
    pad(150, 150, 190, 400, B.ASPHALT);
    const t = makeCtx();
    const player = standing(t, 170, 390);
    t.hold('KeyW', 'ShiftLeft');
    t.run(player, 0.5);
    expect(player.sprinting).toBe(true);
    expect(player.horizontalSpeed).toBeCloseTo(PLAYER.sprintSpeed, 1);
    expect(new Set(t.sounds('step_'))).toEqual(new Set(['step_stone']));
    // Backwards is never a sprint.
    t.release('KeyW');
    t.hold('KeyS');
    t.run(player, 0.5);
    expect(player.sprinting).toBe(false);
    expect(player.horizontalSpeed).toBeCloseTo(PLAYER.walkSpeed, 1);
  });

  test('climbs a 3-voxel step without vertical camera jumps > 0.5 voxel per frame', () => {
    pad(200, 150, 240, 260);
    fill(200, FLOOR, 150, 240, FLOOR + 3, 200, B.DIRT); // step face at z = 200, walking −Z
    const t = makeCtx();
    const player = standing(t, 220, 230);
    t.hold('KeyW');
    let lastEye = player.eye.y;
    let maxJump = 0;
    t.run(player, 2, () => {
      maxJump = Math.max(maxJump, Math.abs(player.eye.y - lastEye));
      lastEye = player.eye.y;
    });
    expect(player.position.y).toBeCloseTo(FLOOR + 3, 2);
    expect(player.position.z).toBeLessThan(195);
    expect(maxJump).toBeLessThanOrEqual(0.5);
    expect(player.eye.y).toBeCloseTo(FLOOR + 3 + PLAYER.eyeHeight, 1);
  });

  test('walks down 1-voxel terraces without leaving the ground or a landing sound', () => {
    pad(250, 150, 290, 260);
    for (let i = 0; i < 6; i++) fill(250, FLOOR, 150, 290, FLOOR + 6 - i, 200 + i * 4, B.DIRT); // descending −Z → +Z
    const t = makeCtx();
    const player = new Player({ x: 270, y: FLOOR + 6, z: 175, yaw: Math.PI }); // yaw π: forward is +Z
    t.run(player, 0.2);
    t.hold('KeyW');
    let airborneFrames = 0;
    let maxJump = 0;
    let lastEye = player.eye.y;
    t.run(player, 1.5, () => {
      if (!player.onGround) airborneFrames++;
      maxJump = Math.max(maxJump, Math.abs(player.eye.y - lastEye));
      lastEye = player.eye.y;
    });
    expect(player.position.y).toBeCloseTo(FLOOR, 2);
    expect(airborneFrames).toBe(0);
    expect(maxJump).toBeLessThanOrEqual(0.5);
    expect(t.sounds('land')).toEqual([]);
  });

  test('collides with solid entity boxes (a closed door)', () => {
    pad(300, 150, 340, 260);
    const door: AABB = { minX: 300, maxX: 340, minY: FLOOR, maxY: FLOOR + 20, minZ: 200, maxZ: 200.4 };
    const t = makeCtx([door]);
    const player = standing(t, 320, 230);
    t.hold('KeyW', 'ShiftLeft');
    t.run(player, 2);
    expect(player.position.z - player.halfWidth).toBeGreaterThanOrEqual(door.maxZ);
    expect(player.position.z - player.halfWidth).toBeLessThan(door.maxZ + 0.01);
  });

  test('gravity runs while the input is inactive; the intent is dropped', () => {
    pad(350, 150, 390, 200);
    const t = makeCtx();
    const player = new Player({ x: 370, y: FLOOR + 30, z: 175, yaw: 0 });
    t.input.active = false;
    t.hold('KeyW', 'Space');
    t.run(player, 1.5);
    expect(player.onGround).toBe(true);
    expect(player.position.y).toBeCloseTo(FLOOR, 2);
    expect(player.position.z).toBeCloseTo(175, 9);
    expect(t.sounds('land')).toEqual(['land']);
  });

  test('stays inside the invisible walls 0.5 m from the map edges', () => {
    pad(0, 150, 20, 170);
    const t = makeCtx();
    const player = new Player({ x: 2, y: FLOOR, z: 160, yaw: Math.PI / 2 }); // yaw π/2: forward is −X
    t.hold('KeyW');
    t.run(player, 1);
    expect(player.position.x).toBe(5);
  });
});

test('a spawn whose footprint overlaps higher ground is lifted out on the first update', () => {
  pad(1200, 150, 1240, 200);
  fill(1218, FLOOR, 160, 1240, FLOOR + 2, 200, B.DIRT); // a 2-voxel bank under part of the footprint
  const t = makeCtx();
  const player = new Player({ x: 1216, y: FLOOR, z: 175, yaw: 0 }); // centre column on the low side
  expect(boxBlocked(world, bodyAABB(player, makeAABB()))).toBe(true);
  t.run(player, DT);
  expect(boxBlocked(world, bodyAABB(player, makeAABB()))).toBe(false);
  expect(player.position.y).toBeCloseTo(FLOOR + 2, 6);
  t.run(player, 0.5);
  expect(player.onGround).toBe(true);
  expect(player.eye.y).toBeCloseTo(FLOOR + 2 + PLAYER.eyeHeight, 1);
});

describe('jumping and crouching', () => {
  test('jump height ≈ 0.6 m, only from the ground, with coyote time after walking off an edge', () => {
    pad(400, 150, 440, 200);
    const t = makeCtx();
    const player = standing(t, 420, 175);
    t.press('Space');
    let apex = 0;
    t.run(player, 1, () => (apex = Math.max(apex, player.position.y - FLOOR)));
    expect(apex).toBeGreaterThan(5.5);
    expect(apex).toBeLessThan(6.2);
    expect(player.onGround).toBe(true);
    t.release('Space');

    // Mid-air presses do nothing (no double jump), but a press just before landing is buffered.
    t.press('Space');
    t.run(player, DT);
    t.release('Space');
    t.run(player, 0.45); // past the apex (≈ 0.35 s)
    t.press('Space');
    t.run(player, DT);
    t.release('Space');
    expect(player.onGround).toBe(false);
    expect(player.velocity.y).toBeLessThan(0);
    let frames = 0;
    while (player.position.y > FLOOR + 1.5 && frames++ < 60) t.run(player, DT);
    expect(player.onGround).toBe(false);
    t.press('Space');
    t.run(player, DT);
    t.release('Space');
    let rebounded = false;
    t.run(player, 0.12, () => (rebounded ||= player.velocity.y > 0));
    expect(rebounded).toBe(true);
    t.run(player, 1);
    expect(player.onGround).toBe(true);

    // Coyote time: a jump within 0.1 s after walking off a high ledge still works.
    fill(450, FLOOR - 1, 150, 490, FLOOR + 20, 175, B.STONE); // a 2 m high block, edge at z = 175
    pad(450, 175, 490, 200);
    const edge = new Player({ x: 470, y: FLOOR + 20, z: 172, yaw: Math.PI }); // forward +Z, off the edge
    t.run(edge, 0.2);
    t.hold('KeyW');
    let airborne = 0;
    while (edge.onGround && airborne < 200) {
      t.run(edge, DT);
      airborne++;
    }
    expect(edge.onGround).toBe(false);
    t.run(edge, 0.05);
    t.press('Space');
    t.run(edge, DT);
    expect(edge.velocity.y).toBeGreaterThan(0);
  });

  test('crouching lowers the eye, slows down and cannot stand up under a ceiling', () => {
    pad(500, 150, 540, 260);
    fill(500, FLOOR + 16, 150, 540, FLOOR + 17, 200, B.CONCRETE); // 1.6 m ceiling for z < 200
    const t = makeCtx();
    const player = standing(t, 520, 230);
    t.hold('KeyC');
    t.run(player, 0.5);
    expect(player.crouching).toBe(true);
    expect(player.height).toBe(PLAYER.crouchHeight);
    expect(player.eye.y).toBeCloseTo(FLOOR + PLAYER.crouchEyeHeight, 1);
    t.hold('KeyW');
    t.run(player, 0.5);
    expect(player.horizontalSpeed).toBeCloseTo(PLAYER.crouchSpeed, 1);
    t.run(player, 2); // now under the ceiling
    expect(player.position.z).toBeLessThan(195);
    t.release('KeyC', 'KeyW');
    t.run(player, 0.5);
    expect(player.crouching).toBe(true);
    // Back out into the open: stands up by itself.
    t.hold('KeyS');
    t.run(player, 2);
    expect(player.position.z).toBeGreaterThan(205);
    expect(player.crouching).toBe(false);
    expect(player.height).toBe(PLAYER.height);
  });

  test('crouching stops at a deep edge', () => {
    fill(550, FLOOR - 1, 150, 590, FLOOR + 20, 200, B.STONE); // edge at z = 150 (walking −Z), 2 m drop
    pad(550, 120, 590, 150);
    const t = makeCtx();
    const player = new Player({ x: 570, y: FLOOR + 20, z: 170, yaw: 0 });
    t.run(player, 0.2);
    t.hold('KeyC', 'KeyW');
    t.run(player, 3);
    expect(player.onGround).toBe(true);
    expect(player.position.y).toBeCloseTo(FLOOR + 20, 2);
    expect(player.position.z).toBeLessThan(153.5);
  });
});

describe('mantling', () => {
  /** A wall of height `h` whose face is at z = 200 (the player walks −Z into it). */
  function ledge(x0: number, h: number): void {
    pad(x0, 170, x0 + 40, 240);
    fill(x0, FLOOR, 170, x0 + 40, FLOOR + h, 200, B.BRICK);
  }

  test('holding Space against a 10-voxel ledge climbs onto it smoothly within mantleTime', () => {
    ledge(600, 10);
    const t = makeCtx();
    const player = standing(t, 620, 203.2);
    t.press('Space', 'KeyW');
    let lastEye = player.eye.y;
    let frames = 0;
    let maxEyeStep = 0;
    let embedded = 0;
    const box = makeAABB();
    t.run(player, 1, () => {
      if (player.position.y < FLOOR + 10 - 1e-6) frames++;
      if (boxBlocked(world, bodyAABB(player, box))) embedded++;
      maxEyeStep = Math.max(maxEyeStep, Math.abs(player.eye.y - lastEye));
      lastEye = player.eye.y;
    });
    expect(embedded).toBe(0); // the climb path never cuts through the ledge's corner
    expect(player.position.y).toBeCloseTo(FLOOR + 10, 2);
    expect(player.position.z).toBeLessThan(198);
    expect(player.onGround).toBe(true);
    expect(player.crouching).toBe(false);
    expect(frames * DT).toBeLessThanOrEqual(PLAYER.mantleTime + 2 * DT);
    expect(maxEyeStep).toBeLessThan(2);
  });

  test('a 14-voxel ledge cannot be mantled, not even mid-jump', () => {
    ledge(650, 14);
    const t = makeCtx();
    const player = standing(t, 670, 203.2);
    t.press('Space', 'KeyW');
    let highest = 0;
    t.run(player, 1.5, () => (highest = Math.max(highest, player.position.y - FLOOR)));
    expect(highest).toBeLessThan(6.5);
    expect(player.position.y).toBeCloseTo(FLOOR, 2);
    expect(player.position.z).toBeGreaterThan(200);
  });

  test('mantles mid-jump: a jump started away from the wall catches the ledge', () => {
    ledge(700, 11);
    const t = makeCtx();
    const player = standing(t, 720, 206);
    t.press('Space', 'KeyW');
    t.run(player, 1.2);
    expect(player.position.y).toBeCloseTo(FLOOR + 11, 2);
  });

  test('crouches automatically when only crouch height fits on the ledge', () => {
    ledge(750, 8);
    fill(750, FLOOR + 8 + 15, 150, 790, FLOOR + 8 + 16, 200, B.CONCRETE); // 1.5 m above the ledge top
    const t = makeCtx();
    const player = standing(t, 770, 203.2);
    t.press('Space', 'KeyW');
    t.run(player, 0.6);
    expect(player.position.y).toBeCloseTo(FLOOR + 8, 2);
    expect(player.crouching).toBe(true);
    expect(player.height).toBe(PLAYER.crouchHeight);
  });

  test('climbs through a window crouched and walks down into the room (no edge trap)', () => {
    // A 3-voxel wall (z 197…199) with a 12 × 14 window over a 9-voxel sill; the room floor is the pad.
    pad(1150, 150, 1190, 240);
    fill(1150, FLOOR, 197, 1190, FLOOR + 30, 200, B.BRICK);
    fill(1164, FLOOR + 9, 197, 1176, FLOOR + 23, 200, B.AIR);
    const t = makeCtx();
    const player = standing(t, 1170, 203.2);
    t.press('Space', 'KeyW');
    t.run(player, 0.5);
    expect(player.crouching).toBe(true);
    expect(player.position.y).toBeCloseTo(FLOOR + 9, 2);
    t.release('Space');
    let frames = 0;
    while (player.position.z > 185 && frames++ < 240) t.run(player, DT);
    t.release('KeyW');
    t.run(player, 0.5);
    expect(player.position.z).toBeLessThan(186);
    expect(player.position.y).toBeCloseTo(FLOOR, 2);
    expect(player.crouching).toBe(false);
  });

  test('climbs out of deep water onto a bank by holding Space towards it', () => {
    // Pool: floor at FLOOR − 30, water up to FLOOR; the bank (z < 200) rises 2 voxels above the water.
    fill(800, FLOOR - 31, 170, 840, FLOOR - 30, 240, B.STONE);
    fill(800, FLOOR - 30, 200, 840, FLOOR, 240, B.WATER);
    fill(800, FLOOR - 30, 170, 840, FLOOR + 2, 200, B.SAND);
    const t = makeCtx();
    const player = new Player({ x: 820, y: FLOOR - 10, z: 215, yaw: 0 });
    t.run(player, 3);
    expect(player.inWater).toBeGreaterThan(0.4);
    t.hold('Space', 'KeyW');
    let frames = 0;
    while (!(player.onGround && player.position.y > FLOOR) && frames++ < 240) t.run(player, DT);
    t.release('Space', 'KeyW');
    expect(player.position.z).toBeLessThan(200);
    expect(player.position.y).toBeCloseTo(FLOOR + 2, 2);
    expect(player.inWater).toBe(0);
  });
});

describe('water', () => {
  test('floats with the eyes above water, dives with C, rises with Space; splashes on a fast entry', () => {
    fill(850, FLOOR - 41, 120, 890, FLOOR - 40, 190, B.STONE);
    fill(850, FLOOR - 40, 120, 890, FLOOR, 190, B.WATER);
    const t = makeCtx();
    const player = new Player({ x: 870, y: FLOOR + 30, z: 170, yaw: 0 });
    t.run(player, 5);
    expect(t.particles.splash).toHaveBeenCalledTimes(1);
    expect(t.sounds('splash')).toEqual(['splash']);
    const [pos, strength] = t.particles.splash.mock.calls[0] as [THREE.Vector3, number];
    expect(pos.y).toBe(FLOOR);
    expect(strength).toBeGreaterThan(0.3);
    expect(strength).toBeLessThanOrEqual(1);
    expect(t.sounds('land')).toEqual([]);
    expect(player.inWater).toBeGreaterThan(0.6);
    expect(player.inWater).toBeLessThan(0.95);
    expect(player.eyeInWater).toBe(false);
    expect(Math.abs(player.velocity.y)).toBeLessThan(3);

    t.hold('KeyC');
    t.run(player, 1.5);
    expect(player.eyeInWater).toBe(true);
    expect(player.crouching).toBe(false);
    const depth = player.position.y;
    t.release('KeyC');
    t.hold('Space');
    t.run(player, 1);
    expect(player.position.y).toBeGreaterThan(depth + 5);
    t.release('Space');
    t.hold('KeyW');
    t.run(player, 0.8);
    expect(player.inWater).toBeGreaterThan(0.4);
    expect(player.horizontalSpeed).toBeCloseTo(PLAYER.swimSpeed, 0);
    expect(t.sounds('swim').length).toBeGreaterThan(0);
  });
});

describe('flight', () => {
  test('V toggles noclip flight: Space rises through ceilings, C descends, V lands again', () => {
    pad(900, 150, 940, 200);
    fill(900, FLOOR + 25, 150, 940, FLOOR + 27, 200, B.STONE);
    const t = makeCtx();
    const player = standing(t, 920, 175);
    t.tap('KeyV');
    t.run(player, DT);
    expect(player.flying).toBe(true);
    t.hold('Space');
    t.run(player, 1);
    expect(player.position.y).toBeGreaterThan(FLOOR + 40);
    expect(player.onGround).toBe(false);
    t.release('Space');
    t.run(player, 1);
    expect(Math.abs(player.velocity.y)).toBeLessThan(1);
    t.hold('KeyC');
    t.run(player, 0.15);
    expect(player.velocity.y).toBeLessThan(-30);
    expect(player.crouching).toBe(false);
    t.release('KeyC');
    t.run(player, 1);
    t.tap('KeyV');
    t.run(player, 3);
    expect(player.flying).toBe(false);
    expect(player.onGround).toBe(true);
    expect(player.position.y).toBeCloseTo(FLOOR + 27, 2); // on top of the slab it flew through
  });

  test('leaving flight inside rock rises to free space nearby, or stays airborne with a hint', () => {
    fill(950, FLOOR - 1, 150, 990, FLOOR + 10, 200, B.STONE);
    const t = makeCtx();
    const player = new Player({ x: 970, y: FLOOR + 10, z: 175, yaw: 0 });
    t.tap('KeyV');
    t.run(player, DT);
    player.position.y = FLOOR + 2; // buried 8 voxels deep
    t.tap('KeyV');
    t.run(player, DT);
    expect(player.flying).toBe(false);
    t.run(player, 0.5);
    expect(player.position.y).toBeCloseTo(FLOOR + 10, 2);

    fill(950, FLOOR + 10, 150, 990, FLOOR + 80, 200, B.STONE);
    t.tap('KeyV');
    t.run(player, DT);
    player.position.y = FLOOR + 20; // 60 voxels under the surface
    t.tap('KeyV');
    t.run(player, DT);
    expect(player.flying).toBe(true);
    expect(t.hud.toast).toHaveBeenCalledTimes(1);
  });
});

test('performance: a walking frame (reported; asserted only with BENCH)', () => {
  pad(1000, 150, 1100, 400);
  for (let i = 0; i < 60; i++) fill(1000 + ((i * 37) % 95), FLOOR, 150 + ((i * 53) % 245), 1003 + ((i * 37) % 95), FLOOR + 1 + (i % 4), 153 + ((i * 53) % 245), B.DIRT);
  const t = makeCtx();
  const player = standing(t, 1050, 390);
  t.hold('KeyW', 'ShiftLeft');
  const frames = 3000;
  const t0 = performance.now();
  t.run(player, frames * DT, (i) => {
    if (i % 100 === 0) player.yaw += 0.7;
  });
  const us = ((performance.now() - t0) * 1000) / frames;
  console.info(`[player] update: ${us.toFixed(1)} µs per frame`);
  if (BENCH) expect(us).toBeLessThan(200);
});
