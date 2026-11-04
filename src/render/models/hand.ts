/**
 * First-person right forearm and hand at 1 cm per voxel (~38 cm): padded work-jacket sleeve with
 * quilted stitching and a knit cuff, bare hand clenched into a fist, thumb on top. Origin at the wrist;
 * the forearm points −Z (fist forward, sleeve back towards the camera), the palm faces −X, the thumb
 * +Y. The fist's handle channel runs along Y through FIST_GRIP, 8.5 cm in front of the wrist — the
 * point where the view model (viewModel.ts HAND_GRIP) closes the hand around a held item.
 *
 * Hold poses are expressed in the view model's frame: its hand is turned by VIEW_HAND (viewModel.ts
 * HAND_QUATERNION) and rests with the fist at REST_GRIP (viewModel.ts EMPTY_WRIST + HAND_GRIP). Tools,
 * sticks and stems have their model origin in the channel; small things sit on top of the fist and
 * papers and cloth hang from the fingers, facing the camera — those poses carry an explicit `grip`.
 */
import * as THREE from 'three';
import type { HoldPose } from './index';
import { hash01, shade } from './palette';
import { Sculpt } from './sculpt';

/** Hand-space handle channel through the fist (cm). */
const FIST_GRIP: readonly [number, number, number] = [0, 1.5, -8.5];
/** Mirrors viewModel.ts: the hand's turn (HAND_QUATERNION) and resting wrist (EMPTY_WRIST). */
const VIEW_HAND = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.15, 0.25, 0.05, 'YXZ'));
const REST_GRIP = new THREE.Vector3(...FIST_GRIP).multiplyScalar(0.1).applyQuaternion(VIEW_HAND).add(new THREE.Vector3(2, -2.1, -4.2));

const SKIN = 0xd8a07e;
const SKIN_SHADE = 0xc58b6b;
const SKIN_LIGHT = 0xe4b393;
const CREASE = 0xb07a5c;
const JACKET = 0x4c5340;

export function buildHand(): THREE.BufferGeometry {
  const s = new Sculpt(-7, -7, -15, 8, 9, 27);
  // Sleeve: widening towards the elbow, lighter on top, quilted rings every 4 cm and a seam underneath.
  s.sdf(
    (x, y, z) => {
      if (z < 3 || z > 26) return 1;
      const r = 4.7 + (z - 3) * 0.05;
      return Math.hypot(x / r, y / (r * 1.08)) - 1;
    },
    (x, y, z) => {
      if ((z & 3) === 0) return 0x3a3f31;
      if (y <= -5 && Math.abs(x + 0.5) < 1) return 0x353a2d;
      const tone = y >= 2 ? shade(JACKET, 1.08) : y <= -3 ? shade(JACKET, 0.86) : JACKET;
      return hash01(x, y, z, 401) < 0.12 ? shade(tone, 0.94) : tone;
    },
    [-7, -7, 3, 8, 8, 27],
  );
  // Knit cuff.
  s.sdf(
    (x, y, z) => (z < 0 || z > 3 ? 1 : Math.hypot(x / 4.1, y / 4.4) - 1),
    (x, y) => ((x + y) & 1 ? 0x2e302b : 0x383a34),
    [-5, -5, 0, 6, 6, 3],
  );
  // Wrist.
  s.sdf((x, y, z) => (z < -4.5 || z > 1 ? 1 : Math.hypot((x - 0.3) / 2.4, (y - 0.6) / 3.1) - 1), SKIN, [-3, -3, -5, 4, 5, 1]);
  // Back of the hand and the closed fist (a rounded box), palm towards −X.
  s.sdf(
    (x, y, z) => ((x - 1) / 3) ** 4 + ((y - 1.2) / 4.5) ** 4 + ((z + 8) / 4.4) ** 4 - 1,
    (x, y) => (x <= -2 ? SKIN_SHADE : y >= 4 ? SKIN_LIGHT : SKIN),
    [-3, -4, -13, 5, 7, -3],
  );
  // Curled fingers wrapped round the channel on the palm side, index on top; knuckles and first joints.
  for (let f = 0; f < 4; f++) {
    const yc = 4.3 - f * 2.15;
    const z1 = f === 3 ? -7.4 : -6.6;
    s.capsule([-1.6, yc, -12.2], [-1.6, yc, z1], 1.25, 1.2, (x, y) => (Math.abs(y + 0.5 - yc) > 0.95 ? CREASE : SKIN));
    s.capsule([-0.2, yc, -12.7], [2.2, yc, -12.2], 1.15, 1.1, SKIN);
    s.ellipsoid(2.9, yc, -11.4, 1.25, 1.05, 1.15, SKIN_LIGHT);
  }
  // Thumb wrapped over the front of the fingers.
  s.capsule([-0.4, 4.8, -4.6], [-2.4, 3.6, -10.4], 1.35, 1.15, (x, y, z) => (z <= -9.5 ? SKIN_LIGHT : SKIN));
  return s.build(0.02, [0, 0, 0]);
}

/**
 * How an item is held: model point `point` (cm) lies at hand-space point `at` (cm), the item turned
 * by `euler` (XYZ) relative to the hand, uniformly scaled; `shift` (camera space, world units) moves
 * hand and item together from the resting place.
 */
interface HoldSpec {
  point: readonly [number, number, number];
  at: readonly [number, number, number];
  euler: readonly [number, number, number];
  scale: number;
  shift?: readonly [number, number, number];
}

/** Tools (and anything else whose origin is held in the fist): no `grip` needed in the pose. */
const TOOL: HoldSpec = { point: [0, 0, 0], at: FIST_GRIP, euler: [-0.6, Math.PI / 2, 0], scale: 1 };
/** Sticks and stems held at their lower end, rising forward from the fist. */
const STEM: HoldSpec = { ...TOOL, euler: [-0.35, 0.3, 0] };
/** Resting on top of the fist. */
const onFist = (scale = 1, yaw = 0.6): HoldSpec => ({ point: [0, 0, 0], at: [-0.5, 6, -8.2], euler: [0.1, yaw, 0], scale });
/** Hanging from the fingers by the edge point `edge`, facing the camera. */
const hanging = (edge: readonly [number, number, number], scale: number): HoldSpec => ({
  point: edge,
  at: [-1.5, 4.5, -10.5],
  euler: [Math.PI / 2 - 0.25, 0.15, 0],
  scale,
});

const HOLD: Readonly<Record<string, HoldSpec>> = {
  stone_axe: TOOL,
  axe: TOOL,
  pickaxe: { ...TOOL, euler: [-0.8, Math.PI / 2, 0], shift: [0.1, -0.4, 0] }, // the 80 cm pick leans further, its head stays in view
  torch: { ...TOOL, euler: [-0.35, 0, 0] },
  shovel: { ...TOOL, euler: [-0.5, 0, 0] },
  flashlight: { ...TOOL, euler: [-Math.PI / 2 + 0.08, 0, 0] },
  stick: STEM,
  grass_fiber: STEM,
  reed: STEM,
  flower: STEM,
  newspaper: hanging([0, 1, 10], 0.8),
  cloth: hanging([0, 2, 7], 0.9),
  hide: hanging([0, 1, 22], 0.45),
  rope: hanging([7, 2, 0], 0.9),
  campfire: onFist(0.35, 0.4),
};
/** Anything else (food, material cubes) rests on the fist. */
const DEFAULT_HOLD = onFist();

const handPoint = new THREE.Vector3();
const modelPoint = new THREE.Vector3();
const turn = new THREE.Quaternion();
const euler = new THREE.Euler();

/** Camera-space hold pose of an item (see the file comment and HoldPose). */
export function holdPose(itemId: string): HoldPose {
  const spec = Object.hasOwn(HOLD, itemId) ? HOLD[itemId] : DEFAULT_HOLD;
  turn.setFromEuler(euler.set(spec.euler[0], spec.euler[1], spec.euler[2])).premultiply(VIEW_HAND);
  // position = REST_GRIP + R_hand·(at − FIST_GRIP) − R_item·point·scale (cm → world units).
  handPoint.set(spec.at[0] - FIST_GRIP[0], spec.at[1] - FIST_GRIP[1], spec.at[2] - FIST_GRIP[2]).multiplyScalar(0.1).applyQuaternion(VIEW_HAND);
  modelPoint.set(spec.point[0], spec.point[1], spec.point[2]).multiplyScalar(0.1 * spec.scale).applyQuaternion(turn);
  const [sx, sy, sz] = spec.shift ?? [0, 0, 0];
  const p = handPoint.add(REST_GRIP).sub(modelPoint);
  euler.setFromQuaternion(turn);
  const pose: HoldPose = { position: [p.x + sx, p.y + sy, p.z + sz], rotation: [euler.x, euler.y, euler.z], scale: spec.scale };
  const inFist = spec.at === FIST_GRIP && spec.point.every((v) => v === 0);
  if (!inFist) pose.grip = [REST_GRIP.x + sx, REST_GRIP.y + sy, REST_GRIP.z + sz];
  return pose;
}
