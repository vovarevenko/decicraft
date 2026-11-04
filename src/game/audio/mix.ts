/**
 * Pure mixing helpers (no WebAudio): distance attenuation, pitch jitter, day/night activity curves, wind
 * gusts and the ambience mix — everything the audio graph is driven by, testable in node.
 */
import { mod, smoothstep, type Vec3Like } from '../../core/math';

/** PannerNode refDistance for one-shots (world units = 2 m): full volume up to here. */
export const REF_DISTANCE = 20;
/** Positional sounds farther than this (world units = 60 m) are not played. */
export const MAX_DISTANCE = 600;
/** Lapping water is audible up to this distance from the nearest water column (world units = 18 m). */
export const SHORE_RANGE = 180;

/** 0..1, NaN → 0. */
export const unit = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/** All three coordinates are finite. */
export const isFinite3 = (p: Vec3Like): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

/** Gain of the 'inverse' distance model, as PannerNode applies it: 1 within `ref`, ≈ ref / d beyond. */
export function distanceGain(distance: number, ref = REF_DISTANCE, rolloff = 1): number {
  return distance > ref ? ref / (ref + rolloff * (distance - ref)) : 1;
}

/** `pitch` randomised by ±`spread` (a fraction) with `r` uniform in [0, 1). */
export function pitchJitter(pitch: number, spread: number, r: number): number {
  return pitch * (1 + spread * (2 * r - 1));
}

/** 1 by day, 0 at night; smooth over dawn (≈ 4:50–6:25) and dusk (≈ 19:50–21:20). */
export function daylight(hour: number): number {
  const h = mod(hour, 24);
  return smoothstep(4.8, 6.4, h) * (1 - smoothstep(19.8, 21.3, h));
}

/** 1 at night, 0 by day: crickets start at dusk (20–22 h) and fall silent at dawn (4–5:50). */
export function nightness(hour: number): number {
  const h = mod(hour, 24);
  return unit(1 - smoothstep(4, 5.8, h) + smoothstep(20, 22, h));
}

/** Birdsong peaks: the dawn chorus around 6:20 and a smaller one at dusk (0..1). */
export function chorus(hour: number): number {
  return Math.max(bump(hour, 6.3, 1.2), 0.6 * bump(hour, 19.6, 1));
}

/** Gaussian bump on the 24 h circle. */
function bump(hour: number, centre: number, width: number): number {
  const d = Math.abs(mod(hour - centre + 12, 24) - 12);
  return Math.exp(-(d * d) / (width * width));
}

/** Wind strength 0..1 at audio time `t` (s): incommensurate slow waves, so gusts never repeat. */
export function gustAt(t: number): number {
  return unit(
    0.5 +
      0.26 * Math.sin(0.23 * t) +
      0.16 * Math.sin(0.61 * t + 1.3) +
      0.1 * Math.sin(1.47 * t + 4.1) +
      0.06 * Math.sin(3.1 * t + 0.7),
  );
}

/** Lapping-water level by the distance (world units) to the nearest water column. */
export function shoreGain(distance: number): number {
  const k = 1 - distance / SHORE_RANGE;
  return k > 0 ? k * k : 0;
}

/** Ambience layer levels, each 0..1 (scaled by AMBIENCE_LEVELS when applied). */
export interface AmbienceMix {
  /** Low wind: always outdoors, stronger on the hills and up high, calmer in the town. */
  wind: number;
  /** Whistling wind on exposed heights. */
  whistle: number;
  /** Leaves rustling (forest, scattered trees elsewhere). */
  foliage: number;
  /** Bird activity by day (forest, meadow; little in the town). */
  birds: number;
  /** Night insects. */
  crickets: number;
  /** How much the outdoors is muffled by walls and roofs (0 = open sky). */
  muffle: number;
}

export const createAmbienceMix = (): AmbienceMix => ({ wind: 0, whistle: 0, foliage: 0, birds: 0, crickets: 0, muffle: 0 });

/**
 * Ambience levels from the biome blend under the listener `weights` = [town, forest, meadow, hills]
 * (sum 1), the in-game `hour`, the `height` above the base ground level (world units) and the
 * `enclosure` (0 = open sky, 1 = under a roof all around). Continuous in every input, also across
 * midnight; every output is in [0, 1].
 */
export function ambienceMix(weights: ArrayLike<number>, hour: number, height: number, enclosure: number, out: AmbienceMix): AmbienceMix {
  const town = unit(weights[0]);
  const forest = unit(weights[1]);
  const meadow = unit(weights[2]);
  const hills = unit(weights[3]);
  const day = unit(daylight(hour));
  const night = unit(nightness(hour));
  const lift = height > 0 ? smoothstep(30, 170, height) : 0;
  const muffle = unit(enclosure);
  const open = 1 - 0.8 * muffle;
  const calm = 1 - 0.45 * town;
  out.wind = unit((0.3 + 0.3 * hills + 0.4 * lift) * calm * (0.85 + 0.15 * day)) * open;
  out.whistle = unit(0.55 * hills * (0.35 + 0.65 * lift) + 0.45 * lift) * calm * open;
  out.foliage = unit(forest + 0.3 * hills + 0.15 * meadow + 0.1 * town) * open;
  out.birds = unit((forest + 0.75 * meadow + 0.3 * hills + 0.12 * town) * day * (0.75 + 0.25 * chorus(hour))) * open;
  out.crickets = unit((meadow + 0.6 * forest + 0.4 * hills + 0.3 * town) * night) * open;
  out.muffle = muffle;
  return out;
}
