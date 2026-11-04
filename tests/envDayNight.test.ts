import * as THREE from 'three';
import { describe, expect, test } from 'vitest';
import {
  LIGHT_SWITCH_ELEVATION,
  SOLAR_NOON_HOUR,
  SUNRISE_HOUR,
  SUNSET_HOUR,
  computeEnvironment,
  createEnvironment,
  elevationDeg,
  moonDirection,
  sunDirection,
  type Environment,
} from '../src/render/env/dayNight';

const v = new THREE.Vector3();
const sunElevation = (hour: number) => elevationDeg(sunDirection(hour, v));

/** Every scalar of the environment that must change smoothly over the day (colours as linear rgb). */
function smoothValues(env: Environment): number[] {
  const out: number[] = [];
  for (const c of [env.zenith, env.horizon, env.sunGlow, env.hemiSky, env.hemiGround, env.cloudLit, env.cloudShade, env.moonDisc]) {
    out.push(c.r, c.g, c.b);
  }
  // The light direction jumps from the sun to the moon where both are dark; colour × intensity does not.
  out.push(env.lightColor.r * env.lightIntensity, env.lightColor.g * env.lightIntensity, env.lightColor.b * env.lightIntensity);
  out.push(env.lightIntensity, env.hemiIntensity, env.fogDensity * 1000, env.daylight, env.stars, env.exposure);
  return out;
}

describe('sun and moon path', () => {
  test('the sun is high in the south at noon and below the horizon at midnight', () => {
    const noon = sunDirection(SOLAR_NOON_HOUR, new THREE.Vector3());
    expect(elevationDeg(noon)).toBeGreaterThan(40);
    expect(noon.z).toBeGreaterThan(0); // +Z = south
    expect(Math.abs(noon.x)).toBeLessThan(1e-9);
    expect(sunElevation(SOLAR_NOON_HOUR + 12)).toBeLessThan(-10);
    expect(sunElevation(1)).toBeLessThan(0);
  });

  test('sunrise ≈ 5:30 in the east, sunset ≈ 20:30 in the west', () => {
    expect(Math.abs(sunElevation(SUNRISE_HOUR))).toBeLessThan(0.5);
    expect(Math.abs(sunElevation(SUNSET_HOUR))).toBeLessThan(0.5);
    expect(sunElevation(SUNRISE_HOUR - 0.25)).toBeLessThan(0);
    expect(sunElevation(SUNRISE_HOUR + 0.25)).toBeGreaterThan(0);
    expect(sunElevation(SUNSET_HOUR - 0.25)).toBeGreaterThan(0);
    expect(sunElevation(SUNSET_HOUR + 0.25)).toBeLessThan(0);
    expect(sunDirection(SUNRISE_HOUR, v).x).toBeGreaterThan(0.5); // east
    expect(sunDirection(SUNSET_HOUR, v).x).toBeLessThan(-0.5); // west
  });

  test('directions are unit vectors and the moon runs twelve hours behind the sun', () => {
    const sun = new THREE.Vector3();
    const moon = new THREE.Vector3();
    for (let h = 0; h < 24; h += 0.37) {
      sunDirection(h, sun);
      moonDirection(h, moon);
      expect(sun.length()).toBeCloseTo(1, 9);
      expect(moon.length()).toBeCloseTo(1, 9);
      expect(moon.distanceTo(sunDirection(h + 12, v))).toBeLessThan(1e-9);
    }
    expect(elevationDeg(moonDirection(SOLAR_NOON_HOUR + 12, moon))).toBeGreaterThan(40);
  });
});

describe('computeEnvironment', () => {
  test('noon: the sun lights the world; midnight: dim moonlight, stars, higher exposure', () => {
    const noon = computeEnvironment(SOLAR_NOON_HOUR, createEnvironment());
    expect(noon.moonlight).toBe(false);
    expect(noon.lightDir.equals(noon.sunDir)).toBe(true);
    expect(noon.lightIntensity).toBeGreaterThan(2);
    expect(noon.daylight).toBe(1);
    expect(noon.stars).toBe(0);

    const night = computeEnvironment(SOLAR_NOON_HOUR + 12, createEnvironment());
    expect(night.moonlight).toBe(true);
    expect(night.lightDir.equals(night.moonDir)).toBe(true);
    expect(night.lightDir.y).toBeGreaterThan(0.5);
    expect(night.lightIntensity).toBeGreaterThan(0);
    expect(night.lightIntensity).toBeLessThan(noon.lightIntensity / 3);
    expect(night.daylight).toBe(0);
    expect(night.stars).toBe(1);
    expect(night.exposure).toBeGreaterThan(noon.exposure);
    // Dark blue but readable: blue-dominant sky, ambient light still on.
    expect(night.zenith.b).toBeGreaterThan(night.zenith.r);
    expect(night.hemiIntensity).toBeGreaterThan(0.3);
  });

  test('twilight is warm: orange horizon and low sun light', () => {
    const dusk = computeEnvironment(SUNSET_HOUR - 0.1, createEnvironment());
    expect(dusk.sunElevation).toBeGreaterThan(0);
    expect(dusk.sunElevation).toBeLessThan(3);
    expect(dusk.horizon.r).toBeGreaterThan(dusk.horizon.b);
    expect(dusk.lightColor.r).toBeGreaterThan(dusk.lightColor.b * 2);
    expect(dusk.sunGlow.r).toBeGreaterThan(0.3);
  });

  test('the directional light is dark where it switches between sun and moon', () => {
    const env = createEnvironment();
    let switches = 0;
    let wasMoon = computeEnvironment(0, env).moonlight;
    for (let m = 1; m <= 24 * 60; m++) {
      const isMoon = computeEnvironment(m / 60, env).moonlight;
      if (isMoon !== wasMoon) {
        switches++;
        expect(env.lightIntensity).toBeLessThan(0.01);
        expect(Math.abs(env.sunElevation - LIGHT_SWITCH_ELEVATION)).toBeLessThan(0.5);
      }
      wasMoon = isMoon;
    }
    expect(switches).toBe(2);
  });

  test('all values are finite, in range and continuous across 24 h (including the wrap at midnight)', () => {
    const env = createEnvironment();
    let prev = smoothValues(computeEnvironment(0, env));
    const prevSun = env.sunDir.clone();
    let maxStep = 0;
    for (let m = 1; m <= 24 * 60; m++) {
      computeEnvironment(m / 60, env);
      const values = smoothValues(env);
      for (let i = 0; i < values.length; i++) {
        expect(Number.isFinite(values[i])).toBe(true);
        expect(values[i]).toBeGreaterThanOrEqual(0);
        maxStep = Math.max(maxStep, Math.abs(values[i] - prev[i]));
      }
      for (const c of [env.zenith, env.horizon, env.hemiSky, env.hemiGround, env.lightColor, env.cloudLit, env.cloudShade]) {
        expect(Math.max(c.r, c.g, c.b)).toBeLessThanOrEqual(1.0001);
      }
      expect(env.daylight).toBeLessThanOrEqual(1);
      expect(env.stars).toBeLessThanOrEqual(1);
      expect(env.fogDensity).toBeGreaterThan(0);
      expect(env.sunDir.distanceTo(prevSun)).toBeLessThan(0.01);
      prevSun.copy(env.sunDir);
      prev = values;
    }
    // One in-game minute never changes any value by more than a few percent of its range.
    expect(maxStep).toBeLessThan(0.06);
  });

  test('hours wrap', () => {
    const a = smoothValues(computeEnvironment(5.25, createEnvironment()));
    const b = smoothValues(computeEnvironment(29.25, createEnvironment()));
    const c = smoothValues(computeEnvironment(-18.75, createEnvironment()));
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i], 6);
      expect(c[i]).toBeCloseTo(a[i], 6);
    }
  });
});
