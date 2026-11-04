/**
 * Scene, camera, lighting, sky, day/night, fog, shadows, horizon. OWNER: agent "env-fx".
 *
 * Rules: lights are created ONCE (no adding/removing/toggling `visible` or `castShadow` at runtime —
 * that recompiles every shader); unused pooled lights get intensity 0. Exactly ONE shadow-casting
 * DirectionalLight serves as sun by day and moon by night; its shadow map is re-rendered every second
 * frame (shadow.autoUpdate = false + needsUpdate). One FogExp2 instance for the whole session.
 * Physically-correct light units (three r170), 1 unit = 10 cm. renderer.outputColorSpace = SRGB,
 * ACES filmic tone mapping, pixel ratio ≤ RENDER.pixelRatioCap.
 *
 * Time-dependent values (light colours/intensities, sky, fog, exposure) come from env/dayNight.ts; the
 * sky dome, horizon ring, light pool, shadow-box placement and underwater tint live in env/ too.
 * Tone-mapping exposure follows the time of day (eye adaptation: nights are dim but readable).
 */
import * as THREE from 'three';
import { RENDER } from '../config';
import type { GameContext } from '../game/context';
import type { TerrainSampler } from '../gen/types';
import { computeEnvironment, createEnvironment, type Environment } from './env/dayNight';
import { createHorizon } from './env/horizon';
import { PooledLights } from './env/lightPool';
import { placeShadowBox } from './env/shadowBox';
import { SkyDome } from './env/sky';
import { UnderwaterTint } from './env/underwater';
import { sharedUniforms } from './sharedUniforms';
import type { ViewModel } from './viewModel';

/** Light presets owned by env-fx: colour, intensity, range and flicker are set and animated by the pool. */
export type PointLightKind = 'torch' | 'campfire';

export interface PointLightHandle {
  readonly light: THREE.PointLight;
  /** Returns the light to the pool (intensity 0). */
  release(): void;
}

/** Pre-created dynamic lights (RENDER.maxPointLights point lights + the flashlight spot). */
export interface LightPool {
  /**
   * A free point light configured for `kind` (warm colour, range ~4–6 m, flicker animated in
   * GameRenderer.update), or null if all are in use. Callers only set `light.position` and release().
   */
  acquire(kind: PointLightKind): PointLightHandle | null;
  /** Flashlight spot (child of the camera, aimed forward): on/off. */
  setFlashlight(on: boolean): void;
}

/** The sun/moon sits this far from the shadow-box centre; the shadow camera covers twice that in depth. */
const SHADOW_DISTANCE = 600;
/** Shadow-map texel size in world units (≈ 2 cm): the box centre snaps to it. */
const SHADOW_TEXEL = (2 * RENDER.shadowExtent) / RENDER.shadowMapSize;
/** Constant depth bias, world units (converted to the shadow camera's normalised depth below). */
const SHADOW_BIAS_UNITS = 0.15;
/** Lookup offset along the surface normal, world units (~1.5 texels): no acne on voxel faces at a grazing sun. */
const SHADOW_NORMAL_BIAS = 0.3;
/** PCF kernel radius, texels. */
const SHADOW_RADIUS = 1.5;
/** Underwater: fog density multiplier (visibility ≈ 5 m by day) and the teal of fog and sky (dimmed at night). */
const UNDERWATER_FOG_MULT = 30;
const UNDERWATER_COLOR = new THREE.Color(0x1d5c66);

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  /** Main camera (added to the scene so camera-attached lights work). */
  readonly camera: THREE.PerspectiveCamera;
  readonly lights: LightPool;
  /** The single shadow-casting directional light: the sun by day, the moon by night (target in the scene). */
  readonly sun: THREE.DirectionalLight;
  readonly hemisphere: THREE.HemisphereLight;
  /** The pooled point lights (owned by their acquirers while in use); the view model mirrors them. */
  readonly pointLights: readonly THREE.PointLight[];
  /** The flashlight spot (child of the camera, switched with lights.setFlashlight). */
  readonly flashlight: THREE.SpotLight;
  /** The environment of the current frame (colours linear). */
  readonly environment: Readonly<Environment>;

  private readonly env = createEnvironment();
  private readonly fog: THREE.FogExp2;
  private readonly sky = new SkyDome();
  private readonly pool: PooledLights;
  private readonly tint = new UnderwaterTint();
  private readonly underwaterColor = new THREE.Color();
  private readonly drawStats = { drawCalls: 0, triangles: 0 };
  private frame = 0;
  /** Day-clock seconds (speeds up with fast-forward): drives the cloud drift. */
  private cloudTime = 0;
  private underwater = false;
  private moonlight: boolean | null = null;

  /** `terrain` is used to shape the horizon ring of fake terrain outside the 128 m map. */
  constructor(canvas: HTMLCanvasElement, terrain: TerrainSampler) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.fog = new THREE.FogExp2(0xffffff, 0.001);
    scene.fog = this.fog;
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(RENDER.fov, 1, RENDER.near, RENDER.far);
    scene.add(this.camera);
    scene.add(this.sky.mesh);
    scene.add(createHorizon(terrain));

    this.sun = new THREE.DirectionalLight(0xffffff, 0);
    this.sun.name = 'sun';
    this.sun.castShadow = true;
    const shadow = this.sun.shadow;
    shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    const box = shadow.camera;
    box.left = -RENDER.shadowExtent;
    box.right = RENDER.shadowExtent;
    box.top = RENDER.shadowExtent;
    box.bottom = -RENDER.shadowExtent;
    box.near = 1;
    box.far = 2 * SHADOW_DISTANCE;
    box.updateProjectionMatrix();
    shadow.bias = -SHADOW_BIAS_UNITS / (box.far - box.near);
    shadow.normalBias = SHADOW_NORMAL_BIAS;
    shadow.radius = SHADOW_RADIUS;
    shadow.autoUpdate = false;
    shadow.needsUpdate = true;
    scene.add(this.sun, this.sun.target);

    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);
    this.hemisphere.name = 'sky-light';
    scene.add(this.hemisphere);

    this.pool = new PooledLights(scene, this.camera);
    this.lights = this.pool;
    this.pointLights = this.pool.points;
    this.flashlight = this.pool.flashlight;
    this.environment = this.env;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * Per frame: sun/moon direction & colour from ctx.time.timeOfDay, sky dome, fog colour/density,
   * hemisphere light, shadow camera following ctx.player (texel-snapped), pooled light flicker,
   * underwater tint when ctx.player.eyeInWater, sharedUniforms update.
   */
  update(dt: number, ctx: GameContext): void {
    const env = computeEnvironment(ctx.time.timeOfDay, this.env);
    this.cloudTime += dt * ctx.time.speed;
    const camera = this.camera;
    camera.updateMatrixWorld();

    const sun = this.sun;
    sun.color.copy(env.lightColor);
    sun.intensity = env.lightIntensity;
    placeShadowBox(camera.position, env.lightDir, SHADOW_TEXEL, SHADOW_DISTANCE, sun.target.position, sun.position);
    // Every second frame; at once when the light jumps between sun and moon.
    this.frame++;
    sun.shadow.needsUpdate = (this.frame & 1) === 0 || env.moonlight !== this.moonlight;
    this.moonlight = env.moonlight;

    this.hemisphere.color.copy(env.hemiSky);
    this.hemisphere.groundColor.copy(env.hemiGround);
    this.hemisphere.intensity = env.hemiIntensity;

    this.underwater = ctx.player.eyeInWater;
    const dim = 0.08 + 0.92 * env.daylight;
    this.underwaterColor.copy(UNDERWATER_COLOR).multiplyScalar(dim);
    if (this.underwater) {
      this.fog.color.copy(this.underwaterColor);
      this.fog.density = env.fogDensity * UNDERWATER_FOG_MULT;
    } else {
      this.fog.color.copy(env.horizon);
      this.fog.density = env.fogDensity;
    }
    this.renderer.toneMappingExposure = env.exposure;
    this.sky.update(env, camera.position, this.cloudTime, this.underwater ? 1 : 0, this.underwaterColor);
    this.pool.update(ctx.time.elapsed);

    sharedUniforms.uTime.value = ctx.time.elapsed;
    sharedUniforms.uSunDir.value.copy(env.lightDir);
    sharedUniforms.uDaylight.value = env.daylight;
    sharedUniforms.uHorizonColor.value.copy(env.horizon);
    sharedUniforms.uZenithColor.value.copy(env.zenith);
  }

  /**
   * Compiles every shader program in the scene (and the view model's) up front with
   * renderer.compileAsync, so no program compiles mid-game. main.ts awaits it before the start screen.
   */
  async precompile(viewModel: ViewModel | null): Promise<void> {
    this.camera.updateMatrixWorld();
    await this.renderer.compileAsync(this.scene, this.camera);
    if (viewModel !== null) await viewModel.compile(this.renderer);
    await this.renderer.compileAsync(this.tint.scene, this.tint.camera);
    // The shadow pass builds its depth programs the first time it runs: let the next render (still
    // behind the loading screen) do that.
    this.sun.shadow.needsUpdate = true;
  }

  /** Renders the scene, then (if given) the first-person view model on top. */
  render(viewModel: ViewModel | null): void {
    const r = this.renderer;
    r.render(this.scene, this.camera);
    // info is reset after the shadow pass inside render(), so this is the main pass alone.
    this.drawStats.drawCalls = r.info.render.calls;
    this.drawStats.triangles = r.info.render.triangles;
    if (viewModel !== null) viewModel.render(r, this.camera);
    if (this.underwater) this.tint.render(r);
  }

  /** Resizes to the canvas' client size. Also wired to window 'resize' by the constructor. */
  resize(): void {
    const canvas = this.renderer.domElement;
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, RENDER.pixelRatioCap));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Draw calls / triangles of the last main-scene pass (snapshot taken before the view-model overlay; shadow pass excluded). */
  stats(): { drawCalls: number; triangles: number } {
    return { drawCalls: this.drawStats.drawCalls, triangles: this.drawStats.triangles };
  }
}
