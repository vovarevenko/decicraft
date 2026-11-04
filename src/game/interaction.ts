/**
 * Player ↔ world interaction. OWNER: agent "interaction". See ARCHITECTURE.md §11. Handles (only when
 * ctx.input.active): targeting (voxels incl. tall plants + entities, reach PLAYER.reach), LMB
 * break/hit (digging on through item drops), RMB place/use, E interact, Q drop, [ ] place size, R precise mode, held lights (flashlight
 * via lights.setFlashlight, torch via lights.acquire('torch')), HUD target/progress updates, view-model
 * swings, sounds and particles, structural collapse → FallingBody (worked out in the felling worker; its answers
 * are applied first thing every frame, also while a UI screen is open), simple water flow into dug cells.
 * One-shot inputs (E, Q, R, [, ], RMB uses such as eat/read/toggle/place-campfire) are read with
 * input.consume()/consumeMouse(); held LMB/RMB repeat via mouseDown().
 *
 * Held lights follow the selected item every frame, also while a UI screen is open. The pure parts live in
 * game/interaction/: breaking.ts (§11.1), placement.ts (§11.2), collapse.ts + felling.ts + water.ts (§11.3),
 * targeting.ts.
 */
import * as THREE from 'three';
import { GAMEPLAY } from '../config';
import type { Vec3Like } from '../core/math';
import type { PointLightHandle } from '../render/renderer';
import type { SwingKind } from '../render/viewModel';
import { B, HARDNESS, SOLID, blockName, isPlant } from '../world/blocks';
import type { VoxelHit } from '../world/raycast';
import type { WorldData } from '../world/world';
import type { SoundName } from './audio';
import type { GameContext } from './context';
import { Campfire } from './entities/campfire';
import type { Entity } from './entities/entity';
import { ItemDrop } from './entities/itemDrop';
import { BREAK_SOUND, brushRadius, clearVoxels, collectBrush, isBreakable, swingPower, tallyDrops } from './interaction/breaking';
import { Aftermath } from './interaction/collapse';
import { fellingFor } from './interaction/felling';
import { MAX_PLACE_SIZE, cellsBounds, filterPlaceable, placementCells, type FaceHit } from './interaction/placement';
import { TargetPicker, blockHint } from './interaction/targeting';
import { VoxelList } from './interaction/voxelList';
import { HAND, ITEMS, type ItemDef, type ToolStats } from './items';
import { bodyAABB, makeAABB, type AABB } from './physics';

export type Target =
  | { kind: 'block'; hit: VoxelHit }
  | { kind: 'entity'; entity: Entity; distance: number };

/** Seconds between placements while RMB is held. */
const PLACE_REPEAT_S = 0.2;
/** At most this many removed voxels emit debris per swing… */
const MAX_DEBRIS_VOXELS = 40;
/** …sharing roughly this many particles. */
const DEBRIS_PER_SWING = 80;
/** A swing that does not break its voxel yet: a few chips and a softer sound. */
const KNOCK_DEBRIS = 3;
const KNOCK_VOLUME = 0.45;
/** Breaking glass startles animals this far away (world units). */
const GLASS_NOISE_RADIUS = 150;
/** Damage is compared with float32 hardness: falling short by less than this still breaks the voxel. */
const DAMAGE_EPSILON = 1e-4;
/** Thrown item drops leave the hand this far ahead of and below the eye (world units)… */
const THROW_FROM = 3;
/** …with this speed along the view direction plus this lift (world units/s). */
const THROW_SPEED = 22;
const THROW_LIFT = 8;
/** Plants within this radius (voxels) around a new campfire are trampled. */
const CAMPFIRE_CLEARING = 3;
/** «Инвентарь полон» when dug material is left lying, at most this often (s). */
const FULL_TOAST_S = 3;
/** Held torch light relative to the eye: forward, right, down (world units). */
const TORCH_FORWARD = 3;
const TORCH_RIGHT = 2.5;
const TORCH_DOWN = 2;

export class Interaction {
  /** What the crosshair points at (updated every frame). */
  target: Target | null = null;
  /** Cube edge (voxels) for placing materials; one of GAMEPLAY.placeSizes. */
  placeSize = 1;
  /** Precise mode: tools break a single voxel. */
  precise = false;
  /** Flashlight switched on (only shines while the flashlight is the selected item). */
  flashlightOn = false;

  private readonly picker = new TargetPicker();
  private readonly aftermath = new Aftermath();
  private readonly removed = new VoxelList(512);
  private readonly drops = new Map<string, number>();
  private readonly cells = new Int32Array(MAX_PLACE_SIZE ** 3 * 3);
  private readonly region = makeAABB();
  private readonly playerBox = makeAABB();
  private readonly blockers: AABB[] = [];
  private readonly face: FaceHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };
  private readonly normal = { x: 0, y: 0, z: 0 };
  private readonly look = new THREE.Vector3();
  private swingTimer = 0;
  private placeTimer = 0;
  private fullToastTimer = 0;
  /** Swing power accumulated on voxel (damagedX, damagedY, damagedZ) holding block damagedId (-1: none). */
  private damage = 0;
  private damagedX = 0;
  private damagedY = 0;
  private damagedZ = 0;
  private damagedId = -1;
  private torch: PointLightHandle | null = null;
  /** What the HUD currently shows (undefined: nothing sent yet). */
  private shownTitle: string | null | undefined = undefined;
  private shownHint: string | null = null;
  private shownProgress: number | null | undefined = undefined;
  /** Block hint cache and its inputs. */
  private hintId = -1;
  private hintStats: ToolStats | null = null;
  private hintItem: ItemDef | null = null;
  private hintCampfire = false;
  private hintText = '';

  update(dt: number, ctx: GameContext): void {
    // What the felling worker found came loose goes first, whatever the input state (it also keeps the worker warm).
    this.aftermath.update(ctx);
    this.swingTimer = Math.max(0, this.swingTimer - dt);
    this.placeTimer = Math.max(0, this.placeTimer - dt);
    this.fullToastTimer = Math.max(0, this.fullToastTimer - dt);
    this.updateHeldLights(ctx, selectedItem(ctx));
    if (ctx.input.active) {
      this.target = this.picker.pick(ctx);
      this.trackDamage();
      this.handleKeys(ctx);
    }
    // A key may have opened a screen (E on a container): from then on this frame's input is not ours.
    if (!ctx.input.active) {
      this.target = null;
      this.trackDamage();
      this.showTarget(ctx, null, null);
      this.showProgress(ctx, null);
      return;
    }
    const item = selectedItem(ctx);
    const stats = item?.tool ?? HAND;
    this.handleUse(ctx, item);
    this.handleSwing(ctx, stats);
    this.refreshHud(ctx, stats, item);
  }

  // ---------------------------------------------------------------- held lights

  private updateHeldLights(ctx: GameContext, item: ItemDef | null): void {
    const lights = ctx.renderer.lights;
    const kind = item?.light?.kind;
    lights.setFlashlight(this.flashlightOn && kind === 'flashlight');
    if (kind !== 'torch') {
      this.torch?.release();
      this.torch = null;
      return;
    }
    this.torch ??= lights.acquire('torch');
    if (this.torch === null) return; // every pooled light is busy: try again next frame
    const { eye, yaw } = ctx.player;
    const d = ctx.player.getLookDir(this.look);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    this.torch.light.position.set(
      eye.x + d.x * TORCH_FORWARD + rightX * TORCH_RIGHT,
      eye.y + d.y * TORCH_FORWARD - TORCH_DOWN,
      eye.z + d.z * TORCH_FORWARD + rightZ * TORCH_RIGHT,
    );
  }

  // ---------------------------------------------------------------- one-shot keys

  private handleKeys(ctx: GameContext): void {
    const { input } = ctx;
    const t = this.target;
    if (t?.kind === 'entity' && t.entity.interact && input.consume('KeyE')) t.entity.interact(ctx);
    if (input.consume('KeyQ')) this.dropSelected(ctx, input.isDown('ShiftLeft') || input.isDown('ShiftRight'));
    if (input.consume('BracketLeft')) this.stepPlaceSize(ctx, -1);
    if (input.consume('BracketRight')) this.stepPlaceSize(ctx, 1);
    if (input.consume('KeyR')) {
      this.precise = !this.precise;
      ctx.hud.toast(this.precise ? 'Точный режим: включён' : 'Точный режим: выключен');
    }
  }

  /** Throws one item (or the whole stack) of the selected slot forward as an ItemDrop. */
  private dropSelected(ctx: GameContext, wholeStack: boolean): void {
    const inv = ctx.inventory;
    const stack = inv.selectedStack();
    if (stack === null) return;
    const taken = inv.takeFromSlot(inv.selected, wholeStack ? stack.count : 1);
    if (taken === null || taken.count <= 0) return;
    const { eye } = ctx.player;
    const d = ctx.player.getLookDir(this.look);
    const pos = { x: eye.x + d.x * THROW_FROM, y: eye.y + d.y * THROW_FROM - THROW_FROM, z: eye.z + d.z * THROW_FROM };
    if (ctx.world.isSolidAt(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))) {
      // Facing a wall up close: let go right under the eye instead of inside the wall.
      pos.x = eye.x;
      pos.y = eye.y - THROW_FROM;
      pos.z = eye.z;
    }
    const vel = { x: d.x * THROW_SPEED, y: d.y * THROW_SPEED + THROW_LIFT, z: d.z * THROW_SPEED };
    ctx.entities.add(new ItemDrop(taken.id, taken.count, pos, vel));
    ctx.audio.play('drop', { volume: 0.7 });
  }

  private stepPlaceSize(ctx: GameContext, step: number): void {
    const sizes = GAMEPLAY.placeSizes;
    const i = Math.max(0, sizes.indexOf(this.placeSize));
    const n = (this.placeSize = sizes[Math.max(0, Math.min(sizes.length - 1, i + step))]);
    ctx.hud.toast(`Размер блока: ${n}×${n}×${n}`);
  }

  // ---------------------------------------------------------------- RMB: place / use

  /** RMB with the selected item; tools and resources have no use. */
  private handleUse(ctx: GameContext, item: ItemDef | null): void {
    const { input } = ctx;
    if (item === null) return;
    switch (item.kind) {
      case 'material': {
        const pressed = input.consumeMouse(2);
        if ((pressed || input.mouseDown(2)) && this.placeTimer <= 0) this.placeMaterial(ctx, item);
        return;
      }
      case 'food':
        if (input.consumeMouse(2)) this.eat(ctx, item);
        return;
      case 'light':
        if (item.light?.kind === 'flashlight' && input.consumeMouse(2)) {
          this.flashlightOn = !this.flashlightOn;
          ctx.audio.play('flashlight', { volume: 0.6 });
          ctx.viewModel.swing('use');
        }
        return;
      case 'placeable':
        if (item.placeEntity === 'campfire' && input.consumeMouse(2)) this.placeCampfire(ctx);
        return;
      case 'note':
        if (item.note && input.consumeMouse(2)) {
          ctx.hud.showNote(ctx, item.note.title, item.note.text);
          ctx.audio.play('paper');
        }
        return;
    }
  }

  /** Fills the placement cube (nearest cells first) with as many voxels as the inventory holds. */
  private placeMaterial(ctx: GameContext, item: ItemDef): void {
    const t = this.target;
    if (t?.kind !== 'block' || item.block === undefined) return;
    const cells = this.cells;
    let n = placementCells(this.faceOf(t.hit), this.placeSize, isPlant(t.hit.id), cells);
    if (n === 0) return;
    const blockers = ctx.entities.solidBoxes(cellsBounds(cells, n, this.region), this.blockers);
    blockers.push(bodyAABB(ctx.player, this.playerBox));
    n = Math.min(filterPlaceable(ctx.world, cells, n, blockers), ctx.inventory.count(item.id));
    if (n <= 0) return;
    for (let i = 0; i < n; i++) ctx.world.setBlock(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2], item.block);
    ctx.inventory.remove(item.id, n);
    this.placeTimer = PLACE_REPEAT_S;
    ctx.audio.play('place', { pos: { x: cells[0] + 0.5, y: cells[1] + 0.5, z: cells[2] + 0.5 } });
    ctx.viewModel.swing('place');
  }

  /** The hit as a clicked face; a hit from inside its voxel (no normal) uses the face turned towards the viewer. */
  private faceOf(hit: VoxelHit): FaceHit {
    if (hit.nx !== 0 || hit.ny !== 0 || hit.nz !== 0) return hit;
    const f = this.face;
    const d = this.picker.dir;
    f.x = hit.x;
    f.y = hit.y;
    f.z = hit.z;
    f.px = hit.px;
    f.py = hit.py;
    f.pz = hit.pz;
    f.nx = f.ny = f.nz = 0;
    const ax = Math.abs(d.x);
    const ay = Math.abs(d.y);
    const az = Math.abs(d.z);
    if (ax >= ay && ax >= az) f.nx = d.x > 0 ? -1 : 1;
    else if (ay >= az) f.ny = d.y > 0 ? -1 : 1;
    else f.nz = d.z > 0 ? -1 : 1;
    return f;
  }

  private eat(ctx: GameContext, item: ItemDef): void {
    if (item.food === undefined || ctx.inventory.takeFromSlot(ctx.inventory.selected, 1) === null) return;
    ctx.hud.toast(item.food.message);
    ctx.audio.play('eat');
    ctx.viewModel.swing('eat');
  }

  private placeCampfire(ctx: GameContext): void {
    const t = this.target;
    const base = t?.kind === 'block' ? campfireBase(ctx.world, t.hit) : -1;
    if (t?.kind !== 'block' || base < 0) {
      ctx.hud.toast('Костёр ставится на землю');
      return;
    }
    const inv = ctx.inventory;
    if (inv.takeFromSlot(inv.selected, 1) === null) return;
    const h = t.hit;
    const x = Math.min(h.x + 0.8, Math.max(h.x + 0.2, h.px));
    const z = Math.min(h.z + 0.8, Math.max(h.z + 0.2, h.pz));
    tramplePlants(ctx, Math.floor(x), base, Math.floor(z));
    ctx.entities.add(new Campfire({ x, y: base, z }));
    ctx.audio.play('place', { pos: { x, y: base, z } });
    ctx.viewModel.swing('place');
  }

  // ---------------------------------------------------------------- LMB: break / hit

  /**
   * The voxel LMB works on: the targeted block, or the one right behind a targeted item drop — drops can't be
   * hit, so one lying in the hole (dug material that did not fit) never stops the digging.
   */
  private swingVoxel(): VoxelHit | null {
    const t = this.target;
    if (t?.kind === 'block') return t.hit;
    return t?.kind === 'entity' && t.entity.type === 'item' ? this.picker.behind : null;
  }

  /** Damage belongs to one voxel: it resets whenever the swung-at voxel changes. */
  private trackDamage(): void {
    const h = this.swingVoxel();
    if (h === null) {
      this.damage = 0;
      this.damagedId = -1;
      return;
    }
    if (h.id === this.damagedId && h.x === this.damagedX && h.y === this.damagedY && h.z === this.damagedZ) return;
    this.damage = 0;
    this.damagedId = h.id;
    this.damagedX = h.x;
    this.damagedY = h.y;
    this.damagedZ = h.z;
  }

  /** First swing as soon as LMB goes down, then one every stats.swingTime while it is held (also at air). */
  private handleSwing(ctx: GameContext, stats: ToolStats): void {
    const { input } = ctx;
    if (this.swingTimer > 0 || !(input.mouseDown(0) || input.mousePressed(0))) return;
    this.swingTimer = stats.swingTime;
    ctx.viewModel.swing(swingKind(stats));
    const t = this.target;
    const voxel = this.swingVoxel();
    if (voxel !== null) this.hitBlock(ctx, voxel, stats);
    else if (t?.kind === 'entity' && t.entity.onHit) this.hitEntity(ctx, t.entity, stats);
    else ctx.audio.play('swing', { volume: 0.5 });
  }

  private hitEntity(ctx: GameContext, entity: Entity, stats: ToolStats): void {
    // HitInfo.dir may be kept by the entity (knockback), so it gets its own vector.
    entity.onHit?.(ctx, { damage: stats.damage, dir: this.picker.dir.clone(), tool: stats.type });
    const { position } = entity;
    ctx.audio.play('hit_mob', { pos: { x: position.x, y: position.y + entity.height / 2, z: position.z } });
  }

  private hitBlock(ctx: GameContext, hit: VoxelHit, stats: ToolStats): void {
    const id = hit.id;
    if (!isBreakable(id)) {
      ctx.audio.play('swing', { volume: 0.5 });
      return;
    }
    this.normal.x = hit.nx;
    this.normal.y = hit.ny;
    this.normal.z = hit.nz;
    this.damage += swingPower(stats, id);
    if (this.damage < HARDNESS[id] - DAMAGE_EPSILON) {
      ctx.particles.blockBreak(hit.x, hit.y, hit.z, id, KNOCK_DEBRIS, this.normal);
      const sound = BREAK_SOUND[id];
      if (sound !== null) ctx.audio.play(sound, { pos: { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 }, volume: KNOCK_VOLUME });
      return;
    }
    this.damage = 0;
    this.breakTarget(ctx, hit, stats);
  }

  /**
   * Removes the brush around the broken voxel — never one a falling body still owns while it writes in slices — then
   * collects drops and lets the world settle (§11.1, §11.3).
   */
  private breakTarget(ctx: GameContext, hit: VoxelHit, stats: ToolStats): void {
    const removed = this.removed;
    removed.clear();
    collectBrush(ctx.world, hit.x, hit.y, hit.z, brushRadius(stats, hit.id, this.precise), removed, fellingFor(ctx.world).owned);
    clearVoxels(ctx.world, removed, 0, removed);
    const at = { x: hit.x + 0.5, y: hit.y + 0.5, z: hit.z + 0.5 };
    this.emitDebris(ctx);
    this.playBreakSounds(ctx, at);
    this.collectDrops(ctx, at);
    this.aftermath.settle(ctx, removed, ctx.player.position);
  }

  /** Debris from a capped, evenly spread subset of the removed voxels; glass shatters into more shards. */
  private emitDebris(ctx: GameContext): void {
    const { positions: p, ids, count } = this.removed;
    const shown = Math.min(count, MAX_DEBRIS_VOXELS);
    const each = Math.max(2, Math.min(10, Math.round(DEBRIS_PER_SWING / shown)));
    for (let k = 0; k < shown; k++) {
      const i = Math.floor((k * count) / shown);
      const id = ids[i];
      ctx.particles.blockBreak(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], id, id === B.GLASS ? each * 2 : each, this.normal);
    }
  }

  /** The broken voxel's sound plus up to two other materials that broke with it (e.g. leaves around a branch). */
  private playBreakSounds(ctx: GameContext, at: Vec3Like): void {
    const { ids, count } = this.removed;
    const sounds: SoundName[] = [];
    for (let i = 0; i < count && sounds.length < 3; i++) {
      const s = BREAK_SOUND[ids[i]];
      if (s !== null && !sounds.includes(s)) sounds.push(s);
    }
    for (const s of sounds) ctx.audio.play(s, { pos: at });
    if (sounds.includes('glass_break')) ctx.entities.emitNoise(ctx, at, GLASS_NOISE_RADIUS);
  }

  /** Drops go to the inventory; what does not fit lands as an ItemDrop in the broken voxel's cell (with a toast). */
  private collectDrops(ctx: GameContext, at: Vec3Like): void {
    const drops = this.drops;
    drops.clear();
    tallyDrops(this.removed, 0, drops);
    let full = false;
    for (const [item, count] of drops) {
      const left = ctx.inventory.add(item, count);
      if (left <= 0) continue;
      ctx.entities.add(new ItemDrop(item, left, { x: at.x, y: at.y - 0.4, z: at.z }));
      full = true;
    }
    if (full && this.fullToastTimer <= 0) {
      this.fullToastTimer = FULL_TOAST_S;
      ctx.hud.toast('Инвентарь полон');
    }
  }

  // ---------------------------------------------------------------- HUD

  private refreshHud(ctx: GameContext, stats: ToolStats, item: ItemDef | null): void {
    const t = this.target;
    if (t === null) {
      this.showTarget(ctx, null, null);
      this.showProgress(ctx, null);
    } else if (t.kind === 'entity') {
      this.showTarget(ctx, t.entity.displayName, t.entity.hint?.(ctx) ?? null);
      this.showProgress(ctx, this.breakProgress());
    } else {
      const { hit } = t;
      this.showTarget(ctx, blockName(hit.id), this.hintFor(ctx.world, hit, stats, item));
      this.showProgress(ctx, this.breakProgress());
    }
  }

  /** How far the swung-at voxel is broken (0 … 1), null while undamaged. */
  private breakProgress(): number | null {
    const h = this.swingVoxel();
    return h !== null && this.damage > 0 ? Math.min(1, this.damage / HARDNESS[h.id]) : null;
  }

  private hintFor(world: WorldData, hit: VoxelHit, stats: ToolStats, item: ItemDef | null): string {
    const campfire = item?.placeEntity === 'campfire' && campfireBase(world, hit) >= 0;
    if (hit.id !== this.hintId || stats !== this.hintStats || item !== this.hintItem || campfire !== this.hintCampfire) {
      this.hintId = hit.id;
      this.hintStats = stats;
      this.hintItem = item;
      this.hintCampfire = campfire;
      this.hintText = blockHint(hit.id, stats, item, campfire);
    }
    return this.hintText;
  }

  private showTarget(ctx: GameContext, title: string | null, hint: string | null): void {
    if (title === this.shownTitle && hint === this.shownHint) return;
    this.shownTitle = title;
    this.shownHint = hint;
    ctx.hud.setTarget(title === null ? null : hint === null ? { title } : { title, hint });
  }

  private showProgress(ctx: GameContext, progress: number | null): void {
    if (progress === this.shownProgress) return;
    this.shownProgress = progress;
    ctx.hud.setBreakProgress(progress);
  }
}

function selectedItem(ctx: GameContext): ItemDef | null {
  const stack = ctx.inventory.selectedStack();
  return stack === null ? null : (ITEMS[stack.id] ?? null);
}

const swingKind = (stats: ToolStats): SwingKind => (stats.type === 'shovel' ? 'dig' : stats.type === 'axe' ? 'chop' : 'swing');

/** y of the cell a campfire would stand in for this block target, or -1 where it cannot stand (needs solid ground). */
function campfireBase(world: WorldData, hit: VoxelHit): number {
  if (isPlant(hit.id)) return SOLID[world.getBlock(hit.x, hit.y - 1, hit.z)] === 1 ? hit.y : -1;
  if (hit.ny !== 1 || SOLID[hit.id] !== 1) return -1;
  const above = world.getBlock(hit.x, hit.y + 1, hit.z);
  return above === B.AIR || isPlant(above) ? hit.y + 1 : -1;
}

/** Removes plants in layer y within CAMPFIRE_CLEARING of (x, z) so they do not grow through the fire. */
function tramplePlants(ctx: GameContext, x: number, y: number, z: number): void {
  const r = CAMPFIRE_CLEARING;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz <= r * r && isPlant(ctx.world.getBlock(x + dx, y, z + dz))) ctx.world.setBlock(x + dx, y, z + dz, B.AIR);
    }
  }
}
