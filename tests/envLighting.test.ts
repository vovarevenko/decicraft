import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import { RENDER } from '../src/config';
import { LIGHT_PRESETS, PooledLights } from '../src/render/env/lightPool';
import { placeShadowBox } from '../src/render/env/shadowBox';
import { UnderwaterTint } from '../src/render/env/underwater';

function makePool() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  return { scene, camera, pool: new PooledLights(scene, camera) };
}

describe('PooledLights', () => {
  test('creates every light once: pooled points in the scene, flashlight and its target on the camera', () => {
    const { scene, camera, pool } = makePool();
    expect(pool.points.length).toBe(RENDER.maxPointLights);
    for (const light of pool.points) {
      expect(light.parent).toBe(scene);
      expect(light.intensity).toBe(0);
      expect(light.decay).toBe(2);
      expect(light.castShadow).toBe(false);
    }
    expect(pool.flashlight.parent).toBe(camera);
    expect(pool.flashlight.target.parent).toBe(camera);
    expect(pool.flashlight.castShadow).toBe(false);
    expect(pool.flashlight.intensity).toBe(0);
    pool.setFlashlight(true);
    expect(pool.flashlight.intensity).toBeGreaterThan(0);
    pool.setFlashlight(false);
    expect(pool.flashlight.intensity).toBe(0);
  });

  test('acquire applies the preset, runs out at the pool size and release returns the light', () => {
    const { scene, pool } = makePool();
    const lightsBefore = scene.children.length;
    const handles = [];
    for (let i = 0; i < RENDER.maxPointLights; i++) {
      const h = pool.acquire(i % 2 === 0 ? 'torch' : 'campfire');
      expect(h).not.toBeNull();
      handles.push(h!);
    }
    expect(pool.acquire('torch')).toBeNull();
    expect(pool.inUse).toBe(RENDER.maxPointLights);
    expect(handles[0].light.intensity).toBe(LIGHT_PRESETS.torch.intensity);
    expect(handles[0].light.color.equals(LIGHT_PRESETS.torch.color)).toBe(true);
    expect(handles[1].light.distance).toBe(LIGHT_PRESETS.campfire.distance);

    handles[0].release();
    expect(handles[0].light.intensity).toBe(0);
    expect(pool.inUse).toBe(RENDER.maxPointLights - 1);
    const again = pool.acquire('campfire');
    expect(again?.light).toBe(handles[0].light);
    // A stale handle must not switch off the light's new owner.
    handles[0].release();
    expect(again!.light.intensity).toBeGreaterThan(0);
    expect(pool.inUse).toBe(RENDER.maxPointLights);
    expect(scene.children.length).toBe(lightsBefore); // nothing added or removed at runtime
  });

  test('flicker stays within the preset depth and leaves free lights dark', () => {
    const { pool } = makePool();
    const torch = pool.acquire('torch')!;
    const { intensity, flicker } = LIGHT_PRESETS.torch;
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 20; t += 0.013) {
      pool.update(t);
      lo = Math.min(lo, torch.light.intensity);
      hi = Math.max(hi, torch.light.intensity);
      for (const light of pool.points) if (light !== torch.light) expect(light.intensity).toBe(0);
    }
    expect(lo).toBeGreaterThanOrEqual(intensity * (1 - flicker) - 1e-6);
    expect(hi).toBeLessThanOrEqual(intensity * (1 + flicker) + 1e-6);
    expect(hi - lo).toBeGreaterThan(intensity * flicker * 0.5);
  });
});

describe('placeShadowBox', () => {
  const texel = (2 * RENDER.shadowExtent) / RENDER.shadowMapSize;

  /** Light-space (right, up, depth) coordinates, same basis as placeShadowBox / Matrix4.lookAt. */
  function lightSpace(p: THREE.Vector3, dir: THREE.Vector3): [number, number, number] {
    const right = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
    const up = new THREE.Vector3().crossVectors(dir, right);
    return [p.dot(right), p.dot(up), p.dot(dir)];
  }

  test('centres the box on the focus, snapped to whole texels across the light', () => {
    const dir = new THREE.Vector3(0.3, 0.8, -0.4).normalize();
    const target = new THREE.Vector3();
    const light = new THREE.Vector3();
    for (const focus of [new THREE.Vector3(640.37, 135.2, 512.91), new THREE.Vector3(12.5, 300, 1100.04)]) {
      placeShadowBox(focus, dir, texel, 600, target, light);
      const [fx, fy, fz] = lightSpace(focus, dir);
      const [tx, ty, tz] = lightSpace(target, dir);
      expect(Math.abs(tx - fx)).toBeLessThanOrEqual(texel / 2 + 1e-6);
      expect(Math.abs(ty - fy)).toBeLessThanOrEqual(texel / 2 + 1e-6);
      expect(tz).toBeCloseTo(fz, 6);
      expect(Math.abs(tx / texel - Math.round(tx / texel))).toBeLessThan(1e-4);
      expect(Math.abs(ty / texel - Math.round(ty / texel))).toBeLessThan(1e-4);
      expect(light.clone().sub(target).normalize().distanceTo(dir)).toBeLessThan(1e-9);
      expect(light.distanceTo(target)).toBeCloseTo(600, 6);
    }
  });

  test('matches the shadow camera basis (lookAt from the light to the target, up +Y)', () => {
    const dir = new THREE.Vector3(-0.5, 0.6, 0.2).normalize();
    const target = new THREE.Vector3();
    const light = new THREE.Vector3();
    placeShadowBox(new THREE.Vector3(100, 120, 300), dir, texel, 600, target, light);
    const cam = new THREE.OrthographicCamera();
    cam.position.copy(light);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const [rx] = lightSpace(right, dir);
    expect(rx).toBeCloseTo(1, 9);
  });

  test('a straight-up light still has a basis', () => {
    const target = new THREE.Vector3();
    const light = new THREE.Vector3();
    placeShadowBox(new THREE.Vector3(10, 20, 30), new THREE.Vector3(0, 1, 0), texel, 600, target, light);
    expect(Number.isFinite(target.x + target.y + target.z)).toBe(true);
    expect(light.y - target.y).toBeCloseTo(600, 6);
  });
});

describe('UnderwaterTint', () => {
  test('multiplies the framebuffer by a blue-green transmittance instead of blending a dark teal over it', () => {
    const tint = new UnderwaterTint();
    const quad = tint.scene.children[0] as THREE.Mesh;
    const m = quad.material as THREE.MeshBasicMaterial;
    // r170, non-premultiplied MultiplyBlending: blendFunc(ZERO, SRC_COLOR), i.e. framebuffer × colour.
    expect(m.blending).toBe(THREE.MultiplyBlending);
    expect(m.premultipliedAlpha).toBe(false);
    expect(m.opacity).toBe(1);
    expect([m.toneMapped, m.fog, m.depthTest]).toEqual([false, false, false]);
    // The colour reaches the framebuffer as sRGB (no tone mapping): red is absorbed most, green and blue pass.
    const t = m.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    expect(t.r).toBeLessThan(0.5);
    expect(Math.min(t.g, t.b)).toBeGreaterThan(0.7);
  });
});
