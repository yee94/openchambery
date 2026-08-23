import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const mobileCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'mobile.css'),
    'utf-8',
);
const chatInputSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../components/chat/ChatInput.tsx'),
    'utf-8',
);
const chatContainerSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../components/chat/ChatContainer.tsx'),
    'utf-8',
);
const autoFollowSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../hooks/useChatAutoFollow.ts'),
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
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-input-shell="true"] .overflow-hidden,
      :root.mobile-pointer:not(.desktop-runtime) [data-attachment-preview="true"],
      :root.mobile-pointer:not(.desktop-runtime) [data-attachment-preview="true"].overflow-hidden {
        overflow: hidden !important;
        overflow-x: hidden !important;
        overflow-y: hidden !important;
      }
      :root.mobile-pointer:not(.desktop-runtime)
        [data-attachment-preview="true"]
        button,
      :root.mobile-pointer:not(.desktop-runtime)
        [data-attachment-preview="true"][role="button"] {
        min-height: 0 !important;
        min-width: 0 !important;
      }
      :root.mobile-pointer:not(.desktop-runtime) button,
      :root.mobile-pointer:not(.desktop-runtime) [role="button"] {
        min-height: 36px;
        min-width: 36px;
      }
      :root.mobile-pointer:not(.desktop-runtime) .flex.flex-col {
        min-height: 0;
      }
      :root.mobile-pointer:not(.desktop-runtime)
        .oc-mobile-composer-surface {
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
        expect(mobileCss).toContain('[data-attachment-preview="true"]');
        expect(mobileCss).toContain('Composer clip shells must stay clippers');
        expect(mobileCss).toContain('min-height: min-content');
        expect(mobileCss).toContain('.oc-mobile-composer-surface');
        expect(mobileCss).toContain('[data-composer-highlight="true"]');
        expect(mobileCss).toContain('font-size: calc(16 * var(--dpt)) !important');
        expect(mobileCss).not.toContain('[data-chat-input-highlight="true"]');
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

    test('declares the scoped 100px CSS scroll timeline with persistent endpoints', () => {
        expect(mobileCss).toContain('@property --oc-mobile-composer-shrink');
        expect(mobileCss).toContain('timeline-scope: --oc-chat-bottom');
        expect(mobileCss).toContain('scroll-timeline-name: --oc-chat-bottom');
        expect(mobileCss).toContain('animation-timeline: --oc-chat-bottom');
        expect(mobileCss).toContain('animation-range: calc(100% - 100px) 100%');
        expect(mobileCss).toContain('animation-fill-mode: both');
        expect(chatContainerSource).toContain('oc-chat-composer-timeline-scope');
        expect(chatContainerSource).toContain('oc-chat-composer-scroll-source');
    });

    test('binds overlay timelines only to the hydrating and main chat scroller branches', () => {
        expect(chatContainerSource.match(/oc-chat-composer-timeline-scope/g)).toHaveLength(2);
        expect(chatContainerSource.match(/oc-chat-composer-scroll-source/g)).toHaveLength(2);
        expect(chatContainerSource.match(/oc-mobile-composer-foot--overlay/g)).toHaveLength(2);
        expect(chatContainerSource.match(/isMobile && 'oc-mobile-composer-foot'/g)).toHaveLength(3);
        expect(mobileCss).toMatch(/\.oc-mobile-composer-foot--overlay\s*\{[^}]*position:\s*absolute\s*!important;/s);
        expect(mobileCss).not.toMatch(/\.oc-mobile-composer-foot\s*\{[^}]*position:\s*absolute/s);
    });

    test('uses a static foot inset and has no Composer animation DOM mutator', () => {
        expect(mobileCss).toMatch(/--oc-chat-foot-inset:\s*calc\(\s*8rem/s);
        expect(mobileCss).toContain('padding-bottom: var(--oc-chat-foot-inset)');
        for (const source of [chatContainerSource, chatInputSource, autoFollowSource]) {
            expect(source).not.toContain("setProperty('--oc-mobile-composer-shrink'");
            expect(source).not.toContain("setProperty('--oc-chat-foot-inset'");
            expect(source).not.toContain('oc-mobile-composer-shrinking');
            expect(source).not.toContain('oc-mobile-composer-shrunk');
            expect(source).not.toContain('oc-mobile-composer-pinned-full');
        }
        expect(chatInputSource).not.toContain('--oc-mobile-composer-stage-height');
        expect(autoFollowSource).not.toContain('publishMobileComposerShrink');
        expect(autoFollowSource).not.toContain('resolveMobileComposerShrink');
    });

    test('clips reveal chrome continuously while preserving the input card paint boundary', () => {
        expect(mobileCss).toContain('12rem * (1 - var(--oc-mobile-composer-shrink))');
        expect(mobileCss).toMatch(/@keyframes oc-mobile-composer-reveal-endpoint\s*\{[\s\S]*?0%\s*\{[^}]*overflow:\s*hidden;[\s\S]*?100%\s*\{[^}]*overflow:\s*visible;/);
        expect(mobileCss).toMatch(/\.oc-mobile-composer-motion-viewport\s*\{[^}]*overflow:\s*visible;/s);
        expect(mobileCss).toMatch(/\.oc-mobile-composer-surface\s*\{[^}]*min-height:\s*var\(--oc-mobile-composer-surface-min-height\)\s*!important;[^}]*overflow:\s*visible;/s);
        expect(mobileCss).toMatch(/@keyframes oc-mobile-composer-terminal-viewport\s*\{[\s\S]*?width:\s*80%;/);
        expect(mobileCss).toContain('--oc-mobile-composer-surface-backdrop: blur(18px)');
    });

    test('restores compact textarea and highlight geometry only at the 0% endpoint', () => {
        const surfaceKeyframes = mobileCss.slice(
            mobileCss.indexOf('@keyframes oc-mobile-composer-terminal-surface'),
            mobileCss.indexOf('@keyframes oc-mobile-composer-terminal-chrome'),
        );
        const terminal = surfaceKeyframes.slice(surfaceKeyframes.indexOf('0% {'), surfaceKeyframes.indexOf('0.01%'));
        expect(terminal).toContain('--oc-mobile-composer-textarea-height: 1.25rem');
        expect(terminal).toContain('--oc-mobile-composer-textarea-min-height: 1.25rem');
        expect(terminal).toContain('--oc-mobile-composer-textarea-max-height: 1.25rem');
        expect(terminal).toContain('--oc-mobile-composer-textarea-white-space: nowrap');
        expect(terminal).toContain('--oc-mobile-composer-textarea-line-height: 1.25rem');
        expect(terminal).toContain('--oc-mobile-composer-textarea-padding-block: 0');
        expect(terminal).toContain('--oc-mobile-composer-textarea-padding-inline: 0.375rem');
        expect(terminal).toContain('--oc-mobile-composer-highlight-top: calc(');
        expect(terminal).toContain('--oc-mobile-composer-highlight-bottom: auto');
        expect(mobileCss).toContain('--oc-composer-textarea-resting-height');
        expect(chatInputSource).toContain("'--oc-composer-textarea-resting-height'");
    });

    test('animates the scroll button between compact and expanded composer tops', () => {
        const buttonKeyframes = mobileCss.slice(
            mobileCss.indexOf('@keyframes oc-mobile-composer-scroll-button'),
            mobileCss.indexOf('@supports (scroll-timeline-name'),
        );
        expect(buttonKeyframes).toContain('0% {');
        expect(buttonKeyframes).toContain('3.75rem + var(--oc-safe-area-bottom-visual, 0px) + 0.5rem');
        expect(buttonKeyframes).toContain('100% {');
        expect(buttonKeyframes).toContain('bottom: calc(var(--oc-chat-foot-inset) + 0.5rem)');
        expect(mobileCss).toMatch(/\.oc-mobile-composer-foot--overlay\s*> button\s*\{\s*animation-name:\s*oc-mobile-composer-scroll-button;/s);
    });

    test('focus and native keyboard state select the static expanded CSS contract', () => {
        expect(mobileCss).toContain('.oc-mobile-composer textarea[data-chat-input="true"]:focus');
        expect(mobileCss).toContain('[data-oc-composer-dictation-active="true"]');
        expect(chatInputSource).toContain('data-oc-composer-dictation-active="true"');
        expect(mobileCss).toContain(':root:is(.oc-keyboard-open, .oc-kb-animating)');
        expect(mobileCss).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*animation-name:\s*none\s*!important/);
        expect(mobileCss).toMatch(/prefers-reduced-transparency:\s*reduce[\s\S]*--oc-mobile-composer-surface-backdrop:\s*none\s*!important/);
    });

    test('attachment preview thumbs stay clippers and keep compact close controls', () => {
        const host = mountStyledFixture(`
            <div data-attachment-preview="true" class="overflow-hidden" data-testid="thumb" role="button">
                <button type="button" data-testid="close">x</button>
            </div>
            <div class="overflow-hidden" data-testid="unrelated"></div>
        `);

        expect(getComputedStyle(host.querySelector('[data-testid="thumb"]')!).overflowY).toBe('hidden');
        expect(['0', '0px']).toContain(getComputedStyle(host.querySelector('[data-testid="close"]')!).minHeight);
        expect(getComputedStyle(host.querySelector('[data-testid="unrelated"]')!).overflowY).toBe('auto');
    });

    test('composer highlight overlay shares the textarea --dpt font-size', () => {
        const highlightRule = mobileCss.slice(
            mobileCss.indexOf('Fix mobile text inputs'),
            mobileCss.indexOf('Prevent keyboard on non-input elements'),
        );
        expect(highlightRule).toContain('[data-composer-highlight="true"]');
        expect(highlightRule).toContain('font-size: calc(16 * var(--dpt)) !important');
        expect(highlightRule).not.toContain('font-size: 16px');
        expect(highlightRule).not.toContain('data-chat-input-highlight');
    });
});
