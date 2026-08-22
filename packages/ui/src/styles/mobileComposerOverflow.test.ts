import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const mobileCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'mobile.css'),
    'utf-8',
);

const injected = new Set<HTMLElement>();

afterEach(() => {
    for (const node of injected) node.remove();
    injected.clear();
    document.documentElement.className = '';
});

function mountStyledFixture(html: string): HTMLElement {
    document.documentElement.classList.add('mobile-pointer');
    const style = document.createElement('style');
    // Keep the competing production rules only — the full mobile.css file
    // includes viewport media queries that happy-dom may not apply uniformly.
    style.textContent = `
      :root.mobile-pointer:not(.desktop-runtime) .overflow-hidden {
        overflow-x: hidden !important;
        overflow-y: auto !important;
      }
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-content="true"] .overflow-hidden,
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-input-shell="true"],
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-input-shell="true"] .overflow-hidden {
        overflow: hidden !important;
        overflow-x: hidden !important;
        overflow-y: hidden !important;
      }
      :root.mobile-pointer:not(.desktop-runtime) .flex.flex-col {
        min-height: 0;
      }
      :root.mobile-pointer:not(.desktop-runtime)
        .oc-mobile-composer-surface:not(.oc-mobile-composer-collapsed) {
        min-height: min-content !important;
      }
    `;
    document.head.appendChild(style);
    injected.add(style);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    injected.add(host);
    return host;
}

describe('mobile composer overflow contract', () => {
    test('opts composer clip shells out of the generic overflow-hidden rewrite', () => {
        expect(mobileCss).toContain('[data-composer-input-shell="true"]');
        expect(mobileCss).toContain('[data-composer-content="true"] .overflow-hidden');
        expect(mobileCss).toContain('Composer clip shells must stay clippers');
        expect(mobileCss).toContain('min-height: min-content');
        expect(mobileCss).toContain('.oc-mobile-composer-surface:not(.oc-mobile-composer-collapsed)');
    });

    test('composer overflow-hidden wrappers stay clippers under mobile-pointer', () => {
        const host = mountStyledFixture(`
            <div data-composer-content="true">
                <div class="overflow-hidden" data-testid="section"></div>
                <div data-composer-input-shell="true" class="overflow-hidden" data-testid="shell">
                    <div class="overflow-hidden" data-testid="overlay"></div>
                </div>
            </div>
            <div class="overflow-hidden" data-testid="unrelated"></div>
        `);

        expect(getComputedStyle(host.querySelector('[data-testid="section"]')!).overflowY).toBe('hidden');
        expect(getComputedStyle(host.querySelector('[data-testid="shell"]')!).overflowY).toBe('hidden');
        expect(getComputedStyle(host.querySelector('[data-testid="overlay"]')!).overflowY).toBe('hidden');
        expect(getComputedStyle(host.querySelector('[data-testid="unrelated"]')!).overflowY).toBe('auto');
    });

    test('expanded composer surface cannot shrink below its content', () => {
        const host = mountStyledFixture(`
            <div class="oc-mobile-composer-motion-viewport">
                <div class="flex flex-col oc-mobile-composer-surface" data-testid="surface"></div>
            </div>
        `);
        expect(getComputedStyle(host.querySelector('[data-testid="surface"]')!).minHeight).toBe('min-content');
    });
});
