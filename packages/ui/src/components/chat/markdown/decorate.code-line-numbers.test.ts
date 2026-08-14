import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { heightFromLineRects } from './decorate';

const decorateSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'decorate.ts'), 'utf-8');

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
});
