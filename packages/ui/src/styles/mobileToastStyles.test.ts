import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(here, 'mobile.css'), 'utf-8');
const indexCss = readFileSync(join(here, '../index.css'), 'utf-8');
const sonnerSource = readFileSync(join(here, '../components/ui/sonner.tsx'), 'utf-8');

describe('mobile toast visual contract', () => {
  test('keeps desktop elevation as the fallback and uses a quiet contact shadow on mobile', () => {
    expect(sonnerSource).toContain('var(--yuri-toast-shadow, inset 0 1px');
    expect(sonnerSource).toContain(
      'backgroundColor: "var(--yuri-toast-background, var(--surface-elevated))"',
    );
    expect(mobileCss).toContain('--yuri-toast-shadow: 0 2px 8px -3px');
    expect(mobileCss).toContain('--yuri-toast-background: var(--yuri-mobile-glass-fill);');
    expect(mobileCss).toContain('--yuri-toast-background-rear-near: var(--yuri-mobile-glass-fill);');
    expect(mobileCss).toContain('--yuri-toast-background-rear-far: var(--yuri-mobile-glass-fill);');
    expect(mobileCss).toContain('--yuri-toast-shadow-rear-near: 0 3px 7px -5px');
    expect(mobileCss).toContain('--yuri-toast-shadow-rear-far: 0 2px 5px -4px');
    expect(mobileCss).toMatch(
      /:root\.dark:is\([\s\S]*?--yuri-toast-shadow-rear-near:\s*0 3px 7px -5px[\s\S]*?\) 62%[\s\S]*?--yuri-toast-shadow-rear-far:\s*0 2px 5px -4px[\s\S]*?\) 48%/,
    );
    expect(mobileCss).toMatch(
      /data-front="false"\]\[data-index="1"\][^{]*\{[\s\S]*?--yuri-toast-shadow: var\(--yuri-toast-shadow-rear-near\);[\s\S]*?background: var\(--yuri-toast-background-rear-near\) !important;/,
    );
    expect(mobileCss).toMatch(
      /data-front="false"\]\[data-index\]:not\([\s\S]*?\) \{[\s\S]*?--yuri-toast-shadow: var\(--yuri-toast-shadow-rear-far\);[\s\S]*?background: var\(--yuri-toast-background-rear-far\) !important;/,
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
    expect(sonnerSource).toContain('var(--yuri-toast-action-background,var(--surface-muted))');
    expect(mobileCss).toContain('--yuri-toast-action-foreground: var(--muted-foreground);');
    expect(mobileCss).toMatch(/data-sonner-toast\]\[data-styled="true"\][^{]*\{[\s\S]*?padding: 0\.25rem 0\.625rem !important;/);
    expect(mobileCss).toMatch(
      /data-sonner-toaster\]\[data-x-position="center"\][^{]*\{[\s\S]*?transform: none !important;/,
    );
    expect(mobileCss).toMatch(
      /\[data-sonner-toast\] \{\s*border: 0 !important;[\s\S]*?background-color: var\(--yuri-toast-background\) !important;[\s\S]*?-webkit-backdrop-filter:[\s\S]*?backdrop-filter:\s*blur\(var\(--yuri-mobile-glass-blur\)\)\s*saturate\(var\(--yuri-mobile-glass-saturate\)\);/,
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
        `<Icon name="${desktopName}" className="yuri-toast-status-icon-desktop size-5" />\n      <Icon name="${mobileName}" className="yuri-toast-status-icon-mobile hidden size-[18px]" />`,
      );
    }
    expect(sonnerSource).not.toMatch(/<(?:svg|path)\b/);
    expect(mobileCss).toMatch(/\.yuri-toast-status-icon-desktop\s*\{\s*display: none;/);
    expect(mobileCss).toMatch(/\.yuri-toast-status-icon-mobile\s*\{\s*display: block;/);
  });

  test('keeps the undo countdown ring out of the button SVG transform workaround', () => {
    expect(indexCss).toContain('svg:not(.animate-spin):not(.yuri-undo-countdown-svg)');
    expect(indexCss).toMatch(
      /svg\.yuri-undo-countdown-svg[\s\S]*?transform: rotate\(-90deg\) !important;/,
    );
    expect(indexCss).toContain('width: var(--yuri-undo-countdown-size) !important;');
  });
});
