/**
 * Cap MobileShareBridge share intake for Lynx.
 * Host injects OpenChamber share envelopes / intents; Lynx stores them and
 * POSTs Cap `…/assistants/:id/share`. No Capgo invention.
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';

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
  ack: (operationID: string) => void;
  /** Build Cap share parts (text + optional staged file URLs). Images only when mime is image/*. */
  partsFor: (envelope: LynxShareEnvelope) => LynxSharePart[];
  /** Cap `POST /api/openchamber/assistants/:id/share`. */
  dispatchToAssistant: (
    runtimeFetch: LynxRuntimeFetch | null | undefined,
    envelope: LynxShareEnvelope,
    options?: { messageID?: string },
  ) => Promise<LynxShareDispatchResult>;
};

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const validateEnvelope = (envelope: LynxShareEnvelope): string | null => {
  if (envelope.version !== 1) return 'unsupported_version';
  if (!envelope.operationID.trim()) return 'operation_id_required';
  if (!envelope.assistantID.trim()) return 'assistant_id_required';
  if (!envelope.serverInstanceID.trim()) return 'server_instance_required';
  if (envelope.attachments.length > MAX_ATTACHMENTS) return 'too_many_share_attachments';
  for (const attachment of envelope.attachments) {
    if (attachment.byteSize <= 0 || attachment.byteSize > MAX_ATTACHMENT_BYTES) {
      return 'invalid_share_attachment';
    }
  }
  return null;
};

export const createLynxShareInbox = (): LynxShareInbox => {
  const pending = new Map<string, LynxShareEnvelope>();

  const acceptEnvelope = (envelope: LynxShareEnvelope): void => {
    const error = validateEnvelope(envelope);
    if (error) throw new Error(error);
    pending.set(envelope.operationID, envelope);
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
      return { status: 'ok', operationID: envelope.operationID };
    } catch (error) {
      return {
        status: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

  return {
    listPending: () => Array.from(pending.values()),
    acceptEnvelope,
    acceptOpenChamberShareIntent,
    ack: (operationID) => { pending.delete(operationID); },
    partsFor,
    dispatchToAssistant,
  };
};
