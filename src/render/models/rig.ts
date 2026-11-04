/**
 * Mob rig assembly: parts are sculpted at 1 cm per voxel around their own joint, then built into
 * geometries with pivots in world units. Also the shared anatomy helpers (smooth unions of
 * ellipsoids and capsule chains as signed distances) used by the deer and dog.
 */
import * as THREE from 'three';
import type { MobRig } from './index';
import { Sculpt, type Vec3 } from './sculpt';

export interface PartSpec {
  name: string;
  parent: string | null;
  /** Joint position relative to the parent's joint (or the rig origin), centimetres. */
  pivot: Vec3;
  /** The part, sculpted relative to its own joint (model cells = centimetres). */
  sculpt: Sculpt;
}

/**
 * Builds the rig: one geometry per part (origin = its joint), pivots in world units and the size of
 * the assembled rest pose (width = X extent, height = top above the ground, length = Z extent).
 */
export function assembleRig(parts: readonly PartSpec[], jitter: number): MobRig {
  const byName = new Map(parts.map((p) => [p.name, p]));
  const absolute = (p: PartSpec): THREE.Vector3 => {
    const v = new THREE.Vector3();
    for (let q: PartSpec | undefined = p; q; q = q.parent !== null ? byName.get(q.parent) : undefined) {
      v.x += q.pivot[0];
      v.y += q.pivot[1];
      v.z += q.pivot[2];
    }
    return v.multiplyScalar(0.1);
  };
  const bounds = new THREE.Box3();
  const out = parts.map((p) => {
    const geometry = p.sculpt.build(jitter);
    bounds.union(geometry.boundingBox!.clone().translate(absolute(p)));
    return {
      name: p.name,
      geometry,
      pivot: [p.pivot[0] * 0.1, p.pivot[1] * 0.1, p.pivot[2] * 0.1] as [number, number, number],
      parent: p.parent,
    };
  });
  return {
    parts: out,
    size: { width: bounds.max.x - bounds.min.x, height: bounds.max.y, length: bounds.max.z - bounds.min.z },
  };
}

/** Smooth minimum (union with a fillet of radius k) of two signed distances. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Approximate signed distance to an axis-aligned ellipsoid. */
export function ellipsoidDist(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  return (Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz) - 1) * Math.min(rx, ry, rz);
}

/** Signed distance to a capsule from a to b with radius tapering ra → rb. */
export function capsuleDist(x: number, y: number, z: number, a: Vec3, b: Vec3, ra: number, rb: number): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / (abx * abx + aby * aby + abz * abz)));
  return Math.hypot(x - a[0] - abx * t, y - a[1] - aby * t, z - a[2] - abz * t) - (ra + (rb - ra) * t);
}

/** Smooth union of a chain of capsules through `joints` ([x, y, z, radius] each), fillet k. */
export function chainDist(x: number, y: number, z: number, joints: readonly (readonly [number, number, number, number])[], k: number): number {
  let d = Infinity;
  for (let i = 0; i + 1 < joints.length; i++) {
    const a = joints[i];
    const b = joints[i + 1];
    const s = capsuleDist(x, y, z, [a[0], a[1], a[2]], [b[0], b[1], b[2]], a[3], b[3]);
    d = d === Infinity ? s : smin(d, s, k);
  }
  return d;
}
