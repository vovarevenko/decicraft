# «Дециметр» — architecture & module contracts

Browser PoC of a Minecraft-like sandbox whose world voxels are **10 cm** (1 dm) instead of 1 m.
Small complex things (tools, items, mobs, doors) are **1 cm voxel models**. The world is more
realistic than Minecraft: natural palettes, real-world proportions, layered ground, trees that fall
when cut, an abandoned post-Soviet small town. **No goal** — the player explores, digs, chops,
builds, loots, crafts a little, meets two kinds of animals, and gets a feel for the scale.

Scope is deliberately small ("пара инструментов, пара рецептов, по паре мобов и предметов"), but the
engine must feel solid: smooth movement, no holes in the world, responsive digging, stable 60 FPS.

Target hardware: **Apple M1, 8 GB RAM**, Chrome/Electron, 1440×900 at pixel ratio 1.

---------------------------------------------------------------------------------------------------

## 1. Ground rules for every agent

1. **Read this file, then your own stub files, then the stub files of modules you call.** Stubs contain
   the exact public API (signatures + JSDoc). Implement bodies; you may add private members, helper
   functions, new files *inside your owned paths*, and extra optional parameters/exports. **Do not
   change existing exported signatures** and **do not edit files you do not own** (table in §3) — not
   even to fix a type error. If you need a change in someone else's file or in the spine, implement
   your side against the current contract and list the request under `SPINE REQUESTS` in your report.
2. Other modules are being written **in parallel** — while you work they are still stubs that throw.
   Code against the contracts, never against guesses about their internals. You cannot run the game.
3. **Verification you must do:** `npx tsc --noEmit` must report **no errors in your files** (errors in
   files you don't own may exist while others work — ignore those, never "fix" them). Write vitest
   unit tests for your pure logic in `tests/<area>*.test.ts` and run `npx vitest run tests/<file>`.
   Do **not** start dev servers or browsers (the lead does visual QA after integration).
4. TypeScript strict, ES2022 modules, `import * as THREE from 'three'` (three **r170**). Use
   `import type` for type-only imports (avoids runtime cycles). Keep comment density modest: JSDoc on
   exported things, short comments for non-obvious logic only.
5. **Units**: 1 world unit = 1 voxel = 10 cm. Axes: +X east, +Y up, +Z south. Voxel (x,y,z) occupies
   [x,x+1)×[y,y+1)×[z,z+1). Centimetre models: 1 model voxel = 0.1 world units. Entity `position` =
   bottom centre.
6. **Determinism**: generation code uses `core/rng` + `core/noise` only (never `Math.random`, `Date`).
   Gameplay/visual code may use `Math.random`.
7. **Performance**: no allocations in per-voxel / per-frame hot loops (reuse vectors/arrays); use the
   flat lookup tables from `world/blocks.ts` (SOLID, OPAQUE, RENDER_KIND…) in hot paths.
8. **three.js r170 pitfalls**: colour management is on — vertex colours are interpreted as *linear*;
   convert sRGB (all colours in this project are sRGB hex) with `srgbToLinear` or in the shader.
   Lights use physical units (intensity in candela for point/spot, decay 2, distances in world units
   = decimetres, so point-light intensities are ~100× the metre-scale values). Never add/remove lights
   or toggle `light.visible` / `castShadow` at runtime (forces shader recompiles) — set `intensity = 0`
   instead; `castShadow` is fixed at creation (false for pooled, flashlight and overlay lights).
   Exactly one FogExp2 instance for the whole session (underwater changes colour/density only).
   Every material using `onBeforeCompile` overrides `customProgramCacheKey()` with a unique string.
   The flashlight's target is a child of the camera. Use `renderer.outputColorSpace = THREE.SRGBColorSpace`.
9. **Input**: key codes are `KeyboardEvent.code`. **Never bind Ctrl/Meta combos** (Ctrl+W closes the
   tab). Systems read gameplay input only when `ctx.input.active`. Anything that opens/closes UI or
   triggers a one-shot action reads its key with `input.consume()` / `consumeMouse()` so no later
   system reacts to the same press in the same frame. Input never grabs pointer lock by itself.
10. **All player-visible text is Russian.** Code, identifiers and comments are English.
11. Workers: `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`; worker files
    use `workerSelf` from `core/workerScope.ts`; SharedArrayBuffer is available (COOP/COEP headers set
    in `vite.config.ts`).

## 2. Running

```
npm install
npm run dev        # http://localhost:5173 (COOP/COEP headers on)
npx tsc --noEmit   # type check
npx vitest run     # unit tests (node)
```

## 3. Module map & ownership

| Owner agent | Paths (create/modify only these) | Provides |
|---|---|---|
| **lead** | `src/config.ts`, `src/core/**`, `src/world/blocks.ts`, `src/world/world.ts`, `src/gen/types.ts`, `src/game/items.ts`, `src/game/context.ts`, `src/game/game.ts`, `src/main.ts`, `src/render/sharedUniforms.ts`, root configs, this file | spine, wiring |
| **worldgen** | `src/gen/terrain.ts`, `src/gen/plan.ts`, `src/gen/flora.ts`, `src/gen/rocks.ts`, `src/gen/generateWorld.ts`, `src/gen/gen.worker.ts`, `src/gen/nature/**`, `tests/gen*.test.ts` | terrain, biomes, trees, rocks, plan, worker generation |
| **town** | `src/gen/town/**`, `tests/town*.test.ts` | `planTown()` |
| **render-core** | `src/render/voxel/**`, `tests/mesher*.test.ts`, `tests/render*.test.ts` | `ChunkRenderer`, voxel materials, mesher, LOD |
| **env-fx** | `src/render/renderer.ts`, `src/render/particles.ts`, `src/render/viewModel.ts`, `src/render/env/**`, `tests/env*.test.ts` | `GameRenderer`, sky/day-night/fog/shadows/horizon, `LightPool`, `Particles`, `ViewModel` |
| **player** | `src/game/input.ts`, `src/game/player.ts`, `src/game/physics.ts`, `src/world/raycast.ts`, `src/game/audio.ts`, `src/game/audio/**`, `tests/physics*.test.ts`, `tests/raycast*.test.ts`, `tests/player*.test.ts`, `tests/audio*.test.ts` | `Input`, `Player`, collision, voxel raycast, synthesized audio |
| **items-ui** | `src/game/inventory.ts`, `src/game/crafting.ts`, `src/ui/**`, `tests/inventory*.test.ts`, `tests/crafting*.test.ts` | `Inventory`, recipes, HUD, inventory/crafting screen, menus, map, icons |
| **art** | `src/render/voxelModel.ts`, `src/render/models/**`, `tests/models*.test.ts` | `VoxelGrid`, `buildVoxelGeometry`, all cm-models & mob rigs |
| **entities** | `src/game/entities/**`, `src/game/mobs/**`, `tests/entities*.test.ts`, `tests/mobs*.test.ts` | entity manager, item drops, doors, containers, campfire, deer, dog, plan spawning |
| **interaction** | `src/game/interaction.ts`, `src/game/interaction/**`, `src/game/fallingBody.ts`, `src/world/structure.ts`, `tests/interaction*.test.ts`, `tests/structure*.test.ts` | break/place/use, structural collapse & falling bodies, water flow |

Frame order (`game/game.ts`): global keys → time → `player.update` → `interaction.update` →
`entities.update` → `world.flush()` (→ ChunkRenderer.markDirty) → camera from player →
`renderer.update` → `particles.update` → view model → `audio.update` → `chunks.update` →
`inventoryScreen.update` → `map.update` → `hud.update` → `renderer.render(viewModel)` → `input.endFrame()`.
Global keys handled by game.ts (via `consume`): Tab/I open+close the inventory, M opens+closes the map,
F3 or Backquote debug, Digit1–9 & wheel hotbar, T (hold) fast-forward time. Screens close themselves
only on Esc (and E for container view / notes). Pointer-lock loss (Esc) or a refused lock request →
pause menu; «Продолжить» requests the lock and the game unpauses only once it is granted.

Boot (`main.ts`): `createWorldPlan` + `createTerrain` → `World.create()` → `generateWorld` (workers) →
`GameRenderer` → `ChunkRenderer` + `prewarm(spawn)` → systems → `spawnFromPlan` → `map.init` →
`renderer.precompile()` → start screen → click: `audio.unlock()`, loop starts, `input.requestLock()`.

## 4. World data (spine — `world/world.ts`, `world/blocks.ts`)

* World: 1280 × 512 × 1280 voxels (128 m × 51.2 m × 128 m), chunks of 32³ (3.2 m), 40×16×40 chunks.
* Shared memory: chunk table (uniform chunks cost 4 bytes), 32 MB segments of chunk arrays, and two
  Int16 column maps: `sky` = first voxel above the topmost SKY_OPAQUE voxel (terrain, walls, roofs —
  not foliage or tree bark, so crowns shade instead of roofing) and `canopy` = first voxel above the
  topmost OPAQUE voxel incl. foliage and bark. `WorldData` (read-only, workers) / `World` (main
  thread writer). Index inside a chunk: `x + z·32 + y·1024`.
  No bedrock voxels: y < 0 is virtual bedrock (`getBlock` → BEDROCK, `setBlock` rejects it).
* `World.setBlock` marks dirty chunks (+ neighbours of border voxels, + skylight-affected chunks in
  columns ±2, 37 voxels below a sky change) and bumps `chunkVersion` of every chunk it dirties;
  `World.flush()` (once per frame) notifies `onChange` listeners.
* `WorldData.floorBelow(x, y, z)` = floor under an intended position (use it to place items, mobs, the
  player — `topSolidY` would put them on roofs and tree tops).
* **Foliage** (OAK/BIRCH leaves, PINE_NEEDLES, BUSH) is opaque but NOT solid: bodies push through
  leaves and bushes; it never carries structural support (`SUP.LEAF`).
* Blocks: ~50 types (natural ground, water, logs/leaves, plants, town materials). Each has sRGB colours
  (side/top/bottom), variation, procedural pattern id (`PAT`), render kind (`RK`), solidity, opacity,
  hardness (hand-seconds), preferred tool class, support role (`SUP`), drop item, sound material.

## 5. Generation (worldgen + town)

### 5.1 Pipeline
* `createWorldPlan(seed)` (worldgen, deterministic, < 100 ms): calls `planTown({seed, terrain})`, adds
  nature features + deer spawns + landmarks; player spawn = `town.entrance` (y = TOWN_GROUND_Y).
* `generateWorld(world, seed, onProgress)`: `workerCount('gen')` workers; each builds its own
  `createTerrain(seed)` + `createWorldPlan(seed)` once, then generates tiles of 128×128 columns × full
  height into a dense 8 MB Uint8Array: `fillColumn` for every column → features overlapping the tile
  sorted by `(order, index)` with a clipping `VoxelWriter` → `decorateColumn` for every column →
  split into chunks with uniform detection (uniform chunks sent as ids) → transfer non-uniform
  `Uint8Array(32768)` chunks + the tile's `Int16Array` sky (SKY_OPAQUE) and canopy (OPAQUE) heights to
  the main thread → `world.loadChunk` / `world.loadSky`. Centre tiles first. Target: whole world < 8 s on M1.
* Features carry conservative bounds; a spatial index (per tile) avoids testing every feature.
* **Tile independence**: a feature's `stamp()` runs once per overlapping tile, each time with a
  different clipping writer, in any order, possibly in different workers. It must write identical
  voxels every time: create its RNG from the feature's own seed at the start of `stamp()` (no shared
  mutable state between calls), and never base decisions on `w.get()` reads outside the current tile
  (they return AIR). Reading terrain via `ctx.terrain` is always safe.

### 5.2 Map layout (`config.ts`)
NW quadrant = **town**, NE = **deciduous forest**, SW = **meadow with a pond**, SE = **rocky pine hills**.
Natural biome borders are domain-warped (±8 m) and blended over ~12 m (heights, surface blocks and
vegetation density all blend; mixed-species fringes). The town border is fairly straight: flat ground
at `TOWN_GROUND_Y` over `TOWN_BUILD_RECT` + 2 m, then a ~6–10 m blend into the neighbours.
The four regions meet near the map centre (640, 640); the player spawns at the town's south-east
entrance next to it, so all regions are visible from the start.

### 5.3 Terrain & ground (worldgen)
* Heights (first air voxel y): town flat 120; forest gently rolling ~116–150 (long wavelengths 20–40 m
  + small bumps ≤ 30 cm); meadow mostly flat ~116–128 with a **pond** (irregular, domain-warped,
  ~20×14 m, water surface `waterY` ≈ 116, depth up to ~2 m, sloping sandy/muddy banks, a gravel
  patch, reeds in shallows); hills: ridged noise up to ~y 260–290 (14–17 m above base), steep rocky
  slopes (slope-dependent exposure of STONE/GRANITE, thin soil + GRASS/MOSS on gentle parts, GRAVEL
  scree at slope feet). Avoid sheer cliffs exactly at the map edge.
* Layers: top block (GRASS, LITTER under forest canopy areas, SAND/MUD at the pond, MOSS/STONE on
  rocks) → DIRT 3–6 voxels → subsoil (CLAY / GRAVEL lenses by 3D-ish noise, GRANITE patches in hills)
  only within ~24 voxels below the surface → plain STONE down to y = 0 (no bedrock voxels; keeps deep
  chunks uniform). Digging should reveal plausible strata.
* `decorateColumn`: plants on suitable top blocks with AIR above (never on roads/floors/roofs):
  meadow: TALL_GRASS ~25–40 % of columns, flower clusters (yellow/white/blue by low-freq noise);
  forest: sparse grass in clearings, FERN patches, MUSHROOM near trunks; hills: DRY_GRASS, sparse
  grass; town yards: tall grass/dry grass (town agent may also place plants itself). Plants only ever
  replace AIR, never WATER: reeds stand in the first AIR cell above shallow water (≤ 3 voxels deep)
  or on MUD/SAND shoreline cells.

### 5.4 Flora & rocks (worldgen; town uses `stampTree/stampBush`)
* Real proportions at 10 cm: oak 12–18 m tall, trunk Ø 40–70 cm, broad irregular crown; birch 14–20 m,
  Ø 20–35 cm, white BIRCH bark, narrow airy crown; pine 15–22 m, straight Ø 30–50 cm reddish trunk,
  branches only in the upper half, layered needle clusters; apple (town yards) 4–6 m, gnarly; sapling
  1.5–3 m; dead tree (bare branches). Trunks: bark block on the outer ring, WOOD inside (chopping
  reveals wood), root flare + a few root ridges into the ground. Branches: tapered capsules, visible
  under the crown. Foliage: 6–14 clusters (Ø 1.5–3.5 m) of noise-deformed ellipsoids with
  low-frequency deformation around branch tips, gaps between clusters (~20–30 % of the crown envelope
  empty so sun flecks reach the ground), clusters ≥ 2 m as shells ≥ 4 voxels thick around an air
  core; **no per-voxel random holes** (face counts must stay low). Crown shyness: the plan passes
  `maxCrownRadius` so neighbouring crowns stay ≥ 0.3 m apart and ≥ 0.5 m from buildings/rocks.
* Bushes (BUSH, Ø 0.8–1.6 m), fallen logs (horizontal trunk, WOOD end faces), stumps, boulders
  (r 0.5–2 m, partly buried, moss on top), rock outcrops (tors) in the hills.
* Density: forest trees on a jittered grid ~5–8 m; hills pines ~9–14 m on gentler slopes; meadow a few
  solitary trees and bushes near the pond. Keep a clear area around the spawn.
* Plan: deer herds — forest 1 herd of 3, meadow 1 herd of 2 (≥ 25 m from the spawn), as `MobSpawn`s.
  Landmarks: «Городок», «Лес», «Пруд», «Холмы» (+ the town's own).

### 5.5 Abandoned town (town agent, `planTown`)
* Everything inside `TOWN_BUILD_RECT` on flat ground (`TOWN_GROUND_Y`). Return features (one per
  building/prop, roads as a few large features, `ORDER.*`), spawns, landmarks, `entrance`.
* Streets: 1–2 asphalt streets (~6 m wide, cracked, potholes with RUBBLE/GRAVEL, grass in cracks),
  CURB edges, raised PAVING sidewalks (1.5–2 m, missing pavers, weeds), a bus stop («Остановка»),
  2–3 lamp posts, a bench, a rusted car wreck (PAINTED_METAL, RUBBER, broken GLASS), fences
  (wooden picket, partly fallen), yards with GRASS, apple trees (`stampTree` kind 'apple') with apples
  lying under them (`ItemSpawn`), bushes, birch saplings growing out of gutters/roofs/ruins.
* 6–9 buildings, post-Soviet small-town style, real dimensions: walls 2–3 voxels thick, concrete
  foundation 2–3 voxels above ground, floors (PLANKS/LINOLEUM/TILES), 2-voxel slabs, interior walls
  with WALLPAPER/PLASTER, door openings 9×20 voxels (`DoorSpawn` each), windows ~12×14 voxels with a
  0.9 m sill, GLASS panes 1 voxel thick in DARK_WOOD/PAINTED_WOOD frames (~40 % of panes missing —
  no glass cubes on floors; glass debris only appears as particles when a pane breaks), gable roofs of SLATE/ROOF_TILES/ROOF_METAL with eaves overhang and holes,
  BRICK chimneys, stairs (2-voxel rise / 3-voxel run) in 2-storey buildings. Mix: two-storey red-brick
  house, 2–3 one-storey wooden houses, a shop «Продукты» (white brick, flat roof, shelves, counter),
  a garage/shed (ROOF_METAL), a two-storey plaster office/post office, one partly collapsed ruin.
* Decay: plaster patches fallen off (brick showing), cracks, rubble piles, moss, grass at thresholds.
* Interiors: voxel furniture (tables, chairs, beds and sofas of FABRIC, shelves, stove of METAL/TILES,
  bathroom tiles) + `ContainerSpawn`s + `ItemSpawn`s.
* Loot (must exist): **starter toolbox** (style 'toolbox') 2–4 m from `entrance`, in view: shovel,
  flashlight, apple ×2, newspaper ×1. Garage: pickaxe (cabinet). Shed or yard crate: axe. Houses:
  cloth ×2–3 (several places), torch ×2, canned_food (shop shelves/fridges), newspapers, sticks,
  rope. Two stray dogs (`MobSpawn` 'dog') in the streets.
* Landmarks: «Магазин», «Гараж», «Остановка», …

## 6. Rendering

### 6.1 Voxel world (render-core)
* **Octree LOD**: level-0 node = 64³ voxels at full resolution; level-L node = (64·2^L)³ voxels
  meshed as 64³ cells of 2^L voxels; roots = level 2 (256³ voxels; world = 5×2×5 roots). A node of
  level L ≥ 1 is replaced by its 8 children when the camera is within `RENDER.lodSplitDist[L-1]` of
  its AABB (18 m → full res, 40 m → 20 cm cells, farther 40 cm cells) and merged back beyond that +
  `RENDER.lodMergeMargin`. **Ready-gating per level**: a node is replaced by its children once all 8
  have a mesh of their own (or are known empty); each child then decides independently. Coarsening
  requires a current-epoch parent mesh. Never show holes. Details (epochs, staleness, budgets, vertex
  format, caching): the JSDoc of `src/render/voxel/chunkRenderer.ts` is normative.
* Mesh workers (`workerCount('mesh')`) read the shared world memory (`world.toShared()`; forward
  `world.onSegmentAdded`), build a 1-cell-padded volume, run the mesher, transfer typed arrays back.
  Skip jobs for nodes that are entirely uniform air, or uniform opaque with uniform opaque padding.
* **Downsampling** (level ≥ 1): per 2^L block: if opaque count ≥ 3/8 of the block (≥ 1/4 when the
  opaque voxels are mostly SUP.STRUCT — thin walls and trunks thicken at distance instead of
  vanishing) → opaque, choosing the most frequent type among *exposed* opaque voxels (air above), else
  the most frequent opaque type; else if water ≥ 1/4 → WATER; else if glass ≥ 1/4 → GLASS; else AIR.
  Plants dropped. Uniform chunks are downsampled in O(1).
* **Greedy mesher** per axis/slice merging faces with identical (block id, 4×AO, 4×sky). Classic
  3-neighbour vertex AO (4 levels) + diagonal flip at level 0; at levels ≥ 1 AO is left out of the
  merge key (AO = 3, −38 % quads). **Skylight** per vertex: average over the 4 columns around the
  vertex of `roof · leaf` where `roof = y ≥ sky ? 1 : max(0.25, 1 − (sky − y)/48)` and
  `leaf = y ≥ canopy ? 1 : 0.6`, quantised to 16 levels — interiors get dark, forest floors get shade,
  not darkness. Vertical faces average instead the 2 columns beside the vertex in 3 rows in front of
  the face, 0, 2 and 5 voxels out at level 0 (not the wall's own columns, which are under its roof;
  past the eaves), with per-level rows at coarser LODs (`SKY_ROWS` in mesher.ts).
  Face colour = side/top/bottom by direction. **Skirts**: on the node's side planes emit
  the outward face of every opaque border cell within 2 cells of a non-opaque cell even when the
  padding cell is opaque (hidden by depth when neighbours match; closes LOD cracks when they don't).
  Separate outputs: opaque, glass, water, plants (plants only at level 0).
* **Materials** (three lit materials via `onBeforeCompile`, so fog, sun shadows, hemisphere and pooled
  lights work): sRGB→linear in shader; per-voxel brightness/hue variation from a hash of the voxel cell
  (`floor((worldPos − normal·0.5·cell)/cell)`), amplitude = `VARY`; procedural sub-voxel `PAT`
  patterns in world space (at least SOIL, GRASS, STONE, BARK, BIRCH, LEAVES, BRICK, PLANKS, ASPHALT,
  PAVING, CORRUGATED, ROOF_TILES, TILES; fade patterns with distance to avoid aliasing); AO multiplies
  indirect light fully and direct light partially; skylight scales indirect (hemisphere) light.
  Water: transparent, animated ripples (normal perturbation with `uTime`), fresnel to
  `uHorizonColor`, sun glint. Glass: transparent tint α≈0.25 with highlight. Plants: two crossed
  double-sided quads per plant cell, height `PLANT_HEIGHT`×(0.7–1.2 by hash), random offset ±0.25,
  alpha-tested procedural canvas atlas (grass blades, flowers, fern, reeds, mushroom), wind sway on
  top vertices, faded out (alpha-test threshold or shrinking, not blending) by `RENDER.plantFadeEnd`.
  Beyond the shadow box sunlight is scaled towards the skylight term (see materials.ts JSDoc).
* Shadows: only opaque level-0 meshes cast; all opaque meshes and plants receive; glass/water/plants
  never cast.
  Bounding volumes from node bounds. Newly shown geometry ≤ `RENDER.uploadBytesPerFrame` per frame;
  prioritise edits (level 0, near first). `whenMeshed(chunks, cb)` lets FallingBody sync with re-meshing;
  `holdMeshes(chunks)` holds back the new meshes of a write spread over several frames — `add(chunks)`
  holds more as it goes — until its `release(cb)`, which turns it into a whenMeshed of all of them. Held
  nodes get no mesh jobs (each is meshed once, after the write); requests sharing a node swap together;
  no LOD split or merge involves a held node; a hold times out after 2 s of game time (`update`'s dt,
  0 while paused), a whenMeshed after 2 s of wall-clock time.
* Budgets: level-0 job ≤ 25 ms in a worker; prewarm ≤ 6 s; < 300 draw calls; ≤ 2 M world triangles.

### 6.2 Environment & FX (env-fx)
* `WebGLRenderer` (antialias, high-performance, shadows PCF + normalBias, ACES, sRGB output, pixel
  ratio ≤ `RENDER.pixelRatioCap`); camera fov 75, near 0.5, far 4000, added to the scene.
* **Day/night** from `ctx.time.timeOfDay`: sunrise ≈ 5:30, sunset ≈ 20:30, sun arcs E→S→W; warm low sun,
  orange/pink twilight, moonlit (dim blue) nights that are dark but playable. Sky dome shader (zenith/
  horizon gradient, sun disc + glow, stars at night, simple drifting cloud layer), `FogExp2` coloured
  like the horizon (day visibility ~150 m), hemisphere light (sky/ground colours by time), ONE
  shadow-casting `DirectionalLight` acting as sun by day and moon by night, shadow box
  ±`RENDER.shadowExtent` following the player, texel-snapped, shadow map re-rendered every second frame.
  Updates `sharedUniforms` every frame. `precompile()` compiles all programs before the start screen;
  `stats()` reports the main pass (snapshot before the view-model overlay).
* **Horizon ring**: fake low-res terrain outside the 128 m map (from the map edge out to ~600 m),
  heights continuing the edge (`terrain.surfaceY` at the clamped edge) into rolling hills, vertex
  coloured by the adjacent biome, darker forest-like bumps; never overlaps the playable area.
* **Underwater** (`ctx.player.eyeInWater`): teal dense fog + tint.
* `LightPool`: `RENDER.maxPointLights` point lights + flashlight spot (child of the camera, target too),
  created once. env-fx owns the presets: `acquire('torch' | 'campfire')` sets colour/intensity/range
  and animates flicker; callers only position and release. `setFlashlight(on)`.
* `Particles`: instanced cubes (debris, splash, dust; bounce/rest on solid voxels via `WorldData`),
  sprite flames & smoke (`fire()`); fixed pools, one draw call each.
* `ViewModel`: overlay scene/camera (depth cleared), hand (`getHandGeometry`) + held item
  (`getItemGeometry` + `getItemHoldPose`), lighting mirrored from the main scene, animations: idle sway,
  walk bob ∝ speed, swing/chop/dig arcs, use/eat (to mouth), place (push); torch glow sprite.

## 7. Player (player agent)
* Body 0.6 × 1.8 m (`PLAYER`), eye 1.65 m; crouch 1.4 m. Acceleration-based ground movement with
  friction, 30 % air control, coyote time 0.1 s, jump only from ground. **Auto step-up** ≤ 4 voxels with
  a smoothed camera (no jitter on 10 cm steps — walking on natural terrain must feel smooth).
  **Mantle**: holding Space against a ledge ≤ `PLAYER.mantleHeight` (1.2 m) above the feet with head
  clearance climbs onto it over `PLAYER.mantleTime` (from the ground, mid-jump, swimming; auto-crouch if
  only crouch height fits) — logs, boulders, window sills, pit edges. Optional: slow down on sustained
  steep climbs. Can't stand up under a ceiling. Swimming (buoyancy, drag, Space to rise, splash).
  Fly/noclip (V). Invisible walls 0.5 m inside the map edges. Collides with `ctx.entities.solidBoxes`.
* Footsteps every ~0.55 m (0.75 m sprinting) by the block under the feet:
  dirt/clay/mud → `step_dirt`; grass/moss/litter → `step_grass`; sand → `step_sand`;
  gravel/rubble → `step_gravel`; stone/brick/concrete/asphalt/paving/curb/tiles → `step_stone`;
  logs/wood/planks → `step_wood`; metal → `step_metal`; swimming → `swim`. `land` after falls > 1 m.
* Input: pointer lock per the `input.ts` JSDoc (requestLock() → Promise<boolean>, refusals reported via
  onLockChange(false), never locks by itself), `consume()`/`consumeMouse()`, keys cleared on blur,
  Tab/F3/Backquote/Space/arrows default prevented, wheel normalised (Mac trackpads: one step per ~50 px).
* `raycastVoxels`: DDA, returns entry face normal; default accepts solids, foliage and plants; tall
  plants are hit through the air cells they visually fill (see JSDoc); optional `out` object.
* Audio (`game/audio.ts`, owned by the player agent): see §11.4.

## 8. Items, crafting, UI (items-ui)
* `game/items.ts` (spine) is the registry. Materials stack to 1000 (dm³), tools 1.
* **Recipes** (exactly these):
  1. «Палки» ×4 ← Древесина ×2
  2. «Верёвка» ×1 ← Трава ×6
  3. «Каменный топор» ×1 ← Палка ×2 + Камень ×3 + Верёвка ×1
  4. «Костёр» ×1 ← Палка ×6 + Камень ×8
  5. «Факел» ×2 ← Палка ×1 + Тряпка ×1
  6. «Доски» ×8 ← Древесина ×8
  7. «Жареное мясо» ×1 ← Сырое мясо ×1 (needs a campfire within `GAMEPLAY.campfireRadius`)
  8. «Палки» ×4 ← Доски ×2 (sticks from the town's planks)
* HUD, inventory/crafting/container screen, menus, map, icons — see the stub JSDoc in `src/ui/*`.
  Style: clean, semi-transparent dark panels, rounded corners, subtle borders, readable 13–15 px
  type, no external fonts/assets. The start screen shows the controls:
  WASD — ходьба, Пробел — прыжок/всплытие, Shift — бег, C — присесть, V — полёт, ЛКМ — копать/рубить/
  ударить, ПКМ — поставить/использовать, E — взаимодействовать/подобрать, Q — выбросить,
  [ ] — размер блока, R — точный режим, 1–9/колесо — слот, Tab — инвентарь и крафт, M — карта,
  T (удерживать) — ускорить время, F3 или ` (клавиша Ё) — отладка, Esc — пауза.
  A dismissable first-minutes hint should point at the starter toolbox («Ящик с инструментами рядом»).

## 9. Art (art agent)
* `buildVoxelGeometry`: greedy mesh of a colour grid (merge equal colour + AO), normals, linear vertex
  colours with per-cell jitter, baked AO, bounds. `getModelMaterial()`: one shared lit material.
* Models at 1 cm (realistic sizes): stone_axe (45 cm haft, lashed stone head), axe (60 cm handle, steel
  head), shovel (Russian штыковая: ~120 cm straight handle, pointed 20×28 cm blade), pickaxe (80 cm),
  flashlight (20 cm), torch (50 cm, wrapped top with embers), campfire (stone ring Ø 60 cm + log
  teepee), stick, rope coil, cloth, hide, grass bundle, flower, reed bundle, mushroom, apple (Ø 7 cm),
  can of stew, raw/cooked meat, folded newspaper; materials → a 10 cm cube of the block's colours
  (top colour on top). Hand: jacket sleeve + hand, ~30 cm. Doors (wood planks / painted peeling /
  rusty metal, 4 cm thick, handle). Containers: crate 60×40×40 (lid), cabinet 60×180×40 (door),
  fridge 60×160×60 (door), toolbox 50×25×25 red (lid). Mob rigs: roe deer (~110 cm long, 70 cm at
  the shoulder, reddish-brown, white rump, black nose, big ears) and a mongrel dog (~55 cm at the
  shoulder, tan with darker back, curled tail) with the part names in the stub.
* Everything cached and built lazily.

## 10. Entities & mobs (entities agent) — see stub JSDoc in `src/game/entities/*`, `src/game/mobs/*`
* Mobs face +Z in model space: `object.rotation.y = atan2(dir.x, dir.z)`.
* Deer stay in natural biomes (avoid the town), avoid water and drops > 1.5 m; far mobs (> 60 m) update
  at a reduced rate. Deer numbers (notice/flee distances, crouch stealth, calm-down, stagger, health 9)
  are pinned in the `deer.ts` JSDoc. Dog AI per stub. Mob cost must be tiny.
* Doors/containers are solid (`solid = true`) when closed; item drops/campfires are not.
* Release pooled lights and audio loops in `onRemove`.

## 11. Interaction (interaction agent)

### 11.1 Breaking model
While LMB is held and the target is a voxel, swings repeat every `stats.swingTime` (`stats` = the
selected item's `ToolStats`, else `HAND`). Per swing on target voxel *t* (hardness *H*, class *C*):
* `H = Infinity` → nothing (hint «Не разрушить»).
* `match = C === TOOL.NONE || stats.toolClass === C`. Power: hand → 1.0 on `TOOL.NONE` blocks, else
  `HAND.power`; tool → `stats.power` if match else `stats.power × 0.35`.
* `damage[t] += power`; HUD progress = damage / H (reset when the target voxel changes).
* When damage ≥ H: brush radius = `match && !precise ? stats.radius : 0` (hand radius 0). Remove every
  voxel *v* within the sphere centred on *t*'s centre with radius `radius + 0.5` that satisfies
  `TOOL_CLASS[v] === C && HARDNESS[v] ≤ 1.5·H + 0.05`, or is a plant — never BEDROCK/WATER.
  Then remove plants standing on removed voxels.
* Each removed voxel adds its `drop` item (aggregated per type); what doesn't fit spawns an `ItemDrop`.
  Particles (`blockBreak`), sound by sound material (`dig_dirt`, `dig_sand`, `dig_gravel`,
  `dig_stone`, `chop_wood`, `leaves`, `plant`, `glass_break`, `metal_hit`, `fabric`), view-model swing
  (`dig` for shovel, `chop` for axe, `swing` otherwise).
* LMB on an entity with `onHit`: one hit per swing → `onHit(ctx, {damage: stats.damage, dir, tool})`.
* Block hints name the preferred tool and whether the held one fits, e.g. «ЛКМ — копать (лучше
  лопатой)», «ЛКМ — колоть (нужна кирка — рукой очень долго)»; TOOL.NONE blocks show just the action.

### 11.2 Placing and using (RMB, repeat every 0.2 s while held)
* Material selected + block target: cube of `placeSize` voxels adjacent to the clicked face (extends
  away from the face, centred on the anchor in the other axes) — or, when the target is a plant, the
  cube starts in the plant's own cell (replacing it) — only into replaceable cells, not intersecting
  the player or solid entities, consuming one item per voxel (nearest cells first until the stack
  runs out). Sound `place`, view-model `place`.
* Food → eat (consume 1, toast `food.message`, `eat`). Flashlight → toggle (`flashlight` sound).
  Campfire → place on a top face (`new Campfire(...)`, consume 1). Note → `hud.showNote`, `paper`.
* E → `entity.interact(ctx)` on the targeted entity. Q → drop 1 (Shift+Q: whole stack) as an
  `ItemDrop` thrown forward. `[`/`]` → place size through `GAMEPLAY.placeSizes`; R → precise toggle.
* Held lights: `lights.setFlashlight(flashlightOn && flashlight selected)`; torch selected →
  `lights.acquire('torch')` positioned near the right hand (release when deselected).
* HUD: `hud.setTarget({title: block name / entity.displayName, hint})`, `hud.setBreakProgress`.

### 11.3 Collapse, falling bodies, water
* After removals: `findDetached(world, removedPositions, GAMEPLAY.supportSearchBudget)` (support only
  through STRUCT/ANCHOR; pieces take their foliage along — see `structure.ts` JSDoc); pieces < 40
  voxels → removed and turned into item drops; larger → `FallingBody` (trees topple away from the
  player, other pieces drop), synced with re-meshing via `ctx.chunks.whenMeshed`, re-voxelised on
  landing (dust, `tree_fall`/`impact`). Foliage is passable, so a felled crown never walls the player in.
* **Felling worker** (client `interaction/felling.ts`, entry `felling.worker.ts`, jobs `fellingJob.ts`; a
  read-only `WorldData` of the shared memory like the mesh workers): the main thread only writes the
  world. A removal next to no STRUCT voxel (`touchesStruct`) costs nothing more; otherwise a **detach**
  job runs findDetached and, per falling piece, `planFall` (grid, toppling decision, pivot, axis, probes),
  its mesh arrays and touched chunks, and sends its voxels in chunk order. **One job in flight**: removals
  made meanwhile merge into one queued batch, posted only after the answer was applied (its world edits
  made), so no two jobs detach the same piece. **Staleness**: a job reports the box of every voxel it
  read; the answer is applied (`Aftermath.update`, first thing in `Interaction.update`, also while a
  screen is open) only if no chunk overlapping that box changed its `world.chunkVersion` since the
  snapshot taken right before posting — else its seeds are re-posted with the queued batch. After 3 stale
  answers in a row, or an error answer, the batch is analysed on the main thread (fresh, so applied
  without asking again) and a **mesh** job (no world reads) makes its falling pieces' meshes; the pieces
  stay in the world until then, and if the analysis' read box was edited meanwhile it runs here once more
  and is applied at once (a piece that came out the same keeps its mesh). No worker (node tests, failed
  start, `onerror`, a job unanswered for 600 updates) → synchronous for good (same call, meshes included,
  unless a write in slices is in progress: see below).
* `FallingBody` vacates its piece in the constructor (a big one a slice per frame, see below) and is
  hidden in that frame. From the next one until `whenMeshed` fires — for every chunk the vacate marked
  dirty (`World.recordMarks`), the ground that loses the crown's shade included — it is rendered with an
  empty draw range and no frustum culling — nothing drawn, but three.js uploads its buffers then: neither
  in the vacate frame nor (unless the world re-meshes by the next frame) in the frame the world's meshes
  swap. On landing, dust and sound play at once while a **land** job scans the cells the posed piece
  fills (inverse sampling, no writes) and lists them in chunk order with their chunks; the next update
  writes them (`writeLanding`: every cell re-checked against the world, the player's box *at that time*
  vetoed; a big landing a slice per frame; then the skeleton joins, worked out on the main thread) and
  waits for every chunk that marked dirty. Synchronous `revoxelize` without a worker, as soon as no
  answer can come (the scan failed, the worker was given up) or after 1 s without one.
* **Writes in slices** (a felled oak's ~150 k voxels written at once cost 10–20 ms twice; the target is
  ≤ ~3 ms of felling work a frame, not a guarantee — node bench, biggest oak: warm, its first vacate
  frame 1.3–2.8 ms (single spikes to ~4.4 ms), the others ≤ ~1.4 ms, landing frames ≤ 1.3–2.5 ms; cold,
  its first vacate frame 4.3–5.3 ms and first landing frame 2.4–4.2 ms; in Chrome, seed 20261103's
  oaks of 86–120 k voxels peak at 1.5–2.3 ms warm and 3.4 ms in the first felling after page load,
  against 12–23 ms written at once; several bodies started in one frame each write their first slice
  in it): a body vacating or landing more than `WRITE_SLICE_VOXELS`
  (10 000) voxels writes a slice per frame — whole chunk runs up to that budget (`sliceEnd`; the
  worker's chunk order, `sortByChunk`: column stacks of chunks, so each chunk is written in one slice
  and each column's sky rescanned once a slice) — and a landing's skeleton joins come after its cells,
  `JOIN_SLICE_VOXELS` (2 000) skeleton voxels a frame. Nothing half written shows:
  `ChunkRenderer.holdMeshes` keeps the meshes of every chunk a slice marks dirty (`World.recordMarks`:
  its chunks, their neighbours, and those whose skylight it changes — the ground under a crown) as they
  were until the write is complete, then all swap together, the body with them (a write done in one
  frame waits with `whenMeshed` for the same set). A render node spans 2×2×2 chunks, so several slices
  dirty it: held nodes get no mesh jobs, and each is meshed once, against the whole write. The hold
  times out in game time only — a paused game stops the write and its hold alike. Nothing half written
  is analysed: from its first slice to its last the body holds the felling client's **write guard**
  (`beginWrite` / `endWrite`), as an analysis of a half-vacated piece would detach its fragments (a
  second body for the same voxels) and one of a half-landed piece fragments of a landing not joined yet.
  Meanwhile `detach()` only queues; a fresh answer to the job in flight is still applied (every slice
  bumps the versions of the chunks it writes, so it read none of them), and whatever else would read the
  world — asking again, analysing here, posting or running the queued batch — waits, the batch back in
  the queue, for the first update without a write in progress. Land jobs are not affected. Nothing half
  written is touched by the player either: the voxels holding a writer's blocks where it puts them — the
  piece it has not vacated yet, the landing cells it has written but not joined yet — are not there for
  the crosshair or a brush (`FellingClient.owned`), as when such a write took one frame: dug, they would
  come back with the landing (in the world and in the inventory); built against, a block would hang in
  the air. A body removed mid-write (its update threw) ends the guard and releases the hold. Every
  `World.setBlocks` marks only the chunks it touched (listed, not found by a pass over all 25 600), so
  an axe swing's few voxels cost microseconds even in unoptimised code.
* Water: a removed cell adjacent (sides/above) to WATER is filled with water and the fill floods into
  connected AIR cells at or below the source surface level (BFS, `GAMEPLAY.waterFillBudget`): dug cells
  at once, crumbled pieces' cells when they crumble.

### 11.4 Audio (owned by the player agent)
WebAudio synthesis only (noise bursts, filtered envelopes, oscillators); positional with distance
attenuation; ambience (wind; birds by day in forest/meadow; crickets at night; quieter town);
`setPaused` mutes. Unlock on the start click; before that every call is a silent no-op.

## 12. Performance budgets (M1, 1440×900, DPR 1)
60 FPS at spawn, ≥ 45 FPS worst case (forest interior); main thread logic < 4 ms/frame; newly shown
voxel geometry ≤ 1.5 MB/frame; < 300 draw calls (excluding shadows); ≤ 2 M world triangles in the main
pass; world memory ≤ 200 MB; voxel mesh cache ≤ 150 MB; generation < 8 s; prewarm < 6 s.

## 13. Report format (every implementation agent)
Return: files created/modified; what is implemented; public API notes the lead must know for wiring;
`SPINE REQUESTS` (changes needed in files you don't own); tests written + results; known limitations.
