import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import type { Part } from '@/lib/opencode/v2-types';
import { useUIStore } from '@/stores/useUIStore';
import { PromptNavigatorRail } from './PromptNavigatorRail';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

test('navigation removes chip references before truncation and preserves turn selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSelectTurn = vi.fn();
    const textPart = (text: string) => ({ type: 'text', text } as Part);
    const previews = new Map([
        ['body', [textPart(`[/attachments/${'long-path/'.repeat(25)}image.png] [skill:review] 请检查 [说明](https://example.com) [普通文本]`)]],
        ['chips', [textPart('[image.png] [command:/commands/review.md]')]],
    ]);
    try {
        await act(async () => root.render(<PromptNavigatorRail
            turnIds={['body', 'chips']}
            previewsByTurnId={previews}
            activeTurnId="body"
            onSelectTurn={onSelectTurn}
            canLoadEarlier={false}
            isLoadingOlder={false}
            onLoadEarlier={() => {}}
        />));
        const ticks = host.querySelectorAll('[role="option"]');
        expect(ticks[0].getAttribute('aria-label')).toBe('请检查 [说明](https://example.com) [普通文本]');
        expect(ticks[1].getAttribute('aria-label')).toBe('chat.timeline.noTextContent');
        await act(async () => useUIStore.getState().setPromptNavigatorPanelOpen(true));
        const rail = host.querySelector('[role="listbox"]')!;
        await act(async () => rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(onSelectTurn).toHaveBeenCalledExactlyOnceWith('body');
    } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    }
});
