import { describe, expect, test } from 'vitest';
import { WORLD_Y } from '../src/config';
import {
  bushBounds,
  fallenLogBounds,
  stampBush,
  stampFallenLog,
  stampStump,
  stampTree,
  stumpBounds,
  treeBounds,
  treeCrownSpan,
  type TreeKind,
  type TreeParams,
} from '../src/gen/flora';
import { boulderBounds, outcropBounds, stampBoulder, stampOutcrop } from '../src/gen/rocks';
import type { VoxelWriter } from '../src/gen/types';
import { B, FOLIAGE, RENDER_KIND, RK, SUP, SUPPORT } from '../src/world/blocks';

/** Dense writer over an arbitrary box (index x + z·sx + y·sx·sz) with an optional clip window (like a generation tile). */
class BoxWriter implements VoxelWriter {
  readonly data: Uint8Array;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  constructor(readonly bx0: number, readonly by0: number, readonly bz0: number, readonly bx1: number, readonly by1: number, readonly bz1: number) {
    this.sx = bx1 - bx0;
    this.sy = by1 - by0;
    this.sz = bz1 - bz0;
    this.data = new Uint8Array(this.sx * this.sy * this.sz);
    this.x0 = bx0;
    this.z0 = bz0;
    this.x1 = bx1;
    this.z1 = bz1;
  }
  clip(x0: number, z0: number, x1: number, z1: number): this {
    this.x0 = x0;
    this.z0 = z0;
    this.x1 = x1;
    this.z1 = z1;
    return this;
  }
  private idx(x: number, y: number, z: number): number {
    return x - this.bx0 + this.sx * (z - this.bz0 + this.sz * (y - this.by0));
  }
  inTile(x: number, z: number): boolean {
    return x >= this.x0 && x < this.x1 && z >= this.z0 && z < this.z1;
  }
  private inside(x: number, y: number, z: number): boolean {
    return this.inTile(x, z) && x >= this.bx0 && x < this.bx1 && z >= this.bz0 && z < this.bz1 && y >= this.by0 && y < this.by1 && y < WORLD_Y;
  }
  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : B.AIR;
  }
  set(x: number, y: number, z: number, id: number): void {
    if (this.inside(x, y, z)) this.data[this.idx(x, y, z)] = id;
  }
  setSoft(x: number, y: number, z: number, id: number): void {
    if (!this.inside(x, y, z)) return;
    const i = this.idx(x, y, z);
    if (this.data[i] === B.AIR || RENDER_KIND[this.data[i]] === RK.PLANT) this.data[i] = id;
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    const xa = Math.max(x0, this.x0, this.bx0);
    const xb = Math.min(x1, this.x1, this.bx1);
    const za = Math.max(z0, this.z0, this.bz0);
    const zb = Math.min(z1, this.z1, this.bz1);
    if (xa >= xb) return;
    for (let y = Math.max(y0, this.by0, 0); y < Math.min(y1, this.by1, WORLD_Y); y++) {
      for (let z = za; z < zb; z++) this.data.fill(id, this.idx(xa, y, z), this.idx(xb, y, z));
    }
  }
  /** Flat test ground: DIRT below `top`, GRASS at top - 1. */
  ground(top: number): this {
    this.fill(this.bx0, this.by0, this.bz0, this.bx1, top, this.bz1, B.DIRT);
    this.fill(this.bx0, top - 1, this.bz0, this.bx1, top, this.bz1, B.GRASS);
    return this;
  }
  copyFrom(o: BoxWriter): void {
    this.data.set(o.data);
  }
}

/** Wraps a writer and records every set/setSoft/fill outside the given bounds. */
class BoundsChecker implements VoxelWriter {
  violations = 0;
  writes = 0;
  constructor(private readonly w: VoxelWriter, private readonly min: number[], private readonly max: number[]) {}
  get x0(): number {
    return this.w.x0;
  }
  get z0(): number {
    return this.w.z0;
  }
  get x1(): number {
    return this.w.x1;
  }
  get z1(): number {
    return this.w.z1;
  }
  inTile(x: number, z: number): boolean {
    return this.w.inTile(x, z);
  }
  get(x: number, y: number, z: number): number {
    return this.w.get(x, y, z);
  }
  private check(x: number, y: number, z: number): void {
    this.writes++;
    if (x < this.min[0] || y < this.min[1] || z < this.min[2] || x >= this.max[0] || y >= this.max[1] || z >= this.max[2]) this.violations++;
  }
  set(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z);
    this.w.set(x, y, z, id);
  }
  setSoft(x: number, y: number, z: number, id: number): void {
    this.check(x, y, z);
    this.w.setSoft(x, y, z, id);
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    this.check(x0, y0, z0);
    this.check(x1 - 1, y1 - 1, z1 - 1);
    this.w.fill(x0, y0, z0, x1, y1, z1, id);
  }
}

/** Index of the first differing byte, or -1 when equal. */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

const KINDS: TreeKind[] = ['oak', 'birch', 'pine', 'apple', 'sapling', 'dead'];
const BASE = 40;

/** Block-id mask (1 = member): the voxel scans below test `mask[id]`, which keeps them fast. */
const mask = (pred: (id: number) => boolean): Uint8Array => Uint8Array.from({ length: 256 }, (_, id) => (pred(id) ? 1 : 0));
const WOOD = mask((id) => SUPPORT[id] === SUP.STRUCT);
const TREE = mask((id) => WOOD[id] === 1 || FOLIAGE[id] === 1);
const GROUND = mask((id) => id === B.DIRT || id === B.GRASS);
const isWood = (id: number): boolean => WOOD[id] === 1;

/** Stamps a tree on flat ground in a box that comfortably contains its bounds. */
function plantTree(p: TreeParams): { w: BoxWriter; b: { min: number[]; max: number[] } } {
  const b = treeBounds(p);
  const w = new BoxWriter(b.min[0] - 4, Math.max(0, b.min[1] - 4), b.min[2] - 4, b.max[0] + 4, b.max[1] + 4, b.max[2] + 4).ground(p.y);
  const checker = new BoundsChecker(w, b.min, b.max);
  stampTree(checker, p);
  expect(checker.violations, `${p.kind} seed ${p.seed}: writes outside treeBounds`).toBe(0);
  return { w, b };
}

// Scratch of the voxel scans below, reused (an oak's box holds ~2.5 M voxels): visit flags, a queue
// and the face neighbours of the voxel being expanded.
let seen = new Uint8Array(0);
let queue = new Int32Array(0);
const nbr = new Int32Array(6);

function resetScratch(n: number): void {
  if (seen.length < n) {
    seen = new Uint8Array(n);
    queue = new Int32Array(n);
  } else seen.fill(0, 0, n);
}

/** Writes the indices of the face neighbours of voxel j that lie inside the box to `nbr`; returns their count. */
function neighbours(w: BoxWriter, j: number): number {
  const plane = w.sx * w.sz;
  const x = j % w.sx;
  const z = ((j - x) / w.sx) % w.sz;
  const y = (j - x - z * w.sx) / plane;
  let n = 0;
  if (x > 0) nbr[n++] = j - 1;
  if (x < w.sx - 1) nbr[n++] = j + 1;
  if (z > 0) nbr[n++] = j - w.sx;
  if (z < w.sz - 1) nbr[n++] = j + w.sx;
  if (y > 0) nbr[n++] = j - plane;
  if (y < w.sy - 1) nbr[n++] = j + plane;
  return n;
}

/** 6-connected components of the voxels in `m` (returns component sizes, largest first). */
function components(w: BoxWriter, m: Uint8Array): number[] {
  const data = w.data;
  resetScratch(data.length);
  const sizes: number[] = [];
  let tail = 0;
  for (let i = 0; i < data.length; i++) {
    if (seen[i] !== 0 || m[data[i]] === 0) continue;
    const start = tail;
    seen[i] = 1;
    queue[tail++] = i;
    for (let head = start; head < tail; head++) {
      const n = neighbours(w, queue[head]);
      for (let q = 0; q < n; q++) {
        const k = nbr[q];
        if (seen[k] === 0 && m[data[k]] === 1) {
          seen[k] = 1;
          queue[tail++] = k;
        }
      }
    }
    sizes.push(tail - start);
  }
  return sizes.sort((a, b) => b - a);
}

/**
 * Steps (6-neighbourhood, through foliage only) from the nearest wood voxel to the farthest foliage
 * voxel; Infinity if some foliage cannot reach wood at all.
 */
function foliageDepth(w: BoxWriter): number {
  const data = w.data;
  resetScratch(data.length);
  let tail = 0;
  let leaves = 0;
  for (let i = 0; i < data.length; i++) {
    if (WOOD[data[i]] === 1) {
      seen[i] = 1;
      queue[tail++] = i;
    } else leaves += FOLIAGE[data[i]];
  }
  const wood = tail;
  let depth = 0;
  for (let head = 0; head < tail; ) {
    const end = tail;
    for (; head < end; head++) {
      const n = neighbours(w, queue[head]);
      for (let q = 0; q < n; q++) {
        const k = nbr[q];
        if (seen[k] === 0 && FOLIAGE[data[k]] === 1) {
          seen[k] = 1;
          queue[tail++] = k;
        }
      }
    }
    if (tail > end) depth++;
  }
  return tail - wood === leaves ? depth : Infinity;
}

/**
 * Tree voxels with a ground (DIRT/GRASS) face neighbour: how many, how many of them are foliage, the
 * highest one and the farthest one from the trunk axis (ax, az).
 */
function groundContacts(w: BoxWriter, ax: number, az: number): { count: number; foliage: number; maxY: number; maxDist: number } {
  const data = w.data;
  const out = { count: 0, foliage: 0, maxY: -Infinity, maxDist: 0 };
  for (let i = 0; i < data.length; i++) {
    const id = data[i];
    if (TREE[id] === 0) continue;
    const n = neighbours(w, i);
    let touches = false;
    for (let q = 0; q < n && !touches; q++) touches = GROUND[data[nbr[q]]] === 1;
    if (!touches) continue;
    const x = (i % w.sx) + w.bx0;
    const z = (Math.floor(i / w.sx) % w.sz) + w.bz0;
    out.count++;
    out.foliage += FOLIAGE[id];
    out.maxY = Math.max(out.maxY, Math.floor(i / (w.sx * w.sz)) + w.by0);
    out.maxDist = Math.max(out.maxDist, Math.hypot(x + 0.5 - ax, z + 0.5 - az));
  }
  return out;
}

/** Lowest and highest y holding a voxel in `m`, or [-1, -1]. */
function ySpan(w: BoxWriter, m: Uint8Array): [number, number] {
  const plane = w.sx * w.sz;
  const layerHas = (ly: number): boolean => {
    for (let i = ly * plane; i < (ly + 1) * plane; i++) if (m[w.data[i]] === 1) return true;
    return false;
  };
  let lo = 0;
  while (lo < w.sy && !layerHas(lo)) lo++;
  if (lo === w.sy) return [-1, -1];
  let hi = w.sy - 1;
  while (!layerHas(hi)) hi--;
  return [lo + w.by0, hi + w.by0];
}

describe('trees', () => {
  test.each(KINDS)('%s: writes stay inside treeBounds; one connected tree touching the ground only at the base', (kind) => {
    for (let seed = 1; seed <= 4; seed++) {
      const label = `${kind} seed ${seed}`;
      const { w } = plantTree({ kind, x: 300, y: BASE, z: 300, seed });
      // Trunk + branches + foliage: a single 6-connected component …
      const all = components(w, TREE);
      expect(all.length, `${label}: tree components ${all.slice(0, 4)}`).toBe(1);
      // … whose wood alone is connected too (cutting the trunk detaches the whole tree) …
      const wood = components(w, WOOD);
      expect(wood.length, `${label}: wood components ${wood.slice(0, 4)}`).toBe(1);
      // … and every leaf is close to wood through foliage (a felled tree takes along the foliage
      // within FOLIAGE_REACH = 30 steps of its wood).
      expect(foliageDepth(w), label).toBeLessThanOrEqual(26);
      // Contact with the ground only through the trunk base and the roots.
      const contact = groundContacts(w, 300.5, 300.5);
      expect(contact.count, `${label}: does not reach the ground`).toBeGreaterThan(0);
      expect(contact.foliage, `${label}: foliage touches the ground`).toBe(0);
      expect(contact.maxY, `${label}: wood touches the ground high up`).toBeLessThanOrEqual(BASE + 4);
      expect(contact.maxDist, `${label}: ground contact far from the trunk`).toBeLessThan(26);
    }
  });

  test('real proportions at 10 cm', () => {
    const ranges: Record<TreeKind, [number, number]> = {
      oak: [110, 200],
      birch: [130, 215],
      pine: [140, 235],
      apple: [35, 70],
      sapling: [12, 36],
      dead: [55, 140],
    };
    // Trunk diameter at chest height (1.3 m): oak 40–70 cm (+ flare/rounding), birch 20–35 cm.
    const widths: Partial<Record<TreeKind, [number, number]>> = { oak: [4, 8], birch: [2, 4] };
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 3; seed++) {
        const { w } = plantTree({ kind, x: 300, y: BASE, z: 300, seed });
        const h = ySpan(w, TREE)[1] + 1 - BASE;
        expect(h, `${kind} ${seed} height`).toBeGreaterThanOrEqual(ranges[kind][0]);
        expect(h, `${kind} ${seed} height`).toBeLessThanOrEqual(ranges[kind][1]);
        const range = widths[kind];
        if (!range) continue;
        let n = 0;
        for (let x = w.bx0; x < w.bx1; x++) if (isWood(w.get(x, BASE + 13, 300))) n++;
        expect(n, `${kind} ${seed} trunk width`).toBeGreaterThanOrEqual(range[0]);
        expect(n, `${kind} ${seed} trunk width`).toBeLessThanOrEqual(range[1]);
      }
    }
  });

  test('bark outside, WOOD inside the trunk', () => {
    const { w } = plantTree({ kind: 'oak', x: 300, y: BASE, z: 300, seed: 3 });
    const y = BASE + 20;
    expect(w.get(300, y, 300)).toBe(B.WOOD);
    let x = 300;
    while (isWood(w.get(x + 1, y, 300))) x++;
    expect(w.get(x, y, 300)).toBe(B.OAK_LOG);
    expect(w.get(x + 1, y, 300)).toBe(B.AIR);
  });

  test('stamping is tile-independent: any clip window writes identical voxels', () => {
    for (const kind of KINDS) {
      const p: TreeParams = { kind, x: 300, y: BASE, z: 300, seed: 11, maxCrownRadius: 34 };
      const { w: full } = plantTree(p);
      const tiled = new BoxWriter(full.bx0, full.by0, full.bz0, full.bx1, full.by1, full.bz1).ground(BASE);
      // Four quadrant windows cut through the trunk, stamped in reverse order.
      for (const [x0, z0, x1, z1] of [
        [301, 301, full.bx1, full.bz1],
        [full.bx0, 301, 301, full.bz1],
        [301, full.bz0, full.bx1, 301],
        [full.bx0, full.bz0, 301, 301],
      ]) {
        stampTree(tiled.clip(x0, z0, x1, z1), p);
      }
      expect(firstDiff(full.data, tiled.data), kind).toBe(-1);
    }
  });

  test('crowns respect maxCrownRadius and the crown cell', () => {
    for (const kind of ['oak', 'birch', 'pine', 'apple', 'dead'] as TreeKind[]) {
      // The crown: foliage, or the bare branches of a dead tree (its wood above 2 m).
      const bottom = kind === 'dead' ? BASE + 20 : 0;
      const crown = kind === 'dead' ? WOOD : FOLIAGE;
      for (let seed = 1; seed <= 4; seed++) {
        // Neighbour to the east at 4 m: the cell keeps the crown ≥ 1.2 m left of the trunk's east side.
        const p: TreeParams = { kind, x: 300, y: BASE, z: 300, seed, maxCrownRadius: 36, crownCell: [1, 0, 12] };
        const { w } = plantTree(p);
        let voxels = 0;
        let reach = 0;
        let east = -Infinity;
        for (let i = Math.max(0, bottom - w.by0) * w.sx * w.sz; i < w.data.length; i++) {
          if (crown[w.data[i]] === 0) continue;
          const dx = (i % w.sx) + w.bx0 + 0.5 - 300.5;
          const dz = (Math.floor(i / w.sx) % w.sz) + w.bz0 + 0.5 - 300.5;
          voxels++;
          reach = Math.max(reach, Math.hypot(dx, dz));
          east = Math.max(east, dx);
        }
        expect(voxels, `${kind} ${seed}: crown`).toBeGreaterThan(kind === 'dead' ? 100 : 500);
        expect(reach, `${kind} ${seed}`).toBeLessThanOrEqual(36.5);
        expect(east, `${kind} ${seed} crosses the cell`).toBeLessThanOrEqual(12.5);
      }
    }
  });

  test('foliage is a few coherent clusters with gaps, big clusters hollow', () => {
    const { w } = plantTree({ kind: 'oak', x: 300, y: BASE, z: 300, seed: 5 });
    // Projected crown: covered columns inside the crown disc leave some sky through.
    let covered = 0;
    let disc = 0;
    for (let z = w.bz0; z < w.bz1; z++) {
      for (let x = w.bx0; x < w.bx1; x++) {
        let any = false;
        for (let y = BASE; y < w.by1 && !any; y++) any = FOLIAGE[w.get(x, y, z)] === 1;
        if (Math.hypot(x - 300, z - 300) < 40) {
          disc++;
          if (any) covered++;
        }
      }
    }
    expect(covered / disc).toBeGreaterThan(0.35);
    expect(covered / disc).toBeLessThan(0.97);
    // Big clusters are shells: air enclosed by foliage that outside air cannot reach.
    const outside = components(w, mask((id) => id === B.AIR));
    const enclosedAir = outside.slice(1).reduce((a, b) => a + b, 0);
    expect(enclosedAir).toBeGreaterThan(2000);
  });

  test("crown span covers the crown layer: foliage, or a dead tree's bare branches", () => {
    const p: TreeParams = { kind: 'pine', x: 300, y: BASE, z: 300, seed: 2 };
    const [lo, hi] = treeCrownSpan(p);
    const { w } = plantTree(p);
    const [bottom, top] = ySpan(w, FOLIAGE);
    expect(bottom).toBeGreaterThanOrEqual(lo);
    expect(top).toBeLessThan(hi);
    expect(lo).toBeGreaterThan(BASE + 60); // pines: branches only in the upper half
    // A dead tree's crown layer is its bare branches: wood away from the trunk (and above the roots).
    for (let seed = 1; seed <= 4; seed++) {
      const d: TreeParams = { kind: 'dead', x: 300, y: BASE, z: 300, seed };
      const [dlo, dhi] = treeCrownSpan(d);
      const { w: dw } = plantTree(d);
      let branches = 0;
      let outside = 0;
      for (let i = 0; i < dw.data.length; i++) {
        if (WOOD[dw.data[i]] === 0) continue;
        const y = Math.floor(i / (dw.sx * dw.sz)) + dw.by0;
        const dx = (i % dw.sx) + dw.bx0 - 300;
        const dz = (Math.floor(i / dw.sx) % dw.sz) + dw.bz0 - 300;
        if (y <= BASE + 4 || Math.hypot(dx, dz) <= 10) continue;
        branches++;
        if (y < dlo || y >= dhi) outside++;
      }
      expect(branches, `dead ${seed}: branches`).toBeGreaterThan(0);
      expect(outside, `dead ${seed}: branch voxels outside the crown span ${dlo}..${dhi}`).toBe(0);
    }
  });

  test('trees anchor on slopes instead of floating', () => {
    const p: TreeParams = { kind: 'oak', x: 300, y: BASE + 10, z: 300, seed: 4 };
    const b = treeBounds(p);
    const w = new BoxWriter(b.min[0] - 4, Math.max(0, b.min[1] - 4), b.min[2] - 4, b.max[0] + 4, b.max[1] + 4, b.max[2] + 4);
    // Slope 1:1 falling towards +x; ground height at the trunk centre = p.y.
    for (let x = w.bx0; x < w.bx1; x++) {
      const top = BASE + 10 - (x - 300);
      w.fill(x, w.by0, w.bz0, x + 1, Math.max(w.by0, Math.min(top, w.by1)), w.bz1, B.DIRT);
    }
    stampTree(w, p);
    expect(components(w, mask((id) => WOOD[id] === 1 || id === B.DIRT)).length).toBe(1);
    // Every trunk/root column rests on something.
    const floating: string[] = [];
    for (let z = 290; z <= 310; z++) {
      for (let x = 290; x <= 316; x++) {
        for (let y = w.by0 + 1; y < BASE + 12; y++) if (isWood(w.get(x, y, z)) && w.get(x, y - 1, z) === B.AIR) floating.push(`${x},${y},${z}`);
      }
    }
    expect(floating, 'floating roots').toEqual([]);
  });
});

describe('bushes, dead wood, rocks', () => {
  test('bushes: inside bounds, passable foliage with hidden twigs, tile-independent', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = 4 + seed * 0.7;
      const b = bushBounds(100, BASE, 100, r);
      const full = new BoxWriter(b.min[0] - 2, b.min[1] - 2, b.min[2] - 2, b.max[0] + 2, b.max[1] + 2, b.max[2] + 2).ground(BASE);
      const checker = new BoundsChecker(full, b.min, b.max);
      stampBush(checker, 100, BASE, 100, r, seed);
      expect(checker.violations).toBe(0);
      let bush = 0;
      for (const id of full.data) if (id === B.BUSH) bush++;
      expect(bush).toBeGreaterThan(50);
      const tiled = new BoxWriter(full.bx0, full.by0, full.bz0, full.bx1, full.by1, full.bz1).ground(BASE);
      stampBush(tiled.clip(full.bx0, full.bz0, 101, full.bz1), 100, BASE, 100, r, seed);
      stampBush(tiled.clip(101, full.bz0, full.bx1, full.bz1), 100, BASE, 100, r, seed);
      expect(firstDiff(full.data, tiled.data)).toBe(-1);
    }
  });

  test('fallen logs: WOOD end faces, bark skin, inside bounds', () => {
    const p = { ax: 80, ay: BASE, az: 100, bx: 125, by: BASE, bz: 112, radius: 3, bark: B.BIRCH_LOG };
    const b = fallenLogBounds(p);
    const w = new BoxWriter(b.min[0] - 2, b.min[1] - 2, b.min[2] - 2, b.max[0] + 2, b.max[1] + 2, b.max[2] + 2).ground(BASE);
    const checker = new BoundsChecker(w, b.min, b.max);
    stampFallenLog(checker, p);
    expect(checker.violations).toBe(0);
    let wood = 0;
    let bark = 0;
    for (const id of w.data) {
      if (id === B.WOOD) wood++;
      if (id === B.BIRCH_LOG) bark++;
    }
    expect(bark).toBeGreaterThan(wood);
    // The cut end shows WOOD in the middle.
    expect(w.get(80, BASE + 2, 100)).toBe(B.WOOD);
  });

  test('stumps: flat WOOD top inside bounds', () => {
    const p = { x: 100, y: BASE, z: 100, radius: 3, height: 5, bark: B.OAK_LOG, seed: 9 };
    const b = stumpBounds(p);
    const w = new BoxWriter(b.min[0] - 2, Math.max(0, b.min[1] - 2), b.min[2] - 2, b.max[0] + 2, b.max[1] + 2, b.max[2] + 2).ground(BASE);
    const checker = new BoundsChecker(w, b.min, b.max);
    stampStump(checker, p);
    expect(checker.violations).toBe(0);
    expect(w.get(100, BASE + 4, 100)).toBe(B.WOOD);
    expect(w.get(100, BASE + 5, 100)).toBe(B.AIR);
  });

  test('boulders: partly buried rock with moss, inside bounds, tile-independent', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = 5 + seed * 2;
      const b = boulderBounds(100, BASE, 100, r);
      const full = new BoxWriter(b.min[0] - 2, Math.max(0, b.min[1] - 2), b.min[2] - 2, b.max[0] + 2, b.max[1] + 2, b.max[2] + 2).ground(BASE);
      const checker = new BoundsChecker(full, b.min, b.max);
      stampBoulder(checker, 100, BASE, 100, r, seed);
      expect(checker.violations).toBe(0);
      let above = 0;
      let below = 0;
      for (let i = 0; i < full.data.length; i++) {
        const id = full.data[i];
        if (id !== B.STONE && id !== B.GRANITE && id !== B.MOSS) continue;
        if (Math.floor(i / (full.sx * full.sz)) + full.by0 >= BASE) above++;
        else below++;
      }
      expect(above, `seed ${seed}`).toBeGreaterThan(0);
      expect(below, `seed ${seed}: partly buried`).toBeGreaterThan(0);
      const tiled = new BoxWriter(full.bx0, full.by0, full.bz0, full.bx1, full.by1, full.bz1).ground(BASE);
      stampBoulder(tiled.clip(full.bx0, full.bz0, 103, 98), 100, BASE, 100, r, seed);
      stampBoulder(tiled.clip(103, full.bz0, full.bx1, 98), 100, BASE, 100, r, seed);
      stampBoulder(tiled.clip(full.bx0, 98, full.bx1, full.bz1), 100, BASE, 100, r, seed);
      expect(firstDiff(full.data, tiled.data)).toBe(-1);
    }
  });

  test('outcrops: tall granite tors inside bounds', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const p = { x: 100, y: BASE, z: 100, size: 18, seed };
      const b = outcropBounds(p);
      const w = new BoxWriter(b.min[0] - 2, Math.max(0, b.min[1] - 2), b.min[2] - 2, b.max[0] + 2, b.max[1] + 2, b.max[2] + 2).ground(BASE);
      const checker = new BoundsChecker(w, b.min, b.max);
      stampOutcrop(checker, p);
      expect(checker.violations).toBe(0);
      let top = 0;
      for (let i = 0; i < w.data.length; i++) if (w.data[i] === B.GRANITE) top = Math.max(top, Math.floor(i / (w.sx * w.sz)) + w.by0);
      expect(top - BASE, `seed ${seed} tor height`).toBeGreaterThan(20);
    }
  });
});

describe('saplings on buildings', () => {
  test('a sapling on a thin roof stands on it and never hangs a log into the room below', () => {
    const p: TreeParams = { kind: 'sapling', x: 100, y: BASE + 12, z: 100, seed: 3 };
    const b = treeBounds(p);
    const w = new BoxWriter(b.min[0] - 4, BASE - 2, b.min[2] - 4, b.max[0] + 4, b.max[1] + 4, b.max[2] + 4).ground(BASE);
    // A 2-voxel roof slab with an empty attic below it.
    w.fill(w.bx0, BASE + 10, w.bz0, w.bx1, BASE + 12, w.bz1, B.SLATE);
    const checker = new BoundsChecker(w, b.min, b.max);
    stampTree(checker, p);
    expect(checker.violations).toBe(0);
    for (let y = BASE; y < BASE + 10; y++) {
      for (let z = w.bz0; z < w.bz1; z++) for (let x = w.bx0; x < w.bx1; x++) expect(w.get(x, y, z), `attic at ${x},${y},${z}`).toBe(B.AIR);
    }
    // Built materials are never replaced: the stem stands on the slate (supported by the roof).
    expect(w.get(100, BASE + 12, 100)).toBe(B.BIRCH_LOG);
    expect(w.get(100, BASE + 11, 100)).toBe(B.SLATE);
    expect(components(w, TREE).length).toBe(1);
  });
});

describe('trees next to buildings', () => {
  test('roots and the buried trunk never cut into built materials', () => {
    const p: TreeParams = { kind: 'apple', x: 100, y: BASE, z: 100, seed: 7 };
    const b = treeBounds(p);
    const w = new BoxWriter(b.min[0] - 4, Math.max(0, b.min[1] - 4), b.min[2] - 4, b.max[0] + 4, b.max[1] + 4, b.max[2] + 4).ground(BASE);
    // A concrete foundation 0.6 m east of the trunk, reaching 3 voxels into the ground.
    w.fill(106, BASE - 3, w.bz0, w.bx1, BASE + 3, w.bz1, B.CONCRETE);
    const before = w.data.slice();
    stampTree(w, p);
    let cut = 0;
    for (let i = 0; i < before.length; i++) if (before[i] === B.CONCRETE && w.data[i] !== B.CONCRETE) cut++;
    expect(cut).toBe(0);
  });
});
