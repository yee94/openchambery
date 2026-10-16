import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { ChildStoreManager } from '@/sync/child-store';
import { useUIStore } from '@/stores/useUIStore';
import { BackgroundActivityHint } from './BackgroundActivityHint';

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: { count: number }) =>
    values ? `${values.count} 个后台任务进行中` : key }) }));
vi.hoisted(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
});
const context = (globalThis as unknown as {
    __openchamber_sync_context__: React.Context<{ childStores: ChildStoreManager } | null>;
}).__openchamber_sync_context__;
let root: Root | undefined;
const previousUI = useUIStore.getState();
afterEach(async () => {
    await act(async () => root?.unmount());
    useUIStore.setState(previousUI);
    vi.restoreAllMocks();
});

test.each([false, true])('live descendants retain non-interactive footer activity (mobile=%s)', async (isMobile) => {
    const children = new ChildStoreManager();
    const store = children.ensureChild('/workspace', { bootstrap: false });
    const parent = { id: 'parent', time: { created: 1, updated: 1 } } as Session;
    store.setState({
        session: [parent, { id: 'child', parentID: 'parent' } as Session],
        session_status: { parent: { type: 'idle' }, child: { type: 'busy' } },
    });
    useUIStore.setState({ isMobile, isSidebarOpen: false, mobileSessionPanelOpen: false });
    const host = document.createElement('div');
    root = createRoot(host);
    await act(async () => root!.render(<context.Provider value={{ childStores: children }}>
        <BackgroundActivityHint sessionId="parent" />
    </context.Provider>));
    const button = host.querySelector<HTMLElement>('[data-background-activity]')!;
    expect(button.textContent).toBe('1 个后台任务进行中');
    expect(button.querySelector('.animate-text-shimmer')).not.toBeNull();
    expect(button.querySelector('svg')).toBeNull();
    expect(host.querySelector('button, [role="button"], [tabindex]')).toBeNull();
    await act(async () => button.click());
    expect(useUIStore.getState().mobileSessionPanelOpen).toBe(false);
    expect(useUIStore.getState().isSidebarOpen).toBe(false);
    await act(async () => store.setState({
        session: [parent, { id: 'child', parentID: 'parent' } as Session, { id: 'nested', parentID: 'child' } as Session],
        session_status: { parent: { type: 'busy' }, child: { type: 'busy' }, nested: { type: 'retry', attempt: 1, message: 'retry', next: 100 } },
    }));
    expect(button.textContent).toBe('2 个后台任务进行中');
    await act(async () => store.setState({ session_status: {
        parent: { type: 'busy' }, child: { type: 'idle' }, nested: { type: 'busy' },
    } }));
    expect(button.textContent).toBe('1 个后台任务进行中');
    await act(async () => store.setState({ session_status: { parent: { type: 'idle' }, child: { type: 'idle' } } }));
    expect(host.querySelector('[data-background-activity]')).toBeNull();
});
