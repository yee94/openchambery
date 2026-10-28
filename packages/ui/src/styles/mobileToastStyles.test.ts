import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(here, 'mobile.css'), 'utf-8');
const indexCss = readFileSync(join(here, '../index.css'), 'utf-8');
const sonnerSource = readFileSync(join(here, '../components/ui/sonner.tsx'), 'utf-8');

describe('shared toast visual contract', () => {
  test('uses shared glass elevation on desktop and mobile with a fallback before styles load', () => {
    expect(sonnerSource).toContain('var(--yuri-toast-shadow, inset 0 1px');
    expect(sonnerSource).toContain(
      'backgroundColor: "var(--yuri-toast-background, var(--surface-elevated))"',
    );
    expect(mobileCss).toContain('inset 0 1px 0 var(--yuri-mobile-glass-highlight)');
    expect(mobileCss).toContain('--yuri-toast-background: color-mix(in srgb, var(--yuri-mobile-glass-fill) 70%, transparent);');
    expect(mobileCss).toContain('--yuri-toast-background-rear-near: var(--yuri-mobile-glass-fill);');
    expect(mobileCss).toContain('--yuri-toast-background-rear-far: var(--yuri-mobile-glass-fill);');
    expect(mobileCss).toContain('--yuri-toast-shadow-rear-near: 0 3px 7px -5px');
    expect(mobileCss).toContain('--yuri-toast-shadow-rear-far: 0 2px 5px -4px');
    expect(mobileCss).toMatch(
      /:root\.dark\s*\{[\s\S]*?--yuri-toast-shadow-rear-near:\s*0 3px 7px -5px[\s\S]*?\) 62%[\s\S]*?--yuri-toast-shadow-rear-far:\s*0 2px 5px -4px[\s\S]*?\) 48%/,
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

  test('shares compact glass and ghost actions without excluding desktop roots', () => {
    const start = mobileCss.indexOf('/* Shared desktop and mobile notifications');
    const sharedToastCss = mobileCss.slice(start, mobileCss.indexOf('@media (prefers-reduced-transparency: reduce)', start));
    expect(start).toBeGreaterThan(-1);
    expect(sharedToastCss).not.toMatch(/device-mobile|device-tablet|mobile-pointer|desktop-runtime/);
    expect(sonnerSource).toContain('var(--yuri-toast-action-background,var(--surface-muted))');
    expect(mobileCss).toContain('--yuri-toast-action-foreground: var(--foreground);');
    expect(mobileCss).toMatch(/data-sonner-toast\]\[data-styled="true"\][^{]*\{[\s\S]*?padding: var\(--yuri-toast-padding-y\) var\(--yuri-toast-padding-x\) !important;/);
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

  test('uses one consistent Lucide outline family including the loading indicator', () => {
    expect(sonnerSource).toContain('icons={TOAST_ICONS}');
    for (const name of ['checkbox-circle', 'information', 'error-warning', 'close-circle']) {
      expect(sonnerSource).toContain(
        `<Icon name="${name}" weight="medium" className="yuri-toast-status-icon size-5" />`,
      );
    }
    expect(sonnerSource).toContain('<Icon name="loader-4" weight="medium" className="yuri-toast-status-icon size-5 animate-spin motion-reduce:animate-none" />');
    expect(sonnerSource).not.toMatch(/<(?:svg|path)\b/);
    expect(mobileCss).toMatch(/\.yuri-toast-status-icon\s*\{\s*display: block;/);
  });

  test('keeps the undo countdown ring out of the button SVG transform workaround', () => {
    expect(indexCss).toContain('svg:not(.animate-spin):not(.yuri-undo-countdown-svg)');
    expect(indexCss).toMatch(
      /svg\.yuri-undo-countdown-svg[\s\S]*?transform: rotate\(-90deg\) !important;/,
    );
    expect(indexCss).toContain('width: var(--yuri-undo-countdown-size) !important;');
  });
});
