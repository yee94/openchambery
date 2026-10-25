import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { useEvent, useEventListener } from '@reactuses/core';
import MessageList, { type MessageListHandle } from './MessageList';
import { useChatAutoFollow } from '@/hooks/useChatAutoFollow';
import { useChatTimelineController } from './hooks/useChatTimelineController';
import { useDesktopHistoryWarmup } from './hooks/useDesktopHistoryWarmup';
import { SyncProvider } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import { queryClient } from '@/lib/queryRuntime';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { createWebAPIs } from '../../../../web/src/api';
import { useUIStore } from '@/stores/useUIStore';
import type { ChatMessageEntry } from './lib/turns/types';
import type { Message, Part } from '@/lib/opencode/v2-types';

const sessionID = 'history-scroll-fixture';
const fixtureScenario = new URLSearchParams(location.search).get('scenario') ?? '';
const isMobile = !fixtureScenario.includes('desktop') && fixtureScenario !== 'partial-turn';
const makeRows = (start: number, count: number): ChatMessageEntry[] => Array.from({ length: count }, (_, index) => {
    const id = `message-${String(start + index).padStart(3, '0')}`;
    return {
        info: { id, sessionID, role: 'user', time: { created: start + index + 1 }, agent: 'build' } as Message,
        parts: [{ id: `${id}-text`, messageID: id, sessionID, type: 'text', text: `${id}\n${'History reading position. '.repeat(40)}` } as Part],
    };
});
const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const partialAssistant = (id: string, text: string, finish: string): ChatMessageEntry => ({
    info: { id, sessionID, role: 'assistant', time: { created: 20, completed: 21 }, finish } as Message,
    parts: [{ id: `${id}-text`, messageID: id, sessionID, type: 'text', text } as Part],
});
const makeTurns = (start: number, count: number): ChatMessageEntry[] => makeRows(start, count).flatMap((message, index) => [
    { ...message, parts: message.parts.map((part) => part.type === 'text' ? { ...part, text: `Question ${start + index}` } : part) },
    partialAssistant(`answer-${start + index}`, Array.from({ length: 12 }, (_, line) => `Paragraph ${line}. ${'Historical assistant response. '.repeat(8)}`).join('\n\n'), 'stop'),
]);

export default function Fixture() {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const delayedResize = scenario === 'delayed-resize';
    const compactPrepend = scenario?.startsWith('compact-prepend');
    const turnPrepend = scenario?.startsWith('turn-prepend');
    const partial = scenario === 'partial-turn' || scenario === 'mobile-partial-turn';
    const warmup = scenario?.startsWith('desktop-warmup') ?? false;
    const releaseWarmupResponse = React.useRef<(() => void) | null>(null);
    const [warmupEnabled, setWarmupEnabled] = React.useState(false);
    const [rows, setRows] = React.useState(() => partial
        ? [partialAssistant('partial-process', 'HIDDEN_PARTIAL_PROCESS', 'tool-calls'),
            partialAssistant('partial-final', Array.from({ length: 40 }, (_, i) => `Answer paragraph ${i}. ${'Reading the final answer. '.repeat(8)}`).join('\n\n'), 'stop')]
        : scenario === 'desktop-short'
        ? makeRows(20, 1).map((message) => ({ ...message, parts: message.parts.map((part) => (
            part.type === 'text' ? { ...part, text: 'Short initial transcript' } : part
        )) }))
        : turnPrepend ? makeTurns(100, 12)
        : makeRows(compactPrepend || warmup ? 100 : 20, scenario === 'virtualize-transition' || warmup ? 4 : scenario?.startsWith('fast-entry') ? 8 : 12));
    const [token, setToken] = React.useState(0);
    const [tailHeight, setTailHeight] = React.useState(0);
    const listRef = React.useRef<MessageListHandle | null>(null);
    const upwardRef = React.useRef<() => void>(() => undefined);
    const loads = React.useRef(0);
    const prepared = React.useRef(false);
    const anchorID = React.useRef<string | null>(null);
    const anchorOffset = React.useRef<number | null>(null);
    const fingerY = React.useRef(0);
    const loadFingerY = React.useRef(0);
    const auto = useChatAutoFollow({
        scrollControllerRef: listRef,
        currentSessionId: sessionID, sessionMessageCount: rows.length, sessionIsWorking: false, isMobile,
        onUpwardUserIntent: useEvent(() => upwardRef.current()),
    });
    const { releaseAutoFollow, restoreSnapshot, scrollRef } = auto;
    React.useEffect(() => {
        const frame = requestAnimationFrame(() => { void restoreSnapshot(); });
        return () => cancelAnimationFrame(frame);
    }, [restoreSnapshot]);
    useEventListener('touchmove', useEvent((event: TouchEvent) => {
        fingerY.current = event.touches.item(0)?.clientY ?? fingerY.current;
    }), scrollRef, { capture: true, passive: true });
    const sample = useEvent(() => {
        const el = auto.scrollRef.current!;
        const node = anchorID.current ? el.querySelector<HTMLElement>(`[data-message-id="${anchorID.current}"]`) : null;
        return {
            run: new URLSearchParams(location.search).get('run'),
            prepared: prepared.current,
            top: el.scrollTop, max: el.scrollHeight - el.clientHeight,
            anchor: anchorID.current,
            anchorOffset: anchorOffset.current,
            fingerDelta: fingerY.current - loadFingerY.current,
            anchorTop: node ? node.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
            anchorBottom: node ? node.getBoundingClientRect().bottom - el.getBoundingClientRect().top : null,
            loads: loads.current, pinned: auto.isPinned,
            displayedMessages: el.querySelectorAll('[data-message-id]').length,
            viewportHeight: el.clientHeight,
        };
    });
    const loadMore = useEvent(async (pageSize?: number) => {
        loads.current += 1;
        const anchor = listRef.current?.captureViewportAnchor();
        anchorID.current = anchor?.messageId ?? null;
        anchorOffset.current = anchor?.offsetTop ?? null;
        loadFingerY.current = fingerY.current;
        await wait(100);
        if (scenario === 'desktop-warmup-scrolling') {
            await new Promise<void>((resolve) => { releaseWarmupResponse.current = resolve; });
        }
        const older = partial
            ? [...makeRows(0, 1), partialAssistant('partial-older', 'HIDDEN_EARLIER_PROCESS', 'tool-calls')]
            : turnPrepend ? makeTurns(0, 12)
            : makeRows(0, scenario === 'desktop-warmup-small-pinned' ? 6 : warmup ? pageSize ?? 50 : compactPrepend ? 60 : 12).map((message) => compactPrepend
                ? { ...message, parts: message.parts.map((part) => part.type === 'text' ? { ...part, text: 'Earlier short message' } : part) }
                : message);
        setRows((current) => [...(delayedResize ? older.map((message) => ({
            ...message, parts: message.parts.map((part) => part.type === 'text' ? { ...part, text: 'Loading history body' } : part),
        })) : older), ...current]);
        if (delayedResize) {
            window.setTimeout(() => {
                setRows((current) => [...older, ...current.slice(12)]);
            }, 350);
        }
    });
    const timeline = useChatTimelineController({
        sessionId: sessionID, directory: '/fixture', messages: rows,
        historyMeta: { limit: rows.length, loading: false, complete: loads.current > 0, canLoadEarlier: loads.current === 0 },
        scrollRef: auto.scrollRef, messageListRef: listRef, loadMoreMessages: useEvent(() => loadMore()),
        goToBottom: auto.goToBottom, releaseAutoFollow: auto.releaseAutoFollow,
        beginHistoryViewportPreservation: auto.beginHistoryViewportPreservation,
        endHistoryViewportPreservation: auto.endHistoryViewportPreservation,
        isPinned: auto.isPinned, showScrollButton: auto.showScrollButton, isMobile,
        onWillLoadEarlier: useEvent(() => setToken((value) => value + 1)),
    });
    upwardRef.current = timeline.handleHistoryUpwardIntent;
    useDesktopHistoryWarmup({
        scope: sessionID,
        enabled: warmup && warmupEnabled,
        cursor: loads.current === 0 ? 'older' : null,
        loadedTurns: rows.length,
        messages: rows,
        scrollRef,
        loadPrevious: loadMore,
    });
    const { resumeToBottomInstant } = timeline;
    React.useEffect(() => {
        const api = {
            prepare: async () => {
                if (warmup && scenario?.endsWith('-pinned')) {
                    prepared.current = true;
                    setWarmupEnabled(true);
                    return;
                }
                if (scenario?.startsWith('fast-entry')) {
                    await restoreSnapshot();
                    prepared.current = true;
                    return;
                }
                releaseAutoFollow();
                await wait(50);
                scrollRef.current!.scrollTop = scenario === 'virtualize-transition' || warmup ? 100 : 800;
                await wait(500);
                prepared.current = true;
                if (warmup) setWarmupEnabled(true);
            },
            sample,
            finishWarmup: () => releaseWarmupResponse.current?.(),
            resume: () => resumeToBottomInstant(),
            grow: () => setTailHeight((height) => height + 300),
        };
        Object.assign(window, { historyScrollFixture: api });
        if (!new URLSearchParams(location.search).has('native')) return;
        const timer = window.setInterval(() => {
            if (scrollRef.current) void fetch('/sample', { method: 'POST', body: JSON.stringify(sample()) });
        }, 200);
        const prepareTimer = window.setTimeout(() => void api.prepare(), 2000);
        return () => { window.clearInterval(timer); window.clearTimeout(prepareTimer); };
    }, [releaseAutoFollow, restoreSnapshot, scrollRef, sample, scenario, resumeToBottomInstant, warmup]);
    return <div ref={auto.scrollRef} data-history-scroller="true" onScroll={timeline.handleHistoryScroll}
        style={{ height: '100dvh', overflowY: 'auto', overflowAnchor: 'none' }}>
        <div><MessageList ref={listRef} sessionKey={sessionID} virtualizerKey={sessionID} directory="/fixture"
            messages={timeline.renderedMessages} scrollRef={auto.scrollRef} isLoadingOlder={timeline.isLoadingOlder}
            sessionIsWorking={false} onMessageContentChange={auto.notifyContentChange}
            getAnimationHandlers={auto.getAnimationHandlers} enableSendPark={false}
            timelineHistoryAnchorToken={token} />
            <div data-live-tail-growth style={{ height: tailHeight }} />
        </div>
    </div>;
}

const partialTurn = ['partial-turn', 'mobile-partial-turn'].includes(new URLSearchParams(location.search).get('scenario') ?? '');
useUIStore.setState({ isMobile, chatRenderMode: partialTurn || fixtureScenario.startsWith('turn-prepend') ? 'sorted' : 'live', activityRenderMode: partialTurn || fixtureScenario.startsWith('turn-prepend') ? 'collapsed' : 'summary' });
createRoot(document.getElementById('root')!).render(
    <RuntimeAPIProvider apis={createWebAPIs()}><QueryClientProvider client={queryClient}><I18nProvider>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory="/fixture" bootstrapDirectory={false}>
            <Fixture />
        </SyncProvider>
    </I18nProvider></QueryClientProvider></RuntimeAPIProvider>,
);
