/**
 * Mongrel dog (дворняга) rig at 1 cm per voxel: 55 cm at the withers, ~80 cm from nose to rump.
 * Tan coat with a darker saddle along the back, cream chest, belly, muzzle and socks, black nose,
 * dark eyes, semi-erect ears whose tips fold forward, a curled tail (бубликом) over the croup.
 * Faces +Z, origin on the ground between the feet; L/R are the dog's own sides (left = +X). The head
 * joint sits at the base of the neck (the neck is part of the head), the jaw hinges under the ears.
 */
import { furShade, mix, shade } from './palette';
import { assembleRig, capsuleDist, chainDist, ellipsoidDist, smin, type PartSpec } from './rig';
import type { MobRig } from './index';
import { Sculpt } from './sculpt';

const SADDLE = 0x6e4a2a;
const TAN = 0xb88a50;
const CREAM = 0xe0c49a;
const NOSE = 0x1b1715;
const EAR = 0x5e3d22;

type Chain = readonly (readonly [number, number, number, number])[];

const FRONT_LEG: Chain = [
  [0, 2, 0, 3.6],
  [0, -16, 0.5, 2.6],
  [0, -33, 0.5, 1.9],
];
const HIND_LEG: Chain = [
  [0, 2, 1, 5.2],
  [0, -14, 3, 3.6],
  [0, -25, -4, 2.2],
  [0, -36, -2.5, 1.9],
];

function leg(chain: Chain, length: number, seed: number): Sculpt {
  const s = new Sculpt(-7, -length, -10, 7, 8, 9);
  const fur = furShade(SADDLE, TAN, CREAM, -length + 6, 6, 0.05, seed, 'y');
  s.sdf(
    (x, y, z) => chainDist(x, y, z, chain, 2),
    (x, y, z) => (y < -length + 12 ? CREAM : fur(x, y, z)),
  );
  // Paw.
  const last = chain[chain.length - 1];
  s.ellipsoid(last[0], -length + 2, last[2] + 1.2, 2.5, 2, 3.1, (x, y, z) => (y === -length && z >= last[2] + 2 ? 0x8a7660 : CREAM));
  return s;
}

function body(): Sculpt {
  const s = new Sculpt(-12, -14, -30, 12, 13, 28);
  const fur = furShade(SADDLE, TAN, CREAM, -10, 10, 0.05, 801);
  s.sdf(
    (x, y, z) => {
      let d = ellipsoidDist(x, y, z, 0, 0, -1, 9.5, 10.5, 26);
      d = smin(d, ellipsoidDist(x, y, z, 0, -1, 14, 9.5, 12.5, 12), 5);
      return smin(d, ellipsoidDist(x, y, z, 0, 1.5, -18, 9, 10, 10.5), 5);
    },
    (x, y, z) => (z >= 17 && y <= 2 ? CREAM : fur(x, y, z)), // cream chest
  );
  return s;
}

/** Neck and head as one part around the neck base; the lower jaw is separate. */
function head(): Sculpt {
  const s = new Sculpt(-8, -6, -7, 8, 21, 26);
  const fur = furShade(SADDLE, TAN, CREAM, 4, 18, 0.05, 802, 'y');
  s.sdf(
    (x, y, z) => {
      const neckD = capsuleDist(x, y, z, [0, 0, 0], [0, 10, 7], 6.2, 5);
      const skull = ellipsoidDist(x, y, z, 0, 13, 10, 6, 5.6, 6.2);
      const muzzle = capsuleDist(x, y, z, [0, 12, 13], [0, 11.2, 21.5], 3.6, 2.8);
      return smin(smin(neckD, skull, 3), muzzle, 2.5);
    },
    (x, y, z) => {
      if (z >= 23) return NOSE;
      if (z >= 16 && y <= 10) return 0x4a2e22; // lip line over the jaw
      if (z >= 16) return mix(CREAM, TAN, 0.25); // pale muzzle
      return fur(x, y, z);
    },
  );
  for (const sx of [-1, 1]) {
    const ex = sx > 0 ? 3 : -4;
    s.set(ex, 14, 15, 0x17120f);
    s.set(ex, 15, 15, 0x2a1d16);
  }
  return s;
}

function jaw(): Sculpt {
  const s = new Sculpt(-4, -3, -2, 4, 2, 11);
  s.sdf(
    (x, y, z) => capsuleDist(x, y, z, [0, 0, 0], [0, -0.6, 8.3], 2.3, 1.8),
    (x, y, z) => (y >= 1 ? 0xa65456 : y >= 0 && z >= 2 ? 0x8c4446 : CREAM), // tongue and the inside of the mouth on top
  );
  return s;
}

/** Semi-erect ear: an upright base whose flap folds forward and down (side = +1 left / −1 right). */
function ear(side: number): Sculpt {
  const s = new Sculpt(-6, -4, -5, 6, 8, 9);
  s.sdf(
    (x, y, z) => {
      const base = ellipsoidDist(x, y, z, 0.6 * side, 2, 0, 1.4, 2.8, 3);
      // Flap: from the top of the base forward, out and down; flattened across its thickness.
      const fx = (x - 0.4 * side) * 1.8;
      const flap = capsuleDist(fx, y, z, [0, 4.2, 0.4], [1.4 * side, 0.6, 5.2], 2.5, 1.4);
      return smin(base, flap, 1.5);
    },
    (x, y, z) => (z >= 3 && y <= 1 ? 0x3a2614 : EAR),
  );
  return s;
}

/** Curled tail: up and back from the croup, then over forward onto the back, pale underneath. */
function tail(): Sculpt {
  const s = new Sculpt(-4, -3, -9, 4, 15, 9);
  const curl: Chain = [
    [0, 0, 0, 2.4],
    [0, 6, -4.5, 2.5],
    [0, 10.5, -2, 2.3],
    [0, 11, 3, 2],
    [0, 8, 6, 1.7],
  ];
  s.sdf(
    (x, y, z) => chainDist(x, y, z, curl, 1.5),
    (x, y, z) => {
      // The inner side of the curl (towards its centre near (0, 6, 0)) is cream, the outside tan.
      const inner = Math.hypot(y + 0.5 - 6, z + 0.5 - 0.5) < 3.2;
      return inner ? CREAM : y >= 9 ? shade(TAN, 0.85) : TAN;
    },
  );
  return s;
}

export function buildDogRig(): MobRig {
  const parts: PartSpec[] = [
    { name: 'body', parent: null, pivot: [0, 44, 0], sculpt: body() },
    { name: 'head', parent: 'body', pivot: [0, 7, 22], sculpt: head() },
    { name: 'jaw', parent: 'head', pivot: [0, 9.6, 13.2], sculpt: jaw() },
    { name: 'earL', parent: 'head', pivot: [4.3, 17, 8.5], sculpt: ear(1) },
    { name: 'earR', parent: 'head', pivot: [-4.3, 17, 8.5], sculpt: ear(-1) },
    { name: 'legFL', parent: 'body', pivot: [5.5, -6, 17], sculpt: leg(FRONT_LEG, 38, 811) },
    { name: 'legFR', parent: 'body', pivot: [-5.5, -6, 17], sculpt: leg(FRONT_LEG, 38, 812) },
    { name: 'legBL', parent: 'body', pivot: [5.5, -4, -19], sculpt: leg(HIND_LEG, 40, 813) },
    { name: 'legBR', parent: 'body', pivot: [-5.5, -4, -19], sculpt: leg(HIND_LEG, 40, 814) },
    { name: 'tail', parent: 'body', pivot: [0, 9, -26], sculpt: tail() },
  ];
  return assembleRig(parts, 0);
}
