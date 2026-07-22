import { beforeEach, describe, expect, test } from 'bun:test';
import { legacyQueueScope, markMessageQueueTransportRetired, migrateMessageQueueState, prepareLegacyQueuesForCutover, queueScopeKey, setMessageQueueMutationFence, useMessageQueueStore, type QueueItem, type QueueScope } from './messageQueueStore';
import { serializeComposerDocument } from '@/composer/document';

const a: Extract<QueueScope, { state: 'bound' }> = { state: 'bound', transportIdentity: 'runtime-a', directory: '/project', sessionID: 'session-a' };
const b: Extract<QueueScope, { state: 'bound' }> = { ...a, transportIdentity: 'runtime-b' };
const reset = (): void => { useMessageQueueStore.setState({ queuedMessages: {}, followUpBehavior: 'queue' }); };
const mustAdd = (scope: QueueScope = a): QueueItem => {
  const result = useMessageQueueStore.getState().addToQueue(scope, { content: 'message' });
  if (!result.ok) throw new Error(result.reason);
  return result.item;
};

describe('messageQueueStore scoped ledger', () => {
  beforeEach(() => { setMessageQueueMutationFence('open'); reset(); });
  test('uses stable physical scope keys and isolates same session across runtimes', () => {
    const first = mustAdd(a); const second = mustAdd(b); const state = useMessageQueueStore.getState();
    expect(queueScopeKey(a)).not.toBe(queueScopeKey(b));
    expect(state.getQueueForScope(a)[0]).toBe(first); expect(state.getQueueForScope(b)[0]).toBe(second);
    expect(/^msg_/.test(first.messageID)).toBe(true); expect(/^msg_/.test(second.messageID)).toBe(true);
  });
  test('round-trips delivery target and runtime generation in the durable UI scope', () => {
    const assistant = { ...a, deliveryTarget: { kind: 'assistant' as const, assistantID: 'assistant-a' }, runtimeGeneration: 7 };
    const item = mustAdd(assistant);
    const migrated = migrateMessageQueueState({ queuedMessages: useMessageQueueStore.getState().queuedMessages });
    expect(queueScopeKey(assistant)).not.toBe(queueScopeKey(a));
    expect(migrated.queuedMessages[queueScopeKey(assistant)]?.[0]?.owner).toEqual({ ...assistant });
    expect(item.owner.state === 'bound' && item.owner.deliveryTarget).toEqual({ kind: 'assistant', assistantID: 'assistant-a' });
  });
  test('fences user mutations while allowing an in-flight item to settle', () => {
    const item = mustAdd();
    const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID };
    useMessageQueueStore.getState().markQueueItemSendAttempt(a, identity);
    setMessageQueueMutationFence('quiescing');
    expect(useMessageQueueStore.getState().addToQueue(a, { content: 'blocked' }).ok).toBe(false);
    useMessageQueueStore.getState().removeFromQueue(a, item.queueItemID, item.operationID);
    expect(useMessageQueueStore.getState().getQueueForScope(a)[0]?.queueItemID).toBe(item.queueItemID);
    useMessageQueueStore.getState().markQueueItemDefinitiveFailure(a, identity);
    expect(useMessageQueueStore.getState().getQueueForScope(a)[0]?.status).toBe('failed');
  });
  test('keeps retired transport scopes read-only while a new unsupported transport opens', () => {
    const retired = { state: 'bound' as const, transportIdentity: 'retired-web-runtime', directory: '/project', sessionID: 'session-a' };
    const fresh = { ...retired, transportIdentity: 'vscode-501-runtime' };
    const old = mustAdd(retired);
    markMessageQueueTransportRetired(retired.transportIdentity);
    setMessageQueueMutationFence('open');
    expect(useMessageQueueStore.getState().addToQueue(retired, { content: 'blocked' }).ok).toBe(false);
    expect(useMessageQueueStore.getState().getQueueForScope(retired)[0]?.queueItemID).toBe(old.queueItemID);
    expect(useMessageQueueStore.getState().addToQueue(fresh, { content: 'new-runtime' }).ok).toBe(true);
  });
  test('bulk binds every legacy scope atomically with stable order and identities', () => {
    const first = mustAdd(legacyQueueScope('session-a')); const second = mustAdd(legacyQueueScope('session-a')); const third = mustAdd(legacyQueueScope('session-b'));
    const existing = mustAdd({ state: 'bound', transportIdentity: 'cutover-runtime', directory: '/a', sessionID: 'session-a' });
    setMessageQueueMutationFence('quiescing');
    expect(prepareLegacyQueuesForCutover('cutover-runtime', (sessionID) => sessionID === 'session-a' ? '/a' : '/b')).toEqual({ ok: true, moved: 3 });
    const boundA = { state: 'bound' as const, transportIdentity: 'cutover-runtime', directory: '/a', sessionID: 'session-a' };
    const boundB = { state: 'bound' as const, transportIdentity: 'cutover-runtime', directory: '/b', sessionID: 'session-b' };
    expect(useMessageQueueStore.getState().getQueueForScope(boundA).map((item) => item.queueItemID)).toEqual([first.queueItemID, second.queueItemID, existing.queueItemID]);
    expect(useMessageQueueStore.getState().getQueueForScope(boundB)[0]?.operationID).toBe(third.operationID);
    expect(useMessageQueueStore.getState().getQueueForScope(legacyQueueScope('session-a'))).toEqual([]);
  });
  test('keeps every legacy scope in place when one authoritative directory is unavailable', () => {
    const first = mustAdd(legacyQueueScope('session-a')); const second = mustAdd(legacyQueueScope('session-b'));
    setMessageQueueMutationFence('quiescing');
    expect(prepareLegacyQueuesForCutover('rollback-runtime', (sessionID) => sessionID === 'session-a' ? '/a' : undefined)).toEqual({ ok: false, unresolvedSessionIDs: ['session-b'] });
    expect(useMessageQueueStore.getState().getQueueForScope(legacyQueueScope('session-a'))[0]?.queueItemID).toBe(first.queueItemID);
    expect(useMessageQueueStore.getState().getQueueForScope(legacyQueueScope('session-b'))[0]?.queueItemID).toBe(second.queueItemID);
  });
  test('rejects malformed and content-mismatched composer sidecars without queue mutation', () => {
    const actions = useMessageQueueStore.getState();
    const malformed = actions.addToQueue(a, { content: 'message', composerDocument: { text: 'message', references: [{ id: 'bad' }] } as never });
    const nullSidecar = actions.addToQueue(a, { content: 'message', composerDocument: null as never });
    const mismatched = actions.addToQueue(a, { content: 'other', composerDocument: { text: '[Paste 1]', references: [{ id: 'paste', kind: 'paste', text: 'payload', characterCount: 7, index: 1, display: '[Paste 1]', start: 0, end: 9 }] } });
    expect(malformed).toEqual({ ok: false, reason: 'invalid-composer-document' });
    expect(nullSidecar).toEqual({ ok: false, reason: 'invalid-composer-document' });
    expect(mismatched).toEqual({ ok: false, reason: 'invalid-composer-document' });
    expect(actions.getQueueForScope(a)).toEqual([]);
  });
  test('preserves confirmed authored file mentions and rejects invalid mention admission', () => {
    const document = { text: '@README', references: [] };
    const accepted = useMessageQueueStore.getState().addToQueue(a, { content: '@README', composerDocument: document, composerMentions: [{ kind: 'file', value: 'README', path: 'README', label: 'README', range: { start: 0, end: 7 } }] });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.reason);
    expect(accepted.item.composerMentions?.[0]?.path).toBe('README');
    const rejected = useMessageQueueStore.getState().addToQueue(a, { content: '@README', composerDocument: document, composerMentions: [{ kind: 'file', value: 'README', path: 'README', label: 'README', range: { start: 0, end: 6 } }] });
    expect(rejected).toEqual({ ok: false, reason: 'invalid-composer-mentions' });
    expect(useMessageQueueStore.getState().getQueueForScope(a)).toHaveLength(1);
  });
  test('admits Session and Paste sidecars with independent attachments and preserves them through migration', () => {
    const document = { text: '[Paste 1] @session', references: [
      { id: 'paste', kind: 'paste' as const, text: 'payload', characterCount: 7, index: 1, display: '[Paste 1]', start: 0, end: 9 },
      { id: 'session', kind: 'session' as const, sessionId: 'session-target', display: '@session', start: 10, end: 18 },
    ] };
    const serialized = serializeComposerDocument(document, 'queue-canonical');
    if (!serialized.ok) throw new Error('expected canonical composer document');
    const result = useMessageQueueStore.getState().addToQueue(a, { content: serialized.text, composerDocument: document });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.item).toEqual(useMessageQueueStore.getState().getQueueForScope(a)[0]);
    const stored = useMessageQueueStore.getState().getQueueForScope(a)[0]!;
    expect(Object.hasOwn(stored, 'ok')).toBe(false);
    expect(Object.hasOwn(stored, 'item')).toBe(false);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    const migrated = migrateMessageQueueState({ queuedMessages: useMessageQueueStore.getState().queuedMessages });
    expect(migrated.queuedMessages[queueScopeKey(a)]?.[0]?.composerDocument).toEqual(document);
  });
  test('admits independent ordinary attachments with Session and Paste sidecars', () => {
    const document = { text: '[Paste 1] @session', references: [
      { id: 'paste', kind: 'paste' as const, text: 'payload', characterCount: 7, index: 1, display: '[Paste 1]', start: 0, end: 9 },
      { id: 'session', kind: 'session' as const, sessionId: 'session-target', display: '@session', start: 10, end: 18 },
    ] };
    const serialized = serializeComposerDocument(document, 'queue-canonical');
    if (!serialized.ok) throw new Error('expected canonical composer document');
    const result = useMessageQueueStore.getState().addToQueue(a, { content: serialized.text, composerDocument: document, attachments: [{ id: 'ordinary-attachment', file: new File([], 'ordinary.txt'), dataUrl: '', mimeType: 'text/plain', filename: 'ordinary.txt', size: 0, source: 'local' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.item.attachments).toHaveLength(1);
  });
  test('replaces invalid persisted message IDs while preserving queue and operation identities', () => {
    const persisted = { queuedMessages: { [queueScopeKey(a)]: [{ id: 'queue-1', queueItemID: 'queue-1', operationID: 'operation-1', messageID: 'message-invalid', content: 'one', createdAt: 1, owner: a, status: 'failed' as const, attemptCount: 1 }] } };
    const migrated = migrateMessageQueueState(persisted);
    const item = migrated.queuedMessages[queueScopeKey(a)]![0]!;
    const repeated = migrateMessageQueueState(migrated).queuedMessages[queueScopeKey(a)]![0]!;
    expect(/^msg_/.test(item.messageID)).toBe(true); expect(item.queueItemID).toBe('queue-1'); expect(item.operationID).toBe('operation-1'); expect(item.status).toBe('failed'); expect(repeated.messageID).toBe(item.messageID);
  });
  test('keeps valid persisted msg IDs unchanged across repeated migrations', () => {
    const persisted = { queuedMessages: { [queueScopeKey(a)]: [{ id: 'queue-1', queueItemID: 'queue-1', operationID: 'operation-1', messageID: 'msg_existing', content: 'one', createdAt: 1, owner: a }] } };
    const migrated = migrateMessageQueueState(persisted);
    expect(migrated.queuedMessages[queueScopeKey(a)]![0]?.messageID).toBe('msg_existing');
    expect(migrateMessageQueueState(migrated).queuedMessages[queueScopeKey(a)]![0]?.messageID).toBe('msg_existing');
  });
  test('migrates v2 session queues by item owner and remains idempotent', () => {
    const migrated = migrateMessageQueueState({ queuedMessages: { 'session-a': [{ id: 'legacy', content: 'one', createdAt: 1 }, { id: 'owned', content: 'two', createdAt: 2, owner: a }] } });
    const repeated = migrateMessageQueueState(migrated);
    const legacy = migrated.queuedMessages[queueScopeKey(legacyQueueScope('session-a'))]![0]!;
    expect(legacy.queueItemID).toBe('legacy'); expect(legacy.owner).toEqual(legacyQueueScope('session-a'));
    expect(repeated.queuedMessages[queueScopeKey(a)]![0]!.operationID).toBe(migrated.queuedMessages[queueScopeKey(a)]![0]!.operationID);
    expect(repeated.queuedMessages[queueScopeKey(a)]![0]!.messageID).toBe(migrated.queuedMessages[queueScopeKey(a)]![0]!.messageID);
  });
  test('locks sending and reconciling items while confirmation still removes the matching identity pair', () => {
    const item = mustAdd(); const id = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(a, id); actions.removeFromQueue(a, item.queueItemID, item.operationID); actions.reorderQueue(a, item.queueItemID, item.queueItemID, item.operationID); actions.clearQueue(a);
    expect(actions.getQueueForScope(a)).toHaveLength(1); actions.confirmQueueItem(a, id); expect(actions.getQueueForScope(a)).toEqual([]);
  });
  test('clearAllQueues retains sending and reconciling items', () => {
    const sending = mustAdd(a); const reconciling = mustAdd(b); const removable = mustAdd(a); const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(a, sending);
    actions.markQueueItemSendAttempt(b, reconciling);
    actions.markQueueItemReconciling(b, reconciling);
    actions.clearAllQueues();
    expect(actions.getQueueForScope(a)[0]?.status).toBe('sending'); expect(actions.getQueueForScope(b)[0]?.status).toBe('reconciling'); expect(actions.getQueueForScope(a)).toHaveLength(1); expect(actions.getQueueForScope(b)).toHaveLength(1); expect(removable.queueItemID).toBeTruthy();
  });
  test('requires operation and message IDs to identify the same item', () => {
    const first = mustAdd(); const second = mustAdd(); const actions = useMessageQueueStore.getState();
    actions.confirmQueueItem(a, { operationID: first.operationID, messageID: second.messageID });
    expect(actions.getQueueForScope(a)).toHaveLength(2); actions.confirmQueueItem(a, { operationID: first.operationID, messageID: first.messageID }); expect(actions.getQueueForScope(a)).toHaveLength(1);
  });
  test('keeps unrelated runtime references stable during scoped transitions', () => {
    const first = mustAdd(a); const other = mustAdd(b); const before = useMessageQueueStore.getState().getQueueForScope(b); useMessageQueueStore.getState().markQueueItemSendAttempt(a, first);
    expect(useMessageQueueStore.getState().getQueueForScope(b)).toBe(before); expect(useMessageQueueStore.getState().getQueueForScope(b)[0]).toBe(other);
  });
  test('migrates ownerless v2 ambiguous rows into editable unresolved legacy entries', () => {
    const migrated = migrateMessageQueueState({ queuedMessages: { 'session-a': [{ id: 'sending', content: 'one', createdAt: 1, status: 'sending', reconciliationStartedAt: 10, reconciliationDeadlineAt: 40, reconciliationChecks: 2 }] } });
    const repeated = migrateMessageQueueState(migrated);
    const item = migrated.queuedMessages[queueScopeKey(legacyQueueScope('session-a'))]![0]!;
    const again = repeated.queuedMessages[queueScopeKey(legacyQueueScope('session-a'))]![0]!;
    expect(item.status).toBe('unresolved'); expect(item.failure?.kind).toBe('ambiguous-dispatch'); expect(item.reconciliationStartedAt).toBe(10); expect(item.reconciliationDeadlineAt).toBe(40); expect(item.reconciliationChecks).toBe(2); expect(again).toEqual(item);
    useMessageQueueStore.setState({ queuedMessages: migrated.queuedMessages }); expect(useMessageQueueStore.getState().popToInput(legacyQueueScope('session-a'), item.queueItemID, item.operationID)?.messageID).toBe(item.messageID);
  });
  test('resolves an exhausted reconciliation into an editable queue item', () => {
    const item = mustAdd(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(a, identity); actions.markQueueItemReconciling(a, identity);
    actions.recordQueueItemReconciliationCheck(a, identity); actions.recordQueueItemReconciliationCheck(a, identity); actions.recordQueueItemReconciliationCheck(a, identity); actions.resolveQueueItemReconciliation(a, identity);
    expect(actions.getQueueForScope(a)[0]?.status).toBe('unresolved'); expect(actions.popToInput(a, item.queueItemID, item.operationID)?.queueItemID).toBe(item.queueItemID); expect(actions.getQueueForScope(a)).toEqual([]);
  });
  test('resolves a reconciliation when its persisted deadline is reached', () => {
    const item = mustAdd(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(a, identity); actions.markQueueItemReconciling(a, identity); const reconciling = actions.getQueueForScope(a)[0]!;
    const expired = { ...reconciling, reconciliationDeadlineAt: Date.now() - 1 }; useMessageQueueStore.setState({ queuedMessages: { [queueScopeKey(a)]: [expired] } }); actions.resolveQueueItemReconciliation(a, identity);
    expect(actions.getQueueForScope(a)[0]?.status).toBe('unresolved');
  });
  test('resets failed unresolved and retrying heads to a clean queued state for redispatch', () => {
    const item = mustAdd(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID }; const actions = useMessageQueueStore.getState();
    actions.markQueueItemSendAttempt(a, identity); actions.markQueueItemDefinitiveFailure(a, identity);
    actions.resetQueueItemForDispatch(a, identity);
    const reset = actions.getQueueForScope(a)[0]!;
    expect(reset.status).toBe('queued');
    expect(reset.nextAttemptAt).toBe(undefined);
    expect(reset.failure).toBe(undefined);
    actions.markQueueItemSendAttempt(a, identity); actions.markQueueItemReconciling(a, identity); actions.resolveQueueItemReconciliation(a, identity);
    actions.resetQueueItemForDispatch(a, identity);
    expect(actions.getQueueForScope(a)[0]?.status).toBe('queued');
    expect(actions.getQueueForScope(a)[0]?.reconciliationDeadlineAt).toBe(undefined);
  });
  test('atomically begins only the matching eligible head with a fresh message ID', () => {
    const first = mustAdd(); const second = mustAdd(); const actions = useMessageQueueStore.getState();
    const fresh = 'msg_ffffffffffffABCDEFGHIJKLMN';
    expect(actions.beginQueueItemDispatch(a, { queueItemID: second.queueItemID, operationID: second.operationID, messageID: second.messageID }, fresh, false)).toBeNull();
    const started = actions.beginQueueItemDispatch(a, { queueItemID: first.queueItemID, operationID: first.operationID, messageID: first.messageID }, fresh, false, Date.now());
    expect(started?.status).toBe('sending'); expect(started?.messageID).toBe(fresh); expect(started?.attemptCount).toBe(1);
    expect(actions.beginQueueItemDispatch(a, { queueItemID: first.queueItemID, operationID: first.operationID, messageID: first.messageID }, 'msg_ffffffffffffABCDEFGHIJKLMO', false)).toBeNull();
    actions.markQueueItemDefinitiveFailure(a, started!);
    expect(actions.beginQueueItemDispatch(a, { queueItemID: first.queueItemID, operationID: first.operationID, messageID: fresh }, 'msg_ffffffffffffABCDEFGHIJKLMO', true)?.status).toBe('sending');
  });
  test('manual dispatch atomically promotes a recoverable later item while automatic dispatch remains FIFO', () => {
    const first = mustAdd(); const second = mustAdd(); const actions = useMessageQueueStore.getState();
    const secondIdentity = { queueItemID: second.queueItemID, operationID: second.operationID, messageID: second.messageID };
    expect(actions.beginQueueItemDispatch(a, secondIdentity, 'msg_ffffffffffffABCDEFGHIJKLMN', false)).toBeNull();
    const started = actions.beginQueueItemDispatch(a, secondIdentity, 'msg_ffffffffffffABCDEFGHIJKLMN', true);
    expect(started?.queueItemID).toBe(second.queueItemID);
    expect(actions.getQueueForScope(a).map((item) => item.queueItemID)).toEqual([second.queueItemID, first.queueItemID]);
    actions.confirmQueueItem(a, started!);
    expect(actions.getQueueForScope(a).map((item) => item.queueItemID)).toEqual([first.queueItemID]);
  });
  test('a sending or reconciling row blocks another manual dispatch in its scope', () => {
    const first = mustAdd(); const second = mustAdd(); const actions = useMessageQueueStore.getState();
    const firstIdentity = { queueItemID: first.queueItemID, operationID: first.operationID, messageID: first.messageID };
    const fresh = 'msg_ffffffffffffABCDEFGHIJKLMN';
    actions.beginQueueItemDispatch(a, firstIdentity, fresh, true);
    expect(actions.beginQueueItemDispatch(a, { queueItemID: second.queueItemID, operationID: second.operationID, messageID: second.messageID }, 'msg_ffffffffffffABCDEFGHIJKLMO', true)).toBeNull();
    actions.markQueueItemReconciling(a, { ...firstIdentity, messageID: fresh });
    expect(actions.beginQueueItemDispatch(a, { queueItemID: second.queueItemID, operationID: second.operationID, messageID: second.messageID }, 'msg_ffffffffffffABCDEFGHIJKLMP', true)).toBeNull();
  });
  test('begins due retries automatically and persisted queued rows with a rotated ID', () => {
    const item = mustAdd(); const actions = useMessageQueueStore.getState(); const identity = { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID };
    actions.markQueueItemSendAttempt(a, identity); actions.markQueueItemPreDispatchRetry(a, identity, 20);
    expect(actions.beginQueueItemDispatch(a, identity, 'msg_ffffffffffffABCDEFGHIJKLMN', false, 19)).toBeNull();
    const retry = actions.beginQueueItemDispatch(a, identity, 'msg_ffffffffffffABCDEFGHIJKLMN', false, 20);
    expect(retry?.messageID).toBe('msg_ffffffffffffABCDEFGHIJKLMN');
  });
});
