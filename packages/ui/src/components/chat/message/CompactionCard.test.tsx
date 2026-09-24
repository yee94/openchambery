import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import type { SessionCompactionPart } from '@/sync/session-projection-api';
import { CompactionCard } from './CompactionCard';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof zh) => zh[key] }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

test('shows running feedback and preserves disclosure through completion', async () => {
    const part: SessionCompactionPart = {
        id: 'p', messageID: 'msg_compact', sessionID: 'ses_compact',
        type: 'compaction', status: 'running', reason: 'auto',
    };
    await act(async () => root.render(<CompactionCard part={part} />));
    expect(host.textContent).toContain(zh['chat.activity.compacting']);
    expect(host.querySelector('.animate-text-shimmer')).not.toBeNull();
    expect(host.querySelector('[data-compaction-card]')?.className).not.toMatch(/rounded-xl|border-border/);
    await act(async () => root.render(<CompactionCard part={{ ...part, summary: 'checkpoint' }} />));
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('checkpoint');
    await act(async () => root.render(<CompactionCard part={{ ...part, status: 'completed', summary: 'final checkpoint' }} />));
    expect(host.textContent).toContain(zh['chat.activity.compactionCompleted']);
    expect(host.querySelector('.animate-text-shimmer')).toBeNull();
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('final checkpoint');
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
});

test('native checkpoint without a text summary still shows completion', async () => {
    await act(async () => root.render(<CompactionCard part={{
        id: 'p', messageID: 'msg_compact', sessionID: 'ses_compact',
        type: 'compaction', status: 'completed', reason: 'manual', summary: '',
    }} />));
    expect(host.textContent).toContain(zh['chat.activity.compactionCompleted']);
    expect(host.querySelector('.oc-tool-row')).not.toBeNull();
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
});
