/**
 * Main loop and global keys. OWNER: integration (lead). Systems are updated in a fixed order;
 * every system reads gameplay input only when `ctx.input.active`.
 *
 * Global keys (read with consume, so no other system sees them): Tab / KeyI toggle the inventory,
 * KeyM toggles the map, F3 / Backquote toggle the debug panel, Digit1–9 and the wheel pick the hotbar
 * slot, KeyT (held) fast-forwards time. Esc while playing exits pointer lock (browser) → pause menu.
 * While paused the frozen scene is not re-rendered (it sits under the menu's blur), the sound is
 * muted and the chunk renderer, which keeps meshing, gets no game time (dt 0); the sound is also
 * muted while the tab is hidden. stop() ends the loop for good (fatal error).
 */
import { BIOME_NAMES, TIME } from '../config';
import { HOTBAR_SIZE } from './inventory';
import type { GameContext } from './context';

export class Game {
  private last = 0;
  private running = false;
  private paused = false;
  /** Draw the frozen scene once more while paused (a resize cleared the canvas). */
  private redrawPaused = false;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;
  /** Longest frame (wall clock, ms) since the debug panel was last updated. */
  private worstFrameMs = 0;

  constructor(private readonly ctx: GameContext) {
    ctx.input.onLockChange = (locked) => {
      if (!this.running) return;
      if (locked) {
        if (this.paused) this.unpause();
      } else if (!ctx.input.uiOpen) {
        this.pause();
      }
    };
    // With a screen open (inventory, map, note) the tab can be left without a lock change, so no pause;
    // a hidden tab gets no frames either, and its ambience and campfire loops would play on.
    document.addEventListener('visibilitychange', () => {
      if (!this.running) return;
      ctx.audio.setPaused(this.paused || document.hidden);
      if (!document.hidden) this.last = performance.now(); // the time spent hidden is not a frame
    });
    window.addEventListener('resize', () => {
      this.redrawPaused = true;
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  /** Ends the loop for good (fatal error: every frame would throw again); mutes the sound, frees the pointer. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.ctx.audio.setPaused(true);
    this.ctx.input.releaseLock();
  }

  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.ctx.audio.setPaused(true);
    this.ctx.menu.showPause(() => void this.ctx.input.requestLock());
  }

  /** Runs once the pointer is really locked again (the pause menu stays up if the request is refused). */
  private unpause(): void {
    this.ctx.menu.hidePause();
    this.paused = false;
    this.ctx.audio.setPaused(false);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const ctx = this.ctx;
    const elapsed = Math.max(0, (now - this.last) / 1000);
    const dt = Math.min(0.05, elapsed);
    this.last = now;

    if (!this.paused) {
      this.handleGlobalKeys();
      const t = ctx.time;
      const h = t.timeOfDay;
      const night = h >= TIME.nightStartHour || h < TIME.nightEndHour;
      t.elapsed += dt;
      t.speed = (ctx.input.active && ctx.input.isDown('KeyT') ? TIME.fastForwardMult : 1) * (night ? TIME.nightSpeedMult : 1);
      t.timeOfDay = (h + (dt * t.speed * 24) / TIME.dayLengthS) % 24;

      ctx.player.update(dt, ctx);
      ctx.interaction.update(dt, ctx);
      ctx.entities.update(dt, ctx);
      ctx.world.flush();
      ctx.player.applyToCamera(ctx.camera);
      ctx.renderer.update(dt, ctx);
      ctx.particles.update(dt);
      ctx.viewModel.setItem(ctx.inventory.selectedStack()?.id ?? null);
      ctx.viewModel.update(dt, ctx);
      ctx.audio.update(dt, ctx);
    }
    // Meshing goes on while paused, but game time does not: a hold on the meshes of a write in slices waits for its body.
    ctx.chunks.update(ctx.camera, this.paused ? 0 : dt);
    ctx.inventoryScreen.update(ctx);
    ctx.map.update(ctx);
    ctx.hud.update(ctx, dt);
    this.updateDebug(elapsed);
    // Paused, every frame would be the same image, blurred again by the menu backdrop: keep the last one.
    if (!this.paused || this.redrawPaused) {
      ctx.renderer.render(ctx.viewModel);
      this.redrawPaused = false;
    }
    ctx.input.endFrame();
  };

  private handleGlobalKeys(): void {
    const ctx = this.ctx;
    const { input, inventory, inventoryScreen, map, hud } = ctx;
    if (input.consume('F3') || input.consume('Backquote')) hud.toggleDebug();

    const invKey = input.consume('Tab') || input.consume('KeyI');
    if (invKey) {
      if (inventoryScreen.isOpen) inventoryScreen.close(ctx);
      else if (input.active) inventoryScreen.open(ctx);
    }
    if (input.consume('KeyM')) {
      if (map.isOpen || input.active) map.toggle(ctx);
    }
    if (!input.active) return;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      if (input.consume(`Digit${i + 1}`)) inventory.selected = i;
    }
    if (input.wheel !== 0) {
      inventory.selected = (((inventory.selected + input.wheel) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    }
  }

  /** `elapsed`: wall-clock seconds of the frame (not the simulation dt, which is capped at 50 ms). */
  private updateDebug(elapsed: number): void {
    this.fpsFrames++;
    this.fpsTime += elapsed;
    this.worstFrameMs = Math.max(this.worstFrameMs, elapsed * 1000);
    if (this.fpsTime < 0.5) return;
    this.fps = Math.round(this.fpsFrames / this.fpsTime);
    const worstMs = Math.round(this.worstFrameMs);
    this.fpsFrames = 0;
    this.fpsTime = 0;
    this.worstFrameMs = 0;
    const ctx = this.ctx;
    const r = ctx.renderer.stats();
    const c = ctx.chunks.stats();
    const p = ctx.player.position;
    const hh = Math.floor(ctx.time.timeOfDay);
    const mm = Math.floor((ctx.time.timeOfDay - hh) * 60);
    ctx.hud.setDebug({
      fps: this.fps,
      'макс. кадр, мс': worstMs,
      drawCalls: r.drawCalls,
      triangles: r.triangles,
      'позиция, м': `${(p.x / 10).toFixed(1)} ${(p.y / 10).toFixed(1)} ${(p.z / 10).toFixed(1)}`,
      биом: BIOME_NAMES[ctx.terrain.biomeAt(Math.floor(p.x), Math.floor(p.z))],
      время: `${hh}:${String(mm).padStart(2, '0')}`,
      'узлы (видимые/кэш)': `${c.visibleNodes}/${c.cachedNodes}`,
      'треугольники мира': c.triangles,
      'задачи мешинга': c.pendingJobs,
      сущности: ctx.entities.all.length,
      'чанки в памяти': ctx.world.allocatedChunks,
    });
  }
}
