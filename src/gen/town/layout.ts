/**
 * Town master plan: a T of two streets (main street E–W along the south of TOWN_BUILD_RECT, a side
 * street running north from it), the four blocks they leave, building lots facing the streets, and
 * anchors for the street furniture. The skeleton is fixed so the composition seen from the entrance
 * is always good; the seed varies lot sizes, setbacks, alignment and everything inside them.
 */
import { TOWN_BUILD_RECT } from '../../config';
import type { Rng } from '../../core/rng';
import type { Facing } from '../types';
import { Frame, type Rect } from './frame';

export type BuildingType = 'brick_house' | 'wooden_house' | 'shop' | 'garage' | 'office' | 'ruin' | 'shed';

/** Sidewalk width including the 1-voxel curb. */
export const SIDEWALK = 18;

/** Main street asphalt (E–W): z ∈ [MAIN_Z0, MAIN_Z1). */
export const MAIN_Z0 = 500;
export const MAIN_Z1 = 560;
/** Side street asphalt (N–S): x ∈ [SIDE_X0, SIDE_X1), from the north edge down to the main street. */
export const SIDE_X0 = 290;
export const SIDE_X1 = 350;

export interface StreetPlan {
  kind: 'main' | 'side';
  /** Direction the street runs along. */
  axis: 'x' | 'z';
  asphalt: Rect;
  /** Sidewalk paving (top voxel at PAVED_TOP). */
  paving: Rect[];
  /** Curb strips (top voxel at PAVED_TOP). */
  curbs: Rect[];
  /** Ends (along `axis`) where the street crumbles into the countryside. */
  raggedMin: boolean;
  raggedMax: boolean;
}

/** A building lot: the building is placed inside `area`, its front towards the street side `facing`. */
export interface LotPlan {
  type: BuildingType;
  area: Rect;
  facing: Facing;
  /** Building footprint frame. */
  frame: Frame;
  /** Gap between the area's street edge and the front wall. */
  setback: number;
  /** Free space inside the area beside the building on its local left (−u) and right (+u). */
  roomLeft: number;
  roomRight: number;
  /** Fenced front garden (residential lots). */
  fenced: boolean;
  /** Landmark name for the map, if any. */
  landmark: string | null;
}

export interface TownLayout {
  streets: StreetPlan[];
  lots: LotPlan[];
  /** Player spawn on the road and the look target. */
  entrance: { x: number; z: number; yaw: number };
  /** Areas kept free of potholes, cracks and missing pavers (entrance, starter toolbox). */
  cleanZones: Rect[];
  /** Spawn pad: asphalt stays intact here even where the street end crumbles. */
  spawnPad: Rect;
}

const R = TOWN_BUILD_RECT;
const WEST_BLOCK_X1 = SIDE_X0 - SIDEWALK; // 272
const EAST_BLOCK_X0 = SIDE_X1 + SIDEWALK; // 368
const BLOCK_Z1 = MAIN_Z0 - SIDEWALK; // 482

interface SlotDef {
  type: BuildingType;
  area: Rect;
  facing: Facing;
  w: [number, number];
  d: [number, number];
  setback: [number, number];
  fenced: boolean;
  landmark: string | null;
}

// prettier-ignore
const SLOTS: readonly SlotDef[] = [
  // East block, main street frontage — the shop greets the player at the entrance.
  { type: 'shop', area: { x0: 448, z0: 372, x1: 586, z1: BLOCK_Z1 }, facing: 0, w: [100, 112], d: [70, 78], setback: [16, 16], fenced: false, landmark: 'Магазин' },
  { type: 'garage', area: { x0: EAST_BLOCK_X0, z0: 392, x1: 444, z1: 462 }, facing: 3, w: [42, 46], d: [56, 62], setback: [8, 12], fenced: false, landmark: 'Гараж' },
  // East block, side street frontage.
  { type: 'office', area: { x0: EAST_BLOCK_X0, z0: 222, x1: 486, z1: 362 }, facing: 3, w: [104, 114], d: [86, 92], setback: [18, 22], fenced: false, landmark: 'Почта' },
  { type: 'wooden_house', area: { x0: EAST_BLOCK_X0, z0: 50, x1: 480, z1: 172 }, facing: 3, w: [70, 80], d: [66, 76], setback: [20, 26], fenced: true, landmark: null },
  // West block, main street frontage.
  { type: 'brick_house', area: { x0: 144, z0: 362, x1: 268, z1: BLOCK_Z1 }, facing: 0, w: [94, 104], d: [82, 88], setback: [24, 28], fenced: true, landmark: null },
  { type: 'ruin', area: { x0: 44, z0: 372, x1: 136, z1: BLOCK_Z1 }, facing: 0, w: [72, 82], d: [62, 70], setback: [22, 30], fenced: false, landmark: 'Развалины' },
  // West block, side street frontage.
  { type: 'wooden_house', area: { x0: 150, z0: 46, x1: WEST_BLOCK_X1, z1: 162 }, facing: 1, w: [70, 80], d: [66, 76], setback: [20, 26], fenced: true, landmark: null },
  { type: 'wooden_house', area: { x0: 150, z0: 178, x1: WEST_BLOCK_X1, z1: 296 }, facing: 1, w: [70, 80], d: [66, 76], setback: [20, 26], fenced: true, landmark: null },
  // Back yard shed behind the north-west house, facing its yard.
  { type: 'shed', area: { x0: 60, z0: 62, x1: 128, z1: 128 }, facing: 1, w: [30, 36], d: [30, 36], setback: [10, 14], fenced: false, landmark: 'Сарай' },
];

/** Local frame spanning a whole lot area with the given facing (u along the street edge). */
export function areaFrame(area: Rect, facing: Facing): Frame {
  const alongX = facing === 0 || facing === 2;
  const w = alongX ? area.x1 - area.x0 : area.z1 - area.z0;
  const d = alongX ? area.z1 - area.z0 : area.x1 - area.x0;
  return new Frame(area.x0, area.z0, w, d, facing);
}

/**
 * Places a W×D building inside an area frame at front gap `setback`, `align` ∈ [0, 1] distributing the
 * free width (0 = flush to the local left margin). Returns the building frame and its offset along u.
 */
function placeInArea(af: Frame, W: number, D: number, setback: number, align: number, margin = 4): { frame: Frame; u0: number } {
  const slack = Math.max(0, af.W - W - 2 * margin);
  const u0 = margin + Math.round(slack * align);
  const r = af.box(u0, setback, u0 + W, setback + D);
  return { frame: new Frame(r.x0, r.z0, W, D, af.facing), u0 };
}

function planStreets(): StreetPlan[] {
  const main: StreetPlan = {
    kind: 'main',
    axis: 'x',
    asphalt: { x0: R.x0, z0: MAIN_Z0, x1: R.x1, z1: MAIN_Z1 },
    paving: [
      { x0: R.x0, z0: BLOCK_Z1, x1: SIDE_X0 - 1, z1: MAIN_Z0 - 1 },
      { x0: SIDE_X1 + 1, z0: BLOCK_Z1, x1: R.x1, z1: MAIN_Z0 - 1 },
      { x0: R.x0, z0: MAIN_Z1 + 1, x1: R.x1, z1: MAIN_Z1 + SIDEWALK },
    ],
    curbs: [
      { x0: R.x0, z0: MAIN_Z0 - 1, x1: SIDE_X0, z1: MAIN_Z0 },
      { x0: SIDE_X1, z0: MAIN_Z0 - 1, x1: R.x1, z1: MAIN_Z0 },
      { x0: R.x0, z0: MAIN_Z1, x1: R.x1, z1: MAIN_Z1 + 1 },
    ],
    raggedMin: true,
    raggedMax: true,
  };
  const side: StreetPlan = {
    kind: 'side',
    axis: 'z',
    asphalt: { x0: SIDE_X0, z0: R.z0, x1: SIDE_X1, z1: MAIN_Z0 },
    paving: [
      { x0: WEST_BLOCK_X1, z0: R.z0, x1: SIDE_X0 - 1, z1: BLOCK_Z1 },
      { x0: SIDE_X1 + 1, z0: R.z0, x1: EAST_BLOCK_X0, z1: BLOCK_Z1 },
    ],
    curbs: [
      { x0: SIDE_X0 - 1, z0: R.z0, x1: SIDE_X0, z1: MAIN_Z0 },
      { x0: SIDE_X1, z0: R.z0, x1: SIDE_X1 + 1, z1: MAIN_Z0 },
    ],
    raggedMin: true,
    raggedMax: false,
  };
  return [main, side];
}

/** Builds the master plan; `rng` only varies lot sizes and placement. */
export function planLayout(rng: Rng): TownLayout {
  const lots: LotPlan[] = [];
  for (const s of SLOTS) {
    const W = rng.int(s.w[0], s.w[1] + 1);
    const D = rng.int(s.d[0], s.d[1] + 1);
    const setback = rng.int(s.setback[0], s.setback[1] + 1);
    const af = areaFrame(s.area, s.facing);
    // Wooden houses keep one wide side yard for their side porch; the shop stays near the entrance.
    let align: number;
    if (s.type === 'shop') align = 0.85;
    else if (s.type === 'wooden_house') align = rng.chance(0.5) ? rng.range(0, 0.12) : rng.range(0.88, 1);
    else align = rng.range(0.3, 0.7);
    const placed = placeInArea(af, W, D, setback, align);
    lots.push({
      type: s.type,
      area: s.area,
      facing: s.facing,
      frame: placed.frame,
      setback,
      roomLeft: placed.u0,
      roomRight: af.W - placed.u0 - W,
      fenced: s.fenced,
      landmark: s.landmark,
    });
  }
  const ex = R.x1 - 30;
  const ez = (MAIN_Z0 + MAIN_Z1) >> 1;
  // Look west along the main street, slightly towards the shop side: yaw = atan2(-dx, -dz).
  const lookX = -1;
  const lookZ = -0.15;
  return {
    streets: planStreets(),
    lots,
    entrance: { x: ex, z: ez, yaw: Math.atan2(-lookX, -lookZ) },
    cleanZones: [{ x0: ex - 50, z0: MAIN_Z0 - SIDEWALK, x1: R.x1, z1: MAIN_Z1 + 6 }],
    spawnPad: { x0: ex - 8, z0: ez - 8, x1: ex + 9, z1: ez + 9 },
  };
}
