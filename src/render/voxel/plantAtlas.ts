/**
 * Procedural plant atlas, drawn once on a canvas: one 64 × 256 px tile per plant type in
 * PLANT_TILE_BLOCKS order (grass blades, buttercup, daisy, cornflower, fern, reeds, mushroom, dry
 * grass). Used alpha-tested with mipmaps; tiles keep a transparent gutter so mip levels do not bleed.
 * Tile u spans the quad width (1.2 voxels), v the plant height, so each tile is drawn with its own
 * vertical stretch (`aspect`) to keep round shapes round on the quad.
 */
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { B, BLOCKS, PLANT_HEIGHT } from '../../world/blocks';
import { PLANT_HALF_WIDTH, PLANT_TILE_BLOCKS, PLANT_TILE_COUNT } from './layout';

export const PLANT_ATLAS_TILE_W = 64;
export const PLANT_ATLAS_TILE_H = 256;
const W = PLANT_ATLAS_TILE_W;
const H = PLANT_ATLAS_TILE_H;
const GUTTER = 3;
/** Horizontal tile pixels per centimetre of quad width (1 voxel = 10 cm). */
const PX_PER_CM = W / (2 * PLANT_HALF_WIDTH * 10);

type Ctx = CanvasRenderingContext2D;

/** Creates the atlas texture (main thread, needs a DOM canvas). */
export function createPlantAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = W * PLANT_TILE_COUNT;
  canvas.height = H;
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('plant atlas: 2D canvas context unavailable');
  PLANT_TILE_BLOCKS.forEach((id, tile) => {
    g.save();
    g.translate(tile * W, 0);
    g.beginPath();
    g.rect(GUTTER, 0, W - 2 * GUTTER, H);
    g.clip();
    // Pixels per voxel vertically / horizontally on the quad: > 1 means the tile is stretched upwards.
    const aspect = H / PLANT_HEIGHT[id] / (W / (2 * PLANT_HALF_WIDTH));
    drawPlant(g, id, aspect, new Rng(0x9a17 + tile * 101));
    g.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'voxel-plant-atlas';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  // Premultiplied mips keep blade edges from darkening; the shader divides the alpha back out.
  texture.premultiplyAlpha = true;
  texture.anisotropy = 4;
  return texture;
}

function drawPlant(g: Ctx, id: number, aspect: number, rng: Rng): void {
  const color = BLOCKS[id].color;
  switch (id) {
    case B.FLOWER_YELLOW:
    case B.FLOWER_WHITE:
    case B.FLOWER_BLUE:
      drawGrass(g, rng, 0x5f8f36, 8, 0.35, 0.75);
      drawFlowers(g, rng, id, color, aspect);
      return;
    case B.FERN:
      drawFern(g, rng, color);
      return;
    case B.REEDS:
      drawReeds(g, rng, color, aspect);
      return;
    case B.MUSHROOM:
      drawMushroom(g, rng, color, aspect);
      return;
    case B.DRY_GRASS:
      drawGrass(g, rng, color, 15, 0.45, 0.98);
      return;
    default:
      drawGrass(g, rng, color, 16, 0.5, 0.98);
  }
}

function css(hex: number, shade = 1, alpha = 1): string {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * shade));
  const gr = Math.min(255, Math.round(((hex >> 8) & 255) * shade));
  const b = Math.min(255, Math.round((hex & 255) * shade));
  return `rgba(${r},${gr},${b},${alpha})`;
}

/** A tapered, slightly curved blade from the tile bottom. */
function blade(g: Ctx, x: number, height: number, lean: number, width: number, fill: string): void {
  const top = H - height;
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(x - width / 2, H);
  g.quadraticCurveTo(x - width * 0.25 + lean * 0.25, H - height * 0.55, x + lean, top);
  g.quadraticCurveTo(x + width * 0.25 + lean * 0.3, H - height * 0.5, x + width / 2, H);
  g.closePath();
  g.fill();
}

function drawGrass(g: Ctx, rng: Rng, color: number, count: number, minH: number, maxH: number): void {
  for (let i = 0; i < count; i++) {
    blade(g, rng.range(12, W - 12), rng.range(minH, maxH) * H, rng.range(-18, 18), rng.range(4, 7.5), css(color, rng.range(0.72, 1.18)));
  }
}

/** Stems with buttercup, daisy or cornflower heads. */
function drawFlowers(g: Ctx, rng: Rng, id: number, color: number, aspect: number): void {
  const heads = 3;
  for (let i = 0; i < heads; i++) {
    const x = 14 + (i * (W - 28)) / (heads - 1) + rng.range(-4, 4);
    const top = H - rng.range(0.62, 0.92) * H;
    const hx = x + rng.range(-6, 6);
    g.strokeStyle = css(0x4f7a2c, rng.range(0.85, 1.1));
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(x, H);
    g.quadraticCurveTo(x + rng.range(-5, 5), (H + top) / 2, hx, top);
    g.stroke();
    g.save();
    g.translate(hx, top);
    g.scale(1, aspect);
    if (id === B.FLOWER_YELLOW) {
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2 + rng.range(0, 0.4);
        g.fillStyle = css(color, rng.range(0.92, 1.08));
        g.beginPath();
        g.ellipse(Math.cos(a) * 3.2, Math.sin(a) * 3.2, 3.6, 3.2, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = css(0xb08a18);
      g.beginPath();
      g.arc(0, 0, 1.8, 0, Math.PI * 2);
      g.fill();
    } else if (id === B.FLOWER_WHITE) {
      for (let p = 0; p < 12; p++) {
        const a = (p / 12) * Math.PI * 2;
        g.fillStyle = css(color, rng.range(0.94, 1.02));
        g.beginPath();
        g.ellipse(Math.cos(a) * 4.2, Math.sin(a) * 4.2, 3.4, 1.2, a, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = css(0xe2b72a);
      g.beginPath();
      g.arc(0, 0, 2.3, 0, Math.PI * 2);
      g.fill();
    } else {
      for (let p = 0; p < 9; p++) {
        const a = (p / 9) * Math.PI * 2 + rng.range(-0.15, 0.15);
        const r = rng.range(5, 6.5);
        g.fillStyle = css(color, rng.range(0.85, 1.15));
        g.beginPath();
        g.moveTo(Math.cos(a - 0.35) * 1.5, Math.sin(a - 0.35) * 1.5);
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        g.lineTo(Math.cos(a + 0.35) * 1.5, Math.sin(a + 0.35) * 1.5);
        g.closePath();
        g.fill();
      }
      g.fillStyle = css(0x2a2f6a);
      g.beginPath();
      g.arc(0, 0, 1.4, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }
}

/** Arching fronds with alternating leaflets. */
function drawFern(g: Ctx, rng: Rng, color: number): void {
  const fronds = 4;
  for (let f = 0; f < fronds; f++) {
    const side = f % 2 === 0 ? -1 : 1;
    const tipX = W / 2 + side * rng.range(10, 24);
    const tipY = H - rng.range(0.7, 0.97) * H;
    const ctrlX = W / 2 + side * rng.range(0, 8);
    const ctrlY = H - rng.range(0.55, 0.8) * H;
    const baseX = W / 2 + rng.range(-4, 4);
    const shade = rng.range(0.8, 1.15);
    g.strokeStyle = css(color, shade * 0.85);
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(baseX, H);
    g.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
    g.stroke();
    g.fillStyle = css(color, shade);
    for (let t = 0.12; t < 0.97; t += 0.055) {
      const mt = 1 - t;
      const px = mt * mt * baseX + 2 * mt * t * ctrlX + t * t * tipX;
      const py = mt * mt * H + 2 * mt * t * ctrlY + t * t * tipY;
      const len = 3 + 9 * (1 - t);
      for (const dir of [-1, 1]) {
        g.beginPath();
        g.ellipse(px + dir * len * 0.5, py + 1.5, len * 0.55, 1.6, dir * 0.35, 0, Math.PI * 2);
        g.fill();
      }
    }
  }
}

/** Tall stalks, long leaves and brown cattail heads. */
function drawReeds(g: Ctx, rng: Rng, color: number, aspect: number): void {
  for (let i = 0; i < 4; i++) {
    blade(g, rng.range(10, W - 10), rng.range(0.55, 0.9) * H, rng.range(-14, 14), rng.range(3, 5), css(color, rng.range(0.8, 1.1)));
  }
  for (let i = 0; i < 5; i++) {
    const x = rng.range(14, W - 14);
    const top = H - rng.range(0.82, 0.99) * H;
    const lean = rng.range(-4, 4);
    g.strokeStyle = css(color, rng.range(0.85, 1.05));
    g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x + lean, top);
    g.stroke();
    if (i < 2) {
      // Cattail: ~2 cm wide, ~12 cm long spike just under the stalk tip.
      const halfLen = 6 * PX_PER_CM * aspect;
      g.fillStyle = css(0x5a3a22, rng.range(0.9, 1.1));
      g.beginPath();
      g.ellipse(x + lean * 0.9, top + halfLen + 4, PX_PER_CM, halfLen, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
}

/** Stem and a rounded brown cap with pale spots, standing on the tile bottom. */
function drawMushroom(g: Ctx, rng: Rng, color: number, aspect: number): void {
  const stemTop = H - Math.min(0.55 * H, 4.5 * PX_PER_CM * aspect);
  g.fillStyle = css(0xe6dcc4);
  g.beginPath();
  g.moveTo(W / 2 - 5, H);
  g.lineTo(W / 2 - 4, stemTop);
  g.lineTo(W / 2 + 4, stemTop);
  g.lineTo(W / 2 + 5, H);
  g.closePath();
  g.fill();
  const capRx = 3.5 * PX_PER_CM;
  const capRy = Math.min(stemTop - 4, 2.2 * PX_PER_CM * aspect);
  g.fillStyle = css(color);
  g.beginPath();
  g.ellipse(W / 2, stemTop + 2, capRx, capRy, 0, Math.PI, Math.PI * 2);
  g.closePath();
  g.fill();
  g.fillStyle = css(0x4a3020);
  g.fillRect(W / 2 - capRx + 2, stemTop, capRx * 2 - 4, 3);
  g.fillStyle = css(0xf0e6d0, 1, 0.85);
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.ellipse(W / 2 + rng.range(-14, 14), stemTop - rng.range(0.25, 0.75) * capRy, 2.2, 2.2 * aspect, 0, 0, Math.PI * 2);
    g.fill();
  }
}
