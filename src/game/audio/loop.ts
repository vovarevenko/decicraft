/**
 * A running loop (campfire crackle, lapping water): looping beds into an output gain, optionally through a
 * panner. Implements LoopHandle; stop() fades out, the owner disposes it once `endAt` has passed.
 */
import type { Vec3Like } from '../../core/math';
import type { LoopHandle } from '../audio';
import { isFinite3, MAX_DISTANCE, REF_DISTANCE, unit } from './mix';
import type { LoopRecipe } from './recipes';
import { createBed, createPanner, placePanner, type NodeSink, type Synth } from './synth';

/** Time constant (s) of volume changes and of the fade-in / fade-out. */
const FADE_S = 0.08;
/** Sources stop after this many fade time constants (≈ −50 dB). */
const STOP_AFTER = 6;
/** Time constant (s) of position glides. */
const MOVE_S = 0.05;

export class Loop implements LoopHandle, NodeSink {
  /** Audio time after which a stopped loop may be disposed (Infinity while it plays). */
  endAt = Infinity;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly out: GainNode;
  private panner: PannerNode | null = null;
  private stopped = false;

  /** Starts `recipe` into `dest` at `volume` (0..1), positional when `pos` is given; `rate` scales playback. */
  constructor(
    private readonly sx: Synth,
    private readonly recipe: LoopRecipe,
    private readonly dest: AudioNode,
    volume: number,
    pos?: Vec3Like,
    rate = 1,
  ) {
    const { ac } = sx;
    this.out = ac.createGain();
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(unit(volume), ac.currentTime, FADE_S);
    this.nodes.push(this.out);
    for (let i = 0; i < recipe.layers.length; i++) createBed(sx, recipe.layers[i], this.out, this, rate);
    if (pos !== undefined && isFinite3(pos)) this.attachPanner(pos);
    else this.out.connect(dest);
  }

  node(n: AudioNode): void {
    this.nodes.push(n);
  }

  source(s: AudioScheduledSourceNode): void {
    this.sources.push(s);
  }

  setVolume(v: number): void {
    if (this.stopped) return;
    this.out.gain.setTargetAtTime(unit(v), this.sx.ac.currentTime, FADE_S);
  }

  /** Moves the source (a loop started without a position becomes positional). */
  setPosition(pos: Vec3Like, glideS = MOVE_S): void {
    if (this.stopped || !isFinite3(pos)) return;
    if (this.panner === null) {
      this.out.disconnect();
      this.attachPanner(pos);
      return;
    }
    placePanner(this.panner, pos.x, pos.y, pos.z, this.sx.ac.currentTime, glideS);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.sx.ac.currentTime;
    this.out.gain.setTargetAtTime(0, now, FADE_S);
    this.endAt = now + FADE_S * STOP_AFTER;
    for (let i = 0; i < this.sources.length; i++) this.sources[i].stop(this.endAt);
  }

  /** Disconnects every node (the owner calls this once `endAt` has passed). */
  dispose(): void {
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
  }

  private attachPanner(pos: Vec3Like): void {
    const { ac } = this.sx;
    const p = createPanner(ac, this.recipe.ref ?? REF_DISTANCE, this.recipe.maxDist ?? MAX_DISTANCE);
    placePanner(p, pos.x, pos.y, pos.z, ac.currentTime);
    this.out.connect(p);
    p.connect(this.dest);
    this.nodes.push(p);
    this.panner = p;
  }
}
