import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { WORLD_X, WORLD_Z, type BiomeId } from '../src/config';
import type { ColumnSample, TerrainSampler } from '../src/gen/types';
import { HORIZON_EDGE_DROP, HORIZON_RINGS, buildHorizonGeometry } from '../src/render/env/horizon';
import { B } from '../src/world/blocks';

/**
 * Rolling test terrain with a sharp 3 m step on the north edge and hills in the south-east; grass and
 * moss alternate in 2 m stripes in the town and the meadow.
 */
function surfaceY(x: number, z: number): number {
  const step = z < 40 && x < 300 ? 30 : 0;
  const hills = x > 640 && z > 640 ? 0.08 * Math.min(x - 640, z - 640) : 0;
  return Math.floor(120 + 8 * Math.sin(x / 37) + 6 * Math.cos(z / 53) + step + hills);
}

/** Quadrants as in config.ts: NW town, NE forest, SW meadow, SE hills. */
const biomeAt = (x: number, z: number): BiomeId => (x < 640 ? (z < 640 ? 0 : 2) : z < 640 ? 1 : 3);

const terrain: TerrainSampler = {
  surfaceY,
  biomeAt,
  sample(x: number, z: number, out: ColumnSample): ColumnSample {
    const biome = biomeAt(x, z);
    out.biome = biome;
    out.weights[0] = out.weights[1] = out.weights[2] = out.weights[3] = 0;
    out.weights[biome] = 1;
    out.surfaceY = surfaceY(x, z);
    out.waterY = 0;
    out.topBlock = biome === 3 ? B.STONE : biome === 1 ? B.LITTER : Math.floor((x + z) / 20) % 2 === 0 ? B.GRASS : B.MOSS;
    return out;
  },
};

describe('horizon ring', () => {
  const t0 = performance.now();
  const geometry = buildHorizonGeometry(terrain);
  const buildMs = performance.now() - t0;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const color = geometry.getAttribute('color') as THREE.BufferAttribute;
  const index = geometry.getIndex() as THREE.BufferAttribute;
  const rings = HORIZON_RINGS.length;
  const perimeter = pos.count / rings;
  const EPS = 1e-3;
  const strictlyInside = (x: number, z: number) => x > EPS && x < WORLD_X - EPS && z > EPS && z < WORLD_Z - EPS;

  test('fits 16-bit indices and has finite positions and colours', () => {
    console.info(`[horizon] ${pos.count} vertices, ${index.count / 3} triangles, built in ${buildMs.toFixed(1)} ms`);
    expect(Number.isInteger(perimeter)).toBe(true);
    expect(pos.count).toBeLessThan(65536);
    expect(index.array).toBeInstanceOf(Uint16Array);
    for (let i = 0; i < pos.count; i++) {
      expect(Number.isFinite(pos.getX(i) + pos.getY(i) + pos.getZ(i))).toBe(true);
      for (const c of [color.getX(i), color.getY(i), color.getZ(i)]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(1.2);
      }
    }
  });

  test('no vertex and no part of any triangle lies inside the map', () => {
    for (let i = 0; i < pos.count; i++) expect(strictlyInside(pos.getX(i), pos.getZ(i))).toBe(false);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const p = new THREE.Vector3();
    const weights = [
      [1 / 3, 1 / 3, 1 / 3],
      [0.5, 0.5, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0.5],
      [0.8, 0.1, 0.1],
      [0.1, 0.8, 0.1],
      [0.1, 0.1, 0.8],
    ];
    for (let t = 0; t < index.count; t += 3) {
      a.fromBufferAttribute(pos, index.getX(t));
      b.fromBufferAttribute(pos, index.getX(t + 1));
      c.fromBufferAttribute(pos, index.getX(t + 2));
      for (const [wa, wb, wc] of weights) {
        p.set(0, 0, 0).addScaledVector(a, wa).addScaledVector(b, wb).addScaledVector(c, wc);
        expect(strictlyInside(p.x, p.z)).toBe(false);
      }
    }
  });

  test('reaches ~600 m out and every non-degenerate triangle faces up', () => {
    let far = 0;
    for (let i = 0; i < pos.count; i++) {
      const dx = Math.max(0, -pos.getX(i), pos.getX(i) - WORLD_X);
      const dz = Math.max(0, -pos.getZ(i), pos.getZ(i) - WORLD_Z);
      far = Math.max(far, Math.hypot(dx, dz));
    }
    expect(far).toBeGreaterThan(5500);
    expect(far).toBeLessThan(6500);

    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let t = 0; t < index.count; t += 3) {
      a.fromBufferAttribute(pos, index.getX(t));
      b.fromBufferAttribute(pos, index.getX(t + 1));
      c.fromBufferAttribute(pos, index.getX(t + 2));
      const n = b.sub(a).cross(c.sub(a));
      if (n.length() < 1e-6) continue; // corner fans collapse to a point on the boundary
      expect(n.y).toBeGreaterThan(0);
    }
  });

  test('detail along a ring is no finer than the ring spacing (no radial streaks)', () => {
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const luma = (i: number) => 0.2126 * color.getX(i) + 0.7152 * color.getY(i) + 0.0722 * color.getZ(i);
    /** RMS of `diff` between neighbours on the straight edges of ring k (1 m apart; the corner arcs spread out). */
    const alongRing = (k: number, diff: (a: number, b: number) => number): number => {
      let sum = 0;
      let n = 0;
      for (let j = 0; j < perimeter; j++) {
        const a = k * perimeter + j;
        const b = k * perimeter + ((j + 1) % perimeter);
        const dx = Math.abs(pos.getX(b) - pos.getX(a));
        const dz = Math.abs(pos.getZ(b) - pos.getZ(a));
        if (Math.min(dx, dz) !== 0 || Math.max(dx, dz) !== 10) continue;
        sum += diff(a, b) ** 2;
        n++;
      }
      expect(n).toBeGreaterThan(400);
      return Math.sqrt(sum / n);
    };
    const angleDeg = (a: number, b: number) => {
      const dot = normal.getX(a) * normal.getX(b) + normal.getY(a) * normal.getY(b) + normal.getZ(a) * normal.getZ(b);
      return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    };
    for (let k = 1; k < rings; k++) {
      const d = HORIZON_RINGS[k];
      // The 2 m grass/moss stripes of the edge are blurred away from the map (unfiltered: 15–20 % steps
      // per metre; further out the hard biome borders of this terrain dominate the colour steps).
      if (d >= 36 && d <= 95) expect(alongRing(k, (a, b) => (2 * (luma(a) - luma(b))) / (luma(a) + luma(b)))).toBeLessThan(0.08);
      // Where the rings are far apart the normals turn smoothly along the ring (they swung by 12–20°).
      if (d >= 95) expect(alongRing(k, angleDeg)).toBeLessThan(7);
    }
  });

  test('meets the map edge below the edge terrain, also between samples', () => {
    // Ring 0 is the boundary itself: interpolate it along each side and compare with every edge column.
    const sides = [
      { onSide: (x: number, z: number) => z === 0, along: (x: number) => x, column: (c: number) => surfaceY(c, 0) },
      { onSide: (x: number) => x === WORLD_X, along: (_x: number, z: number) => z, column: (c: number) => surfaceY(WORLD_X - 1, c) },
      { onSide: (_x: number, z: number) => z === WORLD_Z, along: (x: number) => x, column: (c: number) => surfaceY(c, WORLD_Z - 1) },
      { onSide: (x: number) => x === 0, along: (_x: number, z: number) => z, column: (c: number) => surfaceY(0, c) },
    ];
    for (const side of sides) {
      const samples: { c: number; y: number }[] = [];
      for (let j = 0; j < perimeter; j++) {
        const x = pos.getX(j);
        const z = pos.getZ(j);
        if (side.onSide(x, z)) samples.push({ c: side.along(x, z), y: pos.getY(j) });
      }
      samples.sort((p, q) => p.c - q.c);
      expect(samples.length).toBeGreaterThan(100);
      expect(samples[0].c).toBe(0);
      expect(samples[samples.length - 1].c).toBe(WORLD_X);
      for (let k = 0; k + 1 < samples.length; k++) {
        const s0 = samples[k];
        const s1 = samples[k + 1];
        if (s1.c === s0.c) continue;
        for (let c = Math.ceil(s0.c); c < s1.c; c++) {
          const y = s0.y + ((s1.y - s0.y) * (c + 0.5 - s0.c)) / (s1.c - s0.c);
          expect(y).toBeLessThanOrEqual(side.column(Math.min(c, WORLD_X - 1)) - HORIZON_EDGE_DROP + 1e-6);
        }
      }
    }
  });
});
