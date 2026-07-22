import { admitTextQueueItem, createMessageQueueImport, fetchMessageQueueImportDetails, stageMessageQueueImport, sealMessageQueueImport, type MessageQueueAdmissionItem, type MessageQueueAttachment } from '@/lib/message-queue-server';
import { uploadQueueAttachments } from './message-queue-server-attachment-adapter';
import type { MessageQueueRuntime } from './message-queue-runtime';
import { queueLedgerScopeKey, type QueueItemDTO } from '@/stores/message-queue-ledger';

export type MessageQueueShadowImportStatus = 'idle' | 'pending' | 'complete' | 'degraded' | 'error';
export type MessageQueueShadowImportState = { status: MessageQueueShadowImportStatus; imported: number; total: number; issues: readonly string[]; canActivate: boolean; importID?: string; manifestHash?: string; activationEpoch?: number };
export type MessageQueueShadowImportCapture = { transportIdentity: string; generation: number };
export type MessageQueueShadowImporter = { run: (signal?: AbortSignal) => Promise<MessageQueueShadowImportState> };
type Existing = { queueItemID: string; operationID: string; messageID: string };
type Dependencies = { queue: MessageQueueRuntime; capture: () => MessageQueueShadowImportCapture; current: (capture: MessageQueueShadowImportCapture) => boolean; kind?: 'activation' | 'late'; authorityGeneration?: () => number; admit?: typeof admitTextQueueItem; create?: typeof createMessageQueueImport; details?: typeof fetchMessageQueueImportDetails; stage?: typeof stageMessageQueueImport; seal?: typeof sealMessageQueueImport; upload: typeof uploadQueueAttachments; resolveURL: (url: string, signal: AbortSignal) => Promise<Blob>; existing: () => readonly Existing[]; refresh: () => Promise<void>; publish: (state: MessageQueueShadowImportState) => void };
const deviceClientID = () => { const key = 'openchamber:message-queue-import-client-id'; try { const storage = globalThis.localStorage; const existing = storage.getItem(key); if (existing) return existing; const created = crypto.randomUUID(); storage.setItem(key, created); return created; } catch { return 'memory-client'; } };
const defaults = { queue: undefined as unknown as MessageQueueRuntime, capture: () => ({ transportIdentity: '', generation: 0 }), current: () => true, admit: admitTextQueueItem, create: createMessageQueueImport, details: fetchMessageQueueImportDetails, stage: stageMessageQueueImport, seal: sealMessageQueueImport, upload: uploadQueueAttachments, resolveURL: async (url: string, signal: AbortSignal) => { const parsed = new URL(url); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('durable-url-scheme'); const response = await fetch(url, { signal }); if (!response.ok) throw new Error('durable-url-unavailable'); return response.blob(); }, existing: () => [], refresh: async () => {}, publish: () => {} } satisfies Dependencies;
const identity = (item: QueueItemDTO) => ({ scopeKey: queueLedgerScopeKey(item.owner), queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID });
const requestID = async (operationID: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationID)));
  return `shadow-import:${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};
const migrationState = (item: QueueItemDTO): NonNullable<MessageQueueAdmissionItem['migrationState']> => ({ status: item.status === 'sending' ? 'reconciling' : item.status, attemptCount: item.attemptCount, ...(item.nextAttemptAt === undefined ? {} : { dueAt: item.nextAttemptAt }), ...(item.reconciliationStartedAt === undefined ? {} : { reconciliationStartedAt: item.reconciliationStartedAt }), ...(item.reconciliationDeadlineAt === undefined ? {} : { reconciliationDeadlineAt: item.reconciliationDeadlineAt }), ...(item.reconciliationChecks === undefined ? {} : { reconciliationChecks: item.reconciliationChecks }), ...(item.reconciliationNextCheckAt === undefined ? {} : { reconciliationNextCheckAt: item.reconciliationNextCheckAt }), ...(item.failureKind === undefined ? {} : { failureKind: item.failureKind }) });
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
const digest = async (value: unknown) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value))))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const createMessageQueueShadowImporter = (overrides: Partial<Dependencies>): MessageQueueShadowImporter => {
  const deps = { ...defaults, ...overrides };
  const useStaging = overrides.create !== undefined || overrides.stage !== undefined || overrides.seal !== undefined || overrides.admit === undefined;
  const report = (state: MessageQueueShadowImportState) => { deps.publish(state); return state; };
  return { run: async (providedSignal) => {
    const capture = deps.capture(), controller = new AbortController(), signal = providedSignal ?? controller.signal;
    const hydrated = await deps.queue.hydrate();
    if (!deps.current(capture)) return report({ status: 'pending', imported: 0, total: 0, issues: ['runtime-stale'], canActivate: false });
    const state = deps.queue.getState();
    if (hydrated.status === 'recovery-required' || state.hydration === 'recovery-required' || state.snapshot.migration.v3State === 'degraded') return report({ status: 'degraded', imported: 0, total: 0, issues: ['recovery-required'], canActivate: false });
    if (state.hydration !== 'ready') return report({ status: 'error', imported: 0, total: 0, issues: ['hydrate-failed'], canActivate: false });
    const bound = Object.entries(state.snapshot.queues).sort(([left], [right]) => left.localeCompare(right)).flatMap(([, items]) => items).filter((item): item is QueueItemDTO & { owner: Extract<QueueItemDTO['owner'], { state: 'bound' }> } => item.owner.state === 'bound' && item.owner.transportIdentity === capture.transportIdentity);
    const queueCapture = deps.queue.captureRuntime();
    const unbound = Object.values(state.snapshot.queues).flat().some((item) => item.owner.state !== 'bound');
    let imported = 0;
    let phase = 'prepare';
    try {
      const prepared: Array<{ item: typeof bound[number]; scopeOrdinal: number; itemOrdinal: number; payload: { scope: { directory: string; sessionID: string }; item: MessageQueueAdmissionItem }; payloadHash: string }> = [];
      const scopeOrdinals = new Map<string, number>();
      for (const item of bound) {
        if (!deps.current(capture) || signal.aborted) return report({ status: 'pending', imported, total: bound.length, issues: ['runtime-stale'], canActivate: false });
        const matching = deps.existing().filter((entry) => entry.queueItemID === item.queueItemID || entry.operationID === item.operationID || entry.messageID === item.messageID);
        if (matching.length) { if (!matching.some((entry) => entry.queueItemID === item.queueItemID && entry.operationID === item.operationID && entry.messageID === item.messageID)) return report({ status: 'degraded', imported, total: bound.length, issues: ['cross-id-conflict'], canActivate: false }); imported++; continue; }
        if (item.attachments.some((attachment) => attachment.source === 'vscode')) return report({ status: 'degraded', imported, total: bound.length, issues: ['vscode-attachment'], canActivate: false });
        const owner = item.owner;
        if (owner.state !== 'bound') return report({ status: 'pending', imported, total: bound.length, issues: ['unbound-legacy'], canActivate: false });
        phase = 'acquire'; const acquired = await deps.queue.acquireSendPayload(identity(item), queueCapture);
        if (acquired.status !== 'committed' || !acquired.token) return report({ status: 'degraded', imported, total: bound.length, issues: ['payload-unavailable'], canActivate: false });
        try {
          const values = new Map(acquired.values?.map((entry) => [entry.attachment.occurrenceRefID, entry.value]));
          const attachments: MessageQueueAttachment[] = [];
          for (const attachment of item.attachments) {
            const occurrenceRefID = JSON.parse(attachment.occurrenceRefID) as MessageQueueAttachment['occurrenceRefID'];
            if (attachment.source === 'server' && attachment.serverPath) { attachments.push({ attachmentID: attachment.attachmentID, occurrenceRefID, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size, source: 'server', locator: { kind: 'server-path', path: attachment.serverPath } }); continue; }
            const acquiredValue = values.get(attachment.occurrenceRefID);
            const value = typeof acquiredValue === 'string' ? await deps.resolveURL(acquiredValue, signal) : acquiredValue ?? (attachment.locator.kind === 'url' ? await deps.resolveURL(attachment.locator.url, signal) : undefined);
            if (!value || typeof value !== 'object' || typeof (value as Blob).arrayBuffer !== 'function' || (value as Blob).size !== attachment.size || ((value as Blob).type && (value as Blob).type !== attachment.mimeType)) return report({ status: 'degraded', imported, total: bound.length, issues: ['attachment-bytes-unavailable'], canActivate: false });
            phase = 'upload'; const uploaded = await deps.upload([{ attachmentID: attachment.attachmentID, occurrenceRefID, filename: attachment.filename, mimeType: attachment.mimeType, source: 'local', value: value as Blob }], signal);
            attachments.push(uploaded.attachments[0]!);
          }
          const scopeKey = `${owner.directory}\u0000${owner.sessionID}`, scopeOrdinal = scopeOrdinals.get(scopeKey) ?? scopeOrdinals.size; scopeOrdinals.set(scopeKey, scopeOrdinal);
          const itemOrdinal = prepared.filter((entry) => entry.scopeOrdinal === scopeOrdinal).length;
          const payload = { scope: { directory: owner.directory, sessionID: owner.sessionID }, item: { queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID, content: item.content, ...(item.composerDocument ? { composerDocument: item.composerDocument } : {}), ...(item.composerMentions ? { composerMentions: item.composerMentions } : {}), ...(item.sendConfig ? { sendConfig: item.sendConfig } : {}), attachments, attachmentIssues: item.attachmentIssues, createdAt: item.createdAt, migrationImport: true, migrationState: migrationState(item) } };
          if (!useStaging) { phase = 'admit'; await deps.admit!({ requestID: await requestID(item.operationID), ...payload, signal }); }
          prepared.push({ item, scopeOrdinal, itemOrdinal, payload, payloadHash: await digest(payload) });
          imported++;
        } finally { await deps.queue.releaseSend(identity(item), acquired.token, queueCapture); }
      }
      if (!useStaging) { phase = 'refresh'; await deps.refresh(); const complete = bound.every((item) => deps.existing().some((entry) => entry.queueItemID === item.queueItemID && entry.operationID === item.operationID && entry.messageID === item.messageID)); return report({ status: unbound ? 'pending' : complete ? 'complete' : 'error', imported, total: bound.length, issues: unbound ? ['unbound-legacy'] : complete ? [] : ['catalog-incomplete'], canActivate: complete && !unbound }); }
      const snapshotHash = await digest(prepared.map(({ item, scopeOrdinal, itemOrdinal }) => ({ scopeOrdinal, itemOrdinal, owner: item.owner, queueItemID: item.queueItemID, operationID: item.operationID, messageID: item.messageID, content: item.content, composerDocument: item.composerDocument, composerMentions: item.composerMentions, sendConfig: item.sendConfig, attachments: item.attachments.map(({ attachmentID, occurrenceRefID, filename, mimeType, size, source, serverPath }) => ({ attachmentID, occurrenceRefID, filename, mimeType, size, source, serverPath })), attachmentIssues: item.attachmentIssues, createdAt: item.createdAt, status: item.status, attemptCount: item.attemptCount })));
      phase = 'create'; const created = await deps.create!({ requestID: `shadow-create:${deps.kind ?? 'activation'}:${snapshotHash}`, kind: deps.kind ?? 'activation', clientID: deviceClientID(), snapshotHash, itemCount: prepared.length, protocol: 4, expectedGeneration: deps.authorityGeneration?.() ?? capture.generation, signal });
      if (created.state === 'committed') return report({ status: unbound ? 'pending' : 'complete', imported, total: bound.length, issues: unbound ? ['unbound-legacy'] : [], canActivate: !unbound, importID: created.importID, manifestHash: created.manifestHash, activationEpoch: created.commit?.activationEpoch });
      const details = await deps.details!(created.importID, signal); if (details.state === 'committed') return report({ status: unbound ? 'pending' : 'complete', imported, total: bound.length, issues: unbound ? ['unbound-legacy'] : [], canActivate: !unbound, importID: created.importID, manifestHash: details.manifestHash, activationEpoch: details.commit?.activationEpoch });
      const staged = new Set(details.staged.map((entry) => `${entry.scopeOrdinal}:${entry.itemOrdinal}`));
      phase = 'stage'; if (details.state === 'staging') for (const entry of prepared) { if (staged.has(`${entry.scopeOrdinal}:${entry.itemOrdinal}`)) continue; if (!deps.current(capture)) return report({ status: 'pending', imported, total: bound.length, issues: ['runtime-stale'], canActivate: false }); await deps.stage!(created.importID, { requestID: `shadow-stage:${created.importID}:${entry.scopeOrdinal}:${entry.itemOrdinal}:${entry.payloadHash}`, scopeOrdinal: entry.scopeOrdinal, itemOrdinal: entry.itemOrdinal, payload: entry.payload, payloadHash: entry.payloadHash, signal }); }
      phase = 'seal'; const sealed = details.state === 'sealed' ? { manifestHash: details.manifestHash! } : await deps.seal!(created.importID, { requestID: `shadow-seal:${created.importID}:${snapshotHash}`, signal });
      return report({ status: unbound ? 'pending' : 'complete', imported, total: bound.length, issues: unbound ? ['unbound-legacy'] : [], canActivate: !unbound, importID: created.importID, manifestHash: sealed.manifestHash });
    } catch { return report({ status: 'error', imported, total: bound.length, issues: [`shadow-${phase}-failed`], canActivate: false }); }
  } };
};
