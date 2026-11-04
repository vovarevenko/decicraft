/**
 * Material items: a 10 cm cube (10³ model voxels) of the block's colours — top colour on the top
 * layer, bottom colour on the bottom layer, side colour elsewhere — with a little of the block's
 * surface pattern (`PAT`) so that inventory icons and drops read like the world blocks.
 */
import type * as THREE from 'three';
import { BLOCKS, PAT } from '../../world/blocks';
import { fbm3, grain, hash01, mix, rings, rust, shade, type ColorFn } from './palette';
import { Sculpt } from './sculpt';

/** Cube cells span x, z ∈ [−5, 5), y ∈ [0, 10). */
const LO = -5;
const HI = 4;
const TOP = 9;

const onEdge = (a: number): number => (a === LO || a === HI ? 1 : 0);

/** Cell colour of a material cube for block pattern `pattern` (side / top / bottom colours, variation). */
function patternColor(pattern: number, side: number, top: number, bottom: number, vary: number, hasSoil: boolean): ColorFn {
  const layer = (y: number): number => (y === TOP ? top : y === 0 ? bottom : side);
  const tone = (c: number, x: number, y: number, z: number, seed: number): number => {
    const h = hash01(x, y, z, seed);
    return h < 0.25 ? shade(c, 1 - vary * 0.9) : h > 0.8 ? shade(c, 1 + vary * 0.7) : c;
  };
  switch (pattern) {
    case PAT.SOIL:
      return (x, y, z) => (hash01(x, y, z, 201) < 0.05 ? mix(layer(y), 0x9a9080, 0.45) : tone(layer(y), x, y, z, 202));
    case PAT.GRASS:
      return (x, y, z) => {
        if (y === TOP) return hash01(x, y, z, 203) < 0.3 ? shade(top, 1.12) : tone(top, x, y, z, 204);
        if (!hasSoil) return tone(side, x, y, z, 205);
        // Sod: blades over the upper sides, soil showing through below.
        if (y >= 6) return hash01(x, y, z, 206) < (y - 5) * 0.25 ? tone(side, x, y, z, 207) : tone(bottom, x, y, z, 208);
        return tone(bottom, x, y, z, 209);
      };
    case PAT.STONE:
      return (x, y, z) => {
        if (Math.abs(x - z * 0.6 - y * 0.35 + 1) < 0.4 && (x === LO || z === HI || y === TOP)) return shade(layer(y), 0.62); // crack
        const n = fbm3(x, y, z, 3, 210);
        return n < 0.38 ? shade(layer(y), 1 - vary) : n > 0.64 ? shade(layer(y), 1 + vary * 0.8) : layer(y);
      };
    case PAT.GRAVEL:
      return (x, y, z) => {
        if (hash01(x, y, z, 211) < 0.16) return shade(layer(y), 0.62);
        const h = hash01(x >> 1, y >> 1, z >> 1, 212);
        return h < 0.3 ? shade(layer(y), 1 - vary) : h > 0.7 ? mix(shade(layer(y), 1 + vary), 0xa89a86, 0.3) : layer(y);
      };
    case PAT.WOOD: {
      const sideGrain = grain(side, 'y', { amount: 0.08, streak: 5, seed: 213 });
      const endRings = rings(shade(top, 1.06), shade(top, 0.86), 'y', 0, 0, 1.4);
      return (x, y, z) => (y === TOP || y === 0 ? endRings(x, y, z) : sideGrain(x, y, z));
    }
    case PAT.LEAVES:
      return (x, y, z) => {
        const h = hash01(x, y, z, 214);
        return h < 0.16 ? shade(side, 0.55) : h < 0.45 ? shade(side, 0.82) : h > 0.85 ? shade(side, 1.18) : side;
      };
    case PAT.PLANKS: {
      const boards = grain(side, 'x', { amount: 0.07, streak: 6, knots: 0.015, seed: 215 });
      return (x, y, z) => (z === LO || z === HI ? shade(side, 0.68) : boards(x, y, z));
    }
    case PAT.BRICK:
      return (x, y, z) => {
        const mortar = 0xb3aca0;
        if (y === 2) return mortar;
        const joint = y < 2 ? 2 : -3;
        if (x === joint || z === joint) return mortar;
        return tone(layer(y), x >> 1, y < 2 ? 0 : 1, z >> 1, 216);
      };
    case PAT.TILES:
      return (x, y, z) => (onEdge(x) + onEdge(z) + (y === 0 || y === TOP ? 1 : 0) >= 2 ? 0x9a9c98 : layer(y));
    case PAT.ASPHALT:
      return (x, y, z) => {
        const h = hash01(x, y, z, 217);
        return h < 0.12 ? 0x77767a : h < 0.2 ? shade(layer(y), 0.7) : tone(layer(y), x, y, z, 218);
      };
    case PAT.CORRUGATED:
      return (x, y) => {
        const p = (x + 8) & 3;
        return p < 2 ? shade(layer(y), 1.08) : p === 2 ? layer(y) : shade(layer(y), 0.78);
      };
    case PAT.PAVING:
      return (x, y, z) => (z === 0 || x === LO ? shade(layer(y), 0.7) : tone(layer(y), x, y, z, 219));
    case PAT.PLASTER:
      return (x, y, z) => {
        if (y >= 3 && Math.abs(x * 0.7 + y - 8) < 0.5 && z === HI) return shade(layer(y), 0.7); // hairline crack
        const n = fbm3(x, y, z, 4, 220);
        return n < 0.35 ? shade(layer(y), 1 - vary * 1.4) : n > 0.66 ? shade(layer(y), 1 + vary) : layer(y);
      };
    case PAT.ROOF_TILES:
      return (x, y, z) => {
        const row = (z + 8) % 3;
        const scallop = ((x + 8) & 3) === 0;
        return row === 2 || scallop ? shade(layer(y), 0.72) : row === 0 ? shade(layer(y), 1.1) : layer(y);
      };
    case PAT.METAL:
      return rust((x, y, z) => tone(layer(y), x, y, z, 221), 0.35, 222, 2.5);
    case PAT.FABRIC:
      return (x, y, z) => ((x + y + z) & 1 ? shade(layer(y), 0.88) : layer(y));
    case PAT.WALLPAPER:
      return (x, y, z) => ((x + z + 16) % 4 < 2 ? shade(layer(y), 0.9) : layer(y));
    default:
      return (x, y, z) => tone(layer(y), x, y, z, 223);
  }
}

/** The 10 cm material cube of a block. Origin at the bottom centre. */
export function buildMaterialCube(blockId: number): THREE.BufferGeometry {
  const def = BLOCKS[blockId];
  const s = new Sculpt(LO, 0, LO, HI + 1, TOP + 1, HI + 1);
  const color = patternColor(def.pattern, def.color, def.top ?? def.color, def.bottom ?? def.color, def.vary, def.bottom !== undefined);
  s.box(LO, 0, LO, HI + 1, TOP + 1, HI + 1, color);
  if (def.pattern === PAT.LEAVES) {
    // A ragged leafy outline: some surface cells are missing.
    s.recolor((c, x, y, z) => {
      const surface = onEdge(x) + onEdge(z) + (y === 0 || y === TOP ? 1 : 0);
      return surface > 0 && hash01(x, y, z, 224) < 0.1 * surface ? -1 : c;
    });
  }
  return s.build(0, [0, 0, 0]);
}
