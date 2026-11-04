import { describe, expect, test, vi } from 'vitest';
import { HOTBAR_SIZE, Inventory, PLAYER_INVENTORY_SIZE } from '../src/game/inventory';
import { ITEMS } from '../src/game/items';

/** Snapshot of the occupied slots as `index:id×count` for readable assertions. */
const layout = (inv: Inventory): string[] =>
  inv.slots.flatMap((s, i) => (s === null ? [] : [`${i}:${s.id}×${s.count}`]));

describe('Inventory.add', () => {
  test('fills empty slots in order (hotbar first) and respects maxStack', () => {
    const inv = new Inventory();
    expect(inv.slots).toHaveLength(PLAYER_INVENTORY_SIZE);
    expect(ITEMS.dirt.maxStack).toBe(1000);
    expect(inv.add('dirt', 2500)).toBe(0);
    expect(layout(inv)).toEqual(['0:dirt×1000', '1:dirt×1000', '2:dirt×500']);
  });

  test('merges into existing stacks (hotbar before backpack) before using empty slots', () => {
    const inv = new Inventory();
    inv.setSlot(12, { id: 'stick', count: 50 });
    inv.setSlot(3, { id: 'stick', count: 95 });
    expect(inv.add('stick', 20)).toBe(0);
    expect(layout(inv)).toEqual(['3:stick×100', '12:stick×65']);
    // existing stacks are topped up completely before a new stack is started (in the first empty slot)
    expect(inv.add('stick', 60)).toBe(0);
    expect(layout(inv)).toEqual(['0:stick×25', '3:stick×100', '12:stick×100']);
  });

  test('tools do not stack', () => {
    const inv = new Inventory();
    expect(ITEMS.shovel.maxStack).toBe(1);
    expect(inv.add('shovel', 3)).toBe(0);
    expect(layout(inv)).toEqual(['0:shovel×1', '1:shovel×1', '2:shovel×1']);
  });

  test('returns the overflow when the inventory is full', () => {
    const inv = new Inventory();
    for (let i = 0; i < PLAYER_INVENTORY_SIZE; i++) inv.setSlot(i, { id: 'axe', count: 1 });
    expect(inv.add('axe', 1)).toBe(1);
    expect(inv.add('dirt', 7)).toBe(7);

    inv.setSlot(35, { id: 'dirt', count: 990 });
    expect(inv.add('dirt', 25)).toBe(15);
    expect(inv.slots[35]).toEqual({ id: 'dirt', count: 1000 });
  });

  test('ignores non-positive counts and rejects unknown items', () => {
    const inv = new Inventory();
    expect(inv.add('dirt', 0)).toBe(0);
    expect(inv.add('dirt', -5)).toBe(0);
    expect(layout(inv)).toEqual([]);
    expect(() => inv.add('no_such_item', 1)).toThrow(/Unknown item/);
  });

  test('works for small container inventories', () => {
    const box = new Inventory(12);
    expect(box.add('apple', 45)).toBe(0); // food stacks to 20
    expect(layout(box)).toEqual(['0:apple×20', '1:apple×20', '2:apple×5']);
    expect(box.add('shovel', 20)).toBe(11);
    expect(box.slots.every((s) => s !== null)).toBe(true);
  });

  test('addToRange only touches the given slot range', () => {
    const inv = new Inventory();
    inv.setSlot(0, { id: 'stone', count: 10 }); // hotbar stack outside the range stays as it is
    expect(inv.addToRange('stone', 1500, HOTBAR_SIZE, PLAYER_INVENTORY_SIZE)).toBe(0);
    expect(layout(inv)).toEqual(['0:stone×10', '9:stone×1000', '10:stone×500']);
    expect(inv.addToRange('stone', 5, -4, 2)).toBe(0); // clamped to [0, 2)
    expect(inv.slots[0]).toEqual({ id: 'stone', count: 15 });
    expect(inv.addToRange('shovel', 2, 1, 2)).toBe(1);
  });
});

describe('Inventory.remove / count / has', () => {
  test('removes from the end of the backpack first and never keeps empty stacks', () => {
    const inv = new Inventory();
    inv.setSlot(0, { id: 'wood', count: 100 });
    inv.setSlot(5, { id: 'wood', count: 30 });
    inv.setSlot(20, { id: 'wood', count: 50 });
    inv.setSlot(30, { id: 'stone', count: 7 });
    expect(inv.count('wood')).toBe(180);

    expect(inv.remove('wood', 60)).toBe(60);
    expect(layout(inv)).toEqual(['0:wood×100', '5:wood×20', '30:stone×7']);

    expect(inv.remove('wood', 500)).toBe(120);
    expect(layout(inv)).toEqual(['30:stone×7']);
    expect(inv.count('wood')).toBe(0);
    expect(inv.remove('wood', 1)).toBe(0);
    expect(inv.remove('stone', 0)).toBe(0);
    expect(inv.count('stone')).toBe(7);
  });

  test('has() checks the total over all stacks', () => {
    const inv = new Inventory();
    inv.setSlot(2, { id: 'rope', count: 3 });
    inv.setSlot(17, { id: 'rope', count: 4 });
    expect(inv.has('rope')).toBe(true);
    expect(inv.has('rope', 7)).toBe(true);
    expect(inv.has('rope', 8)).toBe(false);
    expect(inv.has('cloth')).toBe(false);
    expect(inv.has('cloth', 0)).toBe(true);
  });
});

describe('Inventory slots', () => {
  test('selectedStack follows the selected hotbar slot', () => {
    const inv = new Inventory();
    expect(inv.selectedStack()).toBeNull();
    inv.setSlot(4, { id: 'flashlight', count: 1 });
    inv.selected = 4;
    expect(inv.selectedStack()).toEqual({ id: 'flashlight', count: 1 });
    inv.selected = 5;
    expect(inv.selectedStack()).toBeNull();
  });

  test('takeFromSlot takes part of a stack or the whole stack', () => {
    const inv = new Inventory();
    inv.setSlot(7, { id: 'sand', count: 40 });
    expect(inv.takeFromSlot(7, 15)).toEqual({ id: 'sand', count: 15 });
    expect(inv.slots[7]).toEqual({ id: 'sand', count: 25 });
    expect(inv.takeFromSlot(7, 100)).toEqual({ id: 'sand', count: 25 });
    expect(inv.slots[7]).toBeNull();
    expect(inv.takeFromSlot(7, 1)).toBeNull();
    expect(inv.takeFromSlot(99, 1)).toBeNull();
    inv.setSlot(1, { id: 'sand', count: 3 });
    expect(inv.takeFromSlot(1, 0)).toBeNull();
    expect(inv.slots[1]).toEqual({ id: 'sand', count: 3 });
  });

  test('setSlot stores a copy, empties on null or count ≤ 0, rejects bad indices', () => {
    const inv = new Inventory();
    const stack = { id: 'brick', count: 12 };
    inv.setSlot(3, stack);
    stack.count = 999;
    expect(inv.slots[3]).toEqual({ id: 'brick', count: 12 });
    expect(inv.slots[3]).not.toBe(stack);

    const taken = inv.takeFromSlot(3, 2)!;
    taken.count = 50;
    expect(inv.slots[3]).toEqual({ id: 'brick', count: 10 });

    inv.setSlot(3, { id: 'brick', count: 0 });
    expect(inv.slots[3]).toBeNull();
    inv.setSlot(4, { id: 'brick', count: 5 });
    inv.setSlot(4, null);
    expect(inv.slots[4]).toBeNull();

    expect(() => inv.setSlot(36, { id: 'brick', count: 1 })).toThrow(RangeError);
    expect(() => inv.setSlot(-1, null)).toThrow(RangeError);
    expect(inv.slots).toHaveLength(PLAYER_INVENTORY_SIZE);
  });
});

describe('Inventory.onChange', () => {
  test('notifies once per changing call and not for no-ops', () => {
    const inv = new Inventory();
    const fn = vi.fn();
    inv.onChange(fn);

    inv.add('dirt', 2500); // three slots touched, one notification
    expect(fn).toHaveBeenCalledTimes(1);
    inv.remove('dirt', 1200);
    expect(fn).toHaveBeenCalledTimes(2);
    inv.takeFromSlot(0, 1);
    expect(fn).toHaveBeenCalledTimes(3);
    inv.setSlot(10, { id: 'apple', count: 2 });
    expect(fn).toHaveBeenCalledTimes(4);

    inv.add('dirt', 0);
    inv.remove('cloth', 3);
    inv.takeFromSlot(20, 1);
    inv.setSlot(20, null);
    inv.setSlot(10, { id: 'apple', count: 2 }); // identical content
    expect(fn).toHaveBeenCalledTimes(4);

    for (let i = 0; i < PLAYER_INVENTORY_SIZE; i++) inv.setSlot(i, { id: 'axe', count: 1 });
    fn.mockClear();
    expect(inv.add('dirt', 3)).toBe(3); // nothing fits → no notification
    expect(fn).not.toHaveBeenCalled();
  });

  test('unsubscribe works, is idempotent and is safe during notification', () => {
    const inv = new Inventory();
    const calls: string[] = [];
    const offA = inv.onChange(() => {
      calls.push('a');
      offA(); // unsubscribing itself while being notified must not skip the next listener
    });
    const offB = inv.onChange(() => calls.push('b'));
    inv.add('stick', 1);
    expect(calls).toEqual(['a', 'b']);

    inv.add('stick', 1);
    expect(calls).toEqual(['a', 'b', 'b']);

    offB();
    offB();
    inv.add('stick', 1);
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
