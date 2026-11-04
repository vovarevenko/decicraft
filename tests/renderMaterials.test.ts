import * as THREE from 'three';
import { describe, expect, test, vi } from 'vitest';
import { RENDER } from '../src/config';
import { sharedUniforms } from '../src/render/sharedUniforms';
import { getVoxelMaterials } from '../src/render/voxel/materials';
import { B, COLOR_SIDE, COLOR_TOP, PAT, PATTERN, VARY } from '../src/world/blocks';

vi.mock('../src/render/voxel/plantAtlas', async () => {
  const three = await import('three');
  return {
    PLANT_ATLAS_TILE_W: 64,
    PLANT_ATLAS_TILE_H: 256,
    createPlantAtlas: () => new three.DataTexture(new Uint8Array(4), 1, 1),
  };
});

interface CompiledShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/** Runs the material's onBeforeCompile on three's own (r170) Lambert sources, as WebGLRenderer does. */
function compile(material: THREE.Material): CompiledShader {
  const lib = THREE.ShaderLib.lambert;
  const shader: CompiledShader = {
    uniforms: THREE.UniformsUtils.clone(lib.uniforms),
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  };
  material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null as unknown as THREE.WebGLRenderer);
  return shader;
}

const count = (s: string, c: string): number => s.split(c).length - 1;

/** `code` appears after the include anchor `chunk` in `src`. */
function injectedAfter(src: string, chunk: string, code: string): boolean {
  const at = src.indexOf(`#include <${chunk}>`);
  return at >= 0 && src.indexOf(code, at) > at;
}

describe('voxel materials', () => {
  const materials = getVoxelMaterials();
  const all = [materials.opaque, materials.glass, materials.water, materials.plants];

  test('four lit Lambert materials, each with its own program cache key', () => {
    for (const m of all) expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    const keys = all.map((m) => m.customProgramCacheKey());
    expect(new Set(keys).size).toBe(4);
    expect(getVoxelMaterials()).toBe(materials);
    expect(materials.glass.transparent && materials.water.transparent).toBe(true);
    expect(materials.plants.alphaTest).toBeGreaterThan(0);
    expect(materials.plants.side).toBe(THREE.DoubleSide);
  });

  test('every material patches three r170 Lambert at its include points into well-formed GLSL', () => {
    for (const m of all) {
      const s = compile(m);
      for (const src of [s.vertexShader, s.fragmentShader]) {
        expect(src).not.toContain('${');
        expect(count(src, '{')).toBe(count(src, '}'));
        expect(count(src, '(')).toBe(count(src, ')'));
      }
      expect(s.vertexShader).toMatch(/attribute vec4 (vdata|pdata);/);
    }
    const opaque = compile(materials.opaque);
    expect(injectedAfter(opaque.fragmentShader, 'color_fragment', 'voxPattern(')).toBe(true);
    expect(opaque.fragmentShader).toContain(`pat == ${PAT.BRICK}`);
    expect(opaque.fragmentShader).toContain(`pat == ${PAT.ROOF_TILES}`);
    // AO / skylight after the lights, with the shadow-distance edge of the materials.ts contract.
    expect(injectedAfter(opaque.fragmentShader, 'lights_fragment_end', 'reflectedLight.indirectDiffuse *= voxAoLight * vVoxSky')).toBe(true);
    expect(opaque.fragmentShader).toContain('smoothstep(0.75 * uVoxShadowExtent, uVoxShadowExtent, length(vVoxWorld.xz - cameraPosition.xz))');
    // ... which scales only the sun, inside the directional-light loop: torches and the flashlight are not sky-occluded.
    const f = opaque.fragmentShader;
    expect(f).not.toContain('#include <lights_fragment_begin>');
    expect(f).toContain('getPointLightInfo( pointLight, geometryPosition, directLight );');
    expect(count(f, 'directLight.color *= voxSunScale;')).toBe(1);
    expect(f).toContain('getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= voxSunScale;');
    expect(f).toContain('reflectedLight.directDiffuse *= mix(1.0, voxAoLight, 0.5);\n');
    const water = compile(materials.water);
    expect(injectedAfter(water.fragmentShader, 'normal_fragment_maps', 'uTime')).toBe(true);
    expect(injectedAfter(water.vertexShader, 'begin_vertex', 'transformed.y -=')).toBe(true);
    const plants = compile(materials.plants);
    expect(plants.vertexShader).not.toContain('#include <begin_vertex>');
    expect(injectedAfter(plants.vertexShader, 'uv_vertex', 'vMapUv =')).toBe(true);
  });

  test('environment uniforms are the sharedUniforms objects themselves', () => {
    const glass = compile(materials.glass).uniforms;
    const water = compile(materials.water).uniforms;
    const plants = compile(materials.plants).uniforms;
    for (const u of [glass, water]) {
      expect(u.uTime).toBe(sharedUniforms.uTime);
      expect(u.uSunDir).toBe(sharedUniforms.uSunDir);
      expect(u.uDaylight).toBe(sharedUniforms.uDaylight);
      expect(u.uHorizonColor).toBe(sharedUniforms.uHorizonColor);
    }
    expect(plants.uTime).toBe(sharedUniforms.uTime);
    expect(plants.uPlantFadeEnd.value).toBe(RENDER.plantFadeEnd);
    const opaque = compile(materials.opaque).uniforms;
    expect(opaque.uVoxShadowExtent.value).toBe(RENDER.shadowExtent);
    // One block table shared by the cube materials.
    expect(opaque.uVoxBlocks).toBe(water.uVoxBlocks);
  });

  test('block table: sRGB side / top / bottom colours, then variation and pattern per block id', () => {
    const table = compile(materials.opaque).uniforms.uVoxBlocks.value as THREE.DataTexture;
    const data = table.image.data as Uint8Array;
    expect([table.image.width, table.image.height]).toEqual([256, 4]);
    const texel = (id: number, row: number) => Array.from(data.subarray((row * 256 + id) * 4, (row * 256 + id) * 4 + 4));
    for (const id of [B.GRASS, B.BRICK, B.OAK_LEAVES]) {
      expect(texel(id, 0).slice(0, 3)).toEqual(Array.from(COLOR_SIDE.subarray(id * 3, id * 3 + 3)));
      expect(texel(id, 1).slice(0, 3)).toEqual(Array.from(COLOR_TOP.subarray(id * 3, id * 3 + 3)));
      expect(texel(id, 3).slice(0, 2)).toEqual([VARY[id], PATTERN[id]]);
    }
    expect(PATTERN[B.GRASS]).toBe(PAT.GRASS);
    expect(table.magFilter).toBe(THREE.NearestFilter);
  });
});
