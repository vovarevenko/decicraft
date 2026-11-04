/**
 * Parametric building planner. A building is planned once (deterministically from its seed) into a
 * `BuildingPlan`: shell parameters for the procedural stamper, ordered local box lists (partitions,
 * finishes, openings, frames, stairs, furniture, porch, signs, chimney), entity spawns (doors,
 * containers, surfaces for loose items) and conservative bounds. `stampBuilding` replays the plan.
 *
 * Vertical conventions (y): the ground storey's floor finish voxel is `yF = GROUND_TOP + hf`; storey s
 * stands at `fy(s) = yF + 1 + s·storeyH`; a storey has `clear` voxels of headroom and 2-voxel slabs.
 * Walls rise from yF to `yTop` (the top slab's upper voxel) inclusive.
 */
import { PLAYER } from '../../config';
import { Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import type { ContainerSpawn, ContainerStyle, DoorSpawn, DoorStyle } from '../types';
import { DOOR_H, DOOR_W, GROUND_TOP } from './common';
import { BoxList, type Frame, LocalBounds, type LocalDir, type Rect, opposite } from './frame';
import { GLYPH_H, forEachTextCell, textWidth } from './glyphs';
import type { BuildingType, LotPlan } from './layout';
import type { RoofPlan } from './roof';

export type Side = 'front' | 'back' | 'left' | 'right';
/** Outward local direction of each exterior wall. */
export const SIDE_OUT: Record<Side, LocalDir> = { front: 2, back: 0, left: 3, right: 1 };

export type RoomType =
  | 'hall'
  | 'kitchen'
  | 'living'
  | 'bedroom'
  | 'bath'
  | 'sales'
  | 'storage'
  | 'post'
  | 'sorting'
  | 'office'
  | 'garage'
  | 'shed';

/** Occupancy flags of a room's furniture grid. */
export const CELL_SOLID = 1;
export const CELL_CLEAR = 2;
export const CELL_LOW = 4;
/** Nobody can stand here, though low furniture may (an inner window sill sticks out at 0.8 m). */
export const CELL_BLOCK = 8;

/** Footprint (cells) of a player-sized body: PLAYER is 0.6 m wide. */
export const BODY = 2 * PLAYER.halfWidth;

/** Local rectangle (max exclusive). */
export interface LocalRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface Room {
  type: RoomType;
  storey: number;
  /** Free floor area (local, max exclusive). */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Floor surface (first air voxel). */
  fy: number;
  floor: number;
  /** Inner wall finish and what shows where it has fallen off. */
  finish: number;
  under: number;
  /** Height of a tile band (kitchens), 0 = none. */
  tileBand: number;
  /** Furniture occupancy grid, (u − u0) + (v − v0)·width. */
  cells: Uint8Array;
  /**
   * Where a player-sized body must be able to stand: body min corners (local) in front of each door,
   * stair end and container of the room. Furniture only goes where it keeps all of them connected.
   */
  access: LocalRect[];
}

export type ContainerRole =
  | 'starter'
  | 'garage_cabinet'
  | 'shed_crate'
  | 'wardrobe'
  | 'kitchen_cabinet'
  | 'shop_fridge'
  | 'storage_crate'
  | 'post_crate'
  | 'office_cabinet'
  | 'hall_cabinet';

/** A container spawn with the role the loot planner fills it by. */
export interface PlannedContainer {
  spawn: ContainerSpawn;
  role: ContainerRole;
}

export type SurfaceKind = 'table' | 'bed' | 'shelf' | 'counter' | 'workbench';

/** A spot where a loose item can rest (world units; y = surface the item lies on). */
export interface Surface {
  x: number;
  y: number;
  z: number;
  kind: SurfaceKind;
  building: BuildingType;
}

export interface RuinPlan {
  /** Collapse centre (local) and the radius band over which walls fall from `minH` to full height. */
  cu: number;
  cv: number;
  r0: number;
  r1: number;
  minH: number;
  /** Interior partitions (local rects) that collapse with the walls. */
  partitions: { u0: number; v0: number; u1: number; v1: number }[];
  /** Debris mounds (local centres). */
  mounds: { u: number; v: number; r: number; h: number }[];
}

export interface BuildingPlan {
  type: BuildingType;
  kind: string;
  seed: number;
  frame: Frame;
  W: number;
  D: number;
  t: number;
  yF: number;
  storeys: number;
  storeyH: number;
  clear: number;
  yTop: number;
  plinth: number;
  core: number;
  outer: number;
  plinthMat: number;
  slabMat: number;
  floorMat: number;
  /** Share of the outer layer fallen off / peeled (shows `core`), 0..1. */
  decay: number;
  parapet: number;
  roof: RoofPlan | null;
  ruin: RuinPlan | null;
  rooms: Room[];
  /** Stamped after the shell, in order: partitions, floors and inner finishes. */
  inner: BoxList[];
  /** Stamped after interior decay, in order: openings, frames, stairs, furniture, porches, signs. */
  main: BoxList[];
  /** Stamped after the roof: chimneys, attic windows, roof-top details. */
  post: BoxList[];
  bounds: LocalBounds;
  doors: DoorSpawn[];
  containers: PlannedContainer[];
  surfaces: Surface[];
  /** Ground paths (world rects, paved one voxel above the ground) from the street to exterior doors. */
  paths: PathPlan[];
  /** World rects that must stay free of trees and props (footprint + porches + eaves). */
  keepOut: Rect[];
  /** Self-seeded sapling on the roof: local column and base y (first air above the roof), or null. */
  roofSapling: { u: number; v: number; y: number } | null;
}

export interface PathPlan {
  rect: Rect;
  block: number;
}

/** A wall segment: runs along u (alongU) or v over [a0, a1); thickness [c0, c1) on the other axis. */
export interface WallRef {
  alongU: boolean;
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}

interface Exclusion {
  side: Side;
  storey: number;
  a0: number;
  a1: number;
}

export interface WindowStyle {
  w: number;
  h: number;
  sill: number;
  /** Panes: mullion offset from the left (0 = none) and transom offset from the bottom (0 = none). */
  mullion: number;
  transom: number;
  /** Probability that a pane survived. */
  glass: number;
  frame: number;
  outerSill: number;
  innerSill: number;
  /** Carved casing (наличник) around the window, block id or 0. */
  casing: number;
}

export const HOUSE_WINDOW: WindowStyle = {
  w: 12,
  h: 14,
  sill: 9,
  mullion: 6,
  transom: 9,
  glass: 0.6,
  frame: B.PAINTED_WOOD,
  outerSill: B.METAL,
  innerSill: B.PAINTED_WOOD,
  casing: 0,
};

/** Container model sizes [w, h, d] (world units, front = +Z) per ARCHITECTURE.md §9. */
export const CONTAINER_SIZE: Record<ContainerStyle, [number, number, number]> = {
  crate: [6, 4, 4],
  cabinet: [6, 18, 4],
  fridge: [6, 16, 6],
  toolbox: [5, 2.5, 2.5],
};

/** Scratch buffers of the walkability check, reused across calls (their contents never outlive one). */
const scratch = { sat: new Int32Array(0), seen: new Uint8Array(0), queue: new Int32Array(0) };

/** Mutable planning state shared by the type-specific planners and the furniture placer. */
export class BuildingBuilder {
  readonly rng: Rng;
  readonly f: Frame;
  readonly W: number;
  readonly D: number;
  t = 3;
  hf = 3;
  storeys = 1;
  clear = 26;
  plinth = 1;
  core: number = B.BRICK;
  outer: number = B.BRICK;
  plinthMat: number = B.CONCRETE;
  slabMat: number = B.CONCRETE;
  floorMat: number = B.PLANKS;
  decay = 0;
  parapet = 0;
  roof: RoofPlan | null = null;
  ruin: RuinPlan | null = null;
  roofSapling: { u: number; v: number; y: number } | null = null;

  readonly bounds = new LocalBounds();
  readonly rooms: Room[] = [];
  readonly partitionList = new BoxList(this.bounds);
  readonly finishes = new BoxList(this.bounds);
  readonly openings = new BoxList(this.bounds);
  readonly stairs = new BoxList(this.bounds);
  readonly furniture = new BoxList(this.bounds);
  readonly exterior = new BoxList(this.bounds);
  readonly post = new BoxList(this.bounds);
  readonly doors: DoorSpawn[] = [];
  readonly containers: PlannedContainer[] = [];
  readonly surfaces: Surface[] = [];
  readonly paths: PathPlan[] = [];
  readonly keepOut: Rect[] = [];
  private readonly exclusions: Exclusion[] = [];
  /** Local rects of porches (with steps), for keep-out and path planning. */
  readonly porches: { side: Side; u0: number; v0: number; u1: number; v1: number }[] = [];

  constructor(
    readonly lot: LotPlan,
    readonly seed: number,
  ) {
    this.rng = new Rng(seed);
    this.f = lot.frame;
    this.W = lot.frame.W;
    this.D = lot.frame.D;
  }

  get type(): BuildingType {
    return this.lot.type;
  }

  get yF(): number {
    return GROUND_TOP + this.hf;
  }

  get storeyH(): number {
    return this.clear + 2;
  }

  get yTop(): number {
    return this.yF + this.storeys * this.storeyH;
  }

  /** Floor surface (first air voxel) of storey s. */
  fy(s: number): number {
    return this.yF + 1 + s * this.storeyH;
  }

  // ------------------------------------------------------------------ geometry helpers

  /** Exterior wall of a side, full length. */
  sideWall(side: Side): WallRef {
    const { W, D, t } = this;
    switch (side) {
      case 'front':
        return { alongU: true, a0: 0, a1: W, c0: 0, c1: t };
      case 'back':
        return { alongU: true, a0: 0, a1: W, c0: D - t, c1: D };
      case 'left':
        return { alongU: false, a0: 0, a1: D, c0: 0, c1: t };
      default:
        return { alongU: false, a0: 0, a1: D, c0: W - t, c1: W };
    }
  }

  /**
   * Local rect on a side at along-range [a0, a1) and depth range [e0, e1) measured from the outer face
   * inwards (negative = outside the wall).
   */
  sideRect(side: Side, a0: number, a1: number, e0: number, e1: number): [number, number, number, number] {
    const { W, D } = this;
    switch (side) {
      case 'front':
        return [a0, e0, a1, e1];
      case 'back':
        return [a0, D - e1, a1, D - e0];
      case 'left':
        return [e0, a0, e1, a1];
      default:
        return [W - e1, a0, W - e0, a1];
    }
  }

  /** Adds a box on a side (see sideRect) to a list. */
  sideBox(list: BoxList, side: Side, a0: number, a1: number, e0: number, e1: number, y0: number, y1: number, id: number): void {
    const [u0, v0, u1, v1] = this.sideRect(side, a0, a1, e0, e1);
    list.add(u0, y0, v0, u1, y1, v1, id);
  }

  /** Local box of an opening in a wall. */
  wallOpening(w: WallRef, a: number, len: number): [number, number, number, number] {
    return w.alongU ? [a, w.c0, a + len, w.c1] : [w.c0, a, w.c1, a + len];
  }

  // ------------------------------------------------------------------ rooms & partitions

  room(type: RoomType, storey: number, u0: number, v0: number, u1: number, v1: number, floor: number, finish: number, under: number): Room {
    const r: Room = {
      type,
      storey,
      u0,
      v0,
      u1,
      v1,
      fy: this.fy(storey),
      floor,
      finish,
      under,
      tileBand: 0,
      cells: new Uint8Array(Math.max(0, (u1 - u0) * (v1 - v0))),
      access: [],
    };
    this.rooms.push(r);
    return r;
  }

  partition(storey: number, u0: number, v0: number, u1: number, v1: number, mat: number): WallRef {
    const fy = this.fy(storey);
    this.partitionList.add(u0, fy, v0, u1, fy + this.clear, v1, mat);
    const alongU = u1 - u0 >= v1 - v0;
    return alongU ? { alongU, a0: u0, a1: u1, c0: v0, c1: v1 } : { alongU, a0: v0, a1: v1, c0: u0, c1: u1 };
  }

  /** Marks a local rect in a room's furniture grid (clipped to the room). */
  mark(r: Room, u0: number, v0: number, u1: number, v1: number, flag: number): void {
    const w = r.u1 - r.u0;
    const a0 = Math.max(u0, r.u0);
    const a1 = Math.min(u1, r.u1);
    const b0 = Math.max(v0, r.v0);
    const b1 = Math.min(v1, r.v1);
    for (let v = b0; v < b1; v++) for (let u = a0; u < a1; u++) r.cells[u - r.u0 + (v - r.v0) * w] |= flag;
  }

  /** True when the rect lies inside the room and none of its cells has any of `blocked` flags. */
  free(r: Room, u0: number, v0: number, u1: number, v1: number, blocked: number): boolean {
    if (u0 < r.u0 || v0 < r.v0 || u1 > r.u1 || v1 > r.v1) return false;
    const w = r.u1 - r.u0;
    for (let v = v0; v < v1; v++) for (let u = u0; u < u1; u++) if (r.cells[u - r.u0 + (v - r.v0) * w] & blocked) return false;
    return true;
  }

  /** Rooms whose free area touches the given local rect on storey s (for door swing marking). */
  roomsAt(storey: number, u0: number, v0: number, u1: number, v1: number): Room[] {
    return this.rooms.filter((r) => r.storey === storey && r.u0 < u1 && u0 < r.u1 && r.v0 < v1 && v0 < r.v1);
  }

  /**
   * True when a player-sized body (BODY × BODY cells, none of them SOLID or BLOCK) can walk from the
   * room's first access point to every other one.
   */
  walkable(r: Room): boolean {
    const access = r.access;
    if (access.length === 0) return true;
    const w = r.u1 - r.u0;
    const d = r.v1 - r.v0;
    const cw = w - BODY + 1;
    const cd = d - BODY + 1;
    if (cw <= 0 || cd <= 0) return false;
    const sw = w + 1;
    const n = cw * cd;
    if (scratch.sat.length < sw * (d + 1)) scratch.sat = new Int32Array(sw * (d + 1));
    if (scratch.seen.length < n) {
      scratch.seen = new Uint8Array(n);
      scratch.queue = new Int32Array(n);
    }
    const { sat, seen, queue } = scratch;
    // Summed-area table of the blocked cells; a body corner is free (1) when its window sums to zero.
    sat.fill(0, 0, sw);
    for (let v = 0; v < d; v++) {
      let row = 0;
      sat[(v + 1) * sw] = 0;
      for (let u = 0; u < w; u++) {
        if (r.cells[u + v * w] & (CELL_SOLID | CELL_BLOCK)) row++;
        sat[(v + 1) * sw + u + 1] = sat[v * sw + u + 1] + row;
      }
    }
    for (let cv = 0; cv < cd; cv++) {
      const top = cv * sw;
      const bot = (cv + BODY) * sw;
      for (let cu = 0; cu < cw; cu++) seen[cu + cv * cw] = sat[bot + cu + BODY] - sat[top + cu + BODY] - sat[bot + cu] + sat[top + cu] === 0 ? 1 : 0;
    }
    // Flood (2 = reached) from the first access point.
    let tail = 0;
    const a = access[0];
    for (let v = Math.max(a.v0 - r.v0, 0); v < Math.min(a.v1 - r.v0, cd); v++) {
      for (let u = Math.max(a.u0 - r.u0, 0); u < Math.min(a.u1 - r.u0, cw); u++) {
        const k = u + v * cw;
        if (seen[k] === 1) {
          seen[k] = 2;
          queue[tail++] = k;
        }
      }
    }
    if (tail === 0) return false;
    for (let head = 0; head < tail; head++) {
      const k = queue[head];
      const cu = k % cw;
      if (cu + 1 < cw && seen[k + 1] === 1) {
        seen[k + 1] = 2;
        queue[tail++] = k + 1;
      }
      if (cu > 0 && seen[k - 1] === 1) {
        seen[k - 1] = 2;
        queue[tail++] = k - 1;
      }
      if (k + cw < n && seen[k + cw] === 1) {
        seen[k + cw] = 2;
        queue[tail++] = k + cw;
      }
      if (k >= cw && seen[k - cw] === 1) {
        seen[k - cw] = 2;
        queue[tail++] = k - cw;
      }
    }
    for (let i = 1; i < access.length; i++) {
      const t = access[i];
      let hit = false;
      for (let v = Math.max(t.v0 - r.v0, 0); v < Math.min(t.v1 - r.v0, cd) && !hit; v++) {
        for (let u = Math.max(t.u0 - r.u0, 0); u < Math.min(t.u1 - r.u0, cw); u++) {
          if (seen[u + v * cw] === 2) {
            hit = true;
            break;
          }
        }
      }
      if (!hit) return false;
    }
    return true;
  }

  /** Paints a room's floor and inner wall faces (finishes are stamped before openings are cut). */
  private paintRoom(r: Room): void {
    const L = this.finishes;
    const yf = r.fy - 1;
    L.add(r.u0, yf, r.v0, r.u1, yf + 1, r.v1, r.floor);
    const y0 = r.fy;
    const y1 = r.fy + this.clear;
    const ring = (id: number, ya: number, yb: number) => {
      L.add(r.u0, ya, r.v0 - 1, r.u1, yb, r.v0, id);
      L.add(r.u0, ya, r.v1, r.u1, yb, r.v1 + 1, id);
      L.add(r.u0 - 1, ya, r.v0, r.u0, yb, r.v1, id);
      L.add(r.u1, ya, r.v0, r.u1 + 1, yb, r.v1, id);
    };
    ring(r.finish, y0, y1);
    if (r.tileBand > 0) ring(B.TILES, y0, y0 + r.tileBand);
  }

  // ------------------------------------------------------------------ doors & windows

  exclude(side: Side, storey: number, a0: number, a1: number): void {
    this.exclusions.push({ side, storey, a0, a1 });
  }

  /**
   * Cuts a door opening in a wall at along-position `a` and records the DoorSpawn. `into` is the local
   * direction the leaf swings to (towards the room it opens into).
   */
  door(
    w: WallRef,
    storey: number,
    a: number,
    into: LocalDir,
    style: DoorStyle,
    open: boolean,
    width = DOOR_W,
    height = DOOR_H,
    hinge: 'start' | 'end' = this.rng.chance(0.5) ? 'start' : 'end',
  ): void {
    const fy = this.fy(storey);
    const [u0, v0, u1, v1] = this.wallOpening(w, a, width);
    this.openings.add(u0, fy, v0, u1, fy + height, v1, B.AIR);
    const f = this.f;
    const r = f.box(u0, v0, u1, v1);
    const axis = f.axisOf(w.alongU);
    const dx = f.dirX(into);
    const dz = f.dirZ(into);
    const swing = (axis === 'x' ? dz : dx) > 0 ? 1 : -1;
    const positive = f.axisPositive(w.alongU);
    this.doors.push({
      type: 'door',
      x: r.x0,
      y: fy,
      z: r.z0,
      axis,
      width,
      height,
      depth: w.c1 - w.c0,
      hinge: (hinge === 'start') === positive ? 'min' : 'max',
      swing: swing as 1 | -1,
      style,
      open,
    });
    // Keep both sides of the doorway clear of furniture (the leaf swings 90° into one of them).
    const sweep = width + 1;
    for (const dir of [into, opposite(into)] as LocalDir[]) {
      const s = dir === 0 || dir === 1 ? 1 : -1;
      if (w.alongU) {
        const vA = s > 0 ? w.c1 : w.c0 - sweep;
        for (const room of this.roomsAt(storey, a - 1, vA, a + width + 1, vA + sweep)) this.mark(room, a - 1, vA, a + width + 1, vA + sweep, CELL_CLEAR);
      } else {
        const uA = s > 0 ? w.c1 : w.c0 - sweep;
        for (const room of this.roomsAt(storey, uA, a - 1, uA + sweep, a + width + 1)) this.mark(room, uA, a - 1, uA + sweep, a + width + 1, CELL_CLEAR);
      }
    }
    // A body lined up with the opening (every door is wider than a body), against the wall, on either side.
    const span = width - BODY + 1;
    for (const room of this.rooms) {
      if (room.storey !== storey) continue;
      if (w.alongU && room.u0 <= a && a + width <= room.u1) {
        if (room.v0 === w.c1) room.access.push({ u0: a, v0: w.c1, u1: a + span, v1: w.c1 + 1 });
        else if (room.v1 === w.c0) room.access.push({ u0: a, v0: w.c0 - BODY, u1: a + span, v1: w.c0 - BODY + 1 });
      } else if (!w.alongU && room.v0 <= a && a + width <= room.v1) {
        if (room.u0 === w.c1) room.access.push({ u0: w.c1, v0: a, u1: w.c1 + 1, v1: a + span });
        else if (room.u1 === w.c0) room.access.push({ u0: w.c0 - BODY, v0: a, u1: w.c0 - BODY + 1, v1: a + span });
      }
    }
  }

  /** Exterior door on a side; registers a window exclusion around it. */
  exteriorDoor(side: Side, a: number, style: DoorStyle, open: boolean, width = DOOR_W, height = DOOR_H, hinge?: 'start' | 'end'): void {
    this.door(this.sideWall(side), 0, a, opposite(SIDE_OUT[side]), style, open, width, height, hinge);
    this.exclude(side, 0, a - 5, a + width + 5);
    this.cracks(side, a, a + width, this.fy(0) + height, 0.3);
  }

  /**
   * Stress cracks climbing diagonally from the top corners of an opening [a0, a1) whose top is y1:
   * the core shows through plaster, bare masonry gets a shallow groove; wooden walls don't crack.
   */
  cracks(side: Side, a0: number, a1: number, y1: number, chance: number): void {
    // The ruin's broken walls may not reach that high; it weathers its own way.
    if (this.core === B.PLANKS || this.ruin) return;
    const id = this.outer !== this.core ? this.core : B.AIR;
    for (const dir of [-1, 1]) {
      if (!this.rng.chance(chance)) continue;
      let a = dir < 0 ? a0 - 1 : a1;
      let y = y1;
      const len = this.rng.int(4, 9);
      for (let k = 0; k < len && y < this.yTop; k++) {
        this.sideBox(this.openings, side, a, a + 1, 0, 1, y, y + 1, id);
        if (this.rng.chance(0.5)) a += dir;
        else y++;
      }
    }
  }

  /** Interior door through a partition, swinging towards `into`. */
  interiorDoor(p: WallRef, storey: number, a: number, into: LocalDir): void {
    const style: DoorStyle = this.rng.chance(0.7) ? 'wood_painted' : 'wood';
    this.door(p, storey, a, into, style, this.rng.chance(0.55));
  }

  /**
   * Door position on the shared stretch [lo, hi) of a partition, away from its ends; returns the
   * along-position of the opening or null when the stretch is too short.
   */
  doorSpot(lo: number, hi: number, prefer = 0.5): number | null {
    const min = lo + 3;
    const max = hi - 3 - DOOR_W;
    if (max < min) return null;
    return Math.round(min + (max - min) * prefer);
  }

  /** Places windows along the exterior walls of a room. */
  windows(r: Room, style: WindowStyle, maxPerWall: number, sides: readonly Side[] = ['front', 'back', 'left', 'right']): void {
    const { W, D, t } = this;
    for (const side of sides) {
      let a0: number;
      let a1: number;
      if (side === 'front') {
        if (r.v0 !== t) continue;
        [a0, a1] = [r.u0, r.u1];
      } else if (side === 'back') {
        if (r.v1 !== D - t) continue;
        [a0, a1] = [r.u0, r.u1];
      } else if (side === 'left') {
        if (r.u0 !== t) continue;
        [a0, a1] = [r.v0, r.v1];
      } else {
        if (r.u1 !== W - t) continue;
        [a0, a1] = [r.v0, r.v1];
      }
      const lo = a0 + 3;
      const hi = a1 - 3;
      const len = hi - lo;
      const n = Math.min(maxPerWall, Math.floor((len + 10) / (style.w + 10)));
      if (n <= 0) continue;
      const blocked = this.exclusions.filter((e) => e.side === side && e.storey === r.storey);
      const placed: number[] = [];
      for (let i = 0; i < n; i++) {
        const centre = lo + (len * (i + 0.5)) / n;
        let a = Math.round(centre - style.w / 2);
        // Slide away from exclusions (doors, stairs) if possible.
        for (const e of blocked) {
          if (a < e.a1 && e.a0 < a + style.w) a = centre < (e.a0 + e.a1) / 2 ? e.a0 - style.w : e.a1;
        }
        if (a < lo || a + style.w > hi) continue;
        if (blocked.some((e) => a < e.a1 && e.a0 < a + style.w)) continue;
        if (placed.some((p) => a < p + style.w + 6 && p < a + style.w + 6)) continue;
        placed.push(a);
        this.window(side, r, a, style);
      }
    }
  }

  /** One window in an exterior wall of room `r` at along-position a. */
  window(side: Side, r: Room, a: number, s: WindowStyle): void {
    const t = this.t;
    const y0 = r.fy + s.sill;
    const y1 = y0 + s.h;
    const ef = Math.min(1, t - 1);
    const O = this.openings;
    this.sideBox(O, side, a, a + s.w, 0, t, y0, y1, B.AIR);
    // Frame ring, mullion, transom and panes in the frame plane.
    this.sideBox(O, side, a, a + 1, ef, ef + 1, y0, y1, s.frame);
    this.sideBox(O, side, a + s.w - 1, a + s.w, ef, ef + 1, y0, y1, s.frame);
    this.sideBox(O, side, a + 1, a + s.w - 1, ef, ef + 1, y0, y0 + 1, s.frame);
    this.sideBox(O, side, a + 1, a + s.w - 1, ef, ef + 1, y1 - 1, y1, s.frame);
    const cols: [number, number][] = s.mullion > 0 ? [[a + 1, a + s.mullion], [a + s.mullion + 1, a + s.w - 1]] : [[a + 1, a + s.w - 1]];
    const rows: [number, number][] = s.transom > 0 ? [[y0 + 1, y0 + s.transom], [y0 + s.transom + 1, y1 - 1]] : [[y0 + 1, y1 - 1]];
    if (s.mullion > 0) this.sideBox(O, side, a + s.mullion, a + s.mullion + 1, ef, ef + 1, y0 + 1, y1 - 1, s.frame);
    if (s.transom > 0) this.sideBox(O, side, a + 1, a + s.w - 1, ef, ef + 1, y0 + s.transom, y0 + s.transom + 1, s.frame);
    for (const [c0, c1] of cols) {
      for (const [r0, r1] of rows) {
        if (this.rng.chance(s.glass)) this.sideBox(O, side, c0, c1, ef, ef + 1, r0, r1, B.GLASS);
      }
    }
    if (s.outerSill) this.sideBox(O, side, a - 1, a + s.w + 1, -1, 0, y0 - 1, y0, s.outerSill);
    if (s.innerSill) {
      this.sideBox(O, side, a - 1, a + s.w + 1, t, t + 1, y0 - 1, y0, s.innerSill);
      const [u0, v0, u1, v1] = this.sideRect(side, a - 1, a + s.w + 1, t, t + 1);
      this.mark(r, u0, v0, u1, v1, CELL_BLOCK);
    }
    if (s.casing) {
      const c = s.casing;
      this.sideBox(O, side, a - 1, a, -1, 0, y0 - 1, y1 + 1, c);
      this.sideBox(O, side, a + s.w, a + s.w + 1, -1, 0, y0 - 1, y1 + 1, c);
      this.sideBox(O, side, a - 2, a + s.w + 2, -1, 0, y1, y1 + 1, c);
      this.sideBox(O, side, a + 1, a + s.w - 1, -1, 0, y1 + 1, y1 + 2, c);
      this.sideBox(O, side, a + 3, a + s.w - 3, -1, 0, y1 + 2, y1 + 3, c);
    }
    this.cracks(side, a, a + s.w, y1 + (s.casing ? 3 : 0), 0.35);
    // Tall furniture must not stand in front of windows.
    const [u0, v0, u1, v1] = this.sideRect(side, a - 1, a + s.w + 1, t, t + 3);
    this.mark(r, u0, v0, u1, v1, CELL_LOW);
  }

  // ------------------------------------------------------------------ porches & paths

  /**
   * Porch in front of an exterior door: a landing at floor level (top voxel yF) with steps of
   * ≤ 2 voxels rise / 3 run down to the ground, optional canopy. Returns how far it sticks out.
   */
  porch(side: Side, a: number, opts: { width?: number; depth?: number; mat: number; canopy: number; posts: number }): number {
    const width = opts.width ?? DOOR_W + 6;
    const depth = opts.depth ?? 10;
    const a0 = a - ((width - DOOR_W) >> 1);
    const a1 = a0 + width;
    const yF = this.yF;
    const L = this.exterior;
    // Landing (solid down into the ground so nothing floats).
    this.sideBox(L, side, a0, a1, -depth, 0, GROUND_TOP - 1, yF + 1, opts.mat);
    let out = depth;
    for (let top = yF - 2; top > GROUND_TOP; top -= 2) {
      this.sideBox(L, side, a0, a1, -out - 3, -out, GROUND_TOP - 1, top + 1, opts.mat);
      out += 3;
    }
    // Moss on the landing, from the threshold to its outer edge.
    for (let i = this.rng.int(1, 4); i > 0; i--) {
      const ma = this.rng.int(a0, a1 - 1);
      const me = -this.rng.int(1, depth + 1);
      this.sideBox(L, side, ma, ma + 2, me, me + 1, yF, yF + 1, B.MOSS);
    }
    if (opts.canopy) {
      const cy = yF + 1 + DOOR_H + 2;
      this.sideBox(L, side, a0 - 1, a1 + 1, -depth - 1, 0, cy, cy + 1, opts.canopy);
      if (opts.posts) {
        this.sideBox(L, side, a0, a0 + 1, -depth, -depth + 1, yF + 1, cy, opts.posts);
        this.sideBox(L, side, a1 - 1, a1, -depth, -depth + 1, yF + 1, cy, opts.posts);
      }
    }
    const [u0, v0, u1, v1] = this.sideRect(side, a0 - 1, a1 + 1, -out, 0);
    this.porches.push({ side, u0, v0, u1, v1 });
    return out;
  }

  /**
   * Ground path from the foot of a porch to the lot's street edge. `a` is the door's along position,
   * `out` how far the porch sticks out.
   */
  pathFromDoor(side: Side, a: number, out: number, block: number): void {
    const f = this.f;
    const half = 5;
    const mid = a + (DOOR_W >> 1);
    const front = -this.lot.setback;
    if (side === 'front') {
      this.paths.push({ rect: f.box(mid - half, front, mid + half, -out), block });
    } else if (side === 'left' || side === 'right') {
      // Along the side yard to the foot of the porch steps.
      const [u0, , u1] = this.sideRect(side, 0, 1, -out - 10, -out);
      this.paths.push({ rect: f.box(u0, front, u1, mid + half), block });
    }
  }

  // ------------------------------------------------------------------ stairs

  /**
   * Straight flight (2-voxel rise, 3-voxel run) from storey 0 to storey 1 at u ∈ [us, us + 9), rising
   * towards +v from v = vs, with the stairwell opened in the slab and a railing on the open side.
   * `openSide` is +1 when the open (railing) side is at u = us + 9, −1 when at u = us − 1.
   */
  stair(us: number, vs: number, openSide: 1 | -1, mat: number, rail: number): { vEnd: number; open0: number; open1: number } {
    const fy = this.fy(0);
    const fy1 = this.fy(1);
    const n = this.storeyH >> 1;
    const L = this.stairs;
    for (let k = 1; k <= n; k++) L.add(us, fy, vs + 3 * (k - 1), us + 9, fy + 2 * k, vs + 3 * k, mat);
    const open0 = vs + 3 * Math.max(0, ((this.clear - 18) >> 1) - 2);
    const open1 = vs + 3 * (n - 1);
    L.add(us, fy + this.clear, open0, us + 9, fy + this.clear + 2, open1, B.AIR);
    // Railing around the stairwell on the upper floor.
    const ru = openSide > 0 ? us + 9 : us - 1;
    for (let v = open0; v < open1; v += 4) L.add(ru, fy1, v, ru + 1, fy1 + 9, v + 1, rail);
    L.add(ru, fy1, open1 - 1, ru + 1, fy1 + 9, open1, rail);
    L.add(ru, fy1 + 9, open0 - 1, ru + 1, fy1 + 10, open1, rail);
    L.add(us, fy1 + 9, open0 - 1, us + 9, fy1 + 10, open0, rail);
    for (let u = us; u < us + 9; u += 4) L.add(u, fy1, open0 - 1, u + 1, fy1 + 9, open0, rail);
    // Furniture keeps off the flight, its foot, the stairwell and the landing at the top, where a body
    // steps onto and off the flight.
    for (const r of this.roomsAt(0, us, vs - 10, us + 9, vs + 3 * n)) {
      this.mark(r, us, vs, us + 9, vs + 3 * n, CELL_SOLID | CELL_CLEAR);
      this.mark(r, us, vs - 10, us + 9, vs, CELL_CLEAR);
      r.access.push({ u0: us, v0: vs - BODY, u1: us + 10 - BODY, v1: vs - BODY + 1 });
    }
    for (const r of this.roomsAt(1, us - 1, open0 - 1, us + 10, open1)) {
      this.mark(r, us - 1, open0 - 1, us + 10, open1, CELL_SOLID | CELL_CLEAR);
      this.mark(r, us - 1, open1, us + 10, open1 + BODY + 2, CELL_CLEAR);
      r.access.push({ u0: us, v0: open1, u1: us + 10 - BODY, v1: open1 + 1 });
    }
    return { vEnd: vs + 3 * n, open0, open1 };
  }

  // ------------------------------------------------------------------ signs & spawns

  /** Sign board with raised letters on the front facade, centred at u = cu, bottom at y0. */
  sign(text: string, cu: number, y0: number, board: number, letters: number): void {
    const tw = textWidth(text);
    const bw = tw + 4;
    const u0 = Math.round(cu - bw / 2);
    const L = this.exterior;
    L.add(u0, y0, -1, u0 + bw, y0 + GLYPH_H + 4, 0, board);
    const lu = u0 + 2;
    const top = y0 + 2 + GLYPH_H - 1;
    forEachTextCell(text, (col, row) => L.add(lu + col, top - row, -2, lu + col + 1, top - row + 1, -1, letters));
  }

  /** Surface at a continuous local point. */
  surface(u: number, v: number, y: number, kind: SurfaceKind): Surface {
    return { x: this.f.px(u, v), y, z: this.f.pz(u, v), kind, building: this.type };
  }

  /**
   * Container entity standing in a local rect with its front towards `front`; the model is centred
   * along the wall and backed against it.
   */
  container(style: ContainerStyle, role: ContainerRole, u0: number, v0: number, u1: number, v1: number, front: LocalDir, fy: number): void {
    const size = CONTAINER_SIZE[style];
    const back = opposite(front);
    // Centre of the rect, pulled towards the back wall so the model's back is ~0.3 voxels from it.
    let cu = (u0 + u1) / 2;
    let cv = (v0 + v1) / 2;
    const half = size[2] / 2 + 0.3;
    if (back === 0) cv = v1 - half;
    else if (back === 2) cv = v0 + half;
    else if (back === 1) cu = u1 - half;
    else cu = u0 + half;
    this.containers.push({
      spawn: {
        type: 'container',
        x: this.f.px(cu, cv),
        y: fy,
        z: this.f.pz(cu, cv),
        facing: this.f.facingOf(front),
        style,
        loot: [],
      },
      role,
    });
  }

  // ------------------------------------------------------------------ assembly

  /** Finalises the plan: room finishes, bounds of procedural parts, keep-out rects. */
  build(): BuildingPlan {
    for (const r of this.rooms) this.paintRoom(r);
    const { W, D, plinth } = this;
    // Procedural shell (+ plinth), roof and ground details around the walls.
    const m = Math.max(plinth, 1) + 3;
    this.bounds.add(-m, GROUND_TOP - 2, -m, W + m, this.yTop + 1 + this.parapet, D + m);
    if (this.roof) {
      const rb = this.roof.bounds;
      this.bounds.add(rb.u0, this.yTop, rb.v0, rb.u1, rb.y1, rb.v1);
    }
    if (this.ruin) {
      for (const md of this.ruin.mounds) this.bounds.add(md.u - md.r - 1, GROUND_TOP, md.v - md.r - 1, md.u + md.r + 2, this.yF + md.h + 2, md.v + md.r + 2);
    }
    const f = this.f;
    const ext = this.roof ? this.roof.bounds : { u0: 0, v0: 0, u1: W, v1: D };
    this.keepOut.push(f.box(Math.min(-m, ext.u0), Math.min(-m, ext.v0), Math.max(W + m, ext.u1), Math.max(D + m, ext.v1)));
    for (const p of this.porches) this.keepOut.push(f.box(p.u0, p.v0, p.u1, p.v1));
    for (const p of this.paths) this.keepOut.push(p.rect);

    return {
      type: this.type,
      kind: `building:${this.type}`,
      seed: this.seed,
      frame: f,
      W,
      D,
      t: this.t,
      yF: this.yF,
      storeys: this.storeys,
      storeyH: this.storeyH,
      clear: this.clear,
      yTop: this.yTop,
      plinth,
      core: this.core,
      outer: this.outer,
      plinthMat: this.plinthMat,
      slabMat: this.slabMat,
      floorMat: this.floorMat,
      decay: this.decay,
      parapet: this.parapet,
      roof: this.roof,
      ruin: this.ruin,
      rooms: this.rooms,
      inner: [this.partitionList, this.finishes],
      main: [this.openings, this.stairs, this.furniture, this.exterior],
      post: [this.post],
      bounds: this.bounds,
      doors: this.doors,
      containers: this.containers,
      surfaces: this.surfaces,
      paths: this.paths,
      keepOut: this.keepOut,
      roofSapling: this.roofSapling,
    };
  }
}
