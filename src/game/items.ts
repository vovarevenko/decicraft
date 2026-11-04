/**
 * Item registry (pure data). Item ids are referenced by generation (loot), crafting, models and UI.
 *
 * Materials are counted in voxels: 1 item = 1 voxel = 1 dm³ (shown with unit «дм³»).
 */
import { B, TOOL } from '../world/blocks';

export type ItemKind = 'material' | 'tool' | 'food' | 'light' | 'placeable' | 'resource' | 'note';
export type ToolType = 'hand' | 'axe' | 'shovel' | 'pickaxe';

/** Breaking/attack parameters (see ARCHITECTURE.md › Breaking model). */
export interface ToolStats {
  type: ToolType;
  /** TOOL.* class this tool is good at (TOOL.NONE for the hand). */
  toolClass: number;
  /** Hardness removed per swing from a voxel of the matching class (hand-seconds). */
  power: number;
  /** Brush radius (voxels) used on the matching class. 0 = single voxel. */
  radius: number;
  /** Seconds per swing. */
  swingTime: number;
  /** Damage dealt to mobs per hit. */
  damage: number;
}

export interface ItemDef {
  id: string;
  /** Russian display name. */
  name: string;
  kind: ItemKind;
  maxStack: number;
  /** Russian one-line description (tooltip). */
  description: string;
  unit: 'дм³' | 'шт.';
  /** material: block id placed by this item. */
  block?: number;
  tool?: ToolStats;
  food?: { message: string; dogLikes: boolean };
  light?: { kind: 'flashlight' | 'torch' };
  placeEntity?: 'campfire';
  note?: { title: string; text: string };
}

/** Bare hands. */
export const HAND: ToolStats = { type: 'hand', toolClass: TOOL.NONE, power: 0.25, radius: 0, swingTime: 0.28, damage: 1 };

const material = (id: string, name: string, block: number, description: string): ItemDef => ({
  id,
  name,
  kind: 'material',
  maxStack: 1000,
  description,
  unit: 'дм³',
  block,
});

const resource = (id: string, name: string, maxStack: number, description: string): ItemDef => ({
  id,
  name,
  kind: 'resource',
  maxStack,
  description,
  unit: 'шт.',
});

const food = (id: string, name: string, description: string, message: string, dogLikes: boolean): ItemDef => ({
  id,
  name,
  kind: 'food',
  maxStack: 20,
  description,
  unit: 'шт.',
  food: { message, dogLikes },
});

const tool = (id: string, name: string, description: string, stats: Omit<ToolStats, 'toolClass'>): ItemDef => ({
  id,
  name,
  kind: 'tool',
  maxStack: 1,
  description,
  unit: 'шт.',
  tool: {
    ...stats,
    toolClass: stats.type === 'axe' ? TOOL.AXE : stats.type === 'shovel' ? TOOL.SHOVEL : stats.type === 'pickaxe' ? TOOL.PICKAXE : TOOL.NONE,
  },
});

const LIST: ItemDef[] = [
  // ---- materials (placeable voxels)
  material('dirt', 'Земля', B.DIRT, 'Обычный грунт. Копается лопатой.'),
  material('sod', 'Дёрн', B.GRASS, 'Верхний слой земли с травой.'),
  material('sand', 'Песок', B.SAND, 'Сыпучий речной песок.'),
  material('gravel', 'Гравий', B.GRAVEL, 'Мелкие камни.'),
  material('clay', 'Глина', B.CLAY, 'Вязкая рыжая глина.'),
  material('mud', 'Ил', B.MUD, 'Тёмный донный ил.'),
  material('moss', 'Мох', B.MOSS, 'Мягкий мох с камней.'),
  material('stone', 'Камень', B.STONE, 'Обломки горной породы. Нужна кирка.'),
  material('wood', 'Древесина', B.WOOD, 'Брёвна и щепа. Рубится топором.'),
  material('leaves', 'Листва', B.BUSH, 'Охапка веток с листьями (сквозь листву можно пройти).'),
  material('planks', 'Доски', B.PLANKS, 'Струганые доски — хороший стройматериал.'),
  material('asphalt', 'Асфальт', B.ASPHALT, 'Куски старого асфальта.'),
  material('concrete', 'Бетон', B.CONCRETE, 'Обломки бетона.'),
  material('brick', 'Кирпич', B.BRICK, 'Красный кирпич.'),
  material('brick_white', 'Силикатный кирпич', B.BRICK_WHITE, 'Белый силикатный кирпич.'),
  material('plaster', 'Штукатурка', B.PLASTER, 'Куски стены со штукатуркой.'),
  material('roof_tiles', 'Черепица', B.ROOF_TILES, 'Глиняная черепица.'),
  material('slate', 'Шифер', B.SLATE, 'Волнистый серый шифер.'),
  material('metal', 'Металлолом', B.METAL, 'Ржавое железо.'),
  material('paving', 'Тротуарная плитка', B.PAVING, 'Бетонная плитка.'),
  material('rubble', 'Обломки', B.RUBBLE, 'Строительный мусор.'),
  material('tiles', 'Кафель', B.TILES, 'Белая кафельная плитка.'),

  // ---- natural resources & crafting parts
  resource('grass_fiber', 'Трава', 100, 'Пучок травы. Из неё можно свить верёвку.'),
  resource('flower', 'Цветок', 50, 'Полевой цветок.'),
  resource('reed', 'Камыш', 100, 'Стебли камыша.'),
  resource('stick', 'Палка', 100, 'Ровная палка.'),
  resource('rope', 'Верёвка', 50, 'Верёвка, свитая из травы.'),
  resource('cloth', 'Тряпка', 50, 'Кусок старой ткани.'),
  resource('hide', 'Шкура', 20, 'Шкура косули.'),

  // ---- tools
  tool('stone_axe', 'Каменный топор', 'Самодельный топор: рубит дерево, но медленно.', {
    type: 'axe', power: 0.8, radius: 1.2, swingTime: 0.6, damage: 3,
  }),
  tool('axe', 'Топор', 'Старый плотницкий топор. Быстро рубит дерево.', {
    type: 'axe', power: 1.3, radius: 1.6, swingTime: 0.55, damage: 4,
  }),
  tool('shovel', 'Лопата', 'Штыковая лопата: копает землю, песок, гравий.', {
    type: 'shovel', power: 1.0, radius: 2.0, swingTime: 0.5, damage: 3,
  }),
  tool('pickaxe', 'Кирка', 'Кирка: колет камень, кирпич, бетон и асфальт.', {
    type: 'pickaxe', power: 1.2, radius: 1.5, swingTime: 0.6, damage: 3,
  }),

  // ---- lights
  { id: 'flashlight', name: 'Фонарик', kind: 'light', maxStack: 1, unit: 'шт.', description: 'Карманный фонарик. ПКМ — включить/выключить.', light: { kind: 'flashlight' } },
  { id: 'torch', name: 'Факел', kind: 'light', maxStack: 20, unit: 'шт.', description: 'Горит, пока в руке.', light: { kind: 'torch' } },

  // ---- placeables
  { id: 'campfire', name: 'Костёр', kind: 'placeable', maxStack: 5, unit: 'шт.', description: 'Поставьте на землю (ПКМ). Рядом можно жарить мясо.', placeEntity: 'campfire' },

  // ---- food
  food('apple', 'Яблоко', 'Кислое яблоко из заброшенного сада.', 'Кисло, но вкусно.', false),
  food('canned_food', 'Консервы', 'Банка тушёнки. Срок годности давно истёк.', 'Тушёнка… ещё съедобна.', true),
  food('meat_raw', 'Сырое мясо', 'Лучше пожарить на костре.', 'Сырое мясо — так себе идея.', true),
  food('meat_cooked', 'Жареное мясо', 'Горячее и ароматное.', 'Очень сытно!', true),
  food('mushroom', 'Гриб', 'Лесной гриб. Кажется, съедобный.', 'Грибной вкус.', false),

  // ---- notes (lore)
  {
    id: 'newspaper', name: 'Старая газета', kind: 'note', maxStack: 10, unit: 'шт.',
    description: 'Пожелтевшая газета. ПКМ — прочитать.',
    note: {
      title: '«Заречный вестник», 14 мая 1998 г.',
      text:
        'Комбинат окончательно закрывается. Администрация обещает переселить жителей в райцентр до осени. ' +
        'Автобус будет ходить по вторникам и пятницам. Просьба не оставлять животных без присмотра.',
    },
  },
];

export const ITEMS: Readonly<Record<string, ItemDef>> = Object.fromEntries(LIST.map((d) => [d.id, d]));
export const ITEM_LIST: readonly ItemDef[] = LIST;

export function getItem(id: string): ItemDef {
  const d = ITEMS[id];
  if (!d) throw new Error(`Unknown item: ${id}`);
  return d;
}

/** Item id of the material that places `blockId`, if any. */
export function materialForBlock(blockId: number): string | null {
  for (const d of LIST) if (d.block === blockId) return d.id;
  return null;
}
