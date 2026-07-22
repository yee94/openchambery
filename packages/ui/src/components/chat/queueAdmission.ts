import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import type { QueueAttachmentCandidate } from '@/sync/message-queue-server-attachment-adapter';
import { draftKeyString, type DraftKey } from '@/sync/input-draft-types';
import type { DraftRecord } from '@/sync/input-draft-types';
import type { InputDraftRuntimeCapture } from '@/sync/input-store';
import type { ComposerDocument } from '@/composer/document';
import { createUuid } from '@/lib/uuid';
import { ascendingId } from '@/sync/message-id';

export type QueueSendConfig = {
    providerID: string;
    modelID: string;
    agent?: string;
    variant?: string;
};

type QueueAdmissionCurrentConfig = {
    currentProviderId?: string | null;
    currentModelId?: string | null;
    currentAgentName?: string | null;
    currentVariant?: string | null;
};

type QueueAdmissionSelectionReader = {
    getSessionAgentSelection: (sessionID: string) => string | null;
    getAgentModelForSession: (sessionID: string, agentName: string) => { providerId: string; modelId: string } | null;
    getSessionModelSelection: (sessionID: string) => { providerId: string; modelId: string } | null;
    getAgentModelVariantForSession: (sessionID: string, agentName: string, providerID: string, modelID: string) => string | undefined;
};

const nonEmptyString = (value: string | null | undefined): string | undefined => value?.trim() || undefined;

export const isServerQueueAdmissionEventBlocked = (
    queueMode: 'legacy' | 'server' | 'frozen',
    hasBlockingAdmission: boolean,
    hasServerAdmissionFlight: boolean,
): boolean => hasBlockingAdmission || (queueMode !== 'legacy' && hasServerAdmissionFlight);

export type ServerQueueScopeMutationFlights = Map<string, string>;

export const startServerQueueScopeMutationFlight = <T>(
    flightRef: { current: ServerQueueScopeMutationFlights },
    scopeKey: string,
    createRequestID: () => string,
    mutate: (requestID: string) => Promise<T>,
): Promise<T> | null => {
    if (flightRef.current.has(scopeKey)) return null;
    const requestID = createRequestID();
    flightRef.current.set(scopeKey, requestID);
    let mutation: Promise<T>;
    try {
        mutation = mutate(requestID);
    } catch (error) {
        mutation = Promise.reject(error);
    }
    return mutation.finally(() => {
        if (flightRef.current.get(scopeKey) === requestID) flightRef.current.delete(scopeKey);
    });
};

export const resolveQueueSendConfig = ({
    currentConfig,
    sessionID,
    selection,
}: {
    currentConfig: QueueAdmissionCurrentConfig;
    sessionID: string | null | undefined;
    selection: QueueAdmissionSelectionReader;
}): QueueSendConfig | undefined => {
    const currentAgent = nonEmptyString(currentConfig.currentAgentName);
    const agent = sessionID ? nonEmptyString(selection.getSessionAgentSelection(sessionID)) ?? currentAgent : currentAgent;
    const agentModel = sessionID && agent ? selection.getAgentModelForSession(sessionID, agent) : null;
    const sessionModel = sessionID ? selection.getSessionModelSelection(sessionID) : null;
    const providerID = nonEmptyString(agentModel?.providerId) ?? nonEmptyString(sessionModel?.providerId) ?? nonEmptyString(currentConfig.currentProviderId);
    const modelID = nonEmptyString(agentModel?.modelId) ?? nonEmptyString(sessionModel?.modelId) ?? nonEmptyString(currentConfig.currentModelId);
    if (!providerID || !modelID) return undefined;

    const variant = sessionID && agent
        ? nonEmptyString(selection.getAgentModelVariantForSession(sessionID, agent, providerID, modelID)) ?? nonEmptyString(currentConfig.currentVariant)
        : nonEmptyString(currentConfig.currentVariant);
    return {
        providerID,
        modelID,
        ...(agent ? { agent } : {}),
        ...(variant ? { variant } : {}),
    };
};

type QueueAdmissionConsumption<TDraft> = {
    admit: () => void;
    drafts: readonly TDraft[];
    consumeDraft: (draft: TDraft) => void;
    consumeBody: () => void;
    consumeAttachments: () => void;
};

type ChatInputQueueAdmission<TDraft, TQueueItem> = Omit<QueueAdmissionConsumption<TDraft>, 'admit'> & {
    bindLegacy: () => void;
    addComposer: () => { ok: true; item: TQueueItem } | { ok: false; reason: 'invalid-composer-document' | 'invalid-composer-mentions' };
};

type ServerQueueAdmissionCapture = {
    draftKey: DraftKey;
    draftKeyID: string;
    draftRevision: number;
    draftRecord: DraftRecord | undefined;
    runtime: InputDraftRuntimeCapture;
    documentFingerprint: string;
    attachments: ReadonlyMap<string, AttachedFile>;
    inlineDrafts: ReadonlyMap<string, string>;
};

type ServerQueueAdmissionConsumption = {
    capture: ServerQueueAdmissionCapture;
    admit: () => Promise<{ status: 'committed' | 'stale' }>;
    captureRuntime: () => InputDraftRuntimeCapture;
    getCurrentDraftKey: () => DraftKey | null;
    getDraft: (key: DraftKey) => DraftRecord | undefined;
    getDocument: () => ComposerDocument;
    consumeBody: () => void;
    getAttachments: () => readonly AttachedFile[];
    removeAttachment: (id: string) => void;
    getInlineDrafts: () => readonly InlineCommentDraft[];
    removeInlineDraft: (id: string) => void;
};

export type ServerQueueAdmissionConsumptionResult = {
    status: 'committed' | 'stale';
    bodyConsumed: boolean;
    attachmentIDsConsumed: string[];
    inlineDraftIDsConsumed: string[];
};

const sameRuntime = (left: InputDraftRuntimeCapture, right: InputDraftRuntimeCapture): boolean => left.transportIdentity === right.transportIdentity && left.generation === right.generation;
const documentFingerprint = (document: ComposerDocument): string => JSON.stringify([document.text, document.references]);
const inlineDraftFingerprint = (draft: InlineCommentDraft): string => JSON.stringify(draft);
const sameAttachmentOccurrence = (captured: AttachedFile, current: AttachedFile): boolean => captured.id === current.id
    && captured.file === current.file
    && captured.dataUrl === current.dataUrl
    && captured.mimeType === current.mimeType
    && captured.filename === current.filename
    && captured.size === current.size
    && captured.source === current.source
    && captured.serverPath === current.serverPath
    && captured.vscodePath === current.vscodePath
    && captured.vscodeSource === current.vscodeSource;

export const admitQueueMessageAndConsumeResources = <TDraft>({
    admit,
    drafts,
    consumeDraft,
    consumeBody,
    consumeAttachments,
}: QueueAdmissionConsumption<TDraft>): void => {
    admit();
    for (const draft of drafts) {
        consumeDraft(draft);
    }
    consumeBody();
    consumeAttachments();
};

export const admitChatInputQueueMessageAndConsumeResources = <TDraft, TQueueItem>({
    bindLegacy,
    addComposer,
    drafts,
    consumeDraft,
    consumeBody,
    consumeAttachments,
}: ChatInputQueueAdmission<TDraft, TQueueItem>): { ok: true; item: TQueueItem } | { ok: false; reason: 'invalid-composer-document' | 'invalid-composer-mentions' } => {
    const result = addComposer();
    if (!result.ok) return result;
    bindLegacy();
    admitQueueMessageAndConsumeResources({
        admit: () => {},
        drafts,
        consumeDraft,
        consumeBody,
        consumeAttachments,
    });
    return result;
};

export const createServerQueueAdmissionCapture = ({
    draftKey,
    draftRecord,
    runtime,
    document,
    attachments,
    inlineDrafts,
}: {
    draftKey: DraftKey;
    draftRecord: DraftRecord | undefined;
    runtime: InputDraftRuntimeCapture;
    document: ComposerDocument;
    attachments: readonly AttachedFile[];
    inlineDrafts: readonly InlineCommentDraft[];
}): ServerQueueAdmissionCapture => ({
    draftKey: { transportIdentity: draftKey.transportIdentity, owner: { ...draftKey.owner } },
    draftKeyID: draftKeyString(draftKey),
    draftRevision: draftRecord?.revision ?? 0,
    draftRecord,
    runtime: { ...runtime },
    documentFingerprint: documentFingerprint(document),
    attachments: new Map(attachments.map((attachment) => [attachment.id, attachment])),
    inlineDrafts: new Map(inlineDrafts.map((draft) => [draft.id, inlineDraftFingerprint(draft)])),
});

export const admitServerQueueMessageAndConsumeResources = async ({
    capture,
    admit,
    captureRuntime,
    getCurrentDraftKey,
    getDraft,
    getDocument,
    consumeBody,
    getAttachments,
    removeAttachment,
    getInlineDrafts,
    removeInlineDraft,
}: ServerQueueAdmissionConsumption): Promise<ServerQueueAdmissionConsumptionResult> => {
    const admission = await admit();
    const currentKey = getCurrentDraftKey();
    if (admission.status !== 'committed' || !sameRuntime(capture.runtime, captureRuntime()) || !currentKey || draftKeyString(currentKey) !== capture.draftKeyID) {
        return { status: 'stale', bodyConsumed: false, attachmentIDsConsumed: [], inlineDraftIDsConsumed: [] };
    }

    const currentDraft = getDraft(capture.draftKey);
    const bodyConsumed = currentDraft === capture.draftRecord
        && (currentDraft?.revision ?? 0) === capture.draftRevision
        && documentFingerprint(getDocument()) === capture.documentFingerprint;
    if (bodyConsumed) consumeBody();

    const attachmentIDsConsumed: string[] = [];
    const currentAttachments = new Map(getAttachments().map((attachment) => [attachment.id, attachment]));
    for (const [id, captured] of capture.attachments) {
        const current = currentAttachments.get(id);
        if (!current || !sameAttachmentOccurrence(captured, current)) continue;
        removeAttachment(id);
        attachmentIDsConsumed.push(id);
    }

    const inlineDraftIDsConsumed: string[] = [];
    const currentInlineDrafts = new Map(getInlineDrafts().map((draft) => [draft.id, draft]));
    for (const [id, fingerprint] of capture.inlineDrafts) {
        const current = currentInlineDrafts.get(id);
        if (!current || inlineDraftFingerprint(current) !== fingerprint) continue;
        removeInlineDraft(id);
        inlineDraftIDsConsumed.push(id);
    }

    return { status: 'committed', bodyConsumed, attachmentIDsConsumed, inlineDraftIDsConsumed };
};

export const attachedFilesToQueueCandidates = (files: readonly AttachedFile[]): QueueAttachmentCandidate[] => files.map((file) => {
    const mimeType = file.mimeType || file.file.type || 'application/octet-stream';
    if (file.source === 'server') {
        if (!file.serverPath) throw new Error('message-queue-server-attachment-unavailable');
        return { attachmentID: file.id, occurrenceRefID: ['root', file.id], filename: file.filename || file.file.name, mimeType, source: 'server', path: file.serverPath, size: file.size };
    }
    if (file.source === 'vscode') throw new Error('message-queue-vscode-attachment-unsupported');
    return {
        attachmentID: file.id,
        occurrenceRefID: ['root', file.id],
        filename: file.filename || file.file.name,
        mimeType,
        source: 'local',
        value: file.file.slice(0, file.file.size, mimeType),
    };
});

export const createServerQueueAdmissionIdentity = (
    createID: () => string = createUuid,
    createMessageID: () => string = () => ascendingId('msg'),
    createdAt = Date.now(),
) => ({
    requestID: createID(),
    queueItemID: `queued-${createID()}`,
    operationID: `operation-${createID()}`,
    messageID: createMessageID(),
    createdAt,
});
