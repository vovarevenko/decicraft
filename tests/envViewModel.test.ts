import * as THREE from 'three';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RENDER } from '../src/config';
import type { GameContext } from '../src/game/context';
import { computeEnvironment, createEnvironment } from '../src/render/env/dayNight';
import { ViewModel } from '../src/render/viewModel';
import { B } from '../src/world/blocks';

const art = vi.hoisted(() => ({ handFails: false }));

vi.mock('../src/render/models', async () => {
  const THREE = await import('three');
  return {
    getHandGeometry: () => {
      if (art.handFails) throw new Error('hand model not ready');
      return new THREE.BoxGeometry(0.8, 0.9, 3).translate(0, 0, 0.6);
    },
    getItemGeometry: (id: string) => {
      if (id === 'broken') throw new Error('item model not ready');
      return new THREE.BoxGeometry(0.3, 5, 0.3).translate(0, 2.5, 0);
    },
    getItemHoldPose: () => ({ position: [1.6, -1.4, -3.6], rotation: [-0.4, 0.1, 0], scale: 1 }),
  };
});

const DT = 1 / 60;

function makeCtx() {
  const env = computeEnvironment(13, createEnvironment());
  const world = {
    roofY: 0,
    getBlock(_x: number, y: number) {
      return this.roofY > 0 && y >= this.roofY && y < this.roofY + 3 ? B.CONCRETE : B.AIR;
    },
    skyHeight() {
      return this.roofY > 0 ? this.roofY + 3 : 0;
    },
    canopyHeight() {
      return this.skyHeight();
    },
  };
  const parts = {
    renderer: {
      environment: env,
      sun: new THREE.DirectionalLight(0xfff0dc, env.lightIntensity),
      hemisphere: new THREE.HemisphereLight(0xbfd0ea, 0x8a7a62, env.hemiIntensity),
      pointLights: Array.from({ length: RENDER.maxPointLights }, () => new THREE.PointLight(0xffa04a, 0, 120, 2)),
      flashlight: new THREE.SpotLight(0xfff1dc, 0),
    },
    camera: new THREE.PerspectiveCamera(75, 1.6, 0.5, 4000),
    world,
    player: {
      yaw: 0,
      pitch: 0,
      horizontalSpeed: 0,
      onGround: true,
      flying: false,
      inWater: 0,
      sprinting: false,
      velocity: new THREE.Vector3(),
    },
    time: { elapsed: 0, timeOfDay: 13, speed: 1 },
  };
  parts.camera.position.set(640, 136.5, 640);
  return { ...parts, ctx: parts as unknown as GameContext };
}

function run(vm: ViewModel, ctx: GameContext, seconds: number): void {
  for (let t = 0; t < seconds; t += DT) {
    ctx.time.elapsed += DT;
    vm.update(DT, ctx);
  }
}

function worldPosition(vm: ViewModel, name: string): THREE.Vector3 {
  vm.scene.updateMatrixWorld(true);
  const object = vm.scene.getObjectByName(name);
  expect(object).toBeDefined();
  return object!.getWorldPosition(new THREE.Vector3());
}

afterEach(() => {
  art.handFails = false;
  vi.restoreAllMocks();
});

describe('ViewModel models', () => {
  test('builds the hand lazily and closes it around the held item’s grip', () => {
    const { ctx } = makeCtx();
    const vm = new ViewModel();
    expect(vm.scene.getObjectByName('hand')).toBeUndefined();
    vm.setItem(null);
    vm.update(DT, ctx);
    const hand = vm.scene.getObjectByName('hand') as THREE.Mesh;
    expect(hand).toBeDefined();
    vm.setItem('axe');
    const item = vm.scene.getObjectByName('held-axe') as THREE.Mesh;
    expect(item.visible).toBe(true);
    expect(item.position.toArray()).toEqual([1.6, -1.4, -3.6]);
    expect(hand.position.distanceTo(item.position)).toBeLessThan(1.5);
    vm.setItem('axe'); // same id every frame: nothing rebuilt
    expect(vm.scene.getObjectsByProperty('name', 'held-axe').length).toBe(1);
    vm.setItem(null);
    expect(item.visible).toBe(false);
  });

  test('a failing item model warns once and leaves the bare hand', () => {
    const { ctx } = makeCtx();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vm = new ViewModel();
    vm.setItem('broken');
    vm.update(DT, ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vm.scene.getObjectByName('hand')).toBeDefined();
    vm.setItem(null);
    vm.setItem('broken');
    vm.update(DT, ctx);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('without a hand model nothing is drawn until an item is held', () => {
    art.handFails = true;
    const { ctx, camera } = makeCtx();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const vm = new ViewModel();
    vm.setItem(null);
    vm.update(DT, ctx);
    expect(warn).toHaveBeenCalledTimes(1);
    const renderer = { autoClear: true, clearDepth: vi.fn(), render: vi.fn() };
    vm.render(renderer as unknown as THREE.WebGLRenderer, camera);
    expect(renderer.render).not.toHaveBeenCalled();

    vm.setItem('shovel');
    vm.update(DT, ctx);
    vm.render(renderer as unknown as THREE.WebGLRenderer, camera);
    expect(renderer.clearDepth).toHaveBeenCalledTimes(1);
    expect(renderer.render).toHaveBeenCalledWith(vm.scene, vm.camera);
    expect(renderer.autoClear).toBe(true);
    expect(vm.camera.aspect).toBe(camera.aspect);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('compile() compiles the overlay through a stand-in mesh it removes afterwards', async () => {
    const vm = new ViewModel();
    const before = vm.scene.getObjectsByProperty('isMesh', true).length;
    let meshesDuringCompile = 0;
    const renderer = {
      compileAsync: vi.fn(async (scene: THREE.Scene) => {
        meshesDuringCompile = scene.getObjectsByProperty('isMesh', true).length;
        return scene;
      }),
    };
    await vm.compile(renderer as unknown as THREE.WebGLRenderer);
    expect(renderer.compileAsync).toHaveBeenCalledWith(vm.scene, vm.camera);
    expect(meshesDuringCompile).toBe(before + 1);
    expect(vm.scene.getObjectsByProperty('isMesh', true).length).toBe(before);
  });
});

describe('ViewModel animation', () => {
  /** A view model and an untouched control fed identical frames: their difference is the animation alone. */
  function pair(item: string | null) {
    const a = makeCtx();
    const b = makeCtx();
    const vm = new ViewModel();
    const control = new ViewModel();
    vm.setItem(item);
    control.setItem(item);
    const name = item === null ? 'hand' : `held-${item}`;
    return {
      vm,
      control,
      player: a.player,
      step(seconds: number) {
        run(vm, a.ctx, seconds);
        run(control, b.ctx, seconds);
      },
      offset: () => worldPosition(vm, name).sub(worldPosition(control, name)),
    };
  }

  test('swing clips move the item and return it to rest', () => {
    const t = pair('axe');
    t.step(1);
    expect(t.offset().length()).toBeLessThan(1e-9);

    t.vm.swing('chop');
    t.step(0.25);
    expect(t.offset().length()).toBeGreaterThan(0.5);
    t.step(0.8);
    expect(t.offset().length()).toBeLessThan(0.01);

    t.vm.swing('eat');
    t.step(0.4);
    const mouth = t.offset();
    expect(mouth.x).toBeLessThan(-0.5); // towards the screen centre…
    expect(mouth.z).toBeGreaterThan(0.5); // …and the face
    t.step(1);
    expect(t.offset().length()).toBeLessThan(0.01);

    for (const kind of ['swing', 'dig', 'use', 'place'] as const) {
      t.vm.swing(kind);
      t.step(0.1);
      expect(t.offset().length()).toBeGreaterThan(0.2);
      t.step(1);
      expect(t.offset().length()).toBeLessThan(0.01);
    }
  });

  test('switching items raises the new one from below', () => {
    const t = pair('axe');
    t.step(1);
    t.vm.setItem('shovel'); // same mocked model and hold pose as the control's axe
    t.step(DT);
    const raised = () => worldPosition(t.vm, 'held-shovel').sub(worldPosition(t.control, 'held-axe'));
    expect(raised().y).toBeLessThan(-1);
    t.step(0.5);
    expect(raised().length()).toBeLessThan(0.01);
  });

  test('walking bobs the hand, standing still settles it', () => {
    const t = pair(null);
    t.step(1);
    t.player.horizontalSpeed = 38;
    let spread = 0;
    for (let i = 0; i < 60; i++) {
      t.step(DT);
      spread = Math.max(spread, t.offset().length());
    }
    expect(spread).toBeGreaterThan(0.08);
    t.player.horizontalSpeed = 0;
    t.step(2);
    expect(t.offset().length()).toBeLessThan(0.01);
  });
});

describe('ViewModel lighting', () => {
  test('mirrors the sun into camera space and shades it under a roof', () => {
    const { ctx, camera, renderer, world } = makeCtx();
    const env = renderer.environment;
    camera.rotation.set(0.2, Math.PI / 2, 0, 'YXZ');
    camera.updateMatrixWorld();
    const vm = new ViewModel();
    vm.setItem(null);
    run(vm, ctx, 0.5);
    const sun = vm.scene.getObjectByName('view-model-sun') as THREE.DirectionalLight;
    const expected = env.lightDir.clone().applyQuaternion(camera.quaternion.clone().invert());
    expect(sun.position.clone().normalize().distanceTo(expected)).toBeLessThan(1e-6);
    expect(sun.intensity).toBeCloseTo(renderer.sun.intensity, 3);
    const sky = vm.scene.getObjectByName('view-model-sky') as THREE.HemisphereLight;
    expect(sky.intensity).toBeCloseTo(renderer.hemisphere.intensity, 3);

    world.roofY = 160; // a concrete slab above the eye: no sun, dim sky
    run(vm, ctx, 3);
    expect(sun.intensity).toBeLessThan(renderer.sun.intensity * 0.05);
    expect(sky.intensity).toBeLessThan(renderer.hemisphere.intensity * 0.75);
  });

  test('mirrors pooled point lights, kept off the hand', () => {
    const { ctx, camera, renderer } = makeCtx();
    const vm = new ViewModel();
    vm.setItem(null);
    const torch = renderer.pointLights[0];
    torch.intensity = 1000;
    torch.position.copy(camera.position).add(new THREE.Vector3(2.5, -2, -3));
    const far = renderer.pointLights[1];
    far.intensity = 1600;
    far.position.copy(camera.position).add(new THREE.Vector3(0, -10, -40));
    run(vm, ctx, DT);
    const hand = vm.scene.getObjectByName('hand') as THREE.Mesh;
    const mirrored = vm.scene.getObjectByName('view-model-light-0') as THREE.PointLight;
    expect(mirrored.intensity).toBe(1000);
    expect(mirrored.color.equals(torch.color)).toBe(true);
    expect(mirrored.position.distanceTo(hand.position)).toBeGreaterThanOrEqual(12 - 1e-6);
    const second = vm.scene.getObjectByName('view-model-light-1') as THREE.PointLight;
    expect(second.position.toArray().map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, -10, -40]);
    expect((vm.scene.getObjectByName('view-model-light-2') as THREE.PointLight).intensity).toBe(0);

    torch.intensity = 0;
    run(vm, ctx, DT);
    expect(mirrored.intensity).toBe(0);
  });

  test('torch glow at the tip; the flashlight lens glows only while switched on', () => {
    const { ctx, renderer } = makeCtx();
    const vm = new ViewModel();
    const sprites = () => vm.scene.getObjectsByProperty('isSprite', true) as THREE.Sprite[];
    vm.setItem('torch');
    run(vm, ctx, 0.5);
    const lit = sprites().filter((s) => s.visible);
    expect(lit.length).toBe(2);
    const item = vm.scene.getObjectByName('held-torch') as THREE.Mesh;
    const tip = new THREE.Vector3(0, 5 - 0.3, 0).applyMatrix4(item.matrix);
    for (const s of lit) expect(s.position.distanceTo(tip)).toBeLessThan(1e-6);

    vm.setItem('flashlight');
    run(vm, ctx, DT);
    expect(sprites().filter((s) => s.visible).length).toBe(0);
    renderer.flashlight.intensity = 5000;
    run(vm, ctx, DT);
    expect(sprites().filter((s) => s.visible).length).toBe(1);
    vm.setItem(null);
    run(vm, ctx, DT);
    expect(sprites().filter((s) => s.visible).length).toBe(0);
  });
});
