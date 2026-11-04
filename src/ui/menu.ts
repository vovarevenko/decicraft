/**
 * Full-screen menus: loading (progress), start screen (title, short intro, controls), pause,
 * fatal error. OWNER: agent "items-ui". All text in Russian.
 *
 * «Начать» and «Продолжить» are real <button>s: their click is the user gesture that lets the callbacks
 * request pointer lock and unlock audio. The pause screen stays up until hidePause() — game.ts calls
 * it only once the lock is granted — and after a click it shows a hint to click again in case the
 * browser refused the lock (Chrome does for ~1 s after Esc).
 */
import { buildControls, CONTROLS } from './controls';
import { el } from './dom';

/** Distinct error messages kept on the error screen (repeats from a failing frame loop are dropped). */
const MAX_ERRORS = 6;
const ERROR_NOTE = 'Игра не может продолжить работу. Подробности для разработчиков:';

export class Menu {
  private readonly loading: HTMLDivElement;
  private readonly loadingFill: HTMLDivElement;
  private readonly loadingStage: HTMLSpanElement;
  private readonly loadingPercent: HTMLSpanElement;
  private readonly start: HTMLDivElement;
  private readonly startButton: HTMLButtonElement;
  private readonly pause: HTMLDivElement;
  private readonly resumeButton: HTMLButtonElement;
  private readonly error: HTMLDivElement;
  private readonly errorNote: HTMLParagraphElement;
  private readonly errorText: HTMLPreElement;
  private readonly errors: string[] = [];
  private onStart: (() => void) | null = null;
  private onResume: (() => void) | null = null;
  private stageLabel = '';
  private percent = -1;

  constructor(root: HTMLElement) {
    const layer = el('div', 'menu-layer');

    // ---- loading
    this.loading = el('div', 'menu-screen menu-loading');
    this.loading.hidden = true;
    const bar = el('div', 'menu-progress');
    this.loadingFill = el('div', 'menu-progress-fill');
    bar.append(this.loadingFill);
    const status = el('div', 'menu-status');
    this.loadingStage = el('span', 'menu-status-stage');
    this.loadingPercent = el('span', 'menu-status-percent');
    status.append(this.loadingStage, this.loadingPercent);
    this.loading.append(titleBlock(), bar, status);

    // ---- start
    this.start = el('div', 'menu-screen menu-backdrop');
    this.start.hidden = true;
    const startCard = el('div', 'menu-card');
    const intro = el(
      'p',
      'menu-intro',
      'Мир 128 × 128 метров собран из кубиков 10 × 10 × 10 сантиметров. В нём есть заброшенный ' +
        'городок, лиственный лес, луг с прудом и скалистые холмы. Цели нет — исследуйте, копайте, ' +
        'рубите деревья, стройте и мастерите. Начните с ящика с инструментами у въезда в городок.',
    );
    this.startButton = el('button', 'btn btn-primary', 'Начать');
    this.startButton.type = 'button';
    this.startButton.addEventListener('click', () => {
      const cb = this.onStart;
      if (cb === null) return;
      this.onStart = null;
      this.start.hidden = true;
      cb();
    });
    const startActions = el('div', 'menu-actions');
    startActions.append(this.startButton);
    startCard.append(titleBlock(), intro, el('h2', 'menu-heading', 'Управление'), buildControls(CONTROLS, 'menu-controls'), startActions);
    this.start.append(startCard);

    // ---- pause
    this.pause = el('div', 'menu-screen menu-backdrop menu-pause');
    this.pause.hidden = true;
    const pauseCard = el('div', 'menu-card');
    this.resumeButton = el('button', 'btn btn-primary', 'Продолжить');
    this.resumeButton.type = 'button';
    this.resumeButton.addEventListener('click', () => {
      this.pause.classList.add('tried');
      this.onResume?.();
    });
    const pauseActions = el('div', 'menu-actions');
    pauseActions.append(this.resumeButton, el('div', 'menu-retry-hint', 'Если игра не продолжилась, нажмите ещё раз'));
    pauseCard.append(el('h1', 'menu-pause-title', 'Пауза'), buildControls(CONTROLS, 'menu-controls'), pauseActions);
    this.pause.append(pauseCard);

    // ---- fatal error
    this.error = el('div', 'menu-error');
    this.error.hidden = true;
    const errorCard = el('div', 'menu-error-card');
    this.errorText = el('pre', 'menu-error-text');
    this.errorNote = el('p', 'menu-error-note', ERROR_NOTE);
    errorCard.append(el('h2', 'menu-error-title', 'Ошибка'), this.errorNote, this.errorText);
    this.error.append(errorCard);

    layer.append(this.loading, this.start, this.pause, this.error);
    root.append(layer);
  }

  /** Loading screen with a stage label and overall progress 0..1. */
  showLoading(label: string, progress: number): void {
    this.loading.hidden = false;
    if (label !== this.stageLabel) {
      this.stageLabel = label;
      this.loadingStage.textContent = label;
    }
    const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
    if (pct !== this.percent) {
      this.percent = pct;
      this.loadingFill.style.width = `${pct}%`;
      this.loadingPercent.textContent = `${pct} %`;
    }
  }

  hideLoading(): void {
    this.loading.hidden = true;
  }

  /** Title + controls; the click on «Начать» (a user gesture) calls onStart (which requests pointer lock and unlocks audio). */
  showStart(onStart: () => void): void {
    this.onStart = onStart;
    this.start.hidden = false;
    this.startButton.focus({ preventScroll: true });
  }

  /** Pause overlay (controls reminder); clicking «Продолжить» calls onResume. */
  showPause(onResume: () => void): void {
    this.onResume = onResume;
    this.pause.classList.remove('tried');
    this.pause.hidden = false;
    this.resumeButton.focus({ preventScroll: true });
  }

  hidePause(): void {
    this.pause.hidden = true;
    this.pause.classList.remove('tried');
    if (document.activeElement === this.resumeButton) this.resumeButton.blur();
  }

  get pauseVisible(): boolean {
    return !this.pause.hidden;
  }

  /**
   * Fatal error card. `note` replaces the line above the details (e.g. when the game cannot start at all).
   * Returns false when the message is already on the card (a repeat).
   */
  showError(message: string, note: string = ERROR_NOTE): boolean {
    this.errorNote.textContent = note;
    this.error.hidden = false;
    if (this.errors.includes(message)) return false;
    if (this.errors.length < MAX_ERRORS) {
      this.errors.push(message);
      this.errorText.textContent = this.errors.join('\n\n— — —\n\n');
    }
    return true;
  }
}

function titleBlock(): HTMLDivElement {
  const block = el('div', 'menu-title-block');
  block.append(el('h1', 'menu-title', 'ДЕЦИМЕТР'), el('p', 'menu-subtitle', 'PoC мира из 10-сантиметровых вокселей'));
  return block;
}
