/**
 * Key bindings shown on the start and pause screens and in the HUD hint card (ARCHITECTURE.md §8).
 * OWNER: agent "items-ui".
 */
import { el } from './dom';

export interface ControlRow {
  /** Key captions, each drawn as a key chip. */
  keys: readonly string[];
  /** Word or sign between the chips («или», «/»); none = chips side by side. */
  join?: string;
  /** Text after the chips, e.g. «(удерживать)». */
  suffix?: string;
  action: string;
}

export const CONTROLS: readonly ControlRow[] = [
  { keys: ['WASD'], action: 'ходьба' },
  { keys: ['Пробел'], action: 'прыжок/всплытие' },
  { keys: ['Shift'], action: 'бег' },
  { keys: ['C'], action: 'присесть' },
  { keys: ['V'], action: 'полёт' },
  { keys: ['ЛКМ'], action: 'копать/рубить/ударить' },
  { keys: ['ПКМ'], action: 'поставить/использовать' },
  { keys: ['E'], action: 'взаимодействовать/подобрать' },
  { keys: ['Q'], action: 'выбросить' },
  { keys: ['[', ']'], action: 'размер блока' },
  { keys: ['R'], action: 'точный режим' },
  { keys: ['1–9', 'колесо'], join: '/', action: 'слот' },
  { keys: ['Tab'], action: 'инвентарь и крафт' },
  { keys: ['M'], action: 'карта' },
  { keys: ['T'], suffix: '(удерживать)', action: 'ускорить время' },
  { keys: ['F3', '`'], join: 'или', suffix: '(клавиша Ё)', action: 'отладка' },
  { keys: ['Esc'], action: 'пауза' },
];

/** The few bindings repeated on the first-play hint card. */
export const HINT_CONTROLS: readonly ControlRow[] = CONTROLS.filter((row) =>
  ['WASD', 'ЛКМ', 'ПКМ', 'E', 'Tab', 'M', 'Esc'].includes(row.keys[0]),
);

/** Builds a `.controls` list: one row per binding with key chips and the action. */
export function buildControls(rows: readonly ControlRow[], className = ''): HTMLDivElement {
  const list = el('div', className ? `controls ${className}` : 'controls');
  for (const row of rows) {
    const keys = el('span', 'controls-keys');
    row.keys.forEach((key, i) => {
      if (i > 0 && row.join) keys.append(el('span', 'controls-join', row.join));
      keys.append(el('kbd', 'kbd', key));
    });
    if (row.suffix) keys.append(el('span', 'controls-join', row.suffix));
    const line = el('div', 'controls-row');
    line.append(keys, el('span', 'controls-action', row.action));
    list.append(line);
  }
  return list;
}
