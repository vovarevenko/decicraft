/**
 * One item slot (icon + count) that rewrites the DOM only when the shown stack changes. Used by the
 * HUD hotbar, the inventory/container grids and the stack held by the cursor. OWNER: agent "items-ui".
 */
import type { ItemStack } from '../game/inventory';
import { el } from './dom';
import { getItemIcon } from './icons';

export class SlotView {
  readonly el: HTMLDivElement;
  private readonly icon: HTMLImageElement;
  private readonly countEl: HTMLSpanElement;
  private id: string | null = null;
  private count = 0;

  constructor(className = 'slot') {
    this.el = el('div', className);
    this.icon = el('img', 'slot-icon');
    this.icon.alt = '';
    this.icon.draggable = false;
    this.icon.hidden = true;
    this.countEl = el('span', 'slot-count');
    this.el.append(this.icon, this.countEl);
  }

  /** Shows `stack` (null or count ≤ 0 = empty); counts of 1 are not printed. */
  set(stack: ItemStack | null): void {
    let id: string | null = null;
    let count = 0;
    if (stack !== null && stack.count > 0) {
      id = stack.id;
      count = stack.count;
    }
    if (id !== this.id) {
      this.id = id;
      if (id === null) {
        this.icon.hidden = true;
        this.icon.removeAttribute('src');
      } else {
        this.icon.src = getItemIcon(id);
        this.icon.hidden = false;
      }
      this.el.classList.toggle('filled', id !== null);
    }
    if (count !== this.count) {
      this.count = count;
      this.countEl.textContent = count > 1 ? String(count) : '';
    }
  }
}
