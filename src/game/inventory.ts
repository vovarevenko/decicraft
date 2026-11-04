/**
 * Slot inventory (player backpack and containers). OWNER: agent "items-ui".
 * Slots 0..HOTBAR_SIZE-1 are the hotbar for the player inventory.
 *
 * Invariants kept by every method: a slot is either null or a stack with count ≥ 1 (count-0 stacks
 * are never kept), and add() never fills a stack beyond ITEMS[id].maxStack. setSlot() stores a copy of
 * the given stack; takeFromSlot() returns a new object owned by the caller. Every call that changes
 * the contents notifies the onChange listeners exactly once.
 */
import { getItem } from './items';

export interface ItemStack {
  id: string;
  count: number;
}

export const HOTBAR_SIZE = 9;
export const PLAYER_INVENTORY_SIZE = 36;

export class Inventory {
  readonly slots: (ItemStack | null)[];
  /** Selected hotbar slot index (player inventory only). */
  selected = 0;
  /** Replaced (never mutated) on (un)subscribe, so a listener may unsubscribe while being notified. */
  private listeners: readonly (() => void)[] = [];

  constructor(size: number = PLAYER_INVENTORY_SIZE) {
    this.slots = new Array(size).fill(null);
  }

  /** Adds items (merging into existing stacks first, hotbar before backpack). Returns the count that did not fit. */
  add(id: string, count: number): number {
    return this.addToRange(id, count, 0, this.slots.length);
  }

  /**
   * add() limited to slots [start, end): tops up existing stacks of `id` in index order, then fills
   * empty slots in index order. Returns the count that did not fit. Throws for unknown item ids.
   */
  addToRange(id: string, count: number, start: number, end: number): number {
    if (count <= 0) return 0;
    const max = getItem(id).maxStack;
    const from = Math.max(0, start);
    const to = Math.min(this.slots.length, end);
    let left = count;
    for (let i = from; i < to && left > 0; i++) {
      const s = this.slots[i];
      if (s !== null && s.id === id && s.count < max) {
        const n = Math.min(max - s.count, left);
        s.count += n;
        left -= n;
      }
    }
    for (let i = from; i < to && left > 0; i++) {
      if (this.slots[i] === null) {
        const n = Math.min(max, left);
        this.slots[i] = { id, count: n };
        left -= n;
      }
    }
    if (left !== count) this.emit();
    return left;
  }

  /** Removes up to `count` items of `id` (from the end of the backpack first). Returns the number removed. */
  remove(id: string, count: number): number {
    if (count <= 0) return 0;
    let left = count;
    for (let i = this.slots.length - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s === null || s.id !== id) continue;
      const n = Math.min(s.count, left);
      left -= n;
      if (n === s.count) this.slots[i] = null;
      else s.count -= n;
    }
    const removed = count - left;
    if (removed > 0) this.emit();
    return removed;
  }

  count(id: string): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s !== null && s.id === id) n += s.count;
    }
    return n;
  }

  has(id: string, count = 1): boolean {
    if (count <= 0) return true;
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s === null || s.id !== id) continue;
      n += s.count;
      if (n >= count) return true;
    }
    return false;
  }

  /** Stack in the selected hotbar slot, or null. */
  selectedStack(): ItemStack | null {
    return this.slots[this.selected] ?? null;
  }

  /** Removes up to `count` from slot `index`; returns what was taken. */
  takeFromSlot(index: number, count: number): ItemStack | null {
    const s = this.slots[index];
    if (s == null || count <= 0) return null;
    const n = Math.min(count, s.count);
    if (n === s.count) this.slots[index] = null;
    else s.count -= n;
    this.emit();
    return { id: s.id, count: n };
  }

  /** Puts a copy of `stack` into slot `index` (null or a count ≤ 0 empties it). Throws for indices outside the inventory. */
  setSlot(index: number, stack: ItemStack | null): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.slots.length) {
      throw new RangeError(`Inventory slot ${index} is outside 0..${this.slots.length - 1}`);
    }
    const cur = this.slots[index];
    if (stack === null || stack.count <= 0) {
      if (cur === null) return;
      this.slots[index] = null;
    } else {
      if (cur !== null && cur.id === stack.id && cur.count === stack.count) return;
      this.slots[index] = { id: stack.id, count: stack.count };
    }
    this.emit();
  }

  /** Subscribe to any change; returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners = [...this.listeners, fn];
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners = [...this.listeners.slice(0, i), ...this.listeners.slice(i + 1)];
    };
  }

  private emit(): void {
    const list = this.listeners;
    for (let i = 0; i < list.length; i++) list[i]();
  }
}
