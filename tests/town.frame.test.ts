import { describe, expect, test } from 'vitest';
import { BuildingBuilder, type Side } from '../src/gen/town/building';
import { Frame, type LocalDir } from '../src/gen/town/frame';
import type { LotPlan } from '../src/gen/town/layout';
import type { Facing } from '../src/gen/types';

const FACINGS: Facing[] = [0, 1, 2, 3];
const OUT: Record<Facing, [number, number]> = { 0: [0, 1], 1: [1, 0], 2: [0, -1], 3: [-1, 0] };

describe('local frames', () => {
  test('voxel, point and box mappings agree and stay inside the footprint', () => {
    for (const f of FACINGS) {
      const fr = new Frame(100, 200, 12, 7, f);
      const seen = new Set<string>();
      for (let v = 0; v < 7; v++) {
        for (let u = 0; u < 12; u++) {
          const x = fr.wx(u, v);
          const z = fr.wz(u, v);
          expect(x >= fr.x0 && x < fr.x1 && z >= fr.z0 && z < fr.z1).toBe(true);
          const r = fr.box(u, v, u + 1, v + 1);
          expect([r.x0, r.z0]).toEqual([x, z]);
          expect(fr.px(u + 0.5, v + 0.5)).toBeCloseTo(x + 0.5);
          expect(fr.pz(u + 0.5, v + 0.5)).toBeCloseTo(z + 0.5);
          expect(fr.lu(x + 0.5, z + 0.5)).toBeCloseTo(u + 0.5);
          seen.add(`${x},${z}`);
        }
      }
      expect(seen.size).toBe(84);
    }
  });

  test('the front (v = 0) faces `facing` and u runs to the right of a viewer outside (no mirroring)', () => {
    const n = (v: number) => v + 0; // normalises −0
    for (const f of FACINGS) {
      const fr = new Frame(0, 0, 10, 10, f);
      const [ox, oz] = OUT[f];
      expect([fr.dirX(2), fr.dirZ(2)].map(n)).toEqual([ox, oz]);
      expect(fr.facingOf(2)).toBe(f);
      // The viewer looks along (−ox, −oz); with +Y up and +Z south their right is (−dz, dx) = (oz, −ox).
      expect([fr.dirX(1), fr.dirZ(1)].map(n)).toEqual([oz, -ox].map(n));
    }
  });
});

describe('door spawns', () => {
  const lot = (facing: Facing): LotPlan => {
    const frame = new Frame(200, 200, 60, 50, facing);
    return { type: 'wooden_house', area: frame.rect, facing, frame, setback: 20, roomLeft: 30, roomRight: 30, fenced: false, landmark: null };
  };

  test('exterior doors swing into the building, opening boxes match the spawn, hinges map to the right end', () => {
    for (const f of FACINGS) {
      for (const side of ['front', 'back', 'left', 'right'] as Side[]) {
        const b = new BuildingBuilder(lot(f), 7);
        b.t = 3;
        b.exteriorDoor(side, 20, 'wood', false, 9, 20, 'start');
        const d = b.doors[0];
        const cx = (b.f.x0 + b.f.x1) / 2;
        const cz = (b.f.z0 + b.f.z1) / 2;
        const w = d.axis === 'x' ? d.width : d.depth;
        const l = d.axis === 'x' ? d.depth : d.width;
        expect(d.depth).toBe(3);
        expect(d.width).toBe(9);
        // Opening centre + swing direction along the wall normal moves towards the building centre.
        const ox = d.x + w / 2;
        const oz = d.z + l / 2;
        const nx = d.axis === 'z' ? d.swing : 0;
        const nz = d.axis === 'x' ? d.swing : 0;
        expect(Math.hypot(ox + nx * 5 - cx, oz + nz * 5 - cz)).toBeLessThan(Math.hypot(ox - cx, oz - cz));
        // 'start' = the low-u (or low-v) end of the opening in local space.
        const along = side === 'front' || side === 'back';
        const startWorld = along ? [b.f.px(20, side === 'front' ? 0 : 50), b.f.pz(20, side === 'front' ? 0 : 50)] : [b.f.px(side === 'left' ? 0 : 60, 20), b.f.pz(side === 'left' ? 0 : 60, 20)];
        const hingeAt = d.axis === 'x' ? (d.hinge === 'min' ? d.x : d.x + d.width) : d.hinge === 'min' ? d.z : d.z + d.width;
        expect(hingeAt).toBe(d.axis === 'x' ? startWorld[0] : startWorld[1]);
      }
    }
  });

  test('interior doors swing towards the requested side', () => {
    for (const f of FACINGS) {
      for (const into of [0, 1, 2, 3] as LocalDir[]) {
        const b = new BuildingBuilder(lot(f), 3);
        const alongU = into === 0 || into === 2;
        const p = alongU ? b.partition(0, 3, 20, 57, 22, 37) : b.partition(0, 30, 3, 32, 47, 37);
        b.interiorDoor(p, 0, 10, into);
        const d = b.doors[0];
        const sx = d.axis === 'z' ? d.swing : 0;
        const sz = d.axis === 'x' ? d.swing : 0;
        expect([sx, sz].map((v) => v + 0)).toEqual([b.f.dirX(into), b.f.dirZ(into)].map((v) => v + 0));
      }
    }
  });
});
