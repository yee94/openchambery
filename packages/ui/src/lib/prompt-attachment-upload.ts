import { normalize } from 'pathe';
import { runtimeFetch } from '@/lib/runtime-fetch';

export const MAX_PROMPT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export class PromptAttachmentUploadError extends Error {
  readonly status: number;
  readonly code: 'unavailable' | 'too-large' | 'rejected';

  constructor(status: number, code: PromptAttachmentUploadError['code'], message = 'Failed to upload prompt attachment') {
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
};

const FILE_URI_PREFIX = 'file://';

export const toPromptAttachmentFileUrl = (filepath: string): string => {
  const trimmed = filepath.trim();
  if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) return trimmed;
  const normalized = normalize(trimmed);
  const encoded = normalized
    .split('/')
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/');
  if (/^[A-Za-z]:/.test(encoded)) return `${FILE_URI_PREFIX}/${encoded}`;
  return `${FILE_URI_PREFIX}${encoded}`;
};

/** Inverse of `toPromptAttachmentFileUrl` — `file:///C:/a.png` → `C:/a.png`. */
export const pathFromPromptAttachmentFileUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) return trimmed;
  let rest = trimmed.slice(FILE_URI_PREFIX.length);
  if (rest.toLowerCase().startsWith('localhost/')) rest = rest.slice('localhost'.length);
  const decoded = rest
    .split('/')
    .map((segment) => {
      if (/^[A-Za-z]:$/.test(segment)) return segment;
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
  if (/^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1);
  return decoded;
};

const digestHex = async (value: Blob): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer()));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseUploadResult = async (response: Response): Promise<PromptAttachmentUploadResult> => {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PromptAttachmentUploadError(response.status, 'unavailable');
  }
  if (!isRecord(payload) || typeof payload.path !== 'string' || !payload.path) {
    throw new PromptAttachmentUploadError(response.status, 'unavailable');
  }
  const mime = typeof payload.mime === 'string' && payload.mime ? payload.mime : 'application/octet-stream';
  const size = typeof payload.size === 'number' && Number.isSafeInteger(payload.size) ? payload.size : 0;
  const sha256 = typeof payload.sha256 === 'string' ? payload.sha256 : '';
  return {
    path: payload.path,
    url: toPromptAttachmentFileUrl(payload.path),
    mime,
    size,
    sha256,
  };
};

const attachmentIDFor = (filename?: string): string => {
  const raw = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const suffix = filename?.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return suffix ? `att-${raw}-${suffix}` : `att-${raw}`;
};

export const blobFromDataUrl = (url: string, mime: string): Blob | null => {
  if (!url.startsWith('data:')) return null;
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) return null;
  const meta = url.slice(5, commaIndex);
  const payload = url.slice(commaIndex + 1);
  const declaredMime = meta.split(';', 1)[0]?.trim() || mime || 'application/octet-stream';
  try {
    if (meta.toLowerCase().includes(';base64')) {
      const binary = atob(payload);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: declaredMime });
    }
    return new Blob([decodeURIComponent(payload)], { type: declaredMime });
  } catch {
    return null;
  }
};

export const needsPromptAttachmentUpload = (url: string): boolean =>
  url.startsWith('data:') || url.startsWith('blob:');

/**
 * Upload inline image/file bytes as a streamed Blob body, then return a
 * host-absolute file:// URL for the OpenCode prompt part.
 *
 * Failures throw. Callers must not silently fall back to embedding the data
 * URL in the prompt JSON — that blocks the shared relay tunnel.
 */
export const uploadPromptAttachmentBytes = async (
  input: { body: Blob; mime: string; filename?: string; signal?: AbortSignal },
): Promise<PromptAttachmentUploadResult> => {
  const mime = input.mime || input.body.type || 'application/octet-stream';
  const body = input.body.type === mime ? input.body : new Blob([input.body], { type: mime });
  if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > MAX_PROMPT_ATTACHMENT_BYTES) {
    throw new PromptAttachmentUploadError(413, 'too-large');
  }
  const sha256 = await digestHex(body);
  const attachmentID = attachmentIDFor(input.filename);
  let response: Response;
  try {
    response = await runtimeFetch(`/api/fs/prompt-attachments/${encodeURIComponent(attachmentID)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': mime,
        'Content-Length': String(body.size),
        'X-OpenChamber-Content-Length': String(body.size),
        'X-OpenChamber-Sha256': sha256,
        'X-OpenChamber-Mime': mime,
        ...(input.filename ? { 'X-OpenChamber-Filename': encodeURIComponent(input.filename) } : {}),
      },
      body,
      signal: input.signal,
    });
  } catch {
    throw new PromptAttachmentUploadError(0, 'unavailable');
  }
  if (response.status === 413) throw new PromptAttachmentUploadError(413, 'too-large');
  if (!response.ok) throw new PromptAttachmentUploadError(response.status, response.status >= 500 || response.status === 0 ? 'unavailable' : 'rejected');
  const result = await parseUploadResult(response);
  if (result.size !== body.size) {
    throw new PromptAttachmentUploadError(response.status, 'unavailable');
  }
  return { ...result, mime };
};
