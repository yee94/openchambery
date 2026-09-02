import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { TruncatedPath } from './truncated-path';

describe('TruncatedPath', () => {
  test('pins the parent directory and file suffix outside the shrinking prefix', () => {
    const html = renderToString(
      <TruncatedPath path="app/wxaaiagentnodelogicsvr/src/mmpMethod/plugin.ts" />,
    );

    expect(html).toContain('app/wxaaiagentnodelogicsvr/src');
    expect(html).toContain('shrink-[9999]');
    expect(html).toContain('mmpMethod');
    expect(html).toContain('plugin');
    expect(html).toContain('.ts');
    expect(html).toContain('shrink-0');
  });

  test('uses the full path as the title', () => {
    const html = renderToString(
      <TruncatedPath path="src/plugin.ts" title="/abs/src/plugin.ts" />,
    );

    expect(html).toContain('title="/abs/src/plugin.ts"');
  });
});
