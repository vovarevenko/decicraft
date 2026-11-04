/**
 * Pre-created dynamic lights: RENDER.maxPointLights point lights and the flashlight spot. They are
 * added once and never removed, hidden or re-flagged (that would recompile every shader); an unused
 * light simply has intensity 0. OWNER: agent "env-fx".
 *
 * Intensities are three.js physical units (candela, decay 2) at 1 unit = 10 cm, i.e. ~100× their
 * metre-scale values, balanced against a ~2.7 sun: a torch noticeably lights walls and the ground
 * 4–6 m around it, a campfire somewhat more; the flashlight reaches ~15–20 m.
 */
import * as THREE from 'three';
import { RENDER } from '../../config';
import type { LightPool, PointLightHandle, PointLightKind } from '../renderer';

interface Preset {
  color: THREE.Color;
  /** Flicker pulls the colour towards this one as the flame dims. */
  dimColor: THREE.Color;
  intensity: number;
  /** Cut-off range (world units). */
  distance: number;
  /** Relative flicker depth (0..1) and speed. */
  flicker: number;
  speed: number;
}

export const LIGHT_PRESETS: Readonly<Record<PointLightKind, Preset>> = {
  torch: {
    color: new THREE.Color(0xffa04a),
    dimColor: new THREE.Color(0xff7a2a),
    intensity: 1000,
    distance: 120,
    flicker: 0.16,
    speed: 1.4,
  },
  campfire: {
    color: new THREE.Color(0xff8a38),
    dimColor: new THREE.Color(0xff5e1a),
    intensity: 1600,
    distance: 160,
    flicker: 0.22,
    speed: 0.9,
  },
};

const FLASHLIGHT_COLOR = 0xfff1dc;
const FLASHLIGHT_INTENSITY = 5000;
const FLASHLIGHT_DISTANCE = 300;
const FLASHLIGHT_ANGLE = 0.5;
const FLASHLIGHT_PENUMBRA = 0.5;
/** Where released lights wait (far below the world, intensity 0). */
const PARKED_Y = -1000;

interface Slot {
  readonly light: THREE.PointLight;
  preset: Preset | null;
  /** Bumped on every acquire, so a stale handle cannot release the light from its next owner. */
  generation: number;
  /** Flicker phase offset. */
  phase: number;
}

/** Smooth pseudo-random flicker in about [-1, 1] from three incommensurate sines. */
function flickerWave(t: number, phase: number): number {
  return 0.5 * Math.sin(t * 11.3 + phase) + 0.3 * Math.sin(t * 17.9 + phase * 2.3) + 0.2 * Math.sin(t * 6.1 + phase * 3.7);
}

export class PooledLights implements LightPool {
  /** The pooled point lights (in the scene; the view model mirrors them). */
  readonly points: readonly THREE.PointLight[];
  /** Flashlight spot: child of the camera, its target too, aimed straight ahead. */
  readonly flashlight: THREE.SpotLight;
  private readonly slots: Slot[] = [];

  constructor(scene: THREE.Scene, camera: THREE.Camera) {
    const points: THREE.PointLight[] = [];
    for (let i = 0; i < RENDER.maxPointLights; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 1, 2);
      light.name = `pooled-light-${i}`;
      light.castShadow = false;
      light.position.set(0, PARKED_Y, 0);
      scene.add(light);
      points.push(light);
      this.slots.push({ light, preset: null, generation: 0, phase: 0 });
    }
    this.points = points;

    const spot = new THREE.SpotLight(FLASHLIGHT_COLOR, 0, FLASHLIGHT_DISTANCE, FLASHLIGHT_ANGLE, FLASHLIGHT_PENUMBRA, 2);
    spot.name = 'flashlight';
    spot.castShadow = false;
    spot.target.position.set(0, 0, -1);
    camera.add(spot);
    camera.add(spot.target);
    this.flashlight = spot;
  }

  acquire(kind: PointLightKind): PointLightHandle | null {
    let free = 0;
    while (free < this.slots.length && this.slots[free].preset !== null) free++;
    // Callers retry every frame while the pool is exhausted, so this path allocates nothing.
    if (free === this.slots.length) return null;
    const slot = this.slots[free];
    const preset = LIGHT_PRESETS[kind];
    const generation = ++slot.generation;
    slot.preset = preset;
    slot.phase = Math.random() * 100;
    slot.light.color.copy(preset.color);
    slot.light.distance = preset.distance;
    slot.light.intensity = preset.intensity;
    return {
      light: slot.light,
      release: () => {
        if (slot.generation !== generation || slot.preset === null) return;
        slot.preset = null;
        slot.light.intensity = 0;
        slot.light.position.set(0, PARKED_Y, 0);
      },
    };
  }

  setFlashlight(on: boolean): void {
    this.flashlight.intensity = on ? FLASHLIGHT_INTENSITY : 0;
  }

  /** Number of point lights currently handed out. */
  get inUse(): number {
    let n = 0;
    for (const s of this.slots) if (s.preset !== null) n++;
    return n;
  }

  /** Animates the flicker of every acquired light; `time` in seconds. */
  update(time: number): void {
    for (const s of this.slots) {
      const p = s.preset;
      if (p === null) continue;
      const w = flickerWave(time * p.speed, s.phase);
      s.light.intensity = p.intensity * (1 + p.flicker * w);
      s.light.color.lerpColors(p.color, p.dimColor, Math.max(0, -w) * 0.6);
    }
  }
}
