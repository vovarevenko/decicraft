import { describe, expect, test } from 'vitest';
import { B, BLOCKS, FOLIAGE, OPAQUE, RK, SKY_OPAQUE, SOLID, SUP } from '../src/world/blocks';
import { ITEMS, ITEM_LIST, materialForBlock } from '../src/game/items';

describe('registries', () => {
  test('every block drop is a known item', () => {
    for (const b of BLOCKS) {
      if (b.drop) expect(ITEMS[b.drop], `${b.key} drops ${b.drop}`).toBeDefined();
    }
  });

  test('every material places a cube block (solid unless foliage)', () => {
    for (const it of ITEM_LIST) {
      if (it.kind !== 'material') continue;
      expect(it.block, it.id).toBeDefined();
      expect(SOLID[it.block!] === 1 || FOLIAGE[it.block!] === 1, it.id).toBe(true);
      expect(BLOCKS[it.block!].render, it.id).toBe(RK.CUBE);
    }
  });

  test('foliage: opaque, passable, not sky-opaque', () => {
    for (const id of [B.OAK_LEAVES, B.BIRCH_LEAVES, B.PINE_NEEDLES, B.BUSH]) {
      expect(FOLIAGE[id]).toBe(1);
      expect(SOLID[id]).toBe(0);
      expect(SKY_OPAQUE[id]).toBe(0);
      expect(BLOCKS[id].support).toBe(SUP.LEAF);
    }
    expect(SKY_OPAQUE[B.STONE]).toBe(1);
  });

  test('tree bark: opaque and structural, shades like foliage instead of roofing', () => {
    for (const id of [B.OAK_LOG, B.BIRCH_LOG, B.PINE_LOG]) {
      expect(OPAQUE[id]).toBe(1);
      expect(SOLID[id]).toBe(1);
      expect(SKY_OPAQUE[id]).toBe(0);
      expect(BLOCKS[id].support).toBe(SUP.STRUCT);
    }
    expect(SKY_OPAQUE[B.WOOD]).toBe(1); // trunk cores, and what the 'wood' item places
  });

  test('ids are unique and B is consistent with the table', () => {
    expect(new Set(ITEM_LIST.map((i) => i.id)).size).toBe(ITEM_LIST.length);
    for (const [key, id] of Object.entries(B)) {
      expect(BLOCKS[id].key.toUpperCase(), key).toBe(key);
    }
    expect(materialForBlock(B.DIRT)).toBe('dirt');
  });
});
