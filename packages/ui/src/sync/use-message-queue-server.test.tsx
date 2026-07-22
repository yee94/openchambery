import React from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageQueueScope } from '@/lib/message-queue-server';
import { useMessageQueueServerScope } from './use-message-queue-server';
import type { MessageQueuePendingAdmissionItem, MessageQueueServerSurface } from './message-queue-server-runtime';
import type { MessageQueueCutover, MessageQueueOwnership } from './message-queue-cutover';
import { getQueueForScope, queueScopeKey, setMessageQueueMutationFence, useMessageQueueStore, type QueueItem } from '@/stores/messageQueueStore';

const item = { queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'server item', status: 'queued', attemptCount: 0, position: 0, rowVersion: 1, createdAt: 1 };
const scope: MessageQueueScope = { scopeID: 'scope-a', revision: 2, directory: '/project-a', sessionID: 'session-a', worktreeState: 'active', items: [item], itemCount: 1 };

const runtime = (authority: string, onScope?: (input: { transportIdentity: string; directory: string; sessionID: string }) => void, pending: readonly MessageQueuePendingAdmissionItem[] = []): MessageQueueServerSurface => ({
    subscribe: () => () => {},
    subscribeScope: () => () => {},
    getState: () => ({ transportIdentity: 'runtime-a', scopes: new Map(), hydration: 'ready', capability: 'available', authority, isFetching: false, error: undefined, importState: { status: 'idle', imported: 0, total: 0, issues: [], canActivate: false } }),
    getScope: (input) => { onScope?.(input); return input.transportIdentity === 'runtime-a' && input.directory === scope.directory && input.sessionID === scope.sessionID ? scope : undefined; },
    getPendingAdmissions: () => pending,
    captureRuntime: () => ({ transportIdentity: 'runtime-a', generation: 1 }),
    start: () => {}, stop: () => {}, restart: () => {}, refresh: async () => {}, runShadowImport: async () => ({ status: 'idle', imported: 0, total: 0, issues: [], canActivate: false }),
    admit: async () => ({ status: 'committed' }), edit: async () => ({ status: 'committed' }), remove: async () => ({ status: 'committed' }), reserveEdit: async () => undefined, renewEdit: async () => undefined, releaseEdit: async () => {}, removeReserved: async () => false, reorder: async () => ({ status: 'committed' }), manualSend: async () => ({ status: 'committed' }),
});

const cutover = (ownership: MessageQueueOwnership): MessageQueueCutover => {
    const snapshot = { ownership, migration: ownership === 'probing' ? 'freezing' as const : 'complete' as const, frozen: ownership === 'probing' || ownership === 'blocked', admission: ownership === 'legacy-unsupported' ? 'legacy' as const : ownership === 'server-active' || ownership === 'server-paused' ? 'server' as const : 'frozen' as const, importState: { status: 'idle' as const, imported: 0, total: 0, issues: [], canActivate: false } };
    return { subscribe: () => () => {}, getSnapshot: () => snapshot, start: () => {}, stop: () => {}, refresh: async () => snapshot };
};

const Probe = ({ surface, ownership = 'probing', transportIdentity = 'runtime-a', directory = '/project-a' }: { surface: MessageQueueServerSurface; ownership?: MessageQueueOwnership; transportIdentity?: string; directory?: string }) => {
    const view = useMessageQueueServerScope({ transportIdentity, directory, sessionID: 'session-a' }, surface, cutover(ownership));
    return <span>{`${view.mode}:${view.hasPendingAdmission}:${view.hasBlockingAdmission}:${view.items.map((entry) => entry.content).join(',')}`}</span>;
};

describe('useMessageQueueServerScope', () => {
    beforeEach(() => { setMessageQueueMutationFence('open'); useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue' }); });

    test('keeps probing ownership frozen even when the server surface has a shadow snapshot', () => {
        expect(renderToStaticMarkup(<Probe surface={runtime('shadow')} />)).toContain('frozen:');
    });

    test('keeps server rows frozen until cutover publishes active ownership', () => {
        const reads: Array<{ transportIdentity: string; directory: string; sessionID: string }> = [];
        expect(renderToStaticMarkup(<Probe surface={runtime('active', (input) => reads.push(input))} />)).toContain('frozen:');
        expect(reads).toEqual([{ transportIdentity: 'runtime-a', directory: '/project-a', sessionID: 'session-a' }]);
    });

    test('keeps frozen scope reads isolated by directory and runtime identity', () => {
        const surface = runtime('active');
        expect(renderToStaticMarkup(<Probe surface={surface} directory="/project-b" />)).toContain('frozen:');
        expect(renderToStaticMarkup(<Probe surface={surface} transportIdentity="runtime-b" />)).toContain('frozen:');
        expect(renderToStaticMarkup(<Probe surface={surface} />)).toContain('frozen:');
    });

    test('uses server scope rows for active and paused authority', () => {
        const surface = runtime('active');
        expect(renderToStaticMarkup(<Probe surface={surface} ownership="server-active" />)).toContain('server:false:false:server item');
        expect(renderToStaticMarkup(<Probe surface={surface} ownership="server-paused" />)).toContain('server:false:false:server item');
    });

    test('restores legacy mode after unsupported capability ownership', () => {
        expect(renderToStaticMarkup(<Probe surface={runtime('shadow')} ownership="legacy-unsupported" />)).toContain('legacy:');
    });

    test('keeps old runtime rows visible only in their exact frozen scope', () => {
        const localScope = { state: 'bound' as const, transportIdentity: 'runtime-a', directory: '/project-a', sessionID: 'session-a' };
        const localItem: QueueItem = { id: 'local-a', queueItemID: 'local-a', operationID: 'operation-local-a', messageID: 'msg_local_a', content: 'local old row', createdAt: 1, owner: localScope, status: 'queued', attemptCount: 0 };
        useMessageQueueStore.setState({ queuedMessages: { [queueScopeKey(localScope)]: [localItem] } });
        const surface = runtime('active');
        expect(getQueueForScope(useMessageQueueStore.getState(), localScope).map((entry) => entry.content)).toEqual(['local old row']);
        expect(getQueueForScope(useMessageQueueStore.getState(), { ...localScope, transportIdentity: 'runtime-b' })).toEqual([]);
        expect(renderToStaticMarkup(<Probe surface={surface} ownership="blocked" />)).toContain('frozen:');
        expect(renderToStaticMarkup(<Probe surface={surface} ownership="blocked" transportIdentity="runtime-b" />)).toContain('frozen:');
    });

    test('merges pending-only admissions and keeps the authoritative row for duplicate IDs', () => {
        const pending: MessageQueuePendingAdmissionItem = { kind: 'pending-admission', requestID: 'request-a', queueItemID: 'queue-a', operationID: 'operation-a', messageID: 'msg_a', content: 'pending duplicate', createdAt: 1, phase: 'acknowledged', attachmentCount: 0 };
        expect(renderToStaticMarkup(<Probe surface={runtime('active', undefined, [pending])} ownership="server-active" />)).toContain('server:true:false:server item');
        expect(renderToStaticMarkup(<Probe surface={runtime('active', undefined, [{ ...pending, queueItemID: 'queue-pending', content: 'pending only' }])} ownership="server-active" />)).toContain('server:true:false:server item,pending only');
        expect(renderToStaticMarkup(<Probe surface={runtime('active', undefined, [{ ...pending, phase: 'admitting' }])} ownership="server-active" />)).toContain('server:true:true:server item');
    });

    test('publishes a new runtime capture after a generation restart while retaining action references', () => {
        let capture = { transportIdentity: 'runtime-a', generation: 1 };
        const surface = runtime('active');
        surface.captureRuntime = () => capture;
        const views: ReturnType<typeof useMessageQueueServerScope>[] = [];
        const CaptureProbe = () => {
            views.push(useMessageQueueServerScope({ transportIdentity: 'runtime-a', directory: '/project-a', sessionID: 'session-a' }, surface, cutover('server-active')));
            return null;
        };

        renderToStaticMarkup(<CaptureProbe />);
        const initial = views[0]!;
        expect(initial.runtimeCapture).toEqual({ transportIdentity: 'runtime-a', generation: 1 });

        capture = { transportIdentity: 'runtime-a', generation: 2 };
        renderToStaticMarkup(<CaptureProbe />);
        const restarted = views[1]!;
        expect(restarted).not.toBe(initial);
        expect(restarted.runtimeCapture).toEqual({ transportIdentity: 'runtime-a', generation: 2 });
        expect(restarted.actions.admit).toBe(initial.actions.admit);
        expect(restarted.actions.edit).toBe(initial.actions.edit);
        expect(restarted.actions.remove).toBe(initial.actions.remove);
        expect(restarted.actions.reorder).toBe(initial.actions.reorder);
        expect(restarted.actions.manualSend).toBe(initial.actions.manualSend);
    });
});
