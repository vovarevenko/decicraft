/** Small DOM helpers shared by the UI modules. OWNER: agent "items-ui". */

/** Creates an element with an optional class name and text content. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Creates an SVG element with the given attributes. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) e.setAttribute(name, String(value));
  return e;
}

/** Shows/hides an element, writing the attribute only when it actually changes (cheap in per-frame code). */
export function setHidden(e: HTMLElement, hidden: boolean): void {
  if (e.hidden !== hidden) e.hidden = hidden;
}
