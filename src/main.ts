/**
 * Boot sequence: plan → generate world (workers) → renderer + LOD prewarm → systems → start screen.
 * OWNER: integration (lead).
 */
import './ui/styles.css';
import { TIME, WORLD_SEED } from './config';
import { GameAudio } from './game/audio';
import type { GameContext } from './game/context';
import { EntityManager } from './game/entities/entityManager';
import { spawnFromPlan } from './game/entities/spawn';
import { Game } from './game/game';
import { Input } from './game/input';
import { Interaction } from './game/interaction';
import { Inventory } from './game/inventory';
import { Player } from './game/player';
import { generateWorld } from './gen/generateWorld';
import { createWorldPlan } from './gen/plan';
import { createTerrain } from './gen/terrain';
import { Particles } from './render/particles';
import { GameRenderer } from './render/renderer';
import { ViewModel } from './render/viewModel';
import { ChunkRenderer } from './render/voxel/chunkRenderer';
import { Hud } from './ui/hud';
import { InventoryScreen } from './ui/inventoryScreen';
import { MapView } from './ui/mapView';
import { Menu } from './ui/menu';
import { World } from './world/world';

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

/**
 * Debug URL parameters (QA): ?seed=N, ?pos=x,z or x,y,z (metres), ?yaw=deg, ?pitch=deg, ?time=hour,
 * ?autostart (run the loop without the start screen / pointer lock; drive it via window.__game).
 */
function readDebugParams() {
  const q = new URLSearchParams(location.search);
  const num = (k: string): number | null => {
    const v = q.get(k);
    return v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  };
  const pos = q.get('pos')?.split(',').map(Number).filter(Number.isFinite) ?? null;
  return {
    seed: num('seed'),
    pos: pos && pos.length >= 2 ? pos : null,
    yaw: num('yaw'),
    pitch: num('pitch'),
    time: num('time'),
    autostart: q.has('autostart'),
  };
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const menu = new Menu(uiRoot);
  /** Set once the loop exists: an uncaught error is fatal, and a loop left running would throw it every frame. */
  let stopGame = (): void => {};
  const fail = (e: unknown) => {
    stopGame();
    if (menu.showError(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e))) console.error(e);
  };
  window.addEventListener('error', (ev) => fail(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => fail(ev.reason));

  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    menu.showError(
      'Страница открыта без изоляции от других источников (заголовки COOP/COEP), поэтому ' +
        'SharedArrayBuffer недоступен. Запустите игру через «npm run dev» или «npm run preview».',
      'Игра не может запуститься.',
    );
    return;
  }

  const dbg = readDebugParams();
  menu.showLoading('Планирование мира…', 0);
  await nextFrame();
  const seed = dbg.seed ?? WORLD_SEED;
  const t0 = performance.now();
  const plan = createWorldPlan(seed);
  const terrain = createTerrain(seed);
  const world = World.create();
  await generateWorld(world, seed, (done, total) => menu.showLoading('Генерация мира…', 0.03 + (0.62 * done) / total));
  const t1 = performance.now();

  const renderer = new GameRenderer(canvas, terrain);
  const chunks = new ChunkRenderer(renderer.scene, world);
  const spawn = { ...plan.playerSpawn };
  if (dbg.pos) {
    spawn.x = dbg.pos[0] * 10;
    spawn.z = dbg.pos[dbg.pos.length - 1] * 10;
    spawn.y = dbg.pos.length >= 3 ? dbg.pos[1] * 10 : world.topSolidY(Math.floor(spawn.x), Math.floor(spawn.z));
  }
  if (dbg.yaw !== null) spawn.yaw = (dbg.yaw * Math.PI) / 180;
  spawn.y = world.floorBelow(spawn.x, spawn.y, spawn.z);
  await chunks.prewarm(spawn, (done, total) =>
    menu.showLoading('Построение геометрии…', 0.65 + (0.33 * done) / Math.max(1, total)),
  );
  const t2 = performance.now();
  console.info(
    `[boot] generation ${(t1 - t0).toFixed(0)} ms, meshing ${(t2 - t1).toFixed(0)} ms, chunks ${world.allocatedChunks}`,
  );

  const input = new Input(canvas);
  const ctx: GameContext = {
    world,
    terrain,
    plan,
    renderer,
    scene: renderer.scene,
    camera: renderer.camera,
    chunks,
    particles: new Particles(renderer.scene, world),
    viewModel: new ViewModel(),
    input,
    player: new Player(spawn),
    inventory: new Inventory(),
    entities: new EntityManager(renderer.scene),
    interaction: new Interaction(),
    audio: new GameAudio(),
    hud: new Hud(uiRoot),
    inventoryScreen: new InventoryScreen(uiRoot),
    menu,
    map: new MapView(uiRoot),
    time: { elapsed: 0, timeOfDay: dbg.time ?? TIME.startHour, speed: 1 },
  };
  if (dbg.pitch !== null) ctx.player.pitch = (dbg.pitch * Math.PI) / 180;
  spawnFromPlan(ctx, plan.spawns);
  ctx.map.init(ctx);
  ctx.player.applyToCamera(ctx.camera);
  ctx.renderer.update(0, ctx);
  menu.showLoading('Подготовка шейдеров…', 0.99);
  await ctx.renderer.precompile(ctx.viewModel);
  ctx.renderer.render(null);
  menu.hideLoading();

  const game = new Game(ctx);
  stopGame = () => game.stop();
  (window as unknown as { __game: GameContext }).__game = ctx; // debugging handle
  if (dbg.autostart) {
    // QA mode: no pointer lock — treat input as live whenever no UI screen is open. Never ask for the lock:
    // without a user gesture the request is refused, and closing a UI screen would open the pause menu.
    Object.defineProperty(input, 'active', { get: () => !input.uiOpen });
    input.requestLock = () => Promise.resolve(true);
    game.start();
    return;
  }
  menu.showStart(() => {
    ctx.audio.unlock();
    game.start();
    void input.requestLock();
  });
}

void boot();
