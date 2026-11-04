/**
 * Keyboard / mouse input with pointer lock. OWNER: agent "player".
 *
 * Keys are KeyboardEvent.code strings ('KeyW', 'Space', 'ShiftLeft', 'Digit1', 'BracketLeft', 'F3', …).
 * NEVER bind Ctrl/Meta combinations (Ctrl+W closes the browser tab). Tab, F3, Backquote, Space and the
 * arrow keys are preventDefault-ed. Per-frame state (pressed/released/consumed, mouse delta, wheel) is
 * cleared by endFrame(), which the game loop calls after every system has run.
 *
 * ONE-SHOT KEYS: anything that toggles UI or triggers a one-shot action must read the key with
 * `consume()` / `consumeMouse()` so that a later system in the same frame cannot react to the same press
 * (e.g. E opens a container → the inventory screen must not close on that same E).
 *
 * POINTER LOCK: Input never requests the lock on its own (no click-to-lock). game.ts / the menus call
 * requestLock() from user gestures; setUiOpen(false) re-requests it. Any failed request (Chrome refuses
 * re-locking for ~1 s after Esc; Esc is not a user gesture) reports onLockChange(false).
 *
 * Keys pressed together with Ctrl or ⌘ are browser shortcuts: not recorded, not prevented. Held keys and
 * buttons are released when the window loses focus or the page is hidden; mouse buttons held while the
 * lock is gained (the click on «Продолжить») do not count as gameplay presses.
 */

/** Keys whose browser default (focus traversal, find, page scrolling, button activation) is suppressed. */
const NO_DEFAULT = new Set(['Tab', 'F3', 'Backquote', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
/** Mouse buttons tracked: left, middle, right, back, forward. */
const BUTTONS = 5;
/** Pixel-mode wheels: one hotbar step per this many pixels… */
const WHEEL_STEP_PX = 50;
/** …and no further step for this long, so trackpad momentum does not race through the hotbar. */
const WHEEL_COOLDOWN_MS = 100;
/** A pause longer than this starts a new scroll gesture (a leftover partial sum is dropped). */
const WHEEL_GESTURE_GAP_MS = 250;
/** Pointer-locked moves larger than this in a single event are browser glitches around lock changes. */
const MAX_MOUSE_STEP = 500;

const preventDefault = (e: Event): void => e.preventDefault();

export class Input {
  /** Accumulated mouse movement since the last endFrame() (pixels), only while pointer-locked. */
  mouseDX = 0;
  mouseDY = 0;
  /**
   * Hotbar scroll steps since the last endFrame(): +1 per step down, -1 per step up. Line/page-mode
   * wheels give one step per notch; pixel-mode wheels (Mac trackpads) accumulate deltaY and emit one
   * step per ~50 px with a ~100 ms cooldown.
   */
  wheel = 0;
  /** Called when pointer lock is gained (true) or lost/refused (false). */
  onLockChange: ((locked: boolean) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly doc: Document;
  private readonly held = new Set<string>();
  /** Keys that went down / up this frame, and presses consumed this frame. */
  private readonly downNow = new Set<string>();
  private readonly upNow = new Set<string>();
  private readonly consumed = new Set<string>();
  private readonly buttonHeld = new Uint8Array(BUTTONS);
  private readonly buttonDown = new Uint8Array(BUTTONS);
  private readonly buttonUp = new Uint8Array(BUTTONS);
  private readonly buttonConsumed = new Uint8Array(BUTTONS);
  private isLocked: boolean;
  private ui = false;
  /** The pending requestLock() promise and its resolver (null when no request is in flight). */
  private lockRequest: Promise<boolean> | null = null;
  private settleLock: ((locked: boolean) => void) | null = null;
  private wheelPixels = 0;
  private wheelLastMs = -Infinity;
  private wheelReadyMs = -Infinity;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const doc = canvas.ownerDocument;
    const win = doc.defaultView;
    if (win === null) throw new Error('Input: the canvas is not attached to a window');
    this.doc = doc;
    this.isLocked = doc.pointerLockElement === canvas;
    win.addEventListener('keydown', this.onKeyDown);
    win.addEventListener('keyup', this.onKeyUp);
    win.addEventListener('mousedown', this.onMouseDown);
    win.addEventListener('mouseup', this.onMouseUp);
    win.addEventListener('wheel', this.onWheel, { passive: true });
    win.addEventListener('blur', this.releaseAll);
    doc.addEventListener('mousemove', this.onMouseMove);
    doc.addEventListener('pointerlockchange', this.onPointerLockChange);
    doc.addEventListener('pointerlockerror', this.onLockRefused);
    doc.addEventListener('visibilitychange', this.onVisibilityChange);
    canvas.addEventListener('contextmenu', preventDefault);
  }

  /** Pointer is locked to the canvas. */
  get locked(): boolean {
    return this.isLocked;
  }

  /** An in-game UI screen (inventory, map, note) is open: pointer released, gameplay input ignored. The pause menu is NOT a UI here (game.ts handles it). */
  get uiOpen(): boolean {
    return this.ui;
  }

  /** Gameplay input is live: locked && !uiOpen. Systems must ignore gameplay input when false. */
  get active(): boolean {
    return this.isLocked && !this.ui;
  }

  /** Opening a UI releases pointer lock; closing it calls requestLock(). */
  setUiOpen(open: boolean): void {
    if (open === this.ui) return;
    this.ui = open;
    if (open) {
      if (this.isLocked) this.doc.exitPointerLock();
    } else {
      void this.requestLock();
    }
  }

  /** Requests pointer lock on the canvas; resolves true when locked, false if refused (also reported via onLockChange(false)). */
  requestLock(): Promise<boolean> {
    if (this.isLocked) return Promise.resolve(true);
    if (this.lockRequest !== null) return this.lockRequest;
    const request = new Promise<boolean>((resolve) => {
      this.settleLock = resolve;
    });
    this.lockRequest = request;
    try {
      // Chromium returns a promise that rejects on refusal; other browsers fire 'pointerlockerror'.
      const pending = this.canvas.requestPointerLock() as Promise<void> | undefined;
      pending?.catch(this.onLockRefused);
    } catch {
      this.onLockRefused();
    }
    return request;
  }

  /** Exits pointer lock if held (the fatal error screen needs the cursor); reported via onLockChange(false). */
  releaseLock(): void {
    if (this.isLocked) this.doc.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** True only during the frame the key went down (and it was not consumed). Works while a UI is open too. */
  pressed(code: string): boolean {
    return this.downNow.has(code) && !this.consumed.has(code);
  }

  /** Like pressed(), but marks the press as used: later pressed()/consume() calls this frame return false. */
  consume(code: string): boolean {
    if (!this.pressed(code)) return false;
    this.consumed.add(code);
    return true;
  }

  released(code: string): boolean {
    return this.upNow.has(code);
  }

  /** 0 = left, 1 = middle, 2 = right. */
  mouseDown(button: number): boolean {
    return this.buttonHeld[button] === 1;
  }

  mousePressed(button: number): boolean {
    return this.buttonDown[button] === 1 && this.buttonConsumed[button] === 0;
  }

  /** Consuming variant of mousePressed(). */
  consumeMouse(button: number): boolean {
    if (!this.mousePressed(button)) return false;
    this.buttonConsumed[button] = 1;
    return true;
  }

  mouseReleased(button: number): boolean {
    return this.buttonUp[button] === 1;
  }

  endFrame(): void {
    this.downNow.clear();
    this.upNow.clear();
    this.consumed.clear();
    this.buttonDown.fill(0);
    this.buttonUp.fill(0);
    this.buttonConsumed.fill(0);
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey) return; // a browser shortcut: neither game input nor ours to prevent
    if (NO_DEFAULT.has(e.code)) e.preventDefault();
    if (this.held.has(e.code)) return;
    this.held.add(e.code);
    // A repeat for a key we have not seen go down (pressed before the window had focus) only holds it.
    if (!e.repeat) this.downNow.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (NO_DEFAULT.has(e.code)) e.preventDefault();
    // macOS delivers no keyup for keys released while ⌘ is held: forget every key when ⌘ goes up.
    if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
      this.releaseAll();
      return;
    }
    if (this.held.delete(e.code)) this.upNow.add(e.code);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const b = e.button;
    if (b < 0 || b >= BUTTONS || this.buttonHeld[b] === 1) return;
    this.buttonHeld[b] = 1;
    this.buttonDown[b] = 1;
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const b = e.button;
    if (b < 0 || b >= BUTTONS || this.buttonHeld[b] === 0) return;
    this.buttonHeld[b] = 0;
    this.buttonUp[b] = 1;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked) return;
    const dx = e.movementX;
    const dy = e.movementY;
    if (Math.abs(dx) > MAX_MOUSE_STEP || Math.abs(dy) > MAX_MOUSE_STEP) return;
    this.mouseDX += dx;
    this.mouseDY += dy;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    const d = e.deltaY;
    if (d === 0) return;
    if (e.deltaMode !== 0) {
      this.wheel += d > 0 ? 1 : -1; // DOM_DELTA_LINE / DOM_DELTA_PAGE: one step per notch
      return;
    }
    const now = e.timeStamp;
    if (now - this.wheelLastMs > WHEEL_GESTURE_GAP_MS) this.wheelPixels = 0;
    this.wheelLastMs = now;
    if (now < this.wheelReadyMs) return;
    this.wheelPixels += d;
    if (Math.abs(this.wheelPixels) < WHEEL_STEP_PX) return;
    this.wheel += this.wheelPixels > 0 ? 1 : -1;
    this.wheelPixels = 0;
    this.wheelReadyMs = now + WHEEL_COOLDOWN_MS;
  };

  private readonly onPointerLockChange = (): void => {
    const locked = this.doc.pointerLockElement === this.canvas;
    if (locked === this.isLocked) return;
    this.isLocked = locked;
    if (locked) {
      // The click that asked for the lock (start screen, «Продолжить») must not dig or place.
      this.buttonHeld.fill(0);
      this.buttonDown.fill(0);
    }
    this.finishLockRequest(locked);
    this.onLockChange?.(locked);
  };

  /** A refused request: reported once, whether the browser rejects the promise, fires 'pointerlockerror', or both. */
  private readonly onLockRefused = (): void => {
    if (this.settleLock === null) return;
    this.finishLockRequest(false);
    this.onLockChange?.(false);
  };

  private readonly onVisibilityChange = (): void => {
    if (this.doc.visibilityState === 'hidden') this.releaseAll();
  };

  /** Every held key and button goes up (focus lost: their keyup/mouseup events will never arrive). */
  private readonly releaseAll = (): void => {
    for (const code of this.held) this.upNow.add(code);
    this.held.clear();
    for (let b = 0; b < BUTTONS; b++) {
      if (this.buttonHeld[b] === 0) continue;
      this.buttonHeld[b] = 0;
      this.buttonUp[b] = 1;
    }
  };

  private finishLockRequest(locked: boolean): void {
    const settle = this.settleLock;
    this.settleLock = null;
    this.lockRequest = null;
    settle?.(locked);
  }
}
