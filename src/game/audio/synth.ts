/**
 * WebAudio building blocks: the shared buffer bank and the schedulers that turn recipes (recipes.ts) into
 * short-lived node graphs. Schedulers keep no state; every node they create is reported to a NodeSink so
 * its owner can stop and disconnect it once the sound is over.
 */
import { pitchJitter } from './mix';
import type { BedSpec, BirdSong, BufferName, Formant, Layer, NoiseColor, SoundRecipe } from './recipes';
import { fillSeamless, noiseStream, normalizeRms, renderBubbles, renderCrackle, renderCrickets } from './textures';

/** Shared state of the synthesiser: the context, its looping buffers and the random source. */
export interface Synth {
  readonly ac: AudioContext;
  readonly buffers: Readonly<Record<BufferName, AudioBuffer>>;
  readonly random: () => number;
  /** Highest frequency (Hz) given to a filter or oscillator (safely below Nyquist). */
  readonly maxHz: number;
}

/** Collects the nodes of one sound so that its owner can stop and disconnect them later. */
export interface NodeSink {
  node(n: AudioNode): void;
  source(s: AudioScheduledSourceNode): void;
}

/** Default random pitch deviation of a sound (±5 %, PlayOptions.pitch). */
export const DEFAULT_JITTER = 0.05;
/** RMS of every noise buffer, so recipe gains are comparable across colours. */
const NOISE_RMS = 0.25;
/** Lengths (s) of the one-shot noises and of the ambience/loop textures (different, so they never line up). */
const NOISE_S = 3;
const AIR_PINK_S = 5;
const AIR_BROWN_S = 6;
const CRACKLE_S = 4.7;
const BUBBLES_S = 5.3;
const CRICKETS_S = 4;
/** Envelopes start and end at this gain (exponential ramps cannot reach 0). */
const FLOOR = 1e-4;
/** Shortest attack and decay (s) an envelope is given. */
const MIN_ATTACK = 0.0002;
const MIN_DECAY = 0.003;
/** Minimum spacing of grain onsets (s). */
const MIN_GRAIN = 0.004;
/** Sources stop this long after their envelope reaches the floor. */
const STOP_PAD = 0.02;
const MAX_GRAINS = 32;
const MIN_HZ = 20;
/** Attack of a bird note (s). */
const NOTE_ATTACK = 0.008;

/** Builds every buffer once (≈ 9 MB of samples at 48 kHz, a few tens of ms of CPU at unlock). */
export function createSynth(ac: AudioContext, random: () => number): Synth {
  const sr = ac.sampleRate;
  const make = (seconds: number, channels: number): AudioBuffer => ac.createBuffer(channels, Math.round(seconds * sr), sr);
  const noise = (color: NoiseColor, seconds: number, channels: number): AudioBuffer => {
    const b = make(seconds, channels);
    for (let c = 0; c < channels; c++) {
      const data = b.getChannelData(c);
      fillSeamless(data, noiseStream(color, random), sr);
      normalizeRms(data, NOISE_RMS);
    }
    return b;
  };
  const crackle = make(CRACKLE_S, 1);
  renderCrackle(crackle.getChannelData(0), sr, random);
  const bubbles = make(BUBBLES_S, 1);
  renderBubbles(bubbles.getChannelData(0), sr, random);
  const crickets = make(CRICKETS_S, 2);
  renderCrickets(crickets.getChannelData(0), crickets.getChannelData(1), sr, random);
  return {
    ac,
    random,
    maxHz: Math.min(20000, sr * 0.45),
    buffers: {
      white: noise('white', NOISE_S, 1),
      pink: noise('pink', NOISE_S, 1),
      brown: noise('brown', NOISE_S, 1),
      airPink: noise('pink', AIR_PINK_S, 2),
      airBrown: noise('brown', AIR_BROWN_S, 2),
      crackle,
      bubbles,
      crickets,
    },
  };
}

/** A frequency clamped to the audible, representable range. */
const clampHz = (f: number, maxHz: number): number => (f > MIN_HZ ? (f < maxHz ? f : maxHz) : MIN_HZ);

/**
 * Schedules `recipe` at audio time `t0` (pitch = playback-rate multiplier) into `dest`, repeats included.
 * Returns the time when its last source stops.
 */
export function scheduleSound(sx: Synth, recipe: SoundRecipe, t0: number, pitch: number, dest: AudioNode, sink: NodeSink): number {
  const { random } = sx;
  const { layers, repeat } = recipe;
  let end = t0;
  let t = t0;
  let level = 1;
  let p = pitch;
  for (let k = 0; ; k++) {
    for (let i = 0; i < layers.length; i++) end = Math.max(end, scheduleLayer(sx, layers[i], t, p, level, dest, sink));
    if (repeat === undefined || k >= repeat.max || random() >= repeat.chance) return end;
    t += (repeat.gap / p) * (0.85 + 0.3 * random());
    level *= repeat.gain ?? 1;
    p = pitchJitter(pitch, recipe.jitter ?? DEFAULT_JITTER, random());
  }
}

const onsets = new Float64Array(MAX_GRAINS);

/** Grain onsets of `layer` into `onsets` (sorted, ≥ MIN_GRAIN apart); returns the count. */
function grainOnsets(layer: Layer, start: number, rate: number, rand: () => number): number {
  const n = Math.max(1, Math.min(MAX_GRAINS, layer.grains ?? 1));
  const spread = (layer.spread ?? 0) * rate;
  onsets[0] = start;
  for (let i = 1; i < n; i++) onsets[i] = start + rand() * spread;
  if (n > 2) onsets.subarray(1, n).sort();
  for (let i = 1; i < n; i++) if (onsets[i] < onsets[i - 1] + MIN_GRAIN) onsets[i] = onsets[i - 1] + MIN_GRAIN;
  return n;
}

/** One layer: source → (filter | formants) → envelope gain → dest. Returns its stop time (t0 if skipped). */
function scheduleLayer(sx: Synth, layer: Layer, t0: number, pitch: number, level: number, dest: AudioNode, sink: NodeSink): number {
  const { ac, random } = sx;
  if (layer.chance !== undefined && random() >= layer.chance) return t0;
  const rate = 1 / pitch;
  const start = t0 + (layer.at ?? 0) * rate;
  const attack = Math.max(MIN_ATTACK, layer.attack * rate);
  const hold = (layer.hold ?? 0) * rate;
  const length = attack + hold + Math.max(MIN_DECAY, layer.decay * rate);
  const count = grainOnsets(layer, start, rate, random);

  const env = ac.createGain();
  env.gain.value = 0;
  env.connect(dest);
  sink.node(env);
  let src: AudioScheduledSourceNode;
  let freq: AudioParam;
  if ('noise' in layer) {
    const buffer = sx.buffers[layer.noise];
    const s = ac.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.playbackRate.value = pitch;
    const f = ac.createBiquadFilter();
    f.type = layer.filter;
    if (layer.q !== undefined) f.Q.value = layer.q;
    s.connect(f);
    f.connect(env);
    sink.node(f);
    s.start(start, random() * buffer.duration);
    src = s;
    freq = f.frequency;
  } else {
    const o = ac.createOscillator();
    o.type = layer.wave;
    voice(sx, o, layer.formants, pitch, env, sink);
    o.start(start);
    src = o;
    freq = o.frequency;
  }
  sink.node(src);
  sink.source(src);

  let end = start;
  for (let i = 0; i < count; i++) {
    const t = onsets[i];
    const e = i + 1 < count ? Math.min(t + length, onsets[i + 1]) : t + length;
    const scale = pitch * (1 + (layer.freqVar ?? 0) * (2 * random() - 1));
    glide(freq, t, e, layer.freq, scale, layer.wobble ?? 0, random, sx.maxHz);
    envelope(env.gain, t, attack, hold, e, level * layer.gain * (1 - (layer.ampVar ?? 0) * random()));
    end = e;
  }
  src.stop(end + STOP_PAD);
  return end + STOP_PAD;
}

/** Connects a voiced source straight to `dest` or through a bank of parallel band-pass formants. */
function voice(sx: Synth, src: AudioNode, formants: readonly Formant[] | undefined, pitch: number, dest: AudioNode, sink: NodeSink): void {
  if (formants === undefined) {
    src.connect(dest);
    return;
  }
  const { ac } = sx;
  for (let i = 0; i < formants.length; i++) {
    const fm = formants[i];
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = clampHz(fm.f * pitch, sx.maxHz);
    bp.Q.value = fm.q;
    src.connect(bp);
    sink.node(bp);
    if (fm.g === undefined || fm.g === 1) {
      bp.connect(dest);
      continue;
    }
    const g = ac.createGain();
    g.gain.value = fm.g;
    bp.connect(g);
    g.connect(dest);
    sink.node(g);
  }
}

/** Frequency contour over [t, end]: one value, or exponential glides between evenly spaced points. */
function glide(p: AudioParam, t: number, end: number, freq: number | readonly number[], scale: number, wobble: number, rand: () => number, maxHz: number): void {
  if (typeof freq === 'number') {
    p.setValueAtTime(clampHz(freq * scale, maxHz), t);
    return;
  }
  const last = freq.length - 1;
  p.setValueAtTime(clampHz(freq[0] * scale * deviate(wobble, rand), maxHz), t);
  for (let i = 1; i <= last; i++) {
    p.exponentialRampToValueAtTime(clampHz(freq[i] * scale * deviate(wobble, rand), maxHz), t + ((end - t) * i) / last);
  }
}

const deviate = (amount: number, rand: () => number): number => (amount > 0 ? 1 + amount * (2 * rand() - 1) : 1);

/** Linear attack to `peak`, optional hold, exponential decay to the floor at `end`. */
function envelope(p: AudioParam, t: number, attack: number, hold: number, end: number, peak: number): void {
  const top = Math.max(peak, 2 * FLOOR);
  const a = t + Math.min(attack, (end - t) * 0.5);
  p.setValueAtTime(FLOOR, t);
  p.linearRampToValueAtTime(top, a);
  if (hold > 0 && a + hold < end - MIN_DECAY) p.setValueAtTime(top, a + hold);
  p.exponentialRampToValueAtTime(FLOOR, end);
}

/** Schedules one bird song at `t0` into `dest`; returns when its oscillator stops. */
export function scheduleSong(sx: Synth, song: BirdSong, t0: number, level: number, dest: AudioNode, sink: NodeSink): number {
  const { ac, random, maxHz } = sx;
  const o = ac.createOscillator();
  o.type = song.wave;
  const env = ac.createGain();
  env.gain.value = 0;
  voice(sx, o, song.formants, 1, env, sink);
  env.connect(dest);
  sink.node(env);
  sink.node(o);
  sink.source(o);
  const notes = Math.round(between(song.notes, random));
  let base = between(song.freq, random);
  let t = t0;
  let end = t0;
  for (let i = 0; i < notes; i++) {
    const odd = (i & 1) === 1;
    const f = clampHz(base * (odd ? (song.alt ?? 1) : 1) * deviate(song.scatter ?? 0, random), maxHz);
    const dur = between(song.dur, random);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(clampHz(f * song.sweep, maxHz), t + dur);
    envelope(env.gain, t, Math.min(NOTE_ATTACK, dur * 0.3), 0, t + dur, level * song.gain * (0.8 + 0.2 * random()));
    end = t + dur;
    base *= song.drift ?? 1;
    t = end + between(song.gap, random) * (odd ? (song.altGap ?? 1) : 1);
  }
  o.start(t0);
  o.stop(end + STOP_PAD);
  return end + STOP_PAD;
}

const between = (range: readonly [number, number], rand: () => number): number => range[0] + (range[1] - range[0]) * rand();

/** A looping buffer through a filter into a gain (loops and ambience). */
export interface Bed {
  readonly source: AudioBufferSourceNode;
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
}

/** Starts `spec` now (random buffer offset, playback rate × `rate`) into `dest`. */
export function createBed(sx: Synth, spec: BedSpec, dest: AudioNode, sink: NodeSink, rate = 1): Bed {
  const { ac, random } = sx;
  const now = ac.currentTime;
  const buffer = sx.buffers[spec.buffer];
  const source = ac.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.playbackRate.value = (spec.rate ?? 1) * rate;
  const filter = ac.createBiquadFilter();
  filter.type = spec.filter;
  filter.frequency.value = clampHz(spec.freq, sx.maxHz);
  if (spec.q !== undefined) filter.Q.value = spec.q;
  const gain = ac.createGain();
  source.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  const lfo = spec.lfo;
  if (lfo === undefined) {
    gain.gain.value = spec.gain;
  } else {
    // gain swings between spec.gain·(1 − depth) and spec.gain; a random start delay randomises the phase.
    gain.gain.value = spec.gain * (1 - lfo.depth / 2);
    const osc = ac.createOscillator();
    osc.frequency.value = lfo.rate;
    const depth = ac.createGain();
    depth.gain.value = (spec.gain * lfo.depth) / 2;
    osc.connect(depth);
    depth.connect(gain.gain);
    osc.start(now + random() / lfo.rate);
    sink.node(osc);
    sink.source(osc);
    sink.node(depth);
  }
  source.start(now, random() * buffer.duration);
  sink.node(source);
  sink.source(source);
  sink.node(filter);
  sink.node(gain);
  return { source, filter, gain };
}

/** An 'equalpower' panner with the 'inverse' distance model. */
export function createPanner(ac: AudioContext, ref: number, maxDistance: number): PannerNode {
  const p = ac.createPanner();
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = ref;
  p.maxDistance = maxDistance;
  p.rolloffFactor = 1;
  return p;
}

/** Moves a panner at once, or gliding with time constant `glideS`; setPosition() where position params are missing. */
export function placePanner(p: PannerNode, x: number, y: number, z: number, now: number, glideS = 0): void {
  if (!p.positionX) {
    p.setPosition(x, y, z);
  } else if (glideS > 0) {
    p.positionX.setTargetAtTime(x, now, glideS);
    p.positionY.setTargetAtTime(y, now, glideS);
    p.positionZ.setTargetAtTime(z, now, glideS);
  } else {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  }
}
