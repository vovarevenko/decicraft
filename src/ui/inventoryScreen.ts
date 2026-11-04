/**
 * Inventory + crafting screen (Tab / I), also used for containers (crates, cabinets).
 * OWNER: agent "items-ui".
 * Click to pick up / put down a stack, right-click to take half / put one, Shift+click to quick-move,
 * hover tooltips (name, description, count with unit). Crafting list shows every recipe with
 * ingredient availability, «Создать» buttons, campfire requirement.
 * Closing: Tab/I are handled by game.ts (it calls close()); update() closes on input.consume('Escape'),
 * and in container view also on input.consume('KeyE'). close() is idempotent.
 *
 * Layout: recipe cards (or, in container view, the container's grid) on top, the player's 4×9 grid
 * below with the hotbar row separated at the bottom. Shift+click moves a stack between hotbar and
 * backpack, or between container and player (no room: the slot flashes red and a toast says so).
 * A press in the gap between two slots counts for the nearer one (styles.css). Keys 1–9 swap the
 * hovered slot with that hotbar slot, a click outside the panel drops the held stack (right button:
 * one item), Shift+click on «Создать» crafts as many as possible. On close the held stack goes back to
 * its slot if that is still empty, otherwise into the player inventory, and whatever does not fit is
 * dropped as an ItemDrop.
 */
import { GAMEPLAY } from '../config';
import type { GameContext } from '../game/context';
import { canCraft, craft, RECIPES, type Recipe } from '../game/crafting';
import type { Entity } from '../game/entities/entity';
import { ItemDrop } from '../game/entities/itemDrop';
import { HOTBAR_SIZE, PLAYER_INVENTORY_SIZE, type Inventory, type ItemStack } from '../game/inventory';
import { ITEMS, type ItemKind } from '../game/items';
import { el, setHidden } from './dom';
import { getItemIcon } from './icons';
import { SlotView } from './slotView';

export interface ContainerView {
  title: string;
  inventory: Inventory;
}

type SlotOwner = 'player' | 'container';

interface RecipeInputView {
  id: string;
  name: string;
  need: number;
  /** Count shown on screen (-1 = not rendered yet). */
  have: number;
  el: HTMLSpanElement;
}

interface RecipeCard {
  recipe: Recipe;
  el: HTMLDivElement;
  icon: HTMLImageElement;
  button: HTMLButtonElement;
  inputs: RecipeInputView[];
  /** «Нужен костёр рядом» badge (recipes that need a campfire). */
  campfire: HTMLSpanElement | null;
  craftable: boolean | null;
  near: boolean | null;
}

const DIGIT_CODES: readonly string[] = Array.from({ length: HOTBAR_SIZE }, (_, i) => `Digit${i + 1}`);
/** Upper bound of crafts done by one Shift+click on «Создать». */
const MAX_CRAFT_BATCH = 100;
const KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  material: 'Материал',
  tool: 'Инструмент',
  food: 'Еда',
  light: 'Источник света',
  placeable: 'Можно поставить',
  resource: 'Ресурс',
  note: 'Можно прочитать',
};
const HELP_PLAYER =
  'ЛКМ — взять/положить · ПКМ — половину/по одному · Shift+ЛКМ — между панелью и рюкзаком · ' +
  '1–9 — в слот панели · щелчок мимо окна — выбросить · Tab или Esc — закрыть';
const HELP_CONTAINER =
  'ЛКМ — взять/положить · ПКМ — половину/по одному · Shift+ЛКМ — между хранилищем и инвентарём · ' +
  '1–9 — в слот панели · щелчок мимо окна — выбросить · E, Tab или Esc — закрыть';
/** Flash of a slot whose Shift+click found no room: from --ui-bad back to the slot's own colours. */
const DENY_FLASH: Keyframe[] = [
  { borderColor: 'rgba(242, 137, 124, 0.95)', backgroundColor: 'rgba(242, 137, 124, 0.22)' },
  {},
];
const DENY_FLASH_MS = 400;

export class InventoryScreen {
  private readonly layer: HTMLDivElement;
  private readonly craftSection: HTMLElement;
  private readonly campfireBadge: HTMLSpanElement;
  private readonly containerSection: HTMLElement;
  private readonly containerTitle: HTMLHeadingElement;
  private readonly containerGrid: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly playerSlots: SlotView[] = [];
  private containerSlots: SlotView[] = [];
  private readonly cards: RecipeCard[] = [];
  private readonly heldEl: HTMLDivElement;
  private readonly heldView: SlotView;
  private readonly tip: HTMLDivElement;
  private readonly tipName: HTMLDivElement;
  private readonly tipKind: HTMLDivElement;
  private readonly tipDesc: HTMLDivElement;
  private readonly tipAmount: HTMLDivElement;
  private readonly nearby: Entity[] = [];

  private ctx: GameContext | null = null;
  private opened = false;
  /** Set by open(): the frame that opened the screen must not also close it. */
  private freshOpen = false;
  private iconsLoaded = false;
  private view: ContainerView | null = null;
  private held: ItemStack | null = null;
  /** Slot the held stack was picked up from (it goes back there on close if still empty). */
  private heldFrom: { inv: Inventory; index: number } | null = null;
  private nearCampfire = false;
  private shownNear: boolean | null = null;
  private hoverEl: HTMLElement | null = null;
  private hoverOwner: SlotOwner | null = null;
  private hoverIndex = -1;
  private hoverItem: string | null = null;
  private tipId: string | null = null;
  private tipCount = 0;
  private tipW = 0;
  private tipH = 0;
  private mouseX = 0;
  private mouseY = 0;

  constructor(root: HTMLElement) {
    this.layer = el('div', 'inv-layer');
    this.layer.hidden = true;
    const panel = el('div', 'inv-panel');

    const closeButton = el('button', 'ui-close', '✕');
    closeButton.type = 'button';
    closeButton.title = 'Закрыть';
    // Closing from a click keeps the user gesture, so re-locking the pointer succeeds.
    closeButton.addEventListener('click', () => {
      if (this.ctx !== null) this.close(this.ctx);
    });

    this.craftSection = el('section', 'inv-section');
    const craftHead = el('div', 'inv-head');
    this.campfireBadge = el('span', 'inv-badge', 'Костёр рядом');
    this.campfireBadge.hidden = true;
    craftHead.append(el('h2', 'inv-title', 'Создание предметов'), this.campfireBadge);
    const recipes = el('div', 'inv-recipes');
    for (const recipe of RECIPES) {
      const card = this.buildCard(recipe);
      this.cards.push(card);
      recipes.append(card.el);
    }
    this.craftSection.append(craftHead, recipes);

    this.containerSection = el('section', 'inv-section');
    this.containerSection.hidden = true;
    const containerHead = el('div', 'inv-head');
    this.containerTitle = el('h2', 'inv-title');
    containerHead.append(this.containerTitle);
    this.containerGrid = el('div', 'inv-grid');
    this.containerSection.append(containerHead, this.containerGrid);

    const playerSection = el('section', 'inv-section');
    const playerHead = el('div', 'inv-head');
    playerHead.append(el('h2', 'inv-title', 'Инвентарь'));
    const backpack = el('div', 'inv-grid');
    const hotbar = el('div', 'inv-grid inv-hotbar');
    for (let i = 0; i < PLAYER_INVENTORY_SIZE; i++) {
      const slot = slotFor('player', i);
      if (i < HOTBAR_SIZE) {
        slot.el.append(el('span', 'slot-key', String(i + 1)));
        hotbar.append(slot.el);
      } else {
        backpack.append(slot.el);
      }
      this.playerSlots.push(slot);
    }
    playerSection.append(playerHead, backpack, hotbar);

    this.help = el('div', 'inv-help', HELP_PLAYER);
    panel.append(closeButton, this.craftSection, this.containerSection, playerSection, this.help);

    this.heldView = new SlotView('slot');
    this.heldEl = el('div', 'inv-held');
    this.heldEl.hidden = true;
    this.heldEl.append(this.heldView.el);

    this.tip = el('div', 'inv-tip');
    this.tip.hidden = true;
    this.tipName = el('div', 'inv-tip-name');
    this.tipKind = el('div', 'inv-tip-kind');
    this.tipDesc = el('div', 'inv-tip-desc');
    this.tipAmount = el('div', 'inv-tip-amount');
    this.tip.append(this.tipName, this.tipKind, this.tipDesc, this.tipAmount);

    this.layer.append(panel, this.heldEl, this.tip);
    this.layer.addEventListener('mousedown', this.onMouseDown);
    this.layer.addEventListener('mousemove', this.onMouseMove);
    this.layer.addEventListener('mouseleave', () => this.setHover(null));
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());
    root.append(this.layer);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** The container shown right now; null in the plain inventory view and while closed. */
  get container(): ContainerView | null {
    return this.opened ? this.view : null;
  }

  /** Opens the screen (calls ctx.input.setUiOpen(true)); with a container shows its slots instead of crafting. */
  open(ctx: GameContext, container?: ContainerView): void {
    this.ctx = ctx;
    const view = container ?? null;
    if (this.opened) {
      if (view?.inventory !== this.view?.inventory) {
        this.setView(view);
        this.refresh(ctx);
      }
      return;
    }
    this.opened = true;
    this.freshOpen = true;
    if (!this.iconsLoaded) {
      // Deferred to the first open: rendering icons during boot would only delay the start screen.
      for (const card of this.cards) card.icon.src = getItemIcon(card.recipe.output.id);
      this.iconsLoaded = true;
    }
    this.setView(view);
    this.nearCampfire = this.campfireNearby(ctx);
    this.refresh(ctx);
    this.layer.hidden = false;
    ctx.input.setUiOpen(true);
  }

  /** Closes (returns a held stack to the inventory or drops it) and calls ctx.input.setUiOpen(false). */
  close(ctx: GameContext): void {
    if (!this.opened) return;
    this.opened = false;
    this.returnHeld(ctx);
    this.view = null;
    this.setHover(null);
    this.tip.hidden = true;
    this.tipId = null;
    this.layer.hidden = true;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.layer.contains(focused)) focused.blur();
    ctx.input.setUiOpen(false);
  }

  /** Per-frame: Esc/E closing per the class doc, refreshes recipe availability. */
  update(ctx: GameContext): void {
    if (!this.opened) return;
    this.ctx = ctx;
    if (this.freshOpen) {
      this.freshOpen = false;
    } else if (ctx.input.consume('Escape') || (this.view !== null && ctx.input.consume('KeyE'))) {
      this.close(ctx);
      return;
    }
    if (this.hoverOwner !== null && this.held === null) {
      for (let i = 0; i < HOTBAR_SIZE; i++) {
        if (ctx.input.consume(DIGIT_CODES[i])) {
          this.swapWithHotbar(ctx, this.hoverOwner, this.hoverIndex, i);
          break;
        }
      }
    }
    this.nearCampfire = this.campfireNearby(ctx);
    this.refresh(ctx);
  }

  private buildCard(recipe: Recipe): RecipeCard {
    const cardEl = el('div', 'recipe');
    const icon = el('img', 'recipe-icon');
    icon.alt = '';
    icon.draggable = false;
    icon.dataset.item = recipe.output.id;

    const body = el('div', 'recipe-body');
    const name = el('div', 'recipe-name', recipe.name);
    if (recipe.output.count > 1) name.append(el('span', 'recipe-count', ` ×${recipe.output.count}`));
    const inputsEl = el('div', 'recipe-inputs');
    const inputs = recipe.inputs.map((input): RecipeInputView => {
      const span = el('span', 'recipe-input');
      inputsEl.append(span);
      return { id: input.id, name: ITEMS[input.id]?.name ?? input.id, need: input.count, have: -1, el: span };
    });
    body.append(name, inputsEl);
    let campfire: HTMLSpanElement | null = null;
    if (recipe.needsCampfire) {
      campfire = el('span', 'recipe-campfire');
      body.append(campfire);
    }

    const button = el('button', 'btn btn-craft', 'Создать');
    button.type = 'button';
    button.disabled = true;
    button.title = 'Shift+щелчок — создать, сколько получится';
    // Never take focus: a focused button would craft again on Space/Enter.
    button.addEventListener('mousedown', (e) => e.preventDefault());

    const card: RecipeCard = { recipe, el: cardEl, icon, button, inputs, campfire, craftable: null, near: null };
    button.addEventListener('click', (e) => this.craftCard(card, e.shiftKey));
    cardEl.append(icon, body, button);
    return card;
  }

  private setView(view: ContainerView | null): void {
    this.view = view;
    const isContainer = view !== null;
    setHidden(this.craftSection, isContainer);
    setHidden(this.containerSection, !isContainer);
    this.help.textContent = isContainer ? HELP_CONTAINER : HELP_PLAYER;
    if (view === null) return;
    this.containerTitle.textContent = view.title || 'Хранилище';
    const size = view.inventory.slots.length;
    if (this.containerSlots.length === size) return;
    this.containerGrid.replaceChildren();
    this.containerSlots = [];
    const columns = size <= 9 ? size : size % 9 === 0 ? 9 : size % 6 === 0 ? 6 : 9;
    this.containerGrid.style.gridTemplateColumns = `repeat(${columns}, var(--slot))`;
    for (let i = 0; i < size; i++) {
      const slot = slotFor('container', i);
      this.containerSlots.push(slot);
      this.containerGrid.append(slot.el);
    }
  }

  private inventoryOf(ctx: GameContext, owner: SlotOwner): Inventory | null {
    return owner === 'player' ? ctx.inventory : (this.view?.inventory ?? null);
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    const ctx = this.ctx;
    if (!this.opened || ctx === null || (e.button !== 0 && e.button !== 2)) return;
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    const target = e.target instanceof Element ? e.target : null;
    const slotEl = target?.closest<HTMLElement>('[data-slot]') ?? null;
    if (slotEl !== null) {
      e.preventDefault();
      const inv = this.inventoryOf(ctx, slotEl.dataset.owner === 'container' ? 'container' : 'player');
      if (inv !== null) this.clickSlot(ctx, inv, Number(slotEl.dataset.slot), e.button === 2, e.shiftKey);
    } else if (target === this.layer && this.held !== null) {
      e.preventDefault();
      this.dropHeld(ctx, e.button === 2 ? 1 : this.held.count);
    } else {
      return;
    }
    this.refresh(ctx);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.setHover(e.target);
    this.placeFloating();
  };

  /** Left: pick up / put down / merge / swap. Right: take half / put one. Shift+left: quick move. */
  private clickSlot(ctx: GameContext, inv: Inventory, index: number, right: boolean, shift: boolean): void {
    const slot = inv.slots[index] ?? null;
    const held = this.held;
    if (held === null) {
      if (slot === null) return;
      if (shift && !right) {
        this.quickMove(ctx, inv, index);
        return;
      }
      this.held = inv.takeFromSlot(index, right ? Math.ceil(slot.count / 2) : slot.count);
      this.heldFrom = { inv, index };
      return;
    }
    if (slot === null) {
      const n = right ? 1 : held.count;
      inv.setSlot(index, { id: held.id, count: n });
      this.takeHeld(n);
      return;
    }
    if (slot.id === held.id) {
      const n = Math.min(right ? 1 : held.count, (ITEMS[held.id]?.maxStack ?? 1) - slot.count);
      if (n > 0) {
        inv.setSlot(index, { id: slot.id, count: slot.count + n });
        this.takeHeld(n);
      }
      return;
    }
    const picked: ItemStack = { id: slot.id, count: slot.count };
    inv.setSlot(index, held);
    this.held = picked;
    this.heldFrom = { inv, index };
  }

  /** Hotbar ↔ backpack in the plain view, container ↔ player in container view. */
  private quickMove(ctx: GameContext, inv: Inventory, index: number): void {
    const stack = inv.slots[index];
    if (stack == null) return;
    let left: number;
    if (this.view !== null) {
      const target = inv === ctx.inventory ? this.view.inventory : ctx.inventory;
      left = target.add(stack.id, stack.count);
    } else if (index < HOTBAR_SIZE) {
      left = inv.addToRange(stack.id, stack.count, HOTBAR_SIZE, inv.slots.length);
    } else {
      left = inv.addToRange(stack.id, stack.count, 0, HOTBAR_SIZE);
    }
    // The source slot lies outside the target range, so `stack` still holds the original count.
    const moved = stack.count - left;
    if (moved > 0) inv.takeFromSlot(index, moved);
    else this.denyMove(ctx, inv, index);
  }

  /** A quick move with no room on the other side: flash the slot and say why (it would look ignored). */
  private denyMove(ctx: GameContext, inv: Inventory, index: number): void {
    const slot = (inv === ctx.inventory ? this.playerSlots : this.containerSlots)[index];
    slot?.el.animate(DENY_FLASH, { duration: DENY_FLASH_MS, easing: 'ease-out' });
    ctx.hud.toast('Нет места');
  }

  private swapWithHotbar(ctx: GameContext, owner: SlotOwner, index: number, hotbarIndex: number): void {
    const inv = this.inventoryOf(ctx, owner);
    const player = ctx.inventory;
    if (inv === null || (inv === player && index === hotbarIndex)) return;
    const a = inv.slots[index] ?? null;
    const b = player.slots[hotbarIndex] ?? null;
    inv.setSlot(index, b);
    player.setSlot(hotbarIndex, a);
  }

  private takeHeld(n: number): void {
    const held = this.held;
    if (held === null) return;
    held.count -= n;
    if (held.count <= 0) {
      this.held = null;
      this.heldFrom = null;
    }
  }

  private dropHeld(ctx: GameContext, n: number): void {
    const held = this.held;
    if (held === null) return;
    const count = Math.min(n, held.count);
    this.dropStack(ctx, held.id, count);
    this.takeHeld(count);
  }

  private returnHeld(ctx: GameContext): void {
    const held = this.held;
    const from = this.heldFrom;
    this.held = null;
    this.heldFrom = null;
    this.heldView.set(null);
    this.heldEl.hidden = true;
    if (held === null) return;
    if (from !== null && from.inv.slots[from.index] === null) {
      from.inv.setSlot(from.index, held);
      return;
    }
    const left = ctx.inventory.add(held.id, held.count);
    if (left > 0) this.dropStack(ctx, held.id, left);
  }

  /** Tosses a stack forward from the player's chest (starting inside the body box, never inside a wall). */
  private dropStack(ctx: GameContext, id: string, count: number): void {
    const p = ctx.player;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const pos = { x: p.position.x + fx * 2, y: p.position.y + 12, z: p.position.z + fz * 2 };
    ctx.entities.add(new ItemDrop(id, count, pos, { x: fx * 25, y: 12, z: fz * 25 }));
    ctx.audio.play('drop');
  }

  private craftCard(card: RecipeCard, all: boolean): void {
    const ctx = this.ctx;
    if (!this.opened || ctx === null) return;
    const { recipe } = card;
    let crafted = 0;
    let leftover = 0;
    while (crafted < (all ? MAX_CRAFT_BATCH : 1)) {
      const result = craft(ctx.inventory, recipe, this.nearCampfire);
      if (!result.ok) break;
      crafted++;
      if (result.leftover > 0) {
        leftover = result.leftover;
        break;
      }
    }
    if (crafted === 0) return;
    ctx.audio.play('craft');
    const total = crafted * recipe.output.count;
    ctx.hud.toast(total > 1 ? `Создано: ${recipe.name} ×${total}` : `Создано: ${recipe.name}`);
    if (leftover > 0) {
      this.dropStack(ctx, recipe.output.id, leftover);
      ctx.hud.toast('Инвентарь полон — остаток выброшен');
    }
    this.refresh(ctx);
  }

  private campfireNearby(ctx: GameContext): boolean {
    const found = ctx.entities.queryRadius(ctx.player.position, GAMEPLAY.campfireRadius, this.nearby);
    let near = false;
    for (let i = 0; i < found.length && !near; i++) near = found[i].type === 'campfire';
    found.length = 0; // keep no references to entities between frames
    return near;
  }

  /** Brings every visible part up to date; each piece writes to the DOM only when its value changed. */
  private refresh(ctx: GameContext): void {
    const inv = ctx.inventory;
    for (let i = 0; i < this.playerSlots.length; i++) this.playerSlots[i].set(inv.slots[i] ?? null);
    if (this.view !== null) {
      const slots = this.view.inventory.slots;
      for (let i = 0; i < this.containerSlots.length; i++) this.containerSlots[i].set(slots[i] ?? null);
    } else {
      this.refreshRecipes(inv);
    }
    this.heldView.set(this.held);
    if (this.heldEl.hidden !== (this.held === null)) {
      this.heldEl.hidden = this.held === null;
      this.placeFloating();
    }
    this.updateTooltip();
  }

  private refreshRecipes(inv: Inventory): void {
    const near = this.nearCampfire;
    if (near !== this.shownNear) {
      this.shownNear = near;
      setHidden(this.campfireBadge, !near);
    }
    for (const card of this.cards) {
      for (const input of card.inputs) {
        const have = inv.count(input.id);
        if (have === input.have) continue;
        input.have = have;
        input.el.textContent = `${input.name} ${have}/${input.need}`;
        input.el.title = `Есть ${have}, нужно ${input.need}`;
        input.el.classList.toggle('ok', have >= input.need);
      }
      if (card.campfire !== null && card.near !== near) {
        card.near = near;
        card.campfire.textContent = near ? 'Костёр рядом' : 'Нужен костёр рядом';
        card.campfire.classList.toggle('ok', near);
      }
      const ok = canCraft(inv, card.recipe, near);
      if (ok !== card.craftable) {
        card.craftable = ok;
        card.button.disabled = !ok;
        card.el.classList.toggle('ready', ok);
      }
    }
  }

  private setHover(target: EventTarget | null): void {
    const hit = target instanceof Element ? target.closest<HTMLElement>('[data-slot], [data-item]') : null;
    if (hit === this.hoverEl) return;
    this.hoverEl = hit;
    this.hoverOwner = null;
    this.hoverIndex = -1;
    this.hoverItem = null;
    if (hit !== null) {
      if (hit.dataset.slot !== undefined) {
        this.hoverOwner = hit.dataset.owner === 'container' ? 'container' : 'player';
        this.hoverIndex = Number(hit.dataset.slot);
      } else {
        this.hoverItem = hit.dataset.item ?? null;
      }
    }
    this.updateTooltip();
  }

  /** Tooltip of the hovered slot or recipe result (hidden while a stack is held). */
  private updateTooltip(): void {
    let id: string | null = null;
    let count = 0;
    if (this.held === null && this.ctx !== null) {
      if (this.hoverOwner !== null) {
        const stack = this.inventoryOf(this.ctx, this.hoverOwner)?.slots[this.hoverIndex] ?? null;
        if (stack !== null && stack.count > 0) {
          id = stack.id;
          count = stack.count;
        }
      } else {
        id = this.hoverItem;
      }
    }
    const def = id !== null ? ITEMS[id] : undefined;
    if (def === undefined) {
      setHidden(this.tip, true);
      this.tipId = null;
      return;
    }
    if (def.id === this.tipId && count === this.tipCount) return;
    this.tipId = def.id;
    this.tipCount = count;
    this.tipName.textContent = def.name;
    this.tipKind.textContent = KIND_LABELS[def.kind];
    this.tipDesc.textContent = def.description;
    let amount = '';
    if (count > 0) amount = def.maxStack > 1 ? `${count} ${def.unit} из ${def.maxStack}` : `${count} ${def.unit}`;
    else if (def.maxStack > 1) amount = `В стопке до ${def.maxStack} ${def.unit}`;
    this.tipAmount.textContent = amount;
    setHidden(this.tipAmount, amount === '');
    setHidden(this.tip, false);
    this.tipW = this.tip.offsetWidth;
    this.tipH = this.tip.offsetHeight;
    this.placeFloating();
  }

  /** Moves the held stack and the tooltip to the cursor (tooltip kept inside the window). */
  private placeFloating(): void {
    if (!this.heldEl.hidden) this.heldEl.style.transform = `translate(${this.mouseX}px, ${this.mouseY}px)`;
    if (!this.tip.hidden) {
      let x = this.mouseX + 16;
      let y = this.mouseY + 18;
      if (x + this.tipW > window.innerWidth - 8) x = this.mouseX - 12 - this.tipW;
      if (y + this.tipH > window.innerHeight - 8) y = Math.max(8, window.innerHeight - 8 - this.tipH);
      this.tip.style.transform = `translate(${x}px, ${y}px)`;
    }
  }
}

function slotFor(owner: SlotOwner, index: number): SlotView {
  const slot = new SlotView('slot inv-slot');
  slot.el.dataset.owner = owner;
  slot.el.dataset.slot = String(index);
  return slot;
}
