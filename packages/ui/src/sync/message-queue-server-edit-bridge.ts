import { downloadMessageQueueAttachment, type MessageQueueItem } from '@/lib/message-queue-server';
import { parseDraftComposerDocument, parseDraftMentions, type DraftAttachmentMetadata, type DraftKey } from './input-draft-types';
import { useInputStore, type DraftCommitInput } from './input-store';
import type { MessageQueueEditResult } from './message-queue-edit-bridge';
import { getMessageQueueServerRuntime, type MessageQueueServerRuntimeCapture, type MessageQueueServerSurface } from './message-queue-server-runtime';

export type ServerQueueEditInput = { scopeID: string; scopeRevision: number; item: MessageQueueItem; targetKey: DraftKey; expectedRevision: DraftCommitInput['expectedRevision'] };
type Dependencies = { queue: Pick<MessageQueueServerSurface, 'captureRuntime' | 'reserveEdit' | 'renewEdit' | 'releaseEdit' | 'removeReserved' | 'refresh'>; input: Pick<ReturnType<typeof useInputStore.getState>, 'captureDraftRuntime' | 'commitDraftSnapshot'>; download: typeof downloadMessageQueueAttachment; current: (capture: MessageQueueServerRuntimeCapture) => boolean };
const defaults: Dependencies = { queue: getMessageQueueServerRuntime(), input: useInputStore.getState(), download: downloadMessageQueueAttachment, current: (capture) => getMessageQueueServerRuntime().captureRuntime().transportIdentity === capture.transportIdentity && getMessageQueueServerRuntime().captureRuntime().generation === capture.generation };
const diagnostic = (status: MessageQueueEditResult['status'], stage: MessageQueueEditResult['diagnostics'][number]['stage'], code: string, draftDurable = false): MessageQueueEditResult => ({ status, current: false, draftDurable, queueDurablyRemoved: false, attachmentIssues: [], diagnostics: [{ stage, code }] });
const occurrence = (value: readonly string[]): string => JSON.stringify(value);
const sameOccurrence = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
const requestID = () => `queue-edit-${crypto.randomUUID()}`;
const MAX_EDIT_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const EDIT_DOWNLOAD_CONCURRENCY = 4;

export const createMessageQueueServerEditBridge = (overrides: Partial<Dependencies> = {}) => {
  const deps = { ...defaults, ...overrides };
  const flights = new Map<string, Promise<MessageQueueEditResult>>();
  const editServerQueueItemIntoDraft = (input: ServerQueueEditInput): Promise<MessageQueueEditResult> => {
    let queueRuntime: MessageQueueServerRuntimeCapture;
    try { queueRuntime = deps.queue.captureRuntime(); } catch { return Promise.resolve(diagnostic('materialize-failed', 'identity', 'runtime-capture-failed')); }
    const key = `${queueRuntime.transportIdentity}\u0000${queueRuntime.generation}\u0000${input.scopeID}\u0000${input.item.queueItemID}`;
    const existing = flights.get(key); if (existing) return existing;
    const task = (async (): Promise<MessageQueueEditResult> => {
      const inputRuntime = deps.input.captureDraftRuntime();
      if (queueRuntime.transportIdentity !== inputRuntime.transportIdentity || queueRuntime.generation !== inputRuntime.generation || input.targetKey.transportIdentity !== queueRuntime.transportIdentity) return diagnostic('materialize-failed', 'identity', 'runtime-mismatch');
      if ((input.item.attachmentIssues?.length ?? 0) > 0) return { ...diagnostic('materialize-failed', 'attachments', 'attachment-issues'), attachmentIssues: input.item.attachmentIssues as unknown as MessageQueueEditResult['attachmentIssues'] };
      let reservation: Awaited<ReturnType<Dependencies['queue']['reserveEdit']>>;
      try { reservation = await deps.queue.reserveEdit({ requestID: requestID(), scopeID: input.scopeID, revision: input.scopeRevision, item: input.item, owner: 'ui-edit', ttlMs: 60_000, runtime: queueRuntime }); } catch { return diagnostic('materialize-failed', 'materialize', 'reserve-failed'); }
      if (!reservation) return diagnostic('materialize-failed', 'materialize', 'reserve-rejected');
      let released = false, leaseLost = false;
      const controller = new AbortController();
      let renewFlight: Promise<boolean> | undefined;
      const loseLease = () => { leaseLost = true; controller.abort(); };
      const renew = (): Promise<boolean> => {
        if (leaseLost) return Promise.resolve(false);
        if (renewFlight) return renewFlight;
        const flight = (async () => {
          try {
            const next = await deps.queue.renewEdit({ item: input.item, token: reservation.token, generation: reservation.generation, ttlMs: 60_000, runtime: queueRuntime, signal: controller.signal });
            if (!next || next.queueItemID !== input.item.queueItemID || next.token !== reservation.token || next.generation !== reservation.generation || !Number.isSafeInteger(next.expiresAt) || Date.now() >= next.expiresAt || !deps.current(queueRuntime)) { loseLease(); return false; }
            return true;
          } catch { loseLease(); return false; }
          finally { renewFlight = undefined; }
        })();
        renewFlight = flight;
        return flight;
      };
      const heartbeat = setInterval(() => { void renew(); }, 20_000);
      const release = async () => { if (released) return; released = true; try { await deps.queue.releaseEdit({ item: input.item, token: reservation.token, runtime: queueRuntime }); } catch { return; } };
      try {
        if (!deps.current(queueRuntime) || leaseLost) return diagnostic('materialize-failed', 'identity', leaseLost ? 'lease-lost' : 'runtime-stale');
        const attachments = input.item.attachments ?? [];
        if (new Set(attachments.map((attachment) => occurrence(attachment.occurrenceRefID))).size !== attachments.length) return diagnostic('materialize-failed', 'attachments', 'duplicate-occurrence');
        const attachmentBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
        if (attachmentBytes > MAX_EDIT_ATTACHMENT_BYTES) return diagnostic('materialize-failed', 'attachments', 'attachments-too-large');
        const values = new Array<{ attachment: typeof attachments[number]; blob: Blob }>(attachments.length);
        let nextAttachment = 0;
        const downloadWorker = async () => {
          while (!controller.signal.aborted) {
            const index = nextAttachment++;
            if (index >= attachments.length) return;
            const attachment = attachments[index]!;
            values[index] = { attachment, blob: await deps.download(input.item.queueItemID, attachment, controller.signal) };
          }
        };
        await Promise.all(Array.from({ length: Math.min(EDIT_DOWNLOAD_CONCURRENCY, attachments.length) }, downloadWorker));
        if (!deps.current(queueRuntime) || leaseLost) return diagnostic('materialize-failed', 'identity', leaseLost ? 'lease-lost' : 'runtime-stale');
        const draftAttachments: DraftAttachmentMetadata[] = [], draftValues = new Map<string, Blob>();
        for (let index = 0; index < attachments.length; index++) {
          const attachment = attachments[index]!, value = values[index]!;
          if (value.attachment.attachmentID !== attachment.attachmentID || !sameOccurrence(value.attachment.occurrenceRefID, attachment.occurrenceRefID) || value.blob.size !== attachment.size || value.blob.type !== attachment.mimeType) return diagnostic('materialize-failed', 'attachments', 'attachment-mismatch');
          const attachmentRefID = occurrence(attachment.occurrenceRefID);
          draftAttachments.push({ attachmentID: attachment.attachmentID, attachmentRefID, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size, locator: { kind: 'blob', blobID: attachment.attachmentID }, source: attachment.source, ...(attachment.locator.kind === 'server-path' ? { serverPath: attachment.locator.path } : {}) });
          draftValues.set(attachmentRefID, value.blob);
        }
        if (!deps.current(queueRuntime)) return diagnostic('materialize-failed', 'identity', 'runtime-stale');
        const text = input.item.composerDocument?.text ?? input.item.content;
        const composer = parseDraftComposerDocument(text, input.item.composerDocument?.references ?? []), mentions = parseDraftMentions(text, input.item.composerMentions ?? []);
        if (!composer || !mentions) return diagnostic('draft-rejected', 'draft', 'invalid-sidecars');
        if (!await renew()) return diagnostic('materialize-failed', 'identity', 'lease-lost');
        let draft;
        try { draft = await deps.input.commitDraftSnapshot({ key: input.targetKey, expectedRevision: input.expectedRevision, runtime: inputRuntime, values: draftValues, snapshot: { text, composerReferences: composer.references, attachments: draftAttachments, syntheticParts: [], mentions } }); } catch { return diagnostic('draft-rejected', 'draft', 'commit-threw'); }
        if (!draft.durable) return diagnostic('draft-rejected', 'draft', draft.status);
        if (!deps.current(queueRuntime) || leaseLost) return diagnostic('queue-retained', 'remove', leaseLost ? 'lease-lost' : 'runtime-stale', true);
        try {
          const removed = await deps.queue.removeReserved({ requestID: requestID(), scopeID: input.scopeID, revision: input.scopeRevision, item: input.item, token: reservation.token, generation: reservation.generation, runtime: queueRuntime });
          if (!removed) return diagnostic('queue-retained', 'remove', 'remove-rejected', true);
          released = true;
          return { status: 'committed', current: draft.current, draftDurable: true, queueDurablyRemoved: true, attachmentIssues: [], diagnostics: [] };
        } catch { return diagnostic('queue-retained', 'remove', 'remove-failed', true); }
      } catch { return leaseLost ? diagnostic('materialize-failed', 'identity', 'lease-lost') : diagnostic('materialize-failed', 'attachments', 'download-failed'); }
      finally { clearInterval(heartbeat); controller.abort(); await release(); }
    })();
    flights.set(key, task); void task.finally(() => { if (flights.get(key) === task) flights.delete(key); });
    return task;
  };
  return { editServerQueueItemIntoDraft };
};

const defaultBridge = createMessageQueueServerEditBridge();
export const editServerQueueItemIntoDraft = (input: ServerQueueEditInput) => defaultBridge.editServerQueueItemIntoDraft(input);
