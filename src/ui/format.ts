/** Number formatting for player-visible text (Russian conventions). OWNER: agent "items-ui". */

/** Fixed decimals with a decimal comma: formatDecimal(12.345, 1) → «12,3». */
export function formatDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

/** Grouped digits and a decimal comma: 1234567 → «1 234 567», 0.5 → «0,5». */
export function formatNumber(value: number): string {
  return value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}
