/**
 * First-person player controller. OWNER: agent "player".
 *
 * Movement (when ctx.input.active): WASD, Space jump / swim up / fly up, ShiftLeft sprint / fly fast,
 * KeyC crouch / fly down, KeyV toggles fly (noclip). Mouse look with MOUSE_SENSITIVITY, pitch ±89°.
 * Physics via game/physics.ts with PLAYER constants, collides with ctx.entities.solidBoxes(),
 * clamps to the world bounds (invisible walls at 0.5 m from the map edge), auto step-up with a
 * smoothed camera, MANTLE (hold Space while pushing into a ledge whose top is ≤ PLAYER.mantleHeight
 * above the feet and has head clearance → climb onto it over PLAYER.mantleTime with smooth camera
 * motion; works from the ground, mid-jump and when swimming; crouches automatically if only crouch
 * height fits), swimming (buoyancy, drag), footstep sounds by the block under the feet, a soft
 * landing sound after falls > 1 m. No health / fall damage.
 *
 * Details: ground movement accelerates towards the wished velocity (12× the target speed per second)
 * and brakes as quickly; the air keeps momentum with 30 % control. Jumps get 0.1 s of coyote time and
 * a 0.1 s press buffer. Walking down drops of up to PLAYER.stepHeight snaps to the lower floor (stairs,
 * slopes); the camera eases out of every step up or down (~0.12 s). Crouching with C held stops at
 * edges deeper than a step. A mantle never climbs more than PLAYER.mantleHeight above the ground the
 * player last stood on, so jumping first does not extend its reach. Physics and gravity also run while
 * the input is inactive (UI open); only the intent is dropped.
 */
import * as THREE from 'three';
import { GRAVITY, MOUSE_SENSITIVITY, PLAYER, WORLD_X, WORLD_Y, WORLD_Z } from '../config';
import { angleDelta, clamp, damp, smoothstep } from '../core/math';
import { B, BLOCKS } from '../world/blocks';
import type { WorldData } from '../world/world';
import type { SoundName } from './audio';
import type { GameContext } from './context';
import type { Input } from './input';
import { blockUnder, bodyAABB, boxBlocked, makeAABB, moveBody, waterFraction, type AABB, type Body, type MoveOptions } from './physics';

const MAX_PITCH = (89 * Math.PI) / 180;

/** Ground acceleration towards the wished velocity, in target speeds per second. */
const GROUND_ACCEL = 12;
/** Braking on the ground without input, in walk speeds per second. */
const GROUND_BRAKE = 12;
/** Share of the ground acceleration available in the air. */
const AIR_CONTROL = 0.3;
const COYOTE_S = 0.1;
const JUMP_BUFFER_S = 0.1;
/** Wading slows walking by up to this share (reached at the swimming depth). */
const WADE_SLOWDOWN = 0.4;

/** Submerged share of the body above which the player swims: buoyancy, swim speed, no jumping. */
const SWIM_DEPTH = 0.4;
/** Buoyancy at full submersion in multiples of gravity: floats about 80 % under, eyes above water. */
const BUOYANCY = 1.5;
/** Vertical acceleration of Space (up) and C (down) while swimming, units/s². */
const SWIM_UP_ACCEL = 0.9 * GRAVITY;
const SWIM_DOWN_ACCEL = 1.2 * GRAVITY;
/** Vertical water drag at full submersion, 1/s. */
const WATER_DRAG = 3.5;
/** Swimming acceleration and braking, in swim speeds per second. */
const SWIM_ACCEL = 5;
/** Falling into water faster than this (units/s) splashes… */
const SPLASH_SPEED = 20;
/** …once this share of the body is under. */
const SPLASH_DEPTH = 0.05;

/** The flight velocity follows the wished one at this rate (1/s): smooth starts and stops. */
const FLY_RESPONSE = 6;
/** Leaving flight inside solid ground (or a spawn on uneven ground) rises at most this far to free space. */
const MAX_LIFT_OUT = 40;
const NO_CLIP: MoveOptions = { noClip: true };

/** Holding Space while pushing into something closer than this looks for a ledge to mantle. */
const MANTLE_PROBE = 0.5;
/** Horizontal travel of a mantle, onto the ledge. */
const MANTLE_REACH = PLAYER.halfWidth + 1;
/**
 * Share of PLAYER.mantleTime spent rising in place; the rest moves across onto the ledge. The phases
 * never overlap: moving across before the feet clear the top would cut through the ledge's corner.
 */
const MANTLE_RISE_END = 0.6;
/** A crouching player does not walk off drops deeper than this. */
const CROUCH_EDGE_DEPTH = PLAYER.stepHeight + 0.5;

/** Time constant of the camera catching up after a step up or down, seconds. */
const EYE_SMOOTH_S = 0.12;
/** Largest camera lag kept; larger jumps snap the rest. */
const MAX_EYE_LAG = 6;
/** Eye height change rate when crouching / standing up, 1/s. */
const CROUCH_EYE_RATE = 12;

/** Invisible walls 0.5 m inside the map edges. */
const EDGE_MARGIN = 5;
const MIN_FEET_Y = 1;

/** A footstep every 0.55 m walking and 0.75 m sprinting; a swim stroke every 0.9 m. */
const STRIDE = 5.5;
const SPRINT_STRIDE = 7.5;
const SWIM_STROKE = 9;
/** 'land' after falls deeper than 1 m… */
const LAND_FALL = 10;
/** …and a soft footstep after smaller drops deeper than this. */
const SOFT_LAND_FALL = 2;

/** Footstep sound per block id (ARCHITECTURE.md §7); null where there is nothing to step on. */
const STEP_SOUND: readonly (SoundName | null)[] = BLOCKS.map((def): SoundName | null => {
  if (!def.solid) return null;
  if (def.id === B.LINOLEUM) return 'step_wood'; // laid over plank floors
  switch (def.sound) {
    case 'dirt':
      return 'step_dirt';
    case 'grass':
    case 'fabric':
      return 'step_grass';
    case 'sand':
      return 'step_sand';
    case 'gravel':
      return 'step_gravel';
    case 'wood':
      return 'step_wood';
    case 'metal':
      return 'step_metal';
    default:
      return 'step_stone';
  }
});

const setBox = (b: AABB, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): AABB => {
  b.minX = minX;
  b.minY = minY;
  b.minZ = minZ;
  b.maxX = maxX;
  b.maxY = maxY;
  b.maxZ = maxZ;
  return b;
};

export class Player implements Body {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  halfWidth: number = PLAYER.halfWidth;
  height: number = PLAYER.height;
  onGround = false;
  /** Radians; 0 looks to -Z, positive turns left (counter-clockwise seen from above), like three.js Euler 'YXZ'. */
  yaw = 0;
  /** Radians; positive looks up. */
  pitch = 0;
  flying = false;
  crouching = false;
  sprinting = false;
  /** Fraction of the body submerged in water (0..1). */
  inWater = 0;
  /** The camera (eye) is inside a water voxel. */
  eyeInWater = false;
  /** Smoothed eye position, world units (updated in update()). */
  readonly eye = new THREE.Vector3();

  /** Eye height above the feet, easing between standing and crouching. */
  private eyeLevel: number = PLAYER.eyeHeight;
  /** Camera offset left by step-ups (negative) and snaps down (positive); decays to 0. */
  private eyeLag = 0;
  /** Seconds left in which a jump is still allowed after leaving the ground. */
  private coyote = 0;
  /** Seconds left in which a Space press still makes a jump (pressed just before landing). */
  private jumpBuffer = 0;
  /** Feet level when last on the ground or swimming: mantles reach PLAYER.mantleHeight above it at most. */
  private groundY: number;
  /** Highest feet level since leaving the ground (fall height for the landing sound). */
  private fallTop: number;
  /** Distance walked (or swum) since the last footstep. */
  private stepDistance = 0;
  /** Mantle progress 0..1; -1 while not mantling. */
  private mantleT = -1;
  private readonly mantleFrom = new THREE.Vector3();
  private readonly mantleTo = new THREE.Vector3();
  /** This frame's intent: unit horizontal wish direction, forward key axis and held keys. */
  private wishX = 0;
  private wishZ = 0;
  private forwardAxis = 0;
  private jumpHeld = false;
  private downHeld = false;
  private fastHeld = false;
  /** C held when the input was last active (kept while a UI is open). */
  private wantCrouch = false;
  /** The spawn has been checked for overlapping solids (first update). */
  private placed = false;
  private readonly solids: AABB[] = [];
  private readonly region = makeAABB();
  private readonly box = makeAABB();
  private readonly splashAt = new THREE.Vector3();
  private readonly moveOpts: MoveOptions = { stepHeight: PLAYER.stepHeight, solids: this.solids, snapDown: 0, edgeGuard: 0 };

  /** Initialises position, yaw and `eye` from the spawn, so applyToCamera() is valid before the first update(). */
  constructor(spawn: { x: number; y: number; z: number; yaw: number }) {
    this.position.set(spawn.x, spawn.y, spawn.z);
    this.yaw = spawn.yaw;
    this.groundY = spawn.y;
    this.fallTop = spawn.y;
    this.eye.set(spawn.x, spawn.y + PLAYER.eyeHeight, spawn.z);
  }

  update(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    const active = input.active;
    if (active) {
      this.yaw = angleDelta(0, this.yaw - input.mouseDX * MOUSE_SENSITIVITY);
      this.pitch = clamp(this.pitch - input.mouseDY * MOUSE_SENSITIVITY, -MAX_PITCH, MAX_PITCH);
    }
    this.readIntent(input, active, dt);
    this.collectSolids(ctx, dt);
    if (!this.placed) {
      // floorBelow() spawns follow the centre column: on a slope the footprint can overlap higher voxels.
      this.placed = true;
      this.liftOut(ctx.world);
    }
    if (active && input.consume('KeyV')) this.toggleFlight(ctx);

    const wasInWater = this.inWater;
    const fallSpeed = -this.velocity.y;
    if (this.flying) this.fly(dt, ctx.world);
    else if (this.mantleT >= 0) this.advanceMantle(dt, ctx);
    else this.walk(dt, ctx);
    this.keepInWorld();

    this.inWater = waterFraction(ctx.world, this);
    if (!this.flying && wasInWater < SPLASH_DEPTH && this.inWater >= SPLASH_DEPTH && fallSpeed > SPLASH_SPEED) {
      this.splash(ctx, fallSpeed);
    }
    this.updateEye(dt, ctx.world);
  }

  /** Unit look direction from yaw/pitch. */
  getLookDir(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Horizontal speed in world units/s (view-model bobbing, mob reactions). */
  get horizontalSpeed(): number {
    return Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
  }

  /** Copies eye position + yaw/pitch (Euler order 'YXZ') to the camera. */
  applyToCamera(camera: THREE.PerspectiveCamera): void {
    camera.position.copy(this.eye);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private get wishing(): boolean {
    return this.wishX !== 0 || this.wishZ !== 0;
  }

  private readIntent(input: Input, active: boolean, dt: number): void {
    let forward = 0;
    let right = 0;
    if (active) {
      if (input.isDown('KeyW')) forward++;
      if (input.isDown('KeyS')) forward--;
      if (input.isDown('KeyD')) right++;
      if (input.isDown('KeyA')) right--;
      this.wantCrouch = input.isDown('KeyC');
    }
    this.forwardAxis = forward;
    // forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw)
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wx = cos * right - sin * forward;
    const wz = -sin * right - cos * forward;
    const len = Math.sqrt(wx * wx + wz * wz);
    this.wishX = len > 0 ? wx / len : 0;
    this.wishZ = len > 0 ? wz / len : 0;
    this.jumpHeld = active && input.isDown('Space');
    this.downHeld = active && input.isDown('KeyC');
    this.fastHeld = active && input.isDown('ShiftLeft');
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (active && input.consume('Space')) this.jumpBuffer = JUMP_BUFFER_S;
  }

  /** Solid entity boxes (closed doors, containers) around everything this frame can touch. */
  private collectSolids(ctx: GameContext, dt: number): void {
    const p = this.position;
    const v = this.velocity;
    const across = this.halfWidth + MANTLE_REACH + (Math.abs(v.x) + Math.abs(v.z)) * dt + 1;
    const vertical = Math.abs(v.y) * dt + 1;
    setBox(
      this.region,
      p.x - across,
      p.y - PLAYER.stepHeight - vertical,
      p.z - across,
      p.x + across,
      p.y + PLAYER.height + PLAYER.mantleHeight + vertical,
      p.z + across,
    );
    ctx.entities.solidBoxes(this.region, this.solids);
  }

  // ------------------------------------------------------------------ walking & swimming

  private walk(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    const p = this.position;
    const v = this.velocity;
    const swimming = this.inWater > SWIM_DEPTH;
    this.updateCrouch(world, swimming);

    if (this.onGround || swimming) {
      this.coyote = this.onGround && !swimming ? COYOTE_S : 0;
      this.groundY = p.y;
      this.fallTop = p.y;
    } else {
      this.coyote -= dt;
      if (p.y > this.fallTop) this.fallTop = p.y;
    }

    if (this.jumpHeld && this.wishing && this.startMantle(world, swimming)) {
      this.advanceMantle(dt, ctx);
      return;
    }

    this.sprinting = this.fastHeld && this.forwardAxis > 0 && !this.crouching && !swimming && (this.onGround || this.sprinting);
    this.accelerate(dt, swimming);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = PLAYER.jumpSpeed;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.onGround = false;
    }

    let dy: number;
    const wet = this.inWater;
    if (wet > 0) {
      let ay = -GRAVITY;
      if (swimming) {
        ay += (GRAVITY * BUOYANCY * (wet - SWIM_DEPTH)) / (1 - SWIM_DEPTH);
        if (this.jumpHeld) ay += SWIM_UP_ACCEL;
        if (this.downHeld) ay -= SWIM_DOWN_ACCEL;
      }
      v.y = (v.y + ay * dt) * Math.exp(-WATER_DRAG * wet * dt);
      dy = v.y * dt;
    } else {
      dy = (v.y - 0.5 * GRAVITY * dt) * dt; // exact for constant gravity: jump height independent of dt
      v.y -= GRAVITY * dt;
    }

    const opts = this.moveOpts;
    opts.snapDown = swimming || v.y > 0 ? 0 : PLAYER.stepHeight;
    // Only deliberate sneaking guards edges: a crouch forced by a low ceiling (a window mantled into) must not trap.
    opts.edgeGuard = this.crouching && this.wantCrouch && !swimming ? CROUCH_EDGE_DEPTH : 0;
    const x0 = p.x;
    const z0 = p.z;
    const wasOnGround = this.onGround;
    const moved = moveBody(world, this, v.x * dt, dy, v.z * dt, opts);
    this.eyeLag = clamp(this.eyeLag + moved.snapped - moved.stepped, -MAX_EYE_LAG, MAX_EYE_LAG);

    if (this.onGround && !wasOnGround) this.land(ctx);
    const mx = p.x - x0;
    const mz = p.z - z0;
    this.footsteps(ctx, Math.sqrt(mx * mx + mz * mz), swimming);
  }

  /** Crouches while C is held (not in deep water); stands up only where the full height fits. */
  private updateCrouch(world: WorldData, swimming: boolean): void {
    const want = this.wantCrouch && !swimming;
    if (want === this.crouching) return;
    if (want) {
      this.crouching = true;
      this.height = PLAYER.crouchHeight;
    } else if (this.fitsHeight(world, PLAYER.height)) {
      this.crouching = false;
      this.height = PLAYER.height;
    }
  }

  private fitsHeight(world: WorldData, h: number): boolean {
    const b = bodyAABB(this, this.box);
    b.maxY = b.minY + h;
    return !boxBlocked(world, b, this.solids);
  }

  private targetSpeed(swimming: boolean): number {
    if (swimming) return PLAYER.swimSpeed;
    const base = this.crouching ? PLAYER.crouchSpeed : this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
    return base * (1 - WADE_SLOWDOWN * Math.min(1, this.inWater / SWIM_DEPTH));
  }

  /** Moves the horizontal velocity towards the wished one at a bounded rate (no input in the air keeps momentum). */
  private accelerate(dt: number, swimming: boolean): void {
    const v = this.velocity;
    const speed = this.targetSpeed(swimming);
    let rate: number;
    if (swimming) rate = SWIM_ACCEL * PLAYER.swimSpeed;
    else if (this.onGround) rate = this.wishing ? GROUND_ACCEL * speed : GROUND_BRAKE * PLAYER.walkSpeed;
    else if (this.wishing) rate = GROUND_ACCEL * speed * AIR_CONTROL;
    else return;
    let dvx = this.wishX * speed - v.x;
    let dvz = this.wishZ * speed - v.z;
    const dv = Math.sqrt(dvx * dvx + dvz * dvz);
    const max = rate * dt;
    if (dv > max) {
      dvx *= max / dv;
      dvz *= max / dv;
    }
    v.x += dvx;
    v.z += dvz;
  }

  private land(ctx: GameContext): void {
    const fall = this.fallTop - this.position.y;
    this.stepDistance = 0;
    if (fall > LAND_FALL) ctx.audio.play('land', { volume: clamp(0.4 + (fall - LAND_FALL) / 40, 0.4, 1) });
    else if (fall > SOFT_LAND_FALL) this.playStep(ctx, 0.5);
  }

  private footsteps(ctx: GameContext, moved: number, swimming: boolean): void {
    if (swimming) {
      this.stepDistance += moved;
      if (this.stepDistance < SWIM_STROKE) return;
      this.stepDistance %= SWIM_STROKE;
      ctx.audio.play('swim', { volume: 0.5 });
      return;
    }
    if (!this.onGround) return;
    this.stepDistance += moved;
    const stride = this.sprinting ? SPRINT_STRIDE : STRIDE;
    if (this.stepDistance < stride) return;
    this.stepDistance %= stride;
    const pace = clamp(this.horizontalSpeed / PLAYER.sprintSpeed, 0, 1);
    this.playStep(ctx, (0.3 + 0.5 * pace) * (this.crouching ? 0.5 : 1));
  }

  private playStep(ctx: GameContext, volume: number): void {
    const sound = this.groundSound(ctx.world);
    if (sound !== null) ctx.audio.play(sound, { volume });
  }

  /** Step sound of the block under the feet; on an edge (open centre column) of one under a footprint corner. */
  private groundSound(world: WorldData): SoundName | null {
    const centre = STEP_SOUND[blockUnder(world, this)];
    if (centre !== null) return centre;
    const p = this.position;
    const r = this.halfWidth - 0.05;
    const y = Math.floor(p.y - 0.05);
    for (let i = 0; i < 4; i++) {
      const sound = STEP_SOUND[world.getBlock(Math.floor(p.x + (i & 1 ? r : -r)), y, Math.floor(p.z + (i & 2 ? r : -r)))];
      if (sound !== null) return sound;
    }
    return null;
  }

  private splash(ctx: GameContext, speed: number): void {
    const p = this.position;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    let y = Math.floor(p.y);
    for (let i = 0; i < PLAYER.height && ctx.world.getBlock(x, y, z) === B.WATER; i++) y++;
    const strength = clamp(speed / 60, 0.35, 1);
    ctx.particles.splash(this.splashAt.set(p.x, y, p.z), strength);
    ctx.audio.play('splash', { volume: strength });
  }

  // ------------------------------------------------------------------ mantling

  /**
   * Looks for a ledge in the wished direction while pushing into something: the lowest voxel level
   * above the feet (≤ PLAYER.mantleHeight above the ground last stood on) where the body fits on top
   * of something solid, reachable by rising in place and moving across. Prefers standing height and
   * falls back to crouching. On the ground, ledges the step-up takes by itself are left to it.
   */
  private startMantle(world: WorldData, swimming: boolean): boolean {
    const p = this.position;
    const hw = this.halfWidth;
    const fx = this.wishX;
    const fz = this.wishZ;
    const solids = this.solids;
    const b = bodyAABB(this, this.box);
    b.minX += fx * MANTLE_PROBE;
    b.maxX += fx * MANTLE_PROBE;
    b.minZ += fz * MANTLE_PROBE;
    b.maxZ += fz * MANTLE_PROBE;
    if (!boxBlocked(world, b, solids)) return false;

    const tx = p.x + fx * MANTLE_REACH;
    const tz = p.z + fz * MANTLE_REACH;
    const maxTop = Math.min(p.y, this.groundY) + PLAYER.mantleHeight;
    for (let top = Math.floor(p.y) + 1; top <= maxTop + 1e-6; top++) {
      for (let crouch = this.wantCrouch ? 1 : 0; crouch <= 1; crouch++) {
        const h = crouch === 1 ? PLAYER.crouchHeight : PLAYER.height;
        if (boxBlocked(world, setBox(b, tx - hw, top, tz - hw, tx + hw, top + h, tz + hw), solids)) continue;
        if (!boxBlocked(world, setBox(b, tx - hw, top - 0.5, tz - hw, tx + hw, top, tz + hw), solids)) continue;
        if (boxBlocked(world, setBox(b, p.x - hw, p.y, p.z - hw, p.x + hw, top + h, p.z + hw), solids)) continue;
        const x0 = Math.min(p.x, tx) - hw;
        const z0 = Math.min(p.z, tz) - hw;
        if (boxBlocked(world, setBox(b, x0, top, z0, Math.max(p.x, tx) + hw, top + h, Math.max(p.z, tz) + hw), solids)) continue;
        if (this.onGround && !swimming && crouch === 0 && top - p.y <= PLAYER.stepHeight) return false;
        this.mantleFrom.copy(p);
        this.mantleTo.set(tx, top, tz);
        this.mantleT = 0;
        this.jumpBuffer = 0;
        this.onGround = false;
        this.sprinting = false;
        if (crouch === 1 && !this.crouching) {
          this.crouching = true;
          this.height = PLAYER.crouchHeight;
        }
        return true;
      }
    }
    return false;
  }

  /** Rises in place (easing out), then eases across onto the ledge: the path startMantle() checked. */
  private advanceMantle(dt: number, ctx: GameContext): void {
    const t = Math.min(1, this.mantleT + dt / PLAYER.mantleTime);
    this.mantleT = t;
    const rise = Math.sin((Math.min(1, t / MANTLE_RISE_END) * Math.PI) / 2);
    const across = smoothstep(MANTLE_RISE_END, 1, t);
    const from = this.mantleFrom;
    const to = this.mantleTo;
    const p = this.position;
    const x = from.x + (to.x - from.x) * across;
    const y = from.y + (to.y - from.y) * rise;
    const z = from.z + (to.z - from.z) * across;
    if (dt > 0) this.velocity.set((x - p.x) / dt, (y - p.y) / dt, (z - p.z) / dt);
    p.set(x, y, z);
    if (t < 1) return;
    this.mantleT = -1;
    this.velocity.set(0, 0, 0);
    this.onGround = true;
    this.coyote = COYOTE_S;
    this.groundY = y;
    this.fallTop = y;
    this.stepDistance = 0;
    this.playStep(ctx, 0.5);
  }

  // ------------------------------------------------------------------ flight

  private fly(dt: number, world: WorldData): void {
    const v = this.velocity;
    const speed = this.fastHeld ? PLAYER.flySprintSpeed : PLAYER.flySpeed;
    let wx = this.wishX;
    let wy = (this.jumpHeld ? 1 : 0) - (this.downHeld ? 1 : 0);
    let wz = this.wishZ;
    const len = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (len > 1) {
      wx /= len;
      wy /= len;
      wz /= len;
    }
    const k = damp(FLY_RESPONSE, dt);
    v.x += (wx * speed - v.x) * k;
    v.y += (wy * speed - v.y) * k;
    v.z += (wz * speed - v.z) * k;
    moveBody(world, this, v.x * dt, v.y * dt, v.z * dt, NO_CLIP);
  }

  /** V: flight on; flight off, rising out of solid ground up to MAX_LIFT_OUT (deeper: stays airborne). */
  private toggleFlight(ctx: GameContext): void {
    if (!this.flying) {
      this.flying = true;
      this.mantleT = -1;
      this.onGround = false;
      this.sprinting = false;
      if (this.crouching) {
        this.crouching = false;
        this.height = PLAYER.height;
      }
      return;
    }
    if (!this.liftOut(ctx.world)) {
      ctx.hud.toast('Нельзя выключить полёт: вы внутри блока');
      return;
    }
    this.flying = false;
    this.velocity.set(0, 0, 0);
    this.groundY = this.position.y;
    this.fallTop = this.position.y;
  }

  /**
   * Moves the body up to the nearest voxel level (≤ MAX_LIFT_OUT) where it overlaps no solids; the
   * camera eases after it. Returns false, leaving the body in place, if there is none.
   */
  private liftOut(world: WorldData): boolean {
    const p = this.position;
    const y0 = p.y;
    for (let rise = 0; rise <= MAX_LIFT_OUT; rise++) {
      p.y = rise === 0 ? y0 : Math.floor(y0) + rise;
      if (boxBlocked(world, bodyAABB(this, this.box), this.solids)) continue;
      this.eyeLag = clamp(this.eyeLag + y0 - p.y, -MAX_EYE_LAG, MAX_EYE_LAG);
      return true;
    }
    p.y = y0;
    return false;
  }

  // ------------------------------------------------------------------ bounds & camera

  private keepInWorld(): void {
    const p = this.position;
    const v = this.velocity;
    if (p.x < EDGE_MARGIN || p.x > WORLD_X - EDGE_MARGIN) {
      p.x = clamp(p.x, EDGE_MARGIN, WORLD_X - EDGE_MARGIN);
      v.x = 0;
    }
    if (p.z < EDGE_MARGIN || p.z > WORLD_Z - EDGE_MARGIN) {
      p.z = clamp(p.z, EDGE_MARGIN, WORLD_Z - EDGE_MARGIN);
      v.z = 0;
    }
    if (p.y < MIN_FEET_Y) {
      p.y = MIN_FEET_Y;
      if (v.y < 0) v.y = 0;
      if (!this.flying) this.onGround = true;
    } else if (p.y > WORLD_Y) {
      p.y = WORLD_Y;
      if (v.y > 0) v.y = 0;
    }
  }

  private updateEye(dt: number, world: WorldData): void {
    const target = this.crouching ? PLAYER.crouchEyeHeight : PLAYER.eyeHeight;
    this.eyeLevel += (target - this.eyeLevel) * damp(CROUCH_EYE_RATE, dt);
    this.eyeLag *= Math.exp(-dt / EYE_SMOOTH_S);
    const p = this.position;
    this.eye.set(p.x, p.y + this.eyeLevel + this.eyeLag, p.z);
    this.eyeInWater = world.getBlock(Math.floor(p.x), Math.floor(this.eye.y), Math.floor(p.z)) === B.WATER;
  }
}
