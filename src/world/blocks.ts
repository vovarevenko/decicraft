/**
 * Block (10 cm voxel) registry. Pure data — importable from workers.
 *
 * Every voxel stores one block id (Uint8). Colours are sRGB hex; the renderer converts to linear.
 * Hot paths (mesher, physics, generation) must use the flat lookup tables at the bottom of this
 * file (SOLID, OPAQUE, RENDER_KIND, …) instead of `BLOCKS[id]` objects.
 */

/** How a block is rendered. */
export const RK = {
  /** Not rendered (air). */
  NONE: 0,
  /** Opaque cube faces (greedy meshed, AO, per-voxel colour variation, procedural pattern). */
  CUBE: 1,
  /** Transparent cube faces (glass): own transparent mesh, faces between two glass voxels culled. */
  GLASS: 2,
  /** Water: own transparent animated mesh; faces only against air/non-water non-opaque cells. */
  WATER: 3,
  /** Plant: two crossed alpha-tested quads (LOD 0 only), not solid, no AO influence. */
  PLANT: 4,
} as const;

/** Preferred tool class (see ARCHITECTURE.md › Breaking model). NONE = any/hand works at full speed. */
export const TOOL = { NONE: 0, SHOVEL: 1, PICKAXE: 2, AXE: 3 } as const;

/** Structural support role (see world/structure.ts). */
export const SUP = {
  /** Does not carry support (air, water, plants). */
  NONE: 0,
  /** Natural ground & ground-level infrastructure: always supported (stone, dirt, asphalt…). */
  ANCHOR: 1,
  /** Must connect to an ANCHOR through solid STRUCT/ANCHOR voxels, otherwise it falls (logs, bricks…). */
  STRUCT: 2,
  /**
   * Foliage (leaves, needles, bushes): never carries support. It falls together with the STRUCT piece
   * it hangs on (reachable through foliage), and foliage-only clumps never fall.
   */
  LEAF: 3,
} as const;

/**
 * Procedural surface patterns, evaluated in the fragment shader in world space (sub-voxel detail).
 * Renderers may fall back to NONE for patterns they do not implement.
 */
export const PAT = {
  NONE: 0,
  SOIL: 1, // fine grain speckles (dirt, sand, clay, mud)
  GRASS: 2, // top: blade speckles; sides: grass blades over the upper ~70 %, soil showing in the lower ~30 %
  STONE: 3, // blotches and thin cracks
  GRAVEL: 4, // pebbles (cellular dots)
  BARK: 5, // vertical furrows
  BIRCH: 6, // white bark with short horizontal dark dashes
  WOOD: 7, // end grain rings on ±Y faces, long grain on sides
  LEAVES: 8, // leafy dither with dark gaps
  BRICK: 9, // running bond, ~25×6.5 cm bricks with 1 cm mortar (world space, so it spans voxels)
  PLANKS: 10, // boards one voxel wide with seams + grain
  TILES: 11, // square tiles with grout lines on voxel edges
  ASPHALT: 12, // dark speckled aggregate, occasional cracks
  CORRUGATED: 13, // sine ridges (slate, roof metal)
  PAVING: 14, // 20×10 cm pavers
  PLASTER: 15, // soft stains, hairline cracks
  WALLPAPER: 16, // faded vertical stripes
  FABRIC: 17, // weave
  METAL: 18, // rust blotches
  ROOF_TILES: 19, // overlapping scallop rows
} as const;

export type SoundMaterial =
  | 'none'
  | 'dirt'
  | 'grass'
  | 'sand'
  | 'gravel'
  | 'stone'
  | 'wood'
  | 'leaves'
  | 'glass'
  | 'metal'
  | 'plant'
  | 'fabric'
  | 'water';

export interface BlockDef {
  id: number;
  /** Stable identifier (snake_case). */
  key: string;
  /** Russian display name. */
  name: string;
  /** sRGB 0xRRGGBB for side faces (and all faces unless overridden). */
  color: number;
  /** +Y face colour override. */
  top?: number;
  /** -Y face colour override. */
  bottom?: number;
  /** Per-voxel brightness variation amplitude (0..0.5). */
  vary: number;
  pattern: number;
  render: number;
  /** Collides with bodies. Foliage is NOT solid: the player and mobs push through leaves and bushes. */
  solid: boolean;
  /** Hides neighbour faces and darkens AO. */
  opaque: boolean;
  /** Seconds to break one voxel with bare hands (Infinity = unbreakable). */
  hardness: number;
  /** Preferred tool class (TOOL.*). */
  tool: number;
  support: number;
  /** Item id added to the inventory per broken voxel (null = destroyed, e.g. glass). */
  drop: string | null;
  sound: SoundMaterial;
  /** PLANT only: visual height of the crossed quads in voxels (may exceed 1). */
  plantHeight?: number;
}

/** Block ids. Keep in sync with the table below; ids are stored in world data (Uint8). */
export const B = {
  AIR: 0,
  BEDROCK: 1,
  STONE: 2,
  GRANITE: 3,
  DIRT: 4,
  GRASS: 5,
  SAND: 6,
  GRAVEL: 7,
  CLAY: 8,
  MUD: 9,
  MOSS: 10,
  LITTER: 11,
  WATER: 12,
  OAK_LOG: 13,
  BIRCH_LOG: 14,
  PINE_LOG: 15,
  WOOD: 16,
  OAK_LEAVES: 17,
  BIRCH_LEAVES: 18,
  PINE_NEEDLES: 19,
  BUSH: 20,
  TALL_GRASS: 21,
  FLOWER_YELLOW: 22,
  FLOWER_WHITE: 23,
  FLOWER_BLUE: 24,
  FERN: 25,
  REEDS: 26,
  MUSHROOM: 27,
  DRY_GRASS: 28,
  ASPHALT: 30,
  CONCRETE: 31,
  BRICK: 32,
  BRICK_WHITE: 33,
  PLASTER: 34,
  PLASTER_BLUE: 35,
  PLASTER_GREEN: 36,
  PLANKS: 37,
  DARK_WOOD: 38,
  PAINTED_WOOD: 39,
  ROOF_TILES: 40,
  ROOF_METAL: 41,
  SLATE: 42,
  GLASS: 43,
  METAL: 44,
  PAINTED_METAL: 45,
  RUBBER: 46,
  PAVING: 47,
  CURB: 48,
  RUBBLE: 49,
  TILES: 50,
  WALLPAPER: 51,
  LINOLEUM: 52,
  FABRIC: 53,
} as const;

export type BlockId = number;

type Def = Omit<BlockDef, 'id'>;

const cube = (
  key: string,
  name: string,
  color: number,
  pattern: number,
  hardness: number,
  tool: number,
  support: number,
  drop: string | null,
  sound: SoundMaterial,
  extra: Partial<Def> = {},
): Def => ({
  key,
  name,
  color,
  vary: 0.08,
  pattern,
  render: RK.CUBE,
  solid: true,
  opaque: true,
  hardness,
  tool,
  support,
  drop,
  sound,
  ...extra,
});

/** Leaves/needles/bush: opaque cubes that bodies pass through and that never carry structural support. */
const foliage = (key: string, name: string, color: number, vary: number): Def => ({
  key,
  name,
  color,
  vary,
  pattern: PAT.LEAVES,
  render: RK.CUBE,
  solid: false,
  opaque: true,
  hardness: 0.1,
  tool: TOOL.AXE,
  support: SUP.LEAF,
  drop: 'leaves',
  sound: 'leaves',
});

const plant = (key: string, name: string, color: number, drop: string | null, plantHeight: number): Def => ({
  key,
  name,
  color,
  vary: 0.15,
  pattern: PAT.NONE,
  render: RK.PLANT,
  solid: false,
  opaque: false,
  hardness: 0,
  tool: TOOL.NONE,
  support: SUP.NONE,
  drop,
  sound: 'plant',
  plantHeight,
});

const { NONE: T_NONE, SHOVEL, PICKAXE, AXE } = TOOL;
const { ANCHOR, STRUCT } = SUP;

const DEFS: Record<number, Def> = {
  [B.AIR]: {
    key: 'air', name: 'Воздух', color: 0x000000, vary: 0, pattern: PAT.NONE, render: RK.NONE,
    solid: false, opaque: false, hardness: Infinity, tool: T_NONE, support: SUP.NONE, drop: null, sound: 'none',
  },
  [B.BEDROCK]: cube('bedrock', 'Коренная порода', 0x3a3a3c, PAT.STONE, Infinity, PICKAXE, ANCHOR, null, 'stone', { vary: 0.1 }),
  [B.STONE]: cube('stone', 'Камень', 0x7e7c78, PAT.STONE, 2.0, PICKAXE, ANCHOR, 'stone', 'stone', { vary: 0.1 }),
  [B.GRANITE]: cube('granite', 'Гранит', 0x9a8580, PAT.STONE, 2.6, PICKAXE, ANCHOR, 'stone', 'stone', { vary: 0.12 }),
  [B.DIRT]: cube('dirt', 'Земля', 0x6b4c33, PAT.SOIL, 0.25, SHOVEL, ANCHOR, 'dirt', 'dirt', { vary: 0.1 }),
  [B.GRASS]: cube('grass', 'Дёрн', 0x587a38, PAT.GRASS, 0.3, SHOVEL, ANCHOR, 'sod', 'grass', {
    top: 0x5d8a3a, bottom: 0x6b4c33, vary: 0.14,
  }),
  [B.SAND]: cube('sand', 'Песок', 0xcbb88f, PAT.SOIL, 0.2, SHOVEL, ANCHOR, 'sand', 'sand', { vary: 0.06 }),
  [B.GRAVEL]: cube('gravel', 'Гравий', 0x8b8682, PAT.GRAVEL, 0.35, SHOVEL, ANCHOR, 'gravel', 'gravel', { vary: 0.18 }),
  [B.CLAY]: cube('clay', 'Глина', 0xa07b5e, PAT.SOIL, 0.4, SHOVEL, ANCHOR, 'clay', 'dirt', { vary: 0.06 }),
  [B.MUD]: cube('mud', 'Ил', 0x3f342a, PAT.SOIL, 0.3, SHOVEL, ANCHOR, 'mud', 'dirt', { vary: 0.08 }),
  [B.MOSS]: cube('moss', 'Мох', 0x52702f, PAT.GRASS, 0.2, SHOVEL, ANCHOR, 'moss', 'grass', { vary: 0.15 }),
  [B.LITTER]: cube('litter', 'Лесная подстилка', 0x4f3c28, PAT.SOIL, 0.2, SHOVEL, ANCHOR, 'dirt', 'grass', {
    top: 0x5b4a30, vary: 0.16,
  }),
  [B.WATER]: {
    key: 'water', name: 'Вода', color: 0x2f5f6a, vary: 0, pattern: PAT.NONE, render: RK.WATER,
    solid: false, opaque: false, hardness: Infinity, tool: T_NONE, support: SUP.NONE, drop: null, sound: 'water',
  },
  [B.OAK_LOG]: cube('oak_log', 'Дуб', 0x5f5244, PAT.BARK, 1.2, AXE, STRUCT, 'wood', 'wood', { vary: 0.1 }),
  [B.BIRCH_LOG]: cube('birch_log', 'Берёза', 0xd9d4c7, PAT.BIRCH, 1.0, AXE, STRUCT, 'wood', 'wood', { vary: 0.05 }),
  [B.PINE_LOG]: cube('pine_log', 'Сосна', 0x7a4f35, PAT.BARK, 1.1, AXE, STRUCT, 'wood', 'wood', { vary: 0.1 }),
  [B.WOOD]: cube('wood', 'Древесина', 0xb8925e, PAT.WOOD, 1.0, AXE, STRUCT, 'wood', 'wood', { vary: 0.05 }),
  [B.OAK_LEAVES]: foliage('oak_leaves', 'Листва дуба', 0x3d6526, 0.2),
  [B.BIRCH_LEAVES]: foliage('birch_leaves', 'Листва берёзы', 0x6b9a35, 0.2),
  [B.PINE_NEEDLES]: foliage('pine_needles', 'Хвоя', 0x2c4a2a, 0.15),
  [B.BUSH]: foliage('bush', 'Кустарник', 0x4a6e2c, 0.2),
  [B.TALL_GRASS]: plant('tall_grass', 'Высокая трава', 0x6a9a3c, 'grass_fiber', 3),
  [B.FLOWER_YELLOW]: plant('flower_yellow', 'Лютик', 0xe8c832, 'flower', 3),
  [B.FLOWER_WHITE]: plant('flower_white', 'Ромашка', 0xf2f0e6, 'flower', 3),
  [B.FLOWER_BLUE]: plant('flower_blue', 'Василёк', 0x4a6fd0, 'flower', 3),
  [B.FERN]: plant('fern', 'Папоротник', 0x3f6e2a, 'grass_fiber', 4),
  [B.REEDS]: plant('reeds', 'Камыш', 0x7a8a45, 'reed', 12),
  [B.MUSHROOM]: plant('mushroom', 'Гриб', 0x9a6a3a, 'mushroom', 1),
  [B.DRY_GRASS]: plant('dry_grass', 'Сухая трава', 0xa89a5a, 'grass_fiber', 3),
  [B.ASPHALT]: cube('asphalt', 'Асфальт', 0x3b3b3d, PAT.ASPHALT, 2.0, PICKAXE, ANCHOR, 'asphalt', 'stone', { vary: 0.06 }),
  [B.CONCRETE]: cube('concrete', 'Бетон', 0x9b9890, PAT.PLASTER, 2.5, PICKAXE, STRUCT, 'concrete', 'stone', { vary: 0.05 }),
  [B.BRICK]: cube('brick', 'Кирпич', 0x8e3f2c, PAT.BRICK, 1.8, PICKAXE, STRUCT, 'brick', 'stone', { vary: 0.1 }),
  [B.BRICK_WHITE]: cube('brick_white', 'Силикатный кирпич', 0xd2ccbf, PAT.BRICK, 1.8, PICKAXE, STRUCT, 'brick_white', 'stone', { vary: 0.06 }),
  [B.PLASTER]: cube('plaster', 'Штукатурка', 0xcdb994, PAT.PLASTER, 1.2, PICKAXE, STRUCT, 'plaster', 'stone', { vary: 0.05 }),
  [B.PLASTER_BLUE]: cube('plaster_blue', 'Голубая штукатурка', 0x8ea5b1, PAT.PLASTER, 1.2, PICKAXE, STRUCT, 'plaster', 'stone', { vary: 0.05 }),
  [B.PLASTER_GREEN]: cube('plaster_green', 'Зелёная штукатурка', 0x9fb08a, PAT.PLASTER, 1.2, PICKAXE, STRUCT, 'plaster', 'stone', { vary: 0.05 }),
  [B.PLANKS]: cube('planks', 'Доски', 0x9a7350, PAT.PLANKS, 0.8, AXE, STRUCT, 'planks', 'wood', { vary: 0.08 }),
  [B.DARK_WOOD]: cube('dark_wood', 'Тёмное дерево', 0x5b3e2a, PAT.PLANKS, 0.9, AXE, STRUCT, 'planks', 'wood', { vary: 0.06 }),
  [B.PAINTED_WOOD]: cube('painted_wood', 'Крашеное дерево', 0xd8d4c8, PAT.PLANKS, 0.8, AXE, STRUCT, 'planks', 'wood', { vary: 0.06 }),
  [B.ROOF_TILES]: cube('roof_tiles', 'Черепица', 0x8a4430, PAT.ROOF_TILES, 1.0, PICKAXE, STRUCT, 'roof_tiles', 'stone', { vary: 0.1 }),
  [B.ROOF_METAL]: cube('roof_metal', 'Кровельное железо', 0x7d5a44, PAT.CORRUGATED, 1.5, PICKAXE, STRUCT, 'metal', 'metal', { vary: 0.14 }),
  [B.SLATE]: cube('slate', 'Шифер', 0x9c9c95, PAT.CORRUGATED, 1.0, PICKAXE, STRUCT, 'slate', 'stone', { vary: 0.08 }),
  [B.GLASS]: {
    key: 'glass', name: 'Стекло', color: 0xa8c8d0, vary: 0, pattern: PAT.NONE, render: RK.GLASS,
    solid: true, opaque: false, hardness: 0.1, tool: T_NONE, support: STRUCT, drop: null, sound: 'glass',
  },
  [B.METAL]: cube('metal', 'Ржавый металл', 0x6e5040, PAT.METAL, 3.0, PICKAXE, STRUCT, 'metal', 'metal', { vary: 0.12 }),
  [B.PAINTED_METAL]: cube('painted_metal', 'Крашеный металл', 0x4d6a82, PAT.METAL, 3.0, PICKAXE, STRUCT, 'metal', 'metal', { vary: 0.08 }),
  [B.RUBBER]: cube('rubber', 'Резина', 0x232323, PAT.NONE, 0.8, AXE, STRUCT, null, 'fabric', { vary: 0.04 }),
  [B.PAVING]: cube('paving', 'Тротуарная плитка', 0x8e8983, PAT.PAVING, 1.6, PICKAXE, ANCHOR, 'paving', 'stone', { vary: 0.08 }),
  [B.CURB]: cube('curb', 'Бордюр', 0xa9a59c, PAT.NONE, 2.0, PICKAXE, ANCHOR, 'concrete', 'stone', { vary: 0.05 }),
  [B.RUBBLE]: cube('rubble', 'Обломки', 0x7d6e64, PAT.GRAVEL, 0.5, SHOVEL, ANCHOR, 'rubble', 'gravel', { vary: 0.2 }),
  [B.TILES]: cube('tiles', 'Кафель', 0xd5d9d4, PAT.TILES, 1.0, PICKAXE, STRUCT, 'tiles', 'stone', { vary: 0.04 }),
  [B.WALLPAPER]: cube('wallpaper', 'Обои', 0xb9a57c, PAT.WALLPAPER, 0.8, PICKAXE, STRUCT, 'plaster', 'fabric', { vary: 0.05 }),
  [B.LINOLEUM]: cube('linoleum', 'Линолеум', 0x8a6e4e, PAT.TILES, 0.6, AXE, STRUCT, null, 'fabric', { vary: 0.04 }),
  [B.FABRIC]: cube('fabric', 'Ткань', 0x7a4a4a, PAT.FABRIC, 0.4, T_NONE, STRUCT, 'cloth', 'fabric', { vary: 0.08 }),
};

/** Block definitions indexed by id (unused ids map to an "unknown" air-like def). */
export const BLOCKS: readonly BlockDef[] = (() => {
  const out: BlockDef[] = [];
  for (let id = 0; id < 256; id++) {
    const d = DEFS[id];
    out.push(d ? { id, ...d } : { id, ...DEFS[B.AIR], key: `unknown_${id}`, name: '???' });
  }
  return out;
})();

// ---------------------------------------------------------------- flat lookup tables (hot paths)
export const SOLID = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256);
export const RENDER_KIND = new Uint8Array(256);
export const PATTERN = new Uint8Array(256);
/** vary * 255 */
export const VARY = new Uint8Array(256);
export const TOOL_CLASS = new Uint8Array(256);
export const SUPPORT = new Uint8Array(256);
export const HARDNESS = new Float32Array(256);
export const PLANT_HEIGHT = new Uint8Array(256);
/** 1 for foliage blocks (SUP.LEAF). */
export const FOLIAGE = new Uint8Array(256);
/**
 * OPAQUE minus foliage and tree bark — what the `sky` (roof) height map tracks. Crowns (leaves and the bark
 * of trunks and branches) are tracked by the `canopy` map only, so they shade the forest instead of roofing it.
 */
export const SKY_OPAQUE = new Uint8Array(256);
/** sRGB bytes, 3 per id. */
export const COLOR_SIDE = new Uint8Array(256 * 3);
export const COLOR_TOP = new Uint8Array(256 * 3);
export const COLOR_BOTTOM = new Uint8Array(256 * 3);

/** Bark of natural trunks and branches. WOOD (trunk cores, and what players build with) still roofs. */
const TREE_BARK: readonly number[] = [B.OAK_LOG, B.BIRCH_LOG, B.PINE_LOG];

for (const d of BLOCKS) {
  const i = d.id;
  SOLID[i] = d.solid ? 1 : 0;
  OPAQUE[i] = d.opaque ? 1 : 0;
  RENDER_KIND[i] = d.render;
  PATTERN[i] = d.pattern;
  VARY[i] = Math.round(Math.min(1, d.vary) * 255);
  TOOL_CLASS[i] = d.tool;
  SUPPORT[i] = d.support;
  HARDNESS[i] = d.hardness;
  PLANT_HEIGHT[i] = d.plantHeight ?? 0;
  FOLIAGE[i] = d.support === SUP.LEAF ? 1 : 0;
  SKY_OPAQUE[i] = d.opaque && d.support !== SUP.LEAF && !TREE_BARK.includes(i) ? 1 : 0;
  const put = (arr: Uint8Array, hex: number) => {
    arr[i * 3] = (hex >> 16) & 255;
    arr[i * 3 + 1] = (hex >> 8) & 255;
    arr[i * 3 + 2] = hex & 255;
  };
  put(COLOR_SIDE, d.color);
  put(COLOR_TOP, d.top ?? d.color);
  put(COLOR_BOTTOM, d.bottom ?? d.color);
}

export const isSolid = (id: number): boolean => SOLID[id] === 1;
export const isOpaque = (id: number): boolean => OPAQUE[id] === 1;
export const isPlant = (id: number): boolean => RENDER_KIND[id] === RK.PLANT;
export const isWater = (id: number): boolean => id === B.WATER;
export const isFoliage = (id: number): boolean => FOLIAGE[id] === 1;
/** Air, plants and water — cells that placement may overwrite. */
export const isReplaceable = (id: number): boolean => id === B.AIR || RENDER_KIND[id] === RK.PLANT || id === B.WATER;
export const blockName = (id: number): string => BLOCKS[id].name;
