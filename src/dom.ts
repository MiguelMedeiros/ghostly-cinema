/**
 * Elements built in script: the runner allows no markup handlers and no script made later, and the app parses no
 * markup at all (no `innerHTML`), so text from the contact is only ever text.
 */

type Child = Node | string | number | false | null | undefined;
type Attrs = { [key: string]: string | number | boolean | undefined | ((e: Event) => void) | Partial<CSSStyleDeclaration> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") el.addEventListener(key.replace(/^on/, "").toLowerCase(), value as EventListener);
    else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
    else if (key === "class") el.className = String(value);
    else if (key in el && key !== "list" && typeof value !== "string") (el as unknown as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "number" ? String(c) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}
