/**
 * Loot container (crate, cabinet, fridge, toolbox). OWNER: agent "entities".
 * Solid (box = model size rotated by facing; object.rotation.y = facing·π/2, model front = +Z).
 * E opens ctx.inventoryScreen.open(ctx, { title, inventory }) and animates the lid/door
 * (lid.rotation[lidAxis] = t·lidOpenAngle) while the screen is open; hint «E — открыть ящик»
 * (or «…шкаф», «…холодильник»), with «(пусто)» once it has been emptied.
 */
import * as THREE from 'three';
import { smoothstep } from '../../core/math';
import type { ContainerSpawn, ContainerStyle } from '../../gen/types';
import { getContainerModel } from '../../render/models';
import { getModelMaterial } from '../../render/voxelModel';
import type { GameContext } from '../context';
import { Inventory } from '../inventory';
import { ITEMS } from '../items';
import type { AABB } from '../physics';
import { Entity } from './entity';

/** Slots of every container inventory. */
export const CONTAINER_SLOTS = 12;
/** Seconds for the lid/door to open or close. */
const LID_TIME_S = 0.35;
/** Containers (mostly indoors) are not drawn beyond 60 m. */
const VIEW_DISTANCE = 600;

/** Inventory-screen titles and HUD names. */
export const CONTAINER_TITLES: Readonly<Record<ContainerStyle, string>> = {
  crate: 'Ящик',
  cabinet: 'Шкаф',
  fridge: 'Холодильник',
  toolbox: 'Ящик с инструментами',
};

const HINTS: Readonly<Record<ContainerStyle, string>> = {
  crate: 'E — открыть ящик',
  cabinet: 'E — открыть шкаф',
  fridge: 'E — открыть холодильник',
  toolbox: 'E — открыть ящик',
};
const HINTS_EMPTY: Readonly<Record<ContainerStyle, string>> = {
  crate: `${HINTS.crate} (пусто)`,
  cabinet: `${HINTS.cabinet} (пусто)`,
  fridge: `${HINTS.fridge} (пусто)`,
  toolbox: `${HINTS.toolbox} (пусто)`,
};

export class Container extends Entity {
  readonly type = 'container';
  readonly inventory: Inventory;
  /** Russian title for the inventory screen («Ящик», «Шкаф», …). */
  title = '';
  readonly style: ContainerStyle;

  /** Footprint half extents after turning the model to its facing. */
  private readonly halfX: number;
  private readonly halfZ: number;
  private readonly lid: THREE.Mesh | null = null;
  private readonly lidAxis: 'x' | 'y';
  private readonly lidOpenAngle: number;
  /** Lid opening amount 0 … 1 (eased when applied). */
  private t = 0;
  /** The inventory screen currently shows this container. */
  private viewing = false;

  constructor(spawn: ContainerSpawn) {
    super();
    this.inventory = new Inventory(CONTAINER_SLOTS);
    this.style = spawn.style;
    this.title = CONTAINER_TITLES[spawn.style];
    this.displayName = this.title;
    this.position.set(spawn.x, spawn.y, spawn.z);
    this.solid = true;
    this.viewDistance = VIEW_DISTANCE;
    for (const entry of spawn.loot) {
      if (!ITEMS[entry.item] || entry.count <= 0) {
        console.warn(`[entities] container loot skipped: ${entry.count} × «${entry.item}»`);
        continue;
      }
      const left = this.inventory.add(entry.item, entry.count);
      if (left > 0) console.warn(`[entities] ${spawn.style} at ${spawn.x},${spawn.y},${spawn.z} is full: ${left} × ${entry.item} not added`);
    }

    const model = getContainerModel(spawn.style);
    const [w, h, d] = model.size;
    const quarterTurn = spawn.facing % 2 === 1;
    this.halfX = (quarterTurn ? d : w) / 2;
    this.halfZ = (quarterTurn ? w : d) / 2;
    this.halfWidth = Math.max(this.halfX, this.halfZ);
    this.height = h;
    this.lidAxis = model.lidAxis;
    this.lidOpenAngle = model.lidOpenAngle;
    this.object.rotation.y = (spawn.facing * Math.PI) / 2;

    const material = getModelMaterial();
    const body = new THREE.Mesh(model.body, material);
    body.castShadow = true;
    body.receiveShadow = true;
    this.object.add(body);
    if (model.lid) {
      const lid = new THREE.Mesh(model.lid, material);
      lid.position.set(model.lidPivot[0], model.lidPivot[1], model.lidPivot[2]);
      lid.castShadow = true;
      lid.receiveShadow = true;
      this.object.add(lid);
      this.lid = lid;
    }
  }

  update(dt: number, ctx: GameContext): void {
    if (this.viewing && !ctx.inventoryScreen.isOpen) this.viewing = false;
    const target = this.viewing ? 1 : 0;
    if (this.t === target) return;
    const step = dt / LID_TIME_S;
    this.t = target > this.t ? Math.min(1, this.t + step) : Math.max(0, this.t - step);
    if (this.lid) this.lid.rotation[this.lidAxis] = smoothstep(0, 1, this.t) * this.lidOpenAngle;
    if (this.t === 0) ctx.audio.play('door_close', { pos: this.position, volume: 0.6 });
  }

  interact(ctx: GameContext): void {
    if (ctx.inventoryScreen.isOpen) return;
    ctx.inventoryScreen.open(ctx, { title: this.title, inventory: this.inventory });
    this.viewing = true;
    ctx.audio.play('container_open', { pos: this.position });
  }

  hint(): string {
    return (this.isEmpty() ? HINTS_EMPTY : HINTS)[this.style];
  }

  /** Solid box: the model footprint turned to the facing, from the floor up. */
  getBounds(out: AABB): AABB {
    const p = this.position;
    out.minX = p.x - this.halfX;
    out.maxX = p.x + this.halfX;
    out.minY = p.y;
    out.maxY = p.y + this.height;
    out.minZ = p.z - this.halfZ;
    out.maxZ = p.z + this.halfZ;
    return out;
  }

  isEmpty(): boolean {
    const slots = this.inventory.slots;
    for (let i = 0; i < slots.length; i++) if (slots[i] !== null) return false;
    return true;
  }
}
