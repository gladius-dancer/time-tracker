/** Minimal DOM helpers, in place of a UI framework. */

type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    // Assign styles through the CSSOM: the page's CSP forbids `style` attributes
    // (`style-src 'self'`), and setAttribute('style', …) is silently blocked by it.
    else if (key === 'style') node.style.cssText = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function mustGet<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function emptyState(title: string, detail: string): HTMLElement {
  return el('div', { class: 'empty' }, [
    el('p', { class: 'empty__title', text: title }),
    el('p', { class: 'empty__detail', text: detail }),
  ]);
}
