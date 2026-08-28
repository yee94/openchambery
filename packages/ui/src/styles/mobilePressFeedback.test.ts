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
      ':not(\n      [data-mobile-press-feedback="compact"]\n    ):active:not(:has(:where(button, [role="button"], [role="menuitem"]):active))',
    );
    expect(mobileCss).toContain('scale: var(--oc-press-soft-scale)');
    expect(mobileCss).toContain('.pwa-overlay-panel,');
    // Compact must not be the default active rule for every button.
    const compactActiveBlock = mobileCss.slice(
      mobileCss.indexOf('[data-mobile-press-feedback="compact"]'),
    );
    expect(compactActiveBlock).toContain('scale: var(--oc-press-compact-scale)');
  });

  test('changes panel scopes its container and lighter soft press scale', () => {
    const containerRule = mobileCss.match(/([^{}]*\.oc-changes-panel[^{}]*)\{\s*container-type: inline-size;\s*\}/);
    expect(containerRule?.[1]).toContain('.oc-changes-panel');

    const changesPanelRule = mobileCss.match(/\.oc-changes-panel\s*\{([^}]+)\}/);
    expect(changesPanelRule?.[1]).toContain('--oc-press-edge-inset: 2px');
    expect(changesPanelRule?.[1]).toContain('0.985');
  });

  test('composer surface does not press-scale or open with a transform', () => {
    expect(mobileCss).not.toContain('[data-mobile-composer-surface="true"]:has(textarea:active)');
    expect(mobileCss).not.toContain('@keyframes oc-mobile-composer-expand');
    expect(mobileCss).toContain('Composer surface must not press-scale');
    // Collapsed/expanded share 1.5rem; interpolating 9999px dirties iOS corners.
    expect(mobileCss).not.toContain('transition: border-radius');
  });

  test('shared Button only opts icon-sized controls into compact press', () => {
    expect(buttonSource).toContain('COMPACT_PRESS_SIZES');
    expect(buttonSource).toContain('"icon"');
    expect(buttonSource).toContain('"mobileIcon"');
    expect(buttonSource).toContain('"xs"');
    expect(buttonSource).toContain('data-mobile-press-feedback={compactPress}');
    expect(buttonSource).toContain('active:bg-interactive-active');
  });
});
