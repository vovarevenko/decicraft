/**
 * Loot containers at 1 cm per voxel, front towards +Z, origin at the bottom centre:
 *  - crate 60×40×40: army-green painted plank crate, rope handles, latches; lid hinged at the back;
 *  - toolbox 50×25×24: red enamelled steel box with a carrying handle on the lid, hinged at the back;
 *  - cabinet 60×180×40: polished veneer wardrobe with plinth and cornice, one door hinged on the left;
 *  - fridge 60×160×60: Soviet round-shouldered fridge in white enamel, door hinged on the right.
 * Bodies are hollow, so an opened lid or door shows the inside. Each lid/door is modelled relative to
 * its hinge (`lidPivot`) and opens away from the body: lids flip up and back (rotation about X by a
 * negative angle), doors swing out to the front (about Y; negative for a left hinge, positive for a
 * right one). Big flat faces get coherent colour patches and no per-cell jitter, so they merge into
 * few quads; solids are filled with a placeholder, hollowed, and only then painted (the costly colour
 * functions run on the remaining shell only).
 */
import { EMPTY } from '../voxelModel';
import type { ContainerModel } from './index';
import { fbm3, grain, hash01, noise3, rust, shade, wearEdges, type ColorFn } from './palette';
import { Sculpt } from './sculpt';

/** Placeholder fill colours, replaced by `paint` after hollowing. */
const P1 = 0x000001;
const P2 = 0x000002;
const P3 = 0x000003;

function paint(s: Sculpt, fills: Readonly<Record<number, ColorFn>>): void {
  s.recolor((c, x, y, z) => {
    const fn = fills[c];
    return fn ? fn(x, y, z) : c;
  });
}

/** Stencilled blocky marking: 3×5 glyphs with 1 cm gaps from a hash, in the box [x0, x1) × [y0, y0 + 5). */
function stencil(x: number, y: number, x0: number, x1: number, y0: number, seed: number): boolean {
  if (x < x0 || x >= x1 || y < y0 || y >= y0 + 5) return false;
  const gx = (x - x0) % 4;
  return gx < 3 && hash01(Math.floor((x - x0) / 4), gx, y - y0, seed) < 0.55;
}

function crate(): ContainerModel {
  const olive: ColorFn = (x, y, z) => (fbm3(x, y, z, 8, 601) < 0.42 ? 0x515b36 : 0x56603a);
  const dark = 0x434b2c;
  const ink = 0x2c2f22;
  const raw = grain(0xa58c66, 'x', { amount: 0.07, streak: 12, width: 2, seed: 602 });
  const notWood = (c: number): boolean => c !== ink && c !== 0x8e7652;

  // Body: recessed board panels inside a frame of corner battens and top/bottom rims.
  const body = new Sculpt(-30, 0, -20, 30, 34, 20);
  body.box(-29, 0, -19, 29, 34, 19, P1);
  body.sdf((x, y, z) => ((Math.abs(x) > 25 && Math.abs(z) > 15) || y < 4 || y > 30 ? -1 : 1), P2);
  body.box(-27, 2, -17, 27, 34, 17, EMPTY);
  paint(body, {
    [P1]: (x, y, z) => (z >= 18 && stencil(x, y, -13, 14, 15, 603) ? ink : y === 11 || y === 22 ? dark : olive(x, y, z)),
    [P2]: olive,
  });
  wearEdges(body.grid, () => 0x8e7652, 0.35, 604, notWood);
  body.box(-27, 2, -17, 27, 3, 17, raw); // floor boards inside
  for (const sx of [-1, 1]) {
    const x = sx > 0 ? 29 : -30;
    body.box(x, 22, -7, x + 1, 26, -5, 0xa08d64); // rope handle
    body.box(x, 22, 5, x + 1, 26, 7, 0xa08d64);
    body.box(x, 18, -7, x + 1, 22, 7, (xx, y, z) => ((y + z) & 1 ? 0xa08d64 : 0x8a7852));
    body.box(sx * 16 - 2, 29, 19, sx * 16 + 2, 34, 20, 0x3a3d40); // latch
  }

  const lid = new Sculpt(-30, 0, 0, 30, 6, 40);
  lid.box(-30, 0, 0, 30, 6, 40, P1);
  lid.box(-28, 0, 2, 28, 3, 38, EMPTY); // hollow underneath, rim boards all round
  paint(lid, { [P1]: (x, y, z) => (y <= 2 ? raw(x, y, z) : z === 13 || z === 26 ? dark : olive(x, y, z)) });
  wearEdges(lid.grid, () => 0x8e7652, 0.35, 605, notWood);
  for (const sx of [-1, 1]) {
    lid.box(sx * 16 - 2, 0, 39, sx * 16 + 2, 4, 40, 0x3a3d40); // latch hooks
    lid.box(sx * 15 - 3, 1, 0, sx * 15 + 3, 5, 1, 0x3a3d40); // hinges
  }

  return {
    body: body.build(0, [0, 0, 0]),
    lid: lid.build(0, [0, 0, 0]),
    lidPivot: [0, 3.4, -2],
    lidAxis: 'x',
    lidOpenAngle: -1.9,
    size: [6, 4, 4],
  };
}

function toolbox(): ContainerModel {
  const enamel = rust(0xb5352b, 0.08, 612, 3, undefined, 0.003);
  const chip = 0x8a8d90;
  const inner = 0x7e2620;
  const ridge = 0x93281f;

  // Thin sheet steel: edges are worn before hollowing, so the 1 cm walls do not count as edges.
  const body = new Sculpt(-25, 0, -12, 25, 17, 13);
  body.box(-25, 0, -12, 25, 17, 12, (x, y, z) => (y === 8 ? ridge : enamel(x, y, z)));
  wearEdges(body.grid, () => chip, 0.3, 613, (c) => c !== ridge);
  body.box(-24, 1, -11, 24, 17, 11, EMPTY);
  body.box(-24, 1, -11, 24, 2, 11, inner);
  for (const sx of [-1, 1]) body.box(sx * 15 - 2, 12, 12, sx * 15 + 2, 17, 13, 0xb9bdc0); // latch plates

  const lid = new Sculpt(-25, 0, 0, 25, 8, 25);
  lid.box(-25, 0, 0, 25, 5, 24, enamel);
  wearEdges(lid.grid, () => chip, 0.3, 614);
  lid.box(-24, 0, 1, 24, 4, 23, EMPTY);
  lid.box(-24, 3, 1, 24, 4, 23, inner);
  for (const sx of [-1, 1]) {
    lid.box(sx * 15 - 2, 0, 24, sx * 15 + 2, 4, 25, 0xb9bdc0); // latch clasps
    lid.box(sx * 10 - 1, 5, 10, sx * 10 + 1, 7, 14, 0x9a9ea2); // handle posts
  }
  lid.box(-10, 7, 10, 11, 8, 14, 0x2b2b2b); // handle bar

  return {
    body: body.build(0, [0, 0, 0]),
    lid: lid.build(0, [0, 0, 0]),
    lidPivot: [0, 1.7, -1.2],
    lidAxis: 'x',
    lidOpenAngle: -1.85,
    size: [5, 2.5, 2.4],
  };
}

function cabinet(): ContainerModel {
  const veneer = grain(0x5e3d26, 'y', { amount: 0.08, streak: 40, width: 2, seed: 621 });
  const inside = grain(0x8a6a4a, 'y', { amount: 0.06, streak: 30, width: 3, seed: 622 });

  const body = new Sculpt(-30, 0, -20, 30, 180, 20);
  body.box(-30, 7, -20, 30, 172, 17, P1); // carcass
  body.box(-30, 172, -20, 30, 180, 20, P2); // cornice over the door
  wearEdges(body.grid, () => P3, 0.15, 623); // outer edges only: marked before hollowing
  body.box(-28, 9, -19, 28, 170, 17, EMPTY);
  paint(body, {
    [P1]: veneer,
    [P2]: (x, y, z) => (y === 173 ? 0x4b3120 : veneer(x, y, z)),
    [P3]: (x, y, z) => shade(veneer(x, y, z), 1.25),
  });
  body.box(-28, 0, -18, 28, 7, 15, 0x3e2a1c); // recessed plinth
  body.box(-28, 9, -19, 28, 170, -18, 0x6e5a46); // fibreboard back
  body.box(-28, 124, -18, 28, 126, 16, inside); // shelf
  body.box(-26, 108, -2, 26, 109, -1, 0x9a9ea0); // hanging rail

  // Door (3 cm): frame and two recessed panels in veneer, plain wood inside, bar handle at the free edge.
  const door = new Sculpt(0, 0, -3, 58, 164, 2);
  const inPanel = (x: number, y: number): boolean => x >= 7 && x < 51 && ((y >= 8 && y < 76) || (y >= 84 && y < 156));
  const nearPanel = (x: number, y: number): boolean =>
    !inPanel(x, y) && (inPanel(x - 1, y) || inPanel(x + 1, y) || inPanel(x, y - 1) || inPanel(x, y + 1));
  door.box(0, 0, -3, 58, 164, 0, (x, y, z) => (z === -3 ? inside(x, y, z) : nearPanel(x, y) ? 0x4a2f1d : veneer(x, y, z)));
  door.sdf((x, y, z) => (z > -1 && inPanel(Math.floor(x), Math.floor(y)) ? -1 : 1), EMPTY, [0, 0, -1, 58, 164, 0]);
  door.box(52, 85, 0, 54, 87, 1, 0xb0b4b7); // bar handle: two posts and the bar
  door.box(52, 103, 0, 54, 105, 1, 0xb0b4b7);
  door.box(52, 85, 1, 54, 105, 2, 0xb0b4b7);
  door.box(52, 80, -1, 53, 82, 0, 0x1e1e1e); // keyhole

  return {
    body: body.build(0, [0, 0, 0]),
    lid: door.build(0, [0, 0, 0]),
    lidPivot: [-2.9, 0.8, 2],
    lidAxis: 'y',
    lidOpenAngle: -1.75,
    size: [6, 18, 4],
  };
}

function fridge(): ContainerModel {
  const enamel: ColorFn = (x, y, z) => (noise3(x, y, z, 16, 631) < 0.36 ? 0xe4e0d3 : 0xe9e6dc);
  const lower = rust(enamel, 0.32, 632, 4, undefined, 0.004);
  const shell: ColorFn = (x, y, z) => (y < 16 ? lower(x, y, z) : enamel(x, y, z));
  const liner = 0xf2f0ea;
  const seal = 0x3a3a3a;
  // Round shoulders: the top edges are rounded with a 7 cm radius around X (front and back).
  const shoulder = (y: number, z: number): number => {
    const r = 7;
    const yc = 160 - r;
    if (y < yc) return -1;
    const zc = Math.min(30 - r, Math.max(-30 + r, z));
    return Math.hypot(y - yc, z - zc) - r;
  };

  const body = new Sculpt(-30, 0, -30, 30, 160, 26);
  body.box(-30, 8, -30, 30, 153, 26, P1);
  body.sdf((x, y, z) => shoulder(y, z), P1, [-30, 153, -30, 30, 160, 26]);
  body.box(-28, 10, -28, 28, 152, 26, EMPTY);
  paint(body, { [P1]: shell });
  wearEdges(body.grid, () => 0x5a5a58, 0.08, 633);
  body.box(-28, 0, -28, 28, 8, 24, (x, y) => (y >= 2 && y <= 6 && (y & 1) === 0 ? 0x2c2c2c : 0x4a4a4a)); // grille plinth
  body.box(-28, 10, -28, 28, 11, 26, liner);
  body.box(-28, 10, -28, -27, 152, 26, liner);
  body.box(27, 10, -28, 28, 152, 26, liner);
  body.box(-27, 10, -28, 27, 152, -27, liner);
  body.box(-22, 128, -24, 22, 150, 0, 0xb8bcc0); // freezer box
  body.box(-27, 80, -27, 27, 81, 24, 0xb9c6cc); // glass shelf

  // Door: enamel front with the rounded top, rubber seal and liner inside with three bins, chrome handle, badge.
  const door = new Sculpt(-58, 0, -8, 0, 152, 2);
  door.sdf(
    (x, y, z) => shoulder(y + 8, z + 30),
    (x, y, z) => {
      if (z === -4) return x === -58 || x === -1 || y === 0 ? seal : liner;
      return shell(x, y + 8, z);
    },
    [-58, 0, -4, 0, 152, 0],
  );
  wearEdges(door.grid, () => 0x5a5a58, 0.08, 634, (c) => c !== liner && c !== seal);
  for (const y of [30, 62, 94]) {
    door.box(-54, y, -8, -4, y + 2, -4, 0xd9dde0); // bin floor and front lip
    door.box(-54, y, -8, -4, y + 6, -7, 0xd9dde0);
  }
  door.box(-56, 92, 0, -53, 112, 1, 0xc5c9cc); // handle plate
  door.box(-56, 94, 1, -53, 110, 2, 0xd6dadc); // lever
  door.box(-36, 128, 0, -22, 132, 1, 0xc5c9cc); // badge

  return {
    body: body.build(0, [0, 0, 0]),
    lid: door.build(0, [0, 0, 0]),
    lidPivot: [2.9, 0.8, 3],
    lidAxis: 'y',
    lidOpenAngle: 1.75,
    size: [6, 16, 6],
  };
}

export const CONTAINER_MODELS: Readonly<Record<'crate' | 'cabinet' | 'fridge' | 'toolbox', () => ContainerModel>> = {
  crate,
  cabinet,
  fridge,
  toolbox,
};
