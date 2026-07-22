import { beforeEach, describe, expect, test } from 'bun:test';
import { admitChatInputQueueMessageAndConsumeResources, admitQueueMessageAndConsumeResources, admitServerQueueMessageAndConsumeResources, attachedFilesToQueueCandidates, createServerQueueAdmissionCapture, createServerQueueAdmissionIdentity, isServerQueueAdmissionEventBlocked, startServerQueueScopeMutationFlight, type ServerQueueScopeMutationFlights } from './queueAdmission';
import { legacyQueueScope, setMessageQueueMutationFence, useMessageQueueStore, type QueueItem, type QueueScope } from '@/stores/messageQueueStore';
import { sessionDraftKey, type DraftRecord } from '@/sync/input-draft-types';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';

const scope: Extract<QueueScope, { state: 'bound' }> = {
    state: 'bound',
    transportIdentity: 'runtime-a',
    directory: '/project',
    sessionID: 'session-a',
};
const add = (target: QueueScope, content: string): QueueItem => {
    const result = useMessageQueueStore.getState().addToQueue(target, { content });
    if (!result.ok) throw new Error(result.reason);
    return result.item;
};

const serverAdmissionFixture = () => {
    const key = sessionDraftKey({ transportIdentity: 'runtime-a' }, 'session-a');
    const document = { text: 'queued body', references: [] };
    const record: DraftRecord = { version: 1, key, revision: 3, text: document.text, attachments: [], syntheticParts: [], mentions: [], composerReferences: [] };
    const file = new File(['a'], 'a.txt', { type: 'text/plain' });
    const attachment: AttachedFile = { id: 'attachment-a', file, dataUrl: 'data:a', mimeType: 'text/plain', filename: 'a.txt', size: file.size, source: 'local' };
    const inlineDraft: InlineCommentDraft = { id: 'inline-a', sessionKey: 'session-a', source: 'file', fileLabel: 'a.ts', startLine: 1, endLine: 1, code: 'a', language: 'ts', text: 'comment', createdAt: 1 };
    const state = {
        runtime: { transportIdentity: 'runtime-a', generation: 1 },
        currentKey: key,
        record,
        document,
        attachments: [attachment] as AttachedFile[],
        inlineDrafts: [inlineDraft] as InlineCommentDraft[],
        bodyConsumed: false,
    };
    const capture = createServerQueueAdmissionCapture({ draftKey: key, draftRecord: record, runtime: state.runtime, document, attachments: state.attachments, inlineDrafts: state.inlineDrafts });
    const input = (admit: () => Promise<{ status: 'committed' | 'stale' }>) => ({
        capture,
        admit,
        captureRuntime: () => state.runtime,
        getCurrentDraftKey: () => state.currentKey,
        getDraft: () => state.record,
        getDocument: () => state.document,
        consumeBody: () => { state.bodyConsumed = true; },
        getAttachments: () => state.attachments,
        removeAttachment: (id: string) => { state.attachments = state.attachments.filter((entry) => entry.id !== id); },
        getInlineDrafts: () => state.inlineDrafts,
        removeInlineDraft: (id: string) => { state.inlineDrafts = state.inlineDrafts.filter((entry) => entry.id !== id); },
    });
    return { state, capture, input, key, record, document, attachment, inlineDraft };
};

describe('admitQueueMessageAndConsumeResources', () => {
    beforeEach(() => { setMessageQueueMutationFence('open'); });
    test('blocks server admission events for runtime blocking state or a component-local flight', () => {
        expect(isServerQueueAdmissionEventBlocked('server', false, false)).toBe(false);
        expect(isServerQueueAdmissionEventBlocked('server', true, false)).toBe(true);
        expect(isServerQueueAdmissionEventBlocked('server', false, true)).toBe(true);
        expect(isServerQueueAdmissionEventBlocked('frozen', false, true)).toBe(true);
        expect(isServerQueueAdmissionEventBlocked('legacy', false, true)).toBe(false);
    });

    test('runs one server queue mutation per scope flight and keeps its request ID until settlement', async () => {
        const flightRef: { current: ServerQueueScopeMutationFlights } = { current: new Map() };
        let settle!: () => void;
        const pending = new Promise<void>((resolve) => { settle = resolve; });
        const requestIDs: string[] = [];
        let sequence = 0;
        const start = () => startServerQueueScopeMutationFlight(
            flightRef,
            'runtime-a:scope-a',
            () => `request-${++sequence}`,
            (requestID) => {
                requestIDs.push(requestID);
                return pending;
            },
        );

        const first = start();
        expect(first).not.toBeNull();
        expect(start()).toBeNull();
        expect(requestIDs).toEqual(['request-1']);
        expect(flightRef.current.get('runtime-a:scope-a')).toBe('request-1');

        settle();
        await first;
        expect(flightRef.current.has('runtime-a:scope-a')).toBe(false);
    });

    test('admits before consuming drafts, body, and attachments', () => {
        const calls: string[] = [];

        admitQueueMessageAndConsumeResources({
            admit: () => calls.push('admit'),
            drafts: ['first', 'second'],
            consumeDraft: (draft) => calls.push(`draft:${draft}`),
            consumeBody: () => calls.push('body'),
            consumeAttachments: () => calls.push('attachments'),
        });

        expect(calls).toEqual(['admit', 'draft:first', 'draft:second', 'body', 'attachments']);
    });

    test('preserves every composer resource when admission throws', () => {
        const calls: string[] = [];
        const failure = new Error('admission failed');

        let thrown: unknown;
        try {
            admitQueueMessageAndConsumeResources({
                admit: () => {
                    calls.push('admit');
                    throw failure;
                },
                drafts: ['first'],
                consumeDraft: () => calls.push('draft'),
                consumeBody: () => calls.push('body'),
                consumeAttachments: () => calls.push('attachments'),
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBe(failure);
        expect(calls).toEqual(['admit']);
    });

    test('ChatInput admits legacy rows before existing bound and composer rows with stable identities', () => {
        useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue' });
        const actions = useMessageQueueStore.getState();
        const legacyScope = legacyQueueScope(scope.sessionID);
        const legacy = add(legacyScope, 'legacy');
        const bound = add(scope, 'bound');
        const composer = admitChatInputQueueMessageAndConsumeResources({
            bindLegacy: () => actions.bindLegacyQueue(legacyScope, scope),
            addComposer: () => actions.addToQueue(scope, { content: 'composer' }),
            drafts: [],
            consumeDraft: () => {},
            consumeBody: () => {},
            consumeAttachments: () => {},
        });
        const queue = actions.getQueueForScope(scope) as QueueItem[];

        expect(composer.ok).toBe(true);
        if (!composer.ok) return;
        expect(queue.map((item) => item.queueItemID)).toEqual([legacy.queueItemID, bound.queueItemID, composer.item.queueItemID]);
        expect(queue.map((item) => item.operationID)).toEqual([legacy.operationID, bound.operationID, composer.item.operationID]);
        expect(queue.map((item) => item.messageID)).toEqual([legacy.messageID, bound.messageID, composer.item.messageID]);
    });

    test('preserves resources when composer admission fails', () => {
        const calls: string[] = [];
        const result = admitChatInputQueueMessageAndConsumeResources({
            bindLegacy: () => calls.push('bind'),
            addComposer: () => ({ ok: false as const, reason: 'invalid-composer-document' as const }),
            drafts: ['draft'],
            consumeDraft: () => calls.push('draft'),
            consumeBody: () => calls.push('body'),
            consumeAttachments: () => calls.push('attachments'),
        });
        expect(result).toEqual({ ok: false, reason: 'invalid-composer-document' });
        expect(calls).toEqual([]);
    });

    test('server admission consumes every unchanged captured resource after commit', async () => {
        const fixture = serverAdmissionFixture();
        const result = await admitServerQueueMessageAndConsumeResources(fixture.input(async () => ({ status: 'committed' })));
        expect(result).toEqual({ status: 'committed', bodyConsumed: true, attachmentIDsConsumed: ['attachment-a'], inlineDraftIDsConsumed: ['inline-a'] });
        expect(fixture.state.bodyConsumed).toBe(true);
        expect(fixture.state.attachments).toEqual([]);
        expect(fixture.state.inlineDrafts).toEqual([]);
    });

    test('server admission preserves every resource when runtime becomes stale', async () => {
        const fixture = serverAdmissionFixture();
        const result = await admitServerQueueMessageAndConsumeResources(fixture.input(async () => {
            fixture.state.runtime = { transportIdentity: 'runtime-a', generation: 2 };
            return { status: 'committed' };
        }));
        expect(result.status).toBe('stale');
        expect(fixture.state.bodyConsumed).toBe(false);
        expect(fixture.state.attachments).toEqual([fixture.attachment]);
        expect(fixture.state.inlineDrafts).toEqual([fixture.inlineDraft]);
    });

    test('stale admission result preserves every captured resource', async () => {
        const fixture = serverAdmissionFixture();
        const result = await admitServerQueueMessageAndConsumeResources(fixture.input(async () => ({ status: 'stale' })));
        expect(result.status).toBe('stale');
        expect(fixture.state.bodyConsumed).toBe(false);
        expect(fixture.state.attachments).toEqual([fixture.attachment]);
        expect(fixture.state.inlineDrafts).toEqual([fixture.inlineDraft]);
    });

    test('continued input preserves the body while unchanged attachments and inline drafts consume independently', async () => {
        const fixture = serverAdmissionFixture();
        const result = await admitServerQueueMessageAndConsumeResources(fixture.input(async () => {
            fixture.state.document = { text: 'queued body plus new text', references: [] };
            fixture.state.record = { ...fixture.record, revision: 4, text: fixture.state.document.text };
            return { status: 'committed' };
        }));
        expect(result).toEqual({ status: 'committed', bodyConsumed: false, attachmentIDsConsumed: ['attachment-a'], inlineDraftIDsConsumed: ['inline-a'] });
        expect(fixture.state.bodyConsumed).toBe(false);
    });

    test('new and replaced attachment occurrences remain after admission', async () => {
        const fixture = serverAdmissionFixture();
        const replacementFile = new File(['replacement'], 'a.txt', { type: 'text/plain' });
        const replacement = { ...fixture.attachment, file: replacementFile, size: replacementFile.size };
        const added = { ...fixture.attachment, id: 'attachment-b', filename: 'b.txt' };
        const result = await admitServerQueueMessageAndConsumeResources(fixture.input(async () => {
            fixture.state.attachments = [replacement, added];
            return { status: 'committed' };
        }));
        expect(result.attachmentIDsConsumed).toEqual([]);
        expect(fixture.state.attachments).toEqual([replacement, added]);
    });

    test('modified and newly added inline drafts remain after admission', async () => {
        const fixture = serverAdmissionFixture();
        const modified = { ...fixture.inlineDraft, text: 'updated comment' };
        const added = { ...fixture.inlineDraft, id: 'inline-b', text: 'new comment' };
        const result = await admitServerQueueMessageAndConsumeResources(fixture.input(async () => {
            fixture.state.inlineDrafts = [modified, added];
            return { status: 'committed' };
        }));
        expect(result.inlineDraftIDsConsumed).toEqual([]);
        expect(fixture.state.inlineDrafts).toEqual([modified, added]);
    });

    test('admission throw preserves the complete captured composer', async () => {
        const fixture = serverAdmissionFixture();
        await expect(admitServerQueueMessageAndConsumeResources(fixture.input(async () => { throw new Error('failed'); }))).rejects.toThrow('failed');
        expect(fixture.state.bodyConsumed).toBe(false);
        expect(fixture.state.attachments).toEqual([fixture.attachment]);
        expect(fixture.state.inlineDrafts).toEqual([fixture.inlineDraft]);
    });

    test('converts attached files to immutable upload blobs with stable occurrence identity', () => {
        const file = new File(['body'], 'source.txt', { type: 'text/plain' });
        const [candidate] = attachedFilesToQueueCandidates([{ id: 'attachment-a', file, dataUrl: 'data:', mimeType: 'text/plain', filename: 'visible.txt', size: file.size, source: 'local' }]);
        expect(candidate?.attachmentID).toBe('attachment-a');
        expect(candidate?.occurrenceRefID).toEqual(['root', 'attachment-a']);
        expect(candidate?.filename).toBe('visible.txt');
        expect(candidate?.source).toBe('local');
        if (!candidate || candidate.source !== 'local') throw new Error('local candidate expected');
        expect(candidate?.value).toBeInstanceOf(Blob);
        expect(candidate?.value).not.toBe(file);
        expect(candidate.value.size).toBe(file.size);
    });

    test('keeps server files as canonical paths and closes VS Code server admission', () => {
        const file = new File([], 'placeholder.txt', { type: 'text/plain' });
        expect(attachedFilesToQueueCandidates([{ id: 'server-a', file, dataUrl: '', mimeType: 'text/plain', filename: 'server.txt', size: 42, source: 'server', serverPath: '/repo/server.txt' }])).toEqual([{ attachmentID: 'server-a', occurrenceRefID: ['root', 'server-a'], filename: 'server.txt', mimeType: 'text/plain', source: 'server', path: '/repo/server.txt', size: 42 }]);
        expect(() => attachedFilesToQueueCandidates([{ id: 'vscode-a', file, dataUrl: '', mimeType: 'text/plain', filename: 'selection.txt', size: 42, source: 'vscode', vscodePath: '/repo/selection.txt', vscodeSource: 'selection' }])).toThrow('message-queue-vscode-attachment-unsupported');
    });

    test('captures stable queue, operation, OpenCode message, request, and creation identities before admission', () => {
        const ids = ['request-id', 'queue-id', 'operation-id'];
        const identity = createServerQueueAdmissionIdentity(() => ids.shift()!, () => 'msg_ascending', 1234);
        expect(identity).toEqual({ requestID: 'request-id', queueItemID: 'queued-queue-id', operationID: 'operation-operation-id', messageID: 'msg_ascending', createdAt: 1234 });
    });
});
