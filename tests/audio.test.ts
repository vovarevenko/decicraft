/**
 * GameAudio against a fake WebAudio graph. The fake records every node, connection and automation event
 * and can render a sub-graph offline (biquads per the WebAudio formulas, oscillators, looping buffers,
 * gain automation, inverse-distance panning), so the tests also measure loudness, clipping and length.
 * AUDIO_REPORT=1 prints the level table used to calibrate recipes.ts.
 */
import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { Rng } from '../src/core/rng';
import { GameAudio, MAX_VOICES, type SoundName } from '../src/game/audio';
import { SOUNDS } from '../src/game/audio/recipes';
import type { GameContext } from '../src/game/context';
import type { ColumnSample } from '../src/gen/types';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const REPORT = Boolean(env?.AUDIO_REPORT);
/** Hard timing targets are asserted only in benchmark runs (BENCH=1); the parallel suite just reports timings. */
const BENCH = Boolean(env?.BENCH);
const BLOCK = 128;
const NAMES = Object.keys(SOUNDS) as SoundName[];

// ------------------------------------------------------------------------------------------------ fake

type EvKind = 'set' | 'linear' | 'exp' | 'target';
interface Ev {
  kind: EvKind;
  value: number;
  time: number;
  tc: number;
}

class FakeParam {
  readonly events: Ev[] = [];
  readonly inputs: FakeNode[] = [];
  reader: ParamReader | null = null;
  private v: number;

  constructor(v: number) {
    this.v = v;
  }

  get value(): number {
    return this.v;
  }

  set value(v: number) {
    if (!Number.isFinite(v)) throw new TypeError(`non-finite AudioParam value ${v}`);
    this.v = v;
  }

  setValueAtTime(v: number, t: number): this {
    return this.add('set', v, t, 0);
  }

  linearRampToValueAtTime(v: number, t: number): this {
    return this.add('linear', v, t, 0);
  }

  exponentialRampToValueAtTime(v: number, t: number): this {
    if (!(v > 0)) throw new RangeError(`exponential ramp to ${v}`);
    return this.add('exp', v, t, 0);
  }

  setTargetAtTime(v: number, t: number, tc: number): this {
    if (!(tc >= 0)) throw new RangeError(`time constant ${tc}`);
    return this.add('target', v, t, tc);
  }

  /** The latest event (of a kind). */
  last(kind?: EvKind): Ev | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) if (kind === undefined || this.events[i].kind === kind) return this.events[i];
    return undefined;
  }

  private add(kind: EvKind, value: number, time: number, tc: number): this {
    if (!Number.isFinite(value) || !Number.isFinite(time)) throw new TypeError(`non-finite automation ${kind} ${value} @ ${time}`);
    if (time < 0) throw new RangeError(`negative time ${time}`);
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > time) i--;
    this.events.splice(i, 0, { kind, value, time, tc });
    return this;
  }
}

/** Evaluates a param's automation for monotonically increasing times. */
class ParamReader {
  private i = 0;
  private value: number;
  private time = 0;
  private target: Ev | null = null;

  constructor(private readonly p: FakeParam) {
    this.value = p.value;
  }

  at(t: number): number {
    const ev = this.p.events;
    while (this.i < ev.length && ev[this.i].time <= t) {
      const e = ev[this.i++];
      const v = this.curve(e.time);
      this.time = e.time;
      this.target = e.kind === 'target' ? e : null;
      this.value = e.kind === 'target' ? v : e.value;
    }
    const next = ev[this.i];
    if (next !== undefined && this.target === null && (next.kind === 'linear' || next.kind === 'exp')) {
      const f = (t - this.time) / (next.time - this.time);
      if (next.kind === 'linear') return this.value + (next.value - this.value) * f;
      return this.value > 0 ? this.value * Math.pow(next.value / this.value, f) : this.value;
    }
    return this.curve(t);
  }

  private curve(t: number): number {
    const g = this.target;
    return g === null ? this.value : g.value + (this.value - g.value) * Math.exp(-(t - g.time) / Math.max(g.tc, 1e-9));
  }
}

type Dest = FakeNode | FakeParam;
type Pull = (n: FakeNode) => Float32Array;

abstract class FakeNode {
  readonly inputs: FakeNode[] = [];
  outputs: Dest[] = [];
  disconnects = 0;
  /** Render state initialised. */
  rendering = false;
  buf: Float32Array | null = null;

  constructor(readonly ctx: FakeContext) {
    ctx.nodes.push(this);
  }

  connect<T extends Dest>(dest: T): T {
    this.outputs.push(dest);
    dest.inputs.push(this);
    return dest;
  }

  disconnect(): void {
    for (const d of this.outputs) {
      const k = d.inputs.indexOf(this);
      if (k >= 0) d.inputs.splice(k, 1);
    }
    this.outputs = [];
    this.disconnects++;
  }

  get released(): boolean {
    return this.outputs.length === 0 && this.disconnects > 0;
  }

  params(): FakeParam[] {
    return [];
  }

  init(): void {
    for (const p of this.params()) p.reader = new ParamReader(p);
  }

  /** `b` holds the summed inputs; leaves the node's output in it. */
  process(_b: Float32Array, _t0: number, _sr: number, _pull: Pull): void {}
}

/** Sum of the nodes connected to a param (LFOs), or null. */
function modulation(p: FakeParam, pull: Pull): Float32Array | null {
  if (p.inputs.length === 0) return null;
  const m = new Float32Array(BLOCK);
  for (const n of p.inputs) {
    const b = pull(n);
    for (let k = 0; k < BLOCK; k++) m[k] += b[k];
  }
  return m;
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);

  params(): FakeParam[] {
    return [this.gain];
  }

  process(b: Float32Array, t0: number, sr: number, pull: Pull): void {
    const mod = modulation(this.gain, pull);
    const r = this.gain.reader!;
    for (let k = 0; k < BLOCK; k++) b[k] *= r.at(t0 + k / sr) + (mod === null ? 0 : mod[k]);
  }
}

class FakeBiquad extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  params(): FakeParam[] {
    return [this.frequency, this.Q];
  }

  process(b: Float32Array, t0: number, sr: number): void {
    const f = Math.min(sr * 0.4999, Math.max(1, this.frequency.reader!.at(t0)));
    const q = this.Q.reader!.at(t0);
    const w = (2 * Math.PI * f) / sr;
    const cos = Math.cos(w);
    const sin = Math.sin(w);
    let b0: number;
    let b1: number;
    let b2: number;
    let alpha: number;
    if (this.type === 'bandpass') {
      alpha = sin / (2 * q);
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    } else if (this.type === 'lowpass' || this.type === 'highpass') {
      alpha = sin / (2 * 10 ** (q / 20)); // WebAudio: Q in dB for low/high-pass
      const s = this.type === 'lowpass' ? 1 : -1;
      b0 = (1 - s * cos) / 2;
      b1 = s * (1 - s * cos);
      b2 = b0;
    } else {
      throw new Error(`filter type ${this.type} is not rendered`);
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    for (let k = 0; k < BLOCK; k++) {
      const x = b[k];
      const y = (b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2) / a0;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      b[k] = y;
    }
  }
}

abstract class FakeScheduled extends FakeNode {
  startTime = -1;
  offset = 0;
  stopTime = Infinity;

  start(when = 0, offset = 0): void {
    if (this.startTime >= 0) throw new Error('InvalidStateError: start() called twice');
    if (!(when >= 0) || !(offset >= 0) || !Number.isFinite(when) || !Number.isFinite(offset)) throw new RangeError(`start(${when}, ${offset})`);
    this.startTime = when;
    this.offset = offset;
  }

  stop(when = 0): void {
    if (this.startTime < 0) throw new Error('InvalidStateError: stop() before start()');
    if (!(when >= 0) || !Number.isFinite(when)) throw new RangeError(`stop(${when})`);
    this.stopTime = when;
  }

  playing(t: number): boolean {
    return this.startTime >= 0 && t >= this.startTime && t < this.stopTime;
  }
}

const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];

class FakeOscillator extends FakeScheduled {
  readonly frequency = new FakeParam(440);
  private wave: OscillatorType = 'sine';
  private phase = 0;

  get type(): OscillatorType {
    return this.wave;
  }

  set type(t: OscillatorType) {
    if (!WAVES.includes(t)) throw new Error(`InvalidStateError: oscillator type ${t}`);
    this.wave = t;
  }

  params(): FakeParam[] {
    return [this.frequency];
  }

  process(b: Float32Array, t0: number, sr: number): void {
    const r = this.frequency.reader!;
    for (let k = 0; k < BLOCK; k++) {
      const t = t0 + k / sr;
      const f = r.at(t);
      if (!this.playing(t)) {
        b[k] = 0;
        continue;
      }
      this.phase = (this.phase + f / sr) % 1;
      const p = this.phase;
      b[k] =
        this.wave === 'sine'
          ? Math.sin(2 * Math.PI * p)
          : this.wave === 'square'
            ? p < 0.5
              ? 1
              : -1
            : this.wave === 'sawtooth'
              ? 2 * p - 1
              : p < 0.25
                ? 4 * p
                : p < 0.75
                  ? 2 - 4 * p
                  : 4 * p - 4;
    }
  }
}

class FakeBuffer {
  readonly data: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    if (!(length > 0) || !(numberOfChannels > 0)) throw new Error('NotSupportedError: createBuffer');
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(c: number): Float32Array {
    const d = this.data[c];
    if (d === undefined) throw new Error('IndexSizeError: channel');
    return d;
  }
}

class FakeBufferSource extends FakeScheduled {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  private pos = -1;

  params(): FakeParam[] {
    return [this.playbackRate];
  }

  process(b: Float32Array, t0: number, sr: number): void {
    const buf = this.buffer;
    const r = this.playbackRate.reader!;
    for (let k = 0; k < BLOCK; k++) {
      const t = t0 + k / sr;
      const rate = r.at(t);
      if (buf === null || !this.playing(t)) {
        b[k] = 0;
        continue;
      }
      if (this.pos < 0) this.pos = (this.offset + (t - this.startTime) * rate) * buf.sampleRate;
      if (this.loop) this.pos %= buf.length;
      else if (this.pos >= buf.length) {
        b[k] = 0;
        continue;
      }
      const i = Math.floor(this.pos);
      let v = 0;
      for (const ch of buf.data) v += ch[i];
      b[k] = v / buf.data.length;
      this.pos += (rate * buf.sampleRate) / sr;
    }
  }
}

class FakePanner extends FakeNode {
  panningModel: PanningModelType = 'HRTF';
  distanceModel: DistanceModelType = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);

  params(): FakeParam[] {
    return [this.positionX, this.positionY, this.positionZ];
  }

  process(b: Float32Array, t0: number): void {
    const l = this.ctx.listener;
    const d = Math.hypot(
      this.positionX.reader!.at(t0) - l.positionX.value,
      this.positionY.reader!.at(t0) - l.positionY.value,
      this.positionZ.reader!.at(t0) - l.positionZ.value,
    );
    const ref = this.refDistance;
    const g = ref / (ref + this.rolloffFactor * (Math.max(d, ref) - ref));
    for (let k = 0; k < BLOCK; k++) b[k] *= g;
  }
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
}

class FakeDestination extends FakeNode {}

class FakeListener {
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);
  readonly forwardX = new FakeParam(0);
  readonly forwardY = new FakeParam(0);
  readonly forwardZ = new FakeParam(-1);
  readonly upX = new FakeParam(0);
  readonly upY = new FakeParam(1);
  readonly upZ = new FakeParam(0);
}

class FakeContext {
  currentTime = 0;
  state: AudioContextState;
  resumes = 0;
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeDestination;
  readonly listener = new FakeListener();

  constructor(
    readonly sampleRate = 8000,
    state: AudioContextState = 'running',
  ) {
    this.state = state;
    this.destination = new FakeDestination(this);
  }

  resume(): Promise<void> {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  }

  createGain(): FakeGain {
    return new FakeGain(this);
  }

  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad(this);
  }

  createOscillator(): FakeOscillator {
    return new FakeOscillator(this);
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }

  createPanner(): FakePanner {
    return new FakePanner(this);
  }

  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    return new FakeBuffer(channels, length, sampleRate);
  }

  since(count: number): FakeNode[] {
    return this.nodes.slice(count);
  }
}

/** Offline renderer of everything upstream of `root`, block by block from `from`. */
class Renderer {
  time: number;
  private t0 = 0;
  private readonly memo = new Map<FakeNode, Float32Array>();

  constructor(
    private readonly ctx: FakeContext,
    private readonly root: FakeNode,
    from = ctx.currentTime,
  ) {
    this.time = from;
  }

  /** Renders whole blocks up to `until` (s) and returns them. */
  advance(until: number): Float32Array {
    const sr = this.ctx.sampleRate;
    const n = Math.max(0, Math.round(((until - this.time) * sr) / BLOCK)) * BLOCK;
    const out = new Float32Array(n);
    for (let s = 0; s < n; s += BLOCK) {
      this.t0 = this.time + s / sr;
      this.memo.clear();
      out.set(this.pull(this.root), s);
    }
    this.time += n / sr;
    return out;
  }

  private readonly pull: Pull = (node) => {
    const done = this.memo.get(node);
    if (done !== undefined) return done;
    if (!node.rendering) {
      node.rendering = true;
      node.init();
    }
    const b = (node.buf ??= new Float32Array(BLOCK));
    b.fill(0);
    for (const input of node.inputs) {
      const ib = this.pull(input);
      for (let k = 0; k < BLOCK; k++) b[k] += ib[k];
    }
    node.process(b, this.t0, this.ctx.sampleRate, this.pull);
    this.memo.set(node, b);
    return b;
  };
}

// ------------------------------------------------------------------------------------------------ helpers

const db = (v: number): number => 20 * Math.log10(Math.max(v, 1e-9));

/** Third-octave bands (100 Hz – 10 kHz) of the spectral part of a fingerprint, frame length (s) and floor (dB) of its envelope. */
const BANDS = Array.from({ length: 21 }, (_, k) => 100 * 2 ** (k / 3));
const BAND_Q = 4.32;
const FRAME_S = 0.05;
const FLOOR_DB = -40;

interface Fingerprint {
  /** Energy per third-octave band, dB relative to the total. */
  spectrum: number[];
  /** Energy per 50 ms frame from the onset, dB relative to the loudest frame (floored). */
  envelope: number[];
}

/** Timbre and shape of a sound, robust to the random timing of its grains. */
function fingerprint(x: Float32Array, sr: number): Fingerprint {
  const energy = BANDS.map((f) => {
    const w = (2 * Math.PI * f) / sr;
    const alpha = Math.sin(w) / (2 * BAND_Q);
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(w);
    const a2 = 1 - alpha;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      const y = (alpha * x[i] - alpha * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1;
      x1 = x[i];
      y2 = y1;
      y1 = y;
      sum += y * y;
    }
    return sum;
  });
  const total = energy.reduce((a, v) => a + v, 0);
  const frame = Math.round(FRAME_S * sr);
  const frames = new Array<number>(Math.ceil(x.length / frame)).fill(0);
  for (let i = 0; i < x.length; i++) frames[Math.floor(i / frame)] += x[i] * x[i];
  const loudest = Math.max(...frames);
  return {
    spectrum: energy.map((v) => 10 * Math.log10(Math.max(v / total, 1e-6))),
    envelope: frames.map((v) => Math.max(FLOOR_DB, 10 * Math.log10(Math.max(v / loudest, 1e-12)))),
  };
}

/** Mean band difference plus half the mean envelope difference (dB; envelopes aligned at the onset). */
function distance(a: Fingerprint, b: Fingerprint): number {
  let spectral = 0;
  for (let k = 0; k < BANDS.length; k++) spectral += Math.abs(a.spectrum[k] - b.spectrum[k]);
  const frames = Math.max(a.envelope.length, b.envelope.length);
  let shape = 0;
  for (let k = 0; k < frames; k++) shape += Math.abs((a.envelope[k] ?? FLOOR_DB) - (b.envelope[k] ?? FLOOR_DB));
  return spectral / BANDS.length + (0.5 * shape) / frames;
}

/** Peak, loudest 50 ms RMS, audible length (above −40 dB of the peak) and zero-crossing rate. */
function measure(x: Float32Array, sr: number) {
  let peak = 0;
  let finite = true;
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) finite = false;
    peak = Math.max(peak, Math.abs(v));
    sq[i + 1] = sq[i] + v * v;
  }
  const win = Math.min(x.length, Math.round(0.05 * sr));
  let loud = 0;
  for (let s = 0; s + win <= x.length; s += Math.round(0.005 * sr)) loud = Math.max(loud, Math.sqrt((sq[s + win] - sq[s]) / win));
  let first = -1;
  let lastI = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < peak * 0.01) continue;
    if (first < 0) first = i;
    lastI = i;
  }
  let crossings = 0;
  for (let i = Math.max(1, first); i <= lastI; i++) if (x[i - 1] < 0 !== x[i] < 0) crossings++;
  const dur = first < 0 ? 0 : (lastI - first) / sr;
  return { finite, peak, peakDb: db(peak), loudDb: db(loud), dur, zcr: dur > 0 ? crossings / dur : 0 };
}

interface Scene {
  weights?: [number, number, number, number];
  hour?: number;
  /** skyHeight() of every column (roofs above the listener when high). */
  roofY?: number;
  waterY?: (x: number, z: number) => number;
  underwater?: boolean;
  pos?: [number, number, number];
}

/** The parts of GameContext that GameAudio.update reads. */
function scene(s: Scene = {}) {
  const camera = new THREE.PerspectiveCamera();
  const [x, y, z] = s.pos ?? [900, 136, 300];
  camera.position.set(x, y, z);
  const weights = s.weights ?? [0, 1, 0, 0];
  const terrain = {
    sample(cx: number, cz: number, out: ColumnSample): ColumnSample {
      for (let i = 0; i < 4; i++) out.weights[i] = weights[i];
      out.waterY = s.waterY?.(cx, cz) ?? 0;
      return out;
    },
    surfaceY: () => 120,
    biomeAt: () => 1,
  };
  const parts = {
    camera,
    terrain,
    world: { skyHeight: () => s.roofY ?? 0 },
    time: { elapsed: 0, timeOfDay: s.hour ?? 12, speed: 1 },
    player: { eyeInWater: s.underwater ?? false, position: camera.position },
  };
  return { ...parts, game: parts as unknown as GameContext };
}

function setup(sampleRate = 8000, seed = 7) {
  const ac = new FakeContext(sampleRate);
  const rng = new Rng(seed);
  const factory = vi.fn(() => ac as unknown as AudioContext);
  const audio = new GameAudio({ createContext: factory, random: () => rng.next() });
  return { ac, audio, factory };
}

const sources = (nodes: FakeNode[]): FakeScheduled[] => nodes.filter((n): n is FakeScheduled => n instanceof FakeScheduled);

/** The single new node that feeds into the pre-existing graph (a voice's output gain or panner). */
function voiceRoot(ac: FakeContext, before: number): FakeNode {
  const fresh = new Set(ac.since(before));
  const roots = [...fresh].filter((n) => n.outputs.some((o) => o instanceof FakeNode && !fresh.has(o)));
  expect(roots).toHaveLength(1);
  return roots[0];
}

/** master gain: destination ← limiter ← underwater low-pass ← master. */
function masterGain(ac: FakeContext): FakeGain {
  const limiter = ac.destination.inputs[0];
  const lowpass = limiter.inputs[0];
  return lowpass.inputs[0] as FakeGain;
}

/** Runs update() every ~0.1 s for `seconds`, rendering the speakers' signal along the way. */
function run(audio: GameAudio, ac: FakeContext, game: GameContext, seconds: number): Float32Array {
  const r = new Renderer(ac, ac.destination);
  const tick = (BLOCK * Math.round((0.1 * ac.sampleRate) / BLOCK)) / ac.sampleRate;
  const end = r.time + seconds;
  const parts: Float32Array[] = [];
  while (r.time < end - 1e-9) {
    ac.currentTime = r.time;
    audio.update(tick, game);
    parts.push(r.advance(r.time + tick));
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ tests

describe('GameAudio before unlock', () => {
  test('every public method is a silent no-op and startLoop returns an inert handle', () => {
    const { audio, factory } = setup();
    const { game } = scene();
    expect(() => {
      audio.play('dig_dirt');
      audio.play('dog_bark', { pos: { x: 1, y: 2, z: 3 }, volume: 0.5, pitch: 1.2 });
      const loop = audio.startLoop('fire', { pos: { x: 0, y: 0, z: 0 }, volume: 1 });
      loop.setVolume(0.3);
      loop.setPosition({ x: 5, y: 5, z: 5 });
      loop.stop();
      loop.stop();
      audio.update(1 / 60, game);
      audio.setPaused(true);
      audio.setPaused(false);
    }).not.toThrow();
    expect(factory).not.toHaveBeenCalled();
    expect(audio.unlocked).toBe(false);
    expect(audio.activeVoices).toBe(0);
  });

  test('stays silent when the browser has no WebAudio or creating the context fails', () => {
    const none = new GameAudio({ createContext: () => null });
    none.unlock();
    expect(none.unlocked).toBe(false);
    none.play('splash');
    none.startLoop('water').setVolume(1);
    const failing = new GameAudio({
      createContext: () => {
        throw new Error('NotAllowedError');
      },
    });
    expect(() => failing.unlock()).not.toThrow();
    expect(failing.unlocked).toBe(false);
    // node has no AudioContext: the default factory yields none
    const plain = new GameAudio();
    plain.unlock();
    expect(plain.unlocked).toBe(false);
  });
});

describe('GameAudio unlock and mixing graph', () => {
  test('one context per session, created by the first unlock(); a suspended context is resumed', () => {
    const ac = new FakeContext(8000, 'suspended');
    const factory = vi.fn(() => ac as unknown as AudioContext);
    const audio = new GameAudio({ createContext: factory });
    audio.unlock();
    expect(audio.unlocked).toBe(true);
    expect(ac.resumes).toBe(1);
    ac.state = 'suspended';
    audio.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ac.resumes).toBe(2);
    expect(ac.destination.inputs[0]).toBeInstanceOf(FakeCompressor);
  });

  test('setPaused ramps the master gain to 0 and back; a pause before unlock carries over', () => {
    const { ac, audio } = setup();
    audio.setPaused(true);
    audio.unlock();
    const master = masterGain(ac);
    expect(master.gain.value).toBe(0);
    ac.currentTime = 1;
    audio.setPaused(false);
    const up = master.gain.last('target')!;
    expect(up.time).toBe(1);
    expect(up.value).toBeGreaterThan(0.5);
    ac.currentTime = 2;
    audio.setPaused(true);
    expect(master.gain.last('target')).toMatchObject({ value: 0, time: 2 });
  });

  test('the listener follows the camera every frame', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const { game, camera } = scene({ pos: [10, 20, 30] });
    camera.rotation.set(0, Math.PI / 2, 0, 'YXZ'); // looking to -X
    audio.update(1 / 60, game);
    const l = ac.listener;
    expect([l.positionX.value, l.positionY.value, l.positionZ.value]).toEqual([10, 20, 30]);
    expect(l.forwardX.value).toBeCloseTo(-1, 6);
    expect(l.forwardZ.value).toBeCloseTo(0, 6);
    expect(l.upY.value).toBeCloseTo(1, 6);
    camera.position.set(11, 20, 30);
    audio.update(1 / 60, game);
    expect(l.positionX.value).toBe(11);
  });

  test('a head under water muffles everything with the master low-pass', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const lowpass = ac.destination.inputs[0].inputs[0] as FakeBiquad;
    const s = scene({ underwater: true });
    audio.update(1 / 60, s.game);
    expect(lowpass.type).toBe('lowpass');
    expect(lowpass.frequency.last('target')!.value).toBeLessThan(1000);
    s.player.eyeInWater = false;
    audio.update(1 / 60, s.game);
    expect(lowpass.frequency.last('target')!.value).toBeGreaterThan(3000);
  });
});

describe('GameAudio one-shots', () => {
  test('every SoundName plays and its nodes are stopped and disconnected after the envelope', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const { game } = scene({ pos: [0, 0, 0] });
    audio.update(0, game);
    for (const name of NAMES) {
      for (const pos of [undefined, { x: 40, y: 5, z: -30 }]) {
        const before = ac.nodes.length;
        expect(() => audio.play(name, { pos })).not.toThrow();
        const fresh = ac.since(before);
        const srcs = sources(fresh);
        expect(srcs.length, name).toBeGreaterThan(0);
        for (const s of srcs) {
          expect(s.startTime, name).toBeGreaterThanOrEqual(ac.currentTime);
          expect(Number.isFinite(s.stopTime), name).toBe(true);
        }
        expect(fresh.some((n) => n instanceof FakePanner)).toBe(pos !== undefined);
        const end = Math.max(...srcs.map((s) => s.stopTime));
        expect(end - ac.currentTime, name).toBeLessThan(4);
        ac.currentTime = end + 0.01;
        audio.update(1 / 60, game);
        for (const n of fresh) expect(n.released, `${name}: ${n.constructor.name}`).toBe(true);
        expect(audio.activeVoices).toBe(0);
      }
    }
  });

  test('pitch: opts.pitch multiplies, with the recipe jitter (±5 % by default) on top', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const firstTone = (pitch?: number): number => {
      const before = ac.nodes.length;
      audio.play('metal_hit', pitch === undefined ? undefined : { pitch });
      const osc = ac.since(before).find((n): n is FakeOscillator => n instanceof FakeOscillator)!;
      return osc.frequency.events[0].value;
    };
    for (let i = 0; i < 20; i++) {
      const f = firstTone();
      expect(f).toBeGreaterThanOrEqual(520 * 0.96 - 1e-6);
      expect(f).toBeLessThanOrEqual(520 * 1.04 + 1e-6);
      const g = firstTone(2);
      expect(g).toBeGreaterThanOrEqual(1040 * 0.96 - 1e-6);
      expect(g).toBeLessThanOrEqual(1040 * 1.04 + 1e-6);
      ac.currentTime += 2;
      audio.update(0, scene().game);
    }
  });

  test('positional sounds: equalpower/inverse panner at the position, nothing beyond the range', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const { game } = scene({ pos: [0, 0, 0] });
    audio.update(0, game);
    let before = ac.nodes.length;
    audio.play('dig_stone', { pos: { x: 100, y: 0, z: 0 } });
    const panner = ac.since(before).find((n): n is FakePanner => n instanceof FakePanner)!;
    expect(panner.panningModel).toBe('equalpower');
    expect(panner.distanceModel).toBe('inverse');
    expect(panner.refDistance).toBe(20);
    expect(panner.maxDistance).toBe(600);
    expect(panner.positionX.value).toBe(100);
    before = ac.nodes.length;
    audio.play('dig_stone', { pos: { x: 700, y: 0, z: 0 } });
    audio.play('dig_stone', { pos: { x: Number.NaN, y: 0, z: 0 } });
    audio.play('dig_stone', { volume: 0 });
    expect(ac.nodes.length).toBe(before);
    audio.play('tree_fall', { pos: { x: 900, y: 0, z: 0 } }); // carries farther
    const far = ac.since(before).find((n): n is FakePanner => n instanceof FakePanner)!;
    expect(far.refDistance).toBeGreaterThan(20);
  });

  test('the one-shot cap holds: the weakest voice is stolen, quieter newcomers are dropped', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const roots: FakeNode[] = [];
    for (let i = 0; i < 60; i++) {
      const before = ac.nodes.length;
      audio.play(i % 2 ? 'impact' : 'tree_fall', { volume: 0.5 + (i % 7) / 14 });
      if (ac.nodes.length > before) roots.push(voiceRoot(ac, before));
      expect(audio.activeVoices).toBeLessThanOrEqual(MAX_VOICES);
    }
    expect(audio.activeVoices).toBe(MAX_VOICES);
    // stolen voices fade their output to 0 and stop their sources within 50 ms; the rest keep playing
    const live = roots.filter((r) => (r as FakeGain).gain.last('target') === undefined);
    expect(live.length).toBe(MAX_VOICES);
    const stolen = roots.filter((r) => (r as FakeGain).gain.last('target')?.value === 0);
    expect(stolen.length).toBe(roots.length - MAX_VOICES);
    const before = ac.nodes.length;
    audio.play('step_grass', { volume: 0.01 });
    expect(ac.nodes.length).toBe(before);
    ac.currentTime = 10;
    audio.update(0, scene().game);
    expect(audio.activeVoices).toBe(0);
    for (const r of roots) expect(r.released).toBe(true);
  });
});

describe('GameAudio loops', () => {
  test('start, setVolume, setPosition, stop, then everything is disconnected', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const before = ac.nodes.length;
    const loop = audio.startLoop('fire', { pos: { x: 10, y: 1, z: 10 }, volume: 0.5 });
    const fresh = ac.since(before);
    const srcs = sources(fresh);
    expect(srcs.filter((s) => s instanceof FakeBufferSource && s.loop).length).toBe(3);
    for (const s of srcs) expect(s.stopTime).toBe(Infinity);
    const panner = fresh.find((n): n is FakePanner => n instanceof FakePanner)!;
    expect(panner.positionX.value).toBe(10);
    const out = panner.inputs[0] as FakeGain;
    expect(out.gain.last('target')!.value).toBeCloseTo(0.5, 6);
    ac.currentTime = 1;
    loop.setVolume(0.2);
    expect(out.gain.last('target')).toMatchObject({ value: 0.2, time: 1 });
    loop.setVolume(Number.NaN);
    expect(out.gain.last('target')!.value).toBe(0);
    loop.setPosition({ x: 12, y: 1, z: 9 });
    expect(panner.positionX.last('target')!.value).toBe(12);
    loop.stop();
    expect(out.gain.last('target')).toMatchObject({ value: 0, time: 1 });
    const end = srcs[0].stopTime;
    expect(end).toBeGreaterThan(1);
    expect(end).toBeLessThan(2);
    for (const s of srcs) expect(s.stopTime).toBe(end);
    const events = out.gain.events.length;
    loop.setVolume(1);
    loop.setPosition({ x: 0, y: 0, z: 0 });
    loop.stop();
    expect(out.gain.events.length).toBe(events);
    ac.currentTime = end + 0.01;
    audio.update(0, scene().game);
    for (const n of fresh) expect(n.released).toBe(true);
  });

  test('a loop started without a position becomes positional on setPosition', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const before = ac.nodes.length;
    const loop = audio.startLoop('water');
    expect(ac.since(before).some((n) => n instanceof FakePanner)).toBe(false);
    loop.setPosition({ x: 3, y: 4, z: 5 });
    const panner = ac.since(before).find((n): n is FakePanner => n instanceof FakePanner)!;
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([3, 4, 5]);
    expect(panner.outputs.length).toBe(1);
  });

  test('the campfire crackle and the lapping water render at their level, unclipped', () => {
    const { ac, audio } = setup(48000);
    audio.unlock();
    for (const [name, target] of [
      ['fire', -22],
      ['water', -27],
    ] as const) {
      ac.currentTime += 10;
      const before = ac.nodes.length;
      audio.startLoop(name, { volume: 1 });
      const x = new Renderer(ac, voiceRoot(ac, before)).advance(ac.currentTime + 8);
      const m = measure(x.subarray(x.length / 4), ac.sampleRate);
      if (REPORT) console.info(`${name} loop: ${m.loudDb.toFixed(1)} dB (loudest 50 ms), peak ${m.peakDb.toFixed(1)} dB`);
      expect(m.finite).toBe(true);
      expect(Math.abs(m.loudDb - target), name).toBeLessThan(4);
      expect(m.peakDb, name).toBeLessThan(-3);
    }
  });
});

describe('GameAudio ambience', () => {
  test('crossfades by biome, time of day, height and roofs; muted while paused', () => {
    const level = (s: Scene, seconds = 6): number => {
      const { ac, audio } = setup(16000, 3);
      audio.unlock();
      const x = run(audio, ac, scene(s).game, seconds);
      const tail = x.subarray(Math.floor(x.length / 2));
      const m = measure(tail, ac.sampleRate);
      expect(m.finite).toBe(true);
      let sq = 0;
      for (const v of tail) sq += v * v;
      return db(Math.sqrt(sq / tail.length));
    };
    const night = 1;
    const meadowNight = level({ weights: [0, 0, 1, 0], hour: night });
    const meadowDay = level({ weights: [0, 0, 1, 0], hour: 13 });
    const town = level({ weights: [1, 0, 0, 0], hour: 13 });
    const hilltop = level({ weights: [0, 0, 0, 1], hour: 13, pos: [900, 280, 900] });
    const indoors = level({ weights: [0, 0, 0, 1], hour: 13, pos: [900, 280, 900], roofY: 400 });
    if (REPORT) console.info({ meadowNight, meadowDay, town, hilltop, indoors });
    expect(hilltop).toBeGreaterThan(town + 6);
    expect(hilltop).toBeGreaterThan(indoors + 6);
    expect(meadowNight).toBeGreaterThan(-60);
    expect(town).toBeGreaterThan(-60);
    expect(hilltop).toBeLessThan(-14);
  });

  test('birds sing by day in the forest; crickets at night; no nodes are created per frame', () => {
    const day = setup(8000, 11);
    day.audio.unlock();
    let before = day.ac.nodes.length;
    run(day.audio, day.ac, scene({ weights: [0, 1, 0, 0], hour: 7 }).game, 30);
    const songs = sources(day.ac.since(before)).filter((s) => s instanceof FakeOscillator);
    expect(songs.length).toBeGreaterThan(3);
    // bird voices are recycled as they end
    for (const s of songs) if (s.stopTime < day.ac.currentTime - 0.1) expect(s.released).toBe(true);

    const night = setup(8000, 11);
    night.audio.unlock();
    before = night.ac.nodes.length;
    const s = scene({ weights: [0, 0, 1, 0], hour: 1 });
    run(night.audio, night.ac, s.game, 3);
    for (let i = 0; i < 300; i++) night.audio.update(1 / 60, s.game);
    expect(night.ac.nodes.length).toBe(before);
    // the cricket bed: stereo texture → high-pass at 2 kHz → gain
    const filter = night.ac.nodes.find(
      (n): n is FakeBiquad => n instanceof FakeBiquad && n.frequency.value === 2000 && n.inputs.some((i) => i instanceof FakeBufferSource && i.buffer?.numberOfChannels === 2),
    )!;
    const bed = filter.outputs[0] as FakeGain;
    expect(bed.gain.last('target')!.value).toBeGreaterThan(0.05);
  });

  test('lapping water near the pond, positioned at the nearest water', () => {
    const { ac, audio } = setup();
    audio.unlock();
    const pond = (x: number) => (x < 500 ? 116 : 0);
    run(audio, ac, scene({ pos: [540, 130, 600], waterY: pond, weights: [0, 0, 1, 0] }).game, 1);
    const panner = ac.nodes.find((n): n is FakePanner => n instanceof FakePanner && n.refDistance === 30)!;
    expect(panner).toBeDefined();
    const out = panner.inputs[0] as FakeGain;
    expect(out.gain.last('target')!.value).toBeGreaterThan(0.02);
    expect(panner.positionX.value).toBeLessThan(500);
    run(audio, ac, scene({ pos: [1000, 130, 600], waterY: pond, weights: [0, 0, 1, 0] }).game, 1);
    expect(out.gain.last('target')!.value).toBe(0);
  });
});

describe('sound levels (offline render)', () => {
  /** Loudest 50 ms RMS (dBFS) per sound at volume 1, before distance attenuation and the master. */
  const TARGET_DB: Record<SoundName, number> = {
    dig_dirt: -18,
    dig_sand: -20,
    dig_gravel: -18,
    dig_stone: -19.5,
    chop_wood: -17,
    leaves: -21,
    plant: -22,
    glass_break: -18.5,
    metal_hit: -17,
    fabric: -21,
    place: -20,
    step_grass: -25,
    step_dirt: -25,
    step_stone: -25,
    step_wood: -24,
    step_sand: -26,
    step_gravel: -25,
    step_metal: -24,
    land: -19,
    splash: -17,
    swim: -24,
    pickup: -24,
    drop: -24,
    craft: -23,
    eat: -21,
    door_open: -21,
    door_close: -18,
    container_open: -21,
    flashlight: -29,
    tree_fall: -12,
    impact: -14,
    swing: -22,
    hit_mob: -17,
    dog_bark: -14,
    dog_yelp: -16,
    dog_whine: -22,
    deer_alert: -15,
    paper: -23,
  };
  const SEEDS = [1, 2, 3];

  test('every sound renders finite, unclipped, at its class loudness, and distinct from the others', () => {
    const rows: { name: SoundName; loud: number; peak: number; dur: number; zcr: number; prints: Fingerprint[] }[] = [];
    const rigs = SEEDS.map((seed) => {
      const rig = setup(48000, seed);
      rig.audio.unlock();
      return rig;
    });
    for (const name of NAMES) {
      let loud = 0;
      let peak = -Infinity;
      let dur = 0;
      let zcr = 0;
      const prints: Fingerprint[] = [];
      for (const { ac, audio } of rigs) {
        ac.currentTime += 5;
        const before = ac.nodes.length;
        audio.play(name);
        const root = voiceRoot(ac, before);
        const end = Math.max(...sources(ac.since(before)).map((s) => s.stopTime));
        const x = new Renderer(ac, root).advance(end + 0.05);
        const m = measure(x, ac.sampleRate);
        expect(m.finite, name).toBe(true);
        prints.push(fingerprint(x, ac.sampleRate));
        loud += m.loudDb / rigs.length;
        peak = Math.max(peak, m.peakDb);
        dur += m.dur / rigs.length;
        zcr += m.zcr / rigs.length;
      }
      rows.push({ name, loud, peak, dur, zcr, prints });
    }
    if (REPORT) {
      console.info(
        rows
          .map((r) => `${r.name.padEnd(15)} ${r.loud.toFixed(1).padStart(6)} dB  target ${TARGET_DB[r.name]}  peak ${r.peak.toFixed(1).padStart(6)}  ${(r.dur * 1000).toFixed(0).padStart(5)} ms  zcr ${r.zcr.toFixed(0).padStart(5)}`)
          .join('\n'),
      );
    }
    for (const r of rows) {
      expect(r.peak, r.name).toBeLessThan(-1);
      expect(Math.abs(r.loud - TARGET_DB[r.name]), r.name).toBeLessThan(4);
      expect(r.dur, r.name).toBeGreaterThan(0.004);
      expect(r.dur, r.name).toBeLessThan(3);
    }
    // no two sounds alike: every pair is > 3 dB apart (third-octave spectrum + 50 ms envelope; near-duplicates measure ≈ 1.5 dB)
    const mean = (a: Fingerprint[], b: Fingerprint[]): number => {
      let sum = 0;
      for (const fa of a) for (const fb of b) sum += distance(fa, fb);
      return sum / (a.length * b.length);
    };
    const pairs: { pair: string; d: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) pairs.push({ pair: `${rows[i].name} vs ${rows[j].name}`, d: mean(rows[i].prints, rows[j].prints) });
    }
    pairs.sort((p, q) => p.d - q.d);
    if (REPORT) console.info(pairs.slice(0, 12).map((p) => `${p.pair.padEnd(34)} ${p.d.toFixed(1)} dB`).join('\n'));
    for (const p of pairs) expect(p.d, p.pair).toBeGreaterThan(3);
  });
});

describe('timings (reported; asserted only with BENCH)', () => {
  test('unlock builds the buffers once; update and play are cheap', () => {
    let t = performance.now();
    const { ac, audio } = setup(48000, 5);
    audio.unlock();
    const unlockMs = performance.now() - t;
    const { game, camera } = scene({ weights: [0, 0.6, 0.4, 0], hour: 7, waterY: (x) => (x < 880 ? 116 : 0) });
    const frames = 1200;
    t = performance.now();
    for (let i = 0; i < frames; i++) {
      ac.currentTime += 1 / 60;
      camera.position.x += 0.05;
      audio.update(1 / 60, game);
    }
    const updateUs = ((performance.now() - t) * 1000) / frames;
    const plays = 400;
    t = performance.now();
    for (let i = 0; i < plays; i++) audio.play(NAMES[i % NAMES.length], { pos: { x: camera.position.x + (i % 50), y: 136, z: 300 } });
    const playUs = ((performance.now() - t) * 1000) / plays;
    console.info(`[audio] unlock ${unlockMs.toFixed(1)} ms (48 kHz buffers), update ${updateUs.toFixed(1)} µs/frame, play ${playUs.toFixed(0)} µs/sound`);
    expect(audio.activeVoices).toBeLessThanOrEqual(MAX_VOICES);
    if (BENCH) {
      expect(unlockMs).toBeLessThan(150);
      expect(updateUs).toBeLessThan(100);
      expect(playUs).toBeLessThan(300);
    }
  });
});
