/**
 * Placed campfire. OWNER: agent "entities".
 * Model from getCampfireGeometry(); burns forever (PoC): ctx.particles.fire() every frame, a crackle
 * loop via ctx.audio.startLoop('fire') with distance-based volume, and a pooled light
 * ctx.renderer.lights.acquire('campfire') held only while the player is within ~25 m (released
 * beyond, re-acquired when back; may be null). Not solid. Hint «Рядом можно жарить мясо (Tab) · E — забрать»
 * under the HUD title «Костёр»: E picks it back up into the inventory (item 'campfire'). onRemove releases the
 * light and the loop. If the ground under it is dug away, it drops onto the next floor.
 */
import * as THREE from 'three';
import { GRAVITY } from '../../config';
import type { Vec3Like } from '../../core/math';
import { getCampfireGeometry } from '../../render/models';
import type { PointLightHandle } from '../../render/renderer';
import { getModelMaterial } from '../../render/voxelModel';
import type { LoopHandle } from '../audio';
import type { GameContext } from '../context';
import { aabbHitsWorld, makeAABB, moveBody, type Body } from '../physics';
import { Entity } from './entity';
import { giveToPlayer } from './itemDrop';

/** The pooled light is taken within LIGHT_ON (25 m) and given back beyond LIGHT_OFF. */
const LIGHT_ON = 250;
const LIGHT_OFF = 270;
/** Retry interval when the light pool is exhausted (s). */
const LIGHT_RETRY_S = 1;
/** Flames are not emitted farther away than this (100 m). */
const FLAMES_MAX_DIST = 1000;
/** The crackle fades out completely at this distance (20 m). */
const SOUND_RANGE = 200;
/** Flame base and light height above the ground (world units). */
const FLAME_Y = 0.6;
const LIGHT_Y = 3;
const SUPPORT_CHECK_S = 0.5;
/** The stones and logs are not drawn beyond 60 m (the flames are particles and stay visible). */
const VIEW_DISTANCE = 600;

const below = makeAABB();

export class Campfire extends Entity implements Body {
  readonly type = 'campfire';
  onGround = true;

  private readonly flame = new THREE.Vector3();
  private light: PointLightHandle | null = null;
  private lightRetry = 0;
  private loop: LoopHandle | null = null;
  private volume = -1;
  private falling = false;
  private supportTimer = SUPPORT_CHECK_S;

  constructor(pos: Vec3Like) {
    super();
    this.position.set(pos.x, pos.y, pos.z);
    this.halfWidth = 3;
    this.height = 3;
    this.displayName = 'Костёр';
    this.viewDistance = VIEW_DISTANCE;
    const mesh = new THREE.Mesh(getCampfireGeometry(), getModelMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.object.add(mesh);
    this.syncFlame();
  }

  update(dt: number, ctx: GameContext): void {
    this.updateSupport(dt, ctx);
    const d = this.position.distanceTo(ctx.player.position);
    this.updateLight(dt, ctx, d);
    if (d < FLAMES_MAX_DIST) ctx.particles.fire(this.flame, dt);
    this.updateSound(ctx, d);
  }

  /** E: back into the inventory. */
  interact(ctx: GameContext): void {
    if (giveToPlayer(ctx, 'campfire', 1) > 0) {
      ctx.hud.toast('Инвентарь полон');
      return;
    }
    ctx.entities.remove(this);
  }

  hint(): string {
    return 'Рядом можно жарить мясо (Tab) · E — забрать';
  }

  onRemove(): void {
    this.light?.release();
    this.light = null;
    this.loop?.stop();
    this.loop = null;
  }

  private syncFlame(): void {
    this.flame.set(this.position.x, this.position.y + FLAME_Y, this.position.z);
  }

  private updateSupport(dt: number, ctx: GameContext): void {
    if (this.falling) {
      this.velocity.y -= GRAVITY * dt;
      moveBody(ctx.world, this, 0, this.velocity.y * dt, 0);
      if (this.onGround) {
        this.falling = false;
        this.velocity.y = 0;
      }
      this.syncFlame();
      this.loop?.setPosition(this.flame);
      return;
    }
    this.supportTimer -= dt;
    if (this.supportTimer > 0) return;
    this.supportTimer = SUPPORT_CHECK_S;
    const p = this.position;
    below.minX = p.x - this.halfWidth;
    below.maxX = p.x + this.halfWidth;
    below.minZ = p.z - this.halfWidth;
    below.maxZ = p.z + this.halfWidth;
    below.minY = p.y - 0.05;
    below.maxY = p.y;
    if (aabbHitsWorld(ctx.world, below)) return;
    this.falling = true;
    this.onGround = false;
  }

  private updateLight(dt: number, ctx: GameContext, d: number): void {
    if (this.light) {
      if (d > LIGHT_OFF) {
        this.light.release();
        this.light = null;
      } else {
        this.light.light.position.set(this.position.x, this.position.y + LIGHT_Y, this.position.z);
      }
      return;
    }
    this.lightRetry -= dt;
    if (d > LIGHT_ON || this.lightRetry > 0) return;
    this.light = ctx.renderer.lights.acquire('campfire');
    if (this.light) this.light.light.position.set(this.position.x, this.position.y + LIGHT_Y, this.position.z);
    else this.lightRetry = LIGHT_RETRY_S;
  }

  private updateSound(ctx: GameContext, d: number): void {
    const fade = Math.max(0, 1 - d / SOUND_RANGE);
    const v = fade * fade;
    if (!this.loop) {
      this.loop = ctx.audio.startLoop('fire', { pos: this.flame, volume: v });
      this.volume = v;
    } else if (Math.abs(v - this.volume) > 0.01) {
      this.loop.setVolume(v);
      this.volume = v;
    }
  }
}
