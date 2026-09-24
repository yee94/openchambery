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

const part = (status: SessionCompactionPart['status']): SessionCompactionPart => ({
    id: 'p', messageID: 'msg_compact', sessionID: 'ses_compact',
    type: 'compaction', status, reason: 'auto',
});

test('running and completed are one-line style separators, not cards', async () => {
    await act(async () => root.render(<CompactionCard part={part('running')} />));
    expect(host.textContent).toContain(zh['chat.activity.compacting']);
    expect(host.querySelector('.animate-text-shimmer')).not.toBeNull();
    expect(host.querySelector('[data-compaction-card]')?.getAttribute('role')).toBe('separator');
    expect(host.querySelector('[data-compaction-card]')?.className).not.toMatch(/rounded-xl|border-border|oc-tool-row/);
    expect(host.querySelector('button')).toBeNull();

    await act(async () => root.render(<CompactionCard part={{ ...part('completed'), summary: 'checkpoint' }} />));
    expect(host.textContent).toContain(zh['chat.activity.compactionCompleted']);
    expect(host.textContent).not.toContain('checkpoint');
    expect(host.querySelector('.animate-text-shimmer')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
});

test('failed stays a separator and does not open an error card', async () => {
    await act(async () => root.render(<CompactionCard part={{
        ...part('failed'),
        error: { type: 'error', message: 'model refused' },
    }} />));
    expect(host.textContent).toContain(zh['chat.activity.compactionFailed']);
    expect(host.textContent).not.toContain('model refused');
    expect(host.querySelector('[data-compaction-card]')?.getAttribute('role')).toBe('separator');
    expect(host.querySelector('button')).toBeNull();
});
