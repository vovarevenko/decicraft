/**
 * Day/night model: pure functions of the in-game hour, no allocations per call. OWNER: agent "env-fx".
 *
 * The sun follows the path of a summer day at ~55° N: it rises in the east at SUNRISE_HOUR, culminates
 * in the south at ≈ 50° at SOLAR_NOON_HOUR and sets in the west at SUNSET_HOUR (≈ −20° at solar
 * midnight). The moon runs the same arc twelve hours out of phase, i.e. on the opposite side of the
 * sky: it rises around sunset and stands high in the south at solar midnight, so nights are moonlit.
 *
 * Everything else — light colours and intensities, sky gradient, glow, clouds, fog, stars, exposure —
 * is keyed on the sun's elevation (sunrise and sunset therefore look alike). Key colours are sRGB hex
 * and interpolated in linear space. Light intensities are three.js physical units (directional /
 * hemisphere: irradiance; outgoing radiance = albedo · irradiance / π), balanced for ACES filmic tone
 * mapping. `exposure` plays the eye's adaptation: nights are dim in absolute terms but get a higher
 * exposure, so moonlit scenes stay readable while torches look bright.
 */
import * as THREE from 'three';
import { TAU, smoothstep } from '../../core/math';

export const SUNRISE_HOUR = 5.5;
export const SUNSET_HOUR = 20.5;
export const SOLAR_NOON_HOUR = (SUNRISE_HOUR + SUNSET_HOUR) / 2;

const DEG = Math.PI / 180;
const LATITUDE = 55 * DEG;
/** Hour angle of sunset (radians from solar noon). */
const SUNSET_HOUR_ANGLE = ((SUNSET_HOUR - SOLAR_NOON_HOUR) / 24) * TAU;
/** Solar declination that puts sunrise and sunset exactly at SUNRISE_HOUR / SUNSET_HOUR. */
const DECLINATION = Math.atan(-Math.cos(SUNSET_HOUR_ANGLE) / Math.tan(LATITUDE));
const SIN_LAT = Math.sin(LATITUDE);
const COS_LAT = Math.cos(LATITUDE);
const SIN_DEC = Math.sin(DECLINATION);
const COS_DEC = Math.cos(DECLINATION);

/** The directional light is the sun above this sun elevation (degrees) and the moon below it; both are dark there. */
export const LIGHT_SWITCH_ELEVATION = -2;
/** Moonlight at full strength (sun well below the horizon, moon high). */
const MOON_INTENSITY = 0.5;
const MOON_COLOR = new THREE.Color(0xa8bce6);
/** Moon disc colour (linear) at night; faded by daylight. */
const MOON_DISC = new THREE.Color(0xe4e8f2);
/** Sun disc radiance = sun colour × this (clips to white at noon, stays orange at sunset). */
const SUN_DISC_GAIN = 3;

/** Unit direction towards the sun at `hour` (world axes: +X east, +Y up, +Z south). */
export function sunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
  const h = ((hour - SOLAR_NOON_HOUR) / 24) * TAU; // hour angle, positive in the afternoon (west)
  const ch = Math.cos(h);
  const east = -COS_DEC * Math.sin(h);
  const north = SIN_DEC * COS_LAT - COS_DEC * ch * SIN_LAT;
  const up = SIN_DEC * SIN_LAT + COS_DEC * ch * COS_LAT;
  return out.set(east, up, -north);
}

/** Unit direction towards the moon: the sun's arc twelve hours out of phase. */
export function moonDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
  return sunDirection(hour + 12, out);
}

/** Elevation of a unit direction above the horizon, degrees. */
export function elevationDeg(dir: THREE.Vector3): number {
  return Math.asin(Math.max(-1, Math.min(1, dir.y))) / DEG;
}

/** Everything the renderer needs for one moment of the day. Colours are linear. */
export interface Environment {
  /** Towards the sun / the moon (unit vectors). */
  readonly sunDir: THREE.Vector3;
  readonly moonDir: THREE.Vector3;
  /** Sun elevation above the horizon, degrees. */
  sunElevation: number;
  /** Towards the active directional light: the sun by day, the moon by night. */
  readonly lightDir: THREE.Vector3;
  /** The active directional light is the moon. */
  moonlight: boolean;
  readonly lightColor: THREE.Color;
  lightIntensity: number;
  readonly hemiSky: THREE.Color;
  readonly hemiGround: THREE.Color;
  hemiIntensity: number;
  readonly zenith: THREE.Color;
  /** Sky colour at the horizon — also the fog colour, so distant terrain melts into the sky. */
  readonly horizon: THREE.Color;
  /** Glow around the sun (colour × strength). */
  readonly sunGlow: THREE.Color;
  /** Sun disc radiance. */
  readonly sunDisc: THREE.Color;
  /** Moon disc colour × visibility. */
  readonly moonDisc: THREE.Color;
  /** Cloud colour on the lit side / in self-shadow. */
  readonly cloudLit: THREE.Color;
  readonly cloudShade: THREE.Color;
  /** FogExp2 density per world unit (above water). */
  fogDensity: number;
  /** 0 = deep night … 1 = full day. */
  daylight: number;
  /** Star visibility, 0..1. */
  stars: number;
  /** Tone-mapping exposure. */
  exposure: number;
}

export function createEnvironment(): Environment {
  return {
    sunDir: new THREE.Vector3(),
    moonDir: new THREE.Vector3(),
    sunElevation: 0,
    lightDir: new THREE.Vector3(),
    moonlight: false,
    lightColor: new THREE.Color(),
    lightIntensity: 0,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0,
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    sunGlow: new THREE.Color(),
    sunDisc: new THREE.Color(),
    moonDisc: new THREE.Color(),
    cloudLit: new THREE.Color(),
    cloudShade: new THREE.Color(),
    fogDensity: 0,
    daylight: 0,
    stars: 0,
    exposure: 1,
  };
}

interface SkyKey {
  /** Sun elevation, degrees. */
  elevation: number;
  zenith: THREE.Color;
  horizon: THREE.Color;
  glow: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemi: number;
  cloudLit: THREE.Color;
  cloudShade: THREE.Color;
  fog: number;
  exposure: number;
}

const skyKey = (
  elevation: number,
  zenith: number,
  horizon: number,
  glow: number,
  hemiSky: number,
  hemiGround: number,
  hemi: number,
  cloudLit: number,
  cloudShade: number,
  fog: number,
  exposure: number,
): SkyKey => ({
  elevation,
  zenith: new THREE.Color(zenith),
  horizon: new THREE.Color(horizon),
  glow: new THREE.Color(glow),
  hemiSky: new THREE.Color(hemiSky),
  hemiGround: new THREE.Color(hemiGround),
  hemi,
  cloudLit: new THREE.Color(cloudLit),
  cloudShade: new THREE.Color(cloudShade),
  fog,
  exposure,
});

// prettier-ignore
const SKY_KEYS: readonly SkyKey[] = [
  //     elev  zenith    horizon   sun glow  hemi sky  hemi gnd  hemi  cloud lit cloud shd fog      exposure
  skyKey(-18, 0x060a16, 0x161e31, 0x000000, 0x7e90bc, 0x2a2a30, 0.8,  0x2a3244, 0x151a26, 0.0012, 2.3),
  skyKey(-10, 0x0b1430, 0x262d4a, 0x000000, 0x8090bc, 0x2e2c32, 0.8,  0x353a52, 0x1a1e2e, 0.0012, 2.2),
  skyKey(-5,  0x1e2c5c, 0x6a5b7c, 0x50241c, 0x8e88aa, 0x3a3436, 0.9,  0x8a6e88, 0x463a54, 0.0012, 1.8),
  skyKey(-1.5, 0x33508c, 0xc78668, 0xff6e34, 0xc8a6a0, 0x4e4440, 1.15, 0xf0a07e, 0x7e5e6e, 0.0011, 1.35),
  skyKey(2,   0x4669a8, 0xdea47c, 0xff9850, 0xd8bea8, 0x62564a, 1.45, 0xf6c2a2, 0x9a8890, 0.00105, 1.15),
  skyKey(7,   0x4c77bc, 0xd4c0a4, 0xffc890, 0xd2d6dc, 0x74685a, 1.9,  0xf4e6d6, 0xb2b6c2, 0.001, 1.05),
  skyKey(15,  0x4a7cc6, 0xbccbd6, 0x9a8e80, 0xc4d4ea, 0x847660, 2.3,  0xf6f6f6, 0xbac2ce, 0.001, 1.0),
  skyKey(30,  0x4279cb, 0xb1c5da, 0x707070, 0xbfd0ea, 0x8a7a62, 2.5,  0xf8f8f8, 0xbcc4d0, 0.001, 1.0),
  skyKey(60,  0x3c74c9, 0xaac2dc, 0x606060, 0xbccfea, 0x8a7a62, 2.6,  0xf8f8f8, 0xbcc4d0, 0.001, 1.0),
];

interface SunKey {
  elevation: number;
  color: THREE.Color;
  intensity: number;
}

const sunKey = (elevation: number, color: number, intensity: number): SunKey => ({ elevation, color: new THREE.Color(color), intensity });

/** Sunlight by elevation: dark at the switch point, deep orange at the horizon, warm white by day. */
const SUN_KEYS: readonly SunKey[] = [
  sunKey(LIGHT_SWITCH_ELEVATION, 0xff5a1e, 0),
  sunKey(0, 0xff6a2a, 0.15),
  sunKey(3, 0xff8c48, 0.65),
  sunKey(8, 0xffb878, 1.4),
  sunKey(15, 0xffdcb0, 2.1),
  sunKey(30, 0xfff0dc, 2.55),
  sunKey(60, 0xfff6ea, 2.7),
];

/** Index i of the key segment [keys[i], keys[i+1]] containing `e` and the blend factor (clamped outside). */
function segment(keys: readonly { elevation: number }[], e: number): number {
  if (e <= keys[0].elevation) return 0;
  const last = keys.length - 1;
  if (e >= keys[last].elevation) return last - 1;
  let i = 0;
  while (e > keys[i + 1].elevation) i++;
  return i;
}

function blend(keys: readonly { elevation: number }[], i: number, e: number): number {
  const a = keys[i].elevation;
  const b = keys[i + 1].elevation;
  return Math.max(0, Math.min(1, (e - a) / (b - a)));
}

/** Fills `out` with the environment at in-game hour `hour` (0 ≤ hour < 24; other values wrap). */
export function computeEnvironment(hour: number, out: Environment): Environment {
  sunDirection(hour, out.sunDir);
  moonDirection(hour, out.moonDir);
  const e = elevationDeg(out.sunDir);
  out.sunElevation = e;

  const si = segment(SKY_KEYS, e);
  const st = blend(SKY_KEYS, si, e);
  const a = SKY_KEYS[si];
  const b = SKY_KEYS[si + 1];
  out.zenith.lerpColors(a.zenith, b.zenith, st);
  out.horizon.lerpColors(a.horizon, b.horizon, st);
  out.sunGlow.lerpColors(a.glow, b.glow, st);
  out.hemiSky.lerpColors(a.hemiSky, b.hemiSky, st);
  out.hemiGround.lerpColors(a.hemiGround, b.hemiGround, st);
  out.hemiIntensity = a.hemi + (b.hemi - a.hemi) * st;
  out.cloudLit.lerpColors(a.cloudLit, b.cloudLit, st);
  out.cloudShade.lerpColors(a.cloudShade, b.cloudShade, st);
  out.fogDensity = a.fog + (b.fog - a.fog) * st;
  out.exposure = a.exposure + (b.exposure - a.exposure) * st;

  const ui = segment(SUN_KEYS, e);
  const ut = blend(SUN_KEYS, ui, e);
  const sa = SUN_KEYS[ui];
  const sb = SUN_KEYS[ui + 1];
  const sunIntensity = e <= LIGHT_SWITCH_ELEVATION ? 0 : sa.intensity + (sb.intensity - sa.intensity) * ut;
  // The disc keeps its colour while setting; the shader hides whatever is below the horizon.
  out.sunDisc.lerpColors(sa.color, sb.color, ut).multiplyScalar(SUN_DISC_GAIN);

  out.daylight = smoothstep(-8, 12, e);
  out.stars = 1 - smoothstep(-12, -3, e);
  out.moonDisc.copy(MOON_DISC).multiplyScalar(1 - 0.85 * out.daylight);

  out.moonlight = e < LIGHT_SWITCH_ELEVATION;
  if (out.moonlight) {
    const moonUp = smoothstep(-1, 10, elevationDeg(out.moonDir));
    out.lightDir.copy(out.moonDir);
    out.lightColor.copy(MOON_COLOR);
    out.lightIntensity = MOON_INTENSITY * moonUp * (1 - smoothstep(-10, LIGHT_SWITCH_ELEVATION, e));
  } else {
    out.lightDir.copy(out.sunDir);
    out.lightColor.lerpColors(sa.color, sb.color, ut);
    out.lightIntensity = sunIntensity;
  }
  return out;
}
