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
const queuedChipsSource = readFileSync(join(here, '../components/chat/QueuedMessageChips.tsx'), 'utf-8');
const mobileAppSource = readFileSync(join(here, '../apps/MobileApp.tsx'), 'utf-8');
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
        expect(mobileCss).toMatch(/\.oc-mobile-composer-expanded-layer\s*\{[^}]*transform:\s*none/s);
        expect(mobileCss).toMatch(/data-oc-composer-swap-phase="snapping"[\s\S]*?\.oc-mobile-composer-expanded-layer\s*\{[^}]*min\(1, var\(--oc-mobile-composer-swap\) \* 2\) \* 110%/s);
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
        expect(chatInputSource).toContain('oc-mobile-composer-compact-chrome--sending');
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
        expect(mobileCss).not.toMatch(
            /:root\.oc-native-ios-composer \.oc-chat-composer-swap-scope\s*\{[^}]*--oc-mobile-composer-swap:\s*0\s*!important/,
        );
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer\s*\{[^}]*--oc-chat-foot-inset:\s*calc\(\s*var\(--oc-native-composer-height/,
        );
        expect(mobileCss).toContain('--oc-native-composer-accessory');
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-mobile-composer-expanded-layer\s*\{[^}]*transform:\s*none\s*!important;[^}]*opacity:\s*1\s*!important/,
        );
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-mobile-composer-foot--overlay \[data-native-composer-accessories\]\s*\{[^}]*position:\s*absolute;[^}]*bottom:\s*calc\(\s*var\(--oc-native-composer-height/,
        );
        expect(mobileCss).not.toMatch(
            /:root\.oc-native-ios-composer \.oc-mobile-composer-foot--overlay \[data-native-composer-accessories\]\s*\{[^}]*padding-bottom:\s*8px/,
        );
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-mobile-composer-foot--overlay \[data-native-composer-accessories\]\s*\{[^}]*opacity:\s*calc\(1 - min\(1, var\(--oc-native-composer-dock/,
        );
        expect(mobileCss).toMatch(
            /data-oc-native-composer-dock="away"[\s\S]*?\[data-native-composer-accessories\][\s\S]*?pointer-events:\s*none/,
        );
        expect(swapHookSource).toContain('publishNativeComposerDock');
        expect(mobileCss).not.toContain('[data-native-composer-accessories]:has(*)::before');
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-composer-queue\s*\{[^}]*margin-bottom:\s*0/,
        );
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-composer-queue \[data-oc-queue-composer-overlap\]\s*\{[^}]*display:\s*none/,
        );
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-composer-queue \[data-oc-queue-card-body\]\s*\{[^}]*padding-top:\s*0\.375rem;[^}]*padding-bottom:\s*0\.375rem/,
        );
        expect(queuedChipsSource).toContain('data-oc-queue-composer-overlap');
        expect(queuedChipsSource).toContain('data-oc-queue-card');
        expect(queuedChipsSource).toContain("'oc-composer-queue relative z-0 -mb-5 w-full'");
        expect(queuedChipsSource).toMatch(/data-oc-queue-composer-overlap[\s\S]*isMobile \? 'h-4' : 'h-5'/);
        expect(mobileCss.match(/\.oc-composer-queue\s*\{[^}]*margin-bottom:\s*0/g)).toHaveLength(1);
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer \.oc-scroll-to-bottom--expanded,\s*:root\.oc-native-ios-composer \.oc-scroll-to-bottom--compact/,
        );
        expect(chatInputSource).toContain('data-native-composer-accessories');
        expect(chatInputSource).toContain('applyNativeComposerAccessoryVar');
        expect(chatInputSource).toContain('useNativeIosComposer');
        expect(chatInputSource).toContain('data-native-ios-composer');
        expect(chatInputSource).toContain('showScrollToBottom: Boolean(showScrollToBottom && onScrollToBottom)');
        expect(chatInputSource).toContain('reconcileComposerAttachmentTextDeletion');
        expect(chatInputSource).toContain('onRemoveAttachment');
        expect(chatInputSource).toContain('nativeIosComposerActive ? null');
        expect(chatInputSource).not.toContain("setProperty('--oc-chat-foot-inset'");
        expect(chatContainerSource).not.toContain('canUseNativeIosComposer');
        expect(chatContainerSource).toMatch(
            /useMobileComposerSwap\(\{\s*enabled:\s*isMobile,/,
        );
        expect(mobileAppSource).toContain("root.classList.contains('oc-native-ios-composer')");
        expect(mobileAppSource).toContain('unwindKeyboardShell');
        expect(mobileAppSource).toContain('getNativeIosComposerPlugin().blur()');
        expect(mobileAppSource).toMatch(
            /oc-native-ios-composer[\s\S]*unwindKeyboardShell\(\)/,
        );
        expect(mobileAppSource).toContain("setVar('--oc-kb-layout', 0)");
    });

    /**
     * A source regex cannot tell which foot-inset declaration actually wins.
     * The native reservation used to be scoped to `.oc-chat-composer-swap-scope`
     * while the web default was scoped to `:root.mobile-pointer:not(...)` and
     * the same scope class — one extra compound selector, so the web default
     * out-specified it and the transcript reserved a fixed 8rem no matter how
     * tall the native pill plus the queued-message strip really were. Resolve
     * the value through the cascade so weight, not source order, is asserted.
     */
    test('native iOS foot inset wins the cascade over the fixed web reservation', () => {
        const footInsetRules: string[] = [];
        for (let cursor = 0; ;) {
            const declaration = mobileCss.indexOf('--oc-chat-foot-inset:', cursor);
            if (declaration === -1) break;
            const blockEnd = mobileCss.indexOf('}', declaration);
            const blockStart = mobileCss.lastIndexOf('{', declaration);
            footInsetRules.push(mobileCss.slice(mobileCss.lastIndexOf('}', blockStart) + 1, blockEnd + 1));
            cursor = blockEnd + 1;
        }
        // Every declaration is in the fixture, so a third one cannot be added
        // without this assertion resolving it too.
        expect(footInsetRules).toHaveLength(2);

        const resolveFootInset = (nativeIos: boolean): string => {
            document.documentElement.className = nativeIos
                ? 'mobile-pointer oc-native-ios-composer'
                : 'mobile-pointer';
            const style = document.createElement('style');
            style.textContent = `
              :root {
                --oc-native-composer-height: 90px;
                --oc-native-composer-accessory: 100px;
                --oc-safe-area-bottom-visual: 34px;
              }
              ${footInsetRules.join('\n')}
            `;
            document.head.appendChild(style);
            injected.add(style);
            return getComputedStyle(document.documentElement)
                .getPropertyValue('--oc-chat-foot-inset')
                .replace(/\s+/g, '');
        };

        expect(resolveFootInset(false)).toBe('calc(8rem+34px)');
        expect(resolveFootInset(true)).toBe('calc(90px+100px)');
    });

    test('queue card tuck stays on web and Android; native iOS hides the overlap', () => {
        const start = mobileCss.indexOf(':root.oc-native-ios-composer .oc-composer-queue {');
        const end = mobileCss.indexOf('/* Static ancestors so absolute docking', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const queueCss = mobileCss.slice(start, end);

        const mountQueue = (nativeIos: boolean) => {
            document.documentElement.className = nativeIos ? 'oc-native-ios-composer' : '';
            const style = document.createElement('style');
            style.textContent = `
              .oc-composer-queue { margin-bottom: -1.25rem; }
              [data-oc-queue-card-body] { padding-top: 0.25rem; padding-bottom: 0.25rem; }
              [data-oc-queue-composer-overlap] { height: 1rem; }
              ${queueCss}
            `;
            document.head.appendChild(style);
            injected.add(style);
            const host = document.createElement('div');
            host.innerHTML = `
              <div class="oc-composer-queue">
                <div data-oc-queue-card="">
                  <div data-oc-queue-card-body=""></div>
                  <div data-oc-queue-composer-overlap=""></div>
                </div>
              </div>
            `;
            document.body.appendChild(host);
            injected.add(host);
            return {
                queue: host.querySelector<HTMLElement>('.oc-composer-queue')!,
                body: host.querySelector<HTMLElement>('[data-oc-queue-card-body]')!,
                overlap: host.querySelector<HTMLElement>('[data-oc-queue-composer-overlap]')!,
            };
        };

        const web = mountQueue(false);
        expect(getComputedStyle(web.queue).marginBottom).toBe('-20px');
        expect(getComputedStyle(web.overlap).display).not.toBe('none');
        expect(getComputedStyle(web.overlap).height).toBe('16px');
        expect(getComputedStyle(web.body).paddingTop).toBe('4px');
        expect(getComputedStyle(web.body).paddingBottom).toBe('4px');

        const ios = mountQueue(true);
        expect(getComputedStyle(ios.queue).marginBottom).toBe('0px');
        expect(getComputedStyle(ios.overlap).display).toBe('none');
        expect(getComputedStyle(ios.body).paddingTop).toBe('6px');
        expect(getComputedStyle(ios.body).paddingBottom).toBe('6px');
    });

    test('settings inputBarOffset applies only in the native app while the keyboard is down', () => {
        expect(chatInputSource).toContain('isMobile && isCapacitorApp() && !nativeIosComposerActive && inputBarOffset > 0 && !mobileTextareaFocused');
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

    test('native iOS in-flow feet reserve the pill so draft pickers sit above the input', () => {
        expect(mobileCss).toMatch(
            /:root\.oc-native-ios-composer\s+\.oc-mobile-composer-foot:not\(\.oc-mobile-composer-foot--overlay\)\s*\{[^}]*padding-bottom:\s*calc\(\s*var\(--oc-native-composer-height/,
        );
        expect(chatInputSource).toContain('oc-mobile-draft-target-selectors');
        expect(chatInputSource).toContain('data-native-composer-accessories');

        const start = mobileCss.indexOf(
            ':root.oc-native-ios-composer\n  .oc-mobile-composer-foot:not(.oc-mobile-composer-foot--overlay) {',
        );
        expect(start).toBeGreaterThan(-1);
        const end = mobileCss.indexOf('}', start);
        const inFlowNativeCss = mobileCss.slice(start, end + 1);

        const mountFeet = (nativeIos: boolean) => {
            document.documentElement.className = nativeIos ? 'oc-native-ios-composer' : '';
            const style = document.createElement('style');
            style.textContent = `
              :root { --oc-native-composer-height: 88px; }
              .oc-mobile-composer-foot { padding-bottom: 0; }
              ${inFlowNativeCss}
            `;
            document.head.appendChild(style);
            injected.add(style);
            const host = document.createElement('div');
            host.innerHTML = `
              <div class="oc-mobile-composer-foot">
                <div data-native-composer-accessories="" data-testid="draft-accessories"></div>
              </div>
              <div class="oc-mobile-composer-foot oc-mobile-composer-foot--overlay">
                <div data-native-composer-accessories="" data-testid="overlay-accessories"></div>
              </div>
            `;
            document.body.appendChild(host);
            injected.add(host);
            return {
                draft: host.querySelector<HTMLElement>('.oc-mobile-composer-foot:not(.oc-mobile-composer-foot--overlay)')!,
                overlay: host.querySelector<HTMLElement>('.oc-mobile-composer-foot--overlay')!,
            };
        };

        const web = mountFeet(false);
        expect(getComputedStyle(web.draft).paddingBottom).toBe('0px');
        expect(getComputedStyle(web.overlay).paddingBottom).toBe('0px');

        const ios = mountFeet(true);
        expect(getComputedStyle(ios.draft).paddingBottom).toBe('calc(88px - 8px)');
        expect(getComputedStyle(ios.overlay).paddingBottom).toBe('0px');
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
