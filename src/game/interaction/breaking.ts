/**
 * Breaking model (ARCHITECTURE.md §11.1) as pure functions: swing power, brush selection, clearing removed
 * voxels (and the plants left standing on them), drop tallies, break sounds and HUD hints.
 * OWNER: agent "interaction".
 */
import { B, BLOCKS, FOLIAGE, HARDNESS, TOOL, TOOL_CLASS, isPlant, type SoundMaterial } from '../../world/blocks';
import type { World, WorldData } from '../../world/world';
import type { SoundName } from '../audio';
import type { ToolStats, ToolType } from '../items';
import type { VoxelList, VoxelSet } from './voxelList';

/** Power factor of a tool on a block class it is not made for. */
export const MISMATCH_POWER = 0.35;
/** Hints call breaking "very slow" when one voxel takes longer than this (seconds). */
const SLOW_BREAK_S = 1;

/** Finite hardness: everything except air, water and bedrock. */
export const isBreakable = (id: number): boolean => Number.isFinite(HARDNESS[id]);

/** The held tool suits the block (TOOL.NONE blocks suit anything, the hand included). */
export function toolMatches(stats: ToolStats, id: number): boolean {
  const cls = TOOL_CLASS[id];
  return cls === TOOL.NONE || stats.toolClass === cls;
}

/** Hardness one swing takes off voxel `id`: hand 1.0 on TOOL.NONE blocks else HAND.power; tools full power or ×0.35. */
export function swingPower(stats: ToolStats, id: number): number {
  if (stats.type === 'hand') return TOOL_CLASS[id] === TOOL.NONE ? 1 : stats.power;
  return toolMatches(stats, id) ? stats.power : stats.power * MISMATCH_POWER;
}

/** Brush radius when voxel `id` breaks: the tool's radius on blocks it suits, a single voxel otherwise and in precise mode. */
export function brushRadius(stats: ToolStats, id: number, precise: boolean): number {
  return toolMatches(stats, id) && !precise ? stats.radius : 0;
}

/**
 * Appends to `out` the voxels removed when target voxel (x, y, z) breaks with brush `radius`: the target first,
 * then every voxel whose centre lies within radius + 0.5 of the target's centre and that has the target's tool
 * class and hardness ≤ 1.5·H + 0.05, or is a plant. Never water or bedrock, nor a voxel `owned` claims (one a falling
 * body's write in slices still owns: FellingClient.owned).
 */
export function collectBrush(
  world: WorldData,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: VoxelList,
  owned?: (x: number, y: number, z: number) => boolean,
): void {
  const target = world.getBlock(x, y, z);
  if (!isBreakable(target) || owned?.(x, y, z)) return;
  out.push(x, y, z, target);
  const cls = TOOL_CLASS[target];
  const maxHardness = 1.5 * HARDNESS[target] + 0.05;
  const r = radius + 0.5;
  const r2 = r * r;
  const ri = Math.floor(r);
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dz = -ri; dz <= ri; dz++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (dx * dx + dy * dy + dz * dz > r2 || (dx === 0 && dy === 0 && dz === 0)) continue;
        const id = world.getBlock(x + dx, y + dy, z + dz);
        if (id === B.AIR || id === B.WATER || id === B.BEDROCK || owned?.(x + dx, y + dy, z + dz)) continue;
        if (isPlant(id) || (TOOL_CLASS[id] === cls && HARDNESS[id] <= maxHardness)) out.push(x + dx, y + dy, z + dz, id);
      }
    }
  }
}

/**
 * Sets voxels [from, end) of `set` to AIR (all from `from` on by default), then removes the plants left standing on
 * them and appends those to `plants` (which may be `set` itself). Plants grow on the ground, never on plants or
 * foliage (a felled crown skips ~95 % of the lookups).
 */
export function clearVoxels(world: World, set: VoxelSet, from: number, plants: VoxelList, end = set.count): void {
  const p = set.positions;
  world.setBlocks(p, B.AIR, end, from);
  for (let i = from; i < end; i++) {
    if (isPlant(set.ids[i]) || FOLIAGE[set.ids[i]] === 1) continue;
    const x = p[i * 3];
    const y = p[i * 3 + 1] + 1;
    const z = p[i * 3 + 2];
    const above = world.getBlock(x, y, z);
    if (!isPlant(above)) continue;
    world.setBlock(x, y, z, B.AIR);
    plants.push(x, y, z, above);
  }
}

/** Adds the drop item of every voxel [from, set.count) to `out` (item id → count). */
export function tallyDrops(set: VoxelSet, from: number, out: Map<string, number>): void {
  for (let i = from; i < set.count; i++) {
    const drop = BLOCKS[set.ids[i]].drop;
    if (drop !== null) out.set(drop, (out.get(drop) ?? 0) + 1);
  }
}

const SOUND_OF: Readonly<Record<SoundMaterial, SoundName | null>> = {
  none: null,
  dirt: 'dig_dirt',
  grass: 'dig_dirt',
  sand: 'dig_sand',
  gravel: 'dig_gravel',
  stone: 'dig_stone',
  wood: 'chop_wood',
  leaves: 'leaves',
  glass: 'glass_break',
  metal: 'metal_hit',
  plant: 'plant',
  fabric: 'fabric',
  water: null,
};

/** Sound of hitting / breaking each block id (null = silent). */
export const BREAK_SOUND: readonly (SoundName | null)[] = BLOCKS.map((b) => SOUND_OF[b.sound]);

const VERB: Readonly<Record<number, string>> = { [TOOL.SHOVEL]: 'копать', [TOOL.PICKAXE]: 'колоть', [TOOL.AXE]: 'рубить' };
const NEEDS: Readonly<Record<number, string>> = { [TOOL.SHOVEL]: 'нужна лопата', [TOOL.PICKAXE]: 'нужна кирка', [TOOL.AXE]: 'нужен топор' };
const BETTER: Readonly<Record<number, string>> = { [TOOL.SHOVEL]: 'лучше лопатой', [TOOL.PICKAXE]: 'лучше киркой', [TOOL.AXE]: 'лучше топором' };
const WITH_HELD: Readonly<Record<ToolType, string>> = { hand: 'рукой', axe: 'топором', shovel: 'лопатой', pickaxe: 'киркой' };

function breakVerb(id: number): string {
  const cls = TOOL_CLASS[id];
  if (cls !== TOOL.NONE) return VERB[cls];
  switch (BLOCKS[id].sound) {
    case 'plant':
      return 'сорвать';
    case 'glass':
      return 'разбить';
    case 'fabric':
      return 'порвать';
    default:
      return 'сломать';
  }
}

/**
 * HUD hint for breaking block `id` with `stats`: the action, plus — when the held tool does not suit the block —
 * the preferred tool and whether the held one works, e.g. «ЛКМ — копать (лучше лопатой)» or
 * «ЛКМ — колоть (нужна кирка — рукой очень долго)». «Не разрушить» for unbreakable blocks.
 */
export function breakHint(id: number, stats: ToolStats): string {
  if (!isBreakable(id)) return 'Не разрушить';
  const action = `ЛКМ — ${breakVerb(id)}`;
  if (toolMatches(stats, id)) return action;
  const cls = TOOL_CLASS[id];
  const seconds = Math.ceil(HARDNESS[id] / swingPower(stats, id) - 1e-4) * stats.swingTime;
  return seconds > SLOW_BREAK_S ? `${action} (${NEEDS[cls]} — ${WITH_HELD[stats.type]} очень долго)` : `${action} (${BETTER[cls]})`;
}
