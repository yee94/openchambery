/**
 * Assistant contact attachment upload (raw bytes via runtimeFetch).
 *
 * PUT /api/openchamber/assistants/:id/contact/attachments/:uploadID
 * Headers: X-Content-SHA256, X-Content-Size, Content-Type, X-Attachment-Filename
 *
 * Response must be a complete server JSON descriptor — empty/HTML/204/partial bodies fail closed.
 */
import { runtimeFetch } from '@/lib/runtime-fetch';

/** Hard cap for a single assistant contact attachment upload (25 MiB). */
export const ASSISTANT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Frozen structural descriptor stored in the assistant contact DB after upload.
 * UI never invents a second attachment store — this is the durable reference.
 */
export type AssistantAttachmentDescriptor = {
  type: 'file';
  attachmentID: string;
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
};

export class AssistantAttachmentUploadError extends Error {
  readonly status: number;
  readonly code: 'unavailable' | 'too-large' | 'rejected' | 'integrity';

  constructor(
    status: number,
    code: AssistantAttachmentUploadError['code'],
    message = 'Failed to upload assistant attachment',
  ) {
    super(message);
    this.name = 'AssistantAttachmentUploadError';
    this.status = status;
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hexFromBuffer = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const digestSha256Hex = async (value: Blob | ArrayBuffer | Uint8Array): Promise<string> => {
  let bytes: ArrayBuffer;
  if (value instanceof ArrayBuffer) {
    bytes = value;
  } else if (ArrayBuffer.isView(value)) {
    const view = value as Uint8Array;
    bytes = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  } else {
    bytes = await value.arrayBuffer();
  }
  return hexFromBuffer(await crypto.subtle.digest('SHA-256', bytes));
};

const normalizeMime = (value: string | null | undefined): string => {
  const raw = typeof value === 'string' ? value.split(';')[0]?.trim().toLowerCase() : '';
  return raw;
};

const assertSafeIntegerSize = (size: number): void => {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new AssistantAttachmentUploadError(0, 'rejected', 'Invalid attachment size');
  }
  if (size > ASSISTANT_ATTACHMENT_MAX_BYTES) {
    throw new AssistantAttachmentUploadError(413, 'too-large');
  }
};

/**
 * Parse a complete server descriptor. No local fallbacks for missing fields.
 * Expected payload fields: type:'file', attachmentID, sha256, size, mime, filename?
 * @param options.enforceUploadLimit when true (upload path), reject size > 25 MiB
 */
export const parseAssistantAttachmentDescriptor = (
  payload: unknown,
  expected?: { sha256: string; size: number; mime: string },
  options: { enforceUploadLimit?: boolean } = {},
): AssistantAttachmentDescriptor => {
  if (!isRecord(payload)) {
    throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment response was not a JSON object');
  }
  if (payload.type !== 'file') {
    throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment response type must be file');
  }
  const attachmentID = typeof payload.attachmentID === 'string' ? payload.attachmentID.trim() : '';
  const sha256 = typeof payload.sha256 === 'string' ? payload.sha256.trim().toLowerCase() : '';
  const size = typeof payload.size === 'number' && Number.isSafeInteger(payload.size) ? payload.size : NaN;
  const mime = normalizeMime(typeof payload.mime === 'string' ? payload.mime : '');
  const filename = typeof payload.filename === 'string' && payload.filename.trim()
    ? payload.filename.trim()
    : undefined;

  if (!attachmentID) {
    throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment response missing attachmentID');
  }
  if (!/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment response missing sha256');
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment response missing size');
  }
  if (!mime) {
    throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment response missing mime');
  }
  // Upload responses always enforce the 25 MiB cap; type-guard parsing does not.
  if (options.enforceUploadLimit === true || expected) {
    assertSafeIntegerSize(size);
  }

  if (expected) {
    if (sha256 !== expected.sha256.toLowerCase()) {
      throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment SHA-256 mismatch');
    }
    if (size !== expected.size) {
      throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment size mismatch');
    }
    if (mime !== expected.mime) {
      throw new AssistantAttachmentUploadError(0, 'integrity', 'Attachment mime mismatch');
    }
  }

  return {
    type: 'file',
    attachmentID,
    sha256,
    size,
    mime,
    ...(filename ? { filename } : {}),
  };
};

/**
 * Upload raw attachment bytes for an assistant contact.
 * Requires a complete JSON descriptor from the server; empty/HTML/204 fail closed.
 */
export const uploadAssistantAttachment = async (
  assistantID: string,
  file: File,
  uploadID: string,
  signal?: AbortSignal,
): Promise<AssistantAttachmentDescriptor> => {
  const id = typeof assistantID === 'string' ? assistantID.trim() : '';
  const upload = typeof uploadID === 'string' ? uploadID.trim() : '';
  if (!id || !upload) {
    throw new AssistantAttachmentUploadError(0, 'rejected', 'assistantID and uploadID are required');
  }
  if (!(file instanceof Blob)) {
    throw new AssistantAttachmentUploadError(0, 'rejected', 'file must be a File or Blob');
  }

  const mime = normalizeMime(file.type || (file as File).type) || 'application/octet-stream';
  const body = file.type === mime ? file : new Blob([file], { type: mime });
  assertSafeIntegerSize(body.size);

  const sha256 = await digestSha256Hex(body);
  const filename = typeof (file as File).name === 'string' && (file as File).name.trim()
    ? (file as File).name.trim()
    : undefined;

  let response: Response;
  try {
    response = await runtimeFetch(
      `/api/openchamber/assistants/${encodeURIComponent(id)}/contact/attachments/${encodeURIComponent(upload)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': mime,
          'X-Content-SHA256': sha256,
          'X-Content-Size': String(body.size),
          ...(filename ? { 'X-Attachment-Filename': encodeURIComponent(filename) } : {}),
        },
        body,
        signal,
      },
    );
  } catch {
    throw new AssistantAttachmentUploadError(0, 'unavailable');
  }

  if (response.status === 204 || response.status === 205) {
    throw new AssistantAttachmentUploadError(response.status, 'integrity', 'Attachment upload returned empty status');
  }
  if (response.status === 413) {
    throw new AssistantAttachmentUploadError(413, 'too-large');
  }
  if (!response.ok) {
    throw new AssistantAttachmentUploadError(
      response.status,
      response.status >= 500 || response.status === 0 ? 'unavailable' : 'rejected',
    );
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html') || contentType.includes('text/plain')) {
    throw new AssistantAttachmentUploadError(response.status, 'integrity', 'Attachment upload returned non-JSON body');
  }

  let payload: unknown;
  try {
    const text = await response.text();
    if (!text.trim()) {
      throw new AssistantAttachmentUploadError(response.status, 'integrity', 'Attachment upload returned empty body');
    }
    if (!contentType.includes('application/json') && !text.trim().startsWith('{')) {
      throw new AssistantAttachmentUploadError(response.status, 'integrity', 'Attachment upload returned non-JSON body');
    }
    payload = JSON.parse(text);
  } catch (error) {
    if (error instanceof AssistantAttachmentUploadError) throw error;
    throw new AssistantAttachmentUploadError(response.status, 'integrity', 'Attachment upload response was not valid JSON');
  }

  return parseAssistantAttachmentDescriptor(payload, { sha256, size: body.size, mime });
};

/** Type guard for frozen descriptors (DB / network). Does not enforce the 25 MiB upload cap. */
export const isAssistantAttachmentDescriptor = (value: unknown): value is AssistantAttachmentDescriptor => {
  try {
    parseAssistantAttachmentDescriptor(value, undefined, { enforceUploadLimit: false });
    return true;
  } catch {
    return false;
  }
};
