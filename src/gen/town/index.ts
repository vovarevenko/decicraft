/**
 * Abandoned town planner. OWNER: agent "town".
 * Lays out roads, sidewalks, lots, 6–9 buildings (with interiors, doors, windows, roofs, decay),
 * yards with fences and overgrowth, props (car wrecks, lamp posts, benches, rubble), and returns the
 * corresponding features plus entity spawns (doors, containers with loot, loose items, stray dogs).
 * Everything must lie inside TOWN_BUILD_RECT on flat ground at TOWN_GROUND_Y.
 *
 * Every feature captures its own immutable plan and seed; `stamp()` derives all randomness from them,
 * so stamping is identical in every tile and every worker (ARCHITECTURE.md §5.1).
 */
import { TOWN_BUILD_RECT } from '../../config';
import { Rng, hash32 } from '../../core/rng';
import { B } from '../../world/blocks';
import { bushBounds, stampBush, stampTree, treeBounds, type TreeParams } from '../flora';
import { ORDER, type ContainerSpawn, type EntitySpawn, type Feature, type GenContext, type Landmark, type TownPlan } from '../types';
import type { BuildingPlan, PlannedContainer } from './building';
import { GROUND_Y, subSeed } from './common';
import { distToRect, facingOfVector, type Rect, rectsOverlap } from './frame';
import { planBuilding } from './houses';
import { MAIN_Z0, MAIN_Z1, SIDE_X0, SIDE_X1, SIDEWALK, areaFrame, planLayout, type StreetPlan } from './layout';
import { orchardItems, planLoot, type OrchardTree } from './loot';
import { bench, busStop, carWreck, featureRect, lampPost, picketFence, rubblePile } from './props';
import { ruinSurface } from './ruin';
import { stampBuilding } from './stampBuilding';
import { pavedFeature, streetFeature } from './streets';

const TOWN_SALT = 0x70776e5f;
const R = TOWN_BUILD_RECT;

/** Obstacles for overgrowth: crowns keep off `hard` rects, trunks and bushes off `soft` ones too. */
interface Occupancy {
  hard: Rect[];
  soft: Rect[];
}

const minDist = (x: number, z: number, rects: readonly Rect[]): number => {
  let d = Infinity;
  for (const r of rects) d = Math.min(d, distToRect(x, z, r));
  return d;
};

const edgeDist = (x: number, z: number): number => Math.min(x - R.x0, R.x1 - 1 - x, z - R.z0, R.z1 - 1 - z);

function streetRects(s: StreetPlan): Rect[] {
  return [s.asphalt, ...s.paving, ...s.curbs];
}

function buildingFeature(p: BuildingPlan): Feature {
  const bb = p.bounds.toWorld(p.frame);
  return { kind: p.kind, min: bb.min, max: bb.max, order: ORDER.BUILDING, stamp: (w) => stampBuilding(w, p) };
}

function treeFeature(p: TreeParams): Feature {
  const b = treeBounds(p);
  return { kind: `tree:${p.kind}`, min: b.min, max: b.max, order: ORDER.TREE, stamp: (w) => stampTree(w, p) };
}

function bushFeature(x: number, z: number, r: number, seed: number): Feature {
  const b = bushBounds(x, GROUND_Y, z, r);
  return { kind: 'bush', min: b.min, max: b.max, order: ORDER.TREE, stamp: (w) => stampBush(w, x, GROUND_Y, z, r, seed) };
}

/** Self-seeded birch saplings: on the ruin's debris mound and on the shop's flat roof. */
function saplings(plans: readonly BuildingPlan[], rng: Rng, features: Feature[]): void {
  for (const p of plans) {
    if (p.ruin && p.ruin.mounds.length) {
      const m = p.ruin.mounds[0];
      for (let i = 0; i < 2; i++) {
        const u = m.u + (i === 0 ? -1 : 1) * rng.int(2, 6);
        const v = m.v + rng.int(-5, 6);
        const y = ruinSurface(p, u, v);
        features.push(treeFeature({ kind: 'sapling', x: p.frame.wx(u, v), y, z: p.frame.wz(u, v), seed: rng.nextU32(), scale: rng.range(0.8, 1.2), maxCrownRadius: 9 }));
      }
    }
    if (p.roofSapling) {
      const s = p.roofSapling;
      features.push(treeFeature({ kind: 'sapling', x: p.frame.wx(s.u, s.v), y: s.y, z: p.frame.wz(s.u, s.v), seed: rng.nextU32(), scale: rng.range(0.7, 1), maxCrownRadius: 8 }));
    }
  }
}

/** Apple trees in the yards with crowns ≥ 0.5 m from walls and ≥ 0.3 m from each other. */
function orchard(rng: Rng, occ: Occupancy, features: Feature[]): OrchardTree[] {
  const cands: [number, number][] = [];
  for (let z = R.z0 + 24; z < R.z1 - 24; z += 46) {
    for (let x = R.x0 + 24; x < R.x1 - 24; x += 46) cands.push([x + rng.int(-14, 15), z + rng.int(-14, 15)]);
  }
  rng.shuffle(cands);
  const trees: OrchardTree[] = [];
  for (const [x, z] of cands) {
    if (trees.length >= 9) break;
    if (minDist(x, z, occ.soft) < 8) continue;
    let crown = Math.min(28, minDist(x, z, occ.hard) - 5, edgeDist(x, z) - 3);
    for (const t of trees) crown = Math.min(crown, Math.hypot(t.x - x, t.z - z) - t.crown - 3);
    if (crown < 16) continue;
    crown = Math.floor(crown);
    trees.push({ x, z, crown });
    features.push(treeFeature({ kind: 'apple', x, y: GROUND_Y, z, seed: rng.nextU32(), scale: rng.range(0.9, 1.1), maxCrownRadius: crown }));
  }
  return trees;
}

/** Bushes along the yard side of fences and in the back yards (foliage is passable). */
function shrubs(rng: Rng, occ: Occupancy, trees: readonly OrchardTree[], features: Feature[]): Rect[] {
  const cands: [number, number][] = [];
  for (let z = R.z0 + 12; z < R.z1 - 12; z += 28) {
    for (let x = R.x0 + 12; x < R.x1 - 12; x += 28) cands.push([x + rng.int(-9, 10), z + rng.int(-9, 10)]);
  }
  rng.shuffle(cands);
  const placed: Rect[] = [];
  for (const [x, z] of cands) {
    if (placed.length >= 16) break;
    const r = rng.int(4, 8);
    const b = bushBounds(x, GROUND_Y, z, r);
    const rect = { x0: b.min[0], z0: b.min[2], x1: b.max[0], z1: b.max[2] };
    if (rect.x0 < R.x0 || rect.z0 < R.z0 || rect.x1 > R.x1 || rect.z1 > R.z1) continue;
    if ([...occ.hard, ...occ.soft, ...placed].some((o) => rectsOverlap(o, rect))) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < r + 8)) continue;
    placed.push(rect);
    features.push(bushFeature(x, z, r, rng.nextU32()));
  }
  return placed;
}

/**
 * Plans the town of a world seed (deterministic, a few ms; the flat ground needs no terrain reads):
 * street, path, building and prop features plus the overgrowth (apple trees, bushes, saplings), door,
 * container, loose-item and dog spawns, map landmarks, and the entrance on the main street near the
 * south-east corner with the starter toolbox ~3 m ahead of it.
 */
export function planTown(ctx: GenContext): TownPlan {
  const seed = hash32(ctx.seed ^ TOWN_SALT);
  const rng = new Rng(seed);
  const layout = planLayout(rng.fork(1));
  const features: Feature[] = [];
  const spawns: EntitySpawn[] = [];
  const landmarks: Landmark[] = [];
  const occ: Occupancy = { hard: [], soft: [] };

  layout.streets.forEach((s, i) => {
    features.push(streetFeature(s, subSeed(seed, 10 + i), layout.cleanZones, [layout.spawnPad]));
    occ.hard.push(...streetRects(s));
  });

  // Buildings with their paths and front fences.
  const plans: BuildingPlan[] = [];
  const fenceRng = rng.fork(2);
  layout.lots.forEach((lot, i) => {
    const p = planBuilding(lot, subSeed(seed, 100 + i));
    plans.push(p);
    features.push(buildingFeature(p));
    p.paths.forEach((path, j) => {
      features.push(pavedFeature('ground:path', path.rect, path.block, subSeed(p.seed, 200 + j), path.block === B.PAVING ? 0.15 : 0.08));
      occ.soft.push(path.rect);
    });
    spawns.push(...p.doors);
    occ.hard.push(...p.keepOut);
    if (lot.landmark) {
      const f = p.frame;
      landmarks.push({ name: lot.landmark, x: (f.x0 + f.x1) / 2, z: (f.z0 + f.z1) / 2 });
    }
    if (lot.fenced) {
      const af = areaFrame(lot.area, lot.facing);
      const gates = p.paths.map(({ rect }): [number, number] => {
        const a = af.lu(rect.x0, rect.z0);
        const b = af.lu(rect.x1, rect.z1);
        return [Math.floor(Math.min(a, b)) - 1, Math.ceil(Math.max(a, b)) + 1];
      });
      const fence = picketFence(af, gates, fenceRng.fork(i));
      features.push(fence);
      occ.soft.push(featureRect(fence));
    }
  });

  // Street furniture.
  const propRng = rng.fork(3);
  const southWalk = MAIN_Z1 + 2;
  const stop = busStop(436, MAIN_Z1 + 6, 2, propRng);
  const props: Feature[] = [
    stop,
    bench(404, MAIN_Z1 + 9, 2),
    // Three lamp posts: near the entrance, across from the junction and up the side street.
    lampPost(498, southWalk, 2, propRng),
    lampPost(316, southWalk, 2, propRng),
    lampPost(SIDE_X1 + 2, 210, 3, propRng),
    carWreck(SIDE_X0 + 3, 286 + propRng.int(0, 30), propRng.chance(0.5) ? 0 : 2, propRng, subSeed(seed, 20)),
    rubblePile(232, 330, 11, 6, subSeed(seed, 21)),
    rubblePile(SIDE_X1 + SIDEWALK + 18, 376, 8, 4, subSeed(seed, 22)),
  ];
  for (const ft of props) {
    features.push(ft);
    occ.hard.push(featureRect(ft));
  }
  landmarks.push({ name: 'Остановка', x: (stop.min[0] + stop.max[0]) / 2, z: (stop.min[2] + stop.max[2]) / 2 });

  // Overgrowth.
  const growRng = rng.fork(4);
  saplings(plans, growRng, features);
  const trees = orchard(growRng, occ, features);
  const bushes = shrubs(growRng, occ, trees, features);

  // Containers, the starter toolbox near the entrance and the loot.
  const e = layout.entrance;
  const look = e.yaw + 0.18;
  const tx = Math.round(e.x - Math.sin(look) * 31) + 0.5;
  const tz = Math.round(e.z - Math.cos(look) * 31) + 0.5;
  const starter: ContainerSpawn = { type: 'container', x: tx, y: GROUND_Y, z: tz, facing: facingOfVector(e.x - tx, e.z - tz), style: 'toolbox', loot: [] };
  const containers: PlannedContainer[] = [{ spawn: starter, role: 'starter' }, ...plans.flatMap((p) => p.containers)];
  const surfaces = plans.flatMap((p) => p.surfaces);
  const items = planLoot(rng.fork(5), containers, surfaces);
  for (const c of containers) spawns.push(c.spawn);
  spawns.push(...items);
  spawns.push(...orchardItems(rng.fork(6), trees, [...occ.hard, ...occ.soft, ...bushes]));

  // Two stray dogs on the streets, away from the entrance.
  const dogRng = rng.fork(7);
  spawns.push({ type: 'mob', mob: 'dog', x: (SIDE_X0 + SIDE_X1) / 2 + dogRng.int(-12, 13), y: GROUND_Y, z: 220 + dogRng.int(0, 60) });
  spawns.push({ type: 'mob', mob: 'dog', x: 120 + dogRng.int(0, 100), y: GROUND_Y, z: (MAIN_Z0 + MAIN_Z1) / 2 + dogRng.int(-15, 16) });

  return { features, spawns, landmarks, entrance: { x: e.x, z: e.z, yaw: e.yaw } };
}
