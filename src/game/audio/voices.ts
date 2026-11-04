/**
 * Bookkeeping of playing one-shots: a capped pool that steals the weakest voice when full and
 * disconnects every node of a voice once its last source has stopped.
 */
import type { NodeSink } from './synth';

/** A stolen voice fades out over this long (s) before its sources stop. */
const RELEASE_S = 0.05;

/** One playing sound: its nodes, its output gain (faded when stolen) and its lifetime in audio time. */
export class Voice implements NodeSink {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  /** Output gain of the voice (fades out when the voice is stolen). */
  out: GainNode | null = null;
  busy = false;
  /** Stolen: fading out, no longer counted as playing. */
  releasing = false;
  start = 0;
  end = 0;
  /** Volume × distance gain when it started (stealing priority). */
  loudness = 0;

  node(n: AudioNode): void {
    this.nodes.push(n);
  }

  source(s: AudioScheduledSourceNode): void {
    this.sources.push(s);
  }

  /** Loudness weighted by the share of the sound still to come. */
  weight(now: number): number {
    const span = this.end - this.start;
    const left = span > 0 ? (this.end - now) / span : 0;
    return this.loudness * (left > 0 ? (left < 1 ? left : 1) : 0);
  }

  /** Fades the voice out quickly and stops its sources (stolen). */
  release(now: number): void {
    this.releasing = true;
    const end = now + RELEASE_S;
    if (end >= this.end) return;
    this.out?.gain.setTargetAtTime(0, now, RELEASE_S / 5);
    for (let i = 0; i < this.sources.length; i++) {
      try {
        this.sources[i].stop(end);
      } catch {
        // Very old WebKit throws on a second stop(); the source then simply ends as scheduled.
      }
    }
    this.end = end;
  }

  /** Disconnects every node and frees the slot. */
  finish(): void {
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
    this.out = null;
    this.busy = false;
    this.releasing = false;
  }
}

/** At most `cap` voices play at once; stolen voices fade out in extra slots (2 × cap in all). */
export class VoicePool {
  private readonly slots: Voice[];

  constructor(readonly cap: number) {
    this.slots = Array.from({ length: cap * 2 }, () => new Voice());
  }

  /** Voices currently playing (stolen ones excluded). */
  get playing(): number {
    let n = 0;
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].busy && !this.slots[i].releasing) n++;
    return n;
  }

  /** Frees the voices whose sources have all stopped. */
  sweep(now: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      const v = this.slots[i];
      if (v.busy && now >= v.end) v.finish();
    }
  }

  /**
   * A free voice for a new sound of the given loudness (stealing the weakest playing one when all `cap`
   * are busy), or null when everything playing is louder. The caller sets `out` and `end`.
   */
  acquire(now: number, loudness: number): Voice | null {
    this.sweep(now);
    let playing = 0;
    let free: Voice | null = null;
    let weakest: Voice | null = null;
    let weakestWeight = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const v = this.slots[i];
      if (!v.busy) {
        free ??= v;
        continue;
      }
      if (v.releasing) continue;
      playing++;
      const w = v.weight(now);
      if (w < weakestWeight) {
        weakestWeight = w;
        weakest = v;
      }
    }
    if (playing >= this.cap) {
      if (weakest === null || weakestWeight > loudness) return null;
      weakest.release(now);
    }
    if (free === null) free = this.earliestReleasing();
    free.busy = true;
    free.releasing = false;
    free.start = now;
    free.end = now;
    free.loudness = loudness;
    return free;
  }

  /** With every slot taken, at least `cap` voices are fading out: cut the one that ends first. */
  private earliestReleasing(): Voice {
    let best = this.slots[0];
    for (let i = 1; i < this.slots.length; i++) {
      const v = this.slots[i];
      if (v.releasing && (!best.releasing || v.end < best.end)) best = v;
    }
    best.finish();
    return best;
  }
}
