/**
 * Roe deer (косуля) rig at 1 cm per voxel: ~108 cm from nose to rump, 70 cm at the withers, ears to
 * ~1.07 m. Reddish-brown summer coat, darker along the back, pale belly, white rump patch and throat,
 * grey-brown face with a white chin and muzzle band, black nose and eyes, big pale-lined ears, slender
 * legs with black hooves. Faces +Z, origin on the ground between the feet; L/R are the animal's own
 * sides (left = +X). Legs hang −Y from their hip/shoulder joints, the neck rises from the chest, the
 * head hangs on the neck, ears and the short tail sit on their joints.
 */
import { furShade, mix, shade } from './palette';
import { assembleRig, chainDist, ellipsoidDist, smin, type PartSpec } from './rig';
import type { MobRig } from './index';
import { Sculpt } from './sculpt';

const BACK = 0x7d4626;
const SIDE = 0x9a5a32;
const BELLY = 0xd8c0a0;
const WHITE = 0xf1ebdf;
const CREAM = 0xe2d2b4;
const HOOF = 0x24201c;
const NOSE = 0x161311;

/** Joint chain of a leg ([x, y, z, radius], cm, relative to the hip/shoulder joint). */
type Chain = readonly (readonly [number, number, number, number])[];

const FRONT_LEG: Chain = [
  [0, 3, 0, 4.2],
  [0, -19, 1, 3],
  [0, -30, 0, 2.3],
  [0, -46, 0.3, 1.6],
  [0, -50, 1.6, 1.5],
];
const HIND_LEG: Chain = [
  [0, 2, 1, 6],
  [0, -17, 4, 4.1],
  [0, -32, -6, 2.5],
  [0, -50, -4, 1.6],
  [0, -54, -2.6, 1.5],
];

function leg(chain: Chain, length: number, seed: number): Sculpt {
  const s = new Sculpt(-8, -length, -12, 8, 6, 10);
  const lower = furShade(0x7a5038, 0x8a6248, 0x9a7a62, -length, -length + 30, 0.04, seed, 'y');
  const upper = furShade(BACK, SIDE, mix(SIDE, BELLY, 0.6), -length + 30, 4, 0.05, seed, 'y');
  s.sdf(
    (x, y, z) => chainDist(x, y, z, chain, 2.5),
    (x, y, z) => (y < -length + 2.5 ? HOOF : y < -length + 30 ? lower(x, y, z) : upper(x, y, z)),
  );
  // Hoof: two black toes.
  const toe = chain[chain.length - 1];
  s.ellipsoid(toe[0], -length + 1.5, toe[2] + 0.6, 1.7, 1.5, 2.4, HOOF);
  return s;
}

function body(): Sculpt {
  const s = new Sculpt(-14, -17, -41, 14, 16, 37);
  const fur = furShade(BACK, SIDE, BELLY, -13, 12, 0.05, 701);
  s.sdf(
    (x, y, z) => {
      let d = ellipsoidDist(x, y, z, 0, 0, -3, 11.5, 12.5, 33);
      d = smin(d, ellipsoidDist(x, y, z, 0, 0, 21, 11, 14, 14), 5);
      d = smin(d, ellipsoidDist(x, y, z, 0, 2, -25, 12, 13, 13.5), 5);
      return smin(d, ellipsoidDist(x, y, z, 0, 6, 22, 8.5, 9, 10), 4);
    },
    (x, y, z) => {
      // White rump patch with a cream rim, around the tail.
      if (z <= -30 && Math.abs(x + 0.5) <= 8 && y >= -9 && y <= 9) return Math.abs(x + 0.5) > 6.5 || y > 7 ? CREAM : WHITE;
      return fur(x, y, z);
    },
  );
  return s;
}

function neck(): Sculpt {
  const s = new Sculpt(-8, -6, -7, 8, 27, 22);
  const fur = furShade(BACK, SIDE, mix(SIDE, BELLY, 0.5), -2, 24, 0.05, 702, 'y');
  // Axis from the chest up and forward to the head; n points to the throat side (forward-down).
  const len = Math.hypot(22, 14);
  const ay = 22 / len;
  const az = 14 / len;
  s.sdf(
    (x, y, z) => chainDist(x, y, z, [[0, -2, -1, 7], [0, 10, 6, 5.5], [0, 22, 14, 4.6]], 3),
    (x, y, z) => {
      const t = ((y + 0.5) * ay + (z + 0.5) * az) / len;
      const front = -(y + 0.5) * az + (z + 0.5) * ay;
      if (t > 0.62 && t < 0.88 && front > 2.5) return WHITE; // throat patch
      return front > 3.5 ? shade(fur(x, y, z), 1.08) : fur(x, y, z);
    },
  );
  return s;
}

function head(): Sculpt {
  const s = new Sculpt(-7, -9, -6, 7, 9, 19);
  const face = (x: number, y: number, z: number): number => {
    return y >= 4 ? 0x6e4228 : z >= 7 ? 0x7a5a44 : 0x8a5634;
  };
  s.sdf(
    (x, y, z) => {
      const skull = ellipsoidDist(x, y, z, 0, 1, 3, 5, 5.6, 6.5);
      const muzzle = chainDist(x, y, z, [[0, -0.5, 6, 3.8], [0, -3.5, 15.5, 2.5]], 1);
      return smin(skull, muzzle, 3);
    },
    (x, y, z) => {
      if (z >= 15) return NOSE;
      if (z >= 12 && z <= 13 && y <= -1) return WHITE; // band behind the nose
      if (z >= 9 && y <= -5) return WHITE; // chin
      return face(x, y, z);
    },
  );
  // Eyes: dark with a pale ring.
  for (const sx of [-1, 1]) {
    const ex = sx > 0 ? 4 : -5;
    s.set(ex, 2, 6, 0x1a1410);
    s.set(ex, 2, 7, 0x1a1410);
    s.set(ex, 3, 6, CREAM);
  }
  return s;
}

/** An ear: a thin leaf tilted up and out (side = +1 left / −1 right), pale inside, dark-rimmed tip. */
function ear(side: number): Sculpt {
  const s = new Sculpt(-10, -2, -6, 10, 15, 6);
  const tilt = 0.6; // outward lean from vertical
  const ux = Math.sin(tilt) * side;
  const uy = Math.cos(tilt);
  // Leaf frame: u along the ear, n = the opening (forward and out), w = u × n.
  const nx0 = 0.45 * side;
  const nz0 = 0.9;
  const nDot = nx0 * ux;
  let nx = nx0 - nDot * ux;
  let ny = -nDot * uy;
  let nz = nz0;
  const nl = Math.hypot(nx, ny, nz);
  nx /= nl;
  ny /= nl;
  nz /= nl;
  const wx = uy * nz;
  const wy = -ux * nz;
  const wz = ux * ny - uy * nx;
  const frame = (x: number, y: number, z: number): [number, number, number] => [
    x * ux + y * uy,
    x * nx + y * ny + z * nz,
    x * wx + y * wy + z * wz,
  ];
  s.sdf(
    (x, y, z) => {
      const [u, n, w] = frame(x, y, z);
      return Math.hypot((u - 6.8) / 7, n / 1.1, w / 3.8) - 1;
    },
    (x, y, z) => {
      const [u, n] = frame(x + 0.5, y + 0.5, z + 0.5);
      if (u > 11.6) return 0x2e2018; // dark tip
      return n > 0.1 ? 0xd9c7ae : SIDE; // pale lining facing forward
    },
  );
  return s;
}

function tail(): Sculpt {
  const s = new Sculpt(-4, -8, -5, 4, 3, 2);
  s.ellipsoid(0, -2.5, -1.5, 2.6, 4.2, 1.9, (x, y, z) => (z >= -1 ? CREAM : WHITE));
  return s;
}

export function buildDeerRig(): MobRig {
  const parts: PartSpec[] = [
    { name: 'body', parent: null, pivot: [0, 58, 0], sculpt: body() },
    { name: 'neck', parent: 'body', pivot: [0, 6, 28], sculpt: neck() },
    { name: 'head', parent: 'neck', pivot: [0, 22, 14], sculpt: head() },
    { name: 'earL', parent: 'head', pivot: [3.5, 4.5, 0.5], sculpt: ear(1) },
    { name: 'earR', parent: 'head', pivot: [-3.5, 4.5, 0.5], sculpt: ear(-1) },
    { name: 'legFL', parent: 'body', pivot: [6.5, -6, 22], sculpt: leg(FRONT_LEG, 52, 711) },
    { name: 'legFR', parent: 'body', pivot: [-6.5, -6, 22], sculpt: leg(FRONT_LEG, 52, 712) },
    { name: 'legBL', parent: 'body', pivot: [6.5, -2, -24], sculpt: leg(HIND_LEG, 56, 713) },
    { name: 'legBR', parent: 'body', pivot: [-6.5, -2, -24], sculpt: leg(HIND_LEG, 56, 714) },
    { name: 'tail', parent: 'body', pivot: [0, 6, -37], sculpt: tail() },
  ];
  return assembleRig(parts, 0);
}
