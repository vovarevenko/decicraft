/**
 * Map screen (M): top-down shaded map of the 128 m world rendered once from world data
 * (top block colour per column + hill shading from sky heights), updated incrementally from
 * world.onChange; player arrow, landmarks (plan.landmarks), biome legend, scale bar.
 * OWNER: agent "items-ui".
 *
 * The 640×640 base image (1 px = 2×2 columns, see mapRaster.ts) is drawn in init(). world.onChange
 * queues edited chunk columns; update() redraws a few of them at a time (throttled, also while the map
 * is closed) and opening the map redraws everything still pending. The overlay — landmarks, rotated
 * player arrow, north arrow, «10 м» scale bar — is DOM on top of the canvas; the side panel holds the
 * player's coordinates and the legend of the four regions.
 */
import { BIOME_NAMES, CHUNK, CHUNKS_X, CHUNKS_Z, UNITS_PER_M, WORLD_X, WORLD_Z } from '../config';
import type { GameContext } from '../game/context';
import type { Landmark } from '../gen/types';
import type { World } from '../world/world';
import { el, svg } from './dom';
import { formatDecimal } from './format';
import { MAP_H, MAP_SCALE, MAP_SHADE_REACH, MAP_W, rasterizeMap } from './mapRaster';

/** Chunk-column keys: chunk key modulo this = cx + cz·CHUNKS_X. */
const COLUMN_KEYS = CHUNKS_X * CHUNKS_Z;
/** Map pixels per chunk edge. */
const CHUNK_PX = CHUNK / MAP_SCALE;
/** Pending chunk columns redrawn per batch, and the pause between batches (ms), while open / closed. */
const BATCH_OPEN = 24;
const BATCH_CLOSED = 4;
const INTERVAL_OPEN_MS = 200;
const INTERVAL_CLOSED_MS = 400;
const SCALE_BAR_M = 10;

/** Legend in the quadrant layout of the map (config.ts: NW town, NE forest, SW meadow, SE hills). */
const REGIONS: readonly { biome: number; corner: string; color: string }[] = [
  { biome: 0, corner: 'СЗ', color: '#76736e' },
  { biome: 1, corner: 'СВ', color: '#3f6a2a' },
  { biome: 2, corner: 'ЮЗ', color: '#729c45' },
  { biome: 3, corner: 'ЮВ', color: '#8f8a83' },
];

export class MapView {
  private readonly layer: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly landmarks: HTMLDivElement;
  private readonly arrow: HTMLDivElement;
  private readonly coords: HTMLDivElement;
  private g: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;
  private world: World | null = null;
  private ctx: GameContext | null = null;
  private readonly pending = new Set<number>();
  private nextRedrawAt = 0;
  private opened = false;
  /** Set when opened: the frame that opened the map must not also close it. */
  private freshOpen = false;
  private arrowX = -1;
  private arrowZ = -1;
  private arrowDeg = 1e9;
  private coordX = -1;
  private coordZ = -1;

  constructor(root: HTMLElement) {
    this.layer = el('div', 'map-layer');
    this.layer.hidden = true;
    const panel = el('div', 'map-panel');

    const closeButton = el('button', 'ui-close', '✕');
    closeButton.type = 'button';
    closeButton.title = 'Закрыть';
    // Closing from a click keeps the user gesture, so re-locking the pointer succeeds.
    closeButton.addEventListener('click', () => {
      if (this.ctx !== null) this.close(this.ctx);
    });

    const frame = el('div', 'map-frame');
    this.canvas = el('canvas', 'map-canvas');
    this.canvas.width = MAP_W;
    this.canvas.height = MAP_H;
    this.landmarks = el('div', 'map-landmarks');
    this.arrow = el('div', 'map-arrow');
    this.arrow.append(arrowIcon());

    const north = el('div', 'map-north');
    const northSvg = svg('svg', { viewBox: '0 0 20 24', width: 16, height: 19 });
    northSvg.append(svg('path', { d: 'M10 1 L18 22 L10 17 L2 22 Z' }));
    north.append(northSvg, el('span', '', 'С'));

    const scale = el('div', 'map-scale');
    scale.style.width = `${((SCALE_BAR_M * UNITS_PER_M) / WORLD_X) * 100}%`;
    scale.append(el('div', 'map-scale-bar'), el('span', 'map-scale-label', `${SCALE_BAR_M} м`));

    frame.append(this.canvas, this.landmarks, this.arrow, north, scale);

    const side = el('div', 'map-side');
    this.coords = el('div', 'map-coords');
    const legend = el('div', 'map-regions');
    for (const region of REGIONS) {
      const cell = el('div', 'map-region');
      const swatch = el('span', 'map-swatch');
      swatch.style.background = region.color;
      const text = el('span', 'map-region-text');
      text.append(el('span', 'map-region-name', BIOME_NAMES[region.biome]), el('span', 'map-region-corner', region.corner));
      cell.append(swatch, text);
      legend.append(cell);
    }
    const keyYou = el('div', 'map-key');
    keyYou.append(arrowIcon(), el('span', '', 'вы и направление взгляда'));
    const keyPlace = el('div', 'map-key');
    keyPlace.append(el('span', 'map-key-dot'), el('span', '', 'ориентир'));
    side.append(
      el('h2', 'map-title', 'Карта'),
      this.coords,
      el('div', 'map-subtitle', 'Области'),
      legend,
      el('div', 'map-subtitle', 'Обозначения'),
      keyYou,
      keyPlace,
      el('div', 'map-help', 'M или Esc — закрыть'),
    );

    panel.append(closeButton, frame, side);
    this.layer.append(panel);
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());
    root.append(this.layer);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Builds the base image (call once after world generation). */
  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.buildLandmarks(ctx.plan.landmarks);
    if (this.world !== ctx.world) {
      this.world = ctx.world;
      ctx.world.onChange((keys) => {
        for (const key of keys) this.pending.add(key % COLUMN_KEYS);
      });
    }
    this.g ??= this.canvas.getContext('2d');
    if (this.g === null) return; // no 2D canvas: the map stays blank, the overlay still works
    this.image ??= this.g.createImageData(MAP_W, MAP_H);
    const t0 = performance.now();
    rasterizeMap(ctx.world, this.image.data, 0, 0, MAP_W, MAP_H);
    this.g.putImageData(this.image, 0, 0);
    this.pending.clear();
    console.info(`[map] base image ${(performance.now() - t0).toFixed(0)} ms`);
  }

  /** Opens/closes the map; calls ctx.input.setUiOpen(open). KeyM is handled by game.ts. */
  toggle(ctx: GameContext): void {
    if (this.opened) this.close(ctx);
    else this.open(ctx);
  }

  /** Per-frame while open: player marker, pending incremental redraws; closes on input.consume('Escape'). */
  update(ctx: GameContext): void {
    this.ctx = ctx;
    if (this.pending.size > 0) {
      const now = performance.now();
      if (now >= this.nextRedrawAt) {
        this.redrawPending(this.opened ? BATCH_OPEN : BATCH_CLOSED);
        this.nextRedrawAt = now + (this.opened ? INTERVAL_OPEN_MS : INTERVAL_CLOSED_MS);
      }
    }
    if (!this.opened) return;
    if (this.freshOpen) {
      this.freshOpen = false;
    } else if (ctx.input.consume('Escape')) {
      this.close(ctx);
      return;
    }
    this.updatePlayer(ctx);
  }

  private open(ctx: GameContext): void {
    this.ctx = ctx;
    this.opened = true;
    this.freshOpen = true;
    this.redrawPending(Infinity);
    this.layer.hidden = false;
    this.updatePlayer(ctx);
    ctx.input.setUiOpen(true);
  }

  private close(ctx: GameContext): void {
    if (!this.opened) return;
    this.opened = false;
    this.layer.hidden = true;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.layer.contains(focused)) focused.blur();
    ctx.input.setUiOpen(false);
  }

  /** Redraws up to `maxColumns` queued chunk columns, each with the rim whose hillshade they affect. */
  private redrawPending(maxColumns: number): void {
    const { g, image, world } = this;
    if (g === null || image === null || world === null) {
      this.pending.clear();
      return;
    }
    let done = 0;
    for (const column of this.pending) {
      if (done >= maxColumns) break;
      this.pending.delete(column);
      const cx = column % CHUNKS_X;
      const cz = (column - cx) / CHUNKS_X;
      const px0 = Math.max(0, cx * CHUNK_PX - MAP_SHADE_REACH);
      const pz0 = Math.max(0, cz * CHUNK_PX - MAP_SHADE_REACH);
      const px1 = Math.min(MAP_W, (cx + 1) * CHUNK_PX + MAP_SHADE_REACH);
      const pz1 = Math.min(MAP_H, (cz + 1) * CHUNK_PX + MAP_SHADE_REACH);
      rasterizeMap(world, image.data, px0, pz0, px1, pz1);
      g.putImageData(image, 0, 0, px0, pz0, px1 - px0, pz1 - pz0);
      done++;
    }
  }

  /** Player arrow (rotated by yaw: 0 looks north = up) and coordinates; DOM writes only on change. */
  private updatePlayer(ctx: GameContext): void {
    const p = ctx.player.position;
    const x = Math.min(100, Math.max(0, (p.x / WORLD_X) * 100));
    const z = Math.min(100, Math.max(0, (p.z / WORLD_Z) * 100));
    // Seen from above, positive yaw turns counter-clockwise; CSS rotation is clockwise.
    const deg = (-ctx.player.yaw * 180) / Math.PI;
    if (Math.abs(x - this.arrowX) > 0.02 || Math.abs(z - this.arrowZ) > 0.02 || Math.abs(deg - this.arrowDeg) > 0.25) {
      this.arrowX = x;
      this.arrowZ = z;
      this.arrowDeg = deg;
      const s = this.arrow.style;
      s.left = `${x}%`;
      s.top = `${z}%`;
      s.transform = `translate(-50%, -50%) rotate(${deg.toFixed(1)}deg)`;
    }
    const mx = Math.round(p.x) / UNITS_PER_M;
    const mz = Math.round(p.z) / UNITS_PER_M;
    if (mx !== this.coordX || mz !== this.coordZ) {
      this.coordX = mx;
      this.coordZ = mz;
      this.coords.textContent = `X ${formatDecimal(mx, 1)} м · Z ${formatDecimal(mz, 1)} м`;
    }
  }

  private buildLandmarks(list: readonly Landmark[]): void {
    this.landmarks.replaceChildren();
    for (const landmark of list) {
      const mark = el('div', 'map-landmark');
      mark.style.left = `${Math.min(97, Math.max(3, (landmark.x / WORLD_X) * 100))}%`;
      mark.style.top = `${Math.min(97, Math.max(3, (landmark.z / WORLD_Z) * 100))}%`;
      mark.append(el('span', 'map-landmark-dot'), el('span', 'map-landmark-label', landmark.name));
      this.landmarks.append(mark);
    }
  }
}

/** Arrowhead pointing up (north), used for the player marker and its legend entry. */
function arrowIcon(): SVGSVGElement {
  const icon = svg('svg', { class: 'map-arrow-icon', viewBox: '0 0 24 24', width: 22, height: 22 });
  icon.append(svg('path', { d: 'M12 2 L20 21 L12 16.5 L4 21 Z' }));
  return icon;
}
