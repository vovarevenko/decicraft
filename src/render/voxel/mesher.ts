/**
 * Greedy voxel mesher: padded cell volume (see volume.ts) → compact vertex arrays for the opaque,
 * glass, water and plant layers of one octree node. Pure TypeScript (no three.js): runs in the mesh
 * workers and in node tests. Spec: ARCHITECTURE.md §6.1, vertex layout: layout.ts.
 *
 * Faces are merged per direction and slice when their 32-bit keys are equal:
 *   block id (8 bits) | 4 × 2-bit corner AO | 4 × 4-bit corner skylight.
 * Water stores a per-corner "lowered" flag in the AO bits (surface vertices sit ~0.1 voxel lower);
 * glass, water, skirts and every face above level 0 use AO = 3, which also merges better.
 *
 * Visibility: opaque faces show against non-OPAQUE neighbours (foliage is opaque, so leaf-to-leaf
 * faces are culled), glass against neither OPAQUE nor glass, water against air and plants. Faces
 * towards air pockets that are sealed inside the node (e.g. hollow tree crowns) are culled as well;
 * the pockets are reported so the renderer can re-mesh with the camera as an extra open seed if the
 * camera ever enters one. Faces on the world's side planes (never visible from inside) are skipped.
 *
 * Skirts: on node faces that have a neighbour node, every opaque border cell within 2 cells of a
 * non-opaque cell also emits its outward face when the padding cell is opaque. Hidden by depth when
 * the neighbour has the same LOD, they close the cracks when it does not.
 *
 * Speed: opaque faces are found with 64-bit row bitmasks (two Int32 words per x-row: emitters and
 * open-and-reachable cells), so only real faces are visited; open space is flood-filled by x-runs.
 */
import { hash32, hash3 } from '../../core/rng';
import { OPAQUE as OPAQUE_TABLE, PLANT_HEIGHT, RENDER_KIND as RENDER_KIND_TABLE, RK } from '../../world/blocks';
import {
  COLS as COLS_EDGE,
  DIR,
  NODE_CELLS,
  PAD as PAD_EDGE,
  PLANT_HALF_WIDTH,
  PLANT_MAX_HEIGHT,
  PLANT_POS_SCALE,
  PLANT_TILE,
  SKY_REACH as SKY_REACH_CELLS,
  VERTS as VERTS_EDGE,
  VOXEL_VERTEX_BYTES,
  padIndex as padIndexOf,
} from './layout';

// Module-local bindings for the hot loops: some module runners (vitest) compile imported bindings
// into getter calls, which would distort the benchmarks several times over.
const OPAQUE = OPAQUE_TABLE;
const RENDER_KIND = RENDER_KIND_TABLE;
const RK_PLANT: number = RK.PLANT;
const RK_NONE: number = RK.NONE;
const PAD = PAD_EDGE;
const PAD2 = PAD * PAD;
const PAD3 = PAD2 * PAD;
const VERTS = VERTS_EDGE;
const VERTS3 = VERTS * VERTS * VERTS;
const COLS = COLS_EDGE;
const SKY_REACH = SKY_REACH_CELLS;
const padIndex = padIndexOf;
const { PX, NX, PY, NY, PZ, NZ } = DIR;

export interface MeshParams {
  level: number;
  /** Node origin in voxels. */
  ox: number;
  oy: number;
  oz: number;
  /** DIR bits of node faces that lie on the world boundary (no neighbour node). */
  boundary: number;
  /** Padded index of an interior cell that always counts as open space (the camera), or −1. */
  seed: number;
}

export interface MeshOutput {
  /** Interleaved opaque vertices (VOXEL_VERTEX_BYTES each, 4 per quad) or null. */
  opaque: Uint8Array | null;
  opaqueQuads: number;
  glass: Uint8Array | null;
  glassQuads: number;
  water: Uint8Array | null;
  waterQuads: number;
  /** Plant positions (Int16 × 4 per vertex) and data (Uint8 × 4 per vertex), 4 vertices per quad. */
  plantPos: Int16Array | null;
  plantData: Uint8Array | null;
  plantQuads: number;
  /**
   * Boxes of sealed air pockets whose faces were culled: (x0, y0, z0, x1, y1, z1) in node cells, max
   * exclusive, 6 values per box; null if none.
   */
  cavities: Int16Array | null;
}

const N = NODE_CELLS;
const NN = N * N;
const QUAD_BYTES = 4 * VOXEL_VERTEX_BYTES;
const START = padIndex(0, 0, 0);
const MAX_CAVITY_BOXES = 8;
const PLANT_SEED = 0x51a7;

const LAYER_OPAQUE = 1;
const LAYER_GLASS = 2;
const LAYER_WATER = 3;

/** Layer that receives the cube faces of each block id (0 = none: air, plants). */
const FACE_LAYER = new Uint8Array(256);
/** VISIBLE[layer << 8 | neighbour id] = 1 when a face of that layer shows against the neighbour. */
const VISIBLE = new Uint8Array(4 << 8);
for (let id = 0; id < 256; id++) {
  const rk = RENDER_KIND[id];
  FACE_LAYER[id] = rk === RK.CUBE ? LAYER_OPAQUE : rk === RK.GLASS ? LAYER_GLASS : rk === RK.WATER ? LAYER_WATER : 0;
  VISIBLE[(LAYER_OPAQUE << 8) | id] = OPAQUE[id] ^ 1;
  VISIBLE[(LAYER_GLASS << 8) | id] = OPAQUE[id] === 0 && rk !== RK.GLASS ? 1 : 0;
  VISIBLE[(LAYER_WATER << 8) | id] = rk === RK.NONE || rk === RK.PLANT ? 1 : 0;
}

interface FaceDir {
  /** Volume index steps along the slice axes u and v, towards the neighbour, and between slices. */
  du: number;
  dv: number;
  dn: number;
  ds: number;
  /** 1 for positive directions (face plane at slice + 1). */
  pos: number;
  /** Vertex-light cache steps along n, u, v. */
  cn: number;
  cu: number;
  cv: number;
  /** 0/1 factors: x = n·xn + u·xu + v·xv, …; and conversely n = x·xn + y·yn + z·zn, … */
  xn: number;
  xu: number;
  xv: number;
  yn: number;
  yu: number;
  yv: number;
  zn: number;
  zu: number;
  zv: number;
  /** AO-field bits of the corners on the face's top edge (lowered on surface water faces). */
  waterTop: number;
  horizontal: boolean;
  /** Offset of the direction's vertex-light cache: ±Y faces share one, each horizontal normal has its own. */
  light: number;
  /**
   * Horizontal normals, column-grid steps from a vertex's lower column (see Mesher.computeLight): to the
   * nearest column in front of the face, one column further out, and to the other column beside the vertex.
   */
  skyFirst: number;
  skyOut: number;
  skySide: number;
}

/**
 * Per direction: [normal axis, u axis, v axis] (0 = x, 1 = y, 2 = z) with u × v = normal, so corners
 * (u,v) → (u+1,v) → (u+1,v+1) → (u,v+1) wind counter-clockwise seen from outside.
 */
const AXES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], // +X: u = y, v = z
  [0, 2, 1], // −X: u = z, v = y
  [1, 2, 0], // +Y: u = z, v = x
  [1, 0, 2], // −Y: u = x, v = z
  [2, 0, 1], // +Z: u = x, v = y
  [2, 1, 0], // −Z: u = y, v = x
];
const VOL_STEP = [1, PAD2, PAD];
const LIGHT_STEP = [1, VERTS * VERTS, VERTS];
/** Column-grid steps along x and z (index 1, y, is unused). */
const COL_STEP = [1, 0, COLS];
/**
 * Per LOD level, the rows of columns in front of a vertical face (0 = nearest, ≤ SKY_REACH) whose
 * skylight the face averages besides row 0. Level 0 samples the voxel columns 0, 2 and 5 out; the
 * coarser levels have one column sample per cell (0–2 voxels out in row 0) and use rows that keep
 * walls under eaves 2–4 voxels deep as bright as at level 0, so they do not pop at LOD switches
 * (town exterior walls average 0.67 at levels 0 and 1; level 2 walls sit up to 3 voxels further out).
 */
const SKY_ROWS: readonly (readonly [number, number])[] = [
  [2, 5],
  [0, 2],
  [0, 1],
];

const FACE_DIRS: readonly FaceDir[] = AXES.map(([n, u, v], d) => {
  const pos = d % 2 === 0 ? 1 : 0;
  const is = (axis: number, target: number): number => (axis === target ? 1 : 0);
  return {
    du: VOL_STEP[u],
    dv: VOL_STEP[v],
    dn: pos ? VOL_STEP[n] : -VOL_STEP[n],
    ds: VOL_STEP[n],
    pos,
    cn: LIGHT_STEP[n],
    cu: LIGHT_STEP[u],
    cv: LIGHT_STEP[v],
    xn: is(n, 0),
    xu: is(u, 0),
    xv: is(v, 0),
    yn: is(n, 1),
    yu: is(u, 1),
    yv: is(v, 1),
    zn: is(n, 2),
    zu: is(u, 2),
    zv: is(v, 2),
    waterTop: d === PY ? 0x55 : d === NY ? 0 : u === 1 ? 0x14 : 0x50,
    horizontal: n !== 1,
    light: n === 1 ? 0 : [1, 2, 0, 0, 3, 4][d] * VERTS3,
    skyFirst: n === 1 ? 0 : pos * COL_STEP[n],
    skyOut: n === 1 ? 0 : pos ? COL_STEP[n] : -COL_STEP[n],
    skySide: n === 1 ? 0 : COL_STEP[2 - n],
  };
});

const NEIGHBOUR_STEP = [1, -1, PAD, -PAD, PAD2, -PAD2];

/**
 * Skylight of one column at height y (voxels): roof · leaf, where roof fades from 1 (open sky) to 0.25
 * at 36 voxels under the column's sky height and leaf = 0.6 under foliage.
 */
export function columnLight(y: number, sky: number, canopy: number): number {
  const roof = y >= sky ? 1 : Math.max(0.25, 1 - (sky - y) / 48);
  return y >= canopy ? roof : roof * 0.6;
}

/** Growable output of 32-byte quads. */
class QuadWriter {
  bytes: Uint8Array;
  quads = 0;

  constructor(initialQuads: number) {
    this.bytes = new Uint8Array(initialQuads * QUAD_BYTES);
  }

  /** Byte offset for one more quad (the buffer may be replaced: re-read `bytes` afterwards). */
  next(): number {
    const o = this.quads * QUAD_BYTES;
    if (o + QUAD_BYTES > this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.quads++;
    return o;
  }

  take(): Uint8Array | null {
    return this.quads === 0 ? null : this.bytes.slice(0, this.quads * QUAD_BYTES);
  }
}

/** Growable output of plant quads (positions and data in separate arrays). */
class PlantWriter {
  pos: Int16Array;
  data: Uint8Array;
  quads = 0;

  constructor(initialQuads: number) {
    this.pos = new Int16Array(initialQuads * 16);
    this.data = new Uint8Array(initialQuads * 16);
  }

  /** Index of the quad's first vertex (the arrays may be replaced: re-read them afterwards). */
  next(): number {
    const v = this.quads * 4;
    if ((v + 4) * 4 > this.data.length) {
      const pos = new Int16Array(this.pos.length * 2);
      pos.set(this.pos);
      this.pos = pos;
      const data = new Uint8Array(this.data.length * 2);
      data.set(this.data);
      this.data = data;
    }
    this.quads++;
    return v;
  }
}

/** Reusable mesher; all scratch memory is allocated once per instance (one per worker). */
export class Mesher {
  /** Face keys of all 64 slices of the direction being meshed (slice s at s·N²). */
  private readonly masks = new Int32Array(N * NN);
  private readonly sliceUsed = new Uint8Array(N);
  /**
   * Row bitmasks, two Int32 words (x 0..31, x 32..63) per padded x-row r = (z+1) + (y+1)·PAD:
   * cells emitting opaque faces, and open cells reachable from outside the node.
   */
  private readonly rowEmit = new Int32Array(PAD2 * 2);
  private readonly rowOpen = new Int32Array(PAD2 * 2);
  /** rowOpen bits of the padding cells x = −1 (even index) and x = 64 (odd index). */
  private readonly edgeOpen = new Int32Array(PAD2 * 2);
  /** Interior rows holding glass or water. */
  private readonly rowMixed = new Uint8Array(PAD2);
  /** Vertex skylight caches (VERTS³ each; ±Y faces, then ±X, ±Z: FaceDir.light), 0xff = not computed yet. */
  private readonly lightCache = new Uint8Array(5 * VERTS3);
  /** Per padded cell: 1 = open space reachable from outside the node, 2 = sealed pocket, 0 = other. */
  private readonly outside = new Uint8Array(PAD3);
  /** Flood queue of x-runs: x0 | x1 << 7 | (y·N + z) << 14. */
  private readonly runs = new Int32Array(N * NN);
  private readonly cellQueue = new Int32Array(N * NN);
  private readonly plantCells = new Int32Array(N * NN);
  private readonly skirtA = new Uint8Array(PAD2);
  private readonly skirtB = new Uint8Array(PAD2);
  private readonly skirtNear = new Uint8Array(NN);
  private readonly boxes = new Int16Array(MAX_CAVITY_BOXES * 6);
  private readonly opaqueOut = new QuadWriter(16384);
  private readonly glassOut = new QuadWriter(1024);
  private readonly waterOut = new QuadWriter(1024);
  private readonly plantOut = new PlantWriter(1024);

  private level = 0;
  private cell = 1;
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private boundary = 0;
  private colSky: Int16Array = new Int16Array(COLS * COLS);
  private colCanopy: Int16Array = new Int16Array(COLS * COLS);
  /** SKY_ROWS of the level being meshed (the rows after row 0). */
  private skyRow1 = 2;
  private skyRow2 = 5;
  private countOpaque = 0;
  private countOpen = 0;
  private countMixed = 0;
  private countPlants = 0;
  private runCount = 0;
  private reached = 0;

  /**
   * Meshes one node. `vol` is the padded cell volume (padIndex order), `colSky` / `colCanopy` the
   * column samples of VolumeBuilder. The returned arrays are fresh copies (safe to transfer).
   */
  mesh(vol: Uint8Array, colSky: Int16Array, colCanopy: Int16Array, p: MeshParams): MeshOutput {
    this.level = p.level;
    this.cell = 1 << p.level;
    const rows = SKY_ROWS[Math.min(p.level, SKY_ROWS.length - 1)];
    this.skyRow1 = rows[0];
    this.skyRow2 = rows[1];
    this.ox = p.ox;
    this.oy = p.oy;
    this.oz = p.oz;
    this.boundary = p.boundary;
    this.colSky = colSky;
    this.colCanopy = colCanopy;
    this.opaqueOut.quads = 0;
    this.glassOut.quads = 0;
    this.waterOut.quads = 0;
    this.plantOut.quads = 0;

    this.scan(vol);
    let cavities: Int16Array | null = null;
    if (this.countOpaque + this.countMixed + this.countPlants > 0) {
      if (this.countOpaque > 0 && this.countOpen > 0) {
        if (this.flood(vol, p.seed) < this.countOpen) cavities = this.collectCavities(vol);
      } else {
        this.outside.fill(1);
      }
      this.lightCache.fill(0xff);
      if (this.countOpaque > 0) {
        for (let d = 0; d < 6; d++) this.opaqueFaces(vol, d);
      }
      if (this.countMixed > 0) {
        for (let d = 0; d < 6; d++) {
          this.layerFaces(vol, d, LAYER_GLASS, this.glassOut);
          this.layerFaces(vol, d, LAYER_WATER, this.waterOut);
        }
      }
      if (p.level === 0) {
        for (let k = 0; k < this.countPlants; k++) this.plant(vol, this.plantCells[k]);
      }
    }
    const pq = this.plantOut.quads;
    return {
      opaque: this.opaqueOut.take(),
      opaqueQuads: this.opaqueOut.quads,
      glass: this.glassOut.take(),
      glassQuads: this.glassOut.quads,
      water: this.waterOut.take(),
      waterQuads: this.waterOut.quads,
      plantPos: pq > 0 ? this.plantOut.pos.slice(0, pq * 16) : null,
      plantData: pq > 0 ? this.plantOut.data.slice(0, pq * 16) : null,
      plantQuads: pq,
      cavities,
    };
  }

  /**
   * One pass over the padded volume: counts, plant list, rows with glass/water, and the row bitmasks
   * (emitters for interior rows; open cells for every row — refined by flood() when pockets exist).
   */
  private scan(vol: Uint8Array): void {
    const emit = this.rowEmit;
    const open = this.rowOpen;
    const edge = this.edgeOpen;
    let opaque = 0;
    let openCount = 0;
    let mixed = 0;
    let plants = 0;
    for (let y = -1; y <= N; y++) {
      for (let z = -1; z <= N; z++) {
        const r = z + 1 + (y + 1) * PAD;
        const base = padIndex(0, y, z);
        edge[2 * r] = OPAQUE[vol[base - 1]] ^ 1;
        edge[2 * r + 1] = OPAQUE[vol[base + N]] ^ 1;
        let openLo = 0;
        let openHi = 0;
        let emitLo = 0;
        let emitHi = 0;
        let rowMixed = 0;
        if (y < 0 || y >= N || z < 0 || z >= N) {
          for (let x = 0; x < 32; x++) openLo |= (OPAQUE[vol[base + x]] ^ 1) << x;
          for (let x = 0; x < 32; x++) openHi |= (OPAQUE[vol[base + 32 + x]] ^ 1) << x;
        } else {
          for (let x = 0; x < N; x++) {
            const i = base + x;
            const id = vol[i];
            const bit = 1 << (x & 31);
            if (OPAQUE[id] === 1) {
              opaque++;
              if (FACE_LAYER[id] === LAYER_OPAQUE) {
                if (x < 32) emitLo |= bit;
                else emitHi |= bit;
              }
              continue;
            }
            openCount++;
            if (x < 32) openLo |= bit;
            else openHi |= bit;
            const rk = RENDER_KIND[id];
            if (rk === RK_PLANT) {
              this.plantCells[plants++] = i;
            } else if (rk !== RK_NONE) {
              rowMixed = 1;
              mixed++;
            }
          }
          this.rowMixed[r] = rowMixed;
        }
        open[2 * r] = openLo;
        open[2 * r + 1] = openHi;
        emit[2 * r] = emitLo;
        emit[2 * r + 1] = emitHi;
      }
    }
    this.countOpaque = opaque;
    this.countOpen = openCount;
    this.countMixed = mixed;
    this.countPlants = plants;
  }

  /** Opaque faces (and skirts) of direction d: row bitmasks → slice masks → greedy quads. */
  private opaqueFaces(vol: Uint8Array, d: number): void {
    const F = FACE_DIRS[d];
    const emit = this.rowEmit;
    const open = this.rowOpen;
    const edge = this.edgeOpen;
    const onBoundary = (this.boundary >> d) & 1;
    // Faces on a world side plane are dropped: bit x = 63 / 0 for ±X, row z = 63 / 0 for ±Z.
    const keepHi = onBoundary === 1 && d === PX ? ~(1 << 31) : -1;
    const keepLo = onBoundary === 1 && d === NX ? ~1 : -1;
    const dropZ = onBoundary === 1 && d === PZ ? N - 1 : onBoundary === 1 && d === NZ ? 0 : -1;
    const nbRow = d === PY ? PAD : d === NY ? -PAD : d === PZ ? 1 : d === NZ ? -1 : 0;
    this.sliceUsed.fill(0);
    for (let y = 0; y < N; y++) {
      for (let z = 0; z < N; z++) {
        const r = z + 1 + (y + 1) * PAD;
        const eLo = emit[2 * r];
        const eHi = emit[2 * r + 1];
        if ((eLo | eHi) === 0 || z === dropZ) continue;
        let lo: number;
        let hi: number;
        if (d === PX) {
          lo = eLo & ((open[2 * r] >>> 1) | (open[2 * r + 1] << 31));
          hi = eHi & ((open[2 * r + 1] >>> 1) | (edge[2 * r + 1] << 31)) & keepHi;
        } else if (d === NX) {
          lo = eLo & ((open[2 * r] << 1) | edge[2 * r]) & keepLo;
          hi = eHi & ((open[2 * r + 1] << 1) | (open[2 * r] >>> 31));
        } else {
          const rn = r + nbRow;
          lo = eLo & open[2 * rn];
          hi = eHi & open[2 * rn + 1];
        }
        while (lo !== 0) {
          const t = lo & -lo;
          lo ^= t;
          this.opaqueFace(vol, F, d, 31 - Math.clz32(t), y, z, false);
        }
        while (hi !== 0) {
          const t = hi & -hi;
          hi ^= t;
          this.opaqueFace(vol, F, d, 63 - Math.clz32(t), y, z, false);
        }
      }
    }
    if (onBoundary === 0) this.skirtFaces(vol, F, d);
    const pos = F.pos;
    const aoFlip = this.level === 0;
    for (let s = 0; s < N; s++) if (this.sliceUsed[s] === 1) this.merge(s * NN, d, s + pos, this.opaqueOut, aoFlip);
  }

  /** Writes the key of the d-face of cell (x, y, z) into its slice mask. */
  private opaqueFace(vol: Uint8Array, F: FaceDir, d: number, x: number, y: number, z: number, skirt: boolean): void {
    const n = x * F.xn + y * F.yn + z * F.zn;
    const u = x * F.xu + y * F.yu + z * F.zu;
    const v = x * F.xv + y * F.yv + z * F.zv;
    const idx = padIndex(x, y, z);
    let ao = 0xff;
    if (this.level === 0 && !skirt) {
      const nb = idx + F.dn;
      const du = F.du;
      const dv = F.dv;
      const a = OPAQUE[vol[nb - du]];
      const b = OPAQUE[vol[nb + du]];
      const c = OPAQUE[vol[nb - dv]];
      const e = OPAQUE[vol[nb + dv]];
      ao =
        (a & c ? 0 : 3 - a - c - OPAQUE[vol[nb - du - dv]]) |
        ((b & c ? 0 : 3 - b - c - OPAQUE[vol[nb + du - dv]]) << 2) |
        ((b & e ? 0 : 3 - b - e - OPAQUE[vol[nb + du + dv]]) << 4) |
        ((a & e ? 0 : 3 - a - e - OPAQUE[vol[nb - du + dv]]) << 6);
    }
    this.masks[n * NN + u + v * N] = this.faceKey(vol[idx], ao, F, (n + F.pos) * F.cn + u * F.cu + v * F.cv);
    this.sliceUsed[n] = 1;
  }

  /** Skirt faces on direction d's border plane (only where the padding cell is opaque). */
  private skirtFaces(vol: Uint8Array, F: FaceDir, d: number): void {
    this.buildSkirtMask(vol, F);
    const near = this.skirtNear;
    const sb = F.pos === 1 ? N - 1 : 0;
    const base = START + sb * F.ds;
    for (let v = 0; v < N; v++) {
      for (let u = 0; u < N; u++) {
        if (near[u + v * N] === 0) continue;
        const idx = base + u * F.du + v * F.dv;
        if (FACE_LAYER[vol[idx]] !== LAYER_OPAQUE || OPAQUE[vol[idx + F.dn]] === 0) continue;
        const x = sb * F.xn + u * F.xu + v * F.xv;
        const y = sb * F.yn + u * F.yu + v * F.yv;
        const z = sb * F.zn + u * F.zu + v * F.zv;
        this.opaqueFace(vol, F, d, x, y, z, true);
      }
    }
  }

  /** Glass or water faces of direction d, scanning only the rows that contain glass or water. */
  private layerFaces(vol: Uint8Array, d: number, layer: number, out: QuadWriter): void {
    const F = FACE_DIRS[d];
    const outside = this.outside;
    const onBoundary = (this.boundary >> d) & 1;
    const border = F.pos === 1 ? N - 1 : 0;
    let any = false;
    this.sliceUsed.fill(0);
    for (let y = 0; y < N; y++) {
      for (let z = 0; z < N; z++) {
        if (this.rowMixed[z + 1 + (y + 1) * PAD] === 0) continue;
        const base = padIndex(0, y, z);
        for (let x = 0; x < N; x++) {
          const idx = base + x;
          const id = vol[idx];
          if (FACE_LAYER[id] !== layer) continue;
          const nb = idx + F.dn;
          if (VISIBLE[(layer << 8) | vol[nb]] === 0 || outside[nb] !== 1) continue;
          const n = x * F.xn + y * F.yn + z * F.zn;
          if (onBoundary === 1 && F.horizontal && n === border) continue;
          const u = x * F.xu + y * F.yu + z * F.zu;
          const v = x * F.xv + y * F.yv + z * F.zv;
          let flags = 0xff;
          if (layer === LAYER_WATER) {
            if (d === PY) flags = 0x55;
            else if (d === NY) flags = 0;
            else flags = VISIBLE[(LAYER_WATER << 8) | vol[idx + PAD2]] === 1 ? F.waterTop : 0;
          }
          this.masks[n * NN + u + v * N] = this.faceKey(id, flags, F, (n + F.pos) * F.cn + u * F.cu + v * F.cv);
          this.sliceUsed[n] = 1;
          any = true;
        }
      }
    }
    if (!any) return;
    for (let s = 0; s < N; s++) if (this.sliceUsed[s] === 1) this.merge(s * NN, d, s + F.pos, out, false);
  }

  /** Merge key: block id, 4 × 2 bits of AO (or water flags), 4 × 4 bits of corner skylight. */
  private faceKey(id: number, ao: number, F: FaceDir, ci: number): number {
    const lc = this.lightCache;
    const at = F.light + ci;
    let l0 = lc[at];
    if (l0 === 0xff) l0 = this.computeLight(ci, F);
    let l1 = lc[at + F.cu];
    if (l1 === 0xff) l1 = this.computeLight(ci + F.cu, F);
    let l2 = lc[at + F.cu + F.cv];
    if (l2 === 0xff) l2 = this.computeLight(ci + F.cu + F.cv, F);
    let l3 = lc[at + F.cv];
    if (l3 === 0xff) l3 = this.computeLight(ci + F.cv, F);
    return id | (ao << 8) | (l0 << 16) | (l1 << 20) | (l2 << 24) | (l3 << 28);
  }

  /** Greedy rectangles of equal keys in the slice mask at `offset`; clears the mask as it goes. */
  private merge(offset: number, d: number, pn: number, out: QuadWriter, aoFlip: boolean): void {
    const mask = this.masks;
    for (let v = 0; v < N; v++) {
      const row = offset + v * N;
      for (let u = 0; u < N; ) {
        const key = mask[row + u];
        if (key === 0) {
          u++;
          continue;
        }
        let w = 1;
        while (u + w < N && mask[row + u + w] === key) w++;
        let h = 1;
        grow: while (v + h < N) {
          const r = row + h * N + u;
          for (let k = 0; k < w; k++) if (mask[r + k] !== key) break grow;
          h++;
        }
        for (let k = 0; k < h; k++) {
          const r = row + k * N + u;
          mask.fill(0, r, r + w);
        }
        this.emit(out, d, pn, u, v, w, h, key, aoFlip);
        u += w;
      }
    }
  }

  /**
   * Writes one quad. The triangulation diagonal follows the darker corner pair (AO first, then sky) by
   * rotating the vertex order, so the shared index pattern (0,1,2)(0,2,3) needs no variants.
   */
  private emit(out: QuadWriter, d: number, pn: number, u: number, v: number, w: number, h: number, key: number, aoFlip: boolean): void {
    const F = FACE_DIRS[d];
    const id = key & 0xff;
    const a0 = (key >>> 8) & 3;
    const a1 = (key >>> 10) & 3;
    const a2 = (key >>> 12) & 3;
    const a3 = (key >>> 14) & 3;
    const l0 = (key >>> 16) & 15;
    const l1 = (key >>> 20) & 15;
    const l2 = (key >>> 24) & 15;
    const l3 = (key >>> 28) & 15;
    const ls = l0 + l2 - l1 - l3;
    const as = aoFlip ? a0 + a2 - a1 - a3 : 0;
    const flip = as < 0 || (as === 0 && ls < 0);
    const o = out.next();
    const b = out.bytes;
    const u1 = u + w;
    const v1 = v + h;
    if (flip) {
      putVertex(b, o, F, pn, u1, v, d, a1, l1, id);
      putVertex(b, o + 8, F, pn, u1, v1, d, a2, l2, id);
      putVertex(b, o + 16, F, pn, u, v1, d, a3, l3, id);
      putVertex(b, o + 24, F, pn, u, v, d, a0, l0, id);
    } else {
      putVertex(b, o, F, pn, u, v, d, a0, l0, id);
      putVertex(b, o + 8, F, pn, u1, v, d, a1, l1, id);
      putVertex(b, o + 16, F, pn, u1, v1, d, a2, l2, id);
      putVertex(b, o + 24, F, pn, u, v1, d, a3, l3, id);
    }
  }

  /**
   * Quantised (0..15) skylight of the vertex at light-cache index ci on faces of direction F. ±Y faces
   * average the 4 columns around the vertex. Vertical faces average the 2 columns beside the vertex in
   * row 0 and the level's two SKY_ROWS rows in front of the face: the wall's own columns are under its
   * roof, and the columns right in front are often under its eaves.
   */
  private computeLight(ci: number, F: FaceDir): number {
    const px = ci % VERTS;
    const rest = (ci - px) / VERTS;
    const pz = rest % VERTS;
    const py = (rest - pz) / VERTS;
    const y = this.oy + py * this.cell;
    const c = px + SKY_REACH + (pz + SKY_REACH) * COLS;
    const sky = this.colSky;
    const can = this.colCanopy;
    let q: number;
    if (F.horizontal) {
      const side = F.skySide;
      const a = c + F.skyFirst;
      const b = a + this.skyRow1 * F.skyOut;
      const e = a + this.skyRow2 * F.skyOut;
      const sum =
        columnLight(y, sky[a], can[a]) +
        columnLight(y, sky[a + side], can[a + side]) +
        columnLight(y, sky[b], can[b]) +
        columnLight(y, sky[b + side], can[b + side]) +
        columnLight(y, sky[e], can[e]) +
        columnLight(y, sky[e + side], can[e + side]);
      q = Math.round(sum * 2.5);
    } else {
      const sum =
        columnLight(y, sky[c], can[c]) +
        columnLight(y, sky[c + 1], can[c + 1]) +
        columnLight(y, sky[c + COLS], can[c + COLS]) +
        columnLight(y, sky[c + COLS + 1], can[c + COLS + 1]);
      q = Math.round(sum * 3.75);
    }
    this.lightCache[F.light + ci] = q;
    return q;
  }

  /**
   * Marks open cells reachable from outside the node (6-connected through non-opaque cells, starting
   * at interior border cells next to non-opaque padding, plus the seed); padding counts as open.
   * Fills whole x-runs at a time. Returns the number of interior cells reached.
   */
  private flood(vol: Uint8Array, seed: number): number {
    const out = this.outside;
    out.fill(0);
    out.fill(1, 0, PAD2);
    out.fill(1, PAD3 - PAD2, PAD3);
    for (let y = 1; y <= N; y++) {
      const b = y * PAD2;
      out.fill(1, b, b + PAD);
      out.fill(1, b + PAD2 - PAD, b + PAD2);
      for (let z = 1; z <= N; z++) {
        out[b + z * PAD] = 1;
        out[b + z * PAD + PAD - 1] = 1;
      }
    }
    this.runCount = 0;
    this.reached = 0;
    // Seeds: interior cells on the node faces whose padding neighbour is open.
    for (let a = 0; a < N; a++) {
      for (let c = 0; c < N; c++) {
        this.seedRun(vol, -1, 0, a, c);
        this.seedRun(vol, 1, N - 1, a, c);
        this.seedRun(vol, -PAD2, a, 0, c);
        this.seedRun(vol, PAD2, a, N - 1, c);
        this.seedRun(vol, -PAD, a, c, 0);
        this.seedRun(vol, PAD, a, c, N - 1);
      }
    }
    if (seed >= 0 && this.isFree(vol, seed)) {
      const sx = (seed % PAD) - 1;
      const rest = (seed - sx - 1) / PAD;
      const sz = (rest % PAD) - 1;
      this.pushRun(vol, sx, (rest - sz - 1) / PAD - 1, sz);
    }
    const runs = this.runs;
    while (this.runCount > 0) {
      const run = runs[--this.runCount];
      const x0 = run & 127;
      const x1 = (run >>> 7) & 127;
      const yz = run >>> 14;
      const y = (yz / N) | 0;
      const z = yz - y * N;
      if (y > 0) this.scanRow(vol, x0, x1, y - 1, z);
      if (y < N - 1) this.scanRow(vol, x0, x1, y + 1, z);
      if (z > 0) this.scanRow(vol, x0, x1, y, z - 1);
      if (z < N - 1) this.scanRow(vol, x0, x1, y, z + 1);
    }
    return this.reached;
  }

  private isFree(vol: Uint8Array, i: number): boolean {
    return this.outside[i] === 0 && OPAQUE[vol[i]] === 0;
  }

  /** Seeds the run through interior border cell (x, y, z) if its padding neighbour (at +toPadding) is open. */
  private seedRun(vol: Uint8Array, toPadding: number, x: number, y: number, z: number): void {
    const i = padIndex(x, y, z);
    if (OPAQUE[vol[i + toPadding]] === 0 && this.isFree(vol, i)) this.pushRun(vol, x, y, z);
  }

  /** Marks the maximal free x-run through interior cell (x, y, z) and queues it; returns its end x. */
  private pushRun(vol: Uint8Array, x: number, y: number, z: number): number {
    const base = padIndex(0, y, z);
    let x0 = x;
    let x1 = x + 1;
    while (x0 > 0 && this.isFree(vol, base + x0 - 1)) x0--;
    while (x1 < N && this.isFree(vol, base + x1)) x1++;
    this.outside.fill(1, base + x0, base + x1);
    this.runs[this.runCount++] = x0 | (x1 << 7) | ((y * N + z) << 14);
    this.reached += x1 - x0;
    return x1;
  }

  /** Queues every free run of row (y, z) that touches [x0, x1). */
  private scanRow(vol: Uint8Array, x0: number, x1: number, y: number, z: number): void {
    const base = padIndex(0, y, z);
    for (let x = x0; x < x1; x++) {
      if (this.isFree(vol, base + x)) x = this.pushRun(vol, x, y, z);
    }
  }

  /**
   * Labels the sealed pockets left by flood() (marks them 2, clears their open bits so no opaque face
   * points at them) and returns their bounding boxes.
   */
  private collectCavities(vol: Uint8Array): Int16Array {
    const out = this.outside;
    const q = this.cellQueue;
    const open = this.rowOpen;
    const boxes = this.boxes;
    let count = 0;
    for (let y = 0; y < N; y++) {
      for (let z = 0; z < N; z++) {
        let i = padIndex(0, y, z);
        for (let x = 0; x < N; x++, i++) {
          if (out[i] !== 0 || OPAQUE[vol[i]] === 1) continue;
          let x0 = x;
          let x1 = x;
          let y0 = y;
          let y1 = y;
          let z0 = z;
          let z1 = z;
          out[i] = 2;
          q[0] = i;
          let tail = 1;
          for (let head = 0; head < tail; head++) {
            const c = q[head];
            const cx = (c % PAD) - 1;
            const rest = (c - cx - 1) / PAD;
            const cz = (rest % PAD) - 1;
            const cy = (rest - cz - 1) / PAD - 1;
            open[2 * (cz + 1 + (cy + 1) * PAD) + (cx >> 5)] &= ~(1 << (cx & 31));
            if (cx < x0) x0 = cx;
            if (cx > x1) x1 = cx;
            if (cy < y0) y0 = cy;
            if (cy > y1) y1 = cy;
            if (cz < z0) z0 = cz;
            if (cz > z1) z1 = cz;
            // A sealed pocket never touches the padding, so all neighbours are interior cells.
            for (let k = 0; k < 6; k++) {
              const j = c + NEIGHBOUR_STEP[k];
              if (out[j] === 0 && OPAQUE[vol[j]] === 0) {
                out[j] = 2;
                q[tail++] = j;
              }
            }
          }
          const o = Math.min(count, MAX_CAVITY_BOXES - 1) * 6;
          if (count < MAX_CAVITY_BOXES) {
            boxes[o] = x0;
            boxes[o + 1] = y0;
            boxes[o + 2] = z0;
            boxes[o + 3] = x1 + 1;
            boxes[o + 4] = y1 + 1;
            boxes[o + 5] = z1 + 1;
            count++;
          } else {
            // Out of boxes: grow the last one (a conservative union is enough for the camera test).
            boxes[o] = Math.min(boxes[o], x0);
            boxes[o + 1] = Math.min(boxes[o + 1], y0);
            boxes[o + 2] = Math.min(boxes[o + 2], z0);
            boxes[o + 3] = Math.max(boxes[o + 3], x1 + 1);
            boxes[o + 4] = Math.max(boxes[o + 4], y1 + 1);
            boxes[o + 5] = Math.max(boxes[o + 5], z1 + 1);
          }
        }
      }
    }
    return boxes.slice(0, count * 6);
  }

  /**
   * skirtNear[u + v·N] = 1 when the border cell (u, v) of the direction's border plane has a non-opaque
   * cell within 2 cells (in-plane), 2 cells inwards or in the padding. Separable ±2 dilation with
   * running window counts.
   */
  private buildSkirtMask(vol: Uint8Array, F: FaceDir): void {
    const a = this.skirtA;
    const b = this.skirtB;
    const inward = F.pos === 1 ? -F.ds : F.ds;
    const base = START + (F.pos === 1 ? N - 1 : 0) * F.ds;
    for (let vv = -1; vv <= N; vv++) {
      for (let uu = -1; uu <= N; uu++) {
        const i = base + uu * F.du + vv * F.dv;
        a[uu + 1 + (vv + 1) * PAD] =
          (OPAQUE[vol[i - inward]] & OPAQUE[vol[i]] & OPAQUE[vol[i + inward]] & OPAQUE[vol[i + 2 * inward]]) ^ 1;
      }
    }
    // Along u: b[c] = any of a[c−2 .. c+2].
    for (let r = 0; r < PAD; r++) {
      const row = r * PAD;
      let sum = a[row] + a[row + 1] + a[row + 2];
      for (let c = 0; c < PAD; c++) {
        b[row + c] = sum > 0 ? 1 : 0;
        if (c + 3 < PAD) sum += a[row + c + 3];
        if (c - 2 >= 0) sum -= a[row + c - 2];
      }
    }
    // Along v, for the interior cells only: near[u, v] = any of b[u + 1, v − 1 .. v + 3].
    const near = this.skirtNear;
    for (let u = 0; u < N; u++) {
      const col = u + 1;
      let sum = b[col] + b[col + PAD] + b[col + 2 * PAD] + b[col + 3 * PAD];
      for (let v = 0; v < N; v++) {
        near[u + v * N] = sum > 0 ? 1 : 0;
        if (v + 4 < PAD) sum += b[col + (v + 4) * PAD];
        if (v - 1 >= 0) sum -= b[col + (v - 1) * PAD];
      }
    }
  }

  /** Two crossed quads for the plant at padded index i (level 0 only). */
  private plant(vol: Uint8Array, i: number): void {
    if (this.outside[i] !== 1) return;
    const id = vol[i];
    const x = (i % PAD) - 1;
    const rest = (i - x - 1) / PAD;
    const z = (rest % PAD) - 1;
    const y = (rest - z - 1) / PAD - 1;
    const wy = this.oy + y;
    const h = hash3(this.ox + x, wy, this.oz + z, PLANT_SEED);
    const height = Math.min(PLANT_MAX_HEIGHT, PLANT_HEIGHT[id] * (0.7 + (0.5 * (h & 0xff)) / 255));
    const h4 = Math.max(1, Math.round(height * 4));
    const cx = x + 0.5 + (((h >>> 8) & 0xff) / 255 - 0.5) * 0.5;
    const cz = z + 0.5 + (((h >>> 16) & 0xff) / 255 - 0.5) * 0.5;
    const angle = ((h >>> 24) / 255) * Math.PI;
    const ex = Math.cos(angle) * PLANT_HALF_WIDTH;
    const ez = Math.sin(angle) * PLANT_HALF_WIDTH;
    const c = x + 1 + SKY_REACH + (z + 1 + SKY_REACH) * COLS;
    const sky = Math.round(columnLight(wy, this.colSky[c], this.colCanopy[c]) * 15);
    const shade = hash32(h) & 0xff;
    const tile = PLANT_TILE[id];
    this.plantQuad(cx - ex, cz - ez, cx + ex, cz + ez, y, h4, tile, sky, shade);
    this.plantQuad(cx + ez, cz - ex, cx - ez, cz + ex, y, h4, tile, sky, shade);
  }

  private plantQuad(xa: number, za: number, xb: number, zb: number, y: number, h4: number, tile: number, sky: number, shade: number): void {
    const out = this.plantOut;
    const v = out.next();
    const pos = out.pos;
    const data = out.data;
    const y0 = y * PLANT_POS_SCALE;
    const y1 = y0 + h4 * (PLANT_POS_SCALE / 4);
    const pxa = Math.round(xa * PLANT_POS_SCALE);
    const pza = Math.round(za * PLANT_POS_SCALE);
    const pxb = Math.round(xb * PLANT_POS_SCALE);
    const pzb = Math.round(zb * PLANT_POS_SCALE);
    const height = h4 << 2;
    // Corners: (a, bottom) → (b, bottom) → (b, top) → (a, top); corner bits: 1 = side b, 2 = top.
    putPlantVertex(pos, data, v, pxa, y0, pza, tile, height, sky, shade);
    putPlantVertex(pos, data, v + 1, pxb, y0, pzb, tile, height | 1, sky, shade);
    putPlantVertex(pos, data, v + 2, pxb, y1, pzb, tile, height | 3, sky, shade);
    putPlantVertex(pos, data, v + 3, pxa, y1, pza, tile, height | 2, sky, shade);
  }
}

function putVertex(b: Uint8Array, o: number, F: FaceDir, pn: number, u: number, v: number, normal: number, ao: number, sky: number, id: number): void {
  b[o] = pn * F.xn + u * F.xu + v * F.xv;
  b[o + 1] = pn * F.yn + u * F.yu + v * F.yv;
  b[o + 2] = pn * F.zn + u * F.zu + v * F.zv;
  b[o + 3] = 0;
  b[o + 4] = normal;
  b[o + 5] = ao;
  b[o + 6] = sky;
  b[o + 7] = id;
}

function putPlantVertex(
  pos: Int16Array,
  data: Uint8Array,
  v: number,
  x: number,
  y: number,
  z: number,
  tile: number,
  corner: number,
  sky: number,
  shade: number,
): void {
  const p = v * 4;
  pos[p] = x;
  pos[p + 1] = y;
  pos[p + 2] = z;
  pos[p + 3] = 0;
  data[p] = tile;
  data[p + 1] = corner;
  data[p + 2] = sky;
  data[p + 3] = shade;
}
