/**
 * Tiny 5×7 bitmap font for voxel shop signs («ПРОДУКТЫ», «ПОЧТА», the bus-stop «А»).
 */

export const GLYPH_W = 5;
export const GLYPH_H = 7;
/** Horizontal gap between letters. */
export const GLYPH_GAP = 1;

// Rows top → bottom, '#' = filled.
// prettier-ignore
const FONT: Record<string, readonly string[]> = {
  'А': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'Д': ['.###.', '.#.#.', '.#.#.', '.#.#.', '.#.#.', '#####', '#...#'],
  'К': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  'О': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  'П': ['#####', '#...#', '#...#', '#...#', '#...#', '#...#', '#...#'],
  'Р': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Т': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'У': ['#...#', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
  'Ч': ['#...#', '#...#', '#...#', '.####', '....#', '....#', '....#'],
  'Ы': ['#...#', '#...#', '#...#', '###.#', '#.#.#', '#.#.#', '###.#'],
};

/** Width in voxels of a rendered string. */
export const textWidth = (text: string): number => text.length * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP;

/**
 * Calls `cell(col, row)` for every filled voxel of `text` (col from the left, row from the top).
 * Unknown characters render as blanks.
 */
export function forEachTextCell(text: string, cell: (col: number, row: number) => void): void {
  for (let i = 0; i < text.length; i++) {
    const g = FONT[text[i]];
    if (!g) continue;
    const ox = i * (GLYPH_W + GLYPH_GAP);
    for (let row = 0; row < GLYPH_H; row++) {
      const line = g[row];
      for (let col = 0; col < GLYPH_W; col++) if (line[col] === '#') cell(ox + col, row);
    }
  }
}
