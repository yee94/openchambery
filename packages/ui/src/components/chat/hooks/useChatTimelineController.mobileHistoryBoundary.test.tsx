/**
 * Hook-level contract: ordinary-session history auto-load follows the same
 * mounted `isMobile` flag as the ChatContainer load-older button — not
 * `isMobileSurfaceRuntime()` width/pointer probes that can disagree.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message, Part } from '@/lib/opencode/v2-types';
import { toast as sonnerToast, type ToastT } from 'sonner';
import { createQueryTranscriptRepository } from '@/sync/transcript-repository-query-adapter';
import type { TranscriptRepository } from '@/sync/transcript-repository';
import { normalizeSessionProjectionPage } from '@/sync/session-projection-api';
import { resolveChatHistoryLoadState } from '../chatContainerHost';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { SessionHistoryMeta } from '@/stores/types/sessionTypes';
import type { UseChatTimelineControllerResult } from './useChatTimelineController';
import type { MessageListHandle } from '../MessageList';

const runtimeSurface = vi.hoisted(() => ({
    mobileProbe: false,
    runtimeKey: 'test-runtime',
    generation: 1,
    repository: null as TranscriptRepository | null,
}));

vi.mock('@/lib/runtimeSurface', () => ({
    isMobileSurfaceRuntime: () => runtimeSurface.mobileProbe,
}));

vi.mock('@/lib/desktop', () => ({
    isVSCodeRuntime: () => false,
}));

vi.mock('@/lib/runtime-switch', () => ({
    getRuntimeKey: () => runtimeSurface.runtimeKey,
    getRuntimeGeneration: () => runtimeSurface.generation,
}));

vi.mock('@/lib/i18n', () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/ui', async () => import('@/components/ui/toast'));
vi.mock('@/hooks/streamingHaptics', () => ({ triggerMobileHaptic: vi.fn() }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: vi.fn(async () => ({ ok: true })) }));

vi.mock('@/sync/transcript-repository-runtime', () => ({
    getTranscriptRepository: () => runtimeSurface.repository,
    transcriptScope: (directory: string | null, sessionId: string) => ({
        directory,
        sessionID: sessionId,
    }),
}));

import { useChatTimelineController } from './useChatTimelineController';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'ses_history_boundary';

const historyMetaReady = (): SessionHistoryMeta => ({
    limit: 6,
    loading: false,
    complete: false,
    canLoadEarlier: true,
});

const message = (id: string): ChatMessageEntry => ({
    info: {
        id,
        role: 'user',
        sessionID: SESSION_ID,
        time: { created: 1 },
    } as Message,
    parts: [] as Part[],
});

const applyScrollerGeometry = (
    el: HTMLDivElement,
    input: { scrollHeight: number; clientHeight: number; scrollTop: number },
) => {
    el.style.height = `${input.clientHeight}px`;
    el.style.overflow = 'auto';
    const inner = el.firstElementChild as HTMLDivElement | null;
    if (inner) {
        inner.style.height = `${input.scrollHeight}px`;
    }
    // happy-dom often reports 0 for unlaid-out boxes; pin the metrics the
    // controller reads for auto-fill / near-top gates.
    Object.defineProperties(el, {
        scrollHeight: { configurable: true, get: () => input.scrollHeight },
        clientHeight: { configurable: true, get: () => input.clientHeight },
        scrollTop: {
            configurable: true,
            get: () => input.scrollTop,
            set: (value: number) => {
                input.scrollTop = value;
            },
        },
    });
};

const flushMicrotasks = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

const waitMs = async (ms: number) => {
    await act(async () => {
        await new Promise<void>((resolve) => {
            window.setTimeout(resolve, ms);
        });
    });
};

type HarnessState = {
    sessionId: string;
    isMobile: boolean;
    autoFillEnabled: boolean;
    isPinned: boolean;
    historyMeta: SessionHistoryMeta;
    messages: ChatMessageEntry[];
    messageListApi?: MessageListHandle;
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
};

type TimelineHarnessProps = HarnessState & {
    scrollRef: React.MutableRefObject<HTMLDivElement | null>;
    geometry: { scrollHeight: number; clientHeight: number; scrollTop: number };
    onApi: (api: UseChatTimelineControllerResult) => void;
};

const TimelineHarness: React.FC<TimelineHarnessProps> = ({
    sessionId,
    isMobile,
    autoFillEnabled,
    isPinned,
    historyMeta,
    messages,
    messageListApi,
    loadMoreMessages,
    scrollRef,
    geometry,
    onApi,
}) => {
    const messageListRef = React.useRef<MessageListHandle | null>(null);
    messageListRef.current = messageListApi ?? null;
    // Apply geometry before the controller's layout-phase metrics publish so
    // short-viewport auto-fill can arm on the first commit.
    const bindScrollNode = (node: HTMLDivElement | null) => {
        scrollRef.current = node;
        if (node) applyScrollerGeometry(node, geometry);
    };
    const api = useChatTimelineController({
        sessionId,
        directory: '/workspace',
        messages,
        historyMeta,
        scrollRef,
        messageListRef,
        loadMoreMessages,
        goToBottom: () => undefined,
        releaseAutoFollow: () => undefined,
        beginHistoryViewportPreservation: () => undefined,
        endHistoryViewportPreservation: () => undefined,
        isPinned,
        showScrollButton: false,
        autoFillEnabled,
        isMobile,
    });
    onApi(api);
    return (
        <div data-testid="timeline-scroll" ref={bindScrollNode}>
            <div data-testid="timeline-scroll-inner" />
        </div>
    );
};

type Mounted = {
    root: Root;
    host: HTMLDivElement;
    client: QueryClient;
    scrollRef: React.MutableRefObject<HTMLDivElement | null>;
    state: HarnessState;
    geometry: { scrollHeight: number; clientHeight: number; scrollTop: number };
    api: UseChatTimelineControllerResult | null;
    loadingStates: boolean[];
    render: () => Promise<void>;
    setState: (patch: Partial<HarnessState>) => Promise<void>;
};

const mounted: Mounted[] = [];

const mountController = async (input: {
    isMobile: boolean;
    autoFillEnabled?: boolean;
    isPinned?: boolean;
    historyMeta?: SessionHistoryMeta;
    messages?: ChatMessageEntry[];
    loadMoreMessages: (sessionId: string, direction: 'up' | 'down') => Promise<void>;
    geometry?: { scrollHeight: number; clientHeight: number; scrollTop: number };
}): Promise<Mounted> => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const client = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });
    const scrollRef: React.MutableRefObject<HTMLDivElement | null> = { current: null };

    const handle: Mounted = {
        root: createRoot(host),
        host,
        client,
        scrollRef,
        state: {
            sessionId: SESSION_ID,
            isMobile: input.isMobile,
            autoFillEnabled: input.autoFillEnabled ?? true,
            isPinned: input.isPinned ?? true,
            historyMeta: input.historyMeta ?? historyMetaReady(),
            messages: input.messages ?? [message('msg_1'), message('msg_2')],
            loadMoreMessages: input.loadMoreMessages,
        },
        geometry: input.geometry ?? {
            scrollHeight: 400,
            clientHeight: 400,
            scrollTop: 0,
        },
        api: null,
        loadingStates: [],
        render: async () => undefined,
        setState: async () => undefined,
    };

    handle.render = async () => {
        await act(async () => {
            handle.root.render(
                <QueryClientProvider client={handle.client}>
                    <TimelineHarness
                        {...handle.state}
                        scrollRef={handle.scrollRef}
                        geometry={handle.geometry}
                        onApi={(api) => {
                            handle.api = api;
                            handle.loadingStates.push(api.isLoadingOlder);
                        }}
                    />
                </QueryClientProvider>,
            );
        });
    };

    handle.setState = async (patch) => {
        handle.state = { ...handle.state, ...patch };
        await handle.render();
        await flushMicrotasks();
    };

    await handle.render();
    await flushMicrotasks();
    // Metrics publish + Query auto-fill scheduling.
    await flushMicrotasks();
    await waitMs(0);

    if (!handle.api) throw new Error('timeline controller failed to publish api');

    mounted.push(handle);
    return handle;
};

afterEach(async () => {
    for (const entry of mounted.splice(0)) {
        await act(async () => {
            entry.root.unmount();
        });
        entry.client.clear();
        entry.host.remove();
    }
    runtimeSurface.mobileProbe = false;
    document.body.innerHTML = '';
    vi.clearAllMocks();
});

beforeEach(() => {
    runtimeSurface.mobileProbe = false;
    runtimeSurface.runtimeKey = 'test-runtime';
    runtimeSurface.generation = 1;
    runtimeSurface.repository = null;
    for (const toast of sonnerToast.getToasts()) sonnerToast.dismiss(toast.id);
});

describe('history failure feedback with production toast store', () => {
    const activeErrors = () => sonnerToast.getToasts().filter((toast): toast is ToastT => 'type' in toast && toast.type === 'error');
    const fail = async () => { throw new Error('HTTP 400'); };

    test('failed upward load stops gesture retries; explicit retry remains available and success clears feedback', async () => {
        const load = vi.fn(fail);
        const handle = await mountController({ isMobile: false, autoFillEnabled: false, loadMoreMessages: load });
        for (let index = 0; index < 3; index += 1) {
            await act(async () => handle.api!.handleHistoryUpwardIntent());
            await waitMs(10);
        }
        expect(load).toHaveBeenCalledTimes(1);
        expect(activeErrors()).toHaveLength(1);
        expect(handle.api!.historyRetryRequired).toBe(true);
        expect(activeErrors()[0].title).toBe('chat.history.loadOlderFailed');
        expect(activeErrors()[0].action).toMatchObject({ label: 'Copy' });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(load).toHaveBeenCalledTimes(2);
        await handle.setState({ loadMoreMessages: async () => {
            await handle.setState({ historyMeta: { ...historyMetaReady(), complete: true, canLoadEarlier: false } });
        } });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(activeErrors()).toHaveLength(0);
        expect(handle.api!.historyRetryRequired).toBe(false);
    });

    test.each(['session', 'runtime'] as const)('%s switch isolates late failure from new error', async (scope) => {
        let rejectOld!: (error: Error) => void;
        const handle = await mountController({ isMobile: true, loadMoreMessages: () => new Promise((_, reject) => { rejectOld = reject; }) });
        let oldFlight!: Promise<void>;
        await act(async () => { oldFlight = handle.api!.loadEarlier({ userInitiated: true }); });
        if (scope === 'runtime') runtimeSurface.runtimeKey = 'other-runtime';
        await handle.setState({ sessionId: scope === 'session' ? 'other-session' : SESSION_ID, loadMoreMessages: fail });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(activeErrors()).toHaveLength(1);
        const currentId = activeErrors()[0].id;
        await act(async () => { rejectOld(new Error('old HTTP 400')); await oldFlight; });
        expect(activeErrors().map((toast) => toast.id)).toEqual([currentId]);
    });

    test.each(['session', 'runtime'] as const)('%s switch clears old feedback and uses a distinct scoped ID', async (scope) => {
        const handle = await mountController({ isMobile: true, loadMoreMessages: fail });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        const previousId = activeErrors()[0].id;
        if (scope === 'runtime') runtimeSurface.runtimeKey = 'other-runtime';
        await handle.setState({ sessionId: scope === 'session' ? 'other-session' : SESSION_ID });
        expect(activeErrors()).toHaveLength(0);
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(activeErrors()).toHaveLength(1);
        expect(activeErrors()[0].id).not.toBe(previousId);
    });

    test('late success after a session round trip preserves the current error', async () => {
        let resolveOld!: () => void;
        const handle = await mountController({ isMobile: true, loadMoreMessages: () => new Promise((resolve) => { resolveOld = resolve; }) });
        let oldFlight!: Promise<void>;
        await act(async () => { oldFlight = handle.api!.loadEarlier({ userInitiated: true }); });
        await handle.setState({ sessionId: 'other-session' });
        await handle.setState({ sessionId: SESSION_ID, loadMoreMessages: fail });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        const currentId = activeErrors()[0].id;
        await act(async () => { resolveOld(); await oldFlight; });
        expect(activeErrors().map((toast) => toast.id)).toEqual([currentId]);
    });

    test('runtime generation change isolates a late failure before the next render', async () => {
        let rejectOld!: (error: Error) => void;
        const handle = await mountController({ isMobile: true, loadMoreMessages: () => new Promise((_, reject) => { rejectOld = reject; }) });
        let oldFlight!: Promise<void>;
        await act(async () => { oldFlight = handle.api!.loadEarlier({ userInitiated: true }); });
        runtimeSurface.generation += 1;
        await act(async () => { rejectOld(new Error('old HTTP 400')); await oldFlight; });
        expect(activeErrors()).toHaveLength(0);
    });

    test('auto-fill failure makes one request and stays silent', async () => {
        const load = vi.fn(fail);
        const handle = await mountController({ isMobile: false, loadMoreMessages: load });
        await waitMs(350);
        await handle.render();
        expect(load).toHaveBeenCalledTimes(1);
        expect(activeErrors()).toHaveLength(0);
    });

    test('stationary page blocks repeated scroll and auto-fill, retaining explicit retry feedback', async () => {
        const load = vi.fn(async () => undefined);
        const handle = await mountController({ isMobile: false, isPinned: false, autoFillEnabled: false, loadMoreMessages: load });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(activeErrors()).toHaveLength(1);
        expect(handle.api!.historySignals.canLoadEarlier).toBe(true);
        for (let index = 0; index < 3; index += 1) {
            await act(async () => handle.api!.handleHistoryScroll());
            await act(async () => handle.api!.handleHistoryUpwardIntent());
        }
        await handle.setState({ isPinned: true, autoFillEnabled: true });
        await waitMs(350);
        expect(load).toHaveBeenCalledTimes(1);
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(load).toHaveBeenCalledTimes(2);
        expect(activeErrors()).toHaveLength(1);
    });

    test('empty records with advancing repository cursor make progress and keep one page per explicit request', async () => {
        const client = new QueryClient();
        const repo = createQueryTranscriptRepository({ client, transport: 'test-runtime', generation: 1 });
        runtimeSurface.repository = repo;
        const scope = { directory: '/workspace', sessionID: SESSION_ID };
        repo.apply(scope, { type: 'http-page', purpose: 'initial', page: {
            records: [message('msg_1'), message('msg_2')], cursor: 'cursor-1', complete: false, turnCount: 2,
        } });
        const load = vi.fn(async () => {
            repo.apply(scope, { type: 'http-page', purpose: 'prepend', page: {
                records: [], cursor: 'cursor-2', complete: false, turnCount: 0,
            } });
        });
        const handle = await mountController({ isMobile: true, loadMoreMessages: load });
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(repo.getPagination(scope).cursor).toBe('cursor-2');
        expect(load).toHaveBeenCalledTimes(1);
        expect(activeErrors()).toHaveLength(0);
        expect(handle.api!.historySignals.canLoadEarlier).toBe(true);
        // A second explicit request receives the same cursor and surfaces the stall.
        await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
        expect(load).toHaveBeenCalledTimes(2);
        expect(activeErrors()).toHaveLength(1);
        repo.destroy();
        client.clear();
    });

    test('auto-fill re-arms on an empty cursor advance and stops on the next stationary page', async () => {
        const client = new QueryClient();
        const repo = createQueryTranscriptRepository({ client, transport: 'test-runtime', generation: 1 });
        runtimeSurface.repository = repo;
        const scope = { directory: '/workspace', sessionID: SESSION_ID };
        repo.apply(scope, { type: 'http-page', purpose: 'initial', page: {
            records: [message('msg_1'), message('msg_2')], cursor: 'cursor-1', complete: false, turnCount: 2,
        } });
        const load = vi.fn(async () => {
            repo.apply(scope, { type: 'http-page', purpose: 'prepend', page: {
                records: [], cursor: 'cursor-2', complete: false, turnCount: 0,
            } });
        });
        const handle = await mountController({ isMobile: false, loadMoreMessages: load });
        await waitMs(350);
        await handle.render();
        await waitMs(350);
        await handle.render();
        await waitMs(350);
        expect(load).toHaveBeenCalledTimes(2);
        expect(handle.api!.historySignals.canLoadEarlier).toBe(true);
        expect(activeErrors()).toHaveLength(0);
        repo.destroy();
        client.clear();
    });
});

describe('useChatTimelineController mobile history boundary', () => {
    test('mobile explicit load preserves its anchor through delayed DOM hydration before paint', async () => {
        runtimeSurface.mobileProbe = true;
        let settle!: () => void;
        const handle = await mountController({
            isMobile: true,
            isPinned: false,
            loadMoreMessages: () => new Promise<void>((resolve) => { settle = resolve; }),
            geometry: { scrollHeight: 4000, clientHeight: 400, scrollTop: 0 },
        });
        const container = handle.scrollRef.current!;
        const anchor = container.firstElementChild as HTMLElement;
        anchor.dataset.messageId = 'msg_1';
        let contentOffset = 20;
        container.getBoundingClientRect = () => ({ top: 0, bottom: 400 }) as DOMRect;
        anchor.getBoundingClientRect = () => ({ top: contentOffset - container.scrollTop, bottom: contentOffset - container.scrollTop + 200 }) as DOMRect;
        await handle.setState({ messageListApi: {
            captureViewportAnchor: () => ({ messageId: 'msg_1', offsetTop: 20 }),
            restoreViewportAnchor: () => true,
            isHistoryVirtualized: () => true,
            cancelViewportAnchorHold: () => undefined,
        } as unknown as MessageListHandle });
        let flight!: Promise<void>;
        await act(async () => { flight = handle.api!.loadEarlier({ userInitiated: true }); });
        // A nested markdown commit has no new message array: only the DOM
        // keeper can bridge the interval before the virtualizer measures it.
        contentOffset += 132.5;
        anchor.textContent = 'hydrated markdown';
        await waitMs(0);
        expect(anchor.getBoundingClientRect().top).toBe(20);
        expect(container.scrollTop).toBe(132.5);
        await handle.setState({ historyMeta: { limit: 6, complete: true, canLoadEarlier: false, loading: false } });
        await act(async () => { settle(); await flight; });
        expect(anchor.getBoundingClientRect().top).toBe(20);
    });

    test.each([false, true])('first send with an exhausted native short page never loads older (mobile=%s)', async (isMobile) => {
        const client = new QueryClient();
        const repo = createQueryTranscriptRepository({ client, transport: 'test-runtime', generation: 1 });
        runtimeSurface.repository = repo;
        const scope = { directory: '/workspace', sessionID: SESSION_ID };
        // Native message.list emits both positional cursors on every non-empty
        // page, even when this first user message is the entire conversation.
        const page = normalizeSessionProjectionPage({
            data: [{ id: 'msg_first', type: 'user', time: { created: 1 }, text: 'hello' }],
            cursor: { previous: 'toward-newer', next: 'past-oldest' },
        }, SESSION_ID);
        repo.apply(scope, { type: 'http-page', purpose: 'initial', page });
        const boundary = repo.getPagination(scope).boundary;
        const load = vi.fn(async () => undefined);
        const handle = await mountController({
            isMobile,
            messages: [...page.records] as ChatMessageEntry[],
            historyMeta: { limit: 1, loading: false, ...resolveChatHistoryLoadState({ boundary, assistantComplete: true }) },
            loadMoreMessages: load,
        });
        try {
            await handle.setState({ messages: [...handle.state.messages, message('msg_reply')] });
            await act(async () => {
                handle.api!.handleHistoryScroll();
                handle.api!.handleHistoryUpwardIntent();
            });
            await waitMs(100);
            await act(async () => { await handle.api!.loadEarlier({ userInitiated: true }); });
            expect(load).not.toHaveBeenCalled();
            expect(handle.api!.historySignals.canLoadEarlier).toBe(false);
            expect(handle.api!.isLoadingOlder).toBe(false);
            expect(handle.loadingStates).not.toContain(true);
            expect(handle.scrollRef.current?.scrollTop).toBe(0);
        } finally {
            repo.destroy();
            client.clear();
        }
    });

    // isPinned false: scroll/upward only blocked by isMobile (auto-fill also
    // fails the pin gate). isPinned true: short-viewport auto-fill is armed on
    // every non-mobile gate — so zero fetches proves the mobile autofill guard.
    test.each([
        { isPinned: false as const, label: 'unpinned' },
        { isPinned: true as const, label: 'pinned short-viewport auto-fill' },
    ])(
        'UI mobile=true ($label) blocks scroll / upward-intent / short-viewport auto-fill even when runtime probe is desktop',
        async ({ isPinned }) => {
            runtimeSurface.mobileProbe = false;
            const loadMoreMessages = vi.fn(async () => undefined);

            const handle = await mountController({
                isMobile: true,
                autoFillEnabled: true,
                isPinned,
                loadMoreMessages,
                geometry: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 },
            });

            // Extra commit so short-viewport metrics + Query enablement settle
            // when pin would otherwise arm desktop auto-fill.
            await handle.render();
            await flushMicrotasks();
            await waitMs(250);

            await act(async () => {
                handle.api!.handleHistoryScroll();
                handle.api!.handleHistoryUpwardIntent();
            });
            await flushMicrotasks();
            await waitMs(200);

            expect(loadMoreMessages).not.toHaveBeenCalled();
        },
    );

    test('manual loadEarlier remains available once; concurrent scroll cannot double-fetch', async () => {
        runtimeSurface.mobileProbe = false;
        let resolveLoad: (() => void) | null = null;
        const loadMoreMessages = vi.fn(
            () => new Promise<void>((resolve) => {
                resolveLoad = resolve;
            }),
        );

        const handle = await mountController({
            isMobile: true,
            autoFillEnabled: true,
            isPinned: false,
            loadMoreMessages,
            geometry: { scrollHeight: 8000, clientHeight: 400, scrollTop: 0 },
        });

        await act(async () => {
            void handle.api!.loadEarlier({ userInitiated: true });
        });
        await flushMicrotasks();

        await act(async () => {
            handle.api!.handleHistoryScroll();
            handle.api!.handleHistoryUpwardIntent();
            void handle.api!.loadEarlier({ userInitiated: true });
        });
        await flushMicrotasks();

        expect(loadMoreMessages).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveLoad?.();
        });
        await flushMicrotasks();
    });

    test('UI mobile=false keeps scroll auto-load when runtime probe reports mobile', async () => {
        runtimeSurface.mobileProbe = true;
        const loadMoreMessages = vi.fn(async () => undefined);

        const handle = await mountController({
            isMobile: false,
            autoFillEnabled: false,
            isPinned: false,
            loadMoreMessages,
            geometry: { scrollHeight: 8000, clientHeight: 400, scrollTop: 0 },
        });

        await act(async () => {
            handle.api!.handleHistoryScroll();
        });
        await flushMicrotasks();
        await waitMs(50);

        expect(loadMoreMessages).toHaveBeenCalledTimes(1);
        expect(loadMoreMessages).toHaveBeenCalledWith(SESSION_ID, 'up');
    });

    test('UI mobile=false keeps short-viewport auto-fill when runtime probe reports mobile', async () => {
        runtimeSurface.mobileProbe = true;
        const loadMoreMessages = vi.fn(async () => undefined);

        const handle = await mountController({
            isMobile: false,
            autoFillEnabled: true,
            isPinned: true,
            loadMoreMessages,
            geometry: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 },
        });

        // Metrics publish is async setState; give Query one more commit + tick.
        await handle.render();
        await flushMicrotasks();
        await waitMs(250);

        expect(loadMoreMessages).toHaveBeenCalled();
        expect(loadMoreMessages).toHaveBeenCalledWith(SESSION_ID, 'up');
    });

    const autoFillQuerySnapshots = (client: QueryClient) => (
        client.getQueryCache().getAll().filter((query) => (
            Array.isArray(query.queryKey) && query.queryKey[0] === 'chat-timeline-auto-fill'
        ))
    );

    const isAutoFillBusyRetryState = (client: QueryClient): boolean => {
        return autoFillQuerySnapshots(client).some((query) => {
            const error = query.state.error as { code?: string; message?: string } | null;
            return (
                query.state.fetchFailureCount > 0
                || error?.code === 'auto-fill-busy'
                || error?.message === 'auto-fill-busy'
            );
        });
    };

    // Mount autoFill off → real manual pending → enable autoFill so queryFn
    // hits auto-fill-busy retries (not the initial autofill owning the mutex).
    // Stop via mobile flip or autoFill disable; resolve manual with real growth
    // so canLoadEarlier stays true (no-growth would clear it and vacate the assert).
    test.each([
        { stopHow: 'mobile' as const, label: 'flipping to mobile' },
        { stopHow: 'disable-autofill' as const, label: 'disabling autoFillEnabled' },
    ])(
        '$label stops an already-scheduled auto-fill busy retry before real fetch',
        async ({ stopHow }) => {
            runtimeSurface.mobileProbe = false;
            let resolveUserLoad: (() => void) | null = null;
            const loadMoreMessages = vi.fn(
                () => new Promise<void>((resolve) => {
                    resolveUserLoad = resolve;
                }),
            );

            const handle = await mountController({
                isMobile: false,
                autoFillEnabled: false,
                isPinned: true,
                loadMoreMessages,
                geometry: { scrollHeight: 400, clientHeight: 400, scrollTop: 0 },
            });

            // Real manual flight owns isLoadingOlder / mutex first.
            await act(async () => {
                void handle.api!.loadEarlier({ userInitiated: true });
            });
            await flushMicrotasks();
            expect(loadMoreMessages).toHaveBeenCalledTimes(1);

            // Arm short-viewport auto-fill while manual is still pending.
            // isLoadingOlder is excluded from Query `enabled`, so queryFn must
            // enter the busy-retry path instead of a second real fetch.
            await handle.setState({ autoFillEnabled: true });
            await handle.render();
            await flushMicrotasks();

            // Let busy retries schedule (retryDelay 50).
            await waitMs(200);
            expect(isAutoFillBusyRetryState(handle.client)).toBe(true);
            // Still only the manual real fetch.
            expect(loadMoreMessages).toHaveBeenCalledTimes(1);

            if (stopHow === 'mobile') {
                await handle.setState({ isMobile: true });
            } else {
                await handle.setState({ autoFillEnabled: false });
            }

            // Submit actual growth so stop-no-growth cannot clear canLoadEarlier
            // and make "no second fetch" vacuously true.
            const grownMessages = [
                message('msg_0'),
                message('msg_1'),
                message('msg_2'),
            ];
            const grownMeta: SessionHistoryMeta = {
                limit: 12,
                loading: false,
                complete: false,
                canLoadEarlier: true,
            };

            await act(async () => {
                resolveUserLoad?.();
            });
            // Grow on the next commit so fetchOlderHistory's render wait sees it.
            await handle.setState({
                messages: grownMessages,
                historyMeta: grownMeta,
            });
            await flushMicrotasks();
            await waitMs(300);

            expect(loadMoreMessages).toHaveBeenCalledTimes(1);
            // Gate must still claim more history — otherwise the assert is vacuous.
            expect(handle.state.historyMeta.canLoadEarlier).toBe(true);
        },
    );
});
