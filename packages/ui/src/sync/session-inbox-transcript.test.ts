import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { createStore } from 'zustand/vanilla';
import { handleEvent } from './sync-context';
import { normalizeOpenCodeEvent, toLegacyEventShape } from './opencode-event-normalizer';
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter';
import { bindTranscriptRepositoryInstance, unbindTranscriptRepository } from './transcript-repository-runtime';
import { useSessionInboxOverlayStore, resetInboxTerminalReceiptsForTests } from './session-inbox-overlay';
import { INITIAL_STATE, type Event } from './types';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { ChildStoreManager } from './child-store';

vi.hoisted(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }))));
const sessionID = 'ses_inbox_retention';
const directory = '/workspace';
const scope = { directory, sessionID };
const cleanups: Array<() => void> = [];
beforeEach(() => {
    vi.mocked(fetch).mockImplementation(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
});
afterEach(() => {
    unbindTranscriptRepository();
    cleanups.splice(0).forEach(cleanup => cleanup());
    useSessionInboxOverlayStore.setState({ bySession: {} });
    resetInboxTerminalReceiptsForTests();
});

function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const repo = createQueryTranscriptRepository({ client, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() });
    bindTranscriptRepositoryInstance(repo);
    cleanups.push(() => { repo.destroy(); client.clear(); });
    const store = createStore(() => ({ ...INITIAL_STATE }));
    const children = { getChild: () => store, children: new Map([[directory, store]]), ensureChild: () => store, mark: () => {} } as unknown as ChildStoreManager;
    const routing = { sessionDirectoryById: new Map([[sessionID, directory]]), messageSessionById: new Map(), sessionMessageIdsById: new Map() } as Parameters<typeof handleEvent>[3];
    const send = (type: string, data: Record<string, unknown>, created: number) => {
        const normalized = normalizeOpenCodeEvent({ id: `evt_${created}`, type, data: { sessionID, ...data }, created,
            location: { directory }, durable: { aggregateID: `session:${sessionID}`, seq: created, version: 1 } });
        if (normalized.action !== 'emit') throw new Error('Unexpected dropped event');
        handleEvent(directory, toLegacyEventShape(normalized.event) as Event, children, routing);
    };
    return { repo, send };
}

test('consuming queued input hands its body to the transcript before removing its queue chip', () => {
    const { repo, send } = setup();
    send('session.inbox.enqueued', { inboxID: 'msg_followup', item: { type: 'user', delivery: 'queue', payload: { text: 'User follow-up' } } }, 10);
    expect(useSessionInboxOverlayStore.getState().list(sessionID)).toHaveLength(1);
    expect(repo.getTranscript(scope).messageOrder).not.toContain('msg_followup');
    const missingDuringHandoff: boolean[] = [];
    const unsubscribe = useSessionInboxOverlayStore.subscribe(state => {
        if (state.list(sessionID).length === 0) missingDuringHandoff.push(!repo.getMessage(scope, 'msg_followup'));
    });
    try {
        send('session.inbox.delivered', { inboxID: 'msg_followup' }, 11);
    } finally { unsubscribe(); }
    expect(useSessionInboxOverlayStore.getState().list(sessionID)).toHaveLength(0);
    expect(repo.getParts(scope, 'msg_followup')).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'User follow-up' })]));
    expect(missingDuringHandoff).not.toContain(true);
    send('session.inbox.delivered', { inboxID: 'msg_followup' }, 11);
    expect(repo.getTranscript(scope).messageOrder).toEqual(['msg_followup']);
});

test('attachment-only input survives consumption with its original resource', () => {
    const { repo, send } = setup();
    send('session.inbox.enqueued', { inboxID: 'msg_file', item: { type: 'user', delivery: 'queue', payload: { text: '', files: [{ uri: 'file:///workspace/example.png', name: 'example.png' }] } } }, 20);
    send('session.inbox.delivered', { inboxID: 'msg_file' }, 21);
    expect(repo.getParts(scope, 'msg_file')).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'file', url: 'file:///workspace/example.png', filename: 'example.png' })]));
});

test('a delivered message whose enqueue event was missed is recovered by exact identity while streaming', async () => {
    const { repo, send } = setup();
    const requests: string[] = [];
    vi.mocked(fetch).mockImplementation(async input => {
        const url = String(input instanceof Request ? input.url : input);
        requests.push(url);
        return new Response(JSON.stringify({ data: { id: 'msg_missed', type: 'user', text: 'Recovered follow-up', time: { created: 31 } } }), { headers: { 'content-type': 'application/json' } });
    });
    send('session.inbox.delivered', { inboxID: 'msg_missed' }, 31);
    await vi.waitFor(() => expect(repo.getParts(scope, 'msg_missed'), JSON.stringify(requests)).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Recovered follow-up' })])));
    expect(requests.some(url => url.includes(`/session/${sessionID}/message/msg_missed`))).toBe(true);
});

test('an incomplete enqueue payload recovers the authoritative consumed body', async () => {
    const { repo, send } = setup();
    send('session.inbox.enqueued', { inboxID: 'msg_incomplete', item: { type: 'user', delivery: 'queue', payload: {} } }, 35);
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: {
        id: 'msg_incomplete', type: 'user', text: 'Authoritative consumed body', time: { created: 36 },
    } }), { headers: { 'content-type': 'application/json' } }));
    send('session.inbox.delivered', { inboxID: 'msg_incomplete' }, 36);
    await vi.waitFor(() => expect(repo.getParts(scope, 'msg_incomplete')).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'Authoritative consumed body' }),
    ])));
});

test('late exact recovery cannot populate a replacement repository after a runtime switch', async () => {
    const { repo, send } = setup();
    let release!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    send('session.inbox.delivered', { inboxID: 'msg_stale' }, 40);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const replacement = setup().repo;
    release(new Response(JSON.stringify({ data: { id: 'msg_stale', type: 'user', text: 'old runtime', time: { created: 40 } } }), { headers: { 'content-type': 'application/json' } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(repo.getTranscript(scope).messageOrder).toEqual([]);
    expect(replacement.getTranscript(scope).messageOrder).toEqual([]);
});

test('failed recovery preserves another complete message and allows a later delivery retry', async () => {
    const { repo, send } = setup();
    send('session.inbox.enqueued', { inboxID: 'msg_keep', item: { type: 'user', delivery: 'queue', payload: { text: 'Keep this complete input' } } }, 50);
    send('session.inbox.delivered', { inboxID: 'msg_keep' }, 51);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(fetch).mockImplementation(async () => new Response('offline', { status: 503 }));
    try {
        send('session.inbox.delivered', { inboxID: 'msg_retry' }, 52);
        await vi.waitFor(() => expect(warn).toHaveBeenCalled());
        expect(repo.getParts(scope, 'msg_keep')).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Keep this complete input' })]));
        vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ data: { id: 'msg_retry', type: 'user', text: 'Recovered retry', time: { created: 52 } } }), { headers: { 'content-type': 'application/json' } }));
        send('session.inbox.delivered', { inboxID: 'msg_retry' }, 52);
        await vi.waitFor(() => expect(repo.getTranscript(scope).messageOrder).toEqual(['msg_keep', 'msg_retry']));
    } finally { warn.mockRestore(); }
});
