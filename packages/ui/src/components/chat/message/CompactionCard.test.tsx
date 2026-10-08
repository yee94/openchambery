import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import type { SessionCompactionPart } from '@/sync/session-projection-api';
import { CompactionCard } from './CompactionCard';
import { CompactionDisclosureContext, createCompactionDisclosureStore, useCompactionDisclosure } from './compactionDisclosureState';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof zh) => zh[key] }) }));
vi.mock('../MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
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
    const toggle = host.querySelector('button');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle?.click());
    expect(host.textContent).toContain('checkpoint');
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(1);
    await act(async () => toggle?.click());
    expect(host.textContent).not.toContain('checkpoint');
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

test('an expanded streaming summary stays open when the checkpoint completes', async () => {
    await act(async () => root.render(<CompactionCard isMobile part={{ ...part('running'), summary: 'partial' }} />));
    const toggle = host.querySelector('button')!;
    await act(async () => toggle.click());
    expect(host.textContent).toContain('partial');
    await act(async () => root.render(<CompactionCard isMobile part={{ ...part('completed'), summary: 'final summary' }} />));
    expect(host.querySelector('button')).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('final summary');
    expect(host.querySelectorAll('[role="separator"]')).toHaveLength(1);
});

test('disclosure updates subscribe only their own row and stay isolated between views', async () => {
    const first = createCompactionDisclosureStore();
    const second = createCompactionDisclosureStore();
    const renders = { first: 0, sibling: 0, otherView: 0 };
    function Probe({ name, id }: { name: keyof typeof renders; id: string }) {
        const { expanded } = useCompactionDisclosure(id);
        renders[name] += 1;
        return <span data-probe={name}>{String(expanded)}</span>;
    }
    await act(async () => root.render(<>
        <CompactionDisclosureContext.Provider value={first}>
            <Probe name="first" id="same-id" />
            <Probe name="sibling" id="another-id" />
        </CompactionDisclosureContext.Provider>
        <CompactionDisclosureContext.Provider value={second}>
            <Probe name="otherView" id="same-id" />
        </CompactionDisclosureContext.Provider>
    </>));
    await act(async () => first.getState().toggle('same-id'));
    expect(renders).toEqual({ first: 2, sibling: 1, otherView: 1 });
    expect(host.querySelector('[data-probe="first"]')?.textContent).toBe('true');
    expect(host.querySelector('[data-probe="otherView"]')?.textContent).toBe('false');
    await act(async () => first.getState().toggle('same-id'));
    expect(first.getState().expanded.size).toBe(0);
});
