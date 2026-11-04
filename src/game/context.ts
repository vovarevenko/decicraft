/**
 * The bag of systems passed to every update. Built once in main.ts; systems keep no globals.
 */
import type * as THREE from 'three';
import type { TerrainSampler, WorldPlan } from '../gen/types';
import type { GameRenderer } from '../render/renderer';
import type { Particles } from '../render/particles';
import type { ViewModel } from '../render/viewModel';
import type { ChunkRenderer } from '../render/voxel/chunkRenderer';
import type { Hud } from '../ui/hud';
import type { InventoryScreen } from '../ui/inventoryScreen';
import type { MapView } from '../ui/mapView';
import type { Menu } from '../ui/menu';
import type { World } from '../world/world';
import type { GameAudio } from './audio';
import type { EntityManager } from './entities/entityManager';
import type { Input } from './input';
import type { Interaction } from './interaction';
import type { Inventory } from './inventory';
import type { Player } from './player';

export interface GameTime {
  /** Seconds of unpaused game time since start. */
  elapsed: number;
  /** In-game hour, 0 ≤ t < 24. */
  timeOfDay: number;
  /** Current time-of-day speed multiplier (1, or TIME.fastForwardMult while T is held). */
  speed: number;
}

export interface GameContext {
  world: World;
  terrain: TerrainSampler;
  plan: WorldPlan;
  renderer: GameRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  chunks: ChunkRenderer;
  particles: Particles;
  viewModel: ViewModel;
  input: Input;
  player: Player;
  inventory: Inventory;
  entities: EntityManager;
  interaction: Interaction;
  audio: GameAudio;
  hud: Hud;
  inventoryScreen: InventoryScreen;
  menu: Menu;
  map: MapView;
  time: GameTime;
}
