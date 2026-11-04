/**
 * Voxel furniture and room furnishing. Pieces are authored in piece coordinates — a along the wall
 * they back onto, b from that wall (b = 0) towards the room, y from the floor — and rotated into the
 * building's local frame. Placement uses each room's occupancy grid: furniture never covers door
 * swings, stair flights or the space in front of containers, tall pieces stay clear of windows, and
 * every piece must leave a player-sized body a way between all doors, stairs and containers.
 */
import { B } from '../../world/blocks';
import type { ContainerStyle } from '../types';
import {
  BODY,
  type BuildingBuilder,
  CELL_CLEAR,
  CELL_LOW,
  CELL_SOLID,
  CONTAINER_SIZE,
  type ContainerRole,
  type LocalRect,
  type Room,
  type SurfaceKind,
} from './building';
import type { BoxList, LocalDir } from './frame';

/** A placed piece: its local rect, the direction its front faces and the floor it stands on. */
class Piece {
  constructor(
    readonly u0: number,
    readonly v0: number,
    readonly u1: number,
    readonly v1: number,
    readonly front: LocalDir,
    readonly fy: number,
    private readonly list: BoxList,
  ) {}

  /** Local u of piece point (a, b). */
  mu(a: number, b: number): number {
    switch (this.front) {
      case 0:
        return this.u0 + a;
      case 1:
        return this.u0 + b;
      case 2:
        return this.u1 - a;
      default:
        return this.u1 - b;
    }
  }

  /** Local v of piece point (a, b). */
  mv(a: number, b: number): number {
    switch (this.front) {
      case 0:
        return this.v0 + b;
      case 1:
        return this.v1 - a;
      case 2:
        return this.v1 - b;
      default:
        return this.v0 + a;
    }
  }

  box(a0: number, b0: number, y0: number, a1: number, b1: number, y1: number, id: number): void {
    const ua = this.mu(a0, b0);
    const ub = this.mu(a1, b1);
    const va = this.mv(a0, b0);
    const vb = this.mv(a1, b1);
    this.list.add(Math.min(ua, ub), this.fy + y0, Math.min(va, vb), Math.max(ua, ub), this.fy + y1, Math.max(va, vb), id);
  }
}

interface Template {
  /** Width along the wall, depth from the wall, height. */
  w: number;
  d: number;
  h: number;
  /** Free cells required in front of the piece. */
  clear: number;
  build(p: Piece, mat: number): SurfaceSpec[];
}

/** Surface for loose items in piece coordinates. */
interface SurfaceSpec {
  a: number;
  b: number;
  y: number;
  kind: SurfaceKind;
}

/** Contextually types a template literal. */
const tpl = (t: Template): Template => t;

const legs = (p: Piece, w: number, d: number, h: number, id: number) => {
  p.box(0, 0, 0, 1, 1, h, id);
  p.box(w - 1, 0, 0, w, 1, h, id);
  p.box(0, d - 1, 0, 1, d, h, id);
  p.box(w - 1, d - 1, 0, w, d, h, id);
};

const T = {
  table: (w: number, d: number): Template => ({
    w,
    d,
    h: 8,
    clear: 0,
    build(p, mat) {
      legs(p, w, d, 7, mat);
      p.box(0, 0, 7, w, d, 8, mat);
      return [{ a: w / 2, b: d / 2, y: 8, kind: 'table' }];
    },
  }),
  bed: tpl({
    w: 10,
    d: 20,
    h: 9,
    clear: 4,
    build(p, mat) {
      p.box(0, 0, 0, 10, 20, 3, mat);
      p.box(0, 1, 3, 10, 20, 5, B.FABRIC);
      p.box(0, 0, 3, 10, 1, 9, mat);
      p.box(2, 1, 5, 8, 4, 6, B.FABRIC);
      return [{ a: 5, b: 12, y: 5, kind: 'bed' }];
    },
  }),
  sofa: tpl({
    w: 18,
    d: 8,
    h: 9,
    clear: 6,
    build(p) {
      legs(p, 18, 8, 1, B.DARK_WOOD);
      p.box(0, 0, 1, 18, 8, 4, B.FABRIC);
      p.box(0, 0, 4, 18, 2, 9, B.FABRIC);
      p.box(0, 2, 4, 2, 8, 6, B.FABRIC);
      p.box(16, 2, 4, 18, 8, 6, B.FABRIC);
      return [];
    },
  }),
  bookshelf: tpl({
    w: 12,
    d: 3,
    h: 18,
    clear: 4,
    build(p, mat) {
      p.box(0, 0, 0, 1, 3, 18, mat);
      p.box(11, 0, 0, 12, 3, 18, mat);
      p.box(1, 0, 0, 11, 1, 18, mat);
      for (const y of [0, 5, 10, 15]) p.box(1, 1, y, 11, 3, y + 1, mat);
      p.box(0, 0, 17, 12, 3, 18, mat);
      return [
        { a: 6, b: 2, y: 6, kind: 'shelf' },
        { a: 6, b: 2, y: 11, kind: 'shelf' },
      ];
    },
  }),
  shopShelf: tpl({
    w: 20,
    d: 4,
    h: 18,
    clear: 6,
    build(p) {
      for (const [a, b] of [
        [0, 0],
        [19, 0],
        [0, 3],
        [19, 3],
      ])
        p.box(a, b, 0, a + 1, b + 1, 18, B.METAL);
      for (const y of [1, 6, 11, 16]) p.box(0, 0, y, 20, 4, y + 1, B.PLANKS);
      return [
        { a: 5, b: 2, y: 7, kind: 'shelf' },
        { a: 14, b: 2, y: 7, kind: 'shelf' },
        { a: 5, b: 2, y: 12, kind: 'shelf' },
        { a: 14, b: 2, y: 12, kind: 'shelf' },
        { a: 10, b: 2, y: 2, kind: 'shelf' },
      ];
    },
  }),
  russianStove: tpl({
    w: 14,
    d: 16,
    h: 18,
    clear: 6,
    build(p) {
      p.box(0, 0, 0, 14, 16, 15, B.TILES);
      p.box(0, 0, 15, 14, 8, 18, B.TILES);
      p.box(5, 15, 3, 9, 16, 7, B.AIR);
      p.box(5, 14, 3, 9, 15, 7, B.BRICK);
      p.box(2, 10, 15, 12, 15, 16, B.METAL);
      return [];
    },
  }),
  metalStove: tpl({
    w: 6,
    d: 6,
    h: 9,
    clear: 6,
    build(p) {
      p.box(0, 0, 0, 6, 6, 8, B.METAL);
      p.box(1, 1, 8, 5, 5, 9, B.METAL);
      return [];
    },
  }),
  sink: tpl({
    w: 5,
    d: 5,
    h: 9,
    clear: 5,
    build(p) {
      p.box(0, 0, 0, 5, 5, 8, B.PAINTED_WOOD);
      p.box(0, 0, 8, 5, 5, 9, B.METAL);
      p.box(1, 1, 8, 4, 4, 9, B.AIR);
      return [];
    },
  }),
  bathtub: tpl({
    w: 16,
    d: 7,
    h: 5,
    clear: 4,
    build(p) {
      p.box(0, 0, 0, 16, 7, 5, B.TILES);
      p.box(1, 1, 1, 15, 6, 5, B.AIR);
      return [];
    },
  }),
  desk: tpl({
    w: 12,
    d: 7,
    h: 8,
    clear: 6,
    build(p, mat) {
      legs(p, 12, 7, 7, mat);
      p.box(8, 0, 2, 12, 7, 7, mat);
      p.box(0, 0, 7, 12, 7, 8, mat);
      return [{ a: 4, b: 3.5, y: 8, kind: 'table' }];
    },
  }),
  pigeonholes: tpl({
    w: 21,
    d: 3,
    h: 21,
    clear: 5,
    build(p) {
      p.box(0, 0, 0, 21, 3, 21, B.PLANKS);
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) p.box(1 + 4 * i, 1, 1 + 4 * j, 4 + 4 * i, 3, 4 + 4 * j, B.AIR);
      return [];
    },
  }),
  workbench: tpl({
    w: 16,
    d: 6,
    h: 11,
    clear: 6,
    build(p) {
      legs(p, 16, 6, 8, B.DARK_WOOD);
      p.box(0, 0, 2, 16, 6, 3, B.PLANKS);
      p.box(0, 0, 8, 16, 6, 9, B.PLANKS);
      p.box(12, 3, 9, 15, 5, 11, B.METAL);
      return [{ a: 6, b: 3, y: 9, kind: 'workbench' }];
    },
  }),
  tyres: tpl({
    w: 6,
    d: 6,
    h: 6,
    clear: 0,
    build(p) {
      for (let k = 0; k < 3; k++) {
        p.box(0, 1, 2 * k, 6, 5, 2 * k + 2, B.RUBBER);
        p.box(1, 0, 2 * k, 5, 6, 2 * k + 2, B.RUBBER);
        p.box(2, 2, 2 * k, 4, 4, 2 * k + 2, B.AIR);
      }
      return [];
    },
  }),
  barrel: tpl({
    w: 5,
    d: 5,
    h: 9,
    clear: 0,
    build(p) {
      p.box(0, 1, 0, 5, 4, 9, B.METAL);
      p.box(1, 0, 0, 4, 5, 9, B.METAL);
      return [];
    },
  }),
  radiator: tpl({
    w: 8,
    d: 2,
    h: 6,
    clear: 0,
    build(p) {
      // Cast-iron sections on two short feet, a hand's width off the wall.
      p.box(0, 1, 0, 1, 2, 1, B.PAINTED_METAL);
      p.box(7, 1, 0, 8, 2, 1, B.PAINTED_METAL);
      p.box(0, 1, 1, 8, 2, 6, B.PAINTED_METAL);
      return [];
    },
  }),
  bench: tpl({
    w: 16,
    d: 4,
    h: 5,
    clear: 4,
    build(p, mat) {
      p.box(1, 0, 0, 2, 4, 4, mat);
      p.box(14, 0, 0, 15, 4, 4, mat);
      p.box(0, 0, 4, 16, 4, 5, mat);
      return [{ a: 8, b: 2, y: 5, kind: 'table' }];
    },
  }),
  counter: (w: number): Template => ({
    w,
    d: 5,
    h: 10,
    clear: 6,
    build(p) {
      p.box(0, 0, 0, w, 4, 9, B.DARK_WOOD);
      p.box(0, 0, 9, w, 5, 10, B.PLANKS);
      // On the customers' half of the top, clear of the post office's glazed screen (b ∈ [1, 2)).
      return [
        { a: w * 0.3, b: 3, y: 10, kind: 'counter' },
        { a: w * 0.7, b: 3, y: 10, kind: 'counter' },
      ];
    },
  }),
};

type SideKey = 0 | 1 | 2 | 3;
const ALL_SIDES: readonly SideKey[] = [0, 1, 2, 3];

interface Spot {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  front: LocalDir;
}

/** Copy of a room's occupancy grid while a tentative claim is checked. */
const scratch = { cells: new Uint8Array(0) };
/** A piece gives up after this many free spots that would cut the room's walkways. */
const MAX_REFUSALS = 24;

/** Furnishing context for one room. */
class Furnisher {
  /** Claims must keep the room walkable — unless its bare layout is not walkable to begin with. */
  private guard: boolean;

  constructor(
    readonly b: BuildingBuilder,
    readonly r: Room,
  ) {
    this.guard = b.walkable(r);
  }

  /** Candidate rect of a w×d piece backed against side k (0: v0, 1: u1, 2: v1, 3: u0) at offset `pos` along it. */
  private spot(k: SideKey, pos: number, w: number, d: number): Spot {
    const r = this.r;
    switch (k) {
      case 0:
        return { u0: r.u0 + pos, v0: r.v0, u1: r.u0 + pos + w, v1: r.v0 + d, front: 0 };
      case 2:
        return { u0: r.u0 + pos, v0: r.v1 - d, u1: r.u0 + pos + w, v1: r.v1, front: 2 };
      case 3:
        return { u0: r.u0, v0: r.v0 + pos, u1: r.u0 + d, v1: r.v0 + pos + w, front: 1 };
      default:
        return { u0: r.u1 - d, v0: r.v0 + pos, u1: r.u1, v1: r.v0 + pos + w, front: 3 };
    }
  }

  /** Clearance rect in front of a spot (clipped to the room). */
  private frontRect(s: Spot, depth: number): [number, number, number, number] {
    const r = this.r;
    switch (s.front) {
      case 0:
        return [s.u0, s.v1, s.u1, Math.min(r.v1, s.v1 + depth)];
      case 2:
        return [s.u0, Math.max(r.v0, s.v0 - depth), s.u1, s.v0];
      case 1:
        return [s.u1, s.v0, Math.min(r.u1, s.u1 + depth), s.v1];
      default:
        return [Math.max(r.u0, s.u0 - depth), s.v0, s.u0, s.v1];
    }
  }

  /** Body positions (min corners) facing the middle of a spot's front, from touching it to 0.3 m back. */
  private frontAccess(s: Spot): LocalRect {
    const mu = (s.u0 + s.u1) >> 1;
    const mv = (s.v0 + s.v1) >> 1;
    switch (s.front) {
      case 0:
        return { u0: mu - BODY + 1, v0: s.v1, u1: mu + 1, v1: s.v1 + 4 };
      case 2:
        return { u0: mu - BODY + 1, v0: s.v0 - BODY - 3, u1: mu + 1, v1: s.v0 - BODY + 1 };
      case 1:
        return { u0: s.u1, v0: mv - BODY + 1, u1: s.u1 + 4, v1: mv + 1 };
      default:
        return { u0: s.u0 - BODY - 3, v0: mv - BODY + 1, u1: s.u0 - BODY + 1, v1: mv + 1 };
    }
  }

  /**
   * Finds a wall spot for a w×d piece and hands it to `take`, which claims it or refuses it; returns
   * the claimed spot. `sides` restricts the walls tried.
   */
  private findWallSpot(w: number, d: number, tall: boolean, clear: number, sides: readonly SideKey[], take: (s: Spot) => boolean): Spot | null {
    const r = this.r;
    const b = this.b;
    const cands: Spot[] = [];
    for (const k of sides) {
      const len = k === 0 || k === 2 ? r.u1 - r.u0 : r.v1 - r.v0;
      for (let pos = 0; pos + w <= len; pos += 2) cands.push(this.spot(k, pos, w, d));
    }
    b.rng.shuffle(cands);
    const blocked = CELL_SOLID | CELL_CLEAR | (tall ? CELL_LOW : 0);
    let refusals = 0;
    for (const s of cands) {
      if (!b.free(r, s.u0, s.v0, s.u1, s.v1, blocked)) continue;
      if (clear > 0) {
        // At least min(clear, 3) free cells in front (rooms may be shallower than the full clearance).
        const [cu0, cv0, cu1, cv1] = this.frontRect(s, clear);
        const depth = s.front === 0 || s.front === 2 ? cv1 - cv0 : cu1 - cu0;
        if (depth < Math.min(clear, 3) || !b.free(r, cu0, cv0, cu1, cv1, CELL_SOLID)) continue;
      }
      if (take(s)) return s;
      if (++refusals >= MAX_REFUSALS) break;
    }
    return null;
  }

  /**
   * Reserves a spot (footprint solid, clearance kept free, `access` added to the points a body must
   * reach) if a player-sized body can still walk between all access points of the room; otherwise
   * leaves the room as it was and returns false.
   */
  private claim(s: Spot, clear: number, access: LocalRect | null = null): boolean {
    const r = this.r;
    const n = r.cells.length;
    if (this.guard) {
      if (scratch.cells.length < n) scratch.cells = new Uint8Array(n);
      scratch.cells.set(r.cells);
    }
    this.b.mark(r, s.u0, s.v0, s.u1, s.v1, CELL_SOLID);
    if (clear > 0) {
      const [cu0, cv0, cu1, cv1] = this.frontRect(s, clear);
      this.b.mark(r, cu0, cv0, cu1, cv1, CELL_CLEAR);
    }
    if (access) r.access.push(access);
    if (!this.guard || this.b.walkable(r)) return true;
    r.cells.set(scratch.cells.subarray(0, n));
    if (access) r.access.pop();
    return false;
  }

  /** Builds a template on a spot and records its surfaces. */
  build(t: Template, s: Spot, mat: number): Piece {
    const p = new Piece(s.u0, s.v0, s.u1, s.v1, s.front, this.r.fy, this.b.furniture);
    for (const sf of t.build(p, mat)) this.b.surfaces.push(this.b.surface(p.mu(sf.a, sf.b), p.mv(sf.a, sf.b), this.r.fy + sf.y, sf.kind));
    return p;
  }

  /** Places a template against a wall; returns the piece or null. */
  wall(t: Template, mat: number, sides: readonly SideKey[] = ALL_SIDES, clear = t.clear): Piece | null {
    const s = this.findWallSpot(t.w, t.d, t.h > 9, clear, sides, (c) => this.claim(c, clear));
    return s ? this.build(t, s, mat) : null;
  }

  /**
   * Places a container against a wall, front into the room. A `force`d (required) container falls
   * back to shallower spots and, if no spot keeps the room walkable, to any free spot at all.
   */
  container(style: ContainerStyle, role: ContainerRole, force = false): boolean {
    const [mw, mh, md] = CONTAINER_SIZE[style];
    const w = Math.ceil(mw) + 2;
    const d = Math.ceil(md) + 1;
    const take = (c: Spot) => this.claim(c, 7, this.frontAccess(c));
    let s = this.findWallSpot(w, d, mh > 9, 7, ALL_SIDES, take);
    if (!s && force) s = this.findWallSpot(w, d, false, 3, ALL_SIDES, take) ?? this.findWallSpot(w, d, false, 0, ALL_SIDES, take);
    if (!s && force) {
      this.guard = false;
      s = this.findWallSpot(w, d, false, 0, ALL_SIDES, take);
    }
    if (!s) return false;
    this.b.container(style, role, s.u0, s.v0, s.u1, s.v1, s.front, this.r.fy);
    return true;
  }

  /** A table in the room centre (or against a wall in small rooms) with chairs facing it. */
  tableSet(t: Template, mat: number, chairs: number): void {
    const r = this.r;
    const b = this.b;
    const W = r.u1 - r.u0;
    const D = r.v1 - r.v0;
    let s: Spot | null = null;
    if (W >= t.w + 14 && D >= t.d + 14) {
      const cu = r.u0 + ((W - t.w) >> 1) + b.rng.int(-2, 3);
      const cv = r.v0 + ((D - t.d) >> 1) + b.rng.int(-2, 3);
      const c: Spot = { u0: cu, v0: cv, u1: cu + t.w, v1: cv + t.d, front: 0 };
      const roomy = b.free(r, c.u0 - 5, c.v0 - 5, c.u1 + 5, c.v1 + 5, CELL_SOLID) && b.free(r, c.u0, c.v0, c.u1, c.v1, CELL_SOLID | CELL_CLEAR);
      if (roomy && this.claim(c, 0)) s = c;
    }
    if (!s) s = this.findWallSpot(t.w, t.d, false, 5, ALL_SIDES, (c) => this.claim(c, 0));
    if (!s) return;
    this.build(t, s, mat);
    // Chairs on the long sides that face into the room, pushed under the table edge.
    const spots: Spot[] = [];
    const midU = Math.round((s.u0 + s.u1) / 2) - 2;
    const midV = Math.round((s.v0 + s.v1) / 2) - 2;
    if (s.u1 - s.u0 >= s.v1 - s.v0) {
      spots.push({ u0: midU, v0: s.v0 - 3, u1: midU + 4, v1: s.v0 + 1, front: 0 });
      spots.push({ u0: midU, v0: s.v1 - 1, u1: midU + 4, v1: s.v1 + 3, front: 2 });
    } else {
      spots.push({ u0: s.u0 - 3, v0: midV, u1: s.u0 + 1, v1: midV + 4, front: 1 });
      spots.push({ u0: s.u1 - 1, v0: midV, u1: s.u1 + 3, v1: midV + 4, front: 3 });
    }
    let placed = 0;
    for (const c of spots) {
      if (placed >= chairs) break;
      // The chair overlaps the table edge by one voxel (tucked in); check only the part outside it.
      const out: [number, number, number, number] =
        c.front === 0 ? [c.u0, c.v0, c.u1, c.v1 - 1] : c.front === 2 ? [c.u0, c.v0 + 1, c.u1, c.v1] : c.front === 1 ? [c.u0, c.v0, c.u1 - 1, c.v1] : [c.u0 + 1, c.v0, c.u1, c.v1];
      if (!b.free(r, out[0], out[1], out[2], out[3], CELL_SOLID | CELL_CLEAR)) continue;
      // Chairs face the table: their backrest is away from it.
      const chairSpot: Spot = { u0: out[0], v0: out[1], u1: out[2], v1: out[3], front: c.front };
      if (!this.claim(chairSpot, 0)) continue;
      this.buildChair(chairSpot, mat);
      placed++;
    }
  }

  /** Chair on the 4×3 spot beside a table edge, backrest on the far side (b = 0). */
  private buildChair(s: Spot, mat: number): void {
    const p = new Piece(s.u0, s.v0, s.u1, s.v1, s.front, this.r.fy, this.b.furniture);
    const w = s.front === 0 || s.front === 2 ? s.u1 - s.u0 : s.v1 - s.v0;
    const d = s.front === 0 || s.front === 2 ? s.v1 - s.v0 : s.u1 - s.u0;
    p.box(0, 0, 0, 1, 1, 4, mat);
    p.box(w - 1, 0, 0, w, 1, 4, mat);
    p.box(0, d - 1, 0, 1, d, 4, mat);
    p.box(w - 1, d - 1, 0, w, d, 4, mat);
    p.box(0, 0, 4, w, d, 5, mat);
    p.box(0, 0, 5, w, 1, 10, mat);
  }

  /** Radiators under the windows of the room (brick and office buildings). */
  radiators(): void {
    const r = this.r;
    const b = this.b;
    const W = r.u1 - r.u0;
    for (const k of ALL_SIDES) {
      const len = k === 0 || k === 2 ? W : r.v1 - r.v0;
      for (let pos = 2; pos + 8 <= len - 2; pos++) {
        const s = this.spot(k, pos, 8, 2);
        // Only directly under a window (LOW cells) and on free floor.
        if (!b.free(r, s.u0, s.v0, s.u1, s.v1, CELL_SOLID | CELL_CLEAR)) continue;
        if (!lowEverywhere(r, s) || !this.claim(s, 0)) continue;
        this.build(T.radiator, s, B.PAINTED_METAL);
        pos += 14;
      }
    }
  }

  /** Rug on the floor finish in the open middle of the room. */
  rug(): void {
    const r = this.r;
    const W = r.u1 - r.u0;
    const D = r.v1 - r.v0;
    if (W < 24 || D < 24) return;
    const rw = Math.min(30, W - 12);
    const rd = Math.min(20, D - 12);
    const u0 = r.u0 + ((W - rw) >> 1);
    const v0 = r.v0 + ((D - rd) >> 1);
    this.b.furniture.add(u0, r.fy - 1, v0, u0 + rw, r.fy, v0 + rd, B.FABRIC);
  }

  /** «Ковёр на стене»: a FABRIC panel in the wall finish where the wall has no openings. */
  wallCarpet(): void {
    const r = this.r;
    const b = this.b;
    const cw = 16;
    for (const k of b.rng.shuffle([0, 1, 2, 3] as SideKey[])) {
      const len = k === 0 || k === 2 ? r.u1 - r.u0 : r.v1 - r.v0;
      if (len < cw + 8) continue;
      const pos = (len - cw) >> 1;
      const s = this.spot(k, pos - 2, cw + 4, 1);
      // The wall strip must be free of windows (LOW) and doors (CLEAR).
      if (!b.free(r, s.u0, s.v0, s.u1, s.v1, CELL_LOW | CELL_CLEAR)) continue;
      const y0 = r.fy + 7;
      const y1 = r.fy + 19;
      const c = this.spot(k, pos, cw, 1);
      // Shift the strip one voxel into the wall (the finish layer).
      const [du, dv] = k === 0 ? [0, -1] : k === 2 ? [0, 1] : k === 3 ? [-1, 0] : [1, 0];
      b.furniture.add(c.u0 + du, y0, c.v0 + dv, c.u1 + du, y1, c.v1 + dv, B.FABRIC);
      return;
    }
  }
}

/** True when every cell of the spot lies in front of a window. */
function lowEverywhere(r: Room, s: Spot): boolean {
  const w = r.u1 - r.u0;
  for (let v = s.v0; v < s.v1; v++) for (let u = s.u0; u < s.u1; u++) if (!(r.cells[u - r.u0 + (v - r.v0) * w] & CELL_LOW)) return false;
  return true;
}

/** Furniture materials of a building. */
export interface FurnishStyle {
  wood: number;
  radiators: boolean;
  russianStove: boolean;
}

/**
 * Furnishes a room by type. Returns the local rect of a Russian stove's chimney base (4×4) when the
 * room got one, so the caller can run the chimney through the roof.
 */
export function furnishRoom(b: BuildingBuilder, r: Room, style: FurnishStyle): { u: number; v: number; y: number } | null {
  const f = new Furnisher(b, r);
  const wood = style.wood;
  let chimney: { u: number; v: number; y: number } | null = null;
  switch (r.type) {
    case 'living':
      f.wall(T.sofa, wood);
      f.container('cabinet', 'wardrobe');
      f.wall(T.bookshelf, wood);
      if (style.radiators) f.radiators();
      f.tableSet(T.table(12, 8), wood, 2);
      f.rug();
      f.wallCarpet();
      break;
    case 'bedroom':
      f.wall(T.bed, wood);
      if (b.rng.chance(0.4)) f.wall(T.bed, wood);
      f.container('cabinet', 'wardrobe');
      if (style.radiators) f.radiators();
      f.wall(T.table(8, 6), wood);
      f.rug();
      break;
    case 'kitchen': {
      if (style.russianStove) {
        const s = f.wall(T.russianStove, B.TILES);
        if (s) chimney = { u: Math.floor(Math.min(s.mu(5, 2), s.mu(9, 6))), v: Math.floor(Math.min(s.mv(5, 2), s.mv(9, 6))), y: r.fy + 18 };
      } else {
        f.wall(T.metalStove, B.METAL);
        f.wall(T.sink, B.PAINTED_WOOD);
      }
      f.container('cabinet', 'kitchen_cabinet');
      if (style.radiators) f.radiators();
      f.tableSet(T.table(10, 7), wood, 2);
      f.wall(T.bookshelf, wood);
      break;
    }
    case 'bath':
      f.wall(T.bathtub, B.TILES);
      f.wall(T.sink, B.PAINTED_WOOD);
      break;
    case 'hall':
      if (r.storey === 0 && b.storeys === 1) {
        f.container('cabinet', 'hall_cabinet');
        f.wall(T.bench, wood);
      }
      break;
    case 'sales':
      f.container('fridge', 'shop_fridge', true);
      f.container('fridge', 'shop_fridge');
      for (let i = 0; i < 6; i++) f.wall(T.shopShelf, B.PLANKS, [1, 3]);
      // Behind the counter: shelves on the back wall with a narrow aisle for the shop assistant.
      for (let i = 0; i < 3; i++) f.wall(T.shopShelf, B.PLANKS, [2], 3);
      break;
    case 'storage':
      f.container('crate', 'storage_crate', true);
      f.container('crate', 'storage_crate');
      f.wall(T.shopShelf, B.PLANKS);
      f.wall(T.barrel, B.METAL);
      break;
    case 'post':
      f.wall(T.bench, wood);
      f.wall(T.bench, wood);
      if (style.radiators) f.radiators();
      break;
    case 'sorting':
      f.container('crate', 'post_crate', true);
      f.wall(T.pigeonholes, B.PLANKS);
      f.wall(T.pigeonholes, B.PLANKS);
      f.tableSet(T.table(12, 8), wood, 1);
      if (style.radiators) f.radiators();
      break;
    case 'office':
      f.wall(T.desk, wood);
      f.container('cabinet', 'office_cabinet');
      f.wall(T.bookshelf, wood);
      if (style.radiators) f.radiators();
      f.tableSet(T.table(12, 8), wood, 2);
      break;
    case 'garage':
      f.container('cabinet', 'garage_cabinet', true);
      f.wall(T.workbench, B.PLANKS);
      f.wall(T.tyres, B.RUBBER);
      f.wall(T.barrel, B.METAL);
      f.wall(T.bookshelf, B.METAL);
      break;
    case 'shed':
      f.container('crate', 'shed_crate', true);
      f.wall(T.workbench, B.PLANKS);
      f.wall(T.barrel, B.METAL);
      break;
  }
  return chimney;
}

/**
 * Counter across a room at `vc` (front at the customers' side −v), from u0 to u1, with surfaces.
 * Used by the shop and the post office; `glass` adds a glazed screen on top.
 */
export function counterAcross(b: BuildingBuilder, r: Room, u0: number, u1: number, vc: number, glass: boolean): void {
  const p = new Piece(u0, vc, u1, vc + 5, 2, r.fy, b.furniture);
  const w = u1 - u0;
  for (const sf of T.counter(w).build(p, B.DARK_WOOD)) b.surfaces.push(b.surface(p.mu(sf.a, sf.b), p.mv(sf.a, sf.b), r.fy + sf.y, sf.kind));
  if (glass) {
    // Glazed screen with a gap above the counter top for passing letters across.
    for (let a = 0; a < w; a += 6) p.box(a, 1, 10, a + 1, 2, 22, B.PAINTED_WOOD);
    p.box(0, 1, 22, w, 2, 23, B.PAINTED_WOOD);
    for (let a = 0; a + 6 <= w; a += 6) if (b.rng.chance(0.55)) p.box(a + 1, 1, 13, a + 6, 2, 22, B.GLASS);
  }
  b.mark(r, u0, vc - 1, u1, vc + 6, CELL_SOLID);
  b.mark(r, u0, vc - 7, u1, vc - 1, CELL_CLEAR);
}

