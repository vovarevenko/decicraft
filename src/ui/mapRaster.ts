/**
 * Base image of the map screen: one pixel per MAP_SCALE×MAP_SCALE world columns. OWNER: agent "items-ui".
 *
 * A column's colour is its top visible block — the top-face colour of the topmost opaque voxel
 * (foliage darkened), water tinted by its depth over the bottom, a plant standing on top mixed into
 * the ground — averaged over the pixel's columns and shaded by a hillshade lit from the north-west.
 * The hillshade comes from the sky height map (terrain and buildings), or from the canopy height map
 * where tree crowns cover the pixel, so crowns read as rounded blobs. Pure computation over WorldData
 * (no DOM), done for any pixel rectangle so that edits can be redrawn piecewise.
 */
import { WORLD_X, WORLD_Z } from '../config';
import { B, COLOR_SIDE, COLOR_TOP, FOLIAGE, RENDER_KIND, RK } from '../world/blocks';
import type { WorldData } from '../world/world';

/** World columns per map pixel along each axis. */
export const MAP_SCALE = 2;
export const MAP_W = WORLD_X / MAP_SCALE;
export const MAP_H = WORLD_Z / MAP_SCALE;

const COLUMNS_PER_PIXEL = MAP_SCALE * MAP_SCALE;
const MAX_WATER_DEPTH = 48;
const FOLIAGE_SHADE = 0.8;
/** Weight of a plant's colour over the ground it stands on. */
const PLANT_MIX = 0.4;
/** Slope exaggeration, so that gently rolling ground still shows its relief. */
const RELIEF = 1.6;
const SHADE_MIN = 0.45;
const SHADE_MAX = 1.45;
/** Unit vector towards the light: from the north-west (−X, −Z), 45° above the horizon. */
const LIGHT_X = -0.5;
const LIGHT_Y = Math.SQRT1_2;
const LIGHT_Z = -0.5;
/** Pixels on each side used for the broad slope (8 px = 16 voxels across). */
const BROAD_PX = 4;
/** How far (pixels) the shading of a pixel reaches: redraw this rim around edited areas. */
export const MAP_SHADE_REACH = BROAD_PX;
/** Height-sum differences → slopes in voxels per voxel: across ±BROAD_PX pixels and across ±1 pixel. */
const BROAD_K = 1 / (COLUMNS_PER_PIXEL * 2 * BROAD_PX * MAP_SCALE);
const LOCAL_K = 1 / (COLUMNS_PER_PIXEL * 2 * MAP_SCALE);
/** Local slope detail fades in between these magnitudes: walls, roofs and cliffs stay crisp, 10 cm terrace steps vanish. */
const DETAIL_FROM = 0.15;
const DETAIL_TO = 0.6;

const KIND_GROUND = 0;
const KIND_FOLIAGE = 1;
const KIND_WATER = 2;

/** Water colour by depth in voxels (sRGB, 3 per depth) and how much of the bottom shows through. */
const WATER_RGB = new Float32Array((MAX_WATER_DEPTH + 1) * 3);
const BOTTOM_SHOWS = new Float32Array(MAX_WATER_DEPTH + 1);
for (let d = 0; d <= MAX_WATER_DEPTH; d++) {
  const deep = 1 - Math.exp(-d / 10);
  WATER_RGB[d * 3] = 72 + (22 - 72) * deep;
  WATER_RGB[d * 3 + 1] = 126 + (60 - 126) * deep;
  WATER_RGB[d * 3 + 2] = 136 + (80 - 136) * deep;
  BOTTOM_SHOWS[d] = 0.55 * Math.exp(-d / 5);
}

/** Colour of the last column passed to columnColor() (scratch, avoids allocations). */
const rgb = new Float32Array(3);

/**
 * Recolours map pixels [px0, px1) × [pz0, pz1) of `rgba` (MAP_W × MAP_H pixels, 4 bytes each). The
 * hillshade of a pixel depends on the heights of pixels up to MAP_SHADE_REACH away, so after an edit
 * redraw that rim around the edited area too.
 */
export function rasterizeMap(world: WorldData, rgba: Uint8ClampedArray, px0: number, pz0: number, px1: number, pz1: number): void {
  for (let pz = pz0; pz < pz1; pz++) {
    for (let px = px0; px < px1; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let foliage = 0;
      let water = 0;
      for (let dz = 0; dz < MAP_SCALE; dz++) {
        for (let dx = 0; dx < MAP_SCALE; dx++) {
          const kind = columnColor(world, px * MAP_SCALE + dx, pz * MAP_SCALE + dz);
          r += rgb[0];
          g += rgb[1];
          b += rgb[2];
          if (kind === KIND_FOLIAGE) foliage++;
          else if (kind === KIND_WATER) water++;
        }
      }
      const shade =
        water * 2 > COLUMNS_PER_PIXEL ? 1 : hillshade(foliage * 2 > COLUMNS_PER_PIXEL ? world.canopy : world.sky, px, pz);
      const k = shade / COLUMNS_PER_PIXEL;
      const o = (px + pz * MAP_W) * 4;
      rgba[o] = r * k;
      rgba[o + 1] = g * k;
      rgba[o + 2] = b * k;
      rgba[o + 3] = 255;
    }
  }
}

/** Writes the colour of column (x, z) to `rgb` and returns what is on top (KIND_*). */
function columnColor(world: WorldData, x: number, z: number): number {
  const top = world.canopy[x + z * WORLD_X];
  if (top <= 0) {
    rgb[0] = 14;
    rgb[1] = 16;
    rgb[2] = 20;
    return KIND_GROUND;
  }
  const id = world.getBlock(x, top - 1, z);
  let r = COLOR_TOP[id * 3];
  let g = COLOR_TOP[id * 3 + 1];
  let b = COLOR_TOP[id * 3 + 2];
  let kind = KIND_GROUND;
  if (FOLIAGE[id] === 1) {
    r *= FOLIAGE_SHADE;
    g *= FOLIAGE_SHADE;
    b *= FOLIAGE_SHADE;
    kind = KIND_FOLIAGE;
  }
  let y = top;
  let above = world.getBlock(x, y, z);
  if (above === B.WATER) {
    let depth = 1;
    while (depth < MAX_WATER_DEPTH && world.getBlock(x, y + depth, z) === B.WATER) depth++;
    const show = BOTTOM_SHOWS[depth];
    const w = depth * 3;
    r = WATER_RGB[w] + (r - WATER_RGB[w]) * show;
    g = WATER_RGB[w + 1] + (g - WATER_RGB[w + 1]) * show;
    b = WATER_RGB[w + 2] + (b - WATER_RGB[w + 2]) * show;
    kind = KIND_WATER;
    y += depth;
    above = world.getBlock(x, y, z); // reeds stand in the first air cell above the water
  }
  if (RENDER_KIND[above] === RK.PLANT) {
    r += (COLOR_SIDE[above * 3] - r) * PLANT_MIX;
    g += (COLOR_SIDE[above * 3 + 1] - g) * PLANT_MIX;
    b += (COLOR_SIDE[above * 3 + 2] - b) * PLANT_MIX;
  }
  rgb[0] = r;
  rgb[1] = g;
  rgb[2] = b;
  return kind;
}

/**
 * Brightness factor of pixel (px, pz): 1 on flat ground, brighter on slopes facing the light. The slope
 * is the broad slope (smooth relief, no contour lines from the 10 cm steps) plus the local difference
 * to it where that difference is large (sharp edges of buildings, roofs, rock faces).
 */
function hillshade(heights: Int16Array, px: number, pz: number): number {
  const bx = (pixelHeight(heights, px + BROAD_PX, pz) - pixelHeight(heights, px - BROAD_PX, pz)) * BROAD_K;
  const bz = (pixelHeight(heights, px, pz + BROAD_PX) - pixelHeight(heights, px, pz - BROAD_PX)) * BROAD_K;
  const dx = (pixelHeight(heights, px + 1, pz) - pixelHeight(heights, px - 1, pz)) * LOCAL_K - bx;
  const dz = (pixelHeight(heights, px, pz + 1) - pixelHeight(heights, px, pz - 1)) * LOCAL_K - bz;
  const sx = (bx + dx * detail(dx)) * RELIEF;
  const sz = (bz + dz * detail(dz)) * RELIEF;
  // Surface normal (−sx, 1, −sz) normalised, dotted with the light, relative to flat ground.
  const lit = (-sx * LIGHT_X + LIGHT_Y - sz * LIGHT_Z) / (Math.sqrt(sx * sx + 1 + sz * sz) * LIGHT_Y);
  return lit < SHADE_MIN ? SHADE_MIN : lit > SHADE_MAX ? SHADE_MAX : lit;
}

/** Weight of a local slope difference: smoothstep from DETAIL_FROM to DETAIL_TO of its magnitude. */
function detail(d: number): number {
  const t = ((d < 0 ? -d : d) - DETAIL_FROM) / (DETAIL_TO - DETAIL_FROM);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Sum of the heights of a pixel's columns (pixel coordinates clamped to the map). */
function pixelHeight(heights: Int16Array, px: number, pz: number): number {
  const cx = px < 0 ? 0 : px >= MAP_W ? MAP_W - 1 : px;
  const cz = pz < 0 ? 0 : pz >= MAP_H ? MAP_H - 1 : pz;
  let sum = 0;
  for (let dz = 0; dz < MAP_SCALE; dz++) {
    const row = cx * MAP_SCALE + (cz * MAP_SCALE + dz) * WORLD_X;
    for (let dx = 0; dx < MAP_SCALE; dx++) sum += heights[row + dx];
  }
  return sum;
}
