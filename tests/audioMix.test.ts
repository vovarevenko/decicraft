/** Pure audio helpers: mixing curves, recipe tables, bird choice and procedural textures (no WebAudio). */
import { describe, expect, test } from 'vitest';
import { Rng } from '../src/core/rng';
import { pickSong } from '../src/game/audio/ambience';
import {
  ambienceMix,
  chorus,
  createAmbienceMix,
  daylight,
  distanceGain,
  gustAt,
  MAX_DISTANCE,
  nightness,
  pitchJitter,
  REF_DISTANCE,
  SHORE_RANGE,
  shoreGain,
  type AmbienceMix,
} from '../src/game/audio/mix';
import { AMBIENCE_LEVELS, BEDS, BIRDS, LOOPS, SOUNDS, type BufferName, type Layer } from '../src/game/audio/recipes';
import { fillSeamless, noiseStream, normalizeRms, renderBubbles, renderCrackle, renderCrickets } from '../src/game/audio/textures';

const FIELDS: (keyof AmbienceMix)[] = ['wind', 'whistle', 'foliage', 'birds', 'crickets', 'muffle'];
type Weights = [number, number, number, number];
const PURE: Weights[] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const mixOf = (w: ArrayLike<number>, hour: number, height = 0, enclosure = 0): AmbienceMix => ambienceMix(w, hour, height, enclosure, createAmbienceMix());

describe('distance and pitch', () => {
  test('inverse distance gain: 1 up to the reference distance, ref/d-like beyond, never increasing', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(REF_DISTANCE)).toBe(1);
    expect(distanceGain(2 * REF_DISTANCE)).toBeCloseTo(0.5, 9);
    expect(distanceGain(MAX_DISTANCE)).toBeCloseTo(REF_DISTANCE / MAX_DISTANCE, 9);
    expect(distanceGain(120, 60)).toBeCloseTo(0.5, 9);
    let last = 1;
    for (let d = 0; d <= 2000; d += 5) {
      const g = distanceGain(d);
      expect(g).toBeLessThanOrEqual(last);
      expect(g).toBeGreaterThan(0);
      last = g;
    }
  });

  test('pitch jitter stays within ±spread around the requested pitch', () => {
    expect(pitchJitter(1, 0.05, 0.5)).toBe(1);
    expect(pitchJitter(2, 0.05, 0)).toBeCloseTo(1.9, 9);
    expect(pitchJitter(1, 0.05, 0.999999)).toBeCloseTo(1.05, 5);
    const rng = new Rng(1);
    for (let i = 0; i < 1000; i++) {
      const p = pitchJitter(1.5, 0.08, rng.next());
      expect(p).toBeGreaterThanOrEqual(1.5 * 0.92);
      expect(p).toBeLessThanOrEqual(1.5 * 1.08);
    }
  });
});

describe('day/night curves and gusts', () => {
  const curves = { daylight, nightness, chorus };

  test.each(Object.entries(curves))('%s is in [0, 1], 24 h periodic and continuous (also across midnight)', (_, f) => {
    let prev = f(-1);
    for (let h = -1; h <= 25; h += 0.01) {
      const v = f(h);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      expect(f(h + 24)).toBeCloseTo(v, 9);
      prev = v;
    }
  });

  test('day by day, night by night; birds peak at dawn', () => {
    expect(daylight(12)).toBe(1);
    expect(daylight(0)).toBe(0);
    expect(daylight(3)).toBe(0);
    expect(daylight(22)).toBe(0);
    expect(nightness(0)).toBe(1);
    expect(nightness(23)).toBe(1);
    expect(nightness(12)).toBe(0);
    expect(chorus(6.3)).toBeCloseTo(1, 6);
    expect(chorus(13)).toBeLessThan(0.05);
  });

  test('gusts vary smoothly within [0, 1] and never settle', () => {
    let lo = 1;
    let hi = 0;
    let prev = gustAt(0);
    for (let t = 0; t <= 1800; t += 0.05) {
      const g = gustAt(t);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(Math.abs(g - prev)).toBeLessThan(0.05);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
      prev = g;
    }
    expect(hi - lo).toBeGreaterThan(0.6);
  });
});

describe('ambience mix', () => {
  test('every layer is finite and in [0, 1] for any input, garbage included', () => {
    const rng = new Rng(5);
    const blends: ArrayLike<number>[] = [...PURE, [0.25, 0.25, 0.25, 0.25], [Number.NaN, 0, 0, 0], [2, -1, 0, 0]];
    for (let i = 0; i < 20; i++) {
      const w = [rng.next(), rng.next(), rng.next(), rng.next()];
      const sum = w.reduce((a, v) => a + v, 0);
      blends.push(w.map((v) => v / sum));
    }
    for (const w of blends) {
      for (const hour of [0, 3, 5.5, 6.3, 12, 19.6, 20.5, 23.9, -5, 30, Number.NaN]) {
        for (const height of [-200, 0, 30, 100, 170, 400, Number.NaN]) {
          for (const enclosure of [0, 0.3, 1, -1, 2, Number.NaN]) {
            const m = mixOf(w, hour, height, enclosure);
            for (const f of FIELDS) {
              expect(Number.isFinite(m[f]), f).toBe(true);
              expect(m[f]).toBeGreaterThanOrEqual(0);
              expect(m[f]).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  test('crossfades continuously across every biome border and through 24 h', () => {
    const w: Weights = [0, 0, 0, 0];
    for (const hour of [0, 5.5, 12, 20.5]) {
      for (const a of PURE) {
        for (const b of PURE) {
          let prev = mixOf(a, hour, 60);
          for (let t = 0.01; t <= 1.0001; t += 0.01) {
            for (let k = 0; k < 4; k++) w[k] = a[k] * (1 - t) + b[k] * t;
            const m = mixOf(w, hour, 60);
            for (const f of FIELDS) expect(Math.abs(m[f] - prev[f]), `${f} ${a}→${b} @${hour}`).toBeLessThan(0.02);
            prev = m;
          }
        }
      }
    }
    for (const biome of PURE) {
      let prev = mixOf(biome, 0);
      for (let h = 0.01; h <= 24.0001; h += 0.01) {
        const m = mixOf(biome, h % 24);
        for (const f of FIELDS) expect(Math.abs(m[f] - prev[f]), `${f} ${biome} @${h}`).toBeLessThan(0.02);
        prev = m;
      }
    }
    let prev = mixOf(PURE[3], 12, 0);
    for (let height = 1; height <= 300; height++) {
      const m = mixOf(PURE[3], 12, height);
      for (const f of FIELDS) expect(Math.abs(m[f] - prev[f])).toBeLessThan(0.02);
      prev = m;
    }
  });

  test('wind everywhere, strongest up on the hills; birds by day in forest and meadow; crickets at night; a quiet town', () => {
    const [town, forest, meadow, hills] = PURE;
    expect(mixOf(town, 12).wind).toBeGreaterThan(0.1);
    expect(mixOf(hills, 12, 160).wind).toBeGreaterThan(mixOf(meadow, 12).wind + 0.3);
    expect(mixOf(meadow, 12).wind).toBeGreaterThan(mixOf(town, 12).wind);
    expect(mixOf(hills, 12, 160).whistle).toBeGreaterThan(0.6);
    expect(mixOf(town, 12).whistle).toBe(0);
    expect(mixOf(forest, 12).foliage).toBe(1);
    expect(mixOf(forest, 12).birds).toBeGreaterThan(mixOf(meadow, 12).birds);
    expect(mixOf(meadow, 12).birds).toBeGreaterThan(mixOf(town, 12).birds * 4);
    expect(mixOf(forest, 6.3).birds).toBeGreaterThan(mixOf(forest, 13).birds);
    expect(mixOf(forest, 1).birds).toBe(0);
    expect(mixOf(meadow, 1).crickets).toBeGreaterThan(0.9);
    expect(mixOf(meadow, 12).crickets).toBe(0);
    expect(mixOf(town, 1).crickets).toBeLessThan(mixOf(meadow, 1).crickets / 2);
  });

  test('a roof all around muffles the outdoors', () => {
    const open = mixOf(PURE[1], 7, 20, 0);
    const roofed = mixOf(PURE[1], 7, 20, 1);
    expect(roofed.muffle).toBe(1);
    expect(open.muffle).toBe(0);
    for (const f of ['wind', 'whistle', 'foliage', 'birds', 'crickets'] as const) expect(roofed[f]).toBeLessThanOrEqual(open[f] * 0.2 + 1e-12);
  });

  test('lapping water fades out over SHORE_RANGE', () => {
    expect(shoreGain(0)).toBe(1);
    expect(shoreGain(SHORE_RANGE)).toBe(0);
    expect(shoreGain(SHORE_RANGE * 2)).toBe(0);
    expect(shoreGain(Infinity)).toBe(0);
    expect(shoreGain(Number.NaN)).toBe(0);
    for (let d = 1; d < SHORE_RANGE; d++) expect(shoreGain(d)).toBeLessThan(shoreGain(d - 1));
  });
});

describe('recipe tables', () => {
  const inRange = (v: number, lo: number, hi: number): boolean => Number.isFinite(v) && v >= lo && v <= hi;
  const freqs = (l: Layer): number[] => (typeof l.freq === 'number' ? [l.freq] : [...l.freq]);
  const BUFFERS: BufferName[] = ['white', 'pink', 'brown', 'crackle', 'bubbles', 'crickets', 'airPink', 'airBrown'];

  test.each(Object.entries(SOUNDS))('%s is a valid recipe', (name, r) => {
    expect(r.layers.length, name).toBeGreaterThan(0);
    expect(inRange(r.jitter ?? 0.05, 0, 0.2)).toBe(true);
    expect(inRange(r.ref ?? REF_DISTANCE, 1, 200)).toBe(true);
    expect(r.maxDist ?? MAX_DISTANCE).toBeGreaterThan(r.ref ?? REF_DISTANCE);
    if (r.repeat) {
      expect(inRange(r.repeat.chance, 0.01, 1)).toBe(true);
      expect(Number.isInteger(r.repeat.max) && r.repeat.max >= 1).toBe(true);
      expect(inRange(r.repeat.gap, 0.05, 2)).toBe(true);
      expect(inRange(r.repeat.gain ?? 1, 0.1, 1)).toBe(true);
    }
    for (const l of r.layers) {
      expect(inRange(l.attack, 0, 0.5)).toBe(true);
      expect(inRange(l.hold ?? 0, 0, 1)).toBe(true);
      expect(inRange(l.decay, 0.001, 2)).toBe(true);
      expect(inRange(l.gain, 0.001, 4)).toBe(true);
      expect(inRange(l.at ?? 0, 0, 1)).toBe(true);
      const grains = l.grains ?? 1;
      expect(Number.isInteger(grains) && grains >= 1 && grains <= 32).toBe(true);
      expect(inRange(l.spread ?? 0, 0, 1.5)).toBe(true);
      for (const v of [l.ampVar ?? 0, l.freqVar ?? 0, l.wobble ?? 0]) expect(inRange(v, 0, 0.99)).toBe(true);
      expect(inRange(l.chance ?? 1, 0.01, 1)).toBe(true);
      for (const f of freqs(l)) expect(inRange(f, 20, 20000), `${name} ${f} Hz`).toBe(true);
      if ('noise' in l) {
        expect(['white', 'pink', 'brown']).toContain(l.noise);
        expect(['lowpass', 'highpass', 'bandpass']).toContain(l.filter);
        expect(inRange(l.q ?? 1, 0.1, 30)).toBe(true);
      } else {
        expect(['sine', 'triangle', 'square', 'sawtooth']).toContain(l.wave);
        for (const fm of l.formants ?? []) {
          expect(inRange(fm.f, 20, 20000)).toBe(true);
          expect(inRange(fm.q, 0.1, 30)).toBe(true);
          expect(inRange(fm.g ?? 1, 0.01, 2)).toBe(true);
        }
      }
    }
  });

  test('no two sounds share a recipe', () => {
    const seen = new Set(Object.values(SOUNDS).map((r) => JSON.stringify(r.layers)));
    expect(seen.size).toBe(Object.keys(SOUNDS).length);
  });

  test('loops, ambience beds, levels and bird songs are valid', () => {
    for (const spec of [...LOOPS.fire.layers, ...LOOPS.water.layers, ...Object.values(BEDS)]) {
      expect(BUFFERS).toContain(spec.buffer);
      expect(inRange(spec.freq, 20, 20000)).toBe(true);
      expect(spec.gain).toBeGreaterThanOrEqual(0);
      if ('lfo' in spec && spec.lfo) {
        expect(inRange(spec.lfo.depth, 0.01, 1)).toBe(true);
        expect(inRange(spec.lfo.rate, 0.01, 20)).toBe(true);
      }
    }
    for (const v of Object.values(AMBIENCE_LEVELS)) expect(inRange(v, 0.01, 1)).toBe(true);
    for (const b of BIRDS) {
      for (const [lo, hi] of [b.notes, b.dur, b.gap, b.freq, b.height]) expect(lo).toBeLessThanOrEqual(hi);
      expect(b.notes[0]).toBeGreaterThanOrEqual(1);
      expect(inRange(b.freq[0], 200, 8000) && inRange(b.freq[1] * Math.max(1, b.sweep), 200, 10000)).toBe(true);
      expect(b.habitat.every((h) => h >= 0) && b.habitat.some((h) => h > 0)).toBe(true);
      expect(inRange(b.gain, 0.01, 1)).toBe(true);
    }
  });

  test('birds are drawn by habitat: no cuckoo over the town, forest songs in the forest', () => {
    const cuckoo = BIRDS.find((b) => b.habitat[0] === 0 && b.habitat[1] > 0)!;
    const town = new Set<number>();
    const forest = new Set<number>();
    for (let r = 0; r < 1; r += 0.001) {
      town.add(BIRDS.indexOf(pickSong(PURE[0], r)));
      forest.add(BIRDS.indexOf(pickSong(PURE[1], r)));
    }
    expect(town.has(BIRDS.indexOf(cuckoo))).toBe(false);
    for (const i of forest) expect(BIRDS[i].habitat[1]).toBeGreaterThan(0);
    expect(forest.size).toBeGreaterThanOrEqual(3);
    expect(town.size).toBeGreaterThanOrEqual(3);
  });
});

describe('procedural textures', () => {
  const SR = 8000;
  const maxStep = (x: Float32Array): number => {
    let m = 0;
    for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
    return m;
  };
  const rms = (x: Float32Array): number => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

  test.each(['white', 'pink', 'brown'] as const)('%s noise loops without a click at the requested RMS', (color) => {
    const rng = new Rng(9);
    const x = new Float32Array(SR * 2);
    fillSeamless(x, noiseStream(color, () => rng.next()), SR);
    normalizeRms(x, 0.25);
    expect(rms(x)).toBeCloseTo(0.25, 4);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(Math.abs(x[0] - x[x.length - 1])).toBeLessThanOrEqual(maxStep(x));
  });

  test('noise colours: brown is far darker than pink, pink darker than white', () => {
    const roughness = (color: 'white' | 'pink' | 'brown'): number => {
      const rng = new Rng(4);
      const x = new Float32Array(SR);
      fillSeamless(x, noiseStream(color, () => rng.next()), SR);
      normalizeRms(x, 1);
      let d = 0;
      for (let i = 1; i < x.length; i++) d += Math.abs(x[i] - x[i - 1]);
      return d / x.length;
    };
    expect(roughness('brown')).toBeLessThan(roughness('pink') / 3);
    expect(roughness('pink')).toBeLessThan(roughness('white'));
  });

  test('crackle and bubble textures: finite, normalised, seamless', () => {
    for (const render of [renderCrackle, renderBubbles]) {
      const rng = new Rng(2);
      const x = new Float32Array(SR * 3);
      render(x, SR, () => rng.next());
      expect(x.every(Number.isFinite)).toBe(true);
      expect(Math.max(...x.map(Math.abs))).toBeCloseTo(0.9, 5);
      expect(Math.abs(x[0] - x[x.length - 1])).toBeLessThanOrEqual(maxStep(x));
    }
  });

  test('the cricket chorus fills the loop with chirps and never crosses its end', () => {
    const rng = new Rng(3);
    const sr = 24000;
    const left = new Float32Array(sr * 4);
    const right = new Float32Array(sr * 4);
    renderCrickets(left, right, sr, () => rng.next());
    let peak = 0;
    for (const ch of [left, right]) {
      expect(ch.every(Number.isFinite)).toBe(true);
      peak = Math.max(peak, ...ch.map(Math.abs));
      expect(Math.abs(ch[0])).toBeLessThan(0.05);
      expect(Math.abs(ch[ch.length - 1])).toBeLessThan(0.05);
    }
    expect(peak).toBeCloseTo(0.8, 5);
    const win = sr / 10;
    let busy = 0;
    for (let s = 0; s + win <= left.length; s += win) if (rms(left.subarray(s, s + win)) + rms(right.subarray(s, s + win)) > 0.01) busy++;
    expect(busy / (left.length / win)).toBeGreaterThan(0.5);
  });
});
