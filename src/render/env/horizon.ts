/**
 * Horizon ring: fake low-resolution terrain around the 128 m map, from its edge out to ~600 m, so
 * the world fades into hills and haze instead of ending at a cliff. OWNER: agent "env-fx".
 *
 * One indexed geometry made of rings at growing distances d (finer near the map). Each ring is the
 * map rectangle grown by d — straight edges plus quarter-circle corners — so every vertex lies
 * exactly d outside the map and no triangle reaches into it. At d = 0 the ring sits on the map
 * boundary EDGE_DROP below the edge terrain; edge heights are min-filtered over ± one sample
 * spacing, so the linear interpolation between samples never rises above a voxel column. Outwards
 * the profile blends into rolling noise hills with dark canopy bumps (forest patches, dense next to
 * the forest). Vertex colours (linear) come from the top blocks along the edge (averaged over more of
 * them further out) and the biome blend at the nearest edge point.
 */
import * as THREE from 'three';
import { WORLD_X, WORLD_Z } from '../../config';
import { clamp, lerp, smoothstep, srgbToLinear } from '../../core/math';
import { createNoise2D, fbm2 } from '../../core/noise';
import type { ColumnSample, TerrainSampler } from '../../gen/types';
import { COLOR_TOP } from '../../world/blocks';

/** Ring distances from the map edge, world units: dense near the map, ~600 m at the far end. */
export const HORIZON_RINGS: readonly number[] = [
  0, 8, 20, 36, 60, 95, 140, 200, 280, 380, 510, 680, 900, 1180, 1530, 1960, 2480, 3100, 3850, 4800, 6000,
];
/** Spacing of the samples along each map edge (1 m). */
const EDGE_STEP = 10;
const CORNER_SEGMENTS = 8;
/** How far below the edge terrain the ring meets the map boundary. */
export const HORIZON_EDGE_DROP = 0.5;
/** Distance over which the edge profile blends into the hills. */
const BLEND_DISTANCE = 500;
/** ± perimeter samples averaged into the regional base height the hills sit on. */
const REGION_WINDOW = 25;
const NOISE_SEED = 0x6f72697a;

/** Biome palettes, indexed like ColumnSample.weights: town, forest, meadow, hills. */
const GROUND_COLORS = [0x6d8a46, 0x52703a, 0x6a9440, 0x77806a].map((hex) => new THREE.Color(hex));
const CANOPY_DENSITY = [0.25, 0.9, 0.15, 0.4];
const CANOPY_COLOR = new THREE.Color(0x2e4c22);
const ROCK_COLOR = new THREE.Color(0x8a877f);
/** Canopy bump height (world units) at full density, plus up to CANOPY_LUMP from crown-sized noise. */
const CANOPY_HEIGHT = 100;
const CANOPY_LUMP = 60;

/** One sample on the map boundary: where it is, which way is out, and what the terrain there looks like. */
interface EdgePoint {
  x: number;
  z: number;
  nx: number;
  nz: number;
  height: number;
  region: number;
  near: THREE.Color;
  ground: THREE.Color;
  canopy: number;
  hills: number;
}

/** Terrain heights of the outermost voxel row/column along one side, indexed by the varying coordinate. */
function sideHeights(terrain: TerrainSampler, side: number): Float32Array {
  const len = side % 2 === 0 ? WORLD_X : WORLD_Z;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    if (side === 0) out[i] = terrain.surfaceY(i, 0);
    else if (side === 1) out[i] = terrain.surfaceY(WORLD_X - 1, i);
    else if (side === 2) out[i] = terrain.surfaceY(i, WORLD_Z - 1);
    else out[i] = terrain.surfaceY(0, i);
  }
  return out;
}

/** Lowest column within ±EDGE_STEP of boundary coordinate `c` along a side. */
function windowMin(heights: Float32Array, c: number): number {
  const lo = clamp(Math.floor(c - EDGE_STEP), 0, heights.length - 1);
  const hi = clamp(Math.ceil(c + EDGE_STEP) - 1, 0, heights.length - 1);
  let m = Infinity;
  for (let i = lo; i <= hi; i++) m = Math.min(m, heights[i]);
  return m;
}

/**
 * Boundary samples in loop order: north edge west→east, NE corner, east edge north→south, SE corner,
 * south edge east→west, SW corner, west edge south→north, NW corner. Sides are numbered N=0, E=1,
 * S=2, W=3 (side heights: x for N/S, z for E/W).
 */
function edgePoints(terrain: TerrainSampler): EdgePoint[] {
  const heights = [0, 1, 2, 3].map((s) => sideHeights(terrain, s));
  const corners = [
    [0, 0],
    [WORLD_X, 0],
    [WORLD_X, WORLD_Z],
    [0, WORLD_Z],
  ];
  const normals = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  /** Window minimum on side `s` at boundary point (x, z). */
  const minOnSide = (s: number, x: number, z: number) => windowMin(heights[s], s % 2 === 0 ? x : z);

  const sample: ColumnSample = { biome: 0, weights: [0, 0, 0, 0], surfaceY: 0, waterY: 0, topBlock: 0 };
  const points: EdgePoint[] = [];
  const push = (x: number, z: number, nx: number, nz: number, height: number) => {
    // The voxel column just inside the boundary.
    const cx = clamp(Math.floor(x - nx * 0.5), 0, WORLD_X - 1);
    const cz = clamp(Math.floor(z - nz * 0.5), 0, WORLD_Z - 1);
    terrain.sample(cx, cz, sample);
    const ground = new THREE.Color(0, 0, 0);
    let canopy = 0;
    for (let b = 0; b < 4; b++) {
      ground.r += GROUND_COLORS[b].r * sample.weights[b];
      ground.g += GROUND_COLORS[b].g * sample.weights[b];
      ground.b += GROUND_COLORS[b].b * sample.weights[b];
      canopy += CANOPY_DENSITY[b] * sample.weights[b];
    }
    const t = sample.topBlock * 3;
    const near = new THREE.Color(srgbToLinear(COLOR_TOP[t] / 255), srgbToLinear(COLOR_TOP[t + 1] / 255), srgbToLinear(COLOR_TOP[t + 2] / 255));
    points.push({ x, z, nx, nz, height: height - HORIZON_EDGE_DROP, region: 0, near, ground, canopy, hills: sample.weights[3] });
  };

  for (let s = 0; s < 4; s++) {
    const [x0, z0] = corners[s];
    const [x1, z1] = corners[(s + 1) % 4];
    const [nx, nz] = normals[s];
    const length = Math.abs(x1 - x0) + Math.abs(z1 - z0);
    for (let i = 0; i < length; i += EDGE_STEP) {
      const x = x0 + ((x1 - x0) * i) / length;
      const z = z0 + ((z1 - z0) * i) / length;
      const own = minOnSide(s, x, z);
      // The first sample sits on the previous corner: the neighbouring side's window applies too.
      push(x, z, nx, nz, i === 0 ? Math.min(own, minOnSide((s + 3) % 4, x, z)) : own);
    }
    // Quarter circle around the end corner, from this side's normal towards the next side's.
    const [mx, mz] = normals[(s + 1) % 4];
    const cornerHeight = Math.min(minOnSide(s, x1, z1), minOnSide((s + 1) % 4, x1, z1));
    for (let k = 0; k < CORNER_SEGMENTS; k++) {
      const a = (k / CORNER_SEGMENTS) * (Math.PI / 2);
      push(x1, z1, nx * Math.cos(a) + mx * Math.sin(a), nz * Math.cos(a) + mz * Math.sin(a), cornerHeight);
    }
  }

  // Regional base height: a wide moving average around the loop.
  const n = points.length;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -REGION_WINDOW; k <= REGION_WINDOW; k++) sum += points[(i + k + n) % n].height;
    points[i].region = sum / (2 * REGION_WINDOW + 1);
  }
  return points;
}

/** Distance from ring k to the next ring out (to the previous one for the last ring). */
function ringSpacing(k: number): number {
  const last = HORIZON_RINGS.length - 1;
  return k < last ? HORIZON_RINGS[k + 1] - HORIZON_RINGS[k] : HORIZON_RINGS[last] - HORIZON_RINGS[last - 1];
}

/** Moving average over ± `radius` entries of a closed loop of `stride`-component values (wraps around). */
function loopAverage(values: Float32Array, stride: number, radius: number): Float32Array {
  const n = values.length / stride;
  const out = new Float32Array(values.length);
  const sum = new Float64Array(stride);
  for (let t = -radius; t <= radius; t++) {
    const q = (((t % n) + n) % n) * stride;
    for (let c = 0; c < stride; c++) sum[c] += values[q + c];
  }
  for (let j = 0; j < n; j++) {
    const add = ((j + radius + 1) % n) * stride;
    const drop = ((((j - radius) % n) + n) % n) * stride;
    for (let c = 0; c < stride; c++) {
      out[j * stride + c] = sum[c] / (2 * radius + 1);
      sum[c] += values[add + c] - values[drop + c];
    }
  }
  return out;
}

/**
 * Builds the ring geometry (positions, normals, linear vertex colours, 16-bit indices).
 *
 * Samples are 1 m apart along a ring but the rings are 0.8–120 m apart, so anything that changes from
 * one sample to the next along a ring is stretched into a long thin radial strip, and in perspective
 * these strips fan out from the map edge as light and dark rays. So detail along a ring is kept no
 * finer than the distance to the next ring: the edge block colours are averaged over about the
 * distance from the map, the noise scales and the forest edge width grow with the ring spacing, and
 * the normals are averaged along each ring over about one ring spacing. Ring 0 (the map boundary)
 * and ring 1 keep the exact edge colours, so the ring still meets the map without a seam.
 */
export function buildHorizonGeometry(terrain: TerrainSampler): THREE.BufferGeometry {
  const points = edgePoints(terrain);
  const perimeter = points.length;
  const rings = HORIZON_RINGS.length;
  const positions = new Float32Array(perimeter * rings * 3);
  const colors = new Float32Array(perimeter * rings * 3);
  const hillNoise = createNoise2D(NOISE_SEED);
  const forestNoise = createNoise2D(NOISE_SEED + 1);
  const lumpNoise = createNoise2D(NOISE_SEED + 2);
  const tintNoise = createNoise2D(NOISE_SEED + 3);
  const color = new THREE.Color();
  const edgeColors = new Float32Array(perimeter * 3);
  for (let j = 0; j < perimeter; j++) points[j].near.toArray(edgeColors, j * 3);

  for (let k = 0; k < rings; k++) {
    const d = HORIZON_RINGS[k];
    const spacing = ringSpacing(k);
    const blend = smoothstep(0, BLEND_DISTANCE, d);
    const canopyRamp = smoothstep(30, 160, d);
    const nearToGround = smoothstep(0, 300, d);
    const near = loopAverage(edgeColors, 3, Math.min(30, Math.round(d / (2 * EDGE_STEP))));
    const lumpScale = Math.max(70, 3 * spacing);
    const tintScale = Math.max(240, 3 * spacing);
    const forestEdge = 0.12 * Math.max(1, spacing / 60);
    for (let j = 0; j < perimeter; j++) {
      const p = points[j];
      const x = p.x + p.nx * d;
      const z = p.z + p.nz * d;
      const hillValue = fbm2(hillNoise, x / 1400, z / 1400, 4);
      const hills = (hillValue + 0.35) * (40 + d * 0.03);
      const lump = 0.5 + 0.5 * lumpNoise(x / lumpScale, z / lumpScale);
      const forest = smoothstep(-forestEdge, forestEdge, fbm2(forestNoise, x / 650, z / 650, 3) + (p.canopy - 0.5) * 1.6) * canopyRamp;
      const y = lerp(p.height, p.region + hills, blend) + forest * (CANOPY_HEIGHT + CANOPY_LUMP * lump);

      color.fromArray(near, j * 3).lerp(p.ground, nearToGround);
      color.lerp(ROCK_COLOR, p.hills * smoothstep(0.15, 0.6, hillValue) * blend * 0.7);
      const shade = 0.8 + 0.4 * lump;
      color.setRGB(
        lerp(color.r, CANOPY_COLOR.r * shade, forest),
        lerp(color.g, CANOPY_COLOR.g * shade, forest),
        lerp(color.b, CANOPY_COLOR.b * shade, forest),
      );
      color.multiplyScalar(1 + 0.08 * blend * tintNoise(x / tintScale, z / tintScale));

      const o = (k * perimeter + j) * 3;
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
      colors[o] = color.r;
      colors[o + 1] = color.g;
      colors[o + 2] = color.b;
    }
  }

  // Quads between consecutive rings; the loop runs clockwise seen from above, so (a, b, c) faces up.
  const index = new Uint16Array((rings - 1) * perimeter * 6);
  let i = 0;
  for (let k = 0; k < rings - 1; k++) {
    for (let j = 0; j < perimeter; j++) {
      const a = k * perimeter + j;
      const b = k * perimeter + ((j + 1) % perimeter);
      const c = b + perimeter;
      const e = a + perimeter;
      index[i++] = a;
      index[i++] = b;
      index[i++] = c;
      index[i++] = a;
      index[i++] = c;
      index[i++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute('normal').array as Float32Array;
  for (let k = 1; k < rings; k++) {
    const radius = Math.min(40, Math.round(ringSpacing(k) / (2 * EDGE_STEP)));
    const ring = normals.subarray(k * perimeter * 3, (k + 1) * perimeter * 3);
    const smooth = loopAverage(ring, 3, radius);
    for (let j = 0; j < perimeter * 3; j += 3) {
      const length = Math.hypot(smooth[j], smooth[j + 1], smooth[j + 2]) || 1;
      ring[j] = smooth[j] / length;
      ring[j + 1] = smooth[j + 1] / length;
      ring[j + 2] = smooth[j + 2] / length;
    }
  }
  geometry.computeBoundingSphere();
  return geometry;
}

/** The ring as a static, fogged, shadow-receiving mesh drawn after the world (cheap early-z rejection). */
export function createHorizon(terrain: TerrainSampler): THREE.Mesh {
  const mesh = new THREE.Mesh(buildHorizonGeometry(terrain), new THREE.MeshLambertMaterial({ vertexColors: true, name: 'horizon' }));
  mesh.name = 'horizon';
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}
