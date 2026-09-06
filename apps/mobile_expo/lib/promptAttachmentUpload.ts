/**
 * Cap PUT /api/fs/prompt-attachments/:id — upload bytes then file:// parts.
 * HEIC/transcode remains a device residual when pickers cannot convert.
 */

import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class PromptAttachmentUploadError extends Error {
  readonly status: number;
  readonly code: 'unavailable' | 'too-large' | 'rejected';

  constructor(
    status: number,
    code: PromptAttachmentUploadError['code'],
    message = 'Failed to upload prompt attachment',
  ) {
    super(message);
    this.name = 'PromptAttachmentUploadError';
    this.status = status;
    this.code = code;
  }
}

export type PromptAttachmentUploadResult = {
  path: string;
  url: string;
  mime: string;
  size: number;
  sha256: string;
  filename?: string;
};

export type StagedPromptAttachment = {
  localId: string;
  filename: string;
  mime: string;
  uri: string;
  byteSize?: number;
  /** Host path after upload (Cap file:// part). */
  uploaded?: PromptAttachmentUploadResult;
};

const FILE_URI_PREFIX = 'file://';

export const toPromptAttachmentFileUrl = (filepath: string): string => {
  const trimmed = filepath.trim();
  if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) return trimmed;
  const normalized = trimmed.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(normalized)) return `${FILE_URI_PREFIX}/${normalized}`;
  return `${FILE_URI_PREFIX}${normalized.startsWith('/') ? '' : '/'}${normalized}`;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const attachmentIDFor = (filename?: string): string => {
  const raw =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const suffix = filename?.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return suffix ? `att-${raw}-${suffix}` : `att-${raw}`;
};

const digestHex = async (bytes: ArrayBuffer): Promise<string> => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    // Headers are best-effort on runtimes without WebCrypto; server still accepts body.
    return '';
  }
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const parseUploadResult = async (
  response: { status: number; json: () => Promise<unknown> },
  fallbackMime: string,
): Promise<PromptAttachmentUploadResult> => {
  const payload = asRecord(await response.json());
  if (!payload || typeof payload.path !== 'string' || !payload.path) {
    throw new PromptAttachmentUploadError(response.status, 'unavailable');
  }
  const mime =
    typeof payload.mime === 'string' && payload.mime ? payload.mime : fallbackMime || 'application/octet-stream';
  const size =
    typeof payload.size === 'number' && Number.isSafeInteger(payload.size) ? payload.size : 0;
  const sha256 = typeof payload.sha256 === 'string' ? payload.sha256 : '';
  return {
    path: payload.path,
    url: toPromptAttachmentFileUrl(payload.path),
    mime,
    size,
    sha256,
  };
};

/** Read local picker URI into ArrayBuffer (file:// / content:// / ph://). */
export const readLocalUriBytes = async (uri: string): Promise<ArrayBuffer> => {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new PromptAttachmentUploadError(response.status, 'unavailable', 'Failed to read local attachment');
  }
  return response.arrayBuffer();
};

export const uploadPromptAttachmentBytes = async (
  active: ActiveRuntime,
  input: {
    body: ArrayBuffer;
    mime: string;
    filename?: string;
    signal?: AbortSignal;
  },
): Promise<PromptAttachmentUploadResult> => {
  const mime = input.mime || 'application/octet-stream';
  const size = input.body.byteLength;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PROMPT_ATTACHMENT_BYTES) {
    throw new PromptAttachmentUploadError(413, 'too-large');
  }
  const sha256 = await digestHex(input.body);
  const attachmentID = attachmentIDFor(input.filename);
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(size),
    'X-OpenChamber-Content-Length': String(size),
    'X-OpenChamber-Mime': mime,
  };
  if (sha256) headers['X-OpenChamber-Sha256'] = sha256;
  if (input.filename) headers['X-OpenChamber-Filename'] = encodeURIComponent(input.filename);

  let response;
  try {
    response = await openchamberFetch(
      active,
      `/api/fs/prompt-attachments/${encodeURIComponent(attachmentID)}`,
      {
        method: 'PUT',
        headers,
        body: input.body instanceof ArrayBuffer ? new Uint8Array(input.body) : input.body,
        signal: input.signal,
      },
    );
  } catch {
    throw new PromptAttachmentUploadError(0, 'unavailable');
  }

  if (response.status === 413) throw new PromptAttachmentUploadError(413, 'too-large');
  if (!response.ok) {
    throw new PromptAttachmentUploadError(
      response.status,
      response.status >= 500 || response.status === 0 ? 'unavailable' : 'rejected',
    );
  }
  const result = await parseUploadResult(response, mime);
  if (result.size !== size && result.size !== 0) {
    // Some hosts omit size; only fail when mismatched non-zero.
    throw new PromptAttachmentUploadError(response.status, 'unavailable');
  }
  return { ...result, mime, filename: input.filename };
};

export const uploadStagedAttachment = async (
  active: ActiveRuntime,
  staged: StagedPromptAttachment,
  signal?: AbortSignal,
): Promise<PromptAttachmentUploadResult> => {
  if (staged.uploaded) return staged.uploaded;
  const body = await readLocalUriBytes(staged.uri);
  if (typeof staged.byteSize === 'number' && staged.byteSize > MAX_PROMPT_ATTACHMENT_BYTES) {
    throw new PromptAttachmentUploadError(413, 'too-large');
  }
  return uploadPromptAttachmentBytes(active, {
    body,
    mime: staged.mime,
    filename: staged.filename,
    signal,
  });
};

export const isHeicLike = (mime: string, filename: string): boolean => {
  const lowerMime = mime.toLowerCase();
  const lowerName = filename.toLowerCase();
  return (
    lowerMime.includes('heic')
    || lowerMime.includes('heif')
    || lowerName.endsWith('.heic')
    || lowerName.endsWith('.heif')
  );
};
