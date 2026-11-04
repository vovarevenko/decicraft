/**
 * Procedurally synthesised sound effects & ambience (WebAudio; no audio files). OWNER: agent "player".
 * Before unlock() every method is a silent no-op and startLoop() returns an inert handle — callers
 * never need to check whether audio is available.
 *
 * Graph: one-shots and loops → sfx bus ─┐
 *        ambience (wind, leaves, birds, crickets, pond) → roof muffler ─┴→ master (pause fade) →
 *        underwater low-pass → limiter → speakers.
 * Every SoundName is a small recipe (audio/recipes.ts) of noise bursts and oscillators shaped by filters
 * and envelopes (audio/synth.ts), with a slight random pitch. Positional sounds use an 'equalpower'
 * PannerNode with the 'inverse' distance model (refDistance 2 m unless the recipe carries farther) and
 * are skipped beyond their range (60 m by default). At most MAX_VOICES one-shots play at once: a new
 * sound steals the weakest (quietest × least remaining) voice or is dropped when everything is louder.
 * Finished voices are disconnected in update() and play(), stopped loops in update().
 */
import * as THREE from 'three';
import type { Vec3Like } from '../core/math';
import { Ambience } from './audio/ambience';
import { Loop } from './audio/loop';
import { distanceGain, isFinite3, MAX_DISTANCE, pitchJitter, REF_DISTANCE, unit } from './audio/mix';
import { LOOPS, SOUNDS } from './audio/recipes';
import { createPanner, createSynth, DEFAULT_JITTER, placePanner, scheduleSound, type Synth } from './audio/synth';
import { VoicePool } from './audio/voices';
import type { GameContext } from './context';

export type SoundName =
  | 'dig_dirt'
  | 'dig_sand'
  | 'dig_gravel'
  | 'dig_stone'
  | 'chop_wood'
  | 'leaves'
  | 'plant'
  | 'glass_break'
  | 'metal_hit'
  | 'fabric'
  | 'place'
  | 'step_grass'
  | 'step_dirt'
  | 'step_stone'
  | 'step_wood'
  | 'step_sand'
  | 'step_gravel'
  | 'step_metal'
  | 'land'
  | 'splash'
  | 'swim'
  | 'pickup'
  | 'drop'
  | 'craft'
  | 'eat'
  | 'door_open'
  | 'door_close'
  | 'container_open'
  | 'flashlight'
  | 'tree_fall'
  | 'impact'
  | 'swing'
  | 'hit_mob'
  | 'dog_bark'
  | 'dog_yelp'
  | 'dog_whine'
  | 'deer_alert'
  | 'paper';

export type LoopName = 'fire' | 'water';

export interface LoopHandle {
  setVolume(v: number): void;
  setPosition(pos: Vec3Like): void;
  stop(): void;
}

export interface PlayOptions {
  /** World position for distance attenuation/panning; omitted = non-positional. */
  pos?: Vec3Like;
  /** 0..1 (default 1). */
  volume?: number;
  /** Playback-rate/pitch multiplier (default 1, randomised ±5%). */
  pitch?: number;
}

/** Construction options (tests inject a fake context and a seeded random source). */
export interface AudioOptions {
  /** Creates the AudioContext inside unlock(); null = no audio (default: a new AudioContext if the browser has one). */
  createContext?: () => AudioContext | null;
  /** Random source in [0, 1) for pitch, grains and ambience (default Math.random). */
  random?: () => number;
}

/** Concurrent one-shots. */
export const MAX_VOICES = 24;
/** Master gain while playing. */
const MASTER_LEVEL = 0.9;
/** Time constant (s) of the pause fade. */
const PAUSE_FADE_S = 0.05;
/** One-shots quieter than this (volume × distance gain) are not worth a voice. */
const MIN_LOUDNESS = 0.003;
/** Master low-pass cut-off (Hz) while the head is under water, and its glide (s). */
const UNDERWATER_HZ = 650;
const UNDERWATER_GLIDE_S = 0.08;
/** The listener is only re-set when it moved or turned more than this. */
const LISTENER_EPSILON = 1e-3;

const INERT_LOOP: LoopHandle = Object.freeze({ setVolume() {}, setPosition() {}, stop() {} });

function defaultContext(): AudioContext | null {
  const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
}

/** Resumes a context the browser started suspended (a rejection just leaves audio silent). */
function resume(ac: AudioContext): void {
  if (ac.state === 'suspended') ac.resume().catch(() => undefined);
}

/** The live graph, built by unlock(). */
interface Graph {
  readonly sx: Synth;
  readonly master: GainNode;
  readonly sfx: GainNode;
  readonly underwater: BiquadFilterNode;
  readonly ambience: Ambience;
}

const forward = new THREE.Vector3();
const up = new THREE.Vector3();

export class GameAudio {
  private readonly createContext: () => AudioContext | null;
  private readonly random: () => number;
  private graph: Graph | null = null;
  private paused = false;
  private underwater = false;
  private readonly voices = new VoicePool(MAX_VOICES);
  private readonly loops: Loop[] = [];
  /** Listener pose (camera) as last set; distances are measured from here. */
  private readonly ear = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
  private earKnown = false;

  constructor(options: AudioOptions = {}) {
    this.createContext = options.createContext ?? defaultContext;
    this.random = options.random ?? Math.random;
  }

  /** The AudioContext exists (unlock() succeeded). */
  get unlocked(): boolean {
    return this.graph !== null;
  }

  /** One-shots currently playing (debug). */
  get activeVoices(): number {
    return this.voices.playing;
  }

  /** Must be called from a user gesture (the start click) before any sound can play. */
  unlock(): void {
    if (this.graph !== null) {
      resume(this.graph.sx.ac);
      return;
    }
    let ac: AudioContext | null;
    try {
      ac = this.createContext();
    } catch {
      ac = null;
    }
    if (ac === null) return;
    const sx = createSynth(ac, this.random);
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ac.destination);
    const underwater = ac.createBiquadFilter();
    underwater.type = 'lowpass';
    underwater.frequency.value = sx.maxHz;
    underwater.connect(limiter);
    const master = ac.createGain();
    master.gain.value = this.paused ? 0 : MASTER_LEVEL;
    master.connect(underwater);
    const sfx = ac.createGain();
    sfx.connect(master);
    this.graph = { sx, master, sfx, underwater, ambience: new Ambience(sx, master) };
    resume(ac);
  }

  play(name: SoundName, opts?: PlayOptions): void {
    const g = this.graph;
    if (g === null) return;
    const recipe = SOUNDS[name];
    const volume = unit(opts?.volume ?? 1);
    const pos = opts?.pos;
    if (volume === 0 || (pos !== undefined && !isFinite3(pos))) return;
    let loudness = volume;
    if (pos !== undefined && this.earKnown) {
      const e = this.ear;
      const d = Math.hypot(pos.x - e.x, pos.y - e.y, pos.z - e.z);
      if (d > (recipe.maxDist ?? MAX_DISTANCE)) return;
      loudness *= distanceGain(d, recipe.ref ?? REF_DISTANCE);
    }
    if (loudness < MIN_LOUDNESS) return;
    const { sx, sfx } = g;
    const now = sx.ac.currentTime;
    const voice = this.voices.acquire(now, loudness);
    if (voice === null) return;
    const out = sx.ac.createGain();
    out.gain.value = volume;
    voice.node(out);
    voice.out = out;
    if (pos === undefined) {
      out.connect(sfx);
    } else {
      const panner = createPanner(sx.ac, recipe.ref ?? REF_DISTANCE, recipe.maxDist ?? MAX_DISTANCE);
      placePanner(panner, pos.x, pos.y, pos.z, now);
      out.connect(panner);
      panner.connect(sfx);
      voice.node(panner);
    }
    const base = opts?.pitch !== undefined && opts.pitch > 0 ? opts.pitch : 1;
    const pitch = pitchJitter(base, recipe.jitter ?? DEFAULT_JITTER, this.random());
    voice.end = scheduleSound(sx, recipe, now, pitch, out, voice);
  }

  startLoop(name: LoopName, opts?: PlayOptions): LoopHandle {
    const g = this.graph;
    if (g === null) return INERT_LOOP;
    const base = opts?.pitch !== undefined && opts.pitch > 0 ? opts.pitch : 1;
    const rate = pitchJitter(base, DEFAULT_JITTER, this.random());
    const loop = new Loop(g.sx, LOOPS[name], g.sfx, opts?.volume ?? 1, opts?.pos, rate);
    this.loops.push(loop);
    return loop;
  }

  /** Listener from the camera; ambience by biome under the player & time of day (wind, birds, crickets). */
  update(dt: number, ctx: GameContext): void {
    const g = this.graph;
    if (g === null) return;
    const now = g.sx.ac.currentTime;
    this.setListener(g.sx.ac.listener, ctx.camera);
    this.voices.sweep(now);
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const loop = this.loops[i];
      if (now < loop.endAt) continue;
      loop.dispose();
      this.loops[i] = this.loops[this.loops.length - 1];
      this.loops.pop();
    }
    const underwater = ctx.player.eyeInWater;
    if (underwater !== this.underwater) {
      this.underwater = underwater;
      g.underwater.frequency.setTargetAtTime(underwater ? UNDERWATER_HZ : g.sx.maxHz, now, UNDERWATER_GLIDE_S);
    }
    const e = this.ear;
    g.ambience.update(dt, ctx, e.x, e.y, e.z, underwater);
  }

  /** Master mute while paused. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const g = this.graph;
    if (g === null) return;
    g.master.gain.setTargetAtTime(paused ? 0 : MASTER_LEVEL, g.sx.ac.currentTime, PAUSE_FADE_S);
  }

  /** Copies the camera pose to the AudioListener when it changed. */
  private setListener(l: AudioListener, camera: THREE.PerspectiveCamera): void {
    const p = camera.position;
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    if (!isFinite3(p) || !isFinite3(forward) || !isFinite3(up)) return;
    const e = this.ear;
    const moved =
      !this.earKnown ||
      Math.abs(p.x - e.x) + Math.abs(p.y - e.y) + Math.abs(p.z - e.z) > LISTENER_EPSILON ||
      Math.abs(forward.x - e.fx) + Math.abs(forward.y - e.fy) + Math.abs(forward.z - e.fz) > LISTENER_EPSILON ||
      Math.abs(up.x - e.ux) + Math.abs(up.y - e.uy) + Math.abs(up.z - e.uz) > LISTENER_EPSILON;
    if (!moved) return;
    e.x = p.x;
    e.y = p.y;
    e.z = p.z;
    e.fx = forward.x;
    e.fy = forward.y;
    e.fz = forward.z;
    e.ux = up.x;
    e.uy = up.y;
    e.uz = up.z;
    this.earKnown = true;
    if (l.positionX) {
      l.positionX.value = e.x;
      l.positionY.value = e.y;
      l.positionZ.value = e.z;
      l.forwardX.value = e.fx;
      l.forwardY.value = e.fy;
      l.forwardZ.value = e.fz;
      l.upX.value = e.ux;
      l.upY.value = e.uy;
      l.upZ.value = e.uz;
    } else {
      l.setPosition(e.x, e.y, e.z);
      l.setOrientation(e.fx, e.fy, e.fz, e.ux, e.uy, e.uz);
    }
  }
}
