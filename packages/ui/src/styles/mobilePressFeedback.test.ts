import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(__dirname, 'mobile.css'), 'utf-8');
const buttonSource = readFileSync(join(__dirname, '../components/ui/button.tsx'), 'utf-8');

describe('mobile press feedback scale policy', () => {
  test('default press uses soft scale; compact is opt-in only', () => {
    expect(mobileCss).toContain('--oc-press-soft-scale');
    expect(mobileCss).toContain('--oc-press-compact-scale: 0.92');
    expect(mobileCss).toContain('[data-mobile-press-feedback="compact"]');
    // Default active state must not require compact; soft is the baseline.
    expect(mobileCss).toContain(
      ':not(\n      [data-mobile-press-feedback="compact"]\n    ):active:not(:has(:where(button, [role="button"]):active))',
    );
    expect(mobileCss).toContain('scale: var(--oc-press-soft-scale)');
    // Compact must not be the default active rule for every button.
    const compactActiveBlock = mobileCss.slice(
      mobileCss.indexOf('[data-mobile-press-feedback="compact"]'),
    );
    expect(compactActiveBlock).toContain('scale: var(--oc-press-compact-scale)');
  });

  test('shared Button only opts icon-sized controls into compact press', () => {
    expect(buttonSource).toContain('COMPACT_PRESS_SIZES');
    expect(buttonSource).toContain('"icon"');
    expect(buttonSource).toContain('"mobileIcon"');
    expect(buttonSource).toContain('"xs"');
    expect(buttonSource).toContain('data-mobile-press-feedback={compactPress}');
  });
});
