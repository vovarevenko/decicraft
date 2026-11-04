/**
 * Stray dog (бродячая собака): lives in the town. Wary at first (keeps 6–10 m away, barks), comes
 * closer when the player holds food it likes; E with such food feeds it → becomes friendly: follows
 * the player at ~2–3 m, sits when the player stands still, wags its tail, occasionally barks at deer.
 * Hitting it makes it yelp, flee and forget the friendship. Never dies (PoC). OWNER: agent "entities".
 *
 * The state machine lives in dogBrain.ts; this class feeds it senses, moves, animates and handles E.
 * HUD name «Собака», «Дружок» once friendly; hints per state. A bark is a loud noise (deer flee).
 */
import * as THREE from 'three';
import { clamp, damp, TAU } from '../../core/math';
import type { GameContext } from '../context';
import type { Entity } from '../entities/entity';
import { createDogBrain, DOG, dogFoodOf, stepDogBrain, type DogSenses } from './dogBrain';
import { Mob } from './mob';

/** Barks reach this far as noise (20 m). */
const BARK_NOISE_RADIUS = 200;
/** Roaming stays within this radius of the spawn point (12 m). */
const ROAM_RADIUS = 120;
/** Below this horizontal speed (units/s) the player counts as standing still. */
const PLAYER_IDLE_SPEED = 2;
const BARK_ANIM_S = 0.3;

const senses: DogSenses = { dist: 0, playerIdle: 0, food: 'none', friendly: false, hit: false, deerDist: Infinity };
const nearby: Entity[] = [];
const tmp = new THREE.Vector3();

export class Dog extends Mob {
  readonly type = 'mob';
  readonly kind = 'dog' as const;
  friendly = false;
  /** Behaviour state machine (dogBrain.ts). */
  readonly brain = createDogBrain();

  private readonly homeX: number;
  private readonly homeZ: number;
  private playerIdle = 0;
  private hitPending = false;
  private roamX = 0;
  private roamZ = 0;
  private roamTimer = 0;
  /** Movement hysteresis: backing off / closing in (wary), on the way to the player (beg, follow). */
  private retreating = false;
  private approaching = false;
  private catchingUp = false;
  private deerX = 0;
  private deerZ = 0;
  /** Seconds left to face the deer it barked at. */
  private watchDeer = 0;
  private barkAnim = 0;
  /** Seconds of extra-happy wagging after being fed or petted. */
  private happy = 0;
  private wagPhase = 0;
  private wag = 0;
  private sit = 0;
  private scared = 0;
  /** Rig-space joints used by the sitting pose: hind hips (y, z) and the front hips' z. */
  private readonly hipY: number;
  private readonly hindZ: number;
  private readonly frontZ: number;
  private readonly head: THREE.Group | null;
  private readonly jaw: THREE.Group | null;
  private readonly earL: THREE.Group | null;
  private readonly earR: THREE.Group | null;
  private readonly tail: THREE.Group | null;
  private readonly random = (): number => this.rng.next();

  constructor(x: number, y: number, z: number, seed: number) {
    super();
    this.init(x, y, z, seed);
    this.mortal = false;
    this.displayName = 'Собака';
    this.turnRate = 6;
    this.accel = 160;
    this.stride = 6;
    this.gaitFullSpeed = 30;
    this.homeX = x;
    this.homeZ = z;
    this.head = this.part('head');
    this.jaw = this.part('jaw');
    this.earL = this.part('earL');
    this.earR = this.part('earR');
    this.tail = this.part('tail');
    const hind = this.legBL ? this.restPivot('legBL', tmp) : tmp.set(0, this.height * 0.5, -this.rigLength * 0.3);
    this.hipY = hind.y;
    this.hindZ = hind.z;
    this.frontZ = this.legFL ? this.restPivot('legFL', tmp).z : this.rigLength * 0.3;
  }

  /** E: feed it food it likes (befriends it), or pet a friendly dog. */
  interact(ctx: GameContext): void {
    if (this.brain.state === 'flee') return;
    const inv = ctx.inventory;
    if (dogFoodOf(inv) === 'liked') {
      inv.takeFromSlot(inv.selected, 1);
      ctx.audio.play('dog_whine', { pos: this.position });
      this.happy = 3;
      if (this.friendly) {
        ctx.hud.toast('Дружок доволен');
      } else {
        this.friendly = true;
        this.displayName = 'Дружок';
        ctx.hud.toast('Собака теперь ваш друг');
      }
      return;
    }
    if (this.friendly) {
      ctx.audio.play('dog_whine', { pos: this.position, volume: 0.6 });
      this.happy = 2;
    }
  }

  hint(ctx: GameContext): string {
    if (this.brain.state === 'flee') return 'Напугана';
    const food = dogFoodOf(ctx.inventory);
    if (this.friendly) return food === 'liked' ? 'E — угостить' : 'E — погладить';
    if (food === 'liked') return 'E — покормить';
    if (food === 'other') return 'Такое собака не ест';
    return 'Не подпускает — приманите едой';
  }

  protected onHurt(ctx: GameContext): void {
    ctx.audio.play('dog_yelp', { pos: this.position });
    this.hitPending = true;
    this.happy = 0;
    this.friendly = false;
    this.displayName = 'Собака';
  }

  protected think(dt: number, ctx: GameContext): void {
    const pp = ctx.player.position;
    this.playerIdle = ctx.player.horizontalSpeed < PLAYER_IDLE_SPEED ? this.playerIdle + dt : 0;
    senses.dist = this.position.distanceTo(pp);
    senses.playerIdle = this.playerIdle;
    senses.food = dogFoodOf(ctx.inventory);
    senses.friendly = this.friendly;
    senses.hit = this.hitPending;
    // Deer are only looked up when a bark at them is possible this step.
    senses.deerDist = this.friendly && this.brain.barkTimer <= dt ? this.nearestDeer(ctx) : Infinity;
    this.hitPending = false;
    this.happy = Math.max(0, this.happy - dt);
    this.watchDeer = Math.max(0, this.watchDeer - dt);

    const event = stepDogBrain(this.brain, senses, dt, this.random);
    if (event === 'bark') {
      this.bark(ctx);
    } else if (event === 'barkAtDeer') {
      this.bark(ctx);
      this.watchDeer = 1.5;
    }

    const d = senses.dist;
    switch (this.brain.state) {
      case 'roam':
        this.roam(dt);
        break;
      case 'wary':
        this.keepDistance(pp.x, pp.z, d);
        break;
      case 'beg':
        this.goTo(pp.x, pp.z, d, DOG.begDist, DOG.begDist + 10, d > DOG.runDist ? DOG.trot : DOG.walk);
        break;
      case 'follow':
        this.goTo(pp.x, pp.z, d, DOG.followNear, DOG.followFar, d > DOG.runDist ? DOG.run : d > 50 ? DOG.trot : DOG.walk + 6);
        break;
      case 'sit':
        this.stand(this.yawTo(pp.x, pp.z));
        break;
      case 'flee':
        this.moveAwayFrom(pp.x, pp.z, DOG.fleeSpeed);
        break;
    }
    if (this.watchDeer > 0 && this.goalSpeed === 0) this.faceYaw = this.yawTo(this.deerX, this.deerZ);
  }

  protected animatePose(dt: number, ctx: GameContext): void {
    const state = this.brain.state;
    const k = damp(6, dt);
    const sitting = state === 'sit' || (state === 'beg' && this.goalSpeed === 0);
    this.sit += ((sitting ? 1 : 0) - this.sit) * k;
    this.scared += ((state === 'flee' ? 1 : 0) - this.scared) * k;

    // Tail: fast wag when happy or friendly, hopeful wag when begging, a slow low sway when wary, tucked when scared.
    const wagRate = this.happy > 0 ? 18 : this.friendly ? 13 : state === 'beg' ? 10 : 4;
    const wagAmp = state === 'flee' ? 0 : this.happy > 0 ? 0.75 : this.friendly ? 0.55 : state === 'beg' ? 0.45 : 0.15;
    this.wag += (wagAmp - this.wag) * k;
    this.wagPhase = (this.wagPhase + wagRate * dt) % TAU;
    if (this.tail) {
      this.tail.rotation.y = Math.sin(this.wagPhase) * this.wag;
      this.tail.rotation.x = this.scared * 0.9 + (this.friendly ? -0.2 : 0.25 * (1 - this.scared));
    }

    // Ears flat back when scared, pricked while wary.
    const ear = this.scared * 0.6 - (state === 'wary' ? 0.25 : 0);
    if (this.earL) this.earL.rotation.x = ear;
    if (this.earR) this.earR.rotation.x = ear;

    // Jaw snaps open on a bark, pants while running.
    this.barkAnim = Math.max(0, this.barkAnim - dt);
    if (this.jaw) {
      const pant = this.gaitAmp * 0.12 * (0.5 + 0.5 * Math.sin(ctx.time.elapsed * 14));
      this.jaw.rotation.x = this.barkAnim > 0 ? 0.45 * Math.sin((this.barkAnim / BARK_ANIM_S) * Math.PI) : pant;
    }
    if (this.head) this.head.rotation.x = this.headBob - (this.barkAnim > 0 ? 0.25 : 0) - this.sit * 0.15;

    // Sitting: the body pitches up around the hind hips and lowers until the front feet stay on the
    // ground; front legs counter-rotate to stay vertical, hind legs reach forward until the paws touch
    // the ground again (leg length ≈ hip height).
    const s = this.sit;
    const pitch = -0.55 * s;
    const drop = Math.max(0, this.frontZ - this.hindZ) * Math.sin(-pitch);
    this.pitchRig(pitch, this.hipY, this.hindZ, drop);
    if (s > 0.001) {
      const hindLean = Math.acos(clamp((this.hipY - drop) / Math.max(this.hipY, 1e-3), -1, 1));
      const hind = -(hindLean + pitch);
      if (this.legFL) this.legFL.rotation.x = this.legFL.rotation.x * (1 - s) - pitch;
      if (this.legFR) this.legFR.rotation.x = this.legFR.rotation.x * (1 - s) - pitch;
      if (this.legBL) this.legBL.rotation.x = this.legBL.rotation.x * (1 - s) + hind;
      if (this.legBR) this.legBR.rotation.x = this.legBR.rotation.x * (1 - s) + hind;
    }
  }

  /** Strolls between random spots around its home. */
  private roam(dt: number): void {
    this.roamTimer -= dt;
    if (this.roamTimer <= 0) {
      this.roamTimer = this.rng.range(5, 12);
      const a = this.rng.range(0, TAU);
      const r = this.rng.range(0, ROAM_RADIUS);
      this.roamX = this.homeX + Math.sin(a) * r;
      this.roamZ = this.homeZ + Math.cos(a) * r;
    }
    if (this.distTo(this.roamX, this.roamZ) > 8) this.moveTowards(this.roamX, this.roamZ, DOG.walk);
    else this.stand();
  }

  /** Wary: stays 6–10 m from the player, watching. */
  private keepDistance(px: number, pz: number, d: number): void {
    if (d < DOG.waryMin) this.retreating = true;
    else if (d > DOG.waryMin + 15) this.retreating = false;
    if (d > DOG.waryMax) this.approaching = true;
    else if (d < DOG.waryMax - 15) this.approaching = false;
    if (this.retreating) this.moveAwayFrom(px, pz, DOG.trot);
    else if (this.approaching) this.moveTowards(px, pz, DOG.walk);
    else this.stand(this.yawTo(px, pz));
  }

  /** Comes up to the player: starts beyond `far`, stops within `near`, then waits facing them. */
  private goTo(px: number, pz: number, d: number, near: number, far: number, speed: number): void {
    if (d > far) this.catchingUp = true;
    else if (d < near) this.catchingUp = false;
    if (this.catchingUp) this.moveTowards(px, pz, speed);
    else this.stand(this.yawTo(px, pz));
  }

  private nearestDeer(ctx: GameContext): number {
    let best = Infinity;
    const list = ctx.entities.queryRadius(this.position, DOG.deerBarkRange, nearby);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!(e instanceof Mob) || e.kind !== 'deer' || e.dead) continue;
      const d = this.position.distanceTo(e.position);
      if (d < best) {
        best = d;
        this.deerX = e.position.x;
        this.deerZ = e.position.z;
      }
    }
    return best;
  }

  private bark(ctx: GameContext): void {
    ctx.audio.play('dog_bark', { pos: this.position });
    ctx.entities.emitNoise(ctx, this.position, BARK_NOISE_RADIUS);
    this.barkAnim = BARK_ANIM_S;
  }
}
