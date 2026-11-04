/**
 * Sky dome: a camera-centred sphere drawn first behind everything (no depth, no fog, no tone mapping)
 * with a horizon → zenith gradient, sun disc and glow, a moon disc with maria and halo, hashed
 * twinkling stars at night and a drifting procedural cloud layer. OWNER: agent "env-fx".
 *
 * The output skips tone mapping but goes through the same linear → sRGB conversion as fog, so at the
 * horizon the sky shows exactly the fog colour and fully fogged terrain melts into it.
 */
import * as THREE from 'three';
import { RENDER } from '../../config';
import { sharedUniforms } from '../sharedUniforms';
import type { Environment } from './dayNight';

/** Dome radius: inside the camera's far plane. */
const SKY_RADIUS = RENDER.far * 0.75;
/** Fraction of the sky covered by clouds (0..1). */
const CLOUD_COVER = 0.45;
/** Cloud drift in noise units per second of day-clock time (fast-forward makes them race). */
const CLOUD_DRIFT_X = 0.0035;
const CLOUD_DRIFT_Z = 0.0012;

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunGlow;
uniform vec3 uSunDisc;
uniform vec3 uMoonDir;
uniform vec3 uMoonRight;
uniform vec3 uMoonUp;
uniform vec3 uMoonDisc;
uniform float uStars;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform float uTime;
uniform vec3 uUnderwaterColor;
uniform float uUnderwater;
varying vec3 vDir;

#define SUN_RADIUS 0.014
#define MOON_RADIUS 0.021

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 4 octaves, normalised to [0, 1].
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * valueNoise(p);
    p = p * 2.02 + vec2(17.13, 9.71);
    a *= 0.5;
  }
  return s * (1.0 / 0.9375);
}

void main() {
  vec3 dir = normalize(vDir);
  float y = dir.y;
  float t = pow(max(y, 0.0), 0.6);
  vec3 col = mix(uHorizon, uZenith, t);

  // Glow: a broad lobe that hugs the horizon plus a tight halo; faded below the horizon line.
  float cosSun = dot(dir, uSunDir);
  float sunFacing = max(cosSun, 0.0);
  float aboveGlow = smoothstep(-0.03, 0.05, y);
  col += uSunGlow * (pow(sunFacing, 5.0) * (0.3 + 0.7 * (1.0 - t)) + 0.6 * pow(sunFacing, 60.0)) * aboveGlow;

  float aboveDisc = smoothstep(-0.004, 0.006, y);

  vec3 stars = vec3(0.0);
  if (uStars > 0.003 && y > 0.0) {
    vec3 p = dir * 230.0;
    vec3 cell = floor(p);
    float h = hash13(cell);
    if (h > 0.962) {
      vec3 centre = hash33(cell) * 0.7 + 0.15;
      float d = length(fract(p) - centre);
      float size = 0.13 + 0.17 * fract(h * 37.17);
      float twinkle = 0.7 + 0.3 * sin(uTime * (1.7 + 3.1 * fract(h * 91.3)) + h * 61.0);
      stars = vec3(smoothstep(size, 0.0, d) * twinkle * (0.35 + 0.65 * fract(h * 13.7)) * uStars * smoothstep(0.0, 0.12, y));
    }
  }

  float cosMoon = dot(dir, uMoonDir);
  float moonDist = sqrt(max(0.0, 2.0 * (1.0 - cosMoon)));
  float moonMask = smoothstep(MOON_RADIUS, MOON_RADIUS * 0.86, moonDist) * aboveDisc;
  vec2 mq = vec2(dot(dir, uMoonRight), dot(dir, uMoonUp)) * (1.0 / MOON_RADIUS);
  float maria = valueNoise(mq * 2.3 + 7.0) * 0.6 + valueNoise(mq * 5.1 + 3.0) * 0.4;
  float limb = sqrt(max(0.0, 1.0 - dot(mq, mq)));
  vec3 moon = uMoonDisc * (0.72 + 0.28 * smoothstep(0.35, 0.7, maria)) * (0.8 + 0.2 * limb);
  col += stars * (1.0 - moonMask) + moon * moonMask;
  col += uMoonDisc * 0.06 * pow(max(cosMoon, 0.0), 900.0) * aboveGlow;

  float sunDist = sqrt(max(0.0, 2.0 * (1.0 - cosSun)));
  col += uSunDisc * smoothstep(SUN_RADIUS, SUN_RADIUS * 0.75, sunDist) * aboveDisc;

  if (y > 0.0) {
    vec2 uv = dir.xz / (y + 0.16) * 2.6 + uCloudOffset;
    float n = fbm(uv);
    float alpha = smoothstep(1.0 - uCloudCover, 1.28 - uCloudCover, n) * smoothstep(0.01, 0.2, y) * 0.95;
    if (alpha > 0.001) {
      // Denser cloud towards the sun → this point lies in its shade.
      float towardsSun = fbm(uv + uSunDir.xz * 0.3);
      vec3 cloud = mix(uCloudShade, uCloudLit, clamp(0.55 + (n - towardsSun) * 3.0, 0.0, 1.0));
      cloud += uSunGlow * pow(sunFacing, 8.0) * 0.5;
      col = mix(col, cloud, alpha);
    }
  }

  col = mix(col, uUnderwaterColor, uUnderwater);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  gl_FragColor.rgb += (hash12(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
}
`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly uniforms = {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunGlow: { value: new THREE.Color() },
    uSunDisc: { value: new THREE.Color() },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uMoonRight: { value: new THREE.Vector3(1, 0, 0) },
    uMoonUp: { value: new THREE.Vector3(0, 0, 1) },
    uMoonDisc: { value: new THREE.Color() },
    uStars: { value: 0 },
    uCloudLit: { value: new THREE.Color() },
    uCloudShade: { value: new THREE.Color() },
    uCloudOffset: { value: new THREE.Vector2() },
    uCloudCover: { value: CLOUD_COVER },
    uTime: sharedUniforms.uTime,
    uUnderwaterColor: { value: new THREE.Color() },
    uUnderwater: { value: 0 },
  };

  constructor() {
    const material = new THREE.ShaderMaterial({
      name: 'sky',
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 32, 16), material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  /**
   * Centres the dome on the camera and copies the environment into the shader. `cloudTime` is
   * day-clock seconds (drives the drift); `underwater` (0..1) replaces the sky by `underwaterColor`.
   */
  update(env: Environment, cameraPosition: THREE.Vector3, cloudTime: number, underwater: number, underwaterColor: THREE.Color): void {
    const u = this.uniforms;
    this.mesh.position.copy(cameraPosition);
    u.uZenith.value.copy(env.zenith);
    u.uHorizon.value.copy(env.horizon);
    u.uSunDir.value.copy(env.sunDir);
    u.uSunGlow.value.copy(env.sunGlow);
    u.uSunDisc.value.copy(env.sunDisc);
    u.uMoonDir.value.copy(env.moonDir);
    // Tangent frame on the moon disc for its maria; the moon never stands exactly at the zenith.
    u.uMoonRight.value.set(-env.moonDir.z, 0, env.moonDir.x).normalize();
    u.uMoonUp.value.crossVectors(u.uMoonRight.value, env.moonDir);
    u.uMoonDisc.value.copy(env.moonDisc);
    u.uStars.value = env.stars;
    u.uCloudLit.value.copy(env.cloudLit);
    u.uCloudShade.value.copy(env.cloudShade);
    u.uCloudOffset.value.set(cloudTime * CLOUD_DRIFT_X, cloudTime * CLOUD_DRIFT_Z);
    u.uUnderwater.value = underwater;
    u.uUnderwaterColor.value.copy(underwaterColor);
  }
}
