/**
 * Ambience: wind (always outdoors, stronger on the hills and up high, calmer in the town), leaves in the
 * wind, birds by day, crickets at night and lapping water near the pond — crossfaded by the biome blend
 * under the listener, the time of day, the height and how enclosed the listener is (roofs muffle the
 * outdoors). Runs a few times per second; between updates the gains glide.
 */
import { BASE_GROUND_Y } from '../../config';
import { TAU, lerp } from '../../core/math';
import type { ColumnSample } from '../../gen/types';
import type { GameContext } from '../context';
import { Loop } from './loop';
import { ambienceMix, createAmbienceMix, gustAt, shoreGain } from './mix';
import { AMBIENCE_LEVELS, BEDS, BIRDS, LOOPS, type BirdSong } from './recipes';
import { createBed, createPanner, placePanner, scheduleSong, type Bed, type NodeSink, type Synth } from './synth';
import { VoicePool } from './voices';

/** The ambience updates this often (s); gains glide in between. */
const TICK_S = 0.1;
/** The biome blend and the enclosure are re-sampled this often (s)… */
const SENSE_S = 0.25;
/** …the nearest water this often (s). */
const WATER_S = 0.5;
/** Glide time constants (s): crossfades (biome, time of day, roofs) and gusts. */
const CROSSFADE_S = 1.2;
const GUST_S = 0.35;
/** Ambience level while the listener's head is under water. */
const UNDERWATER_DUCK = 0.25;
/** Cut-off (Hz) of the outdoors heard from under a roof all around. */
const MUFFLED_HZ = 900;
/** Columns (dx, dz pairs, voxels) probed for a roof above the listener. */
const ROOF_PROBES = [0, 0, 12, 0, -12, 0, 0, 12, 0, -12, 9, 9, -9, 9, 9, -9, -9, -9];
/** Radii (world units) of the rings of columns searched for water, WATER_DIRS directions each. */
const WATER_RINGS = [40, 90, 150];
const WATER_DIRS = 8;
/** Water this far above or below the listener (world units) does not count. */
const WATER_MAX_DY = 80;
/** Time constant (s) of the lapping water moving to a newly found nearest shore point. */
const SHORE_MOVE_S = 0.4;
/** Birds: at most this many songs at once, sung this far away (world units), panner refDistance. */
const BIRD_VOICES = 3;
const BIRD_NEAR = 60;
const BIRD_FAR = 260;
const BIRD_REF = 50;
const BIRD_MAX_DIST = 1000;
/** Mean pause between songs (s) at the lowest and at the highest bird activity. */
const BIRD_SPARSE_S = 16;
const BIRD_BUSY_S = 2.5;
/** Below this activity no bird sings; the next check follows after BIRD_IDLE_S. */
const MIN_BIRDS = 0.03;
const BIRD_IDLE_S = 2;
/** Delay (s) between scheduling a song and its first note. */
const SONG_LEAD_S = 0.05;

/** The beds live as long as the AudioContext, so their nodes are never collected for disconnection. */
const permanent: NodeSink = { node() {}, source() {} };

export class Ambience {
  private readonly bus: GainNode;
  private readonly muffler: BiquadFilterNode;
  private readonly wind: Bed;
  private readonly whistle: Bed;
  private readonly foliage: Bed;
  private readonly crickets: Bed;
  private readonly shore: Loop;
  private readonly birds = new VoicePool(BIRD_VOICES);
  private readonly column: ColumnSample = { biome: 0, weights: [1, 0, 0, 0], surfaceY: 0, waterY: 0, topBlock: 0 };
  private readonly weights: [number, number, number, number] = [1, 0, 0, 0];
  private readonly mix = createAmbienceMix();
  private readonly shorePos = { x: 0, y: 0, z: 0 };
  /** Starts full so the first update runs at once. */
  private clock = TICK_S;
  private senseIn = 0;
  private waterIn = 0;
  private birdIn = BIRD_IDLE_S;
  private enclosure = 0;
  private shoreLevel = 0;

  /** Starts every bed silent; update() fades them in. */
  constructor(
    private readonly sx: Synth,
    out: AudioNode,
  ) {
    const { ac } = sx;
    this.bus = ac.createGain();
    this.muffler = ac.createBiquadFilter();
    this.muffler.type = 'lowpass';
    this.muffler.frequency.value = sx.maxHz;
    this.bus.connect(this.muffler);
    this.muffler.connect(out);
    this.wind = createBed(sx, BEDS.wind, this.bus, permanent);
    this.whistle = createBed(sx, BEDS.whistle, this.bus, permanent);
    this.foliage = createBed(sx, BEDS.foliage, this.bus, permanent);
    this.crickets = createBed(sx, BEDS.crickets, this.bus, permanent);
    this.shore = new Loop(sx, LOOPS.water, this.bus, 0);
  }

  /** Called every frame with the listener position (world units). */
  update(dt: number, ctx: GameContext, x: number, y: number, z: number, underwater: boolean): void {
    this.clock += dt;
    if (this.clock < TICK_S) return;
    const step = this.clock;
    this.clock = 0;
    const now = this.sx.ac.currentTime;
    if ((this.senseIn -= step) <= 0) {
      this.senseIn = SENSE_S;
      this.sense(ctx, x, y, z);
    }
    if ((this.waterIn -= step) <= 0) {
      this.waterIn = WATER_S;
      this.senseWater(ctx, x, y, z);
    }
    const mix = ambienceMix(this.weights, ctx.time.timeOfDay, y - BASE_GROUND_Y, this.enclosure, this.mix);
    const gust = gustAt(now);
    const duck = underwater ? UNDERWATER_DUCK : 1;
    const lv = AMBIENCE_LEVELS;
    this.wind.gain.gain.setTargetAtTime(mix.wind * (0.55 + 0.45 * gust) * lv.wind * duck, now, GUST_S);
    this.wind.filter.frequency.setTargetAtTime(220 + 600 * gust * (0.5 + 0.5 * mix.wind), now, GUST_S);
    this.whistle.gain.gain.setTargetAtTime(mix.whistle * gust * gust * lv.whistle * duck, now, GUST_S);
    this.whistle.filter.frequency.setTargetAtTime(600 + 900 * gust, now, GUST_S);
    this.foliage.gain.gain.setTargetAtTime(mix.foliage * (0.25 + 0.75 * gust) * lv.foliage * duck, now, GUST_S);
    this.crickets.gain.gain.setTargetAtTime(mix.crickets * lv.crickets * duck, now, CROSSFADE_S);
    this.muffler.frequency.setTargetAtTime(this.sx.maxHz * Math.pow(MUFFLED_HZ / this.sx.maxHz, mix.muffle), now, CROSSFADE_S);
    this.shore.setVolume(this.shoreLevel * (1 - 0.6 * mix.muffle) * lv.shore * duck);
    this.birds.sweep(now);
    if ((this.birdIn -= step) <= 0) this.sing(now, x, y, z, underwater ? 0 : mix.birds);
  }

  /** Biome blend under the listener and the share of nearby columns roofed above the head. */
  private sense(ctx: GameContext, x: number, y: number, z: number): void {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const w = ctx.terrain.sample(xi, zi, this.column).weights;
    for (let i = 0; i < 4; i++) this.weights[i] = w[i];
    let covered = 0;
    for (let i = 0; i < ROOF_PROBES.length; i += 2) {
      if (ctx.world.skyHeight(xi + ROOF_PROBES[i], zi + ROOF_PROBES[i + 1]) > y + 1) covered++;
    }
    this.enclosure = covered / (ROOF_PROBES.length / 2);
  }

  /** Finds the nearest water column (the listener's own, then rings outwards) and moves the lapping there. */
  private senseWater(ctx: GameContext, x: number, y: number, z: number): void {
    let best = this.waterDistance(ctx, x, z, y, 0);
    let bx = x;
    let by = this.column.waterY;
    let bz = z;
    for (let r = 0; r < WATER_RINGS.length && best === Infinity; r++) {
      const radius = WATER_RINGS[r];
      for (let k = 0; k < WATER_DIRS; k++) {
        const a = (k / WATER_DIRS) * TAU;
        const cx = x + Math.cos(a) * radius;
        const cz = z + Math.sin(a) * radius;
        const d = this.waterDistance(ctx, cx, cz, y, radius);
        if (d >= best) continue;
        best = d;
        bx = cx;
        by = this.column.waterY;
        bz = cz;
      }
    }
    this.shoreLevel = shoreGain(best);
    if (best === Infinity) return;
    const p = this.shorePos;
    p.x = bx;
    p.y = by;
    p.z = bz;
    this.shore.setPosition(p, SHORE_MOVE_S);
  }

  /** Distance from the listener to the water surface of column (x, z) `radius` away; Infinity if dry or far above/below. */
  private waterDistance(ctx: GameContext, x: number, z: number, y: number, radius: number): number {
    const waterY = ctx.terrain.sample(Math.floor(x), Math.floor(z), this.column).waterY;
    const dy = y - waterY;
    return waterY > 0 && Math.abs(dy) <= WATER_MAX_DY ? Math.sqrt(radius * radius + dy * dy) : Infinity;
  }

  /** Starts one bird song somewhere around the listener and draws the pause until the next one. */
  private sing(now: number, x: number, y: number, z: number, activity: number): void {
    const { ac, random } = this.sx;
    if (activity < MIN_BIRDS) {
      this.birdIn = BIRD_IDLE_S;
      return;
    }
    const mean = lerp(BIRD_SPARSE_S, BIRD_BUSY_S, activity);
    this.birdIn = Math.min(3 * mean, -Math.log(1 - random()) * mean);
    const song = pickSong(this.weights, random());
    const level = activity * AMBIENCE_LEVELS.birds;
    const voice = this.birds.acquire(now, level);
    if (voice === null) return;
    const out = ac.createGain();
    const panner = createPanner(ac, BIRD_REF, BIRD_MAX_DIST);
    const a = random() * TAU;
    const r = lerp(BIRD_NEAR, BIRD_FAR, random());
    placePanner(panner, x + Math.cos(a) * r, y + lerp(song.height[0], song.height[1], random()), z + Math.sin(a) * r, now);
    out.connect(panner);
    panner.connect(this.bus);
    voice.node(out);
    voice.node(panner);
    voice.out = out;
    voice.end = scheduleSong(this.sx, song, now + SONG_LEAD_S, level, out, voice);
  }
}

/** How well a species fits the biome blend [town, forest, meadow, hills]. */
function fit(song: BirdSong, w: ArrayLike<number>): number {
  const h = song.habitat;
  return h[0] * w[0] + h[1] * w[1] + h[2] * w[2] + h[3] * w[3];
}

/** A species drawn in proportion to its fit (`r` uniform in [0, 1)). */
export function pickSong(weights: ArrayLike<number>, r: number): BirdSong {
  let total = 0;
  for (let i = 0; i < BIRDS.length; i++) total += fit(BIRDS[i], weights);
  let left = r * total;
  for (let i = 0; i < BIRDS.length; i++) {
    left -= fit(BIRDS[i], weights);
    if (left < 0) return BIRDS[i];
  }
  return BIRDS[BIRDS.length - 1];
}
