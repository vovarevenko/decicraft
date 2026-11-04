/**
 * Base mob: rig instantiation from getMobRig() (THREE.Group per part at its pivot), physics body
 * (moveBody with step-up ~5 voxels and small jumps over obstacles), steering helpers (wander,
 * flee, follow, avoid water/cliffs, turn when blocked), procedural gait animation (leg swing ∝
 * speed, head bob, tail), hurt flash + knockback, death (rolls on its side, sinks into the ground,
 * drops loot). OWNER: agent "entities".
 *
 * Subclasses call init() right after super() (once `kind` is set). Each update they decide in
 * think() — moveTowards()/moveAwayFrom()/moveAlong()/stand() — and pose head, ears and tail in
 * animatePose(); the base steers (probing the ground ahead, jumping 6–10 voxel ledges, detouring
 * around walls, water, drops > 1.5 m and areas allowedAt() refuses), integrates physics and swings
 * the legs in diagonal pairs. Models face +Z: object.rotation.y = yaw = atan2(dir.x, dir.z).
 * Mobs farther than FAR_MOB_DIST from the player update every FAR_UPDATE_EVERY-th frame.
 */
import * as THREE from 'three';
import { GRAVITY, WORLD_X, WORLD_Z } from '../../config';
import { angleDelta, clamp, damp, smoothstep, TAU } from '../../core/math';
import { Rng } from '../../core/rng';
import type { LootEntry, MobKind } from '../../gen/types';
import { getMobRig } from '../../render/models';
import { getModelMaterial } from '../../render/voxelModel';
import type { GameContext } from '../context';
import { Entity, type HitInfo } from '../entities/entity';
import { ItemDrop } from '../entities/itemDrop';
import { makeAABB, moveBody, waterFraction, type AABB, type Body, type MoveOptions } from '../physics';
import { makeGroundProbe, MOB_STEP_HEIGHT, probeGround, type ProbeKind } from './probe';

/** Mobs farther than this from the player (60 m) think and move only every FAR_UPDATE_EVERY-th frame. */
export const FAR_MOB_DIST = 600;
export const FAR_UPDATE_EVERY = 4;
/** Longest time step integrated at once (throttled far mobs, frame hitches), seconds. */
const MAX_STEP_S = 0.25;
/** Mobs stay this far (world units) inside the map edges. */
const MAP_MARGIN = 20;
/** Mobs are not drawn beyond 100 m (a few pixels in the fog). */
const VIEW_DISTANCE = 1000;
const FLASH_S = 0.3;
const KNOCKBACK = 28;
const KNOCKBACK_UP = 14;
/** Leg swing at full gait amplitude (radians). */
const MAX_LEG_SWING = 0.6;
/** A corpse lies this long, then sinks into the ground over CORPSE_SINK_S and is removed. */
const CORPSE_STAY_S = 10;
const CORPSE_SINK_S = 2.5;
/** Headings tried (radians off the wanted one, both sides) when the way ahead is blocked. */
const DETOUR_ANGLES = [0.5, 1.0, 1.6, 2.3, 2.9] as const;

const probe = makeGroundProbe();
const region = makeAABB();
const solids: AABB[] = [];
const moveOpts: MoveOptions = { stepHeight: MOB_STEP_HEIGHT, solids };

export abstract class Mob extends Entity implements Body {
  abstract readonly kind: MobKind;
  health = 10;
  maxHealth = 10;
  dead = false;
  onGround = false;
  /** Facing (radians): forward = (sin yaw, 0, cos yaw); mirrored to object.rotation.y. */
  yaw = 0;

  /** Wanted heading (unit xz vector) and speed (units/s) from think(); speed 0 = stand still. */
  protected goalX = 0;
  protected goalZ = 1;
  protected goalSpeed = 0;
  /** Yaw to turn to while standing; null keeps the current one. */
  protected faceYaw: number | null = null;
  /** Turn rate (rad/s) and ground acceleration (units/s²). */
  protected turnRate = 4;
  protected accel = 120;
  /** Speed (units/s) at which the gait reaches full swing, and the distance covered per gait cycle. */
  protected gaitFullSpeed = 40;
  protected stride = 8;
  /** False for mobs that never die (they still flinch and get knocked back). */
  protected mortal = true;
  /** Dropped as item stacks on death. */
  protected loot: readonly LootEntry[] = [];

  protected rng!: Rng;
  /** Whole-body pose root under `object` (death roll, sitting, bounding pitch). */
  protected readonly rig = new THREE.Group();
  protected readonly parts = new Map<string, THREE.Group>();
  protected legFL: THREE.Group | null = null;
  protected legFR: THREE.Group | null = null;
  protected legBL: THREE.Group | null = null;
  protected legBR: THREE.Group | null = null;
  /** Rig footprint from getMobRig (world units). */
  protected rigWidth = 1;
  protected rigLength = 1;
  /** Horizontal distance covered by the last physics step. */
  protected lastMoved = 0;
  /** Gait phase (radians) and swing amplitude (0 … 1). */
  protected gaitPhase = 0;
  protected gaitAmp = 0;

  private ownMaterial: THREE.Material | null = null;
  /** The cloned material's emissive colour (hurt flash) and its resting value. */
  private flashColor: THREE.Color | null = null;
  private readonly baseEmissive = new THREE.Color();
  private flash = 0;
  private detourX = 0;
  private detourZ = 1;
  private detourTime = 0;
  /** Side (±1) of the last detour, preferred again while sideMemory > 0 (seconds). */
  private detourSide = 1;
  private sideMemory = 0;
  private stuckTime = 0;
  private jumpCooldown = 0;
  private frameNo = 0;
  private pendingDt = 0;
  private deathTime = 0;
  private deathSide = 1;
  /** allowedAt() for the current position: a mob that is already somewhere it should not be may leave it freely. */
  private allowedHere = true;
  /** Swimming (water is no hazard then: the mob heads for the shore). */
  private swimming = false;

  /**
   * Places the mob and builds its rig. Subclasses call this right after super(), when `kind` is set.
   */
  protected init(x: number, y: number, z: number, seed: number): void {
    this.rng = new Rng(seed);
    this.position.set(x, y, z);
    this.viewDistance = VIEW_DISTANCE;
    this.yaw = this.rng.range(-Math.PI, Math.PI);
    this.object.rotation.y = this.yaw;

    const rig = getMobRig(this.kind);
    this.rigWidth = rig.size.width;
    this.rigLength = rig.size.length;
    // Square physics box between the body's width and length: fits doorways, rarely clips walls.
    this.halfWidth = Math.max(rig.size.width / 2, rig.size.length * 0.3);
    this.height = rig.size.height;

    const material = this.makeMaterial();
    for (const p of rig.parts) {
      const joint = new THREE.Group();
      joint.name = p.name;
      joint.position.set(p.pivot[0], p.pivot[1], p.pivot[2]);
      const mesh = new THREE.Mesh(p.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      joint.add(mesh);
      this.parts.set(p.name, joint);
    }
    for (const p of rig.parts) {
      const parent = p.parent !== null ? this.parts.get(p.parent) : undefined;
      (parent ?? this.rig).add(this.parts.get(p.name)!);
    }
    this.object.add(this.rig);
    this.legFL = this.part('legFL');
    this.legFR = this.part('legFR');
    this.legBL = this.part('legBL');
    this.legBR = this.part('legBR');
  }

  update(dt: number, ctx: GameContext): void {
    const step = this.throttle(dt, ctx);
    if (step === 0) return;
    if (this.dead) {
      this.updateCorpse(step, ctx);
      return;
    }
    this.think(step, ctx);
    this.locomote(step, ctx);
    this.animateGait(step);
    this.animatePose(step, ctx);
    this.updateFlash(step);
    this.object.rotation.y = this.yaw;
  }

  /**
   * LMB hit (the attacker plays the 'hit_mob' thud): red flash, knockback; damage and death for
   * mortal mobs, otherwise onHurt().
   */
  onHit(ctx: GameContext, hit: HitInfo): void {
    if (this.dead) return;
    this.flash = 1;
    const len = Math.sqrt(hit.dir.x * hit.dir.x + hit.dir.z * hit.dir.z);
    if (len > 1e-4) {
      this.velocity.x += (hit.dir.x / len) * KNOCKBACK;
      this.velocity.z += (hit.dir.z / len) * KNOCKBACK;
    }
    this.velocity.y = Math.max(this.velocity.y, KNOCKBACK_UP);
    if (this.mortal) {
      this.health = Math.max(0, this.health - hit.damage);
      if (this.health === 0) {
        this.die(ctx, hit);
        return;
      }
    }
    this.onHurt(ctx, hit);
  }

  onRemove(_ctx: GameContext): void {
    this.ownMaterial?.dispose();
  }

  /** Picking box: the rig's length × width turned to the facing (the physics box stays square). */
  getBounds(out: AABB): AABB {
    const s = Math.abs(Math.sin(this.yaw));
    const c = Math.abs(Math.cos(this.yaw));
    const hx = (s * this.rigLength + c * this.rigWidth) / 2;
    const hz = (c * this.rigLength + s * this.rigWidth) / 2;
    const p = this.position;
    out.minX = p.x - hx;
    out.maxX = p.x + hx;
    out.minY = p.y;
    out.maxY = p.y + this.height;
    out.minZ = p.z - hz;
    out.maxZ = p.z + hz;
    return out;
  }

  // ------------------------------------------------------------------ subclass hooks

  /** AI for this step: choose a movement with moveTowards()/moveAwayFrom()/moveAlong()/stand(). */
  protected abstract think(dt: number, ctx: GameContext): void;
  /** Kind-specific pose on top of the gait (head, ears, tail, sitting). */
  protected abstract animatePose(dt: number, ctx: GameContext): void;
  /** A non-lethal hit (after flash and knockback). */
  protected onHurt(_ctx: GameContext, _hit: HitInfo): void {}
  /** Called once on death (after the loot dropped). */
  protected onDeath(_ctx: GameContext): void {}
  /** Whether the mob may walk into column (x, z), e.g. deer avoid the town. */
  protected allowedAt(_ctx: GameContext, _x: number, _z: number): boolean {
    return true;
  }

  // ------------------------------------------------------------------ helpers for subclasses

  protected part(name: string): THREE.Group | null {
    return this.parts.get(name) ?? null;
  }

  /** Yaw that faces world point (x, z). */
  protected yawTo(x: number, z: number): number {
    return Math.atan2(x - this.position.x, z - this.position.z);
  }

  /** Horizontal distance to world point (x, z). */
  protected distTo(x: number, z: number): number {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  protected moveAlong(dx: number, dz: number, speed: number): void {
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) {
      this.stand();
      return;
    }
    this.goalX = dx / len;
    this.goalZ = dz / len;
    this.goalSpeed = speed;
    this.faceYaw = null;
  }

  protected moveTowards(x: number, z: number, speed: number): void {
    this.moveAlong(x - this.position.x, z - this.position.z, speed);
  }

  protected moveAwayFrom(x: number, z: number, speed: number): void {
    const dx = this.position.x - x;
    const dz = this.position.z - z;
    if (dx * dx + dz * dz < 1e-6) this.moveAlong(Math.sin(this.yaw), Math.cos(this.yaw), speed);
    else this.moveAlong(dx, dz, speed);
  }

  /** Stop; turn to `yaw` if given. */
  protected stand(yaw: number | null = null): void {
    this.goalSpeed = 0;
    this.faceYaw = yaw;
  }

  /** Rest-pose position of a part's joint in rig space (sum of the pivots up its parent chain). */
  protected restPivot(name: string, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    let node: THREE.Object3D | null = this.parts.get(name) ?? null;
    while (node && node !== this.rig) {
      out.add(node.position);
      node = node.parent;
    }
    return out;
  }

  /** Pitches the rig by `angle` about the horizontal axis through rig point (0, py, pz), lowered by `drop`. */
  protected pitchRig(angle: number, py: number, pz: number, drop: number): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    this.rig.rotation.set(angle, 0, 0);
    this.rig.position.set(0, py - (py * c - pz * s) - drop, pz - (py * s + pz * c));
  }

  /** Head-bob pitch (radians) for the current gait, to add to a head or neck. */
  protected get headBob(): number {
    return Math.sin(this.gaitPhase * 2) * this.gaitAmp * 0.06;
  }

  /** No hazard (wall, deep drop, water, refused area) along the facing within `dist` — e.g. before a leap. */
  protected pathClear(ctx: GameContext, dist: number): boolean {
    return this.freeDistance(ctx, Math.sin(this.yaw), Math.cos(this.yaw), dist) === Infinity;
  }

  // ------------------------------------------------------------------ internals

  /** Far mobs integrate the accumulated time every FAR_UPDATE_EVERY-th frame; returns 0 on skipped frames. */
  private throttle(dt: number, ctx: GameContext): number {
    this.frameNo++;
    this.pendingDt += dt;
    const p = ctx.player.position;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const far = dx * dx + dz * dz > FAR_MOB_DIST * FAR_MOB_DIST;
    if (far && (this.frameNo + this.id) % FAR_UPDATE_EVERY !== 0) return 0;
    const step = Math.min(this.pendingDt, MAX_STEP_S);
    this.pendingDt = 0;
    return step;
  }

  /** A per-mob copy of the shared model material (same shader program) whose emissive drives the hurt flash. */
  private makeMaterial(): THREE.Material {
    const base = getModelMaterial();
    // A ShaderMaterial clone would copy its uniforms (and lose shared ones): share it and skip the flash.
    if ((base as THREE.ShaderMaterial).isShaderMaterial) return base;
    const m = base.clone();
    m.onBeforeCompile = base.onBeforeCompile;
    m.customProgramCacheKey = base.customProgramCacheKey;
    const emissive = (m as THREE.MeshStandardMaterial).emissive;
    if (emissive instanceof THREE.Color) {
      this.flashColor = emissive;
      this.baseEmissive.copy(emissive);
    }
    this.ownMaterial = m;
    return m;
  }

  /**
   * One step of steering and physics:
   *  1. heading — towards the goal, or a detour when the way ahead (within the stopping distance plus
   *     0.3 s) is blocked by a wall, a drop > 1.5 m, water or a refused area; 6–10 voxel ledges are jumped;
   *  2. turning — the mob walks along its facing, slower while still turning towards the heading;
   *  3. safety — the speed along the facing is capped so the mob can stop before the first hazard,
   *     and it brakes fully while its current velocity carries it towards one (turning lag, knockback).
   */
  private locomote(dt: number, ctx: GameContext): void {
    const pos = this.position;
    const vel = this.velocity;
    const wet = waterFraction(ctx.world, this);
    this.swimming = wet > 0.3;
    this.allowedHere = this.allowedAt(ctx, pos.x, pos.z);
    this.jumpCooldown -= dt;
    this.detourTime -= dt;
    this.sideMemory -= dt;
    const accel = this.onGround || this.swimming ? this.accel : this.accel * 0.5;
    const near = this.halfWidth + 2;

    let speed = this.goalSpeed;
    let hx = this.goalX;
    let hz = this.goalZ;
    if (speed > 0) {
      if (this.detourTime > 0) {
        hx = this.detourX;
        hz = this.detourZ;
      }
      const look = near + (speed * speed) / (2 * this.accel) + speed * 0.3;
      const ahead = this.probeAhead(ctx, hx, hz, near);
      // Ledges of 6–10 voxels are jumped; a swimmer hops onto any bank (there is no step-up in water).
      const canJump = (this.onGround || this.swimming) && this.jumpCooldown <= 0;
      if (canJump && (ahead === 'jump' || (this.swimming && ahead === 'ok' && probe.dy > 0))) this.jump(probe.dy);
      const blocked = ahead !== 'ok' && ahead !== 'jump';
      if (blocked || this.freeDistance(ctx, hx, hz, look) < Infinity) {
        if (this.pickDetour(ctx, this.goalX, this.goalZ, look)) {
          hx = this.detourX;
          hz = this.detourZ;
        } else if (blocked) {
          speed = 0;
        }
      }
    }

    const targetYaw = speed > 0 ? Math.atan2(hx, hz) : (this.faceYaw ?? this.yaw);
    const maxTurn = this.turnRate * dt;
    this.yaw = angleDelta(0, this.yaw + clamp(angleDelta(this.yaw, targetYaw), -maxTurn, maxTurn));
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    let s = speed * Math.max(0, Math.cos(angleDelta(this.yaw, targetYaw))) * (this.swimming ? 0.45 : 1);
    if (s > 0) {
      const free = this.freeDistance(ctx, fx, fz, near + (s * s) / (2 * accel) + 1);
      if (free < Infinity) s = Math.min(s, Math.sqrt(2 * accel * Math.max(0, free - near)));
    }
    const v2 = vel.x * vel.x + vel.z * vel.z;
    if (v2 > 1) {
      const v = Math.sqrt(v2);
      if (this.freeDistance(ctx, vel.x / v, vel.z / v, near + v2 / (2 * accel) + 1) < Infinity) s = 0;
    }

    // Velocity approaches the wanted one at `accel` (isotropic, so braking distance is v² / 2a).
    let dvx = fx * s - vel.x;
    let dvz = fz * s - vel.z;
    const dv = Math.sqrt(dvx * dvx + dvz * dvz);
    const maxDv = accel * dt;
    if (dv > maxDv) {
      dvx *= maxDv / dv;
      dvz *= maxDv / dv;
    }
    vel.x += dvx;
    vel.z += dvz;
    vel.y -= GRAVITY * dt;
    if (wet > 0) {
      vel.y += GRAVITY * 1.7 * wet * dt; // buoyancy: floats about 60 % submerged
      vel.y *= Math.exp(-2.5 * dt);
    }

    const x0 = pos.x;
    const z0 = pos.z;
    this.move(ctx, vel.x * dt, vel.y * dt, vel.z * dt);
    pos.x = clamp(pos.x, MAP_MARGIN, WORLD_X - MAP_MARGIN);
    pos.z = clamp(pos.z, MAP_MARGIN, WORLD_Z - MAP_MARGIN);
    const mx = pos.x - x0;
    const mz = pos.z - z0;
    this.lastMoved = Math.sqrt(mx * mx + mz * mz);
    this.checkStuck(dt, s, hx, hz);
  }

  /** moveBody against voxels and solid entities (closed doors, crates). */
  private move(ctx: GameContext, dx: number, dy: number, dz: number): void {
    const p = this.position;
    const hw = this.halfWidth + 1;
    region.minX = p.x - hw - Math.abs(dx);
    region.maxX = p.x + hw + Math.abs(dx);
    region.minY = p.y - Math.abs(dy) - 1;
    region.maxY = p.y + this.height + Math.abs(dy) + MOB_STEP_HEIGHT + 1;
    region.minZ = p.z - hw - Math.abs(dz);
    region.maxZ = p.z + hw + Math.abs(dz);
    ctx.entities.solidBoxes(region, solids);
    moveBody(ctx.world, this, dx, dy, dz, moveOpts);
  }

  /** Classifies the ground `dist` ahead along (hx, hz); 'wall' also stands for the map edge and refused areas. */
  private probeAhead(ctx: GameContext, hx: number, hz: number, dist: number): ProbeKind {
    const x = this.position.x + hx * dist;
    const z = this.position.z + hz * dist;
    if (x < MAP_MARGIN || z < MAP_MARGIN || x > WORLD_X - MAP_MARGIN || z > WORLD_Z - MAP_MARGIN) return 'wall';
    if (this.allowedHere && !this.allowedAt(ctx, x, z)) return 'wall';
    const kind = probeGround(ctx.world, x, z, this.position.y, probe).kind;
    return kind === 'water' && this.swimming ? 'ok' : kind;
  }

  /**
   * Distance along (dx, dz) of the last passable sample before the first hazard, sampling up to
   * `samples` + 1 points from `halfWidth + 2` to `max`; Infinity if every sample is passable.
   */
  private freeDistance(ctx: GameContext, dx: number, dz: number, max: number, samples = 4): number {
    const near = this.halfWidth + 2;
    const n = max > near ? Math.min(samples, Math.ceil((max - near) / 4)) : 0;
    let good = 0;
    for (let i = 0; i <= n; i++) {
      const d = n === 0 ? near : near + ((max - near) * i) / n;
      const kind = this.probeAhead(ctx, dx, dz, d);
      if (kind !== 'ok' && kind !== 'jump') return good;
      good = d;
    }
    return Infinity;
  }

  /**
   * Tries headings increasingly far off (gx, gz), alternating sides, and takes the first one that is
   * passable up to `dist`. Recent detours keep their side, so a mob follows a long wall or shore
   * instead of dithering in front of it.
   */
  private pickDetour(ctx: GameContext, gx: number, gz: number, dist: number): boolean {
    const base = Math.atan2(gx, gz);
    const first = this.sideMemory > 0 ? this.detourSide : this.rng.chance(0.5) ? 1 : -1;
    const probeDist = Math.max(dist, this.halfWidth + 3);
    for (let i = 0; i < DETOUR_ANGLES.length; i++) {
      for (let k = 0; k < 2; k++) {
        const side = k === 0 ? first : -first;
        const a = base + side * DETOUR_ANGLES[i];
        if (this.freeDistance(ctx, Math.sin(a), Math.cos(a), probeDist, 1) === Infinity) {
          this.setDetour(a, this.rng.range(0.7, 1.3), side);
          return true;
        }
      }
    }
    return false;
  }

  private setDetour(yaw: number, seconds: number, side: number): void {
    this.detourX = Math.sin(yaw);
    this.detourZ = Math.cos(yaw);
    this.detourTime = seconds;
    this.detourSide = side;
    this.sideMemory = seconds + 2;
  }

  private jump(rise: number): void {
    this.velocity.y = Math.sqrt(2 * GRAVITY * (rise + 1.5));
    this.onGround = false;
    this.jumpCooldown = 0.6;
  }

  /** Wanting to move but hardly moving (wedged against something the probes missed) → turn away for a while. */
  private checkStuck(dt: number, speed: number, hx: number, hz: number): void {
    const expected = speed * dt;
    if (expected > 0.05 && this.lastMoved < expected * 0.3) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt);
    if (this.stuckTime < 0.6) return;
    this.stuckTime = 0;
    const side = this.sideMemory > 0 ? this.detourSide : this.rng.chance(0.5) ? 1 : -1;
    this.setDetour(Math.atan2(hx, hz) + side * this.rng.range(Math.PI / 2, Math.PI), this.rng.range(1, 2), side);
  }

  /** Diagonal leg pairs swing with ground speed; the amplitude eases in and out. */
  private animateGait(dt: number): void {
    const v = this.velocity;
    const speed = this.onGround ? Math.sqrt(v.x * v.x + v.z * v.z) : 0;
    this.gaitAmp += (clamp(speed / this.gaitFullSpeed, 0, 1) - this.gaitAmp) * damp(8, dt);
    this.gaitPhase = (this.gaitPhase + (speed * dt * TAU) / this.stride) % TAU;
    const swing = Math.sin(this.gaitPhase) * this.gaitAmp * MAX_LEG_SWING;
    if (this.legFL) this.legFL.rotation.x = swing;
    if (this.legBR) this.legBR.rotation.x = swing;
    if (this.legFR) this.legFR.rotation.x = -swing;
    if (this.legBL) this.legBL.rotation.x = -swing;
  }

  private updateFlash(dt: number): void {
    if (this.flash <= 0 || !this.flashColor) return;
    this.flash = Math.max(0, this.flash - dt / FLASH_S);
    const f = this.flash;
    const b = this.baseEmissive;
    this.flashColor.setRGB(b.r + 0.8 * f, b.g + 0.05 * f, b.b + 0.05 * f);
  }

  private die(ctx: GameContext, hit: HitInfo): void {
    this.dead = true;
    this.displayName = '';
    this.stand();
    this.deathTime = 0;
    // Fall towards the side the blow pushes to: local +X is (cos yaw, 0, −sin yaw); a positive roll tips towards −X.
    const push = hit.dir.x * Math.cos(this.yaw) - hit.dir.z * Math.sin(this.yaw);
    this.deathSide = push > 0 ? -1 : 1;
    const p = this.position;
    for (const entry of this.loot) {
      const a = this.rng.range(0, TAU);
      ctx.entities.add(
        new ItemDrop(entry.item, entry.count, { x: p.x, y: p.y + this.height * 0.5, z: p.z }, { x: Math.sin(a) * 10, y: 16, z: Math.cos(a) * 10 }),
      );
    }
    this.onDeath(ctx);
  }

  /** Rolls onto its side, lies still, sinks into the ground and is removed. */
  private updateCorpse(dt: number, ctx: GameContext): void {
    this.deathTime += dt;
    const sink = (this.deathTime - CORPSE_STAY_S) / CORPSE_SINK_S;
    if (sink >= 1) {
      ctx.entities.remove(this);
      return;
    }
    const roll = smoothstep(0, 0.6, this.deathTime) * (Math.PI / 2);
    this.rig.rotation.set(0, 0, roll * this.deathSide);
    // Lifted by half the body width so the side, not the spine, rests on the ground.
    const lift = (this.rigWidth / 2) * Math.sin(roll) - Math.max(0, sink) * (this.rigWidth + 2);
    this.rig.position.set(0, lift, 0);
    const v = this.velocity;
    const friction = Math.exp(-6 * dt);
    v.x *= friction;
    v.z *= friction;
    v.y -= GRAVITY * dt;
    this.move(ctx, v.x * dt, v.y * dt, v.z * dt);
    this.animateGait(dt);
    this.updateFlash(dt);
  }
}
