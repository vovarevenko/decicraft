/**
 * Axis-aligned body vs voxel-world collision, shared by the player, mobs, item drops.
 * OWNER: agent "player".
 *
 * Moves are clipped axis by axis (Y, then X, then Z) against SOLID voxels and extra solid boxes. Each
 * axis is swept: every voxel layer and box between the body's leading face and its destination is
 * tested, so nothing is tunnelled at any speed or thickness. Bodies stop SKIN short of the faces they
 * hit, and overlap tests ignore penetrations thinner than CONTACT (> SKIN), so a body resting on or
 * against a face never counts as being inside it. Voxels and boxes a body already overlaps do not
 * block it (it can always move out).
 */
import type * as THREE from 'three';
import { B, SOLID } from '../world/blocks';
import type { WorldData } from '../world/world';

/** Axis-aligned box in world units (min inclusive, max exclusive for voxel tests). */
export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export const makeAABB = (): AABB => ({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });

/** A moving box: `position` is the bottom centre; the box is [x±halfWidth] × [y, y+height] × [z±halfWidth]. */
export interface Body {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  halfWidth: number;
  height: number;
  /** Set by moveBody: resting on a solid surface after the move. */
  onGround: boolean;
}

export interface MoveOptions {
  /** Max automatic step-up height (world units) when walking into a ledge; only applies when the body was on the ground. */
  stepHeight?: number;
  /** Extra solid boxes (closed doors, crates…). Clipped per axis exactly like voxels — no tunnelling at any thickness. */
  solids?: readonly AABB[];
  /** Ignore all collisions (fly/noclip). */
  noClip?: boolean;
  /**
   * Ground snapping: a body on the ground that walks over a drop of at most this height (world units)
   * is put down onto the lower floor instead of falling — stairs and slopes are walked down, not
   * hopped down. Ignored when the move goes up (dy > 0).
   */
  snapDown?: number;
  /**
   * Edge guard (sneaking): a body on the ground does not move horizontally to where no SOLID voxel or
   * box lies within this depth (world units) below its feet. 0 / omitted = off.
   */
  edgeGuard?: number;
}

export interface MoveResult {
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  /** Height climbed by auto step-up this move (0 if none) — the player smooths the camera with it. */
  stepped: number;
  /** Height descended by ground snapping (`snapDown`) this move (0 if none) — smoothed like `stepped`. */
  snapped: number;
}

/** Gap kept between a body and the faces it collides with. */
const SKIN = 1e-3;
/** Overlaps thinner than this are contacts, not penetration (must exceed SKIN). */
const CONTACT = 2e-3;
/** Longest horizontal distance resolved per sub-step, so axis separation and step-ups follow the path. */
const MAX_SUBSTEP = 0.5;
const MAX_SUBSTEPS = 64;
/** A clipped move shorter than wanted by less than this still counts as unobstructed. */
const BLOCK_TOLERANCE = 1e-7;
/** A step-up must gain at least this much ground at the raised height to be taken. */
const MIN_STEP_GAIN = 1e-4;
/** Depth probed below the feet to decide whether a body stands on something. */
const SUPPORT_PROBE = 0.01;
/** blockUnder() samples this far below the feet. */
const UNDER_PROBE = 0.05;

type Axis = 0 | 1 | 2;

const NO_SOLIDS: readonly AABB[] = [];
/** Scratch boxes: the moving body and probes. moveBody is not re-entrant. */
const moving = makeAABB();
const probe = makeAABB();
const result: MoveResult = { hitX: false, hitY: false, hitZ: false, stepped: 0, snapped: 0 };

const lo = (b: AABB, axis: Axis): number => (axis === 0 ? b.minX : axis === 1 ? b.minY : b.minZ);
const hi = (b: AABB, axis: Axis): number => (axis === 0 ? b.maxX : axis === 1 ? b.maxY : b.maxZ);
const blocked = (moved: number, wanted: number): boolean => Math.abs(wanted - moved) > BLOCK_TOLERANCE;

function coord(p: THREE.Vector3, axis: Axis): number {
  return axis === 0 ? p.x : axis === 1 ? p.y : p.z;
}

function shift(p: THREE.Vector3, axis: Axis, d: number): void {
  if (axis === 0) p.x += d;
  else if (axis === 1) p.y += d;
  else p.z += d;
}

/**
 * Moves `body` by (dx, dy, dz) world units, resolving collisions axis by axis (Y first, then X, Z)
 * against SOLID voxels and `opts.solids`, with optional step-up. Zeroes the velocity component of
 * each blocked axis and updates `body.onGround`. Sub-steps internally so that no move tunnels through
 * a 1-voxel wall or a thin box, and never leaves the body inside solids it was not already in.
 * Foliage, plants and water are not SOLID (bodies pass through them).
 *
 * The returned object is reused by the next call.
 */
export function moveBody(world: WorldData, body: Body, dx: number, dy: number, dz: number, opts?: MoveOptions): MoveResult {
  const r = result;
  r.hitX = r.hitY = r.hitZ = false;
  r.stepped = 0;
  r.snapped = 0;
  const p = body.position;
  if (opts?.noClip) {
    p.x += dx;
    p.y += dy;
    p.z += dz;
    body.onGround = false;
    return r;
  }
  const solids = opts?.solids ?? NO_SOLIDS;
  const stepHeight = opts?.stepHeight ?? 0;
  const snapDown = dy > 0 ? 0 : (opts?.snapDown ?? 0);
  const edgeGuard = opts?.edgeGuard ?? 0;
  const v = body.velocity;
  const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / MAX_SUBSTEP)));
  const sx = dx / n;
  const sy = dy / n;
  const sz = dz / n;
  let grounded = body.onGround;

  for (let i = 0; i < n; i++) {
    if (sy !== 0) {
      const moved = clip(world, bodyAABB(body, moving), 1, sy, solids);
      p.y += moved;
      if (blocked(moved, sy)) {
        r.hitY = true;
        if (sy < 0 ? v.y < 0 : v.y > 0) v.y = 0;
        grounded = sy < 0;
      } else {
        grounded = false;
      }
    } else if (grounded) {
      grounded = supported(world, body, SUPPORT_PROBE, solids);
    }

    if (sx !== 0 && moveAcross(world, body, 0, sx, grounded, stepHeight, edgeGuard, solids, r)) {
      r.hitX = true;
      if (sx > 0 ? v.x > 0 : v.x < 0) v.x = 0;
    }
    if (sz !== 0 && moveAcross(world, body, 2, sz, grounded, stepHeight, edgeGuard, solids, r)) {
      r.hitZ = true;
      if (sz > 0 ? v.z > 0 : v.z < 0) v.z = 0;
    }

    if (snapDown > 0 && grounded && !supported(world, body, SUPPORT_PROBE, solids)) {
      const down = clip(world, bodyAABB(body, moving), 1, -snapDown, solids);
      if (blocked(down, -snapDown)) {
        p.y += down;
        r.snapped -= down;
        if (v.y < 0) v.y = 0;
      } else {
        grounded = false;
      }
    }
  }
  body.onGround = grounded;
  return r;
}

/**
 * One horizontal axis of a sub-step: the swept move, a step-up when it is blocked on the ground, and
 * the edge guard. Returns true if the body could not move the whole way.
 */
function moveAcross(
  world: WorldData,
  body: Body,
  axis: 0 | 2,
  d: number,
  grounded: boolean,
  stepHeight: number,
  edgeGuard: number,
  solids: readonly AABB[],
  r: MoveResult,
): boolean {
  const p = body.position;
  const start = coord(p, axis);
  const moved = clip(world, bodyAABB(body, moving), axis, d, solids);
  shift(p, axis, moved);
  let climbed = 0;
  if (grounded && stepHeight > 0 && blocked(moved, d)) {
    climbed = stepUp(world, body, axis, d - moved, stepHeight, solids);
    r.stepped += climbed;
  }
  if (grounded && edgeGuard > 0 && climbed === 0 && coord(p, axis) !== start && !supported(world, body, edgeGuard, solids)) {
    if (axis === 0) p.x = start;
    else p.z = start;
    return true;
  }
  return blocked(coord(p, axis) - start, d);
}

/**
 * Tries to continue a blocked horizontal move `rest` from 1, 2, … voxel levels higher (up to
 * `maxLift`), lifting the body in place first so the head clearance is checked. Takes the lowest
 * level that lets the body advance; returns the height climbed (0 = no step).
 */
function stepUp(world: WorldData, body: Body, axis: 0 | 2, rest: number, maxLift: number, solids: readonly AABB[]): number {
  const p = body.position;
  const y0 = p.y;
  for (let level = Math.floor(y0 + CONTACT) + 1; ; level++) {
    const lift = level + SKIN - y0;
    if (lift > maxLift + 1e-9) return 0;
    const up = clip(world, bodyAABB(body, moving), 1, lift, solids);
    if (blocked(up, lift)) return 0; // the head hits something: higher levels need even more room
    p.y = y0 + up;
    const ahead = clip(world, bodyAABB(body, moving), axis, rest, solids);
    if (Math.abs(ahead) > MIN_STEP_GAIN) {
      shift(p, axis, ahead);
      return up;
    }
    p.y = y0;
  }
}

/**
 * Longest move ≤ |d| of box `b` along `axis` towards sign(d) before it comes within SKIN of a SOLID
 * voxel or one of `solids` in its way (never negative: a body already closer than SKIN stays put).
 */
function clip(world: WorldData, b: AABB, axis: Axis, d: number, solids: readonly AABB[]): number {
  let allowed = d;
  if (d > 0) {
    const face = hi(b, axis);
    const last = Math.floor(face + d + SKIN);
    for (let c = Math.floor(face - CONTACT) + 1; c <= last; c++) {
      if (layerHasSolid(world, b, axis, c)) {
        allowed = Math.max(0, c - SKIN - face);
        break;
      }
    }
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      const near = lo(s, axis);
      if (near >= face - CONTACT && crossOverlap(s, b, axis)) allowed = Math.min(allowed, Math.max(0, near - SKIN - face));
    }
  } else if (d < 0) {
    const face = lo(b, axis);
    const last = Math.floor(face + d - SKIN);
    for (let c = Math.floor(face + CONTACT) - 1; c >= last; c--) {
      if (layerHasSolid(world, b, axis, c)) {
        allowed = Math.min(0, c + 1 + SKIN - face);
        break;
      }
    }
    for (let i = 0; i < solids.length; i++) {
      const s = solids[i];
      const near = hi(s, axis);
      if (near <= face + CONTACT && crossOverlap(s, b, axis)) allowed = Math.max(allowed, Math.min(0, near + SKIN - face));
    }
  }
  return allowed;
}

/** True if voxel layer `c` along `axis` holds a SOLID voxel within the box's cross-section. */
function layerHasSolid(world: WorldData, b: AABB, axis: Axis, c: number): boolean {
  const x0 = Math.floor(b.minX + CONTACT);
  const x1 = Math.floor(b.maxX - CONTACT);
  const y0 = Math.floor(b.minY + CONTACT);
  const y1 = Math.floor(b.maxY - CONTACT);
  const z0 = Math.floor(b.minZ + CONTACT);
  const z1 = Math.floor(b.maxZ - CONTACT);
  if (axis === 0) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (SOLID[world.getBlock(c, y, z)]) return true;
  } else if (axis === 1) {
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (SOLID[world.getBlock(x, c, z)]) return true;
  } else {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (SOLID[world.getBlock(x, y, c)]) return true;
  }
  return false;
}

/** `s` overlaps `b` (by more than a contact) on the two axes other than `axis`. */
function crossOverlap(s: AABB, b: AABB, axis: Axis): boolean {
  if (axis !== 0 && (s.maxX <= b.minX + CONTACT || s.minX >= b.maxX - CONTACT)) return false;
  if (axis !== 1 && (s.maxY <= b.minY + CONTACT || s.minY >= b.maxY - CONTACT)) return false;
  if (axis !== 2 && (s.maxZ <= b.minZ + CONTACT || s.minZ >= b.maxZ - CONTACT)) return false;
  return true;
}

/** Something SOLID lies within `depth` below the body's feet. */
function supported(world: WorldData, body: Body, depth: number, solids: readonly AABB[]): boolean {
  const b = bodyAABB(body, probe);
  b.maxY = b.minY;
  b.minY -= depth;
  return boxBlocked(world, b, solids);
}

/**
 * True if the box overlaps a SOLID voxel or one of `solids` by more than a contact — the test moveBody
 * itself uses: a box touching a face, like a body moveBody left resting there, is not blocked. Use it
 * to check whether a body fits somewhere (standing up, climbing, leaving noclip).
 */
export function boxBlocked(world: WorldData, box: AABB, solids: readonly AABB[] = NO_SOLIDS): boolean {
  const x0 = Math.floor(box.minX + CONTACT);
  const x1 = Math.floor(box.maxX - CONTACT);
  const y0 = Math.floor(box.minY + CONTACT);
  const y1 = Math.floor(box.maxY - CONTACT);
  const z0 = Math.floor(box.minZ + CONTACT);
  const z1 = Math.floor(box.maxZ - CONTACT);
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) if (SOLID[world.getBlock(x, y, z)]) return true;
    }
  }
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (
      s.maxX > box.minX + CONTACT &&
      s.minX < box.maxX - CONTACT &&
      s.maxY > box.minY + CONTACT &&
      s.minY < box.maxY - CONTACT &&
      s.maxZ > box.minZ + CONTACT &&
      s.minZ < box.maxZ - CONTACT
    ) {
      return true;
    }
  }
  return false;
}

/** Writes the body's box into `out`. */
export function bodyAABB(body: Body, out: AABB): AABB {
  out.minX = body.position.x - body.halfWidth;
  out.maxX = body.position.x + body.halfWidth;
  out.minY = body.position.y;
  out.maxY = body.position.y + body.height;
  out.minZ = body.position.z - body.halfWidth;
  out.maxZ = body.position.z + body.halfWidth;
  return out;
}

/** True if the box overlaps any SOLID voxel. */
export function aabbHitsWorld(world: WorldData, box: AABB): boolean {
  const x1 = Math.ceil(box.maxX) - 1;
  const y1 = Math.ceil(box.maxY) - 1;
  const z1 = Math.ceil(box.maxZ) - 1;
  for (let y = Math.floor(box.minY); y <= y1; y++) {
    for (let z = Math.floor(box.minZ); z <= z1; z++) {
      for (let x = Math.floor(box.minX); x <= x1; x++) if (SOLID[world.getBlock(x, y, z)]) return true;
    }
  }
  return false;
}

/** Fraction (0..1) of the body's height that is inside WATER voxels. */
export function waterFraction(world: WorldData, body: Body): number {
  const h = body.height;
  if (!(h > 0)) return 0;
  const x = Math.floor(body.position.x);
  const z = Math.floor(body.position.z);
  const bottom = body.position.y;
  const top = bottom + h;
  let wet = 0;
  for (let y = Math.floor(bottom); y < top; y++) {
    if (world.getBlock(x, y, z) === B.WATER) wet += Math.min(y + 1, top) - Math.max(y, bottom);
  }
  return Math.min(1, wet / h);
}

/** Block id directly under the body's feet (centre column, first voxel below position.y). */
export function blockUnder(world: WorldData, body: Body): number {
  const p = body.position;
  return world.getBlock(Math.floor(p.x), Math.floor(p.y - UNDER_PROBE), Math.floor(p.z));
}
