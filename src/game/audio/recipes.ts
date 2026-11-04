/**
 * Sound design as data: every SoundName and LoopName is a short table of synthesis parameters, plus the
 * ambience beds and bird songs. synth.ts turns these into WebAudio graphs. Levels are calibrated by
 * offline rendering (tests/audio.test.ts, loudest 50 ms RMS at volume 1 before distance attenuation):
 * footsteps ≈ −25 dBFS, UI-like sounds ≈ −24, digging ≈ −18, a bark ≈ −14, a felled tree ≈ −12; peaks
 * stay below −1 dBFS. Re-run that test with AUDIO_REPORT=1 after changing a recipe.
 */
import type { LoopName, SoundName } from '../audio';

export type NoiseColor = 'white' | 'pink' | 'brown';
/** Looping sample buffers: plain noises plus procedural textures (textures.ts); `air*` are stereo. */
export type BufferName = NoiseColor | 'crackle' | 'bubbles' | 'crickets' | 'airPink' | 'airBrown';
export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';

/** A resonance of a voiced layer: band-pass at `f` Hz (scaled with the pitch), quality `q`, gain `g` (default 1). */
export interface Formant {
  f: number;
  q: number;
  g?: number;
}

interface LayerBase {
  /** Start offset after the sound's start (s). */
  at?: number;
  /**
   * Frequency contour (Hz) across each grain — of the oscillator (tone layers) or of the filter (noise
   * layers). Several values = exponential glides between evenly spaced points.
   */
  freq: number | readonly number[];
  /** Envelope: linear attack, optional hold at the peak, exponential decay (s); `gain` = peak. */
  attack: number;
  hold?: number;
  decay: number;
  gain: number;
  /** Grain train: `grains` envelopes, the first at the start, the rest at random within `spread` s. */
  grains?: number;
  spread?: number;
  /** Per-grain random amplitude reduction (0..1) and frequency deviation (±fraction). */
  ampVar?: number;
  freqVar?: number;
  /** Random deviation (±fraction) of every contour point — irregular creaks and whines. */
  wobble?: number;
  /** Probability that the layer plays at all (default 1). */
  chance?: number;
}

/** A looping noise buffer (random start offset) through a filter whose frequency follows `freq`. */
export interface NoiseLayer extends LayerBase {
  noise: NoiseColor;
  filter: BiquadFilterType;
  /** WebAudio Q: linear for band-pass, dB for low/high-pass (default 1). */
  q?: number;
}

/** An oscillator whose frequency follows `freq`, optionally through a bank of formants in parallel. */
export interface ToneLayer extends LayerBase {
  wave: Wave;
  formants?: readonly Formant[];
}

export type Layer = NoiseLayer | ToneLayer;

export interface SoundRecipe {
  layers: readonly Layer[];
  /** Random pitch deviation (±fraction, default 0.05). */
  jitter?: number;
  /** PannerNode refDistance (world units, default REF_DISTANCE): loud sources carry farther. */
  ref?: number;
  /** Positional plays beyond this distance (world units, default MAX_DISTANCE) are skipped. */
  maxDist?: number;
  /** Calls that come in series: up to `max` repeats `gap` s apart, each with probability `chance`, gain × `gain`. */
  repeat?: { chance: number; max: number; gap: number; gain?: number };
}

/** A looping buffer → filter → gain, optionally breathing with a slow LFO on the gain. */
export interface BedSpec {
  buffer: BufferName;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  gain: number;
  /** Playback rate (default 1). */
  rate?: number;
  /** Gain modulation: `rate` Hz, `depth` 0..1 of the gain. */
  lfo?: { rate: number; depth: number };
}

export interface LoopRecipe {
  layers: readonly BedSpec[];
  ref?: number;
  maxDist?: number;
}

/**
 * One bird species' song: `notes` notes of `dur` s with `gap` s pauses; the first note's frequency is drawn
 * from `freq`, each note glides to × `sweep`, the base frequency changes × `drift` per note, odd notes are
 * × `alt` in frequency and × `altGap` in the following pause (two-note calls), `scatter` = random ± per note.
 */
export interface BirdSong {
  /** Relative likelihood per biome [town, forest, meadow, hills]. */
  habitat: readonly [number, number, number, number];
  wave: Wave;
  formants?: readonly Formant[];
  notes: readonly [number, number];
  dur: readonly [number, number];
  gap: readonly [number, number];
  freq: readonly [number, number];
  sweep: number;
  drift?: number;
  alt?: number;
  altGap?: number;
  scatter?: number;
  gain: number;
  /** Height above the listener (world units) where the bird sings. */
  height: readonly [number, number];
}

/** One recipe per SoundName. */
export const SOUNDS: Readonly<Record<SoundName, SoundRecipe>> = {
  // shovel bite into soil: falling low crunch, a few crumbs, a dull thud
  dig_dirt: {
    jitter: 0.07,
    layers: [
      { noise: 'brown', filter: 'lowpass', freq: [1100, 300], attack: 0.003, decay: 0.14, gain: 1 },
      { noise: 'pink', filter: 'bandpass', q: 0.9, freq: 1400, attack: 0.002, decay: 0.035, gain: 0.5, grains: 4, spread: 0.13, ampVar: 0.6, freqVar: 0.3, at: 0.02 },
      { wave: 'sine', freq: [120, 55], attack: 0.002, decay: 0.09, gain: 0.36 },
    ],
  },
  // sand sliding off the blade: a soft long hiss with pouring grains
  dig_sand: {
    jitter: 0.06,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 0.8, freq: [1700, 1000], attack: 0.025, decay: 0.28, gain: 1.1 },
      { noise: 'white', filter: 'bandpass', q: 1.2, freq: 2600, attack: 0.002, decay: 0.03, gain: 0.48, grains: 8, spread: 0.26, ampVar: 0.7, freqVar: 0.25, at: 0.03 },
      { noise: 'brown', filter: 'lowpass', freq: 400, attack: 0.004, decay: 0.08, gain: 0.84 },
    ],
  },
  // pebbles crunching against each other
  dig_gravel: {
    jitter: 0.06,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1.4, freq: 2600, attack: 0.001, decay: 0.03, gain: 1.8, grains: 10, spread: 0.22, ampVar: 0.6, freqVar: 0.35 },
      { noise: 'brown', filter: 'lowpass', freq: [700, 250], attack: 0.003, decay: 0.12, gain: 1.2 },
      { wave: 'sine', freq: [150, 80], attack: 0.002, decay: 0.06, gain: 0.39 },
    ],
  },
  // pick on rock: sharp crack, a short metallic ring, a knock and flying chips
  dig_stone: {
    jitter: 0.05,
    layers: [
      { noise: 'white', filter: 'highpass', freq: 1800, attack: 0.001, decay: 0.03, gain: 0.44 },
      { wave: 'sine', freq: 2380, attack: 0.001, decay: 0.18, gain: 0.26 },
      { wave: 'sine', freq: 3710, attack: 0.001, decay: 0.1, gain: 0.16 },
      { wave: 'triangle', freq: [190, 120], attack: 0.002, decay: 0.07, gain: 0.17 },
      { noise: 'white', filter: 'bandpass', q: 1.5, freq: 4200, attack: 0.001, decay: 0.02, gain: 0.52, grains: 4, spread: 0.12, ampVar: 0.7, freqVar: 0.3, at: 0.02 },
    ],
  },
  // axe into a trunk: hollow thock, the trunk's resonance, the blade's bite
  chop_wood: {
    jitter: 0.06,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 2.5, freq: [900, 550], attack: 0.0008, decay: 0.09, gain: 2.3 },
      { wave: 'triangle', freq: [240, 190], attack: 0.002, decay: 0.18, gain: 0.46 },
      { wave: 'sine', freq: [620, 540], attack: 0.002, decay: 0.08, gain: 0.23 },
      { noise: 'white', filter: 'highpass', freq: 3500, attack: 0.0005, decay: 0.012, gain: 0.34 },
    ],
  },
  // rustling foliage: many soft high grains over a swish
  leaves: {
    jitter: 0.08,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 0.9, freq: 4200, attack: 0.008, decay: 0.06, gain: 1.6, grains: 12, spread: 0.32, ampVar: 0.6, freqVar: 0.3 },
      { noise: 'pink', filter: 'highpass', freq: 2200, attack: 0.05, hold: 0.05, decay: 0.2, gain: 0.56 },
    ],
  },
  // a plant pulled up: rising swish and snapping stems
  plant: {
    jitter: 0.08,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 1.2, freq: [2400, 4200], attack: 0.02, decay: 0.09, gain: 1.8 },
      { noise: 'white', filter: 'highpass', freq: 3800, attack: 0.001, decay: 0.012, gain: 1, grains: 3, spread: 0.06, ampVar: 0.5, at: 0.03 },
    ],
  },
  // pane shattering: crash, shards, then scattered tinkles
  glass_break: {
    jitter: 0.05,
    layers: [
      { noise: 'white', filter: 'highpass', freq: 2200, attack: 0.002, decay: 0.1, gain: 0.86 },
      { noise: 'white', filter: 'bandpass', q: 1.2, freq: 5200, attack: 0.001, decay: 0.03, gain: 1.7, grains: 10, spread: 0.3, ampVar: 0.6, freqVar: 0.35 },
      { wave: 'sine', freq: 4600, attack: 0.001, decay: 0.09, gain: 0.43, grains: 9, spread: 0.55, ampVar: 0.6, freqVar: 0.4, at: 0.02 },
      { wave: 'sine', freq: 3300, attack: 0.001, decay: 0.12, gain: 0.36, grains: 7, spread: 0.6, ampVar: 0.6, freqVar: 0.4, at: 0.05 },
    ],
  },
  // struck sheet metal: strike noise plus inharmonic plate modes (1 : 2.76 : 5.40 : 8.93)
  metal_hit: {
    jitter: 0.04,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1, freq: 3000, attack: 0.0005, decay: 0.02, gain: 0.57 },
      { wave: 'sine', freq: 520, attack: 0.001, decay: 0.7, gain: 0.21 },
      { wave: 'sine', freq: 1436, attack: 0.001, decay: 0.4, gain: 0.14 },
      { wave: 'sine', freq: 2808, attack: 0.001, decay: 0.22, gain: 0.086 },
      { wave: 'sine', freq: 4644, attack: 0.001, decay: 0.12, gain: 0.057 },
    ],
  },
  // cloth tearing: a fast train of rising grains over a soft body
  fabric: {
    jitter: 0.07,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 1.4, freq: [1300, 2300], attack: 0.002, decay: 0.022, gain: 1.5, grains: 16, spread: 0.28, ampVar: 0.5, freqVar: 0.2 },
      { noise: 'pink', filter: 'lowpass', freq: 1000, attack: 0.03, decay: 0.16, gain: 0.75 },
    ],
  },
  // a block set down: a dry thud, the contact tick and settling grit
  place: {
    jitter: 0.06,
    layers: [
      { noise: 'pink', filter: 'lowpass', freq: [1600, 500], attack: 0.001, decay: 0.06, gain: 1.6 },
      { noise: 'white', filter: 'highpass', freq: 2500, attack: 0.0005, decay: 0.008, gain: 0.63 },
      { noise: 'pink', filter: 'bandpass', q: 1.2, freq: 3000, attack: 0.002, decay: 0.02, gain: 0.55, grains: 3, spread: 0.08, ampVar: 0.5, at: 0.02 },
      { wave: 'sine', freq: [130, 90], attack: 0.002, decay: 0.05, gain: 0.4 },
    ],
  },
  step_grass: {
    jitter: 0.1,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 0.7, freq: [2600, 1800], attack: 0.015, decay: 0.12, gain: 1.1, grains: 2, spread: 0.04, ampVar: 0.3, freqVar: 0.15 },
      { noise: 'brown', filter: 'lowpass', freq: 300, attack: 0.005, decay: 0.05, gain: 0.66 },
    ],
  },
  step_dirt: {
    jitter: 0.1,
    layers: [
      { noise: 'brown', filter: 'lowpass', freq: [500, 250], attack: 0.004, decay: 0.09, gain: 0.62 },
      { wave: 'sine', freq: [75, 55], attack: 0.003, decay: 0.06, gain: 0.18 },
      { noise: 'pink', filter: 'bandpass', q: 1, freq: 1200, attack: 0.003, decay: 0.03, gain: 0.18, grains: 3, spread: 0.06, ampVar: 0.5, at: 0.01 },
    ],
  },
  // heel click and knock, sometimes the toe follows
  step_stone: {
    jitter: 0.08,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1.4, freq: 2600, attack: 0.0005, decay: 0.025, gain: 1.3 },
      { noise: 'brown', filter: 'lowpass', freq: 900, attack: 0.001, decay: 0.03, gain: 0.74 },
      { wave: 'sine', freq: [220, 170], attack: 0.001, decay: 0.03, gain: 0.29 },
      { noise: 'white', filter: 'bandpass', q: 1.4, freq: 2100, attack: 0.0005, decay: 0.018, gain: 0.59, at: 0.055, chance: 0.7 },
    ],
  },
  // hollow boards: two resonant modes, a knock and the heel's contact
  step_wood: {
    jitter: 0.08,
    layers: [
      { wave: 'triangle', freq: [210, 180], attack: 0.001, decay: 0.08, gain: 0.3 },
      { wave: 'sine', freq: [430, 395], attack: 0.001, decay: 0.05, gain: 0.13 },
      { noise: 'white', filter: 'bandpass', q: 2.5, freq: 950, attack: 0.0008, decay: 0.035, gain: 0.87 },
      { noise: 'white', filter: 'bandpass', q: 1.5, freq: 3000, attack: 0.0005, decay: 0.01, gain: 0.44 },
    ],
  },
  step_sand: {
    jitter: 0.1,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 0.7, freq: [1300, 900], attack: 0.025, decay: 0.15, gain: 0.79, grains: 3, spread: 0.06, ampVar: 0.3 },
      { noise: 'brown', filter: 'lowpass', freq: 260, attack: 0.01, decay: 0.08, gain: 0.5 },
    ],
  },
  step_gravel: {
    jitter: 0.08,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1, freq: 3600, attack: 0.0008, decay: 0.018, gain: 1.2, grains: 8, spread: 0.12, ampVar: 0.6, freqVar: 0.4 },
      { noise: 'brown', filter: 'lowpass', freq: 450, attack: 0.002, decay: 0.06, gain: 0.72 },
    ],
  },
  // a boot on sheet metal: short clank
  step_metal: {
    jitter: 0.05,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1, freq: 3200, attack: 0.0005, decay: 0.012, gain: 0.34 },
      { wave: 'sine', freq: 410, attack: 0.001, decay: 0.22, gain: 0.14 },
      { wave: 'sine', freq: 1130, attack: 0.001, decay: 0.12, gain: 0.085 },
      { wave: 'sine', freq: 2230, attack: 0.001, decay: 0.07, gain: 0.046 },
      { noise: 'brown', filter: 'lowpass', freq: 350, attack: 0.002, decay: 0.05, gain: 0.28 },
    ],
  },
  // landing after a fall: body thud and a shuffle of the ground
  land: {
    jitter: 0.06,
    layers: [
      { wave: 'sine', freq: [100, 45], attack: 0.002, decay: 0.16, gain: 0.26 },
      { noise: 'brown', filter: 'lowpass', freq: [550, 200], attack: 0.003, decay: 0.15, gain: 0.45 },
      { noise: 'pink', filter: 'bandpass', q: 0.8, freq: 1300, attack: 0.002, decay: 0.03, gain: 0.15, grains: 3, spread: 0.07, ampVar: 0.5, at: 0.01 },
    ],
  },
  // splash: falling spray, a plunge and rising bubbles
  splash: {
    jitter: 0.07,
    ref: 25,
    layers: [
      { noise: 'white', filter: 'lowpass', freq: [4500, 700], attack: 0.004, decay: 0.45, gain: 0.93 },
      { noise: 'pink', filter: 'bandpass', q: 1, freq: [1600, 900], attack: 0.01, decay: 0.28, gain: 0.83 },
      { wave: 'sine', freq: [450, 1300], attack: 0.002, decay: 0.045, gain: 0.3, grains: 6, spread: 0.5, ampVar: 0.6, freqVar: 0.4, at: 0.05 },
      { noise: 'brown', filter: 'lowpass', freq: 260, attack: 0.004, decay: 0.15, gain: 0.93 },
    ],
  },
  // a swimming stroke: swelling swish and a few bubbles
  swim: {
    jitter: 0.08,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 1.3, freq: [500, 1150, 600], attack: 0.12, hold: 0.04, decay: 0.25, gain: 0.8 },
      { wave: 'sine', freq: [600, 1400], attack: 0.002, decay: 0.035, gain: 0.15, grains: 3, spread: 0.35, ampVar: 0.6, freqVar: 0.35, at: 0.1 },
    ],
  },
  // a light upward plip
  pickup: {
    jitter: 0.03,
    layers: [
      { wave: 'sine', freq: [680, 1250], attack: 0.002, decay: 0.08, gain: 0.25 },
      { wave: 'sine', freq: [1360, 2500], attack: 0.002, decay: 0.05, gain: 0.087, at: 0.012 },
      { noise: 'white', filter: 'highpass', freq: 4000, attack: 0.0005, decay: 0.008, gain: 0.22 },
    ],
  },
  // a toss: short rising whoosh
  drop: {
    jitter: 0.06,
    layers: [
      { noise: 'pink', filter: 'bandpass', q: 1, freq: [700, 1700], attack: 0.03, decay: 0.1, gain: 1.1 },
      { wave: 'sine', freq: [320, 210], attack: 0.002, decay: 0.05, gain: 0.21, at: 0.02 },
    ],
  },
  // knock, knock, a tug of rope and a soft ring
  craft: {
    jitter: 0.03,
    layers: [
      { wave: 'triangle', freq: [540, 500], attack: 0.001, decay: 0.05, gain: 0.47 },
      { wave: 'triangle', freq: [720, 660], attack: 0.001, decay: 0.05, gain: 0.4, at: 0.09 },
      { noise: 'pink', filter: 'bandpass', q: 1, freq: 3000, attack: 0.003, decay: 0.03, gain: 0.67, grains: 4, spread: 0.12, ampVar: 0.5, at: 0.15 },
      { wave: 'sine', freq: 1320, attack: 0.004, decay: 0.3, gain: 0.11, at: 0.22 },
    ],
  },
  // a crunchy bite and two chews
  eat: {
    jitter: 0.06,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1.1, freq: 2300, attack: 0.001, decay: 0.02, gain: 1.4, grains: 6, spread: 0.08, ampVar: 0.5, freqVar: 0.3 },
      { noise: 'white', filter: 'bandpass', q: 1.1, freq: 1900, attack: 0.001, decay: 0.02, gain: 0.86, grains: 5, spread: 0.08, ampVar: 0.5, freqVar: 0.3, at: 0.3 },
      { noise: 'white', filter: 'bandpass', q: 1.1, freq: 1700, attack: 0.001, decay: 0.02, gain: 0.58, grains: 4, spread: 0.07, ampVar: 0.5, freqVar: 0.3, at: 0.58 },
      { noise: 'brown', filter: 'lowpass', freq: 350, attack: 0.01, decay: 0.08, gain: 0.71, grains: 3, spread: 0.6 },
    ],
  },
  // latch click, handle thunk, then a hinge creak (stick-slip sawtooth through resonances)
  door_open: {
    jitter: 0.06,
    layers: [
      { noise: 'white', filter: 'highpass', freq: 3000, attack: 0.0005, decay: 0.01, gain: 0.64 },
      { wave: 'sine', freq: 1900, attack: 0.0005, decay: 0.03, gain: 0.13 },
      { noise: 'brown', filter: 'lowpass', freq: 300, attack: 0.002, decay: 0.08, gain: 0.64 },
      { wave: 'sawtooth', freq: [230, 400, 300, 470, 340], wobble: 0.12, formants: [{ f: 1150, q: 7 }, { f: 2500, q: 9, g: 0.5 }], attack: 0.06, hold: 0.25, decay: 0.25, gain: 0.64, at: 0.07, chance: 0.85 },
    ],
  },
  // the leaf hits the frame: hollow wooden slam, latch, rattle
  door_close: {
    jitter: 0.05,
    layers: [
      { wave: 'triangle', freq: [175, 150], attack: 0.002, decay: 0.14, gain: 0.44 },
      { noise: 'white', filter: 'bandpass', q: 2, freq: [700, 500], attack: 0.001, decay: 0.08, gain: 1.2 },
      { wave: 'sine', freq: [90, 60], attack: 0.003, decay: 0.1, gain: 0.26 },
      { noise: 'white', filter: 'bandpass', q: 2, freq: 2600, attack: 0.0005, decay: 0.02, gain: 0.53, at: 0.015 },
      { wave: 'sine', freq: 1750, attack: 0.0005, decay: 0.05, gain: 0.11, at: 0.015 },
      { noise: 'pink', filter: 'bandpass', q: 1.5, freq: 900, attack: 0.002, decay: 0.03, gain: 0.35, grains: 4, spread: 0.12, ampVar: 0.6, at: 0.03 },
    ],
  },
  // latch clicks, a short lid creak, the lid knocking open
  container_open: {
    jitter: 0.06,
    layers: [
      { noise: 'white', filter: 'highpass', freq: 3500, attack: 0.0005, decay: 0.008, gain: 0.65, grains: 2, spread: 0.05 },
      { wave: 'sine', freq: 2100, attack: 0.0005, decay: 0.025, gain: 0.1 },
      { wave: 'sawtooth', freq: [330, 520, 420], wobble: 0.1, formants: [{ f: 1400, q: 8 }], attack: 0.03, hold: 0.08, decay: 0.12, gain: 0.52, at: 0.07, chance: 0.7 },
      { wave: 'triangle', freq: [190, 150], attack: 0.001, decay: 0.08, gain: 0.45, at: 0.12 },
    ],
  },
  // two-part switch click
  flashlight: {
    jitter: 0.03,
    layers: [
      { noise: 'white', filter: 'highpass', freq: 4500, attack: 0.0003, decay: 0.004, gain: 1.1 },
      { wave: 'sine', freq: 3100, attack: 0.0003, decay: 0.008, gain: 0.24 },
      { noise: 'white', filter: 'highpass', freq: 4000, attack: 0.0003, decay: 0.004, gain: 0.8, at: 0.032 },
      { wave: 'sine', freq: 2500, attack: 0.0003, decay: 0.007, gain: 0.16, at: 0.032 },
    ],
  },
  // a felled tree lands: crack, splintering branches, the crown crashing through, a deep rumble, settling twigs
  tree_fall: {
    jitter: 0.05,
    ref: 60,
    maxDist: 1000,
    layers: [
      { noise: 'white', filter: 'highpass', freq: 1400, attack: 0.001, decay: 0.06, gain: 0.4 },
      { noise: 'white', filter: 'bandpass', q: 0.9, freq: 2400, attack: 0.001, decay: 0.035, gain: 0.36, grains: 12, spread: 0.4, ampVar: 0.6, freqVar: 0.35 },
      { noise: 'pink', filter: 'bandpass', q: 0.6, freq: [3500, 1700], attack: 0.04, hold: 0.15, decay: 0.7, gain: 0.36 },
      { noise: 'brown', filter: 'lowpass', freq: [320, 110], attack: 0.006, decay: 1.2, gain: 0.71, at: 0.04 },
      { wave: 'sine', freq: [58, 32], attack: 0.004, decay: 0.55, gain: 0.36, at: 0.04 },
      { noise: 'pink', filter: 'bandpass', q: 1, freq: 1500, attack: 0.004, decay: 0.06, gain: 0.16, grains: 8, spread: 0.9, ampVar: 0.7, freqVar: 0.4, at: 0.35 },
    ],
  },
  // a heavy piece lands: thud and rattling rubble
  impact: {
    jitter: 0.06,
    ref: 35,
    layers: [
      { noise: 'brown', filter: 'lowpass', freq: [480, 150], attack: 0.002, decay: 0.42, gain: 0.8 },
      { wave: 'sine', freq: [72, 40], attack: 0.002, decay: 0.26, gain: 0.35 },
      { noise: 'white', filter: 'bandpass', q: 0.9, freq: 1700, attack: 0.001, decay: 0.03, gain: 0.3, grains: 8, spread: 0.4, ampVar: 0.6, freqVar: 0.4, at: 0.03 },
    ],
  },
  // whoosh through the air
  swing: {
    jitter: 0.07,
    layers: [{ noise: 'pink', filter: 'bandpass', q: 1.6, freq: [380, 1350, 520], attack: 0.07, hold: 0.02, decay: 0.12, gain: 1.2 }],
  },
  // a blow on an animal: low punch, flesh, the slap of the hide
  hit_mob: {
    jitter: 0.06,
    layers: [
      { wave: 'sine', freq: [140, 70], attack: 0.003, decay: 0.12, gain: 0.5 },
      { noise: 'pink', filter: 'lowpass', freq: [1500, 600], attack: 0.002, decay: 0.08, gain: 0.67 },
      { noise: 'white', filter: 'bandpass', q: 1, freq: 2200, attack: 0.0005, decay: 0.012, gain: 0.34 },
      { wave: 'triangle', freq: [330, 250], attack: 0.002, decay: 0.04, gain: 0.16 },
    ],
  },
  // "woof": a voiced pitch arc through vowel-like formants plus breath; sometimes a second one
  dog_bark: {
    jitter: 0.05,
    ref: 40,
    maxDist: 800,
    repeat: { chance: 0.35, max: 1, gap: 0.24, gain: 0.85 },
    layers: [
      { wave: 'sawtooth', freq: [300, 450, 330, 240], formants: [{ f: 650, q: 4 }, { f: 1500, q: 6, g: 0.5 }, { f: 2700, q: 8, g: 0.2 }], attack: 0.008, hold: 0.04, decay: 0.12, gain: 1 },
      { noise: 'pink', filter: 'bandpass', q: 1.5, freq: 1100, attack: 0.005, decay: 0.1, gain: 0.55 },
    ],
  },
  // high "kai!" yelps
  dog_yelp: {
    jitter: 0.05,
    ref: 40,
    maxDist: 800,
    repeat: { chance: 0.6, max: 2, gap: 0.2, gain: 0.75 },
    layers: [
      { wave: 'sawtooth', freq: [800, 1500, 1150, 700], formants: [{ f: 1250, q: 3 }, { f: 2700, q: 5, g: 0.4 }], attack: 0.008, hold: 0.05, decay: 0.15, gain: 0.43 },
    ],
  },
  // a soft wavering whine
  dog_whine: {
    jitter: 0.05,
    ref: 25,
    layers: [
      { wave: 'triangle', freq: [620, 880, 800, 950, 720, 560], wobble: 0.03, formants: [{ f: 1050, q: 2.5 }], attack: 0.08, hold: 0.35, decay: 0.25, gain: 0.16 },
    ],
  },
  // roe deer alarm: hoarse barks, usually two or three in a row; carries far
  deer_alert: {
    jitter: 0.06,
    ref: 60,
    maxDist: 1200,
    repeat: { chance: 0.8, max: 2, gap: 0.8, gain: 0.9 },
    layers: [
      { wave: 'sawtooth', freq: [210, 265, 190, 150], formants: [{ f: 560, q: 3 }, { f: 1150, q: 4, g: 0.6 }, { f: 2400, q: 6, g: 0.2 }], attack: 0.01, hold: 0.08, decay: 0.18, gain: 0.71 },
      { noise: 'white', filter: 'bandpass', q: 0.8, freq: 950, attack: 0.006, hold: 0.06, decay: 0.16, gain: 0.8 },
    ],
  },
  // newspaper unfolded: crisp crackles and the sheet flapping open
  paper: {
    jitter: 0.05,
    layers: [
      { noise: 'white', filter: 'bandpass', q: 1.2, freq: 3800, attack: 0.001, decay: 0.02, gain: 1.9, grains: 16, spread: 0.42, ampVar: 0.7, freqVar: 0.35 },
      { noise: 'pink', filter: 'bandpass', q: 1, freq: [900, 1600], attack: 0.03, decay: 0.12, gain: 1.3, at: 0.12 },
    ],
  },
};

/** One recipe per LoopName. */
export const LOOPS: Readonly<Record<LoopName, LoopRecipe>> = {
  // campfire: low roar, a breathing hiss, crackles and pops
  fire: {
    ref: 30,
    layers: [
      { buffer: 'brown', filter: 'lowpass', freq: 420, gain: 0.2 },
      { buffer: 'pink', filter: 'bandpass', freq: 2600, q: 0.7, gain: 0.25, lfo: { rate: 0.23, depth: 0.5 } },
      { buffer: 'crackle', filter: 'highpass', freq: 700, gain: 0.45 },
    ],
  },
  // gently lapping water with occasional bubbles
  water: {
    ref: 30,
    layers: [
      { buffer: 'pink', filter: 'bandpass', freq: 520, q: 0.9, gain: 0.1, lfo: { rate: 0.31, depth: 0.7 } },
      { buffer: 'brown', filter: 'lowpass', freq: 320, gain: 0.07, lfo: { rate: 0.17, depth: 0.6 } },
      { buffer: 'bubbles', filter: 'highpass', freq: 300, gain: 0.12 },
    ],
  },
};

/** Ambience beds; their gains (and the wind filters) are driven by the ambience mixer. */
export const BEDS = {
  /** Low wind rumble (the filter opens with gusts). */
  wind: { buffer: 'airBrown', filter: 'lowpass', freq: 400, gain: 0 },
  /** Whistling wind on exposed heights. */
  whistle: { buffer: 'airPink', filter: 'bandpass', freq: 900, q: 6, gain: 0 },
  /** Leaves rustling in the wind. */
  foliage: { buffer: 'airPink', filter: 'highpass', freq: 2600, gain: 0, rate: 1.13 },
  /** Night insects. */
  crickets: { buffer: 'crickets', filter: 'highpass', freq: 2000, gain: 0 },
} as const satisfies Record<string, BedSpec>;

/** Full-scale gains of the ambience layers (mix value 1). */
export const AMBIENCE_LEVELS = {
  wind: 0.3,
  whistle: 0.5,
  foliage: 0.18,
  crickets: 0.16,
  birds: 0.35,
  shore: 0.8,
} as const;

/** The songs the ambience picks from by habitat. */
export const BIRDS: readonly BirdSong[] = [
  // chaffinch: a descending trill
  { habitat: [0.1, 1, 0.3, 0.4], wave: 'sine', notes: [9, 14], dur: [0.045, 0.065], gap: [0.012, 0.02], freq: [3900, 4500], sweep: 0.82, drift: 0.965, scatter: 0.03, gain: 0.5, height: [40, 120] },
  // great tit: "zee-ka zee-ka"
  { habitat: [0.4, 0.8, 0.2, 0.2], wave: 'sine', notes: [4, 8], dur: [0.07, 0.09], gap: [0.05, 0.07], freq: [4900, 5400], sweep: 0.92, alt: 0.74, scatter: 0.01, gain: 0.45, height: [30, 100] },
  // cuckoo: "ku-ku" pairs far away in the forest
  { habitat: [0, 0.35, 0.1, 0.1], wave: 'sine', notes: [4, 10], dur: [0.16, 0.2], gap: [0.12, 0.15], freq: [640, 720], sweep: 0.97, alt: 0.8, altGap: 4.2, scatter: 0.004, gain: 0.35, height: [60, 140] },
  // skylark: an endless warble high above the meadow
  { habitat: [0, 0.05, 1, 0.2], wave: 'sine', notes: [18, 32], dur: [0.035, 0.08], gap: [0.006, 0.03], freq: [2800, 4800], sweep: 1.15, scatter: 0.25, gain: 0.35, height: [150, 300] },
  // sparrow: a few chirps
  { habitat: [1, 0.1, 0.4, 0.1], wave: 'sine', notes: [2, 5], dur: [0.05, 0.08], gap: [0.12, 0.3], freq: [2900, 3700], sweep: 1.4, scatter: 0.08, gain: 0.4, height: [20, 60] },
  // hooded crow: hoarse caws over the town and the hills
  { habitat: [0.7, 0.1, 0.15, 0.6], wave: 'sawtooth', formants: [{ f: 1300, q: 3 }, { f: 2500, q: 5, g: 0.4 }], notes: [2, 4], dur: [0.22, 0.3], gap: [0.25, 0.4], freq: [470, 560], sweep: 0.86, scatter: 0.04, gain: 0.3, height: [60, 160] },
];
