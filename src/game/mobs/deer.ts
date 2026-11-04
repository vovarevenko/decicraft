/**
 * Roe deer (косуля): forest & meadow, herds of 2–3. OWNER: agent "entities".
 * Wanders and grazes (head down) inside natural biomes. Notices the player within 15 m walking,
 * 25 m sprinting, 5 m crouching → alert (head up, ears, 'deer_alert'); a crouching player who stands
 * still ~3 s lets it relax. Flees when the player comes within 8 m (2.5 m crouching), when hit or on a
 * loud sound nearby: runs ~9 m/s with bounding hops for 25–35 m, calms down within 8–12 s, then grazes
 * again while the herd regroups. A hit staggers it for 0.4 s before it runs. health = maxHealth = 9
 * (every tool deals ≥ 3, bare hands 1) → drops meat_raw ×2 and hide ×1 on death.
 *
 * The state machine lives in deerBrain.ts; this class feeds it senses and turns its states into
 * movement. A DeerHerd shares a wander target (never in the town, never in water) and passes alarms:
 * one deer's alert or flight spreads to its herd mates. A herd keeps to its home range: within 30 m of
 * where it spawned and in that spot's biome; a flight that carried it out is walked back in 8–25 m legs.
 */
import * as THREE from 'three';
import { BIOME_TOWN, TOWN_RECT, WORLD_X, WORLD_Z } from '../../config';
import { clamp, damp, TAU, type Vec3Like } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { ColumnSample, LootEntry } from '../../gen/types';
import type { GameContext } from '../context';
import { createDeerBrain, DEER, stepDeerBrain, type DeerAlarm, type DeerSenses } from './deerBrain';
import { Mob } from './mob';

const WALK_SPEED = 12;
const TROT_SPEED = 28;
/** Vertical speed of a bounding hop while fleeing (≈ 35 cm high, ≈ 5 m long at full speed). */
const HOP_SPEED = 26;
/** A hop needs this much clear ground ahead: its length plus the braking distance at full speed (9 m). */
const HOP_CLEARANCE = 90;
/** Herd mates farther apart than this (40 m) ignore each other's alarms. */
const HERD_RANGE = 400;
/** One alarm call per herd within this many seconds. */
const CALL_COOLDOWN_S = 3;
/** Wander targets: 8–25 m from the herd centre, at least 6 m inside the map. */
const TARGET_MIN_DIST = 80;
const TARGET_MAX_DIST = 250;
const TARGET_EDGE_MARGIN = 60;
const TARGET_TRIES = 16;
/** Home range: targets stay within 30 m of the herd's spawn, in the spawn's biome. */
const HOME_RADIUS = 300;
/** Outside its home range a herd heads back: targets within ±60° of the way home. */
const HOME_CONE = Math.PI / 3;
/** The town biome never reaches farther than this (20 m) beyond the town quadrant (warped, blended border). */
const TOWN_LOOKUP_MARGIN = 200;
const LOOT: readonly LootEntry[] = [
  { item: 'meat_raw', count: 2 },
  { item: 'hide', count: 1 },
];

const senses: DeerSenses = {
  dist: 0,
  crouching: false,
  sprinting: false,
  moving: false,
  hit: false,
  noise: false,
  herd: 'none',
  moved: 0,
};
const column: ColumnSample = { biome: 0, weights: [0, 0, 0, 0], surfaceY: 0, waterY: 0, topBlock: 0 };
const centre = { x: 0, z: 0 };
const tmp = new THREE.Vector3();

/** Deer that graze and flee together: a shared wander target inside natural biomes and alarm passing. */
export class DeerHerd {
  readonly members: Deer[] = [];
  targetX = 0;
  targetZ = 0;
  hasTarget = false;
  /** Bumped whenever the target moves, so members walk to their new spots. */
  version = 0;
  /** Game time when the herd may wander to a new target. */
  nextMoveAt = 0;
  /** Game time of the last alarm call. */
  lastCallAt = -Infinity;
  /** Home range centre (where the first member spawned) and its biome (looked up on the first pick, -1 until then). */
  homeX = 0;
  homeZ = 0;
  homeBiome = -1;

  /** Adds a member; the first one's spawn point becomes the herd's home. */
  join(deer: Deer): void {
    if (this.members.length === 0) {
      this.homeX = deer.position.x;
      this.homeZ = deer.position.z;
    }
    this.members.push(deer);
  }

  /** Horizontal distance from (x, z) to the herd's home. */
  homeDistance(x: number, z: number): number {
    return Math.hypot(x - this.homeX, z - this.homeZ);
  }

  /** Mean xz position of the living members other than `except` into `out`; false if there are none. */
  centre(out: { x: number; z: number }, except?: Deer): boolean {
    let n = 0;
    let x = 0;
    let z = 0;
    for (const m of this.members) {
      if (m === except || m.dead) continue;
      x += m.position.x;
      z += m.position.z;
      n++;
    }
    if (n === 0) return false;
    out.x = x / n;
    out.z = z / n;
    return true;
  }

  /** Every living member is idle (grazing or wandering). */
  get calm(): boolean {
    for (const m of this.members) if (!m.dead && m.brain.state !== 'idle') return false;
    return true;
  }

  setTarget(x: number, z: number): void {
    this.targetX = x;
    this.targetZ = z;
    this.hasTarget = true;
    this.version++;
  }

  /**
   * Moves the target 8–25 m from the herd centre to a dry spot in a natural biome inside the home range;
   * a herd outside its range heads back home (any natural biome on the way). Keeps the target if no candidate fits.
   */
  pickTarget(ctx: GameContext, rng: Rng): void {
    if (!this.centre(centre)) return;
    if (this.homeBiome < 0) this.homeBiome = ctx.terrain.biomeAt(Math.floor(this.homeX), Math.floor(this.homeZ));
    const away = this.homeDistance(centre.x, centre.z);
    const back = away > HOME_RADIUS;
    const homeYaw = Math.atan2(this.homeX - centre.x, this.homeZ - centre.z);
    for (let i = 0; i < TARGET_TRIES; i++) {
      const a = back ? homeYaw + rng.range(-HOME_CONE, HOME_CONE) : rng.range(0, TAU);
      const r = rng.range(TARGET_MIN_DIST, TARGET_MAX_DIST);
      const x = centre.x + Math.sin(a) * r;
      const z = centre.z + Math.cos(a) * r;
      if (x < TARGET_EDGE_MARGIN || z < TARGET_EDGE_MARGIN) continue;
      if (x > WORLD_X - TARGET_EDGE_MARGIN || z > WORLD_Z - TARGET_EDGE_MARGIN) continue;
      const fromHome = this.homeDistance(x, z);
      if (!back && fromHome > HOME_RADIUS) continue;
      const xi = Math.floor(x);
      const zi = Math.floor(z);
      const biome = ctx.terrain.biomeAt(xi, zi);
      if (biome === BIOME_TOWN || (!back && biome !== this.homeBiome)) continue;
      if (ctx.terrain.sample(xi, zi, column).waterY !== 0) continue;
      this.setTarget(x, z);
      return;
    }
  }

  /** Passes `from`'s alarm to the other living members within HERD_RANGE (they react on their next step). */
  raise(from: Deer, alarm: 'alert' | 'flee', threatX: number, threatZ: number): void {
    for (const m of this.members) {
      if (m === from || m.dead) continue;
      if (m.position.distanceTo(from.position) <= HERD_RANGE) m.hearAlarm(alarm, threatX, threatZ);
    }
  }

  remove(deer: Deer): void {
    const i = this.members.indexOf(deer);
    if (i >= 0) this.members.splice(i, 1);
  }
}

export class Deer extends Mob {
  readonly type = 'mob';
  readonly kind = 'deer' as const;
  readonly herd: DeerHerd;
  /** Behaviour state machine (deerBrain.ts). */
  readonly brain = createDeerBrain();

  /** This deer's spot relative to the herd target (herd mates graze 1–3 m apart). */
  private readonly slotX: number;
  private readonly slotZ: number;
  private grazing = true;
  private idleTimer = 0;
  private walkX = 0;
  private walkZ = 0;
  private walkTime = 0;
  private herdVersion = -1;
  private hitPending = false;
  private noisePending = false;
  private alarmPending: DeerAlarm = 'none';
  /** The pending noise / herd alarm came with its own threat point (threatX/Z). */
  private pointThreat = false;
  private threatX = 0;
  private threatZ = 0;
  /** The current flight runs from the player (re-aimed as the player moves), not from a fixed point. */
  private threatIsPlayer = true;
  private fleeX = 0;
  private fleeZ = 1;
  private fleeRetarget = 0;
  private hopTimer = 0;
  // pose state (smoothed 0 … 1)
  private headDown = 0;
  private wary = 0;
  private bound = 0;
  private air = 0;
  private twitch = 0;
  private twitchSide = 1;
  private twitchTimer = 2;
  private readonly bodyY: number;
  private readonly neck: THREE.Group | null;
  private readonly head: THREE.Group | null;
  private readonly earL: THREE.Group | null;
  private readonly earR: THREE.Group | null;
  private readonly tail: THREE.Group | null;
  private readonly random = (): number => this.rng.next();

  constructor(x: number, y: number, z: number, seed: number, herd?: DeerHerd) {
    super();
    this.init(x, y, z, seed);
    this.health = DEER.health;
    this.maxHealth = DEER.health;
    this.displayName = 'Косуля';
    this.loot = LOOT;
    this.turnRate = 5;
    this.accel = 160;
    this.stride = 9;
    this.gaitFullSpeed = 30;
    this.herd = herd ?? new DeerHerd();
    this.herd.join(this);
    const a = this.rng.range(0, TAU);
    const r = this.rng.range(10, 30);
    this.slotX = Math.sin(a) * r;
    this.slotZ = Math.cos(a) * r;
    this.idleTimer = this.rng.range(1, 6);
    this.neck = this.part('neck');
    this.head = this.part('head');
    this.earL = this.part('earL');
    this.earR = this.part('earR');
    this.tail = this.part('tail');
    this.bodyY = this.part('body') ? this.restPivot('body', tmp).y : this.height * 0.5;
  }

  /** A herd mate's alarm (DeerHerd.raise). */
  hearAlarm(alarm: 'alert' | 'flee', threatX: number, threatZ: number): void {
    if (this.dead) return;
    if (alarm === 'flee') {
      this.alarmPending = 'flee';
      this.pointThreat = true;
      this.threatX = threatX;
      this.threatZ = threatZ;
    } else if (this.alarmPending === 'none') {
      this.alarmPending = 'alert';
    }
  }

  onNoise(_ctx: GameContext, pos: Vec3Like): void {
    if (this.dead) return;
    this.noisePending = true;
    this.pointThreat = true;
    this.threatX = pos.x;
    this.threatZ = pos.z;
  }

  protected onHurt(): void {
    this.hitPending = true;
  }

  /** The herd bolts from the hunter. */
  protected onDeath(ctx: GameContext): void {
    this.herd.raise(this, 'flee', ctx.player.position.x, ctx.player.position.z);
    this.herd.remove(this);
  }

  /** Anywhere but the town. Far from the town quadrant the (noise-based) biome lookup is skipped. */
  protected allowedAt(ctx: GameContext, x: number, z: number): boolean {
    if (x > TOWN_RECT.x1 + TOWN_LOOKUP_MARGIN || z > TOWN_RECT.z1 + TOWN_LOOKUP_MARGIN) return true;
    return ctx.terrain.biomeAt(Math.floor(x), Math.floor(z)) !== BIOME_TOWN;
  }

  protected think(dt: number, ctx: GameContext): void {
    const player = ctx.player;
    const pp = player.position;
    senses.dist = this.position.distanceTo(pp);
    senses.crouching = player.crouching && !player.flying;
    senses.sprinting = player.sprinting;
    senses.moving = player.horizontalSpeed > DEER.playerMoving;
    senses.hit = this.hitPending;
    senses.noise = this.noisePending;
    senses.herd = this.alarmPending;
    senses.moved = this.lastMoved;
    this.hitPending = false;
    this.noisePending = false;
    this.alarmPending = 'none';

    switch (stepDeerBrain(this.brain, senses, dt, this.random)) {
      case 'alert':
        this.call(ctx);
        this.herd.raise(this, 'alert', pp.x, pp.z);
        break;
      case 'flee':
        this.startFlight(ctx);
        break;
      case 'relax':
        this.grazing = true;
        this.idleTimer = this.rng.range(2, 6);
        break;
      case 'none':
        break;
    }
    this.pointThreat = false;

    switch (this.brain.state) {
      case 'idle':
        this.idle(dt, ctx);
        break;
      case 'alert':
        this.stand(this.yawTo(pp.x, pp.z));
        break;
      case 'stagger':
        this.stand();
        break;
      case 'flee':
        this.flee(dt, ctx);
        break;
      case 'recover':
        this.regroup();
        break;
    }
  }

  protected animatePose(dt: number, ctx: GameContext): void {
    const state = this.brain.state;
    const k = damp(6, dt);
    const fleeing = state === 'flee' ? 1 : 0;
    this.headDown += ((state === 'idle' && this.grazing ? 1 : 0) - this.headDown) * k;
    this.wary += ((state === 'alert' || state === 'recover' || state === 'stagger' ? 1 : 0) - this.wary) * k;
    this.bound += (fleeing - this.bound) * k;
    this.air += ((this.onGround ? 0 : 1) - this.air) * damp(12, dt);

    // Neck down to graze (nibbling), raised when wary, bobbing with the gait.
    const nibble = this.headDown * Math.sin(ctx.time.elapsed * 9) * 0.04;
    const neckPitch = this.headDown * 1.05 - this.wary * 0.3 + this.headBob;
    if (this.neck) this.neck.rotation.x = neckPitch;
    if (this.head) this.head.rotation.x = (this.neck ? this.headDown * 0.35 : neckPitch) + nibble;

    // Ears perk forward when wary and flick now and then; the tail goes up (white rump) when alarmed.
    this.twitchTimer -= dt;
    if (this.twitchTimer <= 0) {
      this.twitchTimer = this.rng.range(1.5, 5);
      this.twitch = 1;
      this.twitchSide = this.rng.chance(0.5) ? 1 : -1;
    }
    this.twitch = Math.max(0, this.twitch - dt * 5);
    const flick = Math.sin(this.twitch * Math.PI) * 0.5;
    const perk = 0.45 * Math.max(this.wary, this.bound * 0.5);
    if (this.earL) {
      this.earL.rotation.x = perk;
      this.earL.rotation.z = this.twitchSide > 0 ? flick : 0;
    }
    if (this.earR) {
      this.earR.rotation.x = perk;
      this.earR.rotation.z = this.twitchSide < 0 ? -flick : 0;
    }
    if (this.tail) {
      this.tail.rotation.x = 1.1 * Math.max(this.bound, this.wary * 0.6);
      this.tail.rotation.y = Math.sin(this.gaitPhase) * this.gaitAmp * 0.25;
    }

    // Bounding: legs gathered on the ground, stretched in the air; the body pitches with the arc.
    if (this.bound > 0.01) {
      const reach = (this.air * 2 - 1) * 0.55;
      const b = this.bound;
      if (this.legFL) this.legFL.rotation.x += (-reach - this.legFL.rotation.x) * b;
      if (this.legFR) this.legFR.rotation.x += (-reach - this.legFR.rotation.x) * b;
      if (this.legBL) this.legBL.rotation.x += (reach - this.legBL.rotation.x) * b;
      if (this.legBR) this.legBR.rotation.x += (reach - this.legBR.rotation.x) * b;
    }
    this.pitchRig(clamp(-this.velocity.y / 90, -0.22, 0.22) * this.bound, this.bodyY, 0, 0);
  }

  /** Grazing in place, nibbling a step further now and then, walking to its spot when the herd moves on. */
  private idle(dt: number, ctx: GameContext): void {
    const herd = this.herd;
    const now = ctx.time.elapsed;
    if (!herd.hasTarget) {
      // After a flight: graze where it ended, or head home at once if it carried the herd out of its range.
      if (herd.centre(centre)) {
        if (herd.homeDistance(centre.x, centre.z) > HOME_RADIUS) herd.pickTarget(ctx, this.rng);
        if (!herd.hasTarget) herd.setTarget(centre.x, centre.z);
      }
      herd.nextMoveAt = now + this.rng.range(15, 40);
    } else if (now >= herd.nextMoveAt && herd.calm) {
      herd.pickTarget(ctx, this.rng);
      herd.nextMoveAt = now + this.rng.range(25, 60);
    }
    if (herd.version !== this.herdVersion) {
      this.herdVersion = herd.version;
      this.beginWalk(herd.targetX + this.slotX, herd.targetZ + this.slotZ);
    }

    if (!this.grazing) {
      this.walkTime += dt;
      const d = this.distTo(this.walkX, this.walkZ);
      if (d > 6 && this.walkTime < 30) {
        this.moveTowards(this.walkX, this.walkZ, d > 80 ? TROT_SPEED : WALK_SPEED);
        return;
      }
      this.grazing = true;
      this.idleTimer = this.rng.range(4, 10);
    }
    this.stand();
    this.idleTimer -= dt;
    if (this.idleTimer > 0) return;
    const sx = herd.targetX + this.slotX;
    const sz = herd.targetZ + this.slotZ;
    if (this.distTo(sx, sz) > 25) this.beginWalk(sx, sz);
    else if (this.rng.chance(0.6)) this.beginWalk(this.position.x + this.rng.range(-15, 15), this.position.z + this.rng.range(-15, 15));
    else this.idleTimer = this.rng.range(3, 8);
  }

  private beginWalk(x: number, z: number): void {
    this.grazing = false;
    this.walkX = x;
    this.walkZ = z;
    this.walkTime = 0;
  }

  private startFlight(ctx: GameContext): void {
    this.threatIsPlayer = !this.pointThreat;
    this.aimFlight(ctx);
    this.fleeRetarget = 0.6;
    this.hopTimer = 0;
    this.call(ctx);
    this.herd.raise(this, 'flee', this.threatX, this.threatZ);
    this.herd.hasTarget = false;
  }

  /** Heads away from the threat, ±20° at random. */
  private aimFlight(ctx: GameContext): void {
    if (this.threatIsPlayer) {
      this.threatX = ctx.player.position.x;
      this.threatZ = ctx.player.position.z;
    }
    const dx = this.position.x - this.threatX;
    const dz = this.position.z - this.threatZ;
    const away = dx * dx + dz * dz > 1 ? Math.atan2(dx, dz) : this.yaw;
    const a = away + this.rng.range(-0.35, 0.35);
    this.fleeX = Math.sin(a);
    this.fleeZ = Math.cos(a);
  }

  private flee(dt: number, ctx: GameContext): void {
    this.fleeRetarget -= dt;
    if (this.fleeRetarget <= 0) {
      this.fleeRetarget = 0.6;
      this.aimFlight(ctx);
    }
    this.moveAlong(this.fleeX, this.fleeZ, DEER.fleeSpeed);
    // Bounding gait: a short ground contact between hops; no leap while an edge, water or a wall is
    // close ahead (a deer in the air can hardly brake).
    if (!this.onGround) {
      this.hopTimer = 0.1;
    } else {
      this.hopTimer -= dt;
      if (this.hopTimer <= 0 && this.lastMoved > 0.2 && this.pathClear(ctx, HOP_CLEARANCE)) {
        this.velocity.y = HOP_SPEED;
        this.onGround = false;
      }
    }
  }

  /** After a flight: rejoin the herd, keep an eye on the threat. */
  private regroup(): void {
    if (this.herd.centre(centre, this)) {
      const d = this.distTo(centre.x, centre.z);
      if (d > 30) {
        this.moveTowards(centre.x, centre.z, d > 150 ? TROT_SPEED : WALK_SPEED);
        return;
      }
    }
    this.stand(this.yawTo(this.threatX, this.threatZ));
  }

  /** The alarm call ('deer_alert'), once per herd per CALL_COOLDOWN_S. */
  private call(ctx: GameContext): void {
    const now = ctx.time.elapsed;
    if (now - this.herd.lastCallAt < CALL_COOLDOWN_S) return;
    this.herd.lastCallAt = now;
    ctx.audio.play('deer_alert', { pos: this.position });
  }
}
