import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(here, 'mobile.css'), 'utf-8');
const chatInputSource = readFileSync(join(here, '../components/chat/ChatInput.tsx'), 'utf-8');
const chatPromptComposerSource = readFileSync(join(here, '../components/chat/ChatPromptComposer.tsx'), 'utf-8');
const chatContainerSource = readFileSync(join(here, '../components/chat/ChatContainer.tsx'), 'utf-8');
const autoFollowSource = readFileSync(join(here, '../hooks/useChatAutoFollow.ts'), 'utf-8');
const swapHookSource = readFileSync(join(here, '../components/chat/useMobileComposerSwap.ts'), 'utf-8');
const injected = new Set<HTMLElement>();

afterEach(() => {
    for (const node of injected) node.remove();
    injected.clear();
    document.documentElement.className = '';
});

function mountStyledFixture(html: string): HTMLElement {
    document.documentElement.classList.add('mobile-pointer');
    const style = document.createElement('style');
    style.textContent = `
      :root.mobile-pointer:not(.desktop-runtime) .overflow-hidden { overflow-x: hidden !important; overflow-y: auto !important; }
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-content="true"] .overflow-hidden,
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-input-shell="true"],
      :root.mobile-pointer:not(.desktop-runtime) [data-composer-input-shell="true"] .overflow-hidden,
      :root.mobile-pointer:not(.desktop-runtime) [data-attachment-preview="true"] { overflow: hidden !important; overflow-y: hidden !important; }
      :root.mobile-pointer:not(.desktop-runtime) [data-attachment-preview="true"] button { min-height: 0 !important; min-width: 0 !important; }
      :root.mobile-pointer:not(.desktop-runtime) button { min-height: 36px; min-width: 36px; }
      :root.mobile-pointer:not(.desktop-runtime) .oc-mobile-composer-surface { min-height: min-content !important; }
    `;
    document.head.appendChild(style);
    injected.add(style);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    injected.add(host);
    return host;
}

describe('mobile composer overflow and swap contract', () => {
    test('keeps composer send and stop controls at their authored compact size', () => {
        expect(mobileCss).toContain('button[data-composer-send="true"]');
        expect(mobileCss).toContain('[data-composer-send="true"][role="button"]');
        expect(mobileCss).toContain('button[data-composer-stop="true"]');
        expect(mobileCss).toContain('[data-composer-stop="true"][role="button"]');
        expect(mobileCss).toMatch(
            /button\[data-composer-send="true"\][\s\S]*button\[data-composer-stop="true"\][^{]*\{[^}]*min-height:\s*0\s*!important;[^}]*min-width:\s*0\s*!important;/,
        );
        expect(chatInputSource.match(/data-composer-send="true"/g)).toHaveLength(2);
        expect(chatPromptComposerSource).toContain('data-composer-send="true"');
    });

    test('keeps Composer clippers, min-content surface, and highlight dpt contract', () => {
        expect(mobileCss).toContain('[data-composer-content="true"] .overflow-hidden');
        expect(mobileCss).toContain('[data-composer-input-shell="true"]');
        expect(mobileCss).toContain('[data-attachment-preview="true"]');
        expect(mobileCss).toContain('Composer clip shells must stay clippers');
        expect(mobileCss).toContain('min-height: min-content');
        expect(mobileCss).toContain('[data-composer-highlight="true"]');
        expect(mobileCss).toContain('font-size: calc(16 * var(--dpt)) !important');
    });

    test('composer wrappers stay clippers under mobile-pointer', () => {
        const host = mountStyledFixture(`<div data-composer-content="true"><div class="overflow-hidden" data-testid="section"></div><div data-composer-input-shell="true" class="overflow-hidden" data-testid="shell"></div></div><div class="overflow-hidden" data-testid="unrelated"></div>`);
        expect(getComputedStyle(host.querySelector('[data-testid="section"]')!).overflowY).toBe('hidden');
        expect(getComputedStyle(host.querySelector('[data-testid="shell"]')!).overflowY).toBe('hidden');
        expect(getComputedStyle(host.querySelector('[data-testid="unrelated"]')!).overflowY).toBe('auto');
    });

    test('declares alternating transform layers and snap-only transition', () => {
        expect(mobileCss).toContain('@property --oc-mobile-composer-swap');
        expect(mobileCss).toMatch(/\.oc-mobile-composer-expanded-layer\s*\{[^}]*min\(1, var\(--oc-mobile-composer-swap\) \* 2\) \* 110%/s);
        expect(mobileCss).toMatch(/\.oc-mobile-composer-compact-layer\s*\{[^}]*width:\s*80%;[^}]*--oc-mobile-glass-shadow[^}]*--oc-mobile-glass-blur[^}]*max\(0, var\(--oc-mobile-composer-swap\) \* 2 - 1\)/s);
        expect(mobileCss).toMatch(/\.oc-mobile-composer-compact-layer\s*\{[^}]*background:\s*var\(--oc-mobile-glass-fill\)/s);
        expect(mobileCss).toMatch(/data-oc-composer-swap-phase="snapping"[^}]*transition:\s*--oc-mobile-composer-swap 240ms/s);
        expect(mobileCss).toMatch(/data-oc-composer-swap-phase="tracking"[^}]*transition:\s*none/s);
        expect(chatInputSource).toContain('data-oc-composer-compact-surface="true"');
        expect(chatInputSource).toContain('oc-mobile-composer-compact-preview');
        expect(chatInputSource).toContain('oc-mobile-composer-compact-preview--placeholder');
        expect(chatInputSource).toContain("t('chat.chatInput.placeholder.compactTap')");
        expect(mobileCss).toContain('.oc-mobile-composer-compact-preview--placeholder');
    });

    test('anchors independent expanded and compact scroll-to-bottom buttons', () => {
        expect(mobileCss).not.toMatch(/\.oc-mobile-composer-foot--overlay\s*>\s*div:first-child[^{]*\{[^}]*--oc-mobile-composer-swap/s);
        expect(mobileCss).toMatch(/\.oc-scroll-to-bottom--expanded\s*\{[^}]*z-index:\s*30;[^}]*bottom:\s*var\(--oc-chat-foot-inset\)[^}]*opacity:\s*calc\(1 - min\(1, var\(--oc-mobile-composer-swap\) \* 2\)\)/s);
        expect(mobileCss).toMatch(/\.oc-scroll-to-bottom--compact\s*\{[^}]*opacity:\s*max\(0, calc\(var\(--oc-mobile-composer-swap\) \* 2 - 1\)\)/s);
        expect(chatContainerSource).toContain('placement="expanded"');
        expect(chatContainerSource).not.toContain('placement="compact"');
        expect(chatInputSource).toContain('placement="compact"');
        expect(chatInputSource).toContain('oc-mobile-composer-compact-chrome--with-scroll');
        expect(chatInputSource).toContain('oc-mobile-composer-compact-chrome--aborting');
        expect(chatInputSource).toContain('data-mobile-composer-compact-slot="trailing"');
        expect(readFileSync(join(here, '../components/chat/components/ScrollToBottomButton.tsx'), 'utf-8')).toContain(
            "isCompactInline ? 'ghost' : 'outline'",
        );
    });

    test('removes timelines, shrink publishing, and geometry mutation', () => {
        expect(mobileCss).not.toContain('scroll-timeline');
        expect(mobileCss).not.toContain('animation-timeline');
        expect(mobileCss).not.toContain('--oc-mobile-composer-shrink');
        expect(mobileCss).not.toContain('@keyframes oc-mobile-composer-');
        expect(chatContainerSource.match(/oc-chat-composer-swap-scope/g)).toHaveLength(2);
        expect(chatContainerSource.match(/oc-mobile-composer-foot--overlay/g)).toHaveLength(2);
        for (const source of [chatContainerSource, chatInputSource, autoFollowSource]) {
            expect(source).not.toContain("setProperty('--oc-mobile-composer-shrink'");
            expect(source).not.toContain("setProperty('--oc-chat-foot-inset'");
            expect(source).not.toContain('publishMobileComposerShrink');
        }
    });

    test('keeps fixed inset and pin accessibility contracts', () => {
        expect(mobileCss).toMatch(/--oc-chat-foot-inset:\s*calc\(\s*8rem/);
        expect(mobileCss).not.toMatch(/\.oc-mobile-composer-foot\s*\{[^}]*--oc-mobile-composer-swap:/s);
        expect(mobileCss).toContain('padding-bottom: var(--oc-chat-foot-inset)');
        expect(swapHookSource).toContain('textarea[data-chat-input="true"]');
        expect(swapHookSource).toContain('[data-oc-composer-dictation-active="true"]');
        expect(swapHookSource).toContain("root.classList.contains('oc-keyboard-open')");
        expect(swapHookSource).toContain("applyComposerSwapForce(stateRef.current, 'expanded')");
        expect(swapHookSource).toContain("textarea?.focus({ preventScroll: true })");
        expect(swapHookSource).toContain('armExpandFocusShield');
        expect(swapHookSource).toContain("addEventListener('click', swallow, true)");
        // Expanding snap must keep the expanded layer interactive so focus sticks.
        expect(mobileCss).toMatch(
            /data-oc-composer-swap-phase="snapping"\]\[data-oc-composer-swap-rest="expanded"\][\s\S]*?\.oc-mobile-composer-compact-layer[\s\S]*?pointer-events:\s*none/,
        );
        expect(mobileCss).not.toMatch(
            /data-oc-composer-swap-phase="snapping"\]\s*:is\(\.oc-mobile-composer-expanded-layer,\s*\.oc-mobile-composer-compact-layer\)/,
        );
        expect(mobileCss).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*transition-duration:\s*0ms/);
        expect(mobileCss).toMatch(/prefers-reduced-transparency:\s*reduce[\s\S]*\.oc-mobile-composer-compact-layer/);
    });

    test('hides web composer chrome when the iOS native overlay is active', () => {
        expect(mobileCss).toContain(':root.oc-native-ios-composer');
        expect(mobileCss).toContain('--oc-native-composer-height');
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-chat-composer-swap-scope\s*\{[^}]*--oc-chat-foot-inset:\s*calc\(\s*var\(--oc-native-composer-height/,
        );
        expect(chatInputSource).toContain('useNativeIosComposer');
        expect(chatInputSource).toContain('data-native-ios-composer');
        expect(chatInputSource).not.toContain("setProperty('--oc-chat-foot-inset'");
    });

    test('settings inputBarOffset applies only in the native app while the keyboard is down', () => {
        expect(chatInputSource).toContain('isMobile && isCapacitorApp() && inputBarOffset > 0 && !mobileTextareaFocused');
    });

    test('in-flow draft feet pin expanded and hide leftover compact pills', () => {
        expect(mobileCss).toMatch(
            /\.oc-mobile-composer-foot:not\(\.oc-mobile-composer-foot--overlay\)\s*\{[^}]*--oc-mobile-composer-swap:\s*0/,
        );
        expect(mobileCss).toMatch(
            /\.oc-mobile-composer-foot:not\(\.oc-mobile-composer-foot--overlay\)\s+\.oc-mobile-composer-compact-layer\s*\{[^}]*display:\s*none/,
        );
        expect(swapHookSource).toContain('clearComposerSwap');
        expect(chatContainerSource.match(/oc-mobile-composer-foot--overlay/g)).toHaveLength(2);
        expect(chatContainerSource).toContain('oc-draft-center');
    });

    test('leftover session swap cannot cover the in-flow draft composer', () => {
        const host = mountStyledFixture(`
          <style>
            .oc-mobile-composer-expanded-layer {
              opacity: calc(1 - min(1, var(--oc-mobile-composer-swap) * 2));
            }
            .oc-mobile-composer-compact-layer {
              opacity: max(0, calc(var(--oc-mobile-composer-swap) * 2 - 1));
              pointer-events: none;
            }
            .oc-mobile-composer-foot:not(.oc-mobile-composer-foot--overlay) {
              --oc-mobile-composer-swap: 0;
            }
            .oc-mobile-composer-foot:not(.oc-mobile-composer-foot--overlay)
              .oc-mobile-composer-compact-layer {
              display: none;
            }
          </style>
          <div style="--oc-mobile-composer-swap: 1">
            <div class="oc-mobile-composer-foot">
              <div class="oc-mobile-composer-expanded-layer" data-testid="draft-expanded"></div>
              <div class="oc-mobile-composer-compact-layer" data-testid="draft-compact"></div>
            </div>
            <div class="oc-mobile-composer-foot oc-mobile-composer-foot--overlay">
              <div class="oc-mobile-composer-compact-layer" data-testid="overlay-compact"></div>
            </div>
          </div>
        `);
        const draftFoot = host.querySelector<HTMLElement>('.oc-mobile-composer-foot:not(.oc-mobile-composer-foot--overlay)')!;
        const draftCompact = host.querySelector('[data-testid="draft-compact"]')!;
        const overlayCompact = host.querySelector('[data-testid="overlay-compact"]')!;
        expect(getComputedStyle(draftFoot).getPropertyValue('--oc-mobile-composer-swap').trim()).toBe('0');
        expect(getComputedStyle(draftCompact).display).toBe('none');
        expect(getComputedStyle(overlayCompact).display).not.toBe('none');
    });
});
