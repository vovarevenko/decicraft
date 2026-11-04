/** Small numeric helpers shared by main thread and workers (no three.js dependency). */

export const TAU = Math.PI * 2;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (v - a) / (b - a);
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  b0 + (b1 - b0) * ((v - a0) / (a1 - a0));

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Positive modulo. */
export const mod = (a: number, n: number): number => ((a % n) + n) % n;

/** Frame-rate independent exponential smoothing factor: `x += (target - x) * damp(rate, dt)`. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/** Shortest signed angle difference b - a in (-π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** 0xRRGGBB → [r, g, b] in 0..255. */
export function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/** sRGB channel (0..1) → linear (0..1). */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
