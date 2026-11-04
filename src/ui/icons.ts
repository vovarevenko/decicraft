/**
 * Item icons rendered from the voxel models (render/models) with a small offscreen three.js
 * renderer, cached as data URLs. OWNER: agent "items-ui".
 *
 * One lazily created 64×64 WebGLRenderer (alpha, preserveDrawingBuffer) draws getItemGeometry(id) with
 * the shared model material in an orthographic 3/4 view fitted to the model's projected vertices, lit
 * by a hemisphere light and a key light from the upper left; long items (tools, sticks, torches) are
 * tilted 45° on screen. Any failure (no WebGL, missing or broken model) yields a generated fallback — a
 * rounded square in the block colour for materials, neutral otherwise, with the first letter of the
 * item name — which is cached like a rendered icon.
 */
import * as THREE from 'three';
import { ITEMS } from '../game/items';
import { getItemGeometry } from '../render/models';
import { getModelMaterial } from '../render/voxelModel';
import { BLOCKS } from '../world/blocks';

const ICON_SIZE = 64;
/** Direction from the model towards the camera: azimuth 45° (front right), ~30° above the horizon. */
const VIEW_DIR = new THREE.Vector3(1, 0.82, 1).normalize();
/** Models at least this many times taller than wide are drawn diagonally. */
const LONG_ASPECT = 1.8;
/** Empty border around the fitted model, as a fraction of the icon size. */
const MARGIN = 0.07;
/** Fallback colour for non-material items. */
const NEUTRAL_COLOR = 0x6b717c;

interface IconStage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  mesh: THREE.Mesh;
}

const cache = new Map<string, string>();
let stage: IconStage | null = null;
let stageFailed = false;
/** Rotation about the view axis that turns a vertical model into a bottom-left → top-right diagonal. */
const DIAGONAL = new THREE.Quaternion().setFromAxisAngle(VIEW_DIR, -Math.PI / 4);
const UPRIGHT = new THREE.Quaternion();
const tmp = new THREE.Vector3();
const modelView = new THREE.Matrix4();

/** Data URL of a 64×64 icon for the item (rendered on first request, then cached). */
export function getItemIcon(itemId: string): string {
  let url = cache.get(itemId);
  if (url === undefined) {
    url = renderIcon(itemId) ?? fallbackIcon(itemId);
    cache.set(itemId, url);
  }
  return url;
}

/**
 * Renders the icons of `ids` ahead of time, a few per idle period, so that opening the inventory
 * never stalls on icon rendering. The model shader is compiled first, in the background.
 */
export function warmItemIcons(ids: readonly string[]): void {
  const queue = ids.filter((id) => !cache.has(id));
  if (queue.length === 0) return;
  const step = (deadline?: IdleDeadline): void => {
    do {
      const id = queue.shift();
      if (id === undefined) return;
      getItemIcon(id);
    } while (queue.length > 0 && deadline !== undefined && !deadline.didTimeout && deadline.timeRemaining() > 6);
    if (queue.length > 0) whenIdle(step);
  };
  whenIdle(() => {
    const s = getStage();
    if (s === null) {
      whenIdle(step);
      return;
    }
    try {
      s.mesh.geometry = getItemGeometry(queue[0]);
    } catch {
      // That item falls back to a generated icon; the program compiled for the empty geometry is the same.
    }
    s.renderer.compileAsync(s.scene, s.camera).then(
      () => whenIdle(step),
      () => whenIdle(step),
    );
  });
}

function whenIdle(fn: (deadline?: IdleDeadline) => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1500 });
  else setTimeout(fn, 30);
}

function getStage(): IconStage | null {
  if (stage === null && !stageFailed) {
    try {
      stage = createStage();
    } catch (e) {
      stageFailed = true;
      console.warn('[icons] offscreen WebGL renderer unavailable, using generated icons', e);
    }
  }
  return stage;
}

function createStage(): IconStage {
  const material = getModelMaterial();
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(ICON_SIZE, ICON_SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;

  // Physical light units: a white face lit head-on with intensity π reflects 1. These give roughly
  // top 1.0 / left 0.7 / right 0.4 — readable block shading.
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8c8f99, 1.7));
  const key = new THREE.DirectionalLight(0xfff3e2, 2.0);
  key.position.set(-0.3, 1, 0.75); // upper left as seen from VIEW_DIR; the target stays at the origin
  scene.add(key);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
  camera.position.copy(VIEW_DIR).multiplyScalar(200);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { renderer, scene, camera, mesh };
}

function renderIcon(itemId: string): string | null {
  const s = getStage();
  if (s === null) return null;
  try {
    if (!frameModel(s, getItemGeometry(itemId))) return null;
    s.renderer.render(s.scene, s.camera);
    return s.renderer.domElement.toDataURL('image/png');
  } catch (e) {
    console.warn(`[icons] cannot render "${itemId}", using a generated icon`, e);
    return null;
  }
}

/** Puts the model on stage (long items tilted) and fits the orthographic frustum to its projected vertices. */
function frameModel(s: IconStage, geometry: THREE.BufferGeometry): boolean {
  const pos = geometry.getAttribute('position');
  if (!pos || pos.count === 0) return false;
  if (geometry.boundingBox === null) geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(tmp);
  const long = size.y > LONG_ASPECT * Math.max(size.x, size.z);

  s.mesh.geometry = geometry;
  s.mesh.quaternion.copy(long ? DIAGONAL : UPRIGHT);
  s.mesh.updateMatrixWorld(true);
  modelView.multiplyMatrices(s.camera.matrixWorldInverse, s.mesh.matrixWorld);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    tmp.fromBufferAttribute(pos, i).applyMatrix4(modelView);
    if (tmp.x < minX) minX = tmp.x;
    if (tmp.x > maxX) maxX = tmp.x;
    if (tmp.y < minY) minY = tmp.y;
    if (tmp.y > maxY) maxY = tmp.y;
  }
  const half = Math.max(maxX - minX, maxY - minY) / 2 / (1 - 2 * MARGIN);
  if (!(half > 0)) return false;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cam = s.camera;
  cam.left = cx - half;
  cam.right = cx + half;
  cam.top = cy + half;
  cam.bottom = cy - half;
  cam.updateProjectionMatrix();
  return true;
}

/** Rounded square in the block colour (materials) or a neutral colour, with the name's first letter. */
function fallbackIcon(itemId: string): string {
  const def = ITEMS[itemId];
  const block = def?.block !== undefined ? BLOCKS[def.block] : undefined;
  const fill = block ? (block.top ?? block.color) : NEUTRAL_COLOR;
  const r = (fill >> 16) & 255;
  const g = (fill >> 8) & 255;
  const b = fill & 255;
  const ink = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? '#1f2227' : '#f3f4f6';
  const letter = escapeXml(((def?.name ?? itemId).trim().charAt(0) || '?').toUpperCase());
  const svgText =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 64 64">` +
    `<rect x="7" y="7" width="50" height="50" rx="11" fill="#${fill.toString(16).padStart(6, '0')}" ` +
    `stroke="rgba(0,0,0,0.45)" stroke-width="2"/>` +
    `<text x="32" y="32" dy="0.35em" text-anchor="middle" fill="${ink}" font-size="26" font-weight="700" ` +
    `font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
