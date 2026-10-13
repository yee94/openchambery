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
import { getTranscriptRepository, unbindTranscriptRepository } from '@/sync/transcript-repository-runtime';
import { normalizeSessionProjectionMessage } from '@/sync/session-projection-api';

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

test.each([true, false])('invisible Thought does not split adjacent tools (showReasoning=%s)', async (showReasoningTraces) => {
    useUIStore.setState({ showReasoningTraces });
    const row = assistant('tools-with-thought', '');
    row.parts = [
        { id: 'tool-one', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/workspace/one.ts' }, output: 'one' } },
        { id: 'thought', type: 'reasoning', text: showReasoningTraces ? '' : 'Hidden thought' },
        { id: 'tool-two', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: '/workspace/two.ts' }, output: 'two' } },
    ].map(part => ({ ...part, messageID: row.info.id, sessionID })) as Part[];
    await render([user, row], row.info.id);
    expect(container.querySelectorAll('[data-component="context-tool-group"]')).toHaveLength(1);
});

beforeEach(async () => {
    previousUI = useUIStore.getState();
    previousFlags = useFeatureFlagsStore.getState();
    useUIStore.setState({ chatRenderMode: 'sorted', activityRenderMode: 'collapsed', showReasoningTraces: true });
    useFeatureFlagsStore.setState({ legendTimelineEnabled: false });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Mount the real runtime before its chat subscriber, as the application
    // does. The provider binds its repository during its first effect.
    await act(async () => root.render(
        <RuntimeAPIProvider apis={apis}><QueryClientProvider client={client}><I18nProvider><SyncProvider sdk={opencodeClient.getSdkClient()} directory="/workspace" bootstrapDirectory={false}>
            {null}
        </SyncProvider></I18nProvider></QueryClientProvider></RuntimeAPIProvider>,
    ));
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
    const first = assistant('assistant-1', 'FIRST_CONCLUSION', 'stop');
    const middle = assistant('assistant-2', 'MIDDLE_CONCLUSION', 'stop');
    const second = assistant('assistant-3', 'SECOND_STREAM');
    await render([user, first, middle, second], second.info.id);
    const repo = getTranscriptRepository()!;
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    await act(async () => {
        repo.apply({ directory: '/workspace', sessionID }, { type: 'sse-event-batch', events: [
            { type: 'message.updated', properties: { info: second.info } },
            { type: 'message.part.updated', properties: { part: { ...second.parts[0], text: 'SECOND_STREAM growing' } } },
        ] });
    });
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(container.textContent).toContain('SECOND_STREAM growing');
    expect(container.querySelector('[data-message-id="assistant-1"] [data-message-text-export-source]')?.textContent).toContain('FIRST_CONCLUSION');
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

test.each([false, true])('completion automatically folds process content but keeps the final answer (mobile=%s)', async (isMobile) => {
    useUIStore.setState({ isMobile });
    const first = assistant('assistant-1', 'FIRST_CONCLUSION', 'stop');
    await render([user, first], null);
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    const second = assistant('assistant-2', 'SECOND_CONCLUSION');
    await render([user, first, second], second.info.id);
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    await render([user, first, assistant('assistant-2', 'SECOND_CONCLUSION', 'stop')], null);
    expect(container.textContent).not.toContain('FIRST_CONCLUSION');
    expect(container.textContent).toContain('SECOND_CONCLUSION');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] button[aria-expanded="false"]')!.click());
    expect(container.textContent).toContain('FIRST_CONCLUSION');
    await render([user, first, assistant('assistant-2', 'SECOND_CONCLUSION', 'stop')], null);
    expect(container.textContent).toContain('FIRST_CONCLUSION');
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

test('an explicit process expansion survives completion', async () => {
    const first = assistant('assistant-1', 'PROCESS_NOTE', 'tool-calls');
    const final = assistant('assistant-2', 'FINAL_REPLY', 'stop');
    await render([user, first, final], null);
    const toggle = () => container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] button[aria-expanded]')!;
    await act(async () => toggle().click());
    const continuation = assistant('assistant-3', 'CONTINUED_REPLY');
    await render([user, first, final, continuation], continuation.info.id);
    await render([user, first, final, assistant(continuation.info.id, 'CONTINUED_REPLY', 'stop')], null);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('PROCESS_NOTE');
    expect(container.textContent).toContain('FINAL_REPLY');
});

test('intermediate narration stays before its tool and before the final answer throughout streaming', async () => {
    const first = assistant('assistant-1', 'BEFORE_FIRST_TOOL');
    await render([user, first], first.info.id);
    const withTool = { ...first, parts: [...first.parts, {
        id: 'tool-1', messageID: first.info.id, sessionID, type: 'tool', tool: 'webfetch', callID: 'call-1',
        state: { status: 'completed', input: { url: 'https://timeline.example/first' }, output: 'First result', title: 'First fetch', time: { start: 3, end: 4 } },
    } as Part] };
    await render([user, withTool], first.info.id);
    const expectOrder = (markers: string[]) => {
        const text = container.textContent ?? '';
        for (const marker of markers) expect(text).toContain(marker);
        expect(markers.map(marker => text.indexOf(marker))).toEqual([...markers.map(marker => text.indexOf(marker))].sort((a, b) => a - b));
    };
    expectOrder(['BEFORE_FIRST_TOOL', '1 call']);
    const second = assistant('assistant-2', 'AFTER_FIRST_TOOL');
    await render([user, withTool, second], second.info.id);
    expectOrder(['BEFORE_FIRST_TOOL', '1 call', 'AFTER_FIRST_TOOL']);
    const final = assistant('assistant-3', 'FINAL_ANSWER', 'stop');
    await render([user, withTool, second, final], null);
    expect(container.textContent).toContain('FINAL_ANSWER');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] button[aria-expanded="false"]')!.click());
    expectOrder(['BEFORE_FIRST_TOOL', '1 call', 'AFTER_FIRST_TOOL', 'FINAL_ANSWER']);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] button[aria-expanded="true"]')!.click());
    expect(container.textContent).not.toContain('BEFORE_FIRST_TOOL');
    expect(container.textContent).not.toContain('AFTER_FIRST_TOOL');
    expect(container.textContent).toContain('FINAL_ANSWER');
});

test('activity after a native compaction checkpoint cannot be merged ahead of it', async () => {
    const before = assistant('assistant-z', 'BEFORE_CHECKPOINT', 'length');
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
        id: 'checkpoint', type: 'compaction', time: { created: 3 }, status: 'completed', reason: 'auto',
    })!;
    const after = assistant('assistant-a', 'AFTER_CHECKPOINT');
    after.parts.push({ id: 'tool-after', messageID: after.info.id, sessionID, type: 'tool', tool: 'webfetch', callID: 'call-after',
        state: { status: 'completed', input: { url: 'https://timeline.example/after' }, output: 'done', title: 'after', time: { start: 1, end: 2 } },
    } as Part);
    await render([user, before, checkpoint, after], after.info.id);
    const divider = container.querySelector('[data-compaction-card]')!;
    const afterText = [...container.querySelectorAll('[data-message-text-export-source]')].find(node => node.textContent === 'AFTER_CHECKPOINT')!;
    expect(divider).not.toBeNull();
    expect(afterText).toBeDefined();
    expect(Boolean(divider.compareDocumentPosition(afterText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

test('a live repository update keeps a checkpoint between the surrounding content', async () => {
    const before = assistant('assistant-z', 'BEFORE_CHECKPOINT', 'length');
    const checkpoint = normalizeSessionProjectionMessage(sessionID, {
        id: 'checkpoint-live', type: 'compaction', time: { created: 3 }, status: 'completed', reason: 'auto',
    })!;
    const after = assistant('assistant-a', 'AFTER_CHECKPOINT');
    await render([user, before, checkpoint, after], after.info.id);
    const repo = getTranscriptRepository()!;
    await act(async () => {
        repo.apply({ directory: '/workspace', sessionID }, { type: 'sse-event-batch', events: [
            { type: 'message.updated', properties: { info: after.info } },
            { type: 'message.part.updated', properties: { part: { ...after.parts[0], text: 'AFTER_CHECKPOINT_UPDATED' } } },
        ] });
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(container.textContent).toContain('AFTER_CHECKPOINT_UPDATED');
    expect(container.querySelectorAll('[data-compaction-card]')).toHaveLength(1);
    const divider = container.querySelector('[data-compaction-card]')!;
    const afterText = [...container.querySelectorAll('[data-message-text-export-source]')].find(node => node.textContent === 'AFTER_CHECKPOINT_UPDATED')!;
    expect(Boolean(divider.compareDocumentPosition(afterText) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});

test.each([false, true])('native content order survives reversed clocks and tool IDs (mobile=%s)', async (isMobile) => {
    useUIStore.setState({ isMobile });
    const content = [
        { type: 'text', text: 'NATIVE_TEXT_FIRST' },
        { type: 'tool', id: 'z-call', name: 'read', time: { created: 900, completed: 901 },
            state: { status: 'completed', input: { filePath: '/workspace/Z_FIRST_TOOL.ts' }, content: [{ type: 'text', text: 'result' }] } },
        { type: 'reasoning', text: 'NATIVE_REASONING_MIDDLE', time: { created: 100, completed: 101 } },
        { type: 'text', text: 'NATIVE_TEXT_MIDDLE' },
        { type: 'tool', id: 'a-call', name: 'read', time: { created: 10, completed: 11 },
            state: { status: 'completed', input: { filePath: '/workspace/A_SECOND_TOOL.ts' }, content: [{ type: 'text', text: 'result' }] } },
        { type: 'text', text: 'NATIVE_FINAL_ANSWER' },
    ];
    const markers = ['NATIVE_TEXT_FIRST', 'Z_FIRST_TOOL.ts', 'NATIVE_REASONING_MIDDLE', 'NATIVE_TEXT_MIDDLE', 'A_SECOND_TOOL.ts', 'NATIVE_FINAL_ANSWER'];
    for (let count = 1; count <= content.length; count += 1) {
        const row = normalizeSessionProjectionMessage(sessionID, { id: 'native-step', type: 'assistant', time: { created: 2 }, content: content.slice(0, count) })!;
        await render([user, row], row.info.id);
        await act(async () => {
            container.querySelectorAll<HTMLElement>('[data-component="context-tool-group"] > [aria-expanded="false"], [data-reasoning-block-id] > [aria-expanded="false"]').forEach(button => button.click());
        });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
        const text = container.textContent ?? '';
        for (const marker of markers.slice(0, count)) expect(text).toContain(marker);
        for (let index = 1; index < count; index += 1) {
            expect(text.indexOf(markers[index - 1])).toBeLessThan(text.indexOf(markers[index]));
        }
    }
});

test('earlier text parts in the final native message remain process content, not concatenated conclusions', async () => {
    const first = assistant('assistant-1', 'INTERMEDIATE_EXPLANATION');
    await render([user, first], first.info.id);
    const final = { ...assistant('assistant-1', 'FINAL_ONLY', 'stop'), parts: [
        ...first.parts,
        { id: 'last-text', messageID: first.info.id, sessionID, type: 'text', text: 'FINAL_ONLY' } as Part,
    ] };
    await render([user, final], null);
    expect(container.textContent).not.toContain('INTERMEDIATE_EXPLANATION');
    expect(container.textContent).toContain('FINAL_ONLY');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] button[aria-expanded="false"]')!.click());
    expect(container.textContent).toContain('INTERMEDIATE_EXPLANATION');
    expect(container.textContent).toContain('FINAL_ONLY');
    const fold = container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] button[aria-expanded="true"]');
    expect(fold).not.toBeNull();
    await act(async () => fold!.click());
    expect(container.textContent).not.toContain('INTERMEDIATE_EXPLANATION');
    expect(container.textContent).toContain('FINAL_ONLY');
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

test.each(['sorted', 'live'] as const)('completed reasoning follows the process fold in sorted mode and stays inline in live mode (%s)', async (mode) => {
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
    if (mode === 'sorted') {
        expect(container.textContent).not.toContain('VISIBLE_REASONING_END');
        expect(container.textContent).toContain('VISIBLE_ANSWER');
        expect(container.querySelector('[data-turn-id="user-1"] button[aria-expanded="false"]')).not.toBeNull();
        return;
    }
    expect(container.textContent).toContain('VISIBLE_REASONING_END');
    const disclosure = container.querySelector<HTMLButtonElement>('[data-turn-id="user-1"] [aria-expanded="true"]');
    expect(disclosure).not.toBeNull();
    await act(async () => disclosure!.click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(container.textContent).not.toContain('VISIBLE_REASONING_END');
    expect(container.textContent).toContain('VISIBLE_ANSWER');
});
