// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { el, append, clear, bindText, bindClass, bindAttr } from './dom';
import { signal, createRoot } from './reactivity';

describe('el', () => {
  it('builds an element with text, class, attrs, and children', () => {
    const node = el(
      'div',
      { class: 'box', 'data-id': '7', text: undefined },
      el('span', { text: 'hi' }),
      'tail',
    );
    expect(node.tagName).toBe('DIV');
    expect(node.className).toBe('box');
    expect(node.getAttribute('data-id')).toBe('7');
    expect(node.children[0]?.tagName).toBe('SPAN');
    expect(node.children[0]?.textContent).toBe('hi');
    expect(node.textContent).toBe('hitail');
  });

  it('wires on* handlers', () => {
    const onClick = vi.fn();
    const button = el('button', { onClick });
    button.dispatchEvent(new Event('click'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('skips null/false props and children', () => {
    const node = el('div', { title: null, hidden: false }, null, false, 'x');
    expect(node.hasAttribute('title')).toBe(false);
    expect(node.hasAttribute('hidden')).toBe(false);
    expect(node.textContent).toBe('x');
  });
});

describe('append / clear', () => {
  it('appends nodes and text; clear empties', () => {
    const root = el('div');
    append(root, 'a');
    append(root, el('b'));
    append(root, 42);
    expect(root.childNodes.length).toBe(3);
    clear(root);
    expect(root.childNodes.length).toBe(0);
  });
});

describe('reactive bindings', () => {
  it('bindText updates in place when the signal changes', () => {
    const count = signal(0);
    const node = el('p');
    bindText(node, () => `count: ${count()}`);
    expect(node.textContent).toBe('count: 0');
    count.set(5);
    expect(node.textContent).toBe('count: 5');
  });

  it('bindClass toggles a class', () => {
    const on = signal(false);
    const node = el('div');
    bindClass(node, 'active', () => on());
    expect(node.classList.contains('active')).toBe(false);
    on.set(true);
    expect(node.classList.contains('active')).toBe(true);
  });

  it('bindAttr sets and removes', () => {
    const href = signal<string | null>('/a');
    const node = el('a');
    bindAttr(node, 'href', () => href());
    expect(node.getAttribute('href')).toBe('/a');
    href.set(null);
    expect(node.hasAttribute('href')).toBe(false);
  });

  it('createRoot disposes bindings so they stop updating', () => {
    const count = signal(0);
    const node = el('p');
    const dispose = createRoot((d) => {
      bindText(node, () => `${count()}`);
      return d;
    });
    count.set(1);
    expect(node.textContent).toBe('1');
    dispose();
    count.set(2);
    expect(node.textContent).toBe('1'); // binding torn down
  });
});
