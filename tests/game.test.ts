import { afterAll, describe, expect, test, vi } from 'vitest';
import type { GameContext } from '../src/game/context';
import { Game } from '../src/game/game';

// The browser parts the loop touches; frames run when the test says so.
const frames: ((now: number) => void)[] = [];
vi.stubGlobal('document', { hidden: false, addEventListener: vi.fn() });
vi.stubGlobal('window', { addEventListener: vi.fn() });
vi.stubGlobal('requestAnimationFrame', (fn: (now: number) => void) => frames.push(fn));
afterAll(() => {
  vi.unstubAllGlobals();
});

/** A context whose systems only record their calls. */
function makeContext() {
  return {
    input: {
      onLockChange: null as ((locked: boolean) => void) | null,
      uiOpen: false,
      active: false,
      wheel: 0,
      consume: () => false,
      isDown: () => false,
      endFrame: vi.fn(),
      requestLock: vi.fn(),
    },
    time: { elapsed: 0, timeOfDay: 12, speed: 1 },
    camera: {},
    player: { update: vi.fn(), applyToCamera: vi.fn(), position: { x: 0, y: 0, z: 0 } },
    interaction: { update: vi.fn() },
    entities: { update: vi.fn(), all: [] },
    world: { flush: vi.fn(), allocatedChunks: 0 },
    renderer: { update: vi.fn(), render: vi.fn(), stats: () => ({ drawCalls: 0, triangles: 0 }) },
    particles: { update: vi.fn() },
    viewModel: { setItem: vi.fn(), update: vi.fn() },
    inventory: { selected: 0, selectedStack: () => null },
    audio: { update: vi.fn(), setPaused: vi.fn() },
    chunks: { update: vi.fn(), stats: () => ({ visibleNodes: 0, triangles: 0, pendingJobs: 0, cachedNodes: 0 }) },
    inventoryScreen: { isOpen: false, update: vi.fn() },
    map: { isOpen: false, update: vi.fn() },
    hud: { update: vi.fn(), setDebug: vi.fn(), toggleDebug: vi.fn() },
    menu: { showPause: vi.fn(), hidePause: vi.fn() },
    terrain: { biomeAt: () => 0 },
  };
}

describe('Game', () => {
  test('paused, the world stands still and the chunk renderer meshes on without game time', () => {
    const ctx = makeContext();
    const game = new Game(ctx as unknown as GameContext);
    let now = performance.now();
    game.start();
    now += 16;
    frames.shift()!(now);
    expect(ctx.entities.update).toHaveBeenCalledTimes(1);
    expect(ctx.chunks.update.mock.lastCall![1]).toBeGreaterThan(0);
    ctx.input.onLockChange!(false); // Esc: the pointer is free, the pause menu opens
    expect(ctx.menu.showPause).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      now += 16;
      frames.shift()!(now);
    }
    expect(ctx.entities.update).toHaveBeenCalledTimes(1); // no write in slices goes on…
    expect(ctx.chunks.update).toHaveBeenCalledTimes(4);
    expect(ctx.chunks.update.mock.lastCall).toEqual([ctx.camera, 0]); // …and no hold on its meshes times out
  });
});
