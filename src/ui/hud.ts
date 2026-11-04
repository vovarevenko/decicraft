/**
 * In-game HUD (DOM overlay): crosshair, hotbar with icons & counts, selected item name, target
 * line + hint, break progress ring, place size / precise mode indicator, clock, toasts, note
 * reader modal, F3 debug panel. OWNER: agent "items-ui". All text in Russian.
 *
 * The DOM is built once; update() and the setters compare with the values on screen and touch the DOM
 * only when something visible changes. The HUD appears with its first update() (when the game loop
 * starts). While an in-game screen is open (ctx.input.uiOpen) the gameplay parts — crosshair, target,
 * hotbar, indicators, hint card — are hidden; the debug panel stays and toasts move to the top centre,
 * clear of the screen's slots. A first-play hint card (key controls + where the starter toolbox is)
 * fades out after HINT_CARD_S of play or as soon as a container has been opened.
 */
import type { GameContext } from '../game/context';
import { HOTBAR_SIZE, type Inventory } from '../game/inventory';
import { ITEMS, ITEM_LIST } from '../game/items';
import { buildControls, HINT_CONTROLS } from './controls';
import { el, setHidden, svg } from './dom';
import { formatNumber } from './format';
import { warmItemIcons } from './icons';
import { SlotView } from './slotView';

export interface DebugInfo {
  fps: number;
  drawCalls: number;
  triangles: number;
  [key: string]: string | number;
}

/** In-game hours of sunrise and sunset (ARCHITECTURE.md §6.2): the clock shows ☀ between them, ☾ otherwise. */
const SUNRISE_H = 5.5;
const SUNSET_H = 20.5;
/** Seconds the selected item's name stays up after the selection changed. */
const NAME_POPUP_S = 1.5;
/** Seconds the cube-size indicator stays up after [ or ] while no material is selected. */
const CUBE_FLASH_S = 2;
/** Seconds of play after which the first-play hint card fades out. */
const HINT_CARD_S = 25;
const HINT_FADE_S = 0.6;
const TOAST_MS = 2600;
const TOAST_FADE_MS = 350;
const MAX_TOASTS = 5;
/** A note can't be closed by a click this soon after it opened (the opening press). */
const NOTE_CLICK_GUARD_MS = 250;
const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** A hint offering the interact key («E — открыть дверь») switches the crosshair to its interact style. */
const INTERACT_HINT = /(?:^|\s)E\s+—/;
/** Russian labels for the English keys of DebugInfo (the other keys are already Russian). */
const DEBUG_LABELS: Readonly<Record<string, string>> = {
  fps: 'FPS',
  drawCalls: 'вызовы отрисовки',
  triangles: 'треугольники в кадре',
};

interface Toast {
  el: HTMLDivElement;
  countEl: HTMLSpanElement;
  text: string;
  count: number;
  remainingMs: number;
  fading: boolean;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly ringArc: SVGCircleElement;
  private readonly target: HTMLDivElement;
  private readonly targetTitle: HTMLDivElement;
  private readonly targetHint: HTMLDivElement;
  private readonly hotbar: SlotView[] = [];
  private readonly itemName: HTMLDivElement;
  private readonly cubePill: HTMLDivElement;
  private readonly precisePill: HTMLDivElement;
  private readonly lightPill: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly clockIcon: HTMLSpanElement;
  private readonly clockTime: HTMLSpanElement;
  private readonly clockSpeed: HTMLSpanElement;
  private readonly toastBox: HTMLDivElement;
  private readonly toasts: Toast[] = [];
  private readonly debugPanel: HTMLPreElement;
  private hintCard: HTMLDivElement | null;
  private readonly noteLayer: HTMLDivElement;
  private readonly noteTitle: HTMLHeadingElement;
  private readonly noteBody: HTMLDivElement;

  private visible = true;
  private started = false;
  private uiOpen = false;
  private selectedSlot = -1;
  private nameItem: string | null = null;
  private nameTimer = 0;
  private targetText = '';
  private hintText = '';
  private progressStep = 0;
  private cubeSize = -1;
  private cubeFlash = 0;
  private clockMinute = -1;
  private clockDay: boolean | null = null;
  private clockMult = 1;
  private debugVisible = false;
  private debugInfo: DebugInfo | null = null;
  private debugText = '';
  private hintFading = false;
  private hintTimer = 0;
  private noteIsOpen = false;
  /** Set by showNote(): the frame that opened the note must not also close it. */
  private noteFresh = false;
  private noteOpenedAt = 0;
  private noteCtx: GameContext | null = null;

  constructor(root: HTMLElement) {
    this.root = el('div', 'hud');
    this.root.hidden = true;

    this.crosshair = el('div', 'hud-crosshair');
    this.ring = el('div', 'hud-ring');
    this.ring.hidden = true;
    const ringSvg = svg('svg', { viewBox: '0 0 40 40', width: 40, height: 40 });
    this.ringArc = svg('circle', {
      class: 'hud-ring-arc',
      cx: 20,
      cy: 20,
      r: RING_RADIUS,
      'stroke-dasharray': RING_LENGTH.toFixed(2),
      'stroke-dashoffset': RING_LENGTH.toFixed(2),
    });
    ringSvg.append(svg('circle', { class: 'hud-ring-track', cx: 20, cy: 20, r: RING_RADIUS }), this.ringArc);
    this.ring.append(ringSvg);

    this.target = el('div', 'hud-target');
    this.target.hidden = true;
    this.targetTitle = el('div', 'hud-target-title');
    this.targetHint = el('div', 'hud-target-hint');
    this.targetHint.hidden = true;
    this.target.append(this.targetTitle, this.targetHint);

    const hotbar = el('div', 'hud-hotbar');
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = new SlotView('slot hud-slot');
      slot.el.append(el('span', 'slot-key', String(i + 1)));
      this.hotbar.push(slot);
      hotbar.append(slot.el);
    }
    this.itemName = el('div', 'hud-item-name');

    const indicators = el('div', 'hud-indicators');
    this.cubePill = el('div', 'hud-pill');
    this.precisePill = el('div', 'hud-pill', 'Точный режим');
    this.lightPill = el('div', 'hud-pill', 'Фонарик');
    for (const pill of [this.cubePill, this.precisePill, this.lightPill]) pill.hidden = true;
    indicators.append(this.cubePill, this.precisePill, this.lightPill);

    this.clock = el('div', 'hud-clock');
    this.clockIcon = el('span', 'hud-clock-icon');
    this.clockTime = el('span', 'hud-clock-time');
    this.clockSpeed = el('span', 'hud-clock-speed');
    this.clock.append(this.clockIcon, this.clockTime, this.clockSpeed);

    this.toastBox = el('div', 'hud-toasts');

    this.debugPanel = el('pre', 'hud-debug');
    this.debugPanel.hidden = true;

    this.hintCard = el('div', 'hud-hint');
    this.hintCard.append(
      el('div', 'hud-hint-title', 'Управление'),
      buildControls(HINT_CONTROLS, 'hud-hint-controls'),
      el('div', 'hud-hint-toolbox', 'Рядом ящик с инструментами — подойдите и нажмите E'),
    );

    this.noteLayer = el('div', 'hud-note-layer');
    this.noteLayer.hidden = true;
    const paper = el('div', 'hud-note');
    this.noteTitle = el('h2', 'hud-note-title');
    this.noteBody = el('div', 'hud-note-body');
    paper.append(this.noteTitle, this.noteBody, el('div', 'hud-note-footer', 'Esc, E, ПКМ или щелчок — закрыть'));
    this.noteLayer.append(paper);
    this.noteLayer.addEventListener('click', (e) => {
      // Closing from the click handler keeps the user gesture, so the pointer lock request succeeds.
      if (e.button !== 0 || !this.noteIsOpen || this.noteCtx === null) return;
      if (performance.now() - this.noteOpenedAt < NOTE_CLICK_GUARD_MS) return;
      this.closeNote(this.noteCtx);
    });
    this.noteLayer.addEventListener('contextmenu', (e) => e.preventDefault());

    this.root.append(
      this.crosshair,
      this.ring,
      this.target,
      this.hintCard,
      indicators,
      this.clock,
      hotbar,
      this.itemName,
      this.toastBox,
      this.debugPanel,
      this.noteLayer,
    );
    root.append(this.root);
    warmItemIcons(ITEM_LIST.map((d) => d.id));
  }

  /** Refreshes dynamic parts (hotbar selection, clock, indicators). Cheap; called every frame. */
  update(ctx: GameContext, dt: number): void {
    if (!this.started) {
      this.started = true;
      this.applyVisibility();
    }
    const inv = ctx.inventory;
    for (let i = 0; i < HOTBAR_SIZE; i++) this.hotbar[i].set(inv.slots[i] ?? null);
    this.updateSelection(inv, dt);
    this.updateIndicators(ctx, dt);
    this.updateClock(ctx);
    this.updateToasts(dt);
    this.updateHintCard(ctx, dt);
    const uiOpen = ctx.input.uiOpen;
    if (uiOpen !== this.uiOpen) {
      this.uiOpen = uiOpen;
      this.root.classList.toggle('ui-open', uiOpen);
    }
    if (this.noteIsOpen) {
      if (this.noteFresh) this.noteFresh = false;
      else if (ctx.input.consume('Escape') || ctx.input.consume('KeyE') || ctx.input.consumeMouse(2)) this.closeNote(ctx);
    }
  }

  /** Short message near the bottom centre (top centre while a screen is open). */
  toast(text: string, ms: number = TOAST_MS): void {
    for (const t of this.toasts) {
      if (t.text === text && !t.fading) {
        // The same message again: count it on the visible toast instead of stacking a duplicate.
        t.count++;
        t.countEl.textContent = `×${t.count}`;
        t.remainingMs = Math.max(t.remainingMs, ms);
        t.el.animate([{ transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
        return;
      }
    }
    const toastEl = el('div', 'hud-toast');
    const countEl = el('span', 'hud-toast-count');
    toastEl.append(el('span', 'hud-toast-text', text), countEl);
    this.toastBox.append(toastEl);
    this.toasts.push({ el: toastEl, countEl, text, count: 1, remainingMs: ms, fading: false });
    while (this.toasts.length > MAX_TOASTS) this.toasts.shift()!.el.remove();
  }

  /** What the crosshair points at, e.g. { title: 'Дуб', hint: 'ЛКМ — рубить' }; null hides it. */
  setTarget(info: { title: string; hint?: string } | null): void {
    if (info === null) {
      setHidden(this.target, true);
      this.setHint('');
      return;
    }
    setHidden(this.target, false);
    if (info.title !== this.targetText) {
      this.targetText = info.title;
      this.targetTitle.textContent = info.title;
    }
    this.setHint(info.hint ?? '');
  }

  /** Break progress 0..1 around the crosshair; null hides it. */
  setBreakProgress(p: number | null): void {
    const step = p === null ? 0 : Math.round(Math.min(1, Math.max(0, p)) * 100);
    if (step === this.progressStep) return;
    this.progressStep = step;
    setHidden(this.ring, step === 0);
    if (step > 0) this.ringArc.style.strokeDashoffset = (RING_LENGTH * (1 - step / 100)).toFixed(2);
  }

  /**
   * Opens a modal with a readable note (newspaper). Calls ctx.input.setUiOpen(true); update() closes it
   * on input.consume('Escape') / consume('KeyE') / consumeMouse(2) or a click (never on the press that opened it).
   */
  showNote(ctx: GameContext, title: string, text: string): void {
    this.noteTitle.textContent = title;
    this.noteBody.replaceChildren(
      ...text
        .split(/\n+/)
        .filter((para) => para.trim() !== '')
        .map((para) => el('p', '', para)),
    );
    this.noteFresh = true;
    this.noteOpenedAt = performance.now();
    this.noteCtx = ctx;
    if (this.noteIsOpen) return;
    this.noteIsOpen = true;
    this.noteLayer.hidden = false;
    ctx.input.setUiOpen(true);
  }

  get noteOpen(): boolean {
    return this.noteIsOpen;
  }

  closeNote(ctx: GameContext): void {
    if (!this.noteIsOpen) return;
    this.noteIsOpen = false;
    this.noteLayer.hidden = true;
    ctx.input.setUiOpen(false);
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debugPanel.hidden = !this.debugVisible;
    if (this.debugVisible) this.renderDebug();
  }

  setDebug(info: DebugInfo): void {
    this.debugInfo = info;
    if (this.debugVisible) this.renderDebug();
  }

  /** Hide/show the whole HUD (e.g. while menus are open). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    setHidden(this.root, !(this.visible && this.started));
  }

  private setHint(hint: string): void {
    if (hint === this.hintText) return;
    this.hintText = hint;
    this.targetHint.textContent = hint;
    setHidden(this.targetHint, hint === '');
    this.crosshair.classList.toggle('interact', INTERACT_HINT.test(hint));
  }

  /** Selected-slot frame and the item name popup (on slot or item change, fading after NAME_POPUP_S). */
  private updateSelection(inv: Inventory, dt: number): void {
    const sel = inv.selected;
    const slotChanged = sel !== this.selectedSlot;
    if (slotChanged) {
      this.hotbar[this.selectedSlot]?.el.classList.remove('selected');
      this.hotbar[sel]?.el.classList.add('selected');
      this.selectedSlot = sel;
    }
    const stack = inv.selectedStack();
    const id = stack !== null && stack.count > 0 ? stack.id : null;
    if (slotChanged || id !== this.nameItem) {
      this.nameItem = id;
      if (id !== null) {
        this.itemName.textContent = ITEMS[id]?.name ?? id;
        this.itemName.classList.add('show');
        this.nameTimer = NAME_POPUP_S;
      } else if (this.nameTimer > 0) {
        this.itemName.classList.remove('show');
        this.nameTimer = 0;
      }
    } else if (this.nameTimer > 0) {
      this.nameTimer -= dt;
      if (this.nameTimer <= 0) this.itemName.classList.remove('show');
    }
  }

  private updateIndicators(ctx: GameContext, dt: number): void {
    const it = ctx.interaction;
    const size = it.placeSize;
    if (size !== this.cubeSize) {
      if (this.cubeSize !== -1) this.cubeFlash = CUBE_FLASH_S;
      this.cubeSize = size;
      this.cubePill.textContent = `Размер блока: ${size}×${size}×${size}`;
    } else if (this.cubeFlash > 0) {
      this.cubeFlash -= dt;
    }
    const stack = ctx.inventory.selectedStack();
    const material = stack !== null && ITEMS[stack.id]?.kind === 'material';
    setHidden(this.cubePill, !material && this.cubeFlash <= 0);
    setHidden(this.precisePill, !it.precise);
    setHidden(this.lightPill, !it.flashlightOn);
    // The flashlight only shines while it is in hand.
    this.lightPill.classList.toggle('dim', stack === null || stack.id !== 'flashlight');
  }

  private updateClock(ctx: GameContext): void {
    const hours = ctx.time.timeOfDay;
    const minute = Math.floor(hours * 60) % 1440;
    if (minute !== this.clockMinute) {
      this.clockMinute = minute;
      this.clockTime.textContent = `${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}`;
      const day = hours >= SUNRISE_H && hours < SUNSET_H;
      if (day !== this.clockDay) {
        this.clockDay = day;
        this.clockIcon.textContent = day ? '☀︎' : '☾︎'; // ☀ / ☾, text presentation
        this.clock.classList.toggle('night', !day);
      }
    }
    const mult = Math.round(ctx.time.speed);
    if (mult !== this.clockMult) {
      this.clockMult = mult;
      this.clockSpeed.textContent = mult > 1 ? `×${mult}` : '';
    }
  }

  private updateToasts(dt: number): void {
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.remainingMs -= dt * 1000;
      if (!t.fading && t.remainingMs <= TOAST_FADE_MS) {
        t.fading = true;
        t.el.classList.add('fade');
      }
      if (t.remainingMs <= 0) {
        t.el.remove();
        this.toasts.splice(i, 1);
      }
    }
  }

  private updateHintCard(ctx: GameContext, dt: number): void {
    const card = this.hintCard;
    if (card === null) return;
    if (!this.hintFading) {
      if (ctx.time.elapsed >= HINT_CARD_S || ctx.inventoryScreen.container !== null) {
        this.hintFading = true;
        this.hintTimer = HINT_FADE_S;
        card.classList.add('fade');
      }
    } else if ((this.hintTimer -= dt) <= 0) {
      card.remove();
      this.hintCard = null;
    }
  }

  private renderDebug(): void {
    const info = this.debugInfo;
    let text = 'Сбор данных…';
    if (info !== null) {
      const keys = Object.keys(info);
      const labels = keys.map((k) => DEBUG_LABELS[k] ?? k);
      const width = Math.max(...labels.map((l) => l.length));
      text = keys
        .map((k, i) => {
          const v = info[k];
          return `${labels[i].padEnd(width)}  ${typeof v === 'number' ? formatNumber(v) : v}`;
        })
        .join('\n');
    }
    if (text !== this.debugText) {
      this.debugText = text;
      this.debugPanel.textContent = text;
    }
  }
}
