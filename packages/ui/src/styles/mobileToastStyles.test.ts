import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(here, 'mobile.css'), 'utf-8');
const indexCss = readFileSync(join(here, '../index.css'), 'utf-8');
const sonnerSource = readFileSync(join(here, '../components/ui/sonner.tsx'), 'utf-8');

describe('mobile toast visual contract', () => {
  test('keeps desktop elevation as the fallback and uses the shared glass shadow on the front mobile toast', () => {
    expect(sonnerSource).toContain('var(--oc-toast-shadow, inset 0 1px');
    expect(sonnerSource).toContain(
      'backgroundColor: "var(--oc-toast-background, var(--surface-elevated))"',
    );
    expect(mobileCss).toContain('--oc-toast-shadow: var(--oc-mobile-glass-shadow);');
    expect(mobileCss).not.toMatch(/--oc-toast-shadow:\s*0 5px 12px -9px/);
    expect(mobileCss).toContain('--oc-toast-background: var(--oc-mobile-glass-fill);');
    expect(mobileCss).toContain('--oc-toast-background-rear-near: var(--oc-mobile-glass-fill);');
    expect(mobileCss).toContain('--oc-toast-background-rear-far: var(--oc-mobile-glass-fill);');
    expect(mobileCss).toContain('--oc-toast-shadow-rear-near: 0 3px 7px -5px');
    expect(mobileCss).toContain('--oc-toast-shadow-rear-far: 0 2px 5px -4px');
    expect(mobileCss).toMatch(
      /:root\.dark:is\([\s\S]*?--oc-toast-shadow-rear-near:\s*0 3px 7px -5px[\s\S]*?\) 62%[\s\S]*?--oc-toast-shadow-rear-far:\s*0 2px 5px -4px[\s\S]*?\) 48%/,
    );
    expect(mobileCss).toMatch(
      /data-front="false"\]\[data-index="1"\][^{]*\{[\s\S]*?--oc-toast-shadow: var\(--oc-toast-shadow-rear-near\);[\s\S]*?background: var\(--oc-toast-background-rear-near\) !important;/,
    );
    expect(mobileCss).toMatch(
      /data-front="false"\]\[data-index\]:not\([\s\S]*?\) \{[\s\S]*?--oc-toast-shadow: var\(--oc-toast-shadow-rear-far\);[\s\S]*?background: var\(--oc-toast-background-rear-far\) !important;/,
    );

    const rearStackChrome = mobileCss.slice(
      mobileCss.indexOf('[data-sonner-toast][data-expanded="false"]'),
      mobileCss.indexOf('[data-sonner-toast]\n  [data-content]'),
    );
    expect(rearStackChrome).not.toMatch(/\b(?:display|opacity|visibility|pointer-events|touch-action|transform|border|outline)\s*:/);
    expect(rearStackChrome).not.toContain('inset');
  });

  test('scopes compact material and quiet actions to mobile-capable web and native roots', () => {
    expect(mobileCss).toContain(':root:is(.device-mobile, .device-tablet, .mobile-pointer):not(.desktop-runtime)');
    expect(sonnerSource).toContain('var(--oc-toast-action-background,var(--primary-base))');
    expect(mobileCss).toContain('--oc-toast-action-foreground: var(--primary-base);');
    expect(mobileCss).toMatch(/data-sonner-toast\]\[data-styled="true"\][^{]*\{[\s\S]*?padding: 0\.5rem 0\.625rem !important;/);
    expect(mobileCss).toMatch(
      /data-sonner-toaster\]\[data-x-position="center"\][^{]*\{[\s\S]*?transform: none !important;/,
    );
    expect(mobileCss).toMatch(
      /\[data-sonner-toast\] \{\s*border: 0 !important;[\s\S]*?background-color: var\(--oc-toast-background\) !important;[\s\S]*?-webkit-backdrop-filter:[\s\S]*?backdrop-filter:\s*blur\(var\(--oc-mobile-glass-blur\)\)\s*saturate\(var\(--oc-mobile-glass-saturate\)\);/,
    );
    expect(mobileCss).toMatch(
      /\[data-sonner-toast\]\[data-mounted="true"\]\[data-front="true"\]:not\(\s*\[data-swiping="true"\]\s*\):not\(\[data-removed="true"\]\):not\(\[data-swipe-out="true"\]\) \{[\s\S]*?transform: none !important;/,
    );
    const styledLayout = mobileCss.match(/\[data-sonner-toast\]\[data-styled="true"\] \{[^}]*\}/);
    expect(styledLayout?.[0]).not.toContain('backdrop-filter');
    expect(mobileCss).toMatch(/\[data-button\][^{]*\{[\s\S]*?min-height: 36px;[\s\S]*?background: transparent !important;/);
    expect(mobileCss).toMatch(/\.session-mutation-undo-action \{[\s\S]*?min-height: 0 !important;/);
    expect(mobileCss).toMatch(/prefers-reduced-transparency:[\s\S]*?\[data-sonner-toast\] \{[\s\S]*?background: var\(--surface-elevated, var\(--card\)\) !important;/);
  });

  test('uses filled sprite icons on desktop and linear sprite icons on mobile', () => {
    expect(sonnerSource).toContain('icons={TOAST_ICONS}');
    for (const [desktopName, mobileName] of [
      ['checkbox-circle-fill', 'check'],
      ['information-fill', 'information'],
      ['alert-fill', 'error-warning'],
      ['error-warning-fill', 'alert'],
    ]) {
      expect(sonnerSource).toContain(
        `<Icon name="${desktopName}" className="oc-toast-status-icon-desktop size-5" />\n      <Icon name="${mobileName}" className="oc-toast-status-icon-mobile hidden size-[18px]" />`,
      );
    }
    expect(sonnerSource).not.toMatch(/<(?:svg|path)\b/);
    expect(mobileCss).toMatch(/\.oc-toast-status-icon-desktop\s*\{\s*display: none;/);
    expect(mobileCss).toMatch(/\.oc-toast-status-icon-mobile\s*\{\s*display: block;/);
  });

  test('keeps the undo countdown ring out of the button SVG transform workaround', () => {
    expect(indexCss).toContain('svg:not(.animate-spin):not(.oc-undo-countdown-svg)');
    expect(indexCss).toMatch(
      /svg\.oc-undo-countdown-svg[\s\S]*?transform: rotate\(-90deg\) !important;/,
    );
    expect(indexCss).toContain('width: var(--oc-undo-countdown-size) !important;');
  });
});
