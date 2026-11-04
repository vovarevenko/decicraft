import * as THREE from 'three';

/**
 * Uniform objects shared by several materials (voxel terrain, water, plants, cm-models, particles).
 * The environment (render/renderer.ts) updates the values every frame; materials put these very
 * objects into their `uniforms`, so nothing else needs per-frame material updates.
 */
export const sharedUniforms = {
  /** Seconds since start (animation of water ripples, plant sway, fire). */
  uTime: { value: 0 },
  /** Normalised direction TO the sun by day / the moon by night, world space. */
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
  /** 0 = deep night … 1 = full day. */
  uDaylight: { value: 1 },
  /** Linear sky colour near the horizon (water reflections, fog-like tints). */
  uHorizonColor: { value: new THREE.Color(0.62, 0.72, 0.85) },
  /** Linear sky colour at the zenith. */
  uZenithColor: { value: new THREE.Color(0.25, 0.45, 0.8) },
};
