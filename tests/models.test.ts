import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { srgbToLinear } from '../src/core/math';
import { ITEM_LIST, ITEMS } from '../src/game/items';
import type { ContainerStyle, DoorStyle } from '../src/gen/types';
import {
  getCampfireGeometry,
  getContainerModel,
  getDoorGeometry,
  getHandGeometry,
  getItemGeometry,
  getItemHoldPose,
  getMobRig,
  type MobRig,
} from '../src/render/models';
import { Sculpt } from '../src/render/models/sculpt';
import { buildVoxelGeometry, EMPTY, getModelMaterial, VoxelGrid } from '../src/render/voxelModel';
import { BLOCKS } from '../src/world/blocks';

const quads = (g: THREE.BufferGeometry): number => g.index!.count / 6;
const triangles = (g: THREE.BufferGeometry): number => g.index!.count / 3;
const size = (g: THREE.BufferGeometry): THREE.Vector3 => g.boundingBox!.getSize(new THREE.Vector3());

/** Vertex colours of the vertices whose normal equals n (and, optionally, that satisfy `where`). */
function colorsOn(g: THREE.BufferGeometry, n: [number, number, number], where?: (p: THREE.Vector3) => boolean): number[][] {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const col = g.getAttribute('color');
  const p = new THREE.Vector3();
  const out: number[][] = [];
  for (let i = 0; i < pos.count; i++) {
    if (nrm.getX(i) !== n[0] || nrm.getY(i) !== n[1] || nrm.getZ(i) !== n[2]) continue;
    p.fromBufferAttribute(pos, i);
    if (where && !where(p)) continue;
    out.push([col.getX(i), col.getY(i), col.getZ(i)]);
  }
  return out;
}

describe('VoxelGrid', () => {
  test('box fills the half-open cell range, a negative colour carves', () => {
    const g = new VoxelGrid(4, 4, 4);
    g.box(0, 0, 0, 2, 3, 4, 0x112233);
    expect(g.count()).toBe(24);
    expect(g.get(1, 2, 3)).toBe(0x112233);
    expect(g.filled(2, 0, 0)).toBe(false);
    g.box(0, 0, 0, 1, 1, 1, EMPTY);
    expect(g.count()).toBe(23);
    g.set(9, 9, 9, 0xffffff); // out of bounds: ignored
    expect(g.count()).toBe(23);
    expect(g.get(-1, 0, 0)).toBe(0);
  });

  test('colour functions get integer cells; black (0x000000) is a real colour', () => {
    const g = new VoxelGrid(3, 1, 1);
    g.box(0, 0, 0, 3, 1, 1, (x) => x * 0x10);
    expect([g.filled(0, 0, 0), g.get(0, 0, 0), g.get(2, 0, 0)]).toEqual([true, 0, 0x20]);
  });

  test('ellipsoid, capsule and sdf fill cells by their centres', () => {
    const g = new VoxelGrid(9, 9, 9);
    g.ellipsoid(4.5, 4.5, 4.5, 3, 3, 3, 1);
    // A sphere of radius 3 holds 4/3·π·27 ≈ 113 cell centres (lattice count 123).
    expect(g.count()).toBe(123);
    const c = new VoxelGrid(5, 12, 5);
    c.capsule(2.5, 2, 2.5, 2.5, 10, 2.5, 1.5, 1.5, 1, true);
    expect(c.count()).toBe(9 * 8); // a 3×3 cross-section over y ∈ [2, 10)
    const r = new VoxelGrid(5, 12, 5);
    r.capsule(2.5, 2, 2.5, 2.5, 10, 2.5, 1.5, 1.5, 1);
    expect(r.count()).toBeGreaterThan(c.count()); // round ends
    const s = new VoxelGrid(6, 6, 6);
    s.sdf((x, y, z) => x - 3, 1, [0, 0, 0, 6, 2, 6]); // x < 3, but only y ∈ [0, 2)
    expect(s.count()).toBe(3 * 2 * 6);
  });

  test('Sculpt addresses cells relative to the model origin', () => {
    const s = new Sculpt(-5, 0, -5, 5, 10, 5);
    s.box(-5, 0, -5, 5, 1, 5, 0x808080);
    expect(s.filled(-5, 0, -5)).toBe(true);
    expect(s.get(4, 0, 4)).toBe(0x808080);
    expect(s.get(4, 1, 4)).toBe(0);
    expect(s.grid.count()).toBe(100);
    const geo = s.build(0);
    expect(geo.boundingBox!.min.toArray()).toEqual([-0.5, 0, -0.5]);
    expect(geo.boundingBox!.max.toArray()).toEqual([0.5, 0.1, 0.5].map((v) => Math.fround(v)));
  });
});

describe('buildVoxelGeometry', () => {
  test('one cell → 6 quads (24 vertices, 36 indices), linear colours, bottom-centre origin', () => {
    const g = new VoxelGrid(1, 1, 1);
    g.set(0, 0, 0, 0x808080);
    const geo = buildVoxelGeometry(g, { jitter: 0 });
    expect(geo.getAttribute('position').count).toBe(24);
    expect(geo.index!.count).toBe(36);
    expect(geo.index!.array).toBeInstanceOf(Uint16Array);
    expect(geo.boundingBox!.min.toArray()).toEqual([-0.05, 0, -0.05].map((v) => Math.fround(v)));
    const lin = srgbToLinear(128 / 255);
    const col = geo.getAttribute('color').array as Float32Array;
    for (const c of col) expect(c).toBeCloseTo(lin, 5);
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as [number, number, number][]) {
      expect(colorsOn(geo, n)).toHaveLength(4);
    }
  });

  test('2×1×1 of one colour merges into 6 quads; two colours do not merge', () => {
    const g = new VoxelGrid(2, 1, 1);
    g.box(0, 0, 0, 2, 1, 1, 0x808080);
    expect(quads(buildVoxelGeometry(g, { jitter: 0 }))).toBe(6);
    g.set(1, 0, 0, 0x404040);
    expect(quads(buildVoxelGeometry(g, { jitter: 0 }))).toBe(10);
  });

  test('a flat plate merges into one quad per side without jitter, jitter varies colours deterministically', () => {
    const g = new VoxelGrid(10, 1, 10);
    g.box(0, 0, 0, 10, 1, 10, 0x6080a0);
    expect(quads(buildVoxelGeometry(g, { jitter: 0 }))).toBe(6);
    const a = buildVoxelGeometry(g, { jitter: 0.05 });
    const b = buildVoxelGeometry(g, { jitter: 0.05 });
    expect(Array.from(a.getAttribute('color').array)).toEqual(Array.from(b.getAttribute('color').array));
    const tones = new Set(colorsOn(a, [0, 1, 0]).map((c) => c[0].toFixed(5)));
    expect(tones.size).toBe(3); // darker, unchanged, brighter
  });

  test('AO darkens the vertices of a concave corner', () => {
    // Floor of three cells with one cell standing on its left end.
    const g = new VoxelGrid(3, 2, 1);
    g.box(0, 0, 0, 3, 1, 1, 0x808080);
    g.set(0, 1, 0, 0x808080);
    const geo = buildVoxelGeometry(g, { jitter: 0, scale: 1, origin: [0, 0, 0] });
    const atCorner = colorsOn(geo, [0, 1, 0], (p) => p.y === 1 && p.x === 1);
    const open = colorsOn(geo, [0, 1, 0], (p) => p.y === 1 && p.x === 3);
    expect(atCorner.length).toBeGreaterThan(0);
    expect(open.length).toBeGreaterThan(0);
    for (const c of atCorner) expect(c[0]).toBeLessThan(open[0][0] * 0.9);
    const flat = buildVoxelGeometry(g, { jitter: 0, scale: 1, origin: [0, 0, 0], ao: false });
    const lit = colorsOn(flat, [0, 1, 0], (p) => p.y === 1 && p.x === 1);
    for (const c of lit) expect(c[0]).toBeCloseTo(open[0][0], 6);
  });

  test('origin and scale place the geometry; bounds match three.js computing them', () => {
    const g = new VoxelGrid(4, 3, 2);
    g.ellipsoid(2, 1.5, 1, 2, 1.5, 1, 0x80a040);
    const geo = buildVoxelGeometry(g, { scale: 2, origin: [1, 0, 1] });
    const check = geo.clone();
    check.computeBoundingBox();
    check.computeBoundingSphere();
    expect(geo.boundingBox!.equals(check.boundingBox!)).toBe(true);
    expect(geo.boundingSphere!.center.distanceTo(check.boundingSphere!.center)).toBeLessThan(1e-9);
    expect(geo.boundingSphere!.radius).toBeCloseTo(check.boundingSphere!.radius, 9);
    expect(geo.boundingBox!.min.x).toBe(-2);
  });

  test('large meshes switch to 32-bit indices; empty grids give an empty geometry', () => {
    const g = new VoxelGrid(30, 30, 10);
    for (let z = 0; z < 10; z++) for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) if ((x + y + z) % 2 === 0) g.set(x, y, z, 0x808080);
    const geo = buildVoxelGeometry(g);
    expect(geo.getAttribute('position').count).toBeGreaterThan(65535);
    expect(geo.index!.array).toBeInstanceOf(Uint32Array);
    const empty = buildVoxelGeometry(new VoxelGrid(3, 3, 3));
    expect(empty.index!.count).toBe(0);
    expect(empty.boundingSphere!.radius).toBe(0);
  });

  test('the shared model material is one lit MeshLambertMaterial with vertex colours', () => {
    const m = getModelMaterial();
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect((m as THREE.MeshLambertMaterial).vertexColors).toBe(true);
    expect(getModelMaterial()).toBe(m);
  });
});

/** Real sizes [x, y, z] in cm of the non-material items as modelled (tools upright, flat things lying). */
const REAL_CM: Readonly<Record<string, [number, number, number]>> = {
  stone_axe: [16, 46, 5],
  axe: [19, 62, 5],
  shovel: [20, 148, 7],
  pickaxe: [45, 80, 5],
  flashlight: [5, 20, 5],
  torch: [7, 50, 7],
  stick: [5, 45, 5],
  rope: [20, 4, 20],
  cloth: [22, 3, 16],
  hide: [62, 3, 46],
  grass_fiber: [10, 30, 10],
  flower: [8, 27, 7],
  reed: [10, 72, 10],
  mushroom: [10, 10, 10],
  apple: [7, 8.5, 7],
  canned_food: [10, 8, 10],
  meat_raw: [14, 5, 10],
  meat_cooked: [13, 4, 9],
  newspaper: [30, 1.5, 21],
  campfire: [60, 36, 60],
};

describe('item models', () => {
  test('every item id has a model at its real size (±25 %, ±2.5 cm on thin sides) within ~6k triangles', () => {
    for (const def of ITEM_LIST) {
      const geo = getItemGeometry(def.id);
      const real = def.block !== undefined ? [10, 10, 10] : REAL_CM[def.id];
      expect(real, def.id).toBeDefined();
      const s = size(geo).multiplyScalar(10).toArray();
      for (let a = 0; a < 3; a++) {
        const tolerance = real[a] >= 10 ? real[a] * 0.25 : 2.5;
        expect(Math.abs(s[a] - real[a]), `${def.id} axis ${a}: ${s[a]} cm vs ${real[a]} cm`).toBeLessThanOrEqual(tolerance);
      }
      expect(triangles(geo), def.id).toBeLessThanOrEqual(6000);
    }
  });

  test('tools stand on their grip, other items on their bottom centre', () => {
    for (const def of ITEM_LIST) {
      const box = getItemGeometry(def.id).boundingBox!;
      if (def.kind === 'tool' || def.light) {
        expect(box.min.y, def.id).toBeLessThan(-0.5); // the handle goes on below the hand
      } else {
        // Centred up to side twigs, stalks and loose ends (≤ 2 cm off).
        expect(box.min.y, def.id).toBeCloseTo(0, 6);
        expect(Math.abs(box.min.x + box.max.x) / 2, def.id).toBeLessThan(0.201);
        expect(Math.abs(box.min.z + box.max.z) / 2, def.id).toBeLessThan(0.201);
      }
    }
  });

  test('material cubes: 10 cm, top layer in the block top colour, bottom in the bottom colour', () => {
    const sod = ITEMS.sod;
    const def = BLOCKS[sod.block!];
    const geo = getItemGeometry('sod');
    const mean = (cs: number[][]): number[] => [0, 1, 2].map((i) => cs.reduce((s, c) => s + c[i], 0) / cs.length);
    const top = mean(colorsOn(geo, [0, 1, 0]));
    const bottom = mean(colorsOn(geo, [0, -1, 0]));
    const lin = (hex: number): number[] => [hex >> 16, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255));
    const near = (a: number[], b: number[]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]) / Math.max(b[i], 0.02)));
    expect(near(top, lin(def.top!))).toBeLessThan(0.25);
    expect(near(bottom, lin(def.bottom!))).toBeLessThan(0.25);
    expect(top[1]).toBeGreaterThan(top[0]); // green on top
    expect(bottom[0]).toBeGreaterThan(bottom[1] * 0.9); // brown soil below
  });

  test('models are cached; unknown ids throw', () => {
    expect(getItemGeometry('axe')).toBe(getItemGeometry('axe'));
    expect(() => getItemGeometry('no_such_item')).toThrow('no_such_item');
    expect(() => getItemGeometry('toString')).toThrow('toString');
    expect(() => getItemHoldPose('no_such_item')).toThrow('no_such_item');
  });

  test('hold poses: finite; tools held by their origin, small things with an explicit grip', () => {
    const up = new THREE.Vector3();
    for (const def of ITEM_LIST) {
      const pose = getItemHoldPose(def.id);
      for (const v of [...pose.position, ...pose.rotation, pose.scale]) expect(Number.isFinite(v), def.id).toBe(true);
      expect(pose.scale).toBeGreaterThan(0);
      // In view: in front of the camera, right of centre, below the eye.
      const grip = pose.grip ?? pose.position;
      expect(grip[2], def.id).toBeLessThan(-3);
      expect(grip[0], def.id).toBeGreaterThan(0.5);
      expect(grip[1], def.id).toBeLessThan(-0.5);
      up.set(0, 1, 0).applyEuler(new THREE.Euler(...pose.rotation));
      if (def.kind === 'tool') {
        expect(pose.grip, def.id).toBeUndefined();
        expect(up.y, def.id).toBeGreaterThan(0.5); // handles rise from the fist
      }
    }
    const lamp = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(...getItemHoldPose('flashlight').rotation));
    expect(lamp.z).toBeLessThan(-0.8); // the beam points ahead
    expect(getItemHoldPose('apple').grip).toBeDefined();
  });

  test('the hand: forearm towards +Z from the wrist, the fist round the grip channel in front', () => {
    const geo = getHandGeometry();
    const box = geo.boundingBox!;
    expect(box.max.z).toBeGreaterThan(2); // sleeve
    expect(box.min.z).toBeLessThan(-1.2); // knuckles
    expect(box.containsPoint(new THREE.Vector3(0, 0.15, -0.85))).toBe(true);
    expect(getHandGeometry()).toBe(geo);
  });
});

describe('doors', () => {
  const styles: DoorStyle[] = ['wood', 'wood_painted', 'metal'];
  test('the leaf spans exactly width × height from the hinge edge and the floor, ~4 cm thick', () => {
    for (const [w, h] of [[9, 20], [8, 19], [12, 21], [3, 10]]) {
      for (const style of styles) {
        const box = getDoorGeometry(w, h, style).boundingBox!;
        const tag = `${style} ${w}×${h}`;
        expect(box.min.x, tag).toBeCloseTo(0, 6);
        expect(box.max.x, tag).toBeCloseTo(w, 6);
        expect(box.min.y, tag).toBeCloseTo(0, 6);
        expect(box.max.y, tag).toBeCloseTo(h, 6);
        expect(box.min.z, tag).toBeGreaterThanOrEqual(-0.6);
        expect(box.max.z, tag).toBeLessThanOrEqual(0.6);
      }
    }
  });

  test('the leaf is 4 cm thick and centred on Z where there are no fittings; cached per size and style', () => {
    const geo = getDoorGeometry(9, 20, 'wood_painted');
    // Faces facing ±Z at the hinge-side stile, below the hinges.
    const zs = new Set<number>();
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    for (let i = 0; i < pos.count; i++) {
      if (nrm.getZ(i) !== 0 && pos.getX(i) < 1 && pos.getY(i) > 3 && pos.getY(i) < 9) zs.add(Math.round(pos.getZ(i) * 100) / 100);
    }
    expect([...zs].sort()).toEqual([-0.2, 0.2]);
    expect(getDoorGeometry(9, 20, 'wood_painted')).toBe(geo);
  });
});

describe('containers', () => {
  const styles: ContainerStyle[] = ['crate', 'cabinet', 'fridge', 'toolbox'];
  const lidBox = (style: ContainerStyle, t: number): THREE.Box3 => {
    const m = getContainerModel(style);
    const rot = m.lidAxis === 'x' ? new THREE.Matrix4().makeRotationX(t * m.lidOpenAngle) : new THREE.Matrix4().makeRotationY(t * m.lidOpenAngle);
    return m.lid!.boundingBox!.clone().applyMatrix4(rot).translate(new THREE.Vector3(...m.lidPivot));
  };

  test('size is the closed outline (±3 cm), front +Z, origin bottom centre', () => {
    for (const style of styles) {
      const m = getContainerModel(style);
      const closed = m.body.boundingBox!.clone().union(lidBox(style, 0));
      const s = closed.getSize(new THREE.Vector3()).toArray();
      for (let a = 0; a < 3; a++) expect(Math.abs(s[a] - m.size[a]), `${style} axis ${a}`).toBeLessThanOrEqual(0.3);
      expect(closed.min.y).toBeCloseTo(0, 6);
      expect(Math.abs(closed.min.x + closed.max.x)).toBeLessThan(0.05);
    }
    expect(getContainerModel('crate').size).toEqual([6, 4, 4]);
    expect(getContainerModel('cabinet').size).toEqual([6, 18, 4]);
    expect(getContainerModel('fridge').size).toEqual([6, 16, 6]);
    expect(getContainerModel('toolbox').size[0]).toBe(5);
  });

  test('lids flip up and back, doors swing out to the front: fully open (t = 1) they stay clear of the body', () => {
    for (const style of styles) {
      const m = getContainerModel(style);
      const body = m.body.boundingBox!;
      const open = lidBox(style, 1);
      const closed = lidBox(style, 0);
      if (m.lidAxis === 'x') {
        expect(style === 'crate' || style === 'toolbox').toBe(true);
        expect(closed.min.y, style).toBeCloseTo(body.max.y, 1); // the lid closes on top of the body
        expect(open.max.y, style).toBeGreaterThan(body.max.y + 0.5 * (closed.max.z - closed.min.z)); // flipped up
        expect(open.max.z, style).toBeLessThanOrEqual(body.min.z + 0.05); // and back, behind the hinge
      } else {
        expect(closed.max.z, style).toBeGreaterThanOrEqual(body.max.z - 0.05); // the door closes the front
        expect(open.min.z, style).toBeGreaterThanOrEqual(body.max.z - 0.35); // swung out to the front
        expect(open.max.z - open.min.z, style).toBeGreaterThan(0.8 * m.size[0]);
      }
      // No part of the opened lid inside the body (2 cm tolerance at the hinge).
      const inner = body.clone().expandByScalar(-0.2);
      expect(inner.intersectsBox(open), style).toBe(false);
    }
  });
});

describe('campfire', () => {
  test('a stone ring of ~60 cm with logs, origin at the bottom centre', () => {
    const geo = getCampfireGeometry();
    const s = size(geo);
    expect(s.x).toBeGreaterThan(5.4);
    expect(s.x).toBeLessThan(6.6);
    expect(s.z).toBeGreaterThan(5.4);
    expect(s.y).toBeGreaterThan(2.5);
    expect(s.y).toBeLessThan(4.5);
    expect(geo.boundingBox!.min.y).toBeCloseTo(0, 6);
    expect(getCampfireGeometry()).toBe(geo);
  });
});

describe('mob rigs', () => {
  const NAMES = {
    deer: ['body', 'neck', 'head', 'earL', 'earR', 'legFL', 'legFR', 'legBL', 'legBR', 'tail'],
    dog: ['body', 'head', 'jaw', 'earL', 'earR', 'legFL', 'legFR', 'legBL', 'legBR', 'tail'],
  } as const;

  const absolutePivot = (rig: MobRig, name: string): THREE.Vector3 => {
    const v = new THREE.Vector3();
    for (let p = rig.parts.find((q) => q.name === name); p; p = rig.parts.find((q) => q.name === p!.parent)) {
      v.add(new THREE.Vector3(...p.pivot));
      if (p.parent === null) break;
    }
    return v;
  };

  for (const kind of ['deer', 'dog'] as const) {
    test(`${kind}: the stub's part names, valid parents listed first, within ~25k triangles`, () => {
      const rig = getMobRig(kind);
      expect(rig.parts.map((p) => p.name).sort()).toEqual([...NAMES[kind]].sort());
      const seen = new Set<string>();
      for (const p of rig.parts) {
        if (p.parent === null) expect(p.name).toBe('body');
        else expect(seen.has(p.parent), `${p.name} → ${p.parent}`).toBe(true);
        seen.add(p.name);
      }
      expect(rig.parts.find((p) => p.name === 'head')!.parent).toBe(kind === 'deer' ? 'neck' : 'body');
      for (const leg of ['legFL', 'legFR', 'legBL', 'legBR']) expect(rig.parts.find((p) => p.name === leg)!.parent).toBe('body');
      const tris = rig.parts.reduce((s, p) => s + triangles(p.geometry), 0);
      expect(tris).toBeLessThanOrEqual(25_000);
      expect(getMobRig(kind)).toBe(rig);
    });

    test(`${kind}: legs hang −Y from their joints to the ground; left is +X; head towards +Z`, () => {
      const rig = getMobRig(kind);
      for (const leg of ['legFL', 'legFR', 'legBL', 'legBR']) {
        const part = rig.parts.find((p) => p.name === leg)!;
        const joint = absolutePivot(rig, leg);
        const box = part.geometry.boundingBox!;
        expect(joint.y + box.min.y, leg).toBeCloseTo(0, 1); // the foot is on the ground
        expect(box.max.y, leg).toBeLessThan(1); // little above the joint
        expect(Math.abs((box.min.z + box.max.z) / 2), leg).toBeLessThan(0.6); // the foot is roughly under it
        expect(Math.sign(joint.x), leg).toBe(leg.endsWith('L') ? 1 : -1);
      }
      expect(absolutePivot(rig, 'legFL').z).toBeGreaterThan(0);
      expect(absolutePivot(rig, 'legBL').z).toBeLessThan(0);
      expect(absolutePivot(rig, 'head').z).toBeGreaterThan(absolutePivot(rig, 'legFL').z);
      expect(absolutePivot(rig, 'tail').z).toBeLessThan(absolutePivot(rig, 'legBL').z);
      expect(Math.abs(absolutePivot(rig, 'body').z)).toBeLessThan(0.01);
    });
  }

  test('real sizes: roe deer ~70 cm at the withers, ~1 m long; dog ~55 cm at the withers', () => {
    const deer = getMobRig('deer');
    const dog = getMobRig('dog');
    const withers = (rig: MobRig): number => absolutePivot(rig, 'body').y + rig.parts.find((p) => p.name === 'body')!.geometry.boundingBox!.max.y;
    expect(withers(deer)).toBeGreaterThan(6.5);
    expect(withers(deer)).toBeLessThan(8);
    expect(deer.size.length).toBeGreaterThan(8.5);
    expect(deer.size.length).toBeLessThan(13);
    expect(deer.size.height).toBeGreaterThan(9);
    expect(deer.size.height).toBeLessThan(12);
    expect(deer.size.width).toBeLessThan(4);
    expect(withers(dog)).toBeGreaterThan(5);
    expect(withers(dog)).toBeLessThan(6.2);
    expect(dog.size.length).toBeGreaterThan(6.5);
    expect(dog.size.length).toBeLessThan(10);
    expect(dog.size.height).toBeLessThan(deer.size.height);
    expect(() => getMobRig('cat' as never)).toThrow('cat');
  });
});
