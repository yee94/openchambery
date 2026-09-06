import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(here, 'mobile.css'), 'utf-8');
const sonnerSource = readFileSync(join(here, '../components/ui/sonner.tsx'), 'utf-8');

describe('mobile toast visual contract', () => {
  test('keeps desktop elevation as the fallback and gives each collapsed mobile layer restrained depth', () => {
    expect(sonnerSource).toContain('var(--oc-toast-shadow, inset 0 1px');
    expect(sonnerSource).toContain(
      'backgroundColor: "var(--oc-toast-background, var(--surface-elevated))"',
    );
    expect(mobileCss).toMatch(
      /--oc-toast-shadow:\s*0 5px 12px -9px\s*color-mix\([\s\S]*?var\(--surface-foreground, var\(--foreground\)\) 30%/,
    );
    expect(mobileCss).toContain('--oc-toast-background: var(--oc-mobile-glass-fill);');
    expect(mobileCss).toContain('--oc-toast-background-rear-near: var(--oc-mobile-glass-fill);');
    expect(mobileCss).toContain('--oc-toast-background-rear-far: var(--oc-mobile-glass-fill);');
    expect(mobileCss).toContain('--oc-toast-shadow-rear-near: 0 3px 7px -5px');
    expect(mobileCss).toContain('--oc-toast-shadow-rear-far: 0 2px 5px -4px');
    expect(mobileCss).toMatch(
      /:root\.dark:is\([\s\S]*?--oc-toast-shadow:\s*0 5px 12px -9px[\s\S]*?var\(--surface-background, var\(--background\)\) 76%[\s\S]*?--oc-toast-shadow-rear-near:\s*0 3px 7px -5px[\s\S]*?\) 62%[\s\S]*?--oc-toast-shadow-rear-far:\s*0 2px 5px -4px[\s\S]*?\) 48%/,
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
      /data-sonner-toast\]\[data-styled="true"\][^{]*\{[\s\S]*?background-color: var\(--oc-toast-background\) !important;[\s\S]*?-webkit-backdrop-filter:[\s\S]*?backdrop-filter:\s*blur\(var\(--oc-mobile-glass-blur\)\)\s*saturate\(var\(--oc-mobile-glass-saturate\)\);/,
    );
    expect(mobileCss).toMatch(/\[data-button\][^{]*\{[\s\S]*?min-height: 36px;[\s\S]*?background: transparent !important;/);
    expect(mobileCss).toMatch(/prefers-reduced-transparency:[\s\S]*?data-sonner-toast\]\[data-styled="true"\][^{]*\{[\s\S]*?background: var\(--surface-elevated, var\(--card\)\) !important;/);
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
});
