import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { heightFromLineRects, syncMarkdownCodeLineNumbers } from './decorate';

const decorateSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'decorate.ts'), 'utf-8');

type RectLike = {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
  width: number;
  height: number;
  x?: number;
  y?: number;
};

const asDomRect = (rect: RectLike): DOMRect => ({
  top: rect.top,
  bottom: rect.bottom,
  left: rect.left ?? 0,
  right: rect.right ?? (rect.left ?? 0) + rect.width,
  width: rect.width,
  height: rect.height,
  x: rect.x ?? rect.left ?? 0,
  y: rect.y ?? rect.top,
  toJSON: () => rect,
});

const stubBoundingRect = (el: Element, rect: RectLike): void => {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(asDomRect(rect));
};

const buildShikiCodeBlock = (lines: string[]): {
  root: HTMLElement;
  lineSpans: HTMLElement[];
  numbers: HTMLElement[];
} => {
  const root = document.createElement('div');
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-component', 'markdown-code');

  const body = document.createElement('div');
  body.setAttribute('data-md-code-body', '');

  const gutter = document.createElement('div');
  gutter.setAttribute('data-md-code-line-numbers', '');
  gutter.setAttribute('aria-hidden', 'true');
  for (let index = 1; index <= lines.length; index += 1) {
    const line = document.createElement('div');
    line.className = 'tabular-nums';
    line.textContent = String(index);
    gutter.appendChild(line);
  }

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.style.lineHeight = '20px';
  code.style.fontSize = '13px';
  code.style.fontFamily = 'monospace';

  const lineSpans: HTMLElement[] = [];
  for (const text of lines) {
    const span = document.createElement('span');
    span.className = 'line';
    span.textContent = text;
    code.appendChild(span);
    lineSpans.push(span);
  }

  pre.appendChild(code);
  body.appendChild(gutter);
  body.appendChild(pre);
  wrapper.appendChild(body);
  root.appendChild(wrapper);

  return {
    root,
    lineSpans,
    numbers: Array.from(gutter.children) as HTMLElement[],
  };
};

const readGutterHeights = (numbers: HTMLElement[]): number[] =>
  numbers.map((el) => Number.parseFloat(el.style.height) || 0);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('markdown code line-number height', () => {
  test('a single tall rect (WebKit wrap) uses the union height, not one row', () => {
    // iOS often returns one client rect covering both visual rows of a wrapped
    // line. Counting unique tops would keep the gutter at 1× line-height.
    expect(heightFromLineRects(
      [{ top: 100, bottom: 140, width: 180, height: 40 }],
      20,
    )).toBe(40);
  });

  test('multiple line boxes still union to the wrapped height', () => {
    expect(heightFromLineRects(
      [
        { top: 100, bottom: 120, width: 160, height: 20 },
        { top: 120, bottom: 140, width: 80, height: 20 },
      ],
      20,
    )).toBe(40);
  });

  test('empty layout boxes fall back to one row', () => {
    expect(heightFromLineRects([], 20)).toBe(20);
    expect(heightFromLineRects(
      [{ top: 0, bottom: 0, width: 0, height: 0 }],
      20,
    )).toBe(20);
  });

  test('sync sizes gutters from layout boxes, not unique client-rect tops', () => {
    expect(decorateSource).toContain('heightFromLineRects');
    expect(decorateSource).toContain('collectShikiLineSpans');
    expect(decorateSource).not.toContain('rowTops');
  });

  test('Shiki path: empty .line with degenerate rect does not inflate itself or neighbors', () => {
    // iOS: empty `.line` getBoundingClientRect collapses (often origin), while the
    // following span top stays large — adjacent top-diff then writes a huge gutter.
    const lineHeight = 20;
    const { root, lineSpans, numbers } = buildShikiCodeBlock(['const a = 1;', '', 'return a;']);
    stubBoundingRect(lineSpans[0]!, { top: 100, bottom: 120, width: 120, height: 20 });
    stubBoundingRect(lineSpans[1]!, { top: 0, bottom: 0, width: 0, height: 0 });
    stubBoundingRect(lineSpans[2]!, { top: 500, bottom: 520, width: 80, height: 20 });

    syncMarkdownCodeLineNumbers(root);

    // Empty row and both neighbors stay one line-height (no 500px / 400px blow-up).
    expect(readGutterHeights(numbers)).toEqual([lineHeight, lineHeight, lineHeight]);
  });

  test('Shiki path: non-empty wrapped line keeps measured multi-row height', () => {
    const { root, lineSpans, numbers } = buildShikiCodeBlock([
      'short',
      'this line wraps across two visual rows',
      'end',
    ]);
    stubBoundingRect(lineSpans[0]!, { top: 50, bottom: 70, width: 100, height: 20 });
    stubBoundingRect(lineSpans[1]!, { top: 70, bottom: 110, width: 180, height: 40 });
    stubBoundingRect(lineSpans[2]!, { top: 110, bottom: 130, width: 60, height: 20 });

    syncMarkdownCodeLineNumbers(root);

    expect(readGutterHeights(numbers)).toEqual([20, 40, 20]);
  });
});
