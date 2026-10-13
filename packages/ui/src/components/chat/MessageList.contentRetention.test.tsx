import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import MessageList from './MessageList';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { opencodeClient } from '@/lib/opencode/client';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { ChatMessageEntry } from './lib/turns/types';
import type { Message, Part } from '@/lib/opencode/v2-types';
import { createQueryTranscriptRepository } from '@/sync/transcript-repository-query-adapter';
import { bindTranscriptRepositoryInstance, unbindTranscriptRepository } from '@/sync/transcript-repository-runtime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

vi.hoisted(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        return url.includes('/event')
            ? new Response(': keep-alive\n\n', { headers: { 'content-type': 'text/event-stream' } })
            : new Response('{}', { headers: { 'content-type': 'application/json' } });
    }));
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sessionID = 'ses_content_retention';
const user: ChatMessageEntry = {
    info: { id: 'user-1', sessionID, role: 'user', time: { created: 1 } } as Message,
    parts: [{ id: 'user-text', sessionID, messageID: 'user-1', type: 'text', text: 'Keep my request visible.' } as Part],
};
const assistant = (id: string, text: string, finish?: string): ChatMessageEntry => ({
    info: { id, sessionID, role: 'assistant', parentID: user.info.id, time: { created: 2, ...(finish ? { completed: 3 } : {}) }, ...(finish ? { finish } : {}) } as Message,
    parts: [{ id: `${id}:text:0`, messageID: id, sessionID, type: 'text', text } as Part],
});
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let previousUI: ReturnType<typeof useUIStore.getState>;
let previousFlags: ReturnType<typeof useFeatureFlagsStore.getState>;
const apis = { runtime: { isVSCode: false, isDesktop: false }, files: {}, editor: {} } as RuntimeAPIs;

beforeEach(() => {
    previousUI = useUIStore.getState();
    previousFlags = useFeatureFlagsStore.getState();
    useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'collapsed', showReasoningTraces: true });
    useFeatureFlagsStore.setState({ legendTimelineEnabled: false });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
    await act(async () => root.unmount());
    unbindTranscriptRepository();
    client.clear();
    container.remove();
    useUIStore.setState(previousUI);
    useFeatureFlagsStore.setState(previousFlags);
});

test('live repository overlays retain earlier conclusions in the real chat list', async () => {
    const repo = createQueryTranscriptRepository({ client, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() });
    bindTranscriptRepositoryInstance(repo);
    const first = assistant('assistant-1', 'FIRST_CONCLUSION', 'stop');
    const middle = assistant('assistant-2', 'MIDDLE_CONCLUSION', 'stop');
    const second = assistant('assistant-3', 'SECOND_STREAM');
    try {
        await render([user, first, middle, second], second.info.id);
        expect(container.textContent).toContain('FIRST_CONCLUSION');
        await act(async () => {
            repo.apply({ directory: '/workspace', sessionID }, { type: 'sse-event-batch', events: [
                { type: 'message.updated', properties: { info: second.info } },
                { type: 'message.part.updated', properties: { part: { ...second.parts[0], text: 'SECOND_STREAM growing' } } },
            ] });
        });
        expect(container.textContent).toContain('FIRST_CONCLUSION');
        expect(container.textContent).toContain('SECOND_STREAM');
        expect(container.querySelector('[data-message-id="assistant-1"] [data-message-text-export-source]')?.textContent).toContain('FIRST_CONCLUSION');
    } finally { repo.destroy(); }
});

async function render(messages: ChatMessageEntry[], activeID: string | null) {
    await act(async () => root.render(
        <RuntimeAPIProvider apis={apis}><QueryClientProvider client={client}><I18nProvider><SyncProvider sdk={opencodeClient.getSdkClient()} directory="/workspace" bootstrapDirectory={false}>
            <MessageList messages={messages} sessionKey={sessionID} directory="/workspace"
                sessionIsWorking={Boolean(activeID)} activeStreamingMessageId={activeID}
                activeStreamingPhase={activeID ? 'streaming' : null} isLoadingOlder={false}
                onMessageContentChange={() => undefined}
                getAnimationHandlers={() => ({ onChunk: () => undefined, onComplete: () => undefined })}
                initialPinRevealComplete disableStaging enableSendPark={false} />
        </SyncProvider></I18nProvider></QueryClientProvider></RuntimeAPIProvider>,
    ));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 180)); });
}

test.each([false, true])('a new streamed assistant cannot remove displayed text (mobile=%s)', async (isMobile) => {
    useUIStore.setState({ isMobile });
    const first = assistant('assistant-1', 'FIRST_VISIBLE_PARAGRAPH');
    await render([user, first], first.info.id);
    expect(container.textContent).toContain('Keep my request visible.');
    expect(container.textContent).toContain('FIRST_VISIBLE_PARAGRAPH');
    await render([user, first, assistant('assistant-2', 'SECOND_VISIBLE_PARAGRAPH')], 'assistant-2');
    expect(container.textContent).toContain('FIRST_VISIBLE_PARAGRAPH');
    expect(container.textContent).toContain('SECOND_VISIBLE_PARAGRAPH');
});

test.each([false, true])('completion keeps earlier conclusions outside automatic folds (mobile=%s)', async (isMobile) => {
    useUIStore.setState({ isMobile });
    const first = assistant('assistant-1', 'FIRST_CONCLUSION', 'stop');
    await render([user, first], null);
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    const second = assistant('assistant-2', 'SECOND_CONCLUSION');
    await render([user, first, second], second.info.id);
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    await render([user, first, assistant('assistant-2', 'SECOND_CONCLUSION', 'stop')], null);
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    expect(container.textContent).toContain('SECOND_CONCLUSION');
});

test('tool arrival, step completion and failure preserve an already displayed partial answer', async () => {
    const first = assistant('assistant-1', 'PARTIAL_ANSWER');
    await render([user, first], first.info.id);
    expect(container.textContent).toContain('PARTIAL_ANSWER');
    const withTool = { ...first, parts: [...first.parts, {
        id: 'tool-1', messageID: first.info.id, sessionID, type: 'tool', tool: 'read', callID: 'call-1',
        state: { status: 'running', input: { filePath: '/workspace/example.txt' }, time: { start: 2 } },
    } as Part] };
    await render([user, withTool], first.info.id);
    expect(container.textContent).toContain('PARTIAL_ANSWER');
    await render([user, { ...withTool, info: { ...first.info, finish: 'tool-calls' } as Message }], null);
    expect(container.textContent).toContain('PARTIAL_ANSWER');
    await render([user, { ...withTool, info: { ...first.info, error: { name: 'UnknownError', data: { message: 'Interrupted test' } } } as Message }], null);
    expect(container.textContent).toContain('PARTIAL_ANSWER');
});

test('a late streaming status for an older message cannot hide a newer visible sibling', async () => {
    const first = assistant('assistant-1', 'FIRST_VISIBLE_PARAGRAPH');
    const second = assistant('assistant-2', 'SECOND_VISIBLE_PARAGRAPH');
    await render([user, first, second], second.info.id);
    expect(container.textContent).toContain('SECOND_VISIBLE_PARAGRAPH');
    await render([user, first, second], first.info.id);
    expect(container.textContent).toContain('FIRST_VISIBLE_PARAGRAPH');
    expect(container.textContent).toContain('SECOND_VISIBLE_PARAGRAPH');
});

test('completed text stays present at every DOM commit when the next user turn arrives', async () => {
    const first = assistant('assistant-1', 'COMMITTED_CONCLUSION');
    await render([user, first], first.info.id);
    const missing: string[] = [];
    const observer = new MutationObserver(() => {
        if (!container.textContent?.includes('COMMITTED_CONCLUSION')) missing.push(container.textContent ?? '');
    });
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    try {
        const completed = assistant(first.info.id, 'COMMITTED_CONCLUSION', 'stop');
        await render([user, completed], null);
        const nextUser = { info: { ...user.info, id: 'user-2', time: { created: 4 } } as Message,
            parts: [{ ...user.parts[0], id: 'user-2-text', messageID: 'user-2', text: 'Next user request' } as Part] };
        await render([user, completed, nextUser], null);
        const next = assistant('assistant-2', 'NEXT_ANSWER');
        next.info = { ...next.info, parentID: 'user-2', time: { created: 5 } } as Message;
        await render([user, completed, nextUser, next], next.info.id);
        expect(missing).toEqual([]);
    } finally { observer.disconnect(); }
});

test.each(['sorted', 'live'] as const)('reasoning shown during streaming stays expanded through completion until the user collapses it (%s)', async (mode) => {
    useUIStore.setState({ chatRenderMode: mode });
    const first = assistant('assistant-1', 'VISIBLE_ANSWER');
    const reasoning = { id: 'reasoning-1', messageID: first.info.id, sessionID, type: 'reasoning', text: `${'Reasoning context. '.repeat(10)}VISIBLE_REASONING_END` } as Part;
    const answer = first.parts;
    first.parts = [reasoning];
    await render([user, first], first.info.id);
    if (mode === 'sorted') await act(async () => container.querySelector<HTMLElement>('[data-reasoning-block-id] [role="button"]')!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(container.textContent).toContain('VISIBLE_REASONING_END');
    const completed = { ...first, parts: [reasoning, ...answer], info: { ...first.info, finish: 'stop', time: { created: 2, completed: 3 } } as Message };
    await render([user, completed], null);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(container.textContent).toContain('VISIBLE_REASONING_END');
    const disclosure = container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] [aria-expanded="true"]');
    expect(disclosure).not.toBeNull();
    await act(async () => disclosure!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(container.textContent).not.toContain('VISIBLE_REASONING_END');
    expect(container.textContent).toContain('VISIBLE_ANSWER');
});
