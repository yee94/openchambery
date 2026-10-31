import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ToolJsonOutput } from './ToolJsonOutput';
import { copyTextToClipboard } from '@/lib/clipboard';

const highlighted = vi.hoisted(() => vi.fn());
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({
    WorkerHighlightedCode: ({ code, language }: { code: string; language: string }) => {
        highlighted(code);
        return <pre data-language={language}>{code}</pre>;
    },
}));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(),
        removeEventListener: vi.fn(), dispatchEvent: () => true,
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.clearAllMocks();
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.getElementById('mobile-overlay-root')?.remove();
    vi.restoreAllMocks();
});

test.each([false, true])('JSON stays collapsed with one code action and no highlighting (mobile=%s)', async (isMobile) => {
    const output = JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ index, value: 'nested output' })), null, 2);
    for (let index = 0; index < 50; index += 1) {
        await act(async () => root.render(<ToolJsonOutput output={output} isMobile={isMobile} />));
    }
    expect(host.querySelectorAll('button')).toHaveLength(1);
    const button = host.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('chat.toolPart.showRawJson');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('code')!.textContent!.length).toBeLessThanOrEqual(240);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(highlighted).not.toHaveBeenCalled();
});

test.each([false, true])('code action opens complete JSON in the platform overlay and copy preserves the source (mobile=%s)', async (isMobile) => {
    const output = '{"largeInteger":9007199254740993,"nested":' + JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ index }))) + '}';
    const parentClick = vi.fn();
    await act(async () => root.render(<div onClick={parentClick}><ToolJsonOutput output={output} isMobile={isMobile} /></div>));
    const trigger = host.querySelector('button')!;
    await act(async () => trigger.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector('[data-language="json"]')?.textContent).toBe(output);
    expect(dialog.querySelector('[data-tool-json-code]')?.classList.contains('overflow-auto')).toBe(true);
    expect(parentClick).not.toHaveBeenCalled();
    if (isMobile) {
        expect(document.querySelector('[data-yuri-motion-id^="tool-json-"]')).not.toBeNull();
        expect(Array.from(dialog.querySelectorAll('[class]')).some((element) => element.classList.contains('h-[72dvh]'))).toBe(true);
    } else {
        expect(dialog.getAttribute('data-slot')).toBe('dialog-content');
        expect(dialog.className).toContain('max-w-5xl');
    }
    const copy = dialog.querySelector<HTMLButtonElement>('[aria-label="chat.toolPart.copyOutput"]')!;
    await act(async () => copy.click());
    expect(copyTextToClipboard).toHaveBeenCalledWith(output);
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="dialog.common.actions.close"]')!;
    await act(async () => close.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-tool-json-code]')).toBeNull();
});
