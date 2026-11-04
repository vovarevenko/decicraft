import { describe, expect, test, vi } from 'vitest';
import { Input } from '../src/game/input';

type Listener = (e: unknown) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Listener[]>();
  readonly options = new Map<string, unknown>();

  addEventListener(type: string, fn: Listener, options?: unknown): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
    if (options !== undefined) this.options.set(type, options);
  }

  emit(type: string, e: object = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

class FakeDocument extends FakeTarget {
  pointerLockElement: unknown = null;
  visibilityState: 'visible' | 'hidden' = 'visible';
  readonly exitPointerLock = vi.fn();

  constructor(readonly defaultView: FakeTarget) {
    super();
  }
}

class FakeCanvas extends FakeTarget {
  /** What requestPointerLock() does: grant (locks on the next microtask), reject (Chromium) or fire 'pointerlockerror'. */
  mode: 'grant' | 'reject' | 'error' | 'both' | 'throw' | 'pending' = 'grant';
  readonly requestPointerLock = vi.fn((): Promise<void> | undefined => {
    switch (this.mode) {
      case 'grant':
        return Promise.resolve().then(() => {
          this.ownerDocument.pointerLockElement = this;
          this.ownerDocument.emit('pointerlockchange');
        });
      case 'reject':
        return Promise.reject(new DOMException('refused', 'NotAllowedError'));
      case 'error':
        queueMicrotask(() => this.ownerDocument.emit('pointerlockerror'));
        return undefined;
      case 'both':
        queueMicrotask(() => this.ownerDocument.emit('pointerlockerror'));
        return Promise.reject(new DOMException('refused', 'NotAllowedError'));
      case 'throw':
        throw new DOMException('no', 'WrongDocumentError');
      case 'pending':
        return new Promise<void>(() => {});
    }
  });

  constructor(readonly ownerDocument: FakeDocument) {
    super();
  }
}

function setup() {
  const win = new FakeTarget();
  const doc = new FakeDocument(win);
  const canvas = new FakeCanvas(doc);
  const input = new Input(canvas as unknown as HTMLCanvasElement);
  const lockEvents: boolean[] = [];
  input.onLockChange = (locked) => lockEvents.push(locked);
  const key = (type: 'keydown' | 'keyup', code: string, extra: object = {}) => {
    const e = { code, repeat: false, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), ...extra };
    win.emit(type, e);
    return e;
  };
  const tap = (code: string) => {
    key('keydown', code);
    key('keyup', code);
  };
  const mouse = (type: 'mousedown' | 'mouseup', button: number) => win.emit(type, { button });
  const move = (movementX: number, movementY: number) => doc.emit('mousemove', { movementX, movementY });
  const wheel = (deltaY: number, deltaMode: number, timeStamp: number) => win.emit('wheel', { deltaY, deltaMode, timeStamp });
  const lock = () => {
    doc.pointerLockElement = canvas;
    doc.emit('pointerlockchange');
  };
  const unlock = () => {
    doc.pointerLockElement = null;
    doc.emit('pointerlockchange');
  };
  return { win, doc, canvas, input, lockEvents, key, tap, mouse, move, wheel, lock, unlock };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('keys', () => {
  test('pressed / isDown / released are edge-triggered per frame', () => {
    const { input, key } = setup();
    key('keydown', 'KeyW');
    expect(input.pressed('KeyW')).toBe(true);
    expect(input.isDown('KeyW')).toBe(true);
    expect(input.released('KeyW')).toBe(false);
    input.endFrame();
    expect(input.pressed('KeyW')).toBe(false);
    expect(input.isDown('KeyW')).toBe(true);
    key('keyup', 'KeyW');
    expect(input.released('KeyW')).toBe(true);
    expect(input.isDown('KeyW')).toBe(false);
    input.endFrame();
    expect(input.released('KeyW')).toBe(false);
  });

  test('a tap between two frames still counts as a press', () => {
    const { input, tap } = setup();
    tap('KeyE');
    expect(input.pressed('KeyE')).toBe(true);
    expect(input.released('KeyE')).toBe(true);
    expect(input.isDown('KeyE')).toBe(false);
  });

  test('consume() takes the press away from every later reader this frame', () => {
    const { input, key, tap } = setup();
    key('keydown', 'KeyE');
    key('keydown', 'KeyQ');
    expect(input.consume('KeyE')).toBe(true);
    expect(input.consume('KeyE')).toBe(false);
    expect(input.pressed('KeyE')).toBe(false);
    expect(input.isDown('KeyE')).toBe(true);
    expect(input.pressed('KeyQ')).toBe(true);
    expect(input.consume('KeyX')).toBe(false);
    input.endFrame();
    expect(input.consume('KeyE')).toBe(false); // still held, no new press
    key('keyup', 'KeyE');
    input.endFrame();
    tap('KeyE');
    expect(input.consume('KeyE')).toBe(true);
  });

  test('presses and consume() work while a UI is open', () => {
    const { input, key, lock } = setup();
    lock();
    input.setUiOpen(true);
    expect(input.active).toBe(false);
    key('keydown', 'Escape');
    key('keydown', 'Digit3');
    expect(input.consume('Escape')).toBe(true);
    expect(input.consume('Digit3')).toBe(true);
  });

  test('auto-repeat is not a new press; a repeat for an unseen key only holds it', () => {
    const { input, key } = setup();
    key('keydown', 'KeyW');
    input.endFrame();
    key('keydown', 'KeyW', { repeat: true });
    expect(input.pressed('KeyW')).toBe(false);
    key('keydown', 'KeyD', { repeat: true });
    expect(input.isDown('KeyD')).toBe(true);
    expect(input.pressed('KeyD')).toBe(false);
  });

  test('Tab, F3, Backquote, Space and arrows are default-prevented, other keys are not', () => {
    const { key } = setup();
    for (const code of ['Tab', 'F3', 'Backquote', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(key('keydown', code).preventDefault).toHaveBeenCalled();
      expect(key('keyup', code).preventDefault).toHaveBeenCalled();
    }
    expect(key('keydown', 'KeyW').preventDefault).not.toHaveBeenCalled();
    expect(key('keydown', 'Escape').preventDefault).not.toHaveBeenCalled();
  });

  test('Ctrl/⌘ combinations are ignored; releasing ⌘ forgets keys whose keyup macOS swallows', () => {
    const { input, key } = setup();
    key('keydown', 'KeyW', { ctrlKey: true });
    key('keydown', 'KeyS', { metaKey: true });
    expect(input.pressed('KeyW') || input.isDown('KeyW') || input.isDown('KeyS')).toBe(false);
    expect(key('keydown', 'Tab', { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(input.isDown('Tab')).toBe(false);
    key('keydown', 'KeyA');
    key('keydown', 'MetaLeft', { metaKey: true });
    key('keyup', 'MetaLeft');
    expect(input.isDown('KeyA')).toBe(false);
    expect(input.released('KeyA')).toBe(true);
  });

  test('blur and hiding the page release every key and button', () => {
    const { win, doc, input, key, mouse } = setup();
    key('keydown', 'KeyW');
    mouse('mousedown', 0);
    win.emit('blur');
    expect(input.isDown('KeyW')).toBe(false);
    expect(input.released('KeyW')).toBe(true);
    expect(input.mouseDown(0)).toBe(false);
    expect(input.mouseReleased(0)).toBe(true);
    input.endFrame();

    key('keydown', 'KeyS');
    doc.visibilityState = 'hidden';
    doc.emit('visibilitychange');
    expect(input.isDown('KeyS')).toBe(false);
  });
});

describe('mouse', () => {
  test('buttons: held, pressed, consumeMouse, released', () => {
    const { input, mouse } = setup();
    mouse('mousedown', 2);
    expect(input.mouseDown(2)).toBe(true);
    expect(input.mousePressed(2)).toBe(true);
    expect(input.consumeMouse(2)).toBe(true);
    expect(input.consumeMouse(2)).toBe(false);
    expect(input.mousePressed(2)).toBe(false);
    expect(input.mouseDown(2)).toBe(true);
    expect(input.mousePressed(0)).toBe(false);
    input.endFrame();
    expect(input.mouseDown(2)).toBe(true);
    mouse('mouseup', 2);
    expect(input.mouseReleased(2)).toBe(true);
    expect(input.mouseDown(2)).toBe(false);
    input.endFrame();
    expect(input.mouseReleased(2)).toBe(false);
    expect(input.mouseDown(7)).toBe(false);
  });

  test('movement accumulates only while locked; glitch jumps are dropped', () => {
    const { input, move, lock, unlock } = setup();
    move(10, 5);
    expect([input.mouseDX, input.mouseDY]).toEqual([0, 0]);
    lock();
    move(10, 5);
    move(-3, 2);
    move(4000, 0);
    expect([input.mouseDX, input.mouseDY]).toEqual([7, 7]);
    input.endFrame();
    expect([input.mouseDX, input.mouseDY]).toEqual([0, 0]);
    unlock();
    move(10, 5);
    expect(input.mouseDX).toBe(0);
  });

  test('a button held while the lock is gained (the resume click) is not a gameplay press', () => {
    const { input, mouse, lock } = setup();
    mouse('mousedown', 0);
    lock();
    expect(input.mouseDown(0)).toBe(false);
    expect(input.mousePressed(0)).toBe(false);
    mouse('mouseup', 0);
    expect(input.mouseReleased(0)).toBe(false);
    mouse('mousedown', 0);
    expect(input.mousePressed(0)).toBe(true);
  });

  test('the context menu is suppressed on the canvas; the wheel listener is passive', () => {
    const { canvas, win } = setup();
    const e = { preventDefault: vi.fn() };
    canvas.emit('contextmenu', e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(win.options.get('wheel')).toEqual({ passive: true });
  });
});

describe('wheel', () => {
  test('line and page mode: one step per notch', () => {
    const { input, wheel } = setup();
    wheel(3, 1, 0);
    wheel(3, 1, 10);
    wheel(-1, 2, 20);
    expect(input.wheel).toBe(1);
    input.endFrame();
    expect(input.wheel).toBe(0);
    wheel(-3, 1, 30);
    expect(input.wheel).toBe(-1);
  });

  test('pixel mode: one step per ~50 px with a ~100 ms cooldown', () => {
    const { input, wheel } = setup();
    wheel(30, 0, 1000);
    expect(input.wheel).toBe(0);
    wheel(30, 0, 1016);
    expect(input.wheel).toBe(1);
    // Momentum within the cooldown is swallowed.
    for (let t = 1032; t < 1110; t += 16) wheel(40, 0, t);
    expect(input.wheel).toBe(1);
    // After the cooldown it accumulates again.
    wheel(40, 0, 1130);
    wheel(40, 0, 1146);
    expect(input.wheel).toBe(2);
    input.endFrame();
    // Opposite direction.
    wheel(-60, 0, 1400);
    expect(input.wheel).toBe(-1);
  });

  test('pixel mode: a pause starts a new gesture (partial sums do not carry over)', () => {
    const { input, wheel } = setup();
    wheel(45, 0, 0);
    wheel(10, 0, 1000);
    expect(input.wheel).toBe(0);
    wheel(45, 0, 1100);
    expect(input.wheel).toBe(1);
  });
});

describe('pointer lock', () => {
  test('Input never locks by itself; requestLock() resolves true once locked', async () => {
    const { canvas, input, lockEvents, key, mouse } = setup();
    key('keydown', 'KeyW');
    mouse('mousedown', 0);
    expect(canvas.requestPointerLock).not.toHaveBeenCalled();
    const granted = input.requestLock();
    expect(input.requestLock()).toBe(granted);
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
    await expect(granted).resolves.toBe(true);
    expect(input.locked).toBe(true);
    expect(input.active).toBe(true);
    expect(lockEvents).toEqual([true]);
    await expect(input.requestLock()).resolves.toBe(true);
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
  });

  test('UI screens release the lock and re-request it when they close', async () => {
    const { doc, canvas, input, lockEvents, lock, unlock } = setup();
    lock();
    input.setUiOpen(true);
    expect(input.uiOpen).toBe(true);
    expect(input.active).toBe(false);
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    unlock();
    expect(lockEvents).toEqual([true, false]);
    input.setUiOpen(true);
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    input.setUiOpen(false);
    expect(input.uiOpen).toBe(false);
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(1);
    await flush();
    expect(input.active).toBe(true);
    expect(lockEvents).toEqual([true, false, true]);
  });

  test.each(['reject', 'error', 'both', 'throw'] as const)('a refused request (%s) resolves false and reports onLockChange(false) once', async (mode) => {
    const { canvas, input, lockEvents } = setup();
    canvas.mode = mode;
    await expect(input.requestLock()).resolves.toBe(false);
    await flush();
    expect(lockEvents).toEqual([false]);
    expect(input.locked).toBe(false);
    // A later request is a fresh one.
    canvas.mode = 'grant';
    await expect(input.requestLock()).resolves.toBe(true);
    expect(lockEvents).toEqual([false, true]);
  });

  test('closing a UI when the browser refuses to re-lock reports the refusal (→ pause menu)', async () => {
    const { canvas, input, lockEvents, lock, unlock } = setup();
    lock();
    input.setUiOpen(true);
    unlock();
    canvas.mode = 'reject';
    input.setUiOpen(false);
    await flush();
    expect(lockEvents).toEqual([true, false, false]);
    expect(input.active).toBe(false);
  });

  test('losing the lock (Esc) reports false; a pending request does not block later reports', () => {
    const { canvas, input, lockEvents, lock, unlock } = setup();
    canvas.mode = 'pending';
    void input.requestLock();
    lock();
    unlock();
    expect(lockEvents).toEqual([true, false]);
    expect(input.locked).toBe(false);
  });

  test('releaseLock() exits the lock only while it is held (fatal error screen)', () => {
    const { doc, input, lockEvents, lock, unlock } = setup();
    input.releaseLock();
    expect(doc.exitPointerLock).not.toHaveBeenCalled();
    lock();
    input.releaseLock();
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    unlock();
    expect(lockEvents).toEqual([true, false]);
    expect(input.active).toBe(false);
  });

  test("'active' stays overridable on the instance (main.ts ?autostart)", () => {
    const { input } = setup();
    Object.defineProperty(input, 'active', { get: () => !input.uiOpen });
    expect(input.active).toBe(true);
    input.setUiOpen(true);
    expect(input.active).toBe(false);
  });
});
