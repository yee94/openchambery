import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatView } from './ChatView';

const fixture = vi.hoisted(() => ({
    session: {
        currentSessionId: null as string | null,
        currentSessionDirectory: '/repo',
        newSessionDraft: { open: true, draftEstablishing: false, draftSubmitting: false, pendingUserMessage: null as object | null },
    },
    ui: {
        isMobile: false, isExpandedInput: false, isRightSidebarOpen: false,
        workStatusPanelEnabled: true, workStatusOverlayOpen: false,
        contextPanelByDirectory: {},
        setWorkStatusPanelFits: vi.fn(), setWorkStatusPanelVisible: vi.fn(), setWorkStatusOverlayOpen: vi.fn(),
    },
    transcript: [] as object[],
    paintedWidths: [] as (string | null)[],
}));

vi.mock('@/stores/useUIStore', () => ({
    normalizeContextPanelDirectoryKey: (directory: string) => directory,
    useUIStore: (selector: (state: typeof fixture.ui) => unknown) => selector(fixture.ui),
}));
vi.mock('@/sync/session-ui-store', () => ({
    useSessionUIStore: (selector: (state: typeof fixture.session) => unknown) => selector(fixture.session),
}));
vi.mock('@/sync/sync-context', () => ({ useSessionMessages: () => fixture.transcript }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => false }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/chat/ChatErrorBoundary', () => ({ ChatErrorBoundary: ({ children }: React.PropsWithChildren) => children }));
vi.mock('@/components/chat/work-status/WorkStatusCompact', () => ({ WorkStatusCompact: () => <span>Project status</span> }));
vi.mock('@/components/chat/ChatContainer', () => ({
    ChatContainer: () => {
        React.useLayoutEffect(() => {
            fixture.paintedWidths.push(document.querySelector<HTMLElement>('aside[aria-hidden="false"]')?.style.width ?? null);
        });
        return <main>Chat</main>;
    },
}));

let root: Root;
let host: HTMLDivElement;
let viewportWidth: number;
let mediaQueries: Map<string, MediaQueryList>;
const resize = (width: number) => {
    viewportWidth = width;
    for (const query of mediaQueries.values()) query.dispatchEvent(new Event('change'));
};

beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    fixture.session.currentSessionId = null;
    Object.assign(fixture.session.newSessionDraft, { open: true, draftEstablishing: false, draftSubmitting: false, pendingUserMessage: null });
    Object.assign(fixture.ui, { isMobile: false, isRightSidebarOpen: false, workStatusOverlayOpen: false });
    fixture.transcript = [];
    fixture.paintedWidths = [];
    viewportWidth = 1600;
    mediaQueries = new Map();
    vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
        let query = mediaQueries.get(media);
        if (!query) {
            query = Object.assign(new EventTarget(), {
                media, matches: false, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
            }) as MediaQueryList;
            Object.defineProperty(query, 'matches', { get: () => viewportWidth >= Number(media.match(/min-width:\s*(\d+)px/)?.[1] ?? Infinity) });
            mediaQueries.set(media, query);
        }
        return query;
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

it('reserves the column on the first chat paint and keeps it through session creation and transcript arrival', async () => {
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    fixture.session.newSessionDraft.draftEstablishing = true;
    fixture.session.newSessionDraft.pendingUserMessage = { id: 'pending' };
    fixture.paintedWidths = [];
    await act(async () => root.render(<ChatView />));
    expect(fixture.paintedWidths[0]).toBe('196px');
    const column = host.querySelector('aside');
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside')).toBe(column);
    fixture.transcript = [{ id: 'message' }];
    await act(async () => root.render(<ChatView />));
    expect(fixture.paintedWidths.every((width) => width === '196px')).toBe(true);
    expect(host.querySelector<HTMLElement>('aside')?.style.transitionProperty).toBe('none');
});

it('uses the current viewport on initial session entry and only shows inline at 1440px or wider', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    viewportWidth = 1439;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    await act(async () => resize(1440));
    expect(host.querySelector<HTMLElement>('aside[aria-hidden="false"]')?.style.width).toBe('196px');
    expect(host.textContent).toContain('Project status');
    await act(async () => resize(1439));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
});

it('shows a selected session before its transcript loads, without a hidden first paint', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    await act(async () => root.render(<ChatView />));
    expect(fixture.paintedWidths[0]).toBe('196px');
});

it('retains manual overlay display below the breakpoint and excludes the right sidebar and mobile', async () => {
    fixture.session.currentSessionId = 'session';
    fixture.session.newSessionDraft.open = false;
    viewportWidth = 1200;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside[aria-hidden="false"]')).toBeNull();
    fixture.ui.workStatusOverlayOpen = true;
    await act(async () => root.render(<ChatView />));
    const overlay = host.querySelector<HTMLElement>('aside[aria-hidden="false"]');
    expect(overlay?.className).toContain('absolute');
    expect(overlay?.textContent).toBe('Project status');
    fixture.ui.isRightSidebarOpen = true;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside')).toBeNull();
    fixture.ui.isRightSidebarOpen = false;
    fixture.ui.isMobile = true;
    await act(async () => root.render(<ChatView />));
    expect(host.querySelector('aside')).toBeNull();
});
