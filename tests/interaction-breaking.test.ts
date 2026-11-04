import { describe, expect, test } from 'vitest';
import { B, HARDNESS, TOOL, TOOL_CLASS, isPlant } from '../src/world/blocks';
import { World } from '../src/world/world';
import { HAND, ITEMS, type ToolStats } from '../src/game/items';
import {
  BREAK_SOUND,
  MISMATCH_POWER,
  breakHint,
  brushRadius,
  clearVoxels,
  collectBrush,
  isBreakable,
  swingPower,
  tallyDrops,
} from '../src/game/interaction/breaking';
import { VoxelList } from '../src/game/interaction/voxelList';

const world = World.create();
const tool = (id: string): ToolStats => ITEMS[id].tool!;
const shovel = tool('shovel');
const axe = tool('axe');
const pickaxe = tool('pickaxe');

function fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
  for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) world.setBlock(x, y, z, id);
}

/** Lattice points within distance r of the origin. */
function ballCount(r: number): number {
  let n = 0;
  const ri = Math.floor(r);
  for (let y = -ri; y <= ri; y++) for (let z = -ri; z <= ri; z++) for (let x = -ri; x <= ri; x++) if (x * x + y * y + z * z <= r * r) n++;
  return n;
}

/** Simulates swings at one voxel: how many until the accumulated power reaches its hardness. */
function swingsToBreak(stats: ToolStats, id: number): number {
  let damage = 0;
  let swings = 0;
  while (damage < HARDNESS[id] - 1e-4) {
    damage += swingPower(stats, id);
    swings++;
  }
  return swings;
}

describe('swing power and brush (§11.1)', () => {
  test('hand: 1.0 on TOOL.NONE blocks, HAND.power elsewhere; never a brush', () => {
    expect(swingPower(HAND, B.GLASS)).toBe(1);
    expect(swingPower(HAND, B.TALL_GRASS)).toBe(1);
    expect(swingPower(HAND, B.DIRT)).toBe(HAND.power);
    expect(brushRadius(HAND, B.DIRT, false)).toBe(0);
    expect(brushRadius(HAND, B.GLASS, false)).toBe(0);
  });

  test('tools: full power and radius on their class, ×0.35 and one voxel otherwise, one voxel in precise mode', () => {
    expect(swingPower(shovel, B.DIRT)).toBe(shovel.power);
    expect(brushRadius(shovel, B.DIRT, false)).toBe(shovel.radius);
    expect(brushRadius(shovel, B.DIRT, true)).toBe(0);
    expect(swingPower(pickaxe, B.DIRT)).toBeCloseTo(pickaxe.power * MISMATCH_POWER);
    expect(brushRadius(pickaxe, B.DIRT, false)).toBe(0);
    expect(swingPower(axe, B.GLASS)).toBe(axe.power); // TOOL.NONE suits every tool
  });

  test('hand on glass breaks it at once; hand on stone takes 8 swings', () => {
    expect(swingsToBreak(HAND, B.GLASS)).toBe(1);
    expect(swingsToBreak(HAND, B.DIRT)).toBe(1);
    expect(swingsToBreak(HAND, B.STONE)).toBe(8);
    expect(swingsToBreak(pickaxe, B.STONE)).toBe(2);
  });

  test('bedrock, water and air are unbreakable', () => {
    expect(isBreakable(B.BEDROCK)).toBe(false);
    expect(isBreakable(B.WATER)).toBe(false);
    expect(isBreakable(B.AIR)).toBe(false);
    expect(isBreakable(B.GLASS)).toBe(true);
    expect(isBreakable(B.TALL_GRASS)).toBe(true);
  });

  test('shovel on dirt removes a ball of radius 2.5 limited to soft soil', () => {
    fill(100, 100, 100, 120, 120, 120, B.DIRT);
    world.setBlock(110, 111, 110, B.STONE); // other class
    world.setBlock(111, 110, 110, B.RUBBLE); // shovel class but too hard (0.5 > 1.5·0.25 + 0.05)
    world.setBlock(109, 110, 110, B.SAND); // soft soil goes too
    world.setBlock(110, 109, 111, B.GRASS);
    const out = new VoxelList();
    collectBrush(world, 110, 110, 110, brushRadius(shovel, B.DIRT, false), out);
    expect(ballCount(2.5)).toBe(81);
    expect(out.count).toBe(81 - 2);
    expect([...out.positions.subarray(0, 3)]).toEqual([110, 110, 110]); // the target comes first
    const limit = 1.5 * HARDNESS[B.DIRT] + 0.05;
    for (let i = 0; i < out.count; i++) {
      const [x, y, z] = out.positions.subarray(i * 3, i * 3 + 3);
      expect((x - 110) ** 2 + (y - 110) ** 2 + (z - 110) ** 2).toBeLessThanOrEqual(6.25);
      expect(TOOL_CLASS[out.ids[i]]).toBe(TOOL.SHOVEL);
      expect(HARDNESS[out.ids[i]]).toBeLessThanOrEqual(limit);
    }
    const ids = [...out.ids.subarray(0, out.count)];
    expect(ids).toContain(B.SAND);
    expect(ids).toContain(B.GRASS);
    expect(ids).not.toContain(B.STONE);
    expect(ids).not.toContain(B.RUBBLE);
  });

  test('axe on an oak trunk also takes the foliage around it, but not stone', () => {
    fill(200, 100, 200, 210, 110, 210, B.OAK_LEAVES);
    fill(204, 100, 204, 206, 110, 206, B.OAK_LOG);
    world.setBlock(203, 105, 204, B.STONE);
    const out = new VoxelList();
    collectBrush(world, 204, 105, 204, brushRadius(axe, B.OAK_LOG, false), out);
    const ids = [...out.ids.subarray(0, out.count)];
    expect(ids.filter((id) => id === B.OAK_LOG).length).toBeGreaterThan(4);
    expect(ids.filter((id) => id === B.OAK_LEAVES).length).toBeGreaterThan(10);
    expect(ids).not.toContain(B.STONE);
    expect(out.count).toBe(ballCount(axe.radius + 0.5) - 1);
  });

  test('a mismatched tool breaks a single voxel', () => {
    fill(300, 100, 300, 306, 106, 306, B.DIRT);
    const out = new VoxelList();
    collectBrush(world, 303, 103, 303, brushRadius(pickaxe, B.DIRT, false), out);
    expect(out.count).toBe(1);
    expect(out.ids[0]).toBe(B.DIRT);
  });

  test('hand on glass takes exactly the pane voxel', () => {
    fill(400, 100, 400, 410, 110, 401, B.GLASS);
    const out = new VoxelList();
    collectBrush(world, 405, 105, 400, brushRadius(HAND, B.GLASS, false), out);
    expect(out.count).toBe(1);
    expect(out.ids[0]).toBe(B.GLASS);
  });

  test('the brush never takes bedrock (below y = 0) or water', () => {
    fill(500, 0, 500, 506, 3, 506, B.DIRT);
    world.setBlock(503, 1, 502, B.WATER);
    const out = new VoxelList();
    collectBrush(world, 503, 0, 503, 2, out);
    for (let i = 0; i < out.count; i++) {
      expect(out.positions[i * 3 + 1]).toBeGreaterThanOrEqual(0);
      expect(out.ids[i]).not.toBe(B.WATER);
      expect(out.ids[i]).not.toBe(B.BEDROCK);
    }
    expect(out.count).toBeGreaterThan(10);
  });

  test('the brush leaves the voxels `owned` claims, the target among them', () => {
    fill(700, 100, 700, 710, 110, 710, B.OAK_LOG);
    const owned = (x: number, _y: number, _z: number): boolean => x >= 705; // a falling body's, still in the world
    const out = new VoxelList();
    collectBrush(world, 704, 105, 704, brushRadius(axe, B.OAK_LOG, false), out, owned);
    expect(out.count).toBeGreaterThan(4);
    for (let i = 0; i < out.count; i++) expect(out.positions[i * 3]).toBeLessThan(705);
    const none = new VoxelList();
    collectBrush(world, 705, 105, 704, brushRadius(axe, B.OAK_LOG, false), none, owned);
    expect(none.count).toBe(0);
    const all = new VoxelList();
    collectBrush(world, 704, 105, 704, brushRadius(axe, B.OAK_LOG, false), all);
    expect(all.count).toBe(ballCount(axe.radius + 0.5));
  });

  test('plants in the ball go with it', () => {
    fill(600, 100, 600, 610, 101, 610, B.GRASS);
    world.setBlock(605, 101, 605, B.TALL_GRASS); // inside the ball
    world.setBlock(609, 101, 605, B.FLOWER_BLUE); // on a voxel the ball does not reach
    const ball = new VoxelList();
    collectBrush(world, 605, 100, 605, 2, ball);
    expect([...ball.ids.subarray(0, ball.count)]).toContain(B.TALL_GRASS);
    clearVoxels(world, ball, 0, ball);
    expect(world.getBlock(605, 100, 605)).toBe(B.AIR);
    expect(world.getBlock(605, 101, 605)).toBe(B.AIR);
    expect(world.getBlock(609, 101, 605)).toBe(B.FLOWER_BLUE);
  });

  test('plants standing on removed voxels are cleared and reported', () => {
    fill(620, 100, 600, 625, 101, 605, B.GRASS);
    world.setBlock(621, 101, 601, B.FERN);
    const removed = new VoxelList();
    collectBrush(world, 621, 100, 601, 0, removed);
    expect(removed.count).toBe(1);
    clearVoxels(world, removed, 0, removed);
    expect(world.getBlock(621, 100, 601)).toBe(B.AIR);
    expect(world.getBlock(621, 101, 601)).toBe(B.AIR);
    expect(removed.count).toBe(2);
    expect([...removed.positions.subarray(3, 6)]).toEqual([621, 101, 601]);
    expect(isPlant(removed.ids[1])).toBe(true);
  });

  test('drops are tallied per item; glass drops nothing', () => {
    const list = new VoxelList();
    list.push(0, 0, 0, B.DIRT);
    list.push(1, 0, 0, B.LITTER); // drops dirt too
    list.push(2, 0, 0, B.OAK_LEAVES);
    list.push(3, 0, 0, B.BUSH);
    list.push(4, 0, 0, B.GLASS);
    const drops = new Map<string, number>();
    tallyDrops(list, 0, drops);
    expect([...drops]).toEqual([
      ['dirt', 2],
      ['leaves', 2],
    ]);
  });

  test('break sounds by material', () => {
    expect(BREAK_SOUND[B.DIRT]).toBe('dig_dirt');
    expect(BREAK_SOUND[B.GRASS]).toBe('dig_dirt');
    expect(BREAK_SOUND[B.SAND]).toBe('dig_sand');
    expect(BREAK_SOUND[B.GRAVEL]).toBe('dig_gravel');
    expect(BREAK_SOUND[B.BRICK]).toBe('dig_stone');
    expect(BREAK_SOUND[B.OAK_LOG]).toBe('chop_wood');
    expect(BREAK_SOUND[B.PINE_NEEDLES]).toBe('leaves');
    expect(BREAK_SOUND[B.TALL_GRASS]).toBe('plant');
    expect(BREAK_SOUND[B.GLASS]).toBe('glass_break');
    expect(BREAK_SOUND[B.ROOF_METAL]).toBe('metal_hit');
    expect(BREAK_SOUND[B.FABRIC]).toBe('fabric');
    expect(BREAK_SOUND[B.WATER]).toBeNull();
  });
});

describe('break hints', () => {
  test('name the preferred tool and whether the held one fits', () => {
    expect(breakHint(B.DIRT, HAND)).toBe('ЛКМ — копать (лучше лопатой)');
    expect(breakHint(B.STONE, HAND)).toBe('ЛКМ — колоть (нужна кирка — рукой очень долго)');
    expect(breakHint(B.OAK_LOG, HAND)).toBe('ЛКМ — рубить (нужен топор — рукой очень долго)');
    expect(breakHint(B.STONE, shovel)).toBe('ЛКМ — колоть (нужна кирка — лопатой очень долго)');
    expect(breakHint(B.DIRT, shovel)).toBe('ЛКМ — копать');
    expect(breakHint(B.OAK_LOG, tool('stone_axe'))).toBe('ЛКМ — рубить');
  });

  test('TOOL.NONE blocks show just the action; unbreakable ones say so', () => {
    expect(breakHint(B.GLASS, pickaxe)).toBe('ЛКМ — разбить');
    expect(breakHint(B.TALL_GRASS, HAND)).toBe('ЛКМ — сорвать');
    expect(breakHint(B.FABRIC, HAND)).toBe('ЛКМ — порвать');
    expect(breakHint(B.BEDROCK, pickaxe)).toBe('Не разрушить');
  });
});
