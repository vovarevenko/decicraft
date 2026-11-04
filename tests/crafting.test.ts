import { describe, expect, test } from 'vitest';
import { canCraft, craft, RECIPES, type Recipe } from '../src/game/crafting';
import { Inventory, PLAYER_INVENTORY_SIZE } from '../src/game/inventory';
import { ITEMS } from '../src/game/items';

/** ARCHITECTURE.md §8, in order: [id, output, output count, inputs, needs campfire]. */
const EXPECTED: [string, string, number, Record<string, number>, boolean][] = [
  ['sticks_from_wood', 'stick', 4, { wood: 2 }, false],
  ['rope', 'rope', 1, { grass_fiber: 6 }, false],
  ['stone_axe', 'stone_axe', 1, { stick: 2, stone: 3, rope: 1 }, false],
  ['campfire', 'campfire', 1, { stick: 6, stone: 8 }, false],
  ['torches', 'torch', 2, { stick: 1, cloth: 1 }, false],
  ['planks', 'planks', 8, { wood: 8 }, false],
  ['meat_cooked', 'meat_cooked', 1, { meat_raw: 1 }, true],
  ['sticks_from_planks', 'stick', 4, { planks: 2 }, false],
];

/** A player inventory holding exactly the recipe's inputs. */
function withInputs(recipe: Recipe): Inventory {
  const inv = new Inventory();
  for (const input of recipe.inputs) expect(inv.add(input.id, input.count)).toBe(0);
  return inv;
}

const contents = (inv: Inventory): (string | null)[] => inv.slots.map((s) => (s ? `${s.id}×${s.count}` : null));

describe('recipe list', () => {
  test('exactly the eight recipes of the spec, with stable ids', () => {
    expect(RECIPES.map((r) => r.id)).toEqual(EXPECTED.map((e) => e[0]));
    RECIPES.forEach((r, i) => {
      const [, out, outCount, inputs, campfire] = EXPECTED[i];
      expect(r.output, r.id).toEqual({ id: out, count: outCount });
      expect(Object.fromEntries(r.inputs.map((x) => [x.id, x.count])), r.id).toEqual(inputs);
      expect(r.needsCampfire === true, r.id).toBe(campfire);
    });
  });

  test('names are Russian, items exist, inputs are unique per recipe', () => {
    const names = RECIPES.map((r) => r.name);
    expect(names).toEqual(['Палки', 'Верёвка', 'Каменный топор', 'Костёр', 'Факел', 'Доски', 'Жареное мясо', 'Палки']);
    for (const r of RECIPES) {
      expect(ITEMS[r.output.id], r.id).toBeDefined();
      for (const input of r.inputs) {
        expect(ITEMS[input.id], `${r.id} needs ${input.id}`).toBeDefined();
        expect(input.count).toBeGreaterThan(0);
      }
      expect(new Set(r.inputs.map((x) => x.id)).size, r.id).toBe(r.inputs.length);
    }
  });
});

describe('canCraft / craft', () => {
  test.each(RECIPES.map((r) => [r.id, r] as const))('%s is craftable from exactly its inputs', (_id, recipe) => {
    const inv = withInputs(recipe);
    expect(canCraft(inv, recipe, true)).toBe(true);
    expect(craft(inv, recipe, true)).toEqual({ ok: true, leftover: 0 });
    for (const input of recipe.inputs) {
      if (input.id !== recipe.output.id) expect(inv.count(input.id), input.id).toBe(0);
    }
    expect(inv.count(recipe.output.id)).toBe(recipe.output.count);
    expect(canCraft(inv, recipe, true)).toBe(false);
  });

  test.each(RECIPES.map((r) => [r.id, r] as const))('%s is not craftable with any input short by one', (_id, recipe) => {
    for (const short of recipe.inputs) {
      const inv = new Inventory();
      for (const input of recipe.inputs) inv.add(input.id, input.id === short.id ? input.count - 1 : input.count);
      const before = contents(inv);
      expect(canCraft(inv, recipe, true), short.id).toBe(false);
      expect(craft(inv, recipe, true)).toEqual({ ok: false, leftover: 0 });
      expect(contents(inv), 'nothing is consumed when crafting fails').toEqual(before);
    }
    expect(canCraft(new Inventory(), recipe, true)).toBe(false);
  });

  test('cooking needs a campfire nearby; nothing else does', () => {
    const meat = RECIPES.find((r) => r.id === 'meat_cooked')!;
    const inv = withInputs(meat);
    expect(canCraft(inv, meat, false)).toBe(false);
    expect(craft(inv, meat, false)).toEqual({ ok: false, leftover: 0 });
    expect(inv.count('meat_raw')).toBe(1);
    expect(craft(inv, meat, true)).toEqual({ ok: true, leftover: 0 });
    expect(inv.count('meat_cooked')).toBe(1);

    for (const r of RECIPES) {
      if (r !== meat) expect(canCraft(withInputs(r), r, false), r.id).toBe(true);
    }
  });

  test('extra materials stay; repeated crafting consumes inputs each time', () => {
    const sticks = RECIPES.find((r) => r.id === 'sticks_from_wood')!;
    const inv = new Inventory();
    inv.add('wood', 7);
    for (let i = 0; i < 3; i++) expect(craft(inv, sticks, false).ok).toBe(true);
    expect(craft(inv, sticks, false).ok).toBe(false);
    expect(inv.count('wood')).toBe(1);
    expect(inv.count('stick')).toBe(12);
  });

  test('crafts even when the output does not fit and reports the leftover', () => {
    const sticks = RECIPES.find((r) => r.id === 'sticks_from_wood')!;
    const inv = new Inventory();
    for (let i = 0; i < PLAYER_INVENTORY_SIZE - 1; i++) inv.setSlot(i, { id: 'axe', count: 1 });
    inv.setSlot(PLAYER_INVENTORY_SIZE - 1, { id: 'wood', count: 10 });
    expect(craft(inv, sticks, false)).toEqual({ ok: true, leftover: 4 });
    expect(inv.count('wood')).toBe(8);
    expect(inv.count('stick')).toBe(0);
  });

  test('output goes into the slot freed by the consumed inputs', () => {
    const torches = RECIPES.find((r) => r.id === 'torches')!;
    const inv = new Inventory();
    for (let i = 0; i < PLAYER_INVENTORY_SIZE; i++) inv.setSlot(i, { id: 'axe', count: 1 });
    inv.setSlot(4, { id: 'stick', count: 1 });
    inv.setSlot(9, { id: 'cloth', count: 1 });
    expect(craft(inv, torches, false)).toEqual({ ok: true, leftover: 0 });
    expect(inv.slots[4]).toEqual({ id: 'torch', count: 2 });
    expect(inv.slots[9]).toBeNull();
  });

  test('partial fit: the rest of the output is the leftover', () => {
    const planks = RECIPES.find((r) => r.id === 'planks')!;
    const inv = new Inventory();
    for (let i = 0; i < PLAYER_INVENTORY_SIZE; i++) inv.setSlot(i, { id: 'axe', count: 1 });
    inv.setSlot(0, { id: 'planks', count: 995 });
    inv.setSlot(1, { id: 'wood', count: 20 });
    expect(craft(inv, planks, false)).toEqual({ ok: true, leftover: 3 });
    expect(inv.slots[0]).toEqual({ id: 'planks', count: 1000 });
    expect(inv.count('wood')).toBe(12);
  });
});
