/**
 * Procedural sample data for the looping buffers (pure; no WebAudio): seamless noises in three colours and
 * the campfire crackle, water bubble and cricket chorus textures. Generated once when audio unlocks.
 */
import type { NoiseColor } from './recipes';

/** Seconds crossfaded from the end of a noise stream into its head, so the buffer loops without a click. */
const LOOP_FADE_S = 0.08;

/** A white / pink / brown noise stream; every call returns the next sample. */
export function noiseStream(color: NoiseColor, rand: () => number): () => number {
  switch (color) {
    case 'white':
      return () => rand() * 2 - 1;
    case 'pink': {
      // Paul Kellet's refined filter: ≈ −3 dB/octave over the audible range.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      return () => {
        const w = rand() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
        return v;
      };
    }
    case 'brown': {
      // Leaky integrator: ≈ −6 dB/octave above a few tens of Hz, no DC drift.
      let last = 0;
      return () => {
        last = (last + 0.02 * (rand() * 2 - 1)) / 1.02;
        return last;
      };
    }
  }
}

/**
 * Fills `out` from `next` so that it loops seamlessly: the stream continues past the end and is
 * equal-power crossfaded into the head, so the wrap from the last sample to the first is a natural step.
 */
export function fillSeamless(out: Float32Array, next: () => number, sampleRate: number): void {
  const n = out.length;
  for (let i = 0; i < n; i++) out[i] = next();
  const fade = Math.min(n >> 1, Math.round(LOOP_FADE_S * sampleRate));
  for (let i = 0; i < fade; i++) {
    const a = ((i + 0.5) / fade) * (Math.PI / 2);
    out[i] = out[i] * Math.sin(a) + next() * Math.cos(a);
  }
}

/** Removes the DC offset and scales to the given RMS. */
export function normalizeRms(out: Float32Array, rms: number): void {
  const n = out.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = out[i] - mean;
    sq += v * v;
  }
  const k = sq > 0 ? rms / Math.sqrt(sq / n) : 0;
  for (let i = 0; i < n; i++) out[i] = (out[i] - mean) * k;
}

/** Scales so that the largest absolute sample across `channels` equals `peak`. */
function normalizePeak(channels: readonly Float32Array[], peak: number): void {
  let max = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) max = Math.max(max, Math.abs(ch[i]));
  if (max === 0) return;
  const k = peak / max;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= k;
}

/**
 * Campfire crackle: ~13 clicks per second — mostly tiny ticks, now and then a loud pop with a short
 * resonant body. Written cyclically, so the buffer loops seamlessly.
 */
export function renderCrackle(out: Float32Array, sampleRate: number, rand: () => number): void {
  const n = out.length;
  const count = Math.round((n / sampleRate) * 13);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(rand() * n);
    const pop = rand() < 0.08;
    const amp = pop ? 0.6 + 0.4 * rand() : 0.05 + 0.3 * rand() * rand();
    const len = Math.max(4, Math.floor(sampleRate * (pop ? 0.004 + 0.006 * rand() : 0.0008 + 0.0025 * rand())));
    for (let i = 0; i < len; i++) out[(at + i) % n] += amp * Math.exp((-3 * i) / len) * (rand() * 2 - 1);
    if (!pop) continue;
    const w = (2 * Math.PI * (300 + 600 * rand())) / sampleRate;
    const body = Math.floor(sampleRate * 0.02);
    for (let i = 0; i < body; i++) out[(at + i) % n] += 0.5 * amp * Math.exp((-4 * i) / body) * Math.sin(w * i);
  }
  normalizePeak([out], 0.9);
}

/**
 * Water bubbles: ~6 per second, each a decaying sine whose pitch rises as it rings (300–1300 Hz,
 * 6–26 ms). Written cyclically, so the buffer loops seamlessly.
 */
export function renderBubbles(out: Float32Array, sampleRate: number, rand: () => number): void {
  const n = out.length;
  const count = Math.round((n / sampleRate) * 6);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(rand() * n);
    const f0 = 300 + 1000 * rand() * rand();
    const tau = (0.006 + 0.02 * rand()) * sampleRate;
    const len = Math.floor(tau * 5);
    const amp = 0.2 + 0.8 * rand();
    let phase = 0;
    for (let i = 0; i < len; i++) {
      phase += (2 * Math.PI * f0 * (1 + (1.5 * i) / len)) / sampleRate;
      out[(at + i) % n] += amp * Math.exp(-i / tau) * Math.sin(phase);
    }
  }
  normalizePeak([out], 0.9);
}

/** Crickets in the chorus: the first few close by, the rest distant. */
const CRICKETS = 7;
const NEAR_CRICKETS = 3;

/**
 * Night chorus (stereo): crickets at 3.9–5 kHz, each chirping 3–5 pulses at 24–36 Hz with its own
 * period. Every period divides the buffer length and no chirp crosses the end, so the loop is seamless.
 */
export function renderCrickets(left: Float32Array, right: Float32Array, sampleRate: number, rand: () => number): void {
  const n = left.length;
  for (let c = 0; c < CRICKETS; c++) {
    const chirps = 6 + Math.floor(rand() * 6);
    const period = n / chirps;
    const pulses = 3 + Math.floor(rand() * 3);
    const pulseLen = Math.floor(sampleRate * (0.011 + 0.006 * rand()));
    const pulseGap = Math.floor(sampleRate / (24 + 12 * rand()));
    const chirpLen = pulseGap * (pulses - 1) + pulseLen;
    const offset = Math.floor(rand() * Math.max(1, period - chirpLen));
    const w = (2 * Math.PI * (3900 + 1100 * rand())) / sampleRate;
    const amp = c < NEAR_CRICKETS ? 0.6 + 0.4 * rand() : 0.12 + 0.25 * rand();
    const pan = (rand() * 1.6 - 0.8 + 1) * (Math.PI / 4);
    const gl = amp * Math.cos(pan);
    const gr = amp * Math.sin(pan);
    for (let k = 0; k < chirps; k++) {
      if (rand() < 0.12) continue; // an irregular pause now and then
      const base = Math.floor(k * period) + offset;
      for (let p = 0; p < pulses; p++) {
        const s0 = base + p * pulseGap;
        for (let i = 0; i < pulseLen; i++) {
          const s = Math.sin((Math.PI * i) / pulseLen);
          const v = s * s * Math.sin(w * (s0 + i));
          const j = (s0 + i) % n;
          left[j] += v * gl;
          right[j] += v * gr;
        }
      }
    }
  }
  normalizePeak([left, right], 0.8);
}
