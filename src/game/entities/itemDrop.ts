/**
 * A loose item stack lying in the world. OWNER: agent "entities".
 * Falls with gravity (small box, physics.moveBody), slides to rest, then slowly spins/bobs.
 * E picks it up (hint «E — подобрать»; the HUD title is the item name); auto-collected when the
 * player is within GAMEPLAY.autoPickupRadius after GAMEPLAY.autoPickupDelayS. A resting drop merges
 * into an identical resting drop within 1 unit. Whatever does not fit into the inventory stays.
 */
import * as THREE from 'three';
import { GAMEPLAY, GRAVITY, WORLD_X, WORLD_Z } from '../../config';
import { clamp, damp, TAU, type Vec3Like } from '../../core/math';
import { getItemGeometry } from '../../render/models';
import { getModelMaterial } from '../../render/voxelModel';
import type { WorldData } from '../../world/world';
import type { GameContext } from '../context';
import { ITEMS } from '../items';
import { aabbHitsWorld, bodyAABB, makeAABB, moveBody, waterFraction, type AABB, type Body, type MoveOptions } from '../physics';
import { Entity } from './entity';

/** Physics box of a drop (world units). */
const BODY_HALF_WIDTH = 0.6;
const BODY_HEIGHT = 1.2;
/** Identical resting drops closer than this merge into one stack. */
const MERGE_RADIUS = 1;
/** Height of the hovering mesh above the ground at rest, plus the bob amplitude. */
const HOVER = 0.3;
const BOB = 0.25;
/** Horizontal velocity decay rates (1/s). */
const GROUND_FRICTION = 10;
const AIR_DRAG = 0.3;
const WATER_DRAG = 3;
/** Below this horizontal speed a drop lying on the ground comes to rest. */
const REST_SPEED = 0.6;
/** How often a resting drop checks that its support still exists (s). */
const SUPPORT_CHECK_S = 0.25;
/** After a failed auto-pickup (inventory full) wait this long before trying again (s). */
const FULL_RETRY_S = 1.5;
/** Long items (tools, sticks) lie flat; anything taller than this and clearly elongated is laid down. */
const LAY_FLAT_MIN_HEIGHT = 1.5;
/** Smallest picking box (half width / height) so tiny items stay easy to target. */
const MIN_PICK = 1.5;
/** Drops are not drawn beyond 50 m (a few pixels at most). */
const VIEW_DISTANCE = 500;

const box = makeAABB();
const region = makeAABB();
const solids: AABB[] = [];
const moveOpts: MoveOptions = { solids };
const near: Entity[] = [];
const tmpBox3 = new THREE.Box3();

/** Toast text for picking up `count` of an item, name first (no numeral agreement needed): «Яблоко +3», «Земля +25 дм³». */
export function pickupText(itemId: string, count: number): string {
  const def = ITEMS[itemId];
  const name = def?.name ?? itemId;
  return def?.unit === 'дм³' ? `${name} +${count} дм³` : `${name} +${count}`;
}

/** «3 шт.» / «25 дм³». */
function amountText(itemId: string, count: number): string {
  return `${count} ${ITEMS[itemId]?.unit ?? 'шт.'}`;
}

/**
 * Adds items to the player's inventory with the 'pickup' sound and a toast for what fit.
 * Returns the count that did not fit.
 */
export function giveToPlayer(ctx: GameContext, itemId: string, count: number): number {
  const left = ctx.inventory.add(itemId, count);
  const taken = count - left;
  if (taken > 0) {
    ctx.audio.play('pickup');
    ctx.hud.toast(pickupText(itemId, taken));
  }
  return left;
}

export class ItemDrop extends Entity implements Body {
  readonly type = 'item';
  itemId: string;
  count: number;
  onGround = false;
  /** Lying still: physics is paused until the support under it disappears. */
  resting = false;
  /** Seconds since the drop appeared (auto-pickup waits GAMEPLAY.autoPickupDelayS). */
  age = 0;

  /** Spins and bobs; holds the item mesh laid out around its spin axis. */
  private readonly spinner = new THREE.Group();
  private readonly spinSpeed: number;
  private readonly pickHalfWidth: number;
  private readonly pickHeight: number;
  private spin = Math.random() * TAU;
  private bobPhase = Math.random() * TAU;
  /** 0 while flying … 1 at rest: blends the hover/bob in. */
  private hover = 0;
  private supportTimer = 0;
  private retryPickupAt = 0;
  private checkedEmbedded = false;
  /** hint() text, rebuilt only when the count changes. */
  private hintCount = -1;
  private hintText = '';

  constructor(itemId: string, count: number, pos: Vec3Like, vel?: Vec3Like) {
    super();
    this.itemId = itemId;
    this.count = count;
    this.position.set(pos.x, pos.y, pos.z);
    if (vel) this.velocity.set(vel.x, vel.y, vel.z);
    this.halfWidth = BODY_HALF_WIDTH;
    this.height = BODY_HEIGHT;
    this.displayName = ITEMS[itemId]?.name ?? itemId;
    this.viewDistance = VIEW_DISTANCE;

    const mesh = new THREE.Mesh(getItemGeometry(itemId), getModelMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const size = layOut(mesh);
    this.spinner.add(mesh);
    this.object.add(this.spinner);
    // Radius swept by the spinning mesh: long items turn slower so their tips never whirl.
    const sweep = Math.sqrt(size.x * size.x + size.z * size.z) / 2;
    this.spinSpeed = Math.min(1.6, 2 / Math.max(sweep, 0.5));
    this.pickHalfWidth = Math.max(MIN_PICK, sweep);
    this.pickHeight = Math.max(MIN_PICK, size.y + HOVER + BOB);
  }

  update(dt: number, ctx: GameContext): void {
    this.age += dt;
    if (this.resting) this.checkSupport(dt, ctx);
    else this.simulate(dt, ctx);
    if (this.removed) return;
    this.animate(dt);
    this.tryAutoPickup(ctx);
  }

  /** E: takes as much as fits into the inventory. */
  interact(ctx: GameContext): void {
    this.pickUp(ctx, true);
  }

  hint(): string {
    if (this.hintCount !== this.count) {
      this.hintCount = this.count;
      this.hintText = this.count > 1 ? `E — подобрать (${amountText(this.itemId, this.count)})` : 'E — подобрать';
    }
    return this.hintText;
  }

  /** Picking box: the circle swept by the spinning mesh (at least MIN_PICK), from the ground up. */
  getBounds(out: AABB): AABB {
    const p = this.position;
    out.minX = p.x - this.pickHalfWidth;
    out.maxX = p.x + this.pickHalfWidth;
    out.minY = p.y;
    out.maxY = p.y + this.pickHeight;
    out.minZ = p.z - this.pickHalfWidth;
    out.maxZ = p.z + this.pickHalfWidth;
    return out;
  }

  private simulate(dt: number, ctx: GameContext): void {
    const world = ctx.world;
    if (!this.checkedEmbedded) {
      this.checkedEmbedded = true;
      this.unbury(world);
    }
    const v = this.velocity;
    const wet = waterFraction(world, this);
    // Items sink slowly through water; on the ground they slide to a stop quickly.
    v.y -= GRAVITY * (wet > 0 ? 0.25 : 1) * dt;
    const decay = Math.exp(-(this.onGround ? GROUND_FRICTION : wet > 0 ? WATER_DRAG : AIR_DRAG) * dt);
    v.x *= decay;
    v.z *= decay;
    if (wet > 0) v.y *= Math.exp(-WATER_DRAG * dt);

    const dx = v.x * dt;
    const dy = v.y * dt;
    const dz = v.z * dt;
    const p = this.position;
    region.minX = p.x - BODY_HALF_WIDTH - Math.abs(dx) - 1;
    region.maxX = p.x + BODY_HALF_WIDTH + Math.abs(dx) + 1;
    region.minY = p.y - Math.abs(dy) - 1;
    region.maxY = p.y + BODY_HEIGHT + Math.abs(dy) + 1;
    region.minZ = p.z - BODY_HALF_WIDTH - Math.abs(dz) - 1;
    region.maxZ = p.z + BODY_HALF_WIDTH + Math.abs(dz) + 1;
    ctx.entities.solidBoxes(region, solids);
    moveBody(world, this, dx, dy, dz, moveOpts);
    p.x = clamp(p.x, 1, WORLD_X - 1);
    p.z = clamp(p.z, 1, WORLD_Z - 1);

    if (this.onGround && v.x * v.x + v.z * v.z < REST_SPEED * REST_SPEED) {
      v.set(0, 0, 0);
      this.resting = true;
      this.supportTimer = SUPPORT_CHECK_S;
      this.mergeIntoNeighbour(ctx);
    }
  }

  /** While resting: wake up when the ground under the drop is dug away; climb out of a block placed onto it. */
  private checkSupport(dt: number, ctx: GameContext): void {
    this.supportTimer -= dt;
    if (this.supportTimer > 0) return;
    this.supportTimer = SUPPORT_CHECK_S;
    const p = this.position;
    this.unbury(ctx.world);
    box.minX = p.x - BODY_HALF_WIDTH;
    box.maxX = p.x + BODY_HALF_WIDTH;
    box.minZ = p.z - BODY_HALF_WIDTH;
    box.maxZ = p.z + BODY_HALF_WIDTH;
    box.minY = p.y - 0.05;
    box.maxY = p.y;
    if (aabbHitsWorld(ctx.world, box) || ctx.entities.solidBoxes(box, solids).length > 0) return;
    this.resting = false;
    this.onGround = false;
  }

  /** Lifts the drop (≤ 3 voxels) out of solid voxels; a drop walled in on its sides stays where it is. */
  private unbury(world: WorldData): void {
    if (!aabbHitsWorld(world, bodyAABB(this, box))) return;
    const y0 = this.position.y;
    for (let i = 1; i <= 3; i++) {
      this.position.y = Math.floor(y0) + i;
      if (!aabbHitsWorld(world, bodyAABB(this, box))) return;
    }
    this.position.y = y0;
  }

  /** Joins an identical resting stack within MERGE_RADIUS (never beyond the item's max stack). */
  private mergeIntoNeighbour(ctx: GameContext): void {
    const maxStack = ITEMS[this.itemId]?.maxStack ?? 1;
    const list = ctx.entities.queryRadius(this.position, MERGE_RADIUS, near);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e === this || !(e instanceof ItemDrop) || !e.resting || e.itemId !== this.itemId) continue;
      if (e.count + this.count > maxStack) continue;
      e.count += this.count;
      // The merged stack inherits the younger pickup delay (a freshly thrown item is not grabbed back at once).
      e.age = Math.min(e.age, this.age);
      this.count = 0;
      ctx.entities.remove(this);
      return;
    }
  }

  private animate(dt: number): void {
    this.spin = (this.spin + this.spinSpeed * dt) % TAU;
    this.bobPhase = (this.bobPhase + 2.2 * dt) % TAU;
    this.hover += ((this.resting ? 1 : 0) - this.hover) * damp(4, dt);
    this.spinner.rotation.y = this.spin;
    this.spinner.position.y = this.hover * (HOVER + BOB * (0.5 + 0.5 * Math.sin(this.bobPhase)));
  }

  private tryAutoPickup(ctx: GameContext): void {
    if (this.age < GAMEPLAY.autoPickupDelayS || this.age < this.retryPickupAt || ctx.input.uiOpen) return;
    if (this.playerWithin(ctx, GAMEPLAY.autoPickupRadius)) this.pickUp(ctx, false);
  }

  /** Distance from the drop to the player's body (a vertical segment from the feet to the head). */
  private playerWithin(ctx: GameContext, r: number): boolean {
    const player = ctx.player;
    const p = this.position;
    const pp = player.position;
    const dx = pp.x - p.x;
    const dz = pp.z - p.z;
    const top = pp.y + player.height;
    const dy = p.y < pp.y ? pp.y - p.y : p.y > top ? p.y - top : 0;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  private pickUp(ctx: GameContext, manual: boolean): void {
    if (this.removed || this.count <= 0) return;
    const left = giveToPlayer(ctx, this.itemId, this.count);
    if (left <= 0) {
      this.count = 0;
      ctx.entities.remove(this);
      return;
    }
    if (manual && left === this.count) ctx.hud.toast('Инвентарь полон');
    this.count = left;
    this.retryPickupAt = this.age + FULL_RETRY_S;
  }
}

/**
 * Lays an item mesh out around the drop's spin axis: elongated items lie flat, the bounding box is
 * centred on the axis and rests on y = 0. Returns the laid-out size.
 */
function layOut(mesh: THREE.Mesh): THREE.Vector3 {
  const geo = mesh.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const b = tmpBox3.copy(geo.boundingBox!);
  const sx = b.max.x - b.min.x;
  const sy = b.max.y - b.min.y;
  const sz = b.max.z - b.min.z;
  if (sy > LAY_FLAT_MIN_HEIGHT && sy > 1.4 * Math.max(sx, sz)) {
    mesh.rotation.z = Math.PI / 2;
    mesh.updateMatrix();
    b.applyMatrix4(mesh.matrix);
  }
  mesh.position.set(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  return b.getSize(new THREE.Vector3());
}
