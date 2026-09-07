import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const indexCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8',
);

const shimmerRule = indexCss.match(/\.animate-text-shimmer \{[\s\S]*?\n\}/)?.[0] ?? '';
const reducedMotionRule = indexCss.match(
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.animate-text-shimmer \{[\s\S]*?\n {2}\}/,
)?.[0] ?? '';

describe('live text shimmer', () => {
  test('keeps a muted clip-text sweep with a plain foreground highlight', () => {
    // color:transparent + background-clip:text vanishes when --oc-text-shimmer-base
    // is an invalid custom-property (Android WebView often rejects color-mix there).
    // Base stays muted so the foreground highlight band is actually visible.
    expect(shimmerRule).toContain('color: transparent');
    expect(shimmerRule).toContain('background-clip: text');
    expect(shimmerRule).toContain('--oc-text-shimmer-base: var(--surface-muted-foreground)');
    expect(shimmerRule).toContain('var(--surface-foreground) 50%');
    expect(shimmerRule).not.toMatch(/--oc-text-shimmer-base:\s*color-mix/);
    expect(shimmerRule).not.toMatch(/color-mix/);
    expect(reducedMotionRule).toContain('var(--surface-muted-foreground)');
    expect(reducedMotionRule).not.toMatch(/color-mix/);
  });
});
