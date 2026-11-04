/**
 * Catalogue of centimetre-voxel models. OWNER: agent "art". All results are cached; callers must
 * not dispose returned geometries (nor mutate returned poses/models). Units: world units (1 cm model
 * voxel = 0.1 units). Everything is built lazily on first request.
 * Orientation conventions: tools/items are modelled pointing up (+Y) with the grip at the origin;
 * mobs face +Z (head towards +Z), origin at the ground between the feet.
 *
 * Model families live next to this file: tools.ts (tools and hand lights), items.ts (small items),
 * materials.ts (10 cm block cubes), campfire.ts, hand.ts (first-person hand + hold poses), doors.ts,
 * containers.ts, deer.ts and dog.ts (mob rigs, assembled by rig.ts).
 */
import type * as THREE from 'three';
import { ITEMS } from '../../game/items';
import type { ContainerStyle, DoorStyle, MobKind } from '../../gen/types';
import { buildCampfire } from './campfire';
import { CONTAINER_MODELS } from './containers';
import { buildDeerRig } from './deer';
import { buildDogRig } from './dog';
import { buildDoor } from './doors';
import { buildHand, holdPose } from './hand';
import { ITEM_MODELS } from './items';
import { buildMaterialCube } from './materials';
import { TOOL_MODELS } from './tools';

/** Builders of every item that is not a material cube (the campfire item: the fire laid, unlit, at 2 cm voxels). */
const ITEM_BUILDERS = new Map<string, () => THREE.BufferGeometry>([
  ...Object.entries(TOOL_MODELS),
  ...Object.entries(ITEM_MODELS),
  ['campfire', () => buildCampfire(false, 2)],
]);

const itemCache = new Map<string, THREE.BufferGeometry>();
const poseCache = new Map<string, HoldPose>();
const doorCache = new Map<string, THREE.BufferGeometry>();
const containerCache = new Map<ContainerStyle, ContainerModel>();
const rigCache = new Map<MobKind, MobRig>();
let hand: THREE.BufferGeometry | null = null;
let campfire: THREE.BufferGeometry | null = null;

function knownItem(itemId: string): boolean {
  return Object.hasOwn(ITEMS, itemId);
}

/**
 * Item model (any id from game/items.ts; materials → a 10 cm cube of that block, top colour on top).
 * Origin: grip (tools) or bottom centre. Throws for an unknown item id.
 */
export function getItemGeometry(itemId: string): THREE.BufferGeometry {
  let geometry = itemCache.get(itemId);
  if (geometry === undefined) {
    const build = ITEM_BUILDERS.get(itemId);
    const block = knownItem(itemId) ? ITEMS[itemId].block : undefined;
    if (build !== undefined) geometry = build();
    else if (block !== undefined) geometry = buildMaterialCube(block);
    else throw new Error(`No model for item "${itemId}"`);
    itemCache.set(itemId, geometry);
  }
  return geometry;
}

/** How the view model holds an item: offset (camera space, world units) and Euler rotation (radians). */
export interface HoldPose {
  /** Camera-space position of the model origin. */
  position: [number, number, number];
  /** Euler XYZ rotation of the model. */
  rotation: [number, number, number];
  scale: number;
  /**
   * Camera-space point the hand closes around (its fist's handle channel, getHandGeometry). Absent
   * when it is `position` itself: tools, sticks and stems, whose origin lies in the fist.
   */
  grip?: [number, number, number];
}

/**
 * Transform of the held item's mesh in view-model camera space (+X right, +Y up, −Z forward) for a
 * right hand turned like the view model's (slightly inwards and up) whose fist is at `grip`: tools
 * rise from the fist tilted forward with the blade ahead, the flashlight points forward, sticks and
 * stems are held at their lower end, food and blocks sit on top of it, papers and cloth hang from the
 * fingers towards the camera, large things are shrunk. Throws for an unknown item id.
 */
export function getItemHoldPose(itemId: string): HoldPose {
  let pose = poseCache.get(itemId);
  if (pose === undefined) {
    if (!knownItem(itemId)) throw new Error(`No hold pose for item "${itemId}"`);
    pose = holdPose(itemId);
    poseCache.set(itemId, pose);
  }
  return pose;
}

/**
 * First-person forearm + hand (sleeve + skin), origin at the wrist, pointing -Z (forward). Right hand,
 * palm towards −X, thumb up; the fist's handle channel runs along Y through (0, 0.15, −0.85) from the
 * wrist (the HoldPose grip goes there).
 */
export function getHandGeometry(): THREE.BufferGeometry {
  hand ??= buildHand();
  return hand;
}

/**
 * Door leaf for an opening of widthVox × heightVox world voxels: origin at the hinge edge, bottom,
 * centre of thickness; extends +X (width) and +Y (height); ~4 cm thick (centred on Z). The leaf's
 * bounding box is exactly width × height in X/Y; handles on both faces stick out along ±Z.
 */
export function getDoorGeometry(widthVox: number, heightVox: number, style: DoorStyle): THREE.BufferGeometry {
  const key = `${widthVox}x${heightVox}:${style}`;
  let geometry = doorCache.get(key);
  if (geometry === undefined) {
    geometry = buildDoor(widthVox, heightVox, style);
    doorCache.set(key, geometry);
  }
  return geometry;
}

export interface ContainerModel {
  body: THREE.BufferGeometry;
  /** Lid / door that opens (null if none). Modelled relative to `lidPivot`. */
  lid: THREE.BufferGeometry | null;
  /** Hinge position relative to the body origin (bottom centre), world units. */
  lidPivot: [number, number, number];
  /** Rotation axis of the lid: 'x' (crate lid flips up) or 'y' (cabinet/fridge door swings). */
  lidAxis: 'x' | 'y';
  /** Signed opening angle (radians): the entity sets lid.rotation[lidAxis] = t · lidOpenAngle for t ∈ [0, 1]. */
  lidOpenAngle: number;
  /** Outer size [w, h, d] in world units (for collision). Front faces +Z. */
  size: [number, number, number];
}

/** Container body + lid/door (crate, toolbox: lid hinged at the back; cabinet, fridge: front door). Throws for an unknown style. */
export function getContainerModel(style: ContainerStyle): ContainerModel {
  let model = containerCache.get(style);
  if (model === undefined) {
    if (!Object.hasOwn(CONTAINER_MODELS, style)) throw new Error(`No container model "${style}"`);
    model = CONTAINER_MODELS[style]();
    containerCache.set(style, model);
  }
  return model;
}

/** Campfire: stone ring + logs (no flames — particles do that). Origin bottom centre. */
export function getCampfireGeometry(): THREE.BufferGeometry {
  campfire ??= buildCampfire(true, 1);
  return campfire;
}

export interface MobRigPart {
  /** deer: body, neck, head, earL, earR, legFL, legFR, legBL, legBR, tail; dog: body, head, jaw, earL, earR, legFL, legFR, legBL, legBR, tail. */
  name: string;
  /** Geometry modelled relative to the part's own pivot (joint). */
  geometry: THREE.BufferGeometry;
  /** Pivot position relative to the parent's pivot (or to the rig origin for root parts), world units. */
  pivot: [number, number, number];
  parent: string | null;
}

export interface MobRig {
  parts: MobRigPart[];
  /** Approximate size in world units (for the collision box). */
  size: { width: number; height: number; length: number };
}

/**
 * Mob rig in its rest pose (parents listed before children). L/R are the animal's own sides (left =
 * +X). Legs hang −Y from their joints with the feet on the ground (y = 0 of the rig); positive
 * rotation.x swings a foot backwards and lowers a head or a jaw; ear and tail tips rotate the
 * same way (positive rotation.x moves an upward-pointing tip forward, a backward-pointing tip up).
 * Throws for an unknown kind.
 */
export function getMobRig(kind: MobKind): MobRig {
  let rig = rigCache.get(kind);
  if (rig === undefined) {
    if (kind === 'deer') rig = buildDeerRig();
    else if (kind === 'dog') rig = buildDogRig();
    else throw new Error(`No rig for mob "${String(kind)}"`);
    rigCache.set(kind, rig);
  }
  return rig;
}
