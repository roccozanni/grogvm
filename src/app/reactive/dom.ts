/**
 * Minimal DOM render helpers built on the reactivity kernel
 * (ARCHITECTURE.md §7). `el` builds elements; the `bind*` helpers tie a
 * piece of DOM to a reactive expression via `effect`, so it updates in
 * place when the signals it reads change — no re-render, no diffing.
 *
 * Kept deliberately un-magic: `el`'s props/children are STATIC. Anything
 * dynamic is wired explicitly with `bindText` / `bindAttr` / `bindClass`
 * (each just an `effect`), which reads clearer than reactive-prop sugar and
 * matches the project's clarity-over-cleverness rule. A component is a plain
 * function that returns an element and (via `createRoot`) a dispose.
 */

import { effect } from './reactivity';

export type Child = Node | string | number | null | undefined | false;

/** Prop values: attribute scalars, an `on<Event>` handler, or a `style` map. */
export type Props = Record<
  string,
  string | number | boolean | null | undefined | EventListener | Partial<CSSStyleDeclaration>
>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) applyProps(node, props);
  for (const child of children) append(node, child);
  return node;
}

function applyProps(node: HTMLElement, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

/** Append a child to `parent`. Strings/numbers become text nodes; falsy is skipped. */
export function append(parent: Node, child: Child): void {
  if (child == null || child === false) return;
  parent.appendChild(
    typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child,
  );
}

/** Remove all children of `node`. */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ── reactive bindings (effect-backed; auto-disposed by the owning root) ──

export function bindText(node: { textContent: string | null }, fn: () => string): void {
  effect(() => {
    node.textContent = fn();
  });
}

export function bindAttr(node: Element, name: string, fn: () => string | null | undefined): void {
  effect(() => {
    const value = fn();
    if (value == null) node.removeAttribute(name);
    else node.setAttribute(name, value);
  });
}

export function bindClass(node: Element, name: string, fn: () => boolean): void {
  effect(() => {
    node.classList.toggle(name, fn());
  });
}
