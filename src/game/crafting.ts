/**
 * Recipes (no grid — pick a recipe from a list). OWNER: agent "items-ui".
 * See ARCHITECTURE.md › Crafting for the required recipe list; recipe ids are stable.
 *
 * Crafting is atomic: inputs are consumed only when every one of them is present (and the campfire
 * requirement is met). The output is then always added; whatever does not fit is reported as
 * `leftover` so the caller can drop it into the world.
 */
import type { Inventory } from './inventory';

export interface Recipe {
  id: string;
  /** Russian display name of the result. */
  name: string;
  inputs: { id: string; count: number }[];
  output: { id: string; count: number };
  /** Requires a burning campfire within GAMEPLAY.campfireRadius of the player. */
  needsCampfire?: boolean;
}

export const RECIPES: readonly Recipe[] = [
  { id: 'sticks_from_wood', name: 'Палки', inputs: [{ id: 'wood', count: 2 }], output: { id: 'stick', count: 4 } },
  { id: 'rope', name: 'Верёвка', inputs: [{ id: 'grass_fiber', count: 6 }], output: { id: 'rope', count: 1 } },
  {
    id: 'stone_axe',
    name: 'Каменный топор',
    inputs: [
      { id: 'stick', count: 2 },
      { id: 'stone', count: 3 },
      { id: 'rope', count: 1 },
    ],
    output: { id: 'stone_axe', count: 1 },
  },
  {
    id: 'campfire',
    name: 'Костёр',
    inputs: [
      { id: 'stick', count: 6 },
      { id: 'stone', count: 8 },
    ],
    output: { id: 'campfire', count: 1 },
  },
  {
    id: 'torches',
    name: 'Факел',
    inputs: [
      { id: 'stick', count: 1 },
      { id: 'cloth', count: 1 },
    ],
    output: { id: 'torch', count: 2 },
  },
  { id: 'planks', name: 'Доски', inputs: [{ id: 'wood', count: 8 }], output: { id: 'planks', count: 8 } },
  {
    id: 'meat_cooked',
    name: 'Жареное мясо',
    inputs: [{ id: 'meat_raw', count: 1 }],
    output: { id: 'meat_cooked', count: 1 },
    needsCampfire: true,
  },
  { id: 'sticks_from_planks', name: 'Палки', inputs: [{ id: 'planks', count: 2 }], output: { id: 'stick', count: 4 } },
];

export function canCraft(inv: Inventory, recipe: Recipe, nearCampfire: boolean): boolean {
  if (recipe.needsCampfire && !nearCampfire) return false;
  for (const input of recipe.inputs) {
    if (!inv.has(input.id, input.count)) return false;
  }
  return true;
}

/** Consumes inputs and adds the output (leftover output that does not fit is returned as a count). Returns false if not craftable. */
export function craft(inv: Inventory, recipe: Recipe, nearCampfire: boolean): { ok: boolean; leftover: number } {
  if (!canCraft(inv, recipe, nearCampfire)) return { ok: false, leftover: 0 };
  for (const input of recipe.inputs) inv.remove(input.id, input.count);
  return { ok: true, leftover: inv.add(recipe.output.id, recipe.output.count) };
}
