/**
 * Cap MobileShareBridge share intake for Lynx.
 * Host injects OpenChamber share envelopes / intents / Android share drafts;
 * Lynx stores them and POSTs Cap `…/assistants/:id/share`. No Capgo invention.
 *
 * Envelopes require assistantID. Android generic-share drafts may omit target
 * until the full-page recipient picker assigns exact instance+assistant.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  isAssignedLynxShareDraft,
  type AssignedLynxShareDraft,
  type LynxShareDraft,
} from './shareDraft';

export type LynxShareAttachment = {
  stagedPath: string;
  originalName: string;
  mime: string;
  byteSize: number;
};

export type LynxShareEnvelope = {
  version: 1;
  operationID: string;
  serverInstanceID: string;
  assistantID: string;
  text?: string;
  attachments: LynxShareAttachment[];
  source: 'ios-share' | 'android-share' | 'openchamber-intent';
  createdAt: number;
  expiresAt: number;
};

export type LynxSharePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string };

export type LynxShareDispatchResult =
  | { status: 'ok'; operationID: string }
  | { status: 'no-runtime' }
  | { status: 'empty' }
  | { status: 'expired' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxShareInbox = {
  listPending: () => LynxShareEnvelope[];
  /** Host injects a native share envelope (Cap OpenChamberShare.listPending shape). */
  acceptEnvelope: (envelope: LynxShareEnvelope) => void;
  /** Host injects openchamber share intent payload into Assistant session path. */
  acceptOpenChamberShareIntent: (input: {
    operationID: string;
    serverInstanceID: string;
    assistantID: string;
    text?: string;
    attachments?: LynxShareAttachment[];
    expiresAt?: number;
  }) => LynxShareEnvelope;
  /** Host injects Android share draft (may be unassigned until picker). */
  acceptDraft: (draft: LynxShareDraft) => void;
  listDrafts: () => LynxShareDraft[];
  listUnassignedDrafts: () => LynxShareDraft[];
  /** Drop/ack a draft without inventing dispatch success. */
  cancelDraft: (draftID: string) => void;
  /** Replace a draft after recipient assignment (exact instance+assistant). */
  putAssignedDraft: (draft: AssignedLynxShareDraft) => void;
  ack: (operationID: string) => void;
  /** Build Cap share parts (text + optional staged file URLs). Images only when mime is image/*. */
  partsFor: (envelope: LynxShareEnvelope) => LynxSharePart[];
  /** Cap `POST /api/openchamber/assistants/:id/share`. */
  dispatchToAssistant: (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    envelope: LynxShareEnvelope,
    options?: { messageID?: string },
  ) => Promise<LynxShareDispatchResult>;
  /**
   * Cap/Expo assigned-draft deliver: envelope POST then drop draft.
   * Failure does not invent success (draft remains until cancel/success).
   */
  dispatchAssignedDraft: (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    draft: AssignedLynxShareDraft,
    options?: { messageID?: string },
  ) => Promise<LynxShareDispatchResult>;
  subscribe: (listener: () => void) => () => void;
  getRevision: () => number;
};

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const validateAttachments = (attachments: LynxShareAttachment[]): string | null => {
  if (attachments.length > MAX_ATTACHMENTS) return 'too_many_share_attachments';
  for (const attachment of attachments) {
    if (attachment.byteSize <= 0 || attachment.byteSize > MAX_ATTACHMENT_BYTES) {
      return 'invalid_share_attachment';
    }
  }
  return null;
};

const validateEnvelope = (envelope: LynxShareEnvelope): string | null => {
  if (envelope.version !== 1) return 'unsupported_version';
  if (!envelope.operationID.trim()) return 'operation_id_required';
  if (!envelope.assistantID.trim()) return 'assistant_id_required';
  if (!envelope.serverInstanceID.trim()) return 'server_instance_required';
  return validateAttachments(envelope.attachments);
};

const validateDraft = (draft: LynxShareDraft): string | null => {
  if (draft.version !== 1) return 'unsupported_version';
  if (!draft.draftID.trim()) return 'draft_id_required';
  if (draft.source !== 'android-share') return 'unsupported_source';
  return validateAttachments(draft.attachments);
};

/** Convert assigned draft → Cap envelope for assistants share POST. */
export const assignedLynxShareDraftToEnvelope = (
  draft: AssignedLynxShareDraft,
): LynxShareEnvelope => ({
  version: 1,
  operationID: draft.draftID,
  serverInstanceID: draft.serverInstanceID,
  assistantID: draft.assistantID,
  text: draft.text,
  attachments: draft.attachments,
  source: 'android-share',
  createdAt: draft.createdAt,
  expiresAt: draft.expiresAt,
});

export const createLynxShareInbox = (): LynxShareInbox => {
  const pending = new Map<string, LynxShareEnvelope>();
  const drafts = new Map<string, LynxShareDraft>();
  const listeners = new Set<() => void>();
  let revision = 0;

  const bump = (): void => {
    revision += 1;
    listeners.forEach((listener) => listener());
  };

  const acceptEnvelope = (envelope: LynxShareEnvelope): void => {
    const error = validateEnvelope(envelope);
    if (error) throw new Error(error);
    pending.set(envelope.operationID, envelope);
    bump();
  };

  const acceptOpenChamberShareIntent = (input: {
    operationID: string;
    serverInstanceID: string;
    assistantID: string;
    text?: string;
    attachments?: LynxShareAttachment[];
    expiresAt?: number;
  }): LynxShareEnvelope => {
    const now = Date.now();
    const envelope: LynxShareEnvelope = {
      version: 1,
      operationID: input.operationID.trim(),
      serverInstanceID: input.serverInstanceID.trim(),
      assistantID: input.assistantID.trim(),
      text: input.text,
      attachments: input.attachments ?? [],
      source: 'openchamber-intent',
      createdAt: now,
      expiresAt: input.expiresAt ?? now + 15 * 60_000,
    };
    acceptEnvelope(envelope);
    return envelope;
  };

  const acceptDraft = (draft: LynxShareDraft): void => {
    const error = validateDraft(draft);
    if (error) throw new Error(error);
    drafts.set(draft.draftID, draft);
    bump();
  };

  const putAssignedDraft = (draft: AssignedLynxShareDraft): void => {
    if (!isAssignedLynxShareDraft(draft)) throw new Error('draft_target_required');
    const error = validateDraft(draft);
    if (error) throw new Error(error);
    drafts.set(draft.draftID, draft);
    bump();
  };

  const cancelDraft = (draftID: string): void => {
    const removedDraft = drafts.delete(draftID);
    // Assigned-draft retries may have admitted a pending envelope under the same id.
    const removedPending = pending.delete(draftID);
    if (!removedDraft && !removedPending) return;
    bump();
  };

  const partsFor = (envelope: LynxShareEnvelope): LynxSharePart[] => {
    const parts: LynxSharePart[] = [];
    if (envelope.text?.trim()) {
      parts.push({ type: 'text', text: envelope.text });
    }
    for (const attachment of envelope.attachments) {
      if (!attachment.mime.startsWith('image/')) {
        throw new Error('unsupported_share_attachment');
      }
      const staged = attachment.stagedPath.trim();
      if (!staged) throw new Error('staged_file_unavailable');
      const url = /^(?:data:|https?:|content:|file:)/i.test(staged)
        ? staged
        : `file://${staged}`;
      parts.push({ type: 'file', mime: attachment.mime, url });
    }
    if (parts.length === 0) throw new Error('empty_share');
    return parts;
  };

  const dispatchToAssistant = async (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    envelope: LynxShareEnvelope,
    options?: { messageID?: string },
  ): Promise<LynxShareDispatchResult> => {
    if (!runtimeFetch) return { status: 'no-runtime' };
    if (Date.now() > envelope.expiresAt) return { status: 'expired' };
    let parts: LynxSharePart[];
    try {
      parts = partsFor(envelope);
    } catch (error) {
      if (error instanceof Error && error.message === 'empty_share') {
        return { status: 'empty' };
      }
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    const messageID = options?.messageID?.trim()
      || `share_${envelope.operationID}`;
    try {
      const response = await runtimeFetch(
        `/api/openchamber/assistants/${encodeURIComponent(envelope.assistantID)}/share`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            operationID: envelope.operationID,
            payload: {
              messageID,
              parts,
              source: envelope.source === 'openchamber-intent'
                ? 'ios-share'
                : envelope.source,
            },
          }),
        },
      );
      if (response.status === 0) return { status: 'no-runtime' };
      if (!response.ok) {
        const body = asRecord(await response.json().catch(() => null));
        const message = typeof body.error === 'string' && body.error.trim()
          ? body.error.trim()
          : `assistant share failed (${response.status})`;
        return { status: 'failed', error: new Error(message), httpStatus: response.status };
      }
      pending.delete(envelope.operationID);
      bump();
      return { status: 'ok', operationID: envelope.operationID };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  const dispatchAssignedDraft = async (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    draft: AssignedLynxShareDraft,
    options?: { messageID?: string },
  ): Promise<LynxShareDispatchResult> => {
    if (!isAssignedLynxShareDraft(draft)) {
      return { status: 'failed', error: new Error('draft_target_required') };
    }
    const envelope = assignedLynxShareDraftToEnvelope(draft);
    // Ensure envelope path can ack after success even if host only stored the draft.
    if (!pending.has(envelope.operationID)) {
      try {
        acceptEnvelope(envelope);
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
    const result = await dispatchToAssistant(runtimeFetch, envelope, options);
    if (result.status === 'ok') {
      drafts.delete(draft.draftID);
      bump();
    }
    return result;
  };

  return {
    listPending: () => Array.from(pending.values()),
    acceptEnvelope,
    acceptOpenChamberShareIntent,
    acceptDraft,
    listDrafts: () => Array.from(drafts.values()),
    listUnassignedDrafts: () => Array.from(drafts.values()).filter((draft) => !isAssignedLynxShareDraft(draft)),
    cancelDraft,
    putAssignedDraft,
    ack: (operationID) => {
      if (!pending.delete(operationID)) return;
      bump();
    },
    partsFor,
    dispatchToAssistant,
    dispatchAssignedDraft,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getRevision: () => revision,
  };
};
