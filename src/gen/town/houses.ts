/**
 * Type-specific building planners: room layouts, doors, windows, porches, stairs, roofs, chimneys,
 * signs and the decay profile of each building type in the town.
 */
import { B } from '../../world/blocks';
import { DOOR_H, DOOR_W, GROUND_TOP, rnd2, weedAt } from './common';
import {
  BuildingBuilder,
  type BuildingPlan,
  HOUSE_WINDOW,
  type Room,
  type RuinPlan,
  type Side,
  type WallRef,
  type WindowStyle,
} from './building';
import type { LocalDir } from './frame';
import { counterAcross, furnishRoom, type FurnishStyle } from './furniture';
import type { LotPlan } from './layout';
import { makeRoof, roofTopAt } from './roof';
import { ruinWallTop } from './ruin';

const STAIR_HALL = 21;

/** Plans a building of the lot's type. */
export function planBuilding(lot: LotPlan, seed: number): BuildingPlan {
  const b = new BuildingBuilder(lot, seed);
  switch (lot.type) {
    case 'brick_house':
      planTwoStorey(b, 'house');
      break;
    case 'office':
      planTwoStorey(b, 'office');
      break;
    case 'wooden_house':
      planWoodenHouse(b);
      break;
    case 'shop':
      planShop(b);
      break;
    case 'garage':
      planGarage(b);
      break;
    case 'shed':
      planShed(b);
      break;
    case 'ruin':
      planRuin(b);
      break;
  }
  return b.build();
}

/** Brick chimney (4×4) from y0 up through the roof, ending ≥ 0.6 m above the roof surface around it. */
function chimney(b: BuildingBuilder, u: number, v: number, y0: number): void {
  if (!b.roof) return;
  let top = 0;
  for (let du = -1; du <= 4; du++) for (let dv = -1; dv <= 4; dv++) top = Math.max(top, roofTopAt(b.roof, u + du, v + dv));
  b.post.add(u, y0, v, u + 4, top + 7, v + 4, B.BRICK);
  b.post.add(u - 1, top + 6, v - 1, u + 5, top + 7, v + 5, B.BRICK);
  b.post.add(u + 1, top + 6, v + 1, u + 3, top + 7, v + 3, B.AIR);
}

/** Small window in each gable end, if the gable is tall enough. */
function atticWindows(b: BuildingBuilder, frame: number): void {
  const r = b.roof;
  if (!r || r.type !== 'gable') return;
  const sides: Side[] = r.ridgeAlongU ? ['left', 'right'] : ['front', 'back'];
  const across = r.ridgeAlongU ? b.D : b.W;
  const mid = (across >> 1) - 3;
  const top = roofTopAt(r, r.ridgeAlongU ? 0 : mid + 3, r.ridgeAlongU ? mid + 3 : 0);
  const y0 = b.yTop + 4;
  if (top - 2 < y0 + 8) return;
  const t = b.t;
  for (const side of sides) {
    // Along-coordinate of a gable wall is v for left/right and u for front/back: both equal `mid`.
    b.sideBox(b.post, side, mid, mid + 6, 0, t, y0, y0 + 6, B.AIR);
    const ef = Math.min(1, t - 1);
    b.sideBox(b.post, side, mid, mid + 6, ef, ef + 1, y0 + 2, y0 + 3, frame);
    b.sideBox(b.post, side, mid + 2, mid + 3, ef, ef + 1, y0, y0 + 6, frame);
    if (b.rng.chance(0.4)) b.sideBox(b.post, side, mid + 3, mid + 6, ef, ef + 1, y0 + 3, y0 + 6, B.GLASS);
  }
}

// ---------------------------------------------------------------------------------------- two-storey

/**
 * Two-storey building with a stair hall strip along one side wall (front door into the hall for the
 * house, into the post room for the office) and two rooms per storey beside it.
 */
function planTwoStorey(b: BuildingBuilder, kind: 'house' | 'office'): void {
  const rng = b.rng;
  const office = kind === 'office';
  b.t = 3;
  b.hf = 3;
  b.storeys = 2;
  b.clear = office ? 28 : 26;
  b.plinth = 1;
  b.core = B.BRICK;
  b.outer = office ? rng.pick([B.PLASTER_BLUE, B.PLASTER_GREEN, B.PLASTER]) : B.BRICK;
  b.decay = office ? rng.range(0.45, 0.8) : 0;
  b.slabMat = B.CONCRETE;
  b.floorMat = B.PLANKS;
  const { W, D, t } = b;
  const leftHall = rng.chance(0.5);
  const hallU0 = leftHall ? t : W - t - STAIR_HALL;
  const p0 = leftHall ? t + STAIR_HALL : W - t - STAIR_HALL - 2;
  const ra0 = leftHall ? p0 + 2 : t;
  const ra1 = leftHall ? W - t : p0;
  const hallSide: Side = leftHall ? 'left' : 'right';
  const intoRooms: LocalDir = leftHall ? 1 : 3;
  const floorA = office ? B.LINOLEUM : B.PLANKS;

  const halls = [0, 1].map((s) => b.room('hall', s, hallU0, t, hallU0 + STAIR_HALL, D - t, office ? B.TILES : B.LINOLEUM, B.PLASTER, B.BRICK));
  const p0w = [0, 1].map((s) => b.partition(s, p0, t, p0 + 2, D - t, B.BRICK));

  // Ground storey.
  const vf = t + Math.round((D - 2 * t - 2) * rng.range(0.46, 0.54));
  const front0 = b.room(office ? 'post' : 'living', 0, ra0, t, ra1, vf, floorA, office ? B.PLASTER : B.WALLPAPER, B.BRICK);
  const p1 = b.partition(0, ra0, vf, ra1, vf + 2, B.BRICK);
  let backA: Room;
  let backB: Room | null = null;
  let p2: WallRef | null = null;
  if (office) {
    backA = b.room('sorting', 0, ra0, vf + 2, ra1, D - t, B.PLANKS, B.PLASTER, B.BRICK);
  } else {
    const bw = rng.int(22, 27);
    const bu0 = leftHall ? ra0 : ra1 - bw;
    const pu = leftHall ? ra0 + bw : ra1 - bw - 2;
    backB = b.room('bath', 0, bu0, vf + 2, bu0 + bw, D - t, B.TILES, B.TILES, B.BRICK);
    p2 = b.partition(0, pu, vf + 2, pu + 2, D - t, B.BRICK);
    backA = b.room('kitchen', 0, leftHall ? pu + 2 : ra0, vf + 2, leftHall ? ra1 : pu, D - t, B.LINOLEUM, B.WALLPAPER, B.BRICK);
    backA.tileBand = 15;
  }
  // Upper storey.
  const vf1 = t + Math.round((D - 2 * t - 2) * rng.range(0.44, 0.56));
  const up0 = b.room(office ? 'office' : 'bedroom', 1, ra0, t, ra1, vf1, floorA, office ? B.PLASTER : B.WALLPAPER, B.BRICK);
  b.partition(1, ra0, vf1, ra1, vf1 + 2, B.BRICK);
  const up1 = b.room(office ? 'office' : rng.chance(0.5) ? 'bedroom' : 'living', 1, ra0, vf1 + 2, ra1, D - t, floorA, office ? B.PLASTER : B.WALLPAPER, B.BRICK);

  // Stairs against the hall's exterior side wall; that wall gets windows only clear of the flight.
  const us = leftHall ? t : W - t - 9;
  const vs = t + 13;
  const st = b.stair(us, vs, leftHall ? 1 : -1, office ? B.CONCRETE : B.PLANKS, office ? B.PAINTED_METAL : B.DARK_WOOD);
  b.exclude(hallSide, 0, 0, st.vEnd + 4);
  b.exclude(hallSide, 1, st.open0 - 4, st.open1 + 4);

  // Exterior door + porch + path.
  const doorStyle = office ? 'wood_painted' : rng.pick(['wood_painted', 'wood'] as const);
  let doorA: number;
  if (office) doorA = Math.round((ra0 + ra1) / 2) - (DOOR_W >> 1);
  else doorA = leftHall ? t + 10 : W - t - 19;
  b.exteriorDoor('front', doorA, doorStyle, rng.chance(0.35));
  const out = b.porch('front', doorA, { mat: B.CONCRETE, canopy: B.CONCRETE, posts: 0 });
  b.pathFromDoor('front', doorA, out, B.CONCRETE);
  if (office) b.sign('ПОЧТА', doorA + DOOR_W / 2, b.fy(0) + DOOR_H + 3, B.PAINTED_METAL, B.PAINTED_WOOD);

  // Interior doors through the hall partition and between rooms.
  const dA = b.doorSpot(t, vf, office ? 0.15 : 0.5);
  if (dA !== null) b.interiorDoor(p0w[0], 0, dA, intoRooms);
  if (office) {
    const dB = b.doorSpot(vf + 2, D - t, 0.5);
    if (dB !== null) b.interiorDoor(p0w[0], 0, dB, intoRooms);
  } else if (backB && p2) {
    const dBath = b.doorSpot(vf + 2, D - t, 0.5);
    if (dBath !== null) b.interiorDoor(p0w[0], 0, dBath, intoRooms);
    const dK = b.doorSpot(backA.u0, backA.u1, rng.range(0.2, 0.8));
    if (dK !== null) b.interiorDoor(p1, 0, dK, 0);
    if (rng.chance(0.6)) {
      const dBack = b.doorSpot(backA.u0, backA.u1, 0.5);
      if (dBack !== null) {
        b.exteriorDoor('back', dBack, 'wood', rng.chance(0.4));
        b.porch('back', dBack, { mat: B.CONCRETE, canopy: 0, posts: 0 });
      }
    }
  }
  const dU0 = b.doorSpot(t, vf1, 0.6);
  if (dU0 !== null) b.interiorDoor(p0w[1], 1, dU0, intoRooms);
  const dU1 = b.doorSpot(vf1 + 2, D - t, 0.4);
  if (dU1 !== null) b.interiorDoor(p0w[1], 1, dU1, intoRooms);

  // Windows.
  const win: WindowStyle = { ...HOUSE_WINDOW, frame: office ? B.PAINTED_WOOD : rng.pick([B.PAINTED_WOOD, B.DARK_WOOD]) };
  for (const r of [front0, backA, up0, up1, ...halls]) b.windows(r, win, 2);
  if (backB) b.windows(backB, { ...win, w: 8, h: 8, sill: 13, mullion: 0, transom: 0 }, 1);

  // Office counter before the rest of the furniture.
  if (office) {
    const gapAtHall = 14;
    const c0 = leftHall ? front0.u0 + gapAtHall : front0.u0 + 3;
    const c1 = leftHall ? front0.u1 - 3 : front0.u1 - gapAtHall;
    counterAcross(b, front0, c0, c1, front0.v1 - 14, true);
  }
  const style: FurnishStyle = { wood: B.DARK_WOOD, radiators: true, russianStove: false };
  for (const r of b.rooms) furnishRoom(b, r, style);

  b.roof = makeRoof(b, {
    type: 'gable',
    mat: office ? B.SLATE : rng.pick([B.ROOF_TILES, B.SLATE]),
    gableMat: b.outer,
    wallMat: B.BRICK,
    ridgeAlongU: true,
    rise: office ? 1 : 2,
    run: office ? 2 : 3,
    eave: 4,
    verge: 3,
    holes: rng.range(0.2, 0.7),
    weeds: rng.range(0.2, 0.7),
  });
  const cu = Math.round((ra0 + ra1) / 2) + rng.int(-10, 10);
  chimney(b, cu, (D >> 1) - 2 + rng.int(-6, 6), b.yTop - 1);
  if (office) chimney(b, leftHall ? ra1 - 12 : ra0 + 8, (D >> 1) + 6, b.yTop - 1);
  atticWindows(b, B.PAINTED_WOOD);
}

// ---------------------------------------------------------------------------------------- wooden house

function planWoodenHouse(b: BuildingBuilder): void {
  const rng = b.rng;
  b.t = 2;
  b.hf = rng.int(2, 5);
  b.storeys = 1;
  b.clear = 26;
  b.plinth = 1;
  b.core = B.PLANKS;
  b.outer = rng.pick([B.PAINTED_WOOD, B.PAINTED_WOOD, B.DARK_WOOD, B.PLANKS]);
  b.decay = b.outer === B.PAINTED_WOOD ? rng.range(0.4, 0.8) : 0;
  b.slabMat = B.PLANKS;
  b.floorMat = B.PLANKS;
  const { W, D, t } = b;

  const vf = t + Math.round((D - 2 * t - 2) * rng.range(0.5, 0.57));
  const livingLeft = rng.chance(0.5);
  const us1 = t + Math.round((W - 2 * t - 2) * (livingLeft ? rng.range(0.55, 0.62) : rng.range(0.38, 0.45)));
  const wallpaper = B.WALLPAPER;
  const leftRoom = b.room(livingLeft ? 'living' : 'bedroom', 0, t, t, us1, vf, B.PLANKS, wallpaper, B.PLANKS);
  const rightRoom = b.room(livingLeft ? 'bedroom' : 'living', 0, us1 + 2, t, W - t, vf, B.PLANKS, wallpaper, B.PLANKS);
  const p2 = b.partition(0, us1, t, us1 + 2, vf, B.PLANKS);
  const p1 = b.partition(0, t, vf, W - t, vf + 2, B.PLANKS);

  // The entrance (сени) is on the side with the larger yard.
  const sideRoom = Math.max(b.lot.roomLeft, b.lot.roomRight);
  const doorSide: Side | 'front' = sideRoom >= 26 ? (b.lot.roomLeft >= b.lot.roomRight ? 'left' : 'right') : 'front';
  const hallLeft = doorSide === 'right' ? false : doorSide === 'left' ? true : rng.chance(0.5);
  const hw = rng.int(24, 30);
  const hu0 = hallLeft ? t : W - t - hw;
  const pu = hallLeft ? t + hw : W - t - hw - 2;
  const hall = b.room('hall', 0, hu0, vf + 2, hu0 + hw, D - t, B.PLANKS, B.PLANKS, B.PLANKS);
  const p3 = b.partition(0, pu, vf + 2, pu + 2, D - t, B.PLANKS);
  const kitchen = b.room('kitchen', 0, hallLeft ? pu + 2 : t, vf + 2, hallLeft ? W - t : pu, D - t, B.PLANKS, wallpaper, B.PLANKS);

  const doorStyle = rng.pick(['wood', 'wood_painted'] as const);
  if (doorSide === 'front') {
    const fr = livingLeft ? leftRoom : rightRoom;
    const a = Math.round((fr.u0 + fr.u1) / 2) - 4;
    b.exteriorDoor('front', a, doorStyle, rng.chance(0.4));
    const out = b.porch('front', a, { mat: B.PLANKS, canopy: B.SLATE, posts: B.DARK_WOOD });
    b.pathFromDoor('front', a, out, B.PAVING);
  } else {
    const a = b.doorSpot(hall.v0, hall.v1, 0.5) ?? hall.v0 + 2;
    b.exteriorDoor(doorSide, a, doorStyle, rng.chance(0.4));
    const out = b.porch(doorSide, a, { mat: B.PLANKS, canopy: rng.pick([B.SLATE, B.ROOF_METAL]), posts: B.DARK_WOOD });
    b.pathFromDoor(doorSide, a, out, B.PAVING);
  }
  // hall → kitchen, hall → the front room above it, living ↔ bedroom.
  const dk = b.doorSpot(hall.v0, hall.v1, 0.5);
  if (dk !== null) b.interiorDoor(p3, 0, dk, hallLeft ? 1 : 3);
  const above = hallLeft ? leftRoom : rightRoom;
  const lo = Math.max(hall.u0, above.u0);
  const hi = Math.min(hall.u1, above.u1);
  const df = b.doorSpot(lo, hi, 0.5);
  if (df !== null) b.interiorDoor(p1, 0, df, 2);
  const dl = b.doorSpot(t, vf, rng.range(0.3, 0.7));
  if (dl !== null) b.interiorDoor(p2, 0, dl, livingLeft ? 1 : 3);

  const win: WindowStyle = { ...HOUSE_WINDOW, frame: B.PAINTED_WOOD, outerSill: B.PAINTED_WOOD, casing: B.PAINTED_WOOD };
  for (const r of [leftRoom, rightRoom, kitchen]) b.windows(r, win, 2);
  b.windows(hall, { ...win, w: 8, h: 10, sill: 11, mullion: 0, transom: 0, casing: 0 }, 1, ['back']);

  const style: FurnishStyle = { wood: rng.pick([B.DARK_WOOD, B.PLANKS]), radiators: false, russianStove: true };
  let stove: { u: number; v: number; y: number } | null = null;
  for (const r of b.rooms) {
    const c = furnishRoom(b, r, style);
    if (c) stove = c;
  }

  b.roof = makeRoof(b, {
    type: 'gable',
    mat: rng.pick([B.SLATE, B.SLATE, B.ROOF_METAL]),
    gableMat: b.outer,
    wallMat: B.PLANKS,
    ridgeAlongU: false,
    rise: 1,
    run: 1,
    eave: 4,
    verge: 3,
    holes: rng.range(0.1, 0.8),
    weeds: rng.range(0.3, 0.9),
  });
  if (stove) chimney(b, stove.u, stove.v, stove.y);
  atticWindows(b, B.PAINTED_WOOD);
}

// ---------------------------------------------------------------------------------------- shop

function planShop(b: BuildingBuilder): void {
  const rng = b.rng;
  b.t = 3;
  b.hf = 3;
  b.storeys = 1;
  b.clear = 32;
  b.plinth = 1;
  b.core = B.BRICK_WHITE;
  b.outer = B.BRICK_WHITE;
  b.slabMat = B.CONCRETE;
  b.floorMat = B.TILES;
  b.parapet = 3;
  const { W, D, t } = b;
  const vf = t + Math.round((D - 2 * t - 2) * 0.64);
  const sales = b.room('sales', 0, t, t, W - t, vf, B.TILES, B.PLASTER, B.BRICK_WHITE);
  const p1 = b.partition(0, t, vf, W - t, vf + 2, B.BRICK_WHITE);
  const storage = b.room('storage', 0, t, vf + 2, W - t, D - t, B.CONCRETE, B.PLASTER, B.BRICK_WHITE);

  // Entrance a little off centre with big vitrines on both sides; the sales hall has blank side
  // walls (room for shelving), the back room small high windows.
  const doorLeft = rng.chance(0.5);
  const doorA = Math.round(W / 2 + (doorLeft ? -8 : 8)) - (DOOR_W >> 1);
  b.exteriorDoor('front', doorA, rng.pick(['wood_painted', 'metal'] as const), true);
  b.porch('front', doorA, { mat: B.CONCRETE, canopy: B.CONCRETE, posts: 0 });
  b.paths.push({ rect: b.f.box(-2, -b.lot.setback, W + 2, 0), block: B.PAVING });
  const vitrine: WindowStyle = {
    w: 24,
    h: 20,
    sill: 5,
    mullion: 12,
    transom: 14,
    glass: 0.5,
    frame: B.PAINTED_METAL,
    outerSill: B.METAL,
    innerSill: 0,
    casing: 0,
  };
  for (const [lo, hi] of [
    [sales.u0 + 3, doorA - 5],
    [doorA + DOOR_W + 5, sales.u1 - 3],
  ]) {
    const n = Math.min(2, Math.floor((hi - lo + 6) / (vitrine.w + 6)));
    for (let i = 0; i < n; i++) b.window('front', sales, Math.round(lo + ((hi - lo) * (i + 0.5)) / n - vitrine.w / 2), vitrine);
  }
  // Storage door at one end of the back partition, a back door out of the storage room.
  const storageDoorRight = !doorLeft;
  const ds = storageDoorRight ? W - t - 6 - DOOR_W : t + 6;
  b.interiorDoor(p1, 0, ds, 0);
  const back = b.doorSpot(storage.u0, storage.u1, storageDoorRight ? 0.25 : 0.75);
  if (back !== null) {
    b.exteriorDoor('back', back, 'metal', false);
    b.porch('back', back, { mat: B.CONCRETE, canopy: 0, posts: 0 });
  }
  b.windows(storage, { ...HOUSE_WINDOW, w: 8, h: 8, sill: 16, mullion: 0, transom: 0, innerSill: 0 }, 1, ['left', 'right', 'back']);
  // Counter in front of the back partition, open at the storage door's end.
  const c0 = storageDoorRight ? sales.u0 + 4 : sales.u0 + 22;
  const c1 = storageDoorRight ? sales.u1 - 22 : sales.u1 - 4;
  counterAcross(b, sales, c0, c1, sales.v1 - 14, false);
  const style: FurnishStyle = { wood: B.PLANKS, radiators: false, russianStove: false };
  for (const r of b.rooms) furnishRoom(b, r, style);

  b.sign('ПРОДУКТЫ', W / 2, b.fy(0) + 26, B.PAINTED_METAL, B.PAINTED_WOOD);
  b.roof = makeRoof(b, {
    type: 'flat',
    mat: B.CONCRETE,
    gableMat: B.BRICK_WHITE,
    wallMat: B.BRICK_WHITE,
    ridgeAlongU: true,
    rise: 0,
    run: 1,
    eave: 0,
    verge: 0,
    holes: 0,
    weeds: 0.8,
  });
  // A birch has seeded itself in a crack of the flat roof near the back wall, weeds around its foot.
  const su = rng.chance(0.5) ? t + 12 : W - t - 13;
  const sv = D - t - 13;
  const y = b.yTop + 1;
  for (let dv = -3; dv <= 3; dv++) {
    for (let du = -3; du <= 3; du++) {
      if ((du !== 0 || dv !== 0) && rng.chance(0.3)) b.post.add(su + du, y, sv + dv, su + du + 1, y + 1, sv + dv + 1, weedAt(du, dv, b.seed));
    }
  }
  b.roofSapling = { u: su, v: sv, y };
}

// ---------------------------------------------------------------------------------------- garage & shed

function planGarage(b: BuildingBuilder): void {
  const rng = b.rng;
  b.t = 2;
  b.hf = 1;
  b.storeys = 1;
  b.clear = 24;
  b.plinth = 0;
  b.core = rng.pick([B.BRICK_WHITE, B.BRICK, B.CONCRETE]);
  b.outer = b.core;
  b.slabMat = B.CONCRETE;
  b.floorMat = B.CONCRETE;
  const { W, D, t } = b;
  const room = b.room('garage', 0, t, t, W - t, D - t, B.CONCRETE, b.core, b.core);
  // Double metal gate, leaves hinged at the outer ends, swinging in; one stands open.
  const g = 12;
  const a0 = (W >> 1) - g;
  const openRight = rng.chance(0.5);
  b.door(b.sideWall('front'), 0, a0, 0, 'metal', !openRight, g, DOOR_H + 1, 'start');
  b.door(b.sideWall('front'), 0, a0 + g, 0, 'metal', openRight, g, DOOR_H + 1, 'end');
  b.exclude('front', 0, a0 - 4, a0 + 2 * g + 4);
  b.windows(room, { ...HOUSE_WINDOW, w: 8, h: 8, sill: 13, mullion: 0, transom: 0, innerSill: 0, outerSill: 0 }, 1, ['left', 'right']);
  furnishRoom(b, room, { wood: B.PLANKS, radiators: false, russianStove: false });
  // Concrete apron in front of the gate out to the street.
  b.paths.push({ rect: b.f.box(a0 - 2, -b.lot.setback, a0 + 2 * g + 2, 0), block: B.CONCRETE });
  b.roof = makeRoof(b, {
    type: 'mono',
    mat: B.ROOF_METAL,
    gableMat: b.core,
    wallMat: b.core,
    ridgeAlongU: true,
    rise: 1,
    run: 4,
    eave: 3,
    verge: 2,
    holes: rng.range(0.3, 0.9),
    weeds: 0,
  });
}

function planShed(b: BuildingBuilder): void {
  const rng = b.rng;
  b.t = 2;
  b.hf = 1;
  b.storeys = 1;
  b.clear = 22;
  b.plinth = 0;
  b.core = B.PLANKS;
  b.outer = rng.pick([B.PLANKS, B.DARK_WOOD]);
  b.slabMat = B.PLANKS;
  b.floorMat = B.PLANKS;
  const { W, D, t } = b;
  const room = b.room('shed', 0, t, t, W - t, D - t, B.PLANKS, B.PLANKS, B.PLANKS);
  const a = (W >> 1) - 4 + rng.int(-3, 4);
  b.exteriorDoor('front', a, 'wood', rng.chance(0.6));
  b.windows(room, { ...HOUSE_WINDOW, w: 8, h: 8, sill: 12, mullion: 0, transom: 0, innerSill: 0, outerSill: 0, glass: 0.3 }, 1, ['left', 'right']);
  furnishRoom(b, room, { wood: B.PLANKS, radiators: false, russianStove: false });
  b.roof = makeRoof(b, {
    type: 'mono',
    mat: B.ROOF_METAL,
    gableMat: b.outer,
    wallMat: b.outer,
    ridgeAlongU: true,
    rise: 1,
    run: 3,
    eave: 3,
    verge: 2,
    holes: rng.range(0.4, 1),
    weeds: 0.4,
  });
}

// ---------------------------------------------------------------------------------------- ruin

function planRuin(b: BuildingBuilder): void {
  const rng = b.rng;
  b.t = 3;
  b.hf = 2;
  b.storeys = 1;
  b.clear = 26;
  b.plinth = 1;
  b.core = B.BRICK;
  b.outer = B.PLASTER;
  b.decay = 0.75;
  b.floorMat = B.CONCRETE;
  const { W, D, t } = b;
  // The roof came down over one front corner, so the collapse reads from the street.
  const collapseRight = rng.chance(0.5);
  const big = Math.max(W, D);
  const ruin: RuinPlan = {
    cu: collapseRight ? W - 4 : 4,
    cv: Math.round(D * rng.range(0.36, 0.48)),
    r0: big * 0.16,
    r1: big * 0.64,
    minH: 0,
    partitions: [],
    mounds: [],
  };
  b.ruin = ruin;
  const vf = t + Math.round((D - 2 * t - 2) * rng.range(0.45, 0.55));
  ruin.partitions.push({ u0: t, v0: vf, u1: W - t, v1: vf + 2 });
  const view = { ruin, yF: b.yF, yTop: b.yTop, W, D, seed: b.seed };
  const intact = (side: Side, a0: number, a1: number, top: number): boolean => {
    for (let a = a0 - 1; a <= a1; a++) {
      const [u0, v0] = b.sideRect(side, a, a + 1, 0, 1);
      if (ruinWallTop(view, u0, v0) < top) return false;
    }
    return true;
  };
  // Front door on the standing side; the door itself has long since been propped open.
  const fy = b.fy(0);
  const doorA = collapseRight ? t + 8 : W - t - 8 - DOOR_W;
  if (intact('front', doorA, doorA + DOOR_W, fy + DOOR_H + 2)) {
    b.exteriorDoor('front', doorA, 'wood', true);
    b.porch('front', doorA, { mat: B.CONCRETE, canopy: 0, posts: 0 });
  } else {
    // A breach in the broken wall instead of a doorway (no door entity), open to the top.
    b.sideBox(b.openings, 'front', doorA, doorA + DOOR_W, 0, t, fy, b.yTop + 1, B.AIR);
  }
  // Empty window openings wherever the wall still stands high enough.
  for (const side of ['front', 'left', 'right', 'back'] as Side[]) {
    const len = side === 'front' || side === 'back' ? W : D;
    for (let a = t + 6; a + 12 <= len - t - 6; a += 26) {
      if (side === 'front' && a < doorA + DOOR_W + 5 && doorA - 5 < a + 12) continue;
      if (!intact(side, a, a + 12, fy + 9 + 14 + 2)) continue;
      b.sideBox(b.openings, side, a, a + 12, 0, t, fy + 9, fy + 23, B.AIR);
      if (rng.chance(0.5)) b.sideBox(b.openings, side, a, a + 1, 1, 2, fy + 9, fy + 23, B.DARK_WOOD);
    }
  }
  // Debris: a big mound where the roof came down, a smaller one in the back room, loose bricks
  // around — all kept inside the lot.
  const minU = -b.lot.roomLeft + 2;
  const maxU = W + b.lot.roomRight - 2;
  const minV = -b.lot.setback + 2;
  const maxV = D + 8;
  const mound = (u: number, v: number, r: number, h: number) => {
    const rr = Math.min(r, u - minU, maxU - u, v - minV, maxV - v);
    if (rr >= 6) ruin.mounds.push({ u, v, r: rr, h: Math.min(h, rr) });
  };
  mound(ruin.cu + (collapseRight ? -14 : 14), ruin.cv + 4, rng.int(20, 27), rng.int(9, 13));
  mound(Math.round(W * (collapseRight ? rng.range(0.25, 0.45) : rng.range(0.55, 0.75))), Math.round((vf + D) / 2) + rng.int(-4, 5), rng.int(9, 13), rng.int(4, 7));
  for (let i = 0; i < 40; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const dist = rng.range(4, 34);
    const u = Math.round(ruin.cu + Math.cos(ang) * dist);
    const v = Math.round(ruin.cv + Math.sin(ang) * dist);
    if ((u >= -1 && u <= W && v >= -1 && v <= D) || u < minU || u + 2 > maxU || v < minV || v >= maxV) continue;
    const y = GROUND_TOP + 1;
    b.exterior.add(u, y, v, u + 1 + (i & 1), y + 1, v + 1, rnd2(u, v, b.seed) < 0.7 ? B.BRICK : B.RUBBLE);
  }
  for (const m of ruin.mounds) b.keepOut.push(b.f.box(m.u - m.r, m.v - m.r, m.u + m.r, m.v + m.r));
}
