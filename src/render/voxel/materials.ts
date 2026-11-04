/**
 * Materials for voxel world meshes. OWNER: agent "render-core". Spec: ARCHITECTURE.md §6.1.
 * Built on three's lit materials (via onBeforeCompile) so fog, the sun's shadow map, hemisphere
 * light and the pooled point/spot lights all work; they add per-voxel colour variation, procedural
 * PAT.* patterns, vertex AO and the skylight term. All share `sharedUniforms` (render/sharedUniforms.ts).
 * Every material overrides customProgramCacheKey() with a unique string (three otherwise keys programs
 * by onBeforeCompile.toString(), and two materials patched by one closure would share a program).
 * Beyond the shadow box the sun is not shadowed, so the sun/moon light is additionally scaled towards
 * the per-vertex skylight term with distance: sun *= mix(1, sky, smoothstep(0.75·E, E, dist_xz)) with
 * E = RENDER.shadowExtent (no bright ring under trees/roofs at the shadow distance). Only the
 * directional light is scaled, inside three's light loop: point and spot lights are not sky-occluded.
 */
import * as THREE from 'three';
import { RENDER } from '../../config';
import { COLOR_BOTTOM, COLOR_SIDE, COLOR_TOP, PATTERN, VARY } from '../../world/blocks';
import { sharedUniforms } from '../sharedUniforms';
import { PLANT_ATLAS_TILE_H, PLANT_ATLAS_TILE_W, createPlantAtlas } from './plantAtlas';
import { GLASS_SHADER, OPAQUE_SHADER, PLANT_SHADER, WATER_SHADER, type ShaderParts } from './shaders';
import { PLANT_TILE_COUNT } from './layout';

export interface VoxelMaterials {
  opaque: THREE.Material;
  glass: THREE.Material;
  water: THREE.Material;
  plants: THREE.Material;
}

let materials: VoxelMaterials | null = null;

/** Lazily creates (once) and returns the shared voxel materials. */
export function getVoxelMaterials(): VoxelMaterials {
  if (materials === null) materials = createMaterials();
  return materials;
}

function createMaterials(): VoxelMaterials {
  const blocks = { value: createBlockTexture() };
  const env = {
    uTime: sharedUniforms.uTime,
    uSunDir: sharedUniforms.uSunDir,
    uDaylight: sharedUniforms.uDaylight,
    uHorizonColor: sharedUniforms.uHorizonColor,
  };

  const opaque = new THREE.MeshLambertMaterial({ color: 0xffffff });
  patchMaterial(opaque, 'voxel-opaque', OPAQUE_SHADER, { uVoxBlocks: blocks, uVoxShadowExtent: { value: RENDER.shadowExtent } });

  const glass = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
  patchMaterial(glass, 'voxel-glass', GLASS_SHADER, { uVoxBlocks: blocks, ...env });

  // Double-sided so the surface is visible from below; one pass keeps it one draw call and one program.
  const water = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, forceSinglePass: true });
  patchMaterial(water, 'voxel-water', WATER_SHADER, { uVoxBlocks: blocks, ...env });

  const plants = new THREE.MeshLambertMaterial({ color: 0xffffff, map: createPlantAtlas(), alphaTest: 0.5, side: THREE.DoubleSide });
  patchMaterial(plants, 'voxel-plants', PLANT_SHADER, {
    uTime: sharedUniforms.uTime,
    uPlantFadeEnd: { value: RENDER.plantFadeEnd },
    uPlantAtlasSize: { value: new THREE.Vector2(PLANT_ATLAS_TILE_W * PLANT_TILE_COUNT, PLANT_ATLAS_TILE_H) },
  });

  return { opaque, glass, water, plants };
}

/**
 * Block table for the shaders, 256 × 4 RGBA8 texels indexed (block id, row): row 0 side colour,
 * row 1 top colour, row 2 bottom colour (sRGB), row 3 = (vary · 255, PAT id, 0, 0).
 */
function createBlockTexture(): THREE.DataTexture {
  const data = new Uint8Array(256 * 4 * 4);
  for (let id = 0; id < 256; id++) {
    for (let c = 0; c < 3; c++) {
      data[id * 4 + c] = COLOR_SIDE[id * 3 + c];
      data[(256 + id) * 4 + c] = COLOR_TOP[id * 3 + c];
      data[(512 + id) * 4 + c] = COLOR_BOTTOM[id * 3 + c];
    }
    data[id * 4 + 3] = 255;
    data[(256 + id) * 4 + 3] = 255;
    data[(512 + id) * 4 + 3] = 255;
    data[(768 + id) * 4] = VARY[id];
    data[(768 + id) * 4 + 1] = PATTERN[id];
  }
  const texture = new THREE.DataTexture(data, 256, 4, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.name = 'voxel-blocks';
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function patchMaterial(material: THREE.MeshLambertMaterial, key: string, parts: ShaderParts, uniforms: Record<string, THREE.IUniform>): void {
  material.name = key;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchVertexShader(shader.vertexShader, parts);
    shader.fragmentShader = patchFragmentShader(shader.fragmentShader, parts);
  };
  material.customProgramCacheKey = () => key;
}

function patchVertexShader(src: string, p: ShaderParts): string {
  let s = declare(src, p.vertexPars);
  s = at(s, 'beginnormal_vertex', p.vertexNormal, true);
  if (p.vertexBeginReplace !== undefined) s = at(s, 'begin_vertex', p.vertexBeginReplace, true);
  if (p.vertexBegin !== undefined) s = at(s, 'begin_vertex', p.vertexBegin, false);
  if (p.vertexUv !== undefined) s = at(s, 'uv_vertex', p.vertexUv, false);
  if (p.vertexMain !== undefined) s = at(s, 'project_vertex', p.vertexMain, false);
  return s;
}

function patchFragmentShader(src: string, p: ShaderParts): string {
  let s = declare(src, p.fragmentPars);
  if (p.fragmentMap !== undefined) s = at(s, 'map_fragment', p.fragmentMap, false);
  s = at(s, 'color_fragment', p.fragmentColor, false);
  if (p.fragmentNormalBegin !== undefined) s = at(s, 'normal_fragment_begin', p.fragmentNormalBegin, false);
  if (p.fragmentNormal !== undefined) s = at(s, 'normal_fragment_maps', p.fragmentNormal, false);
  if (p.fragmentSunScale !== undefined) s = at(s, 'lights_fragment_begin', scaledSunLights(p.fragmentSunScale), true);
  return at(s, 'lights_fragment_end', p.fragmentLight, false);
}

/** In r170's <lights_fragment_begin> this occurs once: inside the directional-light loop, before the shadow lookup. */
const SUN_LIGHT_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';

/** Three's <lights_fragment_begin> with the directional light's colour multiplied by `scale` (a GLSL float). */
function scaledSunLights(scale: string): string {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  if (chunk.split(SUN_LIGHT_INFO).length !== 2) throw new Error('voxel material: unexpected lights_fragment_begin');
  return `float voxSunScale = ${scale};\n${chunk.replace(SUN_LIGHT_INFO, `${SUN_LIGHT_INFO}\n\t\tdirectLight.color *= voxSunScale;`)}`;
}

/** Inserts declarations right before main(). */
function declare(src: string, code: string): string {
  const anchor = 'void main() {';
  if (!src.includes(anchor)) throw new Error('voxel material: shader has no main()');
  return src.replace(anchor, `${code}\n${anchor}`);
}

/** Replaces `#include <chunk>` with `code`, or appends `code` after it. */
function at(src: string, chunk: string, code: string, replace: boolean): string {
  const anchor = `#include <${chunk}>`;
  if (!src.includes(anchor)) throw new Error(`voxel material: missing ${anchor}`);
  return src.replace(anchor, replace ? code : `${anchor}\n${code}`);
}
