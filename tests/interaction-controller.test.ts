import * as THREE from 'three';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { B } from '../src/world/blocks';
import { World } from '../src/world/world';
import { makeVoxelHit, raycastVoxels } from '../src/world/raycast';
import type { GameContext } from '../src/game/context';
import { ITEMS } from '../src/game/items';
import { Interaction } from '../src/game/interaction';
import { FallingBody } from '../src/game/fallingBody';

// Modules of other agents that are still stubs while this one is written.
vi.mock('../src/world/raycast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/world/raycast')>()),
  raycastVoxels: vi.fn(),
}));
vi.mock('../src/game/entities/itemDrop', () => ({
  ItemDrop: class {
    readonly type = 'item';
    removed = false;
    constructor(
      public itemId: string,
      public count: number,
      public pos: unknown,
      public vel?: unknown,
    ) {}
  },
}));
vi.mock('../src/game/entities/campfire', () => ({
  Campfire: class {
    readonly type = 'campfire';
    removed = false;
    constructor(public pos: { x: number; y: number; z: number }) {}
  },
}));
vi.mock('../src/render/voxelModel', async (importOriginal) => {
  const three = await import('three');
  return {
    ...(await importOriginal<typeof import('../src/render/voxelModel')>()),
    buildVoxelGeometry: vi.fn(() => new three.BufferGeometry()),
    getModelMaterial: vi.fn(() => new three.MeshBasicMaterial()),
  };
});

const world = World.create();

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** The voxel and face the (mocked) crosshair ray hits; null = sky. A voxel `accept` refuses is passed (nothing behind it). */
let aim: { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null = null;
vi.mocked(raycastVoxels).mockImplementation((w, _origin, _dir, _max, accept, out) => {
  if (aim === null) return null;
  const id = w.getBlock(aim.x, aim.y, aim.z);
  if (accept === undefined ? id === B.AIR || id === B.WATER : !accept(id, aim.x, aim.y, aim.z)) return null;
  const hit = out ?? makeVoxelHit();
  Object.assign(hit, aim, {
    id,
    distance: 12,
    px: aim.x + 0.5 + aim.nx * 0.5,
    py: aim.y + 0.5 + aim.ny * 0.5,
    pz: aim.z + 0.5 + aim.nz * 0.5,
  });
  return hit;
});

class FakeInventory {
  readonly slots: ({ id: string; count: number } | null)[] = new Array(36).fill(null);
  selected = 0;

  add(id: string, count: number): number {
    const max = ITEMS[id].maxStack;
    for (const s of this.slots) {
      if (s?.id !== id || s.count >= max) continue;
      const n = Math.min(count, max - s.count);
      s.count += n;
      count -= n;
    }
    for (let i = 0; i < this.slots.length && count > 0; i++) {
      if (this.slots[i] !== null) continue;
      const n = Math.min(count, max);
      this.slots[i] = { id, count: n };
      count -= n;
    }
    return count;
  }

  remove(id: string, count: number): number {
    let removed = 0;
    for (let i = this.slots.length - 1; i >= 0 && removed < count; i--) {
      const s = this.slots[i];
      if (s?.id !== id) continue;
      const n = Math.min(s.count, count - removed);
      s.count -= n;
      removed += n;
      if (s.count === 0) this.slots[i] = null;
    }
    return removed;
  }

  count(id: string): number {
    return this.slots.reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);
  }

  selectedStack(): { id: string; count: number } | null {
    return this.slots[this.selected];
  }

  takeFromSlot(index: number, count: number): { id: string; count: number } | null {
    const s = this.slots[index];
    if (s === null) return null;
    const n = Math.min(count, s.count);
    s.count -= n;
    if (s.count === 0) this.slots[index] = null;
    return { id: s.id, count: n };
  }
}

function makeContext() {
  const keysDown = new Set<string>();
  const keysPressed = new Set<string>();
  const buttonsDown = new Set<number>();
  const buttonsPressed = new Set<number>();
  const pending: (() => void)[] = [];
  const added: { type: string; removed: boolean }[] = [];
  const torchLight = { light: new THREE.PointLight(), release: vi.fn() };
  const ctx = {
    world,
    input: {
      active: true,
      isDown: (c: string) => keysDown.has(c),
      pressed: (c: string) => keysPressed.has(c),
      consume: (c: string) => keysPressed.delete(c),
      mouseDown: (b: number) => buttonsDown.has(b),
      mousePressed: (b: number) => buttonsPressed.has(b),
      consumeMouse: (b: number) => buttonsPressed.delete(b),
    },
    player: {
      position: new THREE.Vector3(100, 100, 110.5),
      eye: new THREE.Vector3(100, 116.5, 110.5),
      yaw: -Math.PI / 2, // looking east (+X)
      halfWidth: 3,
      height: 18,
      getLookDir: (out: THREE.Vector3) => out.set(1, 0, 0),
    },
    inventory: new FakeInventory(),
    entities: {
      add: (e: { type: string; removed: boolean }) => (added.push(e), e),
      remove: (e: { removed: boolean }) => void (e.removed = true),
      raycast: vi.fn(() => null),
      solidBoxes: (_region: unknown, out: unknown[] = []) => ((out.length = 0), out),
      emitNoise: vi.fn(),
    },
    hud: { setTarget: vi.fn(), setBreakProgress: vi.fn(), toast: vi.fn(), showNote: vi.fn() },
    particles: { blockBreak: vi.fn(), splash: vi.fn(), dust: vi.fn() },
    audio: { play: vi.fn() },
    viewModel: { swing: vi.fn() },
    renderer: { lights: { setFlashlight: vi.fn(), acquire: vi.fn(() => torchLight) } },
    chunks: {
      whenMeshed: vi.fn((_keys: Iterable<number>, cb: () => void) => void pending.push(cb)),
      holdMeshes: vi.fn(() => ({ add: vi.fn(), release: (cb: () => void) => void pending.push(cb) })),
    },
  };
  return {
    ctx,
    game: ctx as unknown as GameContext,
    inventory: ctx.inventory,
    added,
    torchLight,
    keysDown,
    buttonsDown,
    /** One-frame presses, like Input before endFrame(). */
    press: (...codes: string[]) => codes.forEach((c) => keysPressed.add(c)),
    click: (button: number) => buttonsPressed.add(button),
    /** Runs the whenMeshed callbacks, as ChunkRenderer.update() does once meshes are applied. */
    flushMeshes: () => pending.splice(0).forEach((cb) => cb()),
  };
}

/** The body's mesh is drawn (while syncing it is rendered with an empty draw range, so only its buffers upload). */
const drawn = (body: FallingBody): boolean => body.object.visible && (body.object.children[0] as THREE.Mesh).geometry.drawRange.count > 0;

let t: ReturnType<typeof makeContext>;
let interaction: Interaction;

beforeEach(() => {
  t = makeContext();
  interaction = new Interaction();
  aim = null;
});

describe('Interaction.update', () => {
  test('hand digs a dirt voxel in one swing into the inventory, with HUD, sound and swing', () => {
    fill(90, 99, 90, 110, 100, 110, B.DIRT);
    aim = { x: 95, y: 99, z: 95, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.016, t.game);
    expect(t.ctx.hud.setTarget).toHaveBeenLastCalledWith({ title: 'Земля', hint: 'ЛКМ — копать (лучше лопатой)' });
    expect(interaction.target?.kind).toBe('block');

    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);
    expect(world.getBlock(95, 99, 95)).toBe(B.AIR);
    expect(t.inventory.count('dirt')).toBe(1);
    expect(t.ctx.viewModel.swing).toHaveBeenCalledWith('swing');
    expect(t.ctx.audio.play).toHaveBeenCalledWith('dig_dirt', expect.objectContaining({ pos: { x: 95.5, y: 99.5, z: 95.5 } }));
    expect(t.ctx.particles.blockBreak).toHaveBeenCalledWith(95, 99, 95, B.DIRT, 10, { x: 0, y: 1, z: 0 });
  });

  test('hand on stone needs 8 swings, one per swing time, with growing break progress', () => {
    fill(120, 99, 90, 130, 100, 100, B.STONE);
    aim = { x: 125, y: 99, z: 95, nx: 0, ny: 1, nz: 0 };
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);
    expect(t.ctx.hud.setBreakProgress).toHaveBeenLastCalledWith(0.125);
    interaction.update(0.1, t.game); // still within the 0.28 s swing time
    expect(t.ctx.viewModel.swing).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 6; i++) interaction.update(0.3, t.game);
    expect(world.getBlock(125, 99, 95)).toBe(B.STONE);
    expect(t.ctx.hud.setBreakProgress).toHaveBeenLastCalledWith(0.875);
    interaction.update(0.3, t.game);
    expect(world.getBlock(125, 99, 95)).toBe(B.AIR);
    expect(t.inventory.count('stone')).toBe(1);
  });

  test('damage resets when the target changes', () => {
    fill(140, 99, 90, 150, 100, 100, B.STONE);
    aim = { x: 145, y: 99, z: 95, nx: 0, ny: 1, nz: 0 };
    t.buttonsDown.add(0);
    interaction.update(0.3, t.game);
    interaction.update(0.3, t.game);
    expect(t.ctx.hud.setBreakProgress).toHaveBeenLastCalledWith(0.25);
    aim = { x: 146, y: 99, z: 95, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.3, t.game);
    expect(t.ctx.hud.setBreakProgress).toHaveBeenLastCalledWith(0.125);
  });

  test('a shovel digs a ball of soil with the plants on it; drops are aggregated', () => {
    fill(200, 90, 200, 210, 99, 210, B.DIRT);
    fill(200, 99, 200, 210, 100, 210, B.GRASS);
    world.setBlock(205, 100, 205, B.TALL_GRASS);
    world.setBlock(207, 100, 205, B.TALL_GRASS);
    world.setBlock(205, 100, 208, B.FLOWER_WHITE); // beyond the ball
    t.inventory.slots[0] = { id: 'shovel', count: 1 };
    aim = { x: 205, y: 99, z: 205, nx: 0, ny: 1, nz: 0 };
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);
    expect(t.inventory.count('sod')).toBe(21);
    expect(t.inventory.count('dirt')).toBe(30);
    expect(t.inventory.count('grass_fiber')).toBe(2);
    expect(world.getBlock(205, 100, 208)).toBe(B.FLOWER_WHITE);
    expect(t.ctx.viewModel.swing).toHaveBeenCalledWith('dig');
  });

  test('LMB digs on through an item drop in the hole; a full inventory says so, at most every 3 s', () => {
    fill(600, 90, 600, 610, 100, 610, B.DIRT);
    t.inventory.slots[0] = { id: 'shovel', count: 1 };
    for (let i = 1; i < t.inventory.slots.length; i++) t.inventory.slots[i] = { id: 'stone', count: 1000 };
    const drop = { type: 'item', removed: false, displayName: 'Земля', hint: () => 'E — подобрать', position: new THREE.Vector3(605.5, 100, 605.5) };
    t.ctx.entities.raycast.mockReturnValue({ entity: drop, distance: 5 } as never); // nearer than the ground (12)
    aim = { x: 605, y: 99, z: 605, nx: 0, ny: 1, nz: 0 };
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);
    expect(interaction.target).toMatchObject({ kind: 'entity', entity: drop }); // the HUD and E keep the drop…
    expect(t.ctx.hud.setTarget).toHaveBeenLastCalledWith({ title: 'Земля', hint: 'E — подобрать' });
    expect(world.getBlock(605, 99, 605)).toBe(B.AIR); // …while the shovel digs the ground behind it
    expect(t.added.some((e) => e.type === 'item')).toBe(true); // the dirt that did not fit
    expect(t.ctx.hud.toast).toHaveBeenCalledWith('Инвентарь полон');

    aim = { x: 605, y: 96, z: 605, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.6, t.game);
    expect(world.getBlock(605, 96, 605)).toBe(B.AIR);
    expect(t.ctx.hud.toast).toHaveBeenCalledTimes(1);
  });

  test('swinging at nothing still animates', () => {
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);
    expect(t.ctx.viewModel.swing).toHaveBeenCalledWith('swing');
    expect(t.ctx.audio.play).toHaveBeenCalledWith('swing', expect.anything());
  });

  test('materials are placed as a cube on the clicked face, nearest first, while the stack lasts', () => {
    fill(300, 99, 300, 310, 100, 310, B.STONE);
    t.inventory.slots[0] = { id: 'dirt', count: 10 };
    aim = { x: 305, y: 99, z: 305, nx: 0, ny: 1, nz: 0 };
    t.click(2);
    interaction.update(0.016, t.game);
    expect(world.getBlock(305, 100, 305)).toBe(B.DIRT);
    expect(t.inventory.count('dirt')).toBe(9);
    expect(t.ctx.audio.play).toHaveBeenCalledWith('place', expect.anything());

    t.press('BracketRight', 'BracketRight');
    interaction.update(0.3, t.game); // ] is consumed once per frame
    t.press('BracketRight');
    interaction.update(0.3, t.game);
    expect(interaction.placeSize).toBe(3);
    expect(t.ctx.hud.toast).toHaveBeenLastCalledWith('Размер блока: 3×3×3');

    aim = { x: 302, y: 99, z: 302, nx: 0, ny: 1, nz: 0 };
    t.click(2);
    interaction.update(0.3, t.game);
    expect(t.inventory.count('dirt')).toBe(0);
    let placed = 0;
    for (let y = 100; y < 103; y++) for (let z = 301; z < 304; z++) for (let x = 301; x < 304; x++) if (world.getBlock(x, y, z) === B.DIRT) placed++;
    expect(placed).toBe(9);
    expect(world.getBlock(302, 100, 302)).toBe(B.DIRT); // the anchor first
  });

  test('placement repeats every 0.2 s while RMB is held, and never inside the player', () => {
    fill(320, 99, 300, 330, 100, 310, B.STONE);
    t.inventory.slots[0] = { id: 'planks', count: 100 };
    aim = { x: 325, y: 99, z: 305, nx: 0, ny: 1, nz: 0 };
    t.buttonsDown.add(2);
    interaction.update(0.016, t.game);
    aim = { x: 325, y: 100, z: 305, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.1, t.game);
    expect(world.getBlock(325, 101, 305)).toBe(B.AIR);
    interaction.update(0.15, t.game);
    expect(world.getBlock(325, 101, 305)).toBe(B.PLANKS);

    t.ctx.player.position.set(325.5, 102, 305.5); // standing right on top
    aim = { x: 325, y: 101, z: 305, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.25, t.game);
    expect(world.getBlock(325, 102, 305)).toBe(B.AIR);
  });

  test('a cut tree falls away from the player and lies on the ground once settled', () => {
    fill(80, 99, 80, 180, 100, 140, B.DIRT);
    fill(109, 100, 110, 111, 150, 112, B.OAK_LOG); // 2×2 trunk, 5 m
    for (let y = 144; y <= 156; y++) {
      for (let z = 105; z <= 117; z++) {
        for (let x = 104; x <= 116; x++) {
          if ((x - 110) ** 2 + (y - 150) ** 2 + (z - 111) ** 2 <= 36 && world.getBlock(x, y, z) === B.AIR) world.setBlock(x, y, z, B.OAK_LEAVES);
        }
      }
    }
    t.inventory.slots[0] = { id: 'axe', count: 1 };
    aim = { x: 109, y: 101, z: 110, nx: -1, ny: 0, nz: 0 };
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);

    expect(t.inventory.count('wood')).toBeGreaterThan(8);
    const body = t.added.find((e): e is FallingBody => e instanceof FallingBody);
    expect(body).toBeDefined();
    expect(world.getBlock(110, 140, 111)).toBe(B.AIR); // removed from the world while it falls
    expect(world.getBlock(110, 150, 111)).toBe(B.AIR);
    expect(drawn(body!)).toBe(false); // until the world meshes no longer show the tree
    t.flushMeshes();
    expect(drawn(body!)).toBe(true);

    let frames = 0;
    for (; frames < 600 && !body!.removed; frames++) {
      body!.update(1 / 60, t.game);
      t.flushMeshes();
    }
    expect(body!.removed).toBe(true);
    expect(frames).toBeGreaterThan(90); // a 5.6 m tree takes a couple of seconds to come down (≈2.5 s)
    expect(frames).toBeLessThan(6.5 * 60);
    expect(t.ctx.audio.play).toHaveBeenCalledWith('tree_fall', expect.anything());
    expect(t.ctx.particles.dust).toHaveBeenCalled();

    let east = 0;
    let standing = 0;
    for (let y = 100; y < 160; y++) {
      for (let z = 100; z < 125; z++) {
        for (let x = 100; x < 170; x++) {
          if (world.getBlock(x, y, z) !== B.OAK_LOG) continue;
          if (x >= 115 && y < 125) east++;
          if (x < 112 && y >= 125) standing++;
        }
      }
    }
    expect(east).toBeGreaterThan(60);
    expect(standing).toBe(0);
  });

  test('swings at a tree still leaving the world in slices take none of it: the crosshair passes it, no brush reaches it', () => {
    fill(870, 99, 870, 960, 100, 960, B.DIRT);
    fill(900, 100, 900, 902, 170, 902, B.OAK_LOG); // a 2×2 trunk, 7 m, in a crown 1.2 m deep: three write slices
    for (let y = 130; y <= 170; y++) for (let z = 888; z < 914; z++) for (let x = 888; x < 914; x++) if (world.getBlock(x, y, z) === B.AIR) world.setBlock(x, y, z, B.OAK_LEAVES);
    t.inventory.slots[0] = { id: 'axe', count: 1 };
    aim = { x: 900, y: 101, z: 900, nx: -1, ny: 0, nz: 0 };
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game); // cut through: its first slice (the trunk, the leaves nearest it) leaves the world
    const body = t.added.find((e): e is FallingBody => e instanceof FallingBody)!;
    expect(t.ctx.chunks.holdMeshes).toHaveBeenCalledTimes(1);
    expect(world.getBlock(912, 170, 912)).toBe(B.OAK_LEAVES); // the crown's rim is not out yet
    aim = { x: 912, y: 170, z: 912, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.6, t.game);
    expect(interaction.target).toBeNull(); // passed: as if gone already
    world.setBlock(914, 170, 912, B.OAK_LOG); // a log put by the rim since: no part of the tree
    const wood = t.inventory.count('wood');
    aim = { x: 914, y: 170, z: 912, nx: 1, ny: 0, nz: 0 };
    interaction.update(0.6, t.game);
    expect(world.getBlock(914, 170, 912)).toBe(B.AIR); // the log is dug…
    expect(t.inventory.count('wood') - wood).toBe(1);
    expect(world.getBlock(913, 170, 912)).toBe(B.OAK_LEAVES); // …the rim in its brush is not
    expect(world.getBlock(912, 170, 912)).toBe(B.OAK_LEAVES);
    for (let i = 0; i < 10 && world.getBlock(912, 170, 912) !== B.AIR; i++) body.update(1 / 60, t.game);
    expect(world.getBlock(912, 170, 912)).toBe(B.AIR); // vacated: it falls with the body, and lands once
  });

  test('one-shot keys: E interacts, Q throws one item (Shift+Q the stack), R toggles precise mode', () => {
    const door = { type: 'door', removed: false, displayName: 'Дверь', interact: vi.fn(), hint: () => 'E — открыть дверь', position: new THREE.Vector3(), height: 20 };
    t.ctx.entities.raycast.mockReturnValue({ entity: door, distance: 5 } as never);
    t.press('KeyE');
    interaction.update(0.016, t.game);
    expect(door.interact).toHaveBeenCalledTimes(1);
    expect(t.ctx.hud.setTarget).toHaveBeenLastCalledWith({ title: 'Дверь', hint: 'E — открыть дверь' });

    t.ctx.entities.raycast.mockReturnValue(null);
    t.inventory.slots[0] = { id: 'apple', count: 5 };
    t.press('KeyQ');
    interaction.update(0.016, t.game);
    expect(t.inventory.count('apple')).toBe(4);
    t.keysDown.add('ShiftLeft');
    t.press('KeyQ');
    interaction.update(0.016, t.game);
    expect(t.inventory.count('apple')).toBe(0);
    const thrown = t.added.filter((e) => e.type === 'item') as unknown as { itemId: string; count: number; vel: { x: number } }[];
    expect(thrown.map((d) => d.count)).toEqual([1, 4]);
    expect(thrown[0].vel.x).toBeGreaterThan(0); // forward (+X)

    t.press('KeyR');
    interaction.update(0.016, t.game);
    expect(interaction.precise).toBe(true);
    expect(t.ctx.hud.toast).toHaveBeenLastCalledWith('Точный режим: включён');
  });

  test('RMB uses: eat food, read a note, toggle the flashlight, place a campfire on the ground', () => {
    t.inventory.slots[0] = { id: 'apple', count: 2 };
    t.click(2);
    interaction.update(0.016, t.game);
    expect(t.inventory.count('apple')).toBe(1);
    expect(t.ctx.hud.toast).toHaveBeenLastCalledWith(ITEMS.apple.food!.message);
    expect(t.ctx.audio.play).toHaveBeenCalledWith('eat');

    t.inventory.slots[0] = { id: 'newspaper', count: 1 };
    t.click(2);
    interaction.update(0.016, t.game);
    expect(t.ctx.hud.showNote).toHaveBeenCalledWith(t.game, ITEMS.newspaper.note!.title, ITEMS.newspaper.note!.text);

    t.inventory.slots[0] = { id: 'flashlight', count: 1 };
    interaction.update(0.016, t.game);
    expect(t.ctx.renderer.lights.setFlashlight).toHaveBeenLastCalledWith(false);
    t.click(2);
    interaction.update(0.016, t.game);
    interaction.update(0.016, t.game);
    expect(interaction.flashlightOn).toBe(true);
    expect(t.ctx.renderer.lights.setFlashlight).toHaveBeenLastCalledWith(true);
    t.inventory.selected = 1; // put away: the light goes out but stays switched on
    interaction.update(0.016, t.game);
    expect(t.ctx.renderer.lights.setFlashlight).toHaveBeenLastCalledWith(false);
    expect(interaction.flashlightOn).toBe(true);

    fill(400, 99, 400, 410, 100, 410, B.GRASS);
    world.setBlock(406, 100, 405, B.TALL_GRASS);
    t.inventory.selected = 0;
    t.inventory.slots[0] = { id: 'campfire', count: 1 };
    aim = { x: 405, y: 99, z: 405, nx: 1, ny: 0, nz: 0 }; // side face: refused
    t.click(2);
    interaction.update(0.016, t.game);
    expect(t.ctx.hud.toast).toHaveBeenLastCalledWith('Костёр ставится на землю');
    aim = { x: 405, y: 99, z: 405, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.016, t.game);
    expect(t.ctx.hud.setTarget).toHaveBeenLastCalledWith({ title: 'Дёрн', hint: 'ЛКМ — копать (лучше лопатой) · ПКМ — поставить костёр' });
    t.click(2);
    interaction.update(0.016, t.game);
    const fire = t.added.find((e) => e.type === 'campfire') as unknown as { pos: { x: number; y: number; z: number } };
    expect(fire.pos).toEqual({ x: 405.5, y: 100, z: 405.5 });
    expect(t.inventory.count('campfire')).toBe(0);
    expect(world.getBlock(406, 100, 405)).toBe(B.AIR); // trampled
  });

  test('a held torch takes a pooled light near the hand and gives it back', () => {
    t.inventory.slots[0] = { id: 'torch', count: 2 };
    interaction.update(0.016, t.game);
    expect(t.ctx.renderer.lights.acquire).toHaveBeenCalledWith('torch');
    const p = t.torchLight.light.position;
    expect(p.x).toBeCloseTo(103); // 0.3 m ahead (east)
    expect(p.y).toBeCloseTo(114.5); // 0.2 m below the eye
    expect(p.z).toBeCloseTo(110.5 + 2.5); // the right hand is south when facing east
    interaction.update(0.016, t.game);
    expect(t.ctx.renderer.lights.acquire).toHaveBeenCalledTimes(1);
    t.inventory.selected = 3;
    interaction.update(0.016, t.game);
    expect(t.torchLight.release).toHaveBeenCalledTimes(1);
  });

  test('no gameplay input while a screen is open: target and HUD cleared', () => {
    fill(500, 99, 500, 510, 100, 510, B.DIRT);
    aim = { x: 505, y: 99, z: 505, nx: 0, ny: 1, nz: 0 };
    interaction.update(0.016, t.game);
    expect(interaction.target).not.toBeNull();
    t.ctx.input.active = false;
    t.buttonsDown.add(0);
    interaction.update(0.016, t.game);
    expect(interaction.target).toBeNull();
    expect(t.ctx.hud.setTarget).toHaveBeenLastCalledWith(null);
    expect(t.ctx.viewModel.swing).not.toHaveBeenCalled();
    expect(world.getBlock(505, 99, 505)).toBe(B.DIRT);
  });
});
