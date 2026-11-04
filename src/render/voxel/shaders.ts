/**
 * GLSL injected into three's MeshLambertMaterial (r170) by the voxel materials (materials.ts).
 * GLSL ES 3.00: explicit float literals, no implicit int/float conversions, smoothstep edges ascending.
 * Attribute layouts: layout.ts. All colours of the block table are sRGB and converted here.
 */
import { PAT } from '../../world/blocks';
import { PLANT_POS_SCALE, PLANT_TILE_COUNT } from './layout';

const COMMON = /* glsl */ `
vec3 voxToLinear(vec3 c) {
  return mix(c * 0.0773993808, pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), step(vec3(0.04045), c));
}
`;

const NOISE = /* glsl */ `
float voxHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float voxHash13(vec3 p) {
  vec3 p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float voxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = voxHash12(i);
  float b = voxHash12(i + vec2(1.0, 0.0));
  float c = voxHash12(i + vec2(0.0, 1.0));
  float d = voxHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// 1 while a feature of \`size\` world units spans several pixels, fading to 0 as it nears pixel size.
float voxDetail(float size, float pix) {
  return 1.0 - smoothstep(0.2 * size, 0.7 * size, pix);
}
`;

// ---------------------------------------------------------------- cube faces (opaque, glass, water)

const VERTEX_PARS = /* glsl */ `
attribute vec4 vdata;
uniform sampler2D uVoxBlocks;
varying vec3 vVoxWorld;
varying float vVoxAo;
varying float vVoxSky;
flat varying vec3 vVoxNormal;
flat varying vec3 vVoxColor;
flat varying vec3 vVoxAlt;
flat varying vec4 vVoxParams;
${COMMON}
vec3 voxAxisNormal(float n) {
  if (n < 0.5) return vec3(1.0, 0.0, 0.0);
  if (n < 1.5) return vec3(-1.0, 0.0, 0.0);
  if (n < 2.5) return vec3(0.0, 1.0, 0.0);
  if (n < 3.5) return vec3(0.0, -1.0, 0.0);
  if (n < 4.5) return vec3(0.0, 0.0, 1.0);
  return vec3(0.0, 0.0, -1.0);
}
`;

/** Replaces <beginnormal_vertex>: the normal comes from the packed normal id. */
const VERTEX_NORMAL = /* glsl */ `
vec3 objectNormal = voxAxisNormal(vdata.x);
`;

/** After <project_vertex>: world position, AO / sky, block colours (by face) and per-block parameters. */
const VERTEX_MAIN = /* glsl */ `
vec4 voxWorldPos = modelMatrix * vec4(transformed, 1.0);
vVoxWorld = voxWorldPos.xyz;
vVoxNormal = objectNormal;
vVoxAo = vdata.y * (1.0 / 3.0);
vVoxSky = vdata.z * (1.0 / 15.0);
int voxId = int(vdata.w + 0.5);
int voxRow = (vdata.x > 1.5 && vdata.x < 2.5) ? 1 : ((vdata.x > 2.5 && vdata.x < 3.5) ? 2 : 0);
vVoxColor = voxToLinear(texelFetch(uVoxBlocks, ivec2(voxId, voxRow), 0).rgb);
vVoxAlt = voxToLinear(texelFetch(uVoxBlocks, ivec2(voxId, 2), 0).rgb);
vec4 voxProps = texelFetch(uVoxBlocks, ivec2(voxId, 3), 0);
vVoxParams = vec4(length(modelMatrix[0].xyz), voxProps.r, floor(voxProps.g * 255.0 + 0.5), vdata.x);
`;

/** After <begin_vertex> (water): surface vertices sit 0.1 voxel lower. */
const WATER_VERTEX_LOWER = /* glsl */ `
transformed.y -= vdata.y * (0.1 / length(modelMatrix[0].xyz));
`;

const FRAGMENT_VARYINGS = /* glsl */ `
varying vec3 vVoxWorld;
varying float vVoxAo;
varying float vVoxSky;
flat varying vec3 vVoxNormal;
flat varying vec3 vVoxColor;
flat varying vec3 vVoxAlt;
flat varying vec4 vVoxParams;
`;

/**
 * Procedural sub-voxel surface patterns (block PAT ids) in world space. \`col\` is the varied face
 * colour, \`alt\` the block's bottom colour (soil under grass), \`uv\` the face-plane world coordinates
 * (v = height on side faces), \`fy\` the height inside the cell, \`pix\` the world size of one pixel.
 */
const PATTERNS = /* glsl */ `
vec3 voxPattern(int pat, vec3 col, vec3 alt, vec2 uv, float face, float fy, float pix) {
  bool topFace = face > 1.5 && face < 3.5; // ±Y faces
  if (pat == ${PAT.SOIL}) { // fine speckles
    float n = voxNoise(uv * 1.7);
    float g = voxHash12(floor(uv * 11.0));
    col *= mix(1.0, 0.86 + 0.28 * n, voxDetail(0.6, pix)) * mix(1.0, 0.8 + 0.4 * g, voxDetail(0.09, pix));
  } else if (pat == ${PAT.GRASS}) { // blade speckles on top, blades over soil on the sides
    if (topFace) {
      float n = voxNoise(uv * 0.45);
      float b = voxHash12(floor(uv * 9.0));
      col *= mix(1.0, 0.88 + 0.24 * n, voxDetail(2.0, pix)) * mix(1.0, 0.78 + 0.44 * b, voxDetail(0.11, pix));
    } else {
      // Blades over the upper ~70 % of the cell (ragged tip line 0.2..0.42), soil below.
      float tip = 0.2 + 0.14 * voxNoise(vec2(uv.x * 7.0, 3.7)) + 0.08 * voxHash12(vec2(floor(uv.x * 13.0), 5.0));
      float cover = mix(0.7, step(tip, fy), voxDetail(0.12, pix));
      vec3 soil = alt * mix(1.0, 0.8 + 0.4 * voxHash12(floor(uv * 11.0)), voxDetail(0.09, pix));
      vec3 blades = col * mix(1.0, 0.8 + 0.4 * voxHash12(vec2(floor(uv.x * 12.0), 9.0)), voxDetail(0.09, pix));
      col = mix(soil, blades, cover);
    }
  } else if (pat == ${PAT.STONE}) { // blotches and thin cracks
    float b = voxNoise(uv * 0.8) * 0.6 + voxNoise(uv * 2.6 + 7.1) * 0.4;
    col *= mix(1.0, 0.8 + 0.4 * b, voxDetail(1.2, pix));
    float c = abs(voxNoise(uv * 0.9 + 13.7) - 0.5);
    col *= 1.0 - 0.35 * (1.0 - smoothstep(0.012, 0.035, c)) * voxDetail(0.15, pix);
    col *= mix(1.0, 0.9 + 0.2 * voxHash12(floor(uv * 9.0)), voxDetail(0.1, pix));
  } else if (pat == ${PAT.GRAVEL}) { // cellular pebbles
    vec2 g = uv * 3.2;
    vec2 gi = floor(g);
    vec2 gf = fract(g);
    float best = 8.0;
    float shade = 0.5;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 o = vec2(float(i), float(j));
        vec2 h = vec2(voxHash12(gi + o), voxHash12(gi + o + 19.19));
        float d = length(o + h - gf);
        if (d < best) {
          best = d;
          shade = h.x;
        }
      }
    }
    float peb = (0.72 + 0.56 * shade) * (1.0 - 0.4 * smoothstep(0.3, 0.7, best));
    col *= mix(0.95, peb, voxDetail(0.32, pix));
  } else if (pat == ${PAT.BARK}) { // vertical furrows
    vec2 b = topFace ? uv * 2.0 : vec2(uv.x * 3.0, uv.y * 0.3);
    float f = voxNoise(b) * 0.7 + voxNoise(b * 2.3 + 4.1) * 0.3;
    col *= mix(0.92, 0.62 + 0.6 * smoothstep(0.3, 0.7, f), voxDetail(0.3, pix));
  } else if (pat == ${PAT.BIRCH}) { // white bark, short dark horizontal dashes
    vec2 c = vec2(uv.x * 1.4, uv.y * 3.6);
    vec2 ci = floor(c);
    vec2 cf = fract(c);
    float r = voxHash12(ci);
    float dash = step(0.74, r) * step(abs(cf.y - 0.5), 0.16) * step(abs(cf.x - 0.5), 0.18 + 0.28 * fract(r * 7.31));
    col = mix(col, vec3(0.03, 0.028, 0.025), dash * 0.9 * voxDetail(0.14, pix));
    col *= mix(1.0, 0.92 + 0.14 * voxNoise(uv * 2.2), voxDetail(0.5, pix));
  } else if (pat == ${PAT.WOOD}) { // end grain rings on ±Y, long grain on sides
    if (topFace) {
      vec2 q = fract(uv / 6.0) - 0.5;
      float ring = 0.5 + 0.5 * sin(length(q) * 54.0 + voxNoise(uv * 0.7) * 3.0);
      col *= mix(0.97, 0.86 + 0.2 * ring, voxDetail(0.2, pix));
    } else {
      float grain = voxNoise(vec2(uv.x * 8.0, uv.y * 0.25));
      col *= mix(0.98, 0.84 + 0.3 * grain, voxDetail(0.15, pix));
    }
  } else if (pat == ${PAT.LEAVES}) { // leafy dither with dark gaps
    float l = voxNoise(uv * 3.4) * 0.6 + voxHash12(floor(uv * 6.0)) * 0.4;
    float gap = 1.0 - smoothstep(0.2, 0.34, l);
    col *= mix(0.9, (0.78 + 0.45 * l) * (1.0 - 0.6 * gap), voxDetail(0.3, pix));
  } else if (pat == ${PAT.BRICK}) { // running bond, 25 × 6.5 cm bricks, 1 cm mortar
    float row = floor(uv.y / 0.75);
    float bx = uv.x / 2.6 + 0.5 * mod(row, 2.0);
    float fx = fract(bx) * 2.6;
    float fyb = uv.y - row * 0.75;
    float mortar = 1.0 - step(0.1, fx) * step(0.1, fyb);
    vec3 mortarCol = vec3(0.36, 0.34, 0.31);
    vec3 brick = col * mix(1.0, 0.8 + 0.34 * voxHash12(vec2(floor(bx), row)), voxDetail(0.9, pix));
    brick *= mix(1.0, 0.9 + 0.2 * voxHash12(floor(uv * 7.0)), voxDetail(0.1, pix));
    float lines = voxDetail(0.14, pix);
    col = mix(brick, mortarCol, mortar * lines + 0.13 * (1.0 - lines));
  } else if (pat == ${PAT.PLANKS}) { // one-voxel boards with seams and grain
    float across = topFace ? uv.y : uv.x;
    float along = topFace ? uv.x : uv.y;
    float board = floor(across);
    float fa = fract(across);
    float seg = floor((along + voxHash12(vec2(board, 3.0)) * 17.0) / 17.0);
    float tone = voxHash12(vec2(board, seg));
    float grain = voxNoise(vec2(fa * 7.0 + board * 3.1, along * 0.45));
    float seam = smoothstep(0.0, 0.05, fa) * (1.0 - smoothstep(0.95, 1.0, fa));
    col *= mix(1.0, 0.84 + 0.28 * tone, voxDetail(1.0, pix)) * mix(1.0, 0.9 + 0.18 * grain, voxDetail(0.15, pix));
    col *= mix(0.94, 0.55 + 0.45 * seam, voxDetail(0.08, pix));
  } else if (pat == ${PAT.TILES}) { // square tiles, grout on voxel edges
    vec2 t = fract(uv);
    vec2 e = min(t, 1.0 - t);
    float grout = 1.0 - smoothstep(0.025, 0.05, min(e.x, e.y));
    col *= mix(1.0, 0.95 + 0.1 * voxHash12(floor(uv) + 7.0), voxDetail(0.8, pix));
    col = mix(col, col * 0.6 + vec3(0.03), grout * voxDetail(0.07, pix));
  } else if (pat == ${PAT.ASPHALT}) { // speckled aggregate, patches, hairline cracks
    float s = voxHash12(floor(uv * 13.0));
    col *= mix(1.0, 0.82 + 0.5 * step(0.86, s) + 0.12 * s, voxDetail(0.07, pix));
    col *= mix(1.0, 0.88 + 0.24 * voxNoise(uv * 0.3), voxDetail(5.0, pix));
    float c = abs(voxNoise(uv * 0.33 + 3.7) - 0.5);
    col *= 1.0 - 0.5 * (1.0 - smoothstep(0.008, 0.022, c)) * voxDetail(0.12, pix);
  } else if (pat == ${PAT.CORRUGATED}) { // sine ridges
    col *= mix(1.0, 0.86 + 0.14 * sin(uv.x * 9.42), voxDetail(0.35, pix));
    col *= mix(1.0, 0.9 + 0.2 * voxNoise(uv * 0.6), voxDetail(2.0, pix));
  } else if (pat == ${PAT.PAVING}) { // 20 × 10 cm pavers, offset rows
    vec2 p = vec2(uv.x * 0.5, uv.y);
    p.x += 0.5 * mod(floor(p.y), 2.0);
    vec2 f = fract(p);
    float j = min(min(f.x, 1.0 - f.x) * 2.0, min(f.y, 1.0 - f.y));
    float joint = 1.0 - smoothstep(0.03, 0.07, j);
    col *= mix(1.0, 0.86 + 0.26 * voxHash12(floor(p)), voxDetail(1.0, pix));
    col *= 1.0 - 0.38 * joint * voxDetail(0.09, pix);
  } else if (pat == ${PAT.PLASTER}) { // soft stains, hairline cracks
    float st = voxNoise(uv * 0.22) * 0.6 + voxNoise(uv * 0.8 + 5.3) * 0.4;
    col *= mix(1.0, 0.86 + 0.24 * st, voxDetail(4.0, pix));
    float c = abs(voxNoise(uv * 0.45 + 9.7) - 0.5);
    col *= 1.0 - 0.28 * (1.0 - smoothstep(0.005, 0.015, c)) * voxDetail(0.09, pix);
  } else if (pat == ${PAT.WALLPAPER}) { // faded vertical stripes
    float s = smoothstep(0.3, 0.45, abs(fract(uv.x * 1.25) - 0.5));
    col *= mix(1.0, (0.9 + 0.1 * s) * (0.92 + 0.12 * voxNoise(uv * 0.4)), voxDetail(0.25, pix));
  } else if (pat == ${PAT.FABRIC}) { // weave
    vec2 w = uv * 18.0;
    float a = mod(floor(w.x) + floor(w.y), 2.0);
    float th = mix(sin(fract(w.x) * 3.14159), sin(fract(w.y) * 3.14159), a);
    col *= mix(0.95, 0.82 + 0.25 * th, voxDetail(0.06, pix));
  } else if (pat == ${PAT.METAL}) { // rust blotches
    float r = voxNoise(uv * 0.6) * 0.6 + voxNoise(uv * 2.1 + 2.7) * 0.4;
    col = mix(col, vec3(0.2, 0.07, 0.025), smoothstep(0.55, 0.78, r) * 0.65 * voxDetail(1.0, pix));
    col *= mix(1.0, 0.88 + 0.24 * voxHash12(floor(uv * 5.0)), voxDetail(0.2, pix));
  } else if (pat == ${PAT.ROOF_TILES}) { // overlapping scallop rows
    vec2 p = vec2(uv.x / 1.6, uv.y / 1.2);
    p.x += 0.5 * mod(floor(p.y), 2.0);
    vec2 f = fract(p);
    float edge = smoothstep(0.55, 0.66, length(vec2((f.x - 0.5) * 1.3, f.y)));
    col *= mix(1.0, (0.82 + 0.3 * voxHash12(floor(p))) * (1.0 - 0.35 * edge) * (0.8 + 0.25 * f.y), voxDetail(0.45, pix));
  }
  return col;
}
`;

/** After <color_fragment> (opaque): per-voxel variation, then the block's pattern. */
const OPAQUE_COLOR = /* glsl */ `
float voxCell = vVoxParams.x;
vec3 voxCellId = floor((vVoxWorld - vVoxNormal * (0.5 * voxCell)) / voxCell);
float voxVary = vVoxParams.y;
float voxBright = 1.0 + (voxHash13(voxCellId) - 0.5) * 2.0 * voxVary;
float voxTint = (voxHash13(voxCellId + vec3(17.0, 31.0, 47.0)) - 0.5) * voxVary * 0.6;
float voxFace = vVoxParams.w;
vec2 voxUv = voxFace < 1.5 ? vVoxWorld.zy : (voxFace < 3.5 ? vVoxWorld.xz : vVoxWorld.xy);
vec2 voxFw = fwidth(voxUv);
float voxPix = max(voxFw.x, voxFw.y);
vec3 voxCol = voxPattern(
  int(vVoxParams.z + 0.5),
  vVoxColor * voxBright * vec3(1.0 + voxTint, 1.0, 1.0 - voxTint),
  vVoxAlt * voxBright,
  voxUv,
  voxFace,
  fract(vVoxWorld.y / voxCell),
  voxPix
);
diffuseColor.rgb *= max(voxCol, vec3(0.0));
`;

/**
 * Opaque sun scale: beyond the shadow box (no sun shadows there) the skylight stands in for the
 * shadow. Only the directional light is scaled: torches, campfires and the flashlight are not sky-occluded.
 */
const OPAQUE_SUN_SCALE = /* glsl */ `mix(1.0, vVoxSky, smoothstep(0.75 * uVoxShadowExtent, uVoxShadowExtent, length(vVoxWorld.xz - cameraPosition.xz)))`;

/** After <lights_fragment_end> (opaque): AO scales indirect light fully and direct light by half; the skylight scales indirect light. */
const OPAQUE_LIGHT = /* glsl */ `
float voxAoLight = 0.35 + 0.65 * vVoxAo;
reflectedLight.indirectDiffuse *= voxAoLight * vVoxSky;
reflectedLight.directDiffuse *= mix(1.0, voxAoLight, 0.5);
`;

const GLASS_LIGHT = /* glsl */ `
reflectedLight.indirectDiffuse *= vVoxSky;
vec3 voxView = normalize(vViewPosition);
float voxFres = pow(1.0 - abs(dot(normal, voxView)), 4.0);
vec3 voxSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
float voxSpec = pow(max(dot(normal, normalize(voxSunV + voxView)), 0.0), 160.0) * uDaylight;
totalEmissiveRadiance += uHorizonColor * (voxFres * 0.5 * vVoxSky) + vec3(voxSpec * 1.5);
diffuseColor.a = clamp(0.25 + 0.5 * voxFres + voxSpec, 0.0, 1.0);
`;

/** After <color_fragment> (water): base colour; ripple fade measured here (derivatives need uniform flow). */
const WATER_COLOR = /* glsl */ `
diffuseColor.rgb *= vVoxColor;
vec2 voxWaterFw = fwidth(vVoxWorld.xz);
float voxWaterPix = max(voxWaterFw.x, voxWaterFw.y);
`;

/** After <normal_fragment_maps> (water): animated ripples on the surface (normal id 2 = +Y). */
const WATER_NORMAL = /* glsl */ `
if (vVoxParams.w > 1.5 && vVoxParams.w < 2.5) {
  vec2 voxP = vVoxWorld.xz;
  vec2 voxG = vec2(0.8, 0.6) * (0.09 * cos(dot(voxP, vec2(0.8, 0.6)) * 2.1 + uTime * 1.9));
  voxG += vec2(-0.5, 0.86) * (0.06 * cos(dot(voxP, vec2(-0.5, 0.86)) * 3.3 + uTime * 2.6));
  voxG += vec2(0.96, -0.28) * (0.035 * cos(dot(voxP, vec2(0.96, -0.28)) * 5.1 + uTime * 3.4));
  voxG += vec2(-0.2, -0.98) * (0.08 * cos(dot(voxP, vec2(-0.2, -0.98)) * 1.3 + uTime * 1.2));
  voxG *= 1.0 - smoothstep(0.3, 1.5, voxWaterPix);
  normal = normalize((viewMatrix * vec4(-voxG.x, 1.0, -voxG.y, 0.0)).xyz) * faceDirection;
}
`;

/** After <lights_fragment_end> (water): fresnel towards the horizon colour, sun glint, view-dependent alpha. */
const WATER_LIGHT = /* glsl */ `
vec3 voxView = normalize(vViewPosition);
float voxNdV = clamp(dot(normal, voxView), 0.0, 1.0);
float voxFres = 0.03 + 0.97 * pow(1.0 - voxNdV, 5.0);
vec3 voxSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
float voxGlint = pow(max(dot(reflect(-voxView, normal), voxSunV), 0.0), 240.0) * (0.15 + 0.85 * uDaylight);
reflectedLight.indirectDiffuse *= vVoxSky * (1.0 - voxFres);
reflectedLight.directDiffuse *= 1.0 - voxFres;
totalEmissiveRadiance += uHorizonColor * (voxFres * mix(0.4, 1.0, vVoxSky)) + vec3(voxGlint * 4.0 * vVoxSky);
diffuseColor.a = mix(0.7, 0.96, voxFres);
`;

const ENV_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uDaylight;
uniform vec3 uHorizonColor;
`;

/** Shader pieces of one voxel material: declarations go before main(), the rest at the named anchors. */
export interface ShaderParts {
  vertexPars: string;
  /** Replaces <beginnormal_vertex>. */
  vertexNormal: string;
  /** Appended after <begin_vertex> (optional). */
  vertexBegin?: string;
  /** Replaces <begin_vertex> (optional; plants). */
  vertexBeginReplace?: string;
  /** Appended after <uv_vertex> (optional; plants). */
  vertexUv?: string;
  /** Appended after <project_vertex> (optional). */
  vertexMain?: string;
  fragmentPars: string;
  /** Appended after <map_fragment> (optional). */
  fragmentMap?: string;
  /** Appended after <color_fragment>. */
  fragmentColor: string;
  /** Appended after <normal_fragment_begin> (optional). */
  fragmentNormalBegin?: string;
  /** Appended after <normal_fragment_maps> (optional). */
  fragmentNormal?: string;
  /**
   * GLSL float expression that scales the directional (sun/moon) light inside three's light loop,
   * before its shadow lookup; point and spot lights are not affected (optional).
   */
  fragmentSunScale?: string;
  /** Appended after <lights_fragment_end>. */
  fragmentLight: string;
}

export const OPAQUE_SHADER: ShaderParts = {
  vertexPars: VERTEX_PARS,
  vertexNormal: VERTEX_NORMAL,
  vertexMain: VERTEX_MAIN,
  fragmentPars: `uniform float uVoxShadowExtent;\n${FRAGMENT_VARYINGS}${NOISE}${PATTERNS}`,
  fragmentColor: OPAQUE_COLOR,
  fragmentSunScale: OPAQUE_SUN_SCALE,
  fragmentLight: OPAQUE_LIGHT,
};

export const GLASS_SHADER: ShaderParts = {
  vertexPars: VERTEX_PARS,
  vertexNormal: VERTEX_NORMAL,
  vertexMain: VERTEX_MAIN,
  fragmentPars: `${ENV_UNIFORMS}${FRAGMENT_VARYINGS}`,
  fragmentColor: 'diffuseColor.rgb *= vVoxColor;\n',
  fragmentLight: GLASS_LIGHT,
};

export const WATER_SHADER: ShaderParts = {
  vertexPars: VERTEX_PARS,
  vertexNormal: VERTEX_NORMAL,
  vertexBegin: WATER_VERTEX_LOWER,
  vertexMain: VERTEX_MAIN,
  fragmentPars: `${ENV_UNIFORMS}${FRAGMENT_VARYINGS}`,
  fragmentColor: WATER_COLOR,
  fragmentNormal: WATER_NORMAL,
  fragmentLight: WATER_LIGHT,
};

// ---------------------------------------------------------------- plants

const PLANT_VERTEX_PARS = /* glsl */ `
attribute vec4 pdata;
uniform float uTime;
uniform float uPlantFadeEnd;
varying float vPlantSky;
varying float vPlantShade;
`;

/** After <uv_vertex>: atlas coordinates from the tile and the corner bits. */
const PLANT_VERTEX_UV = /* glsl */ `
vMapUv = vec2((pdata.x + mix(0.04, 0.96, mod(pdata.y, 2.0))) * ${(1 / PLANT_TILE_COUNT).toFixed(6)}, mod(floor(pdata.y * 0.5), 2.0));
`;

/**
 * Replaces <begin_vertex>: Int16 positions → voxels, wind sway of the top edge, and the distance fade
 * that shrinks plants into the ground by uPlantFadeEnd.
 */
const PLANT_VERTEX_BEGIN = /* glsl */ `
vec3 transformed = position * ${(1 / PLANT_POS_SCALE).toFixed(6)};
float voxTop = mod(floor(pdata.y * 0.5), 2.0);
float voxHeight = floor(pdata.y * 0.25) * 0.25;
vec3 voxBase = (modelMatrix * vec4(transformed, 1.0)).xyz;
float voxGrow = 1.0 - smoothstep(uPlantFadeEnd * 0.65, uPlantFadeEnd, length(voxBase.xz - cameraPosition.xz));
float voxPhase = dot(voxBase.xz, vec2(0.13, 0.09)) + pdata.w * 0.0246;
vec2 voxSway = vec2(sin(uTime * 1.6 + voxPhase), sin(uTime * 1.1 + voxPhase * 1.7 + 1.3));
transformed.xz += voxSway * (0.04 * voxHeight * voxTop * voxGrow);
transformed.y -= voxTop * voxHeight * (1.0 - voxGrow);
vPlantSky = pdata.z * (1.0 / 15.0);
vPlantShade = 0.82 + 0.36 * pdata.w * (1.0 / 255.0);
`;

const PLANT_FRAGMENT_PARS = /* glsl */ `
uniform vec2 uPlantAtlasSize;
varying float vPlantSky;
varying float vPlantShade;
`;

/**
 * After <map_fragment>: the atlas is premultiplied (clean mip edges), so divide the alpha back out;
 * then keep thin blades from dissolving in coarse mip levels under the alpha test.
 */
const PLANT_FRAGMENT_MAP = /* glsl */ `
diffuseColor.rgb /= max(sampledDiffuseColor.a, 0.004);
vec2 voxAtlasPx = fwidth(vMapUv) * uPlantAtlasSize;
float voxMip = log2(max(max(voxAtlasPx.x, voxAtlasPx.y), 1.0));
diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 0.3 * voxMip));
`;

/**
 * After <lights_fragment_end>: the skylight term (canopy and roof shade) scales the indirect light;
 * direct sunlight is shadowed by the shadow map, like the ground the plants stand on.
 */
const PLANT_LIGHT = /* glsl */ `
reflectedLight.indirectDiffuse *= vPlantSky;
`;

export const PLANT_SHADER: ShaderParts = {
  vertexPars: PLANT_VERTEX_PARS,
  vertexNormal: 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);\n',
  vertexBeginReplace: PLANT_VERTEX_BEGIN,
  vertexUv: PLANT_VERTEX_UV,
  fragmentPars: PLANT_FRAGMENT_PARS,
  fragmentMap: PLANT_FRAGMENT_MAP,
  fragmentColor: 'diffuseColor.rgb *= vPlantShade;\n',
  // Double-sided quads lit like the ground: undo the back-face normal flip.
  fragmentNormalBegin: 'normal = normalize(vNormal);\n',
  fragmentLight: PLANT_LIGHT,
};
