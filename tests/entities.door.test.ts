import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import {
  Door,
  DOOR_SWING_S,
  doorHinge,
  doorLeafBox,
  doorLeafYaw,
  doorOpeningBox,
} from '../src/game/entities/door';
import { EntityManager } from '../src/game/entities/entityManager';
import { makeAABB } from '../src/game/physics';
import type { DoorSpawn } from '../src/gen/types';

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  return {
    // Leaf frame per the contract: hinge edge at the origin, width along +X, centred on Z.
    getDoorGeometry: (w: number, h: number) => new THREE.BoxGeometry(w, h, 0.4).translate(w / 2, h / 2, 0),
  };
});
vi.mock('../src/render/voxelModel', async () => {
  const THREE = await import('three');
  const material = new THREE.MeshStandardMaterial({ vertexColors: true });
  return { getModelMaterial: () => material };
});

const spawn = (axis: 'x' | 'z', hinge: 'min' | 'max', swing: 1 | -1, open = false): DoorSpawn => ({
  type: 'door',
  x: 100,
  y: 120,
  z: 200,
  axis,
  width: 9,
  height: 20,
  depth: 3,
  hinge,
  swing,
  style: 'wood',
  open,
});

/** World direction of the leaf's local +X for a yaw (three.js rotation about +Y). */
function leafDir(yaw: number): THREE.Vector3 {
  const o = new THREE.Object3D();
  o.rotation.y = yaw;
  o.updateMatrixWorld(true);
  return new THREE.Vector3(1, 0, 0).transformDirection(o.matrixWorld);
}

const combos: [axis: 'x' | 'z', hinge: 'min' | 'max', swing: 1 | -1][] = [];
for (const axis of ['x', 'z'] as const) for (const hinge of ['min', 'max'] as const) for (const swing of [1, -1] as const) combos.push([axis, hinge, swing]);

describe('door transform math', () => {
  test.each(combos)('axis %s, hinge %s, swing %i', (axis, hinge, swing) => {
    const s = spawn(axis, hinge, swing);
    const h = doorHinge(s);
    const alongX = axis === 'x';
    const axisDir = alongX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const normal = alongX ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);

    // Hinge on the requested end of the opening, in the middle of the wall depth.
    const hingeAlong = hinge === 'min' ? 0 : s.width;
    if (alongX) {
      expect(h.x).toBe(s.x + hingeAlong);
      expect(h.z).toBe(s.z + s.depth / 2);
    } else {
      expect(h.x).toBe(s.x + s.depth / 2);
      expect(h.z).toBe(s.z + hingeAlong);
    }

    // Closed: the leaf spans the opening from the hinge to the far jamb.
    const closed = leafDir(doorLeafYaw(h, 0));
    expect(closed.dot(axisDir)).toBeCloseTo(hinge === 'min' ? 1 : -1);
    const farEnd = new THREE.Vector3(h.x, 0, h.z).addScaledVector(closed, s.width);
    if (alongX) expect(farEnd.x).toBeCloseTo(s.x + (hinge === 'min' ? s.width : 0));
    else expect(farEnd.z).toBeCloseTo(s.z + (hinge === 'min' ? s.width : 0));

    // Open: a quarter turn, pointing into the swing side.
    expect(Math.abs(h.openTurn)).toBeCloseTo(Math.PI / 2);
    const open = leafDir(doorLeafYaw(h, 1));
    expect(open.dot(normal)).toBeCloseTo(swing);
    expect(open.dot(axisDir)).toBeCloseTo(0);

    // Half way: within the quarter between the closed and the open direction.
    const mid = leafDir(doorLeafYaw(h, 0.5));
    expect(mid.dot(closed)).toBeCloseTo(Math.SQRT1_2);
    expect(mid.dot(open)).toBeCloseTo(Math.SQRT1_2);

    // The open leaf's picking box lies on the swing side of the wall.
    const leaf = doorLeafBox(s, h, doorLeafYaw(h, 1), makeAABB());
    const wallMid = alongX ? s.z + s.depth / 2 : s.x + s.depth / 2;
    const lo = alongX ? leaf.minZ : leaf.minX;
    const hi = alongX ? leaf.maxZ : leaf.maxX;
    if (swing > 0) {
      expect(lo).toBeCloseTo(wallMid - 0.5);
      expect(hi).toBeCloseTo(wallMid + s.width + 0.5);
    } else {
      expect(lo).toBeCloseTo(wallMid - s.width - 0.5);
      expect(hi).toBeCloseTo(wallMid + 0.5);
    }
  });

  test('the easing is monotonic from closed to open', () => {
    const h = doorHinge(spawn('x', 'max', -1));
    let prev = doorLeafYaw(h, 0);
    for (let i = 1; i <= 20; i++) {
      const yaw = doorLeafYaw(h, i / 20);
      expect(Math.sign(yaw - prev) === Math.sign(h.openTurn) || yaw === prev).toBe(true);
      prev = yaw;
    }
    expect(prev).toBeCloseTo(h.closedYaw + h.openTurn);
  });

  test('opening box spans width × height × depth across the wall', () => {
    expect(doorOpeningBox(spawn('x', 'min', 1), makeAABB())).toEqual({ minX: 100, maxX: 109, minY: 120, maxY: 140, minZ: 200, maxZ: 203 });
    expect(doorOpeningBox(spawn('z', 'min', 1), makeAABB())).toEqual({ minX: 100, maxX: 103, minY: 120, maxY: 140, minZ: 200, maxZ: 209 });
  });
});

function makeCtx() {
  const scene = new THREE.Scene();
  const ctx = {
    entities: new EntityManager(scene),
    audio: { play: vi.fn() },
    hud: { toast: vi.fn() },
    player: { position: new THREE.Vector3(80, 120, 250), halfWidth: 3, height: 18 },
  };
  return { ctx: ctx as unknown as GameContext, audio: ctx.audio, hud: ctx.hud, player: ctx.player };
}

describe('Door entity', () => {
  test('the leaf mesh fills the opening in the middle of the wall', () => {
    const s = spawn('z', 'max', 1);
    const door = new Door(s);
    door.object.position.copy(door.position);
    door.object.updateMatrixWorld(true);
    const pivot = door.object.children[0];
    const hinge = pivot.localToWorld(new THREE.Vector3(0, 0, 0));
    const tip = pivot.localToWorld(new THREE.Vector3(s.width, s.height, 0));
    expect(hinge.toArray()).toEqual([expect.closeTo(101.5), expect.closeTo(120), expect.closeTo(209)]);
    expect(tip.toArray()).toEqual([expect.closeTo(101.5), expect.closeTo(140), expect.closeTo(200)]);
    const mesh = pivot.children[0] as THREE.Mesh;
    expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
  });

  test('toggle: solid while closed or swinging, open leaf not solid, sounds and hints', () => {
    const { ctx, audio } = makeCtx();
    const s = spawn('x', 'min', 1);
    const door = new Door(s);
    const opening = doorOpeningBox(s, makeAABB());
    expect(door.solid).toBe(true);
    expect(door.getBounds(makeAABB())).toEqual(opening);
    expect(door.hint()).toBe('E — открыть дверь');

    door.interact(ctx);
    expect(door.open).toBe(true);
    expect(audio.play).toHaveBeenCalledWith('door_open', expect.anything());
    expect(door.hint()).toBe('E — закрыть дверь');
    door.update(DOOR_SWING_S / 2, ctx);
    expect(door.solid).toBe(true);
    door.update(DOOR_SWING_S / 2 + 0.01, ctx);
    expect(door.solid).toBe(false);
    const leaf = door.getBounds(makeAABB());
    expect(leaf.minZ).toBeCloseTo(201.5 - 0.5); // the wall's middle (z 200 + depth 3 / 2) …
    expect(leaf.maxZ).toBeCloseTo(201.5 + 9 + 0.5); // … out into the swing side by the leaf width

    door.interact(ctx);
    expect(door.open).toBe(false);
    expect(door.solid).toBe(true); // closing blocks at once
    expect(door.getBounds(makeAABB())).toEqual(opening);
    door.update(DOOR_SWING_S / 2, ctx);
    expect(audio.play).not.toHaveBeenCalledWith('door_close', expect.anything());
    door.update(DOOR_SWING_S, ctx);
    expect(audio.play).toHaveBeenCalledWith('door_close', expect.anything());
    expect(door.object.children[0].rotation.y).toBeCloseTo(doorHinge(s).closedYaw);
  });

  test('a spawn with open = true starts open and passable', () => {
    const s = spawn('z', 'min', -1, true);
    const door = new Door(s);
    expect(door.open).toBe(true);
    expect(door.solid).toBe(false);
    const h = doorHinge(s);
    expect(door.object.children[0].rotation.y).toBeCloseTo(h.closedYaw + h.openTurn);
  });

  test('does not close on someone standing in the doorway', () => {
    const { ctx, hud, player } = makeCtx();
    const door = new Door(spawn('x', 'min', 1, true));
    player.position.set(104.5, 120, 201.5);
    door.interact(ctx);
    expect(door.open).toBe(true);
    expect(hud.toast).toHaveBeenCalledWith('Не закрыть: проём занят');
    player.position.set(104.5, 120, 215);
    door.interact(ctx);
    expect(door.open).toBe(false);
  });
});
