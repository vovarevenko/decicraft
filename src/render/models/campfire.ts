/**
 * Campfire (Ø ~62 cm, ~36 cm tall): a ring of half-buried stones and a teepee of five logs. The world
 * model (1 cm voxels) is lit — ash bed with glowing embers, charred log feet, soot on the stones (no
 * flames: particles do that); the item model is the same fire laid but unlit, at 2 cm voxels to keep
 * it light. Colours are coherent patches (no per-cell jitter) so faces merge. Origin at the bottom
 * centre.
 */
import type * as THREE from 'three';
import { fbm3, hash01, noise3, shade } from './palette';
import { Sculpt } from './sculpt';

const TAU = Math.PI * 2;
const EMBERS = [0xff7a1f, 0xd9481a, 0xffb040, 0x9a2a12] as const;
const STONE_BASES = [0x8a877f, 0x7a766f, 0x9b968c, 0x6d6a64, 0x948a80] as const;

/**
 * @param lit   burning fire (world entity) or a fire laid (inventory item)
 * @param cellCm voxel edge in centimetres (1 for the world model, 2 for the item)
 */
export function buildCampfire(lit: boolean, cellCm = 1): THREE.BufferGeometry {
  const k = 1 / cellCm; // cells per centimetre
  const ext = Math.ceil(32 * k);
  const s = new Sculpt(-ext, 0, -ext, ext, Math.ceil(38 * k), ext);
  const patch = (base: number, x: number, y: number, z: number, seed: number): number => {
    const n = fbm3(x, y, z, 3 * k, seed);
    return n < 0.38 ? shade(base, 0.86) : n > 0.64 ? shade(base, 1.1) : base;
  };

  if (lit) {
    s.sdf(
      (x, y, z) => (y > k ? 1 : Math.hypot(x, z) - 19 * k - (noise3(x, 0, z, 4 * k, 302) - 0.5) * 3 * k),
      (x, y, z) => {
        const r = Math.hypot(x + 0.5, z + 0.5);
        const h = hash01(x, y, z, 303);
        if (r < 9 * k && h < 0.4) return EMBERS[Math.floor(h * 10) & 3];
        return h > 0.92 ? 0x2a2624 : patch(0x85827d, x, y, z, 301); // ash with charcoal bits
      },
      [-ext, 0, -ext, ext, Math.ceil(k), ext],
    );
  }

  // Ring of stones, each an ellipsoid along the ring, roughened by noise, sooty on the fire side.
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * TAU + (hash01(i, 0, 0, 304) - 0.5) * 0.25;
    const r = (24.5 + (hash01(i, 1, 0, 304) - 0.5) * 2.5) * k;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r;
    const rx = (5 + hash01(i, 2, 0, 304) * 1.5) * k;
    const ry = (4 + hash01(i, 3, 0, 304) * 2) * k;
    const rz = (5.5 + hash01(i, 4, 0, 304) * 1.8) * k;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const base = STONE_BASES[i % STONE_BASES.length];
    const e = Math.ceil(Math.max(rx, rz) + 2);
    s.sdf(
      (x, y, z) => {
        const dx = x - cx;
        const dz = z - cz;
        const u = dx * ca + dz * sa;
        const v = -dx * sa + dz * ca;
        return Math.hypot(u / rx, (y - ry * 0.45) / ry, v / rz) - 1 + (noise3(x, y, z, 3 * k, 305 + i) - 0.5) * 0.3;
      },
      (x, y, z) => {
        const tone = patch(base, x, y, z, 306 + i);
        const inward = (x + 0.5 - cx) * ca + (z + 0.5 - cz) * sa < -1.5 * k;
        return lit && inward && y < 6 * k ? shade(tone, 0.55) : tone;
      },
      [Math.floor(cx - e), 0, Math.floor(cz - e), Math.ceil(cx + e), Math.ceil(ry * 1.6), Math.ceil(cz + e)],
    );
  }

  // Teepee: five logs from the ring to a crossing above the centre; bark in streaks along each log.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU + 0.3;
    const foot: [number, number, number] = [Math.cos(a) * 17 * k, 2.5 * k, Math.sin(a) * 17 * k];
    const head: [number, number, number] = [-Math.cos(a + 0.35) * 3.2 * k, 33 * k, -Math.sin(a + 0.35) * 3.2 * k];
    const dx = head[0] - foot[0];
    const dy = head[1] - foot[1];
    const dz = head[2] - foot[2];
    const len2 = dx * dx + dy * dy + dz * dz;
    s.capsule(foot, head, 3.1 * k, 2.7 * k, (x, y, z) => {
      const t = ((x + 0.5 - foot[0]) * dx + (y + 0.5 - foot[1]) * dy + (z + 0.5 - foot[2]) * dz) / len2;
      if (t > 0.97) return (x + z) & 1 ? 0xc8a878 : 0xb39064; // cut end
      if (lit && t < 0.4) {
        const h = hash01(x, y, z, 312);
        if (h < 0.14 * (1 - t / 0.4)) return EMBERS[Math.floor(h * 40) & 3];
        return h < 0.6 ? 0x231c17 : 0x35291f;
      }
      const run = hash01(Math.floor(t * 9), (x + y + z) & 3, i, 307);
      return run < 0.3 ? 0x544232 : run > 0.8 ? 0x6a5440 : 0x5e4a38;
    });
  }
  return s.build(0, [0, 0, 0], 0.1 * cellCm);
}
