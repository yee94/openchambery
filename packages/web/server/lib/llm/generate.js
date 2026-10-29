import { generateCleanCompletion } from './bridge-client.js';
import { randomUUID } from 'node:crypto';

/** Single attachment payload cap (decoded bytes). Composer UI allows larger drafts; gateway enforces this. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TEXT_FILE_MIME = /^(text\/|application\/(json|javascript|xml|sql|yaml|x-yaml|toml))/i;

/**
 * Strict data-URL parse. Returns null when the URI is not a well-formed data URL.
 * Decoded size is checked against MAX_ATTACHMENT_BYTES.
 */
export function parseDataUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const comma = url.indexOf(',');
  if (comma < 5) return null;
  const meta = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  if (!meta || !payload) return null;
  const parts = meta.split(';');
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(parts[0]) ? parts[0] : null;
  if (!mime) return null;
  const isBase64 = parts.some(part => part.toLowerCase() === 'base64');
  let bytes;
  try { bytes = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8'); }
  catch { return null; }
  // Reject corrupt base64 that decodes to empty while payload was non-empty.
  if (isBase64 && !bytes.length && payload.replace(/\s/g, '').length) return null;
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw Object.assign(new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`), { code: 'validation_error' });
  return { mime, bytes, isBase64, byteLength: bytes.length };
}

const prepareMessages = (messages, forwardImageParts) => messages.map(message => {
  const descriptions = [];
  const images = [];
  for (const part of message.parts ?? []) {
    const parsed = parseDataUrl(part.url);
    if (!parsed) throw Object.assign(new Error('Attachment data URL is malformed'), { code: 'validation_error' });
    if (forwardImageParts && part.mime.startsWith('image/')) {
      images.push({ ...part, url: `data:${part.mime};base64,${parsed.bytes.toString('base64')}` });
    } else {
      const label = `[${part.mime.startsWith('image/') ? 'image' : 'file'}: ${part.filename || 'attachment'} (${part.mime})]`;
      descriptions.push(TEXT_FILE_MIME.test(part.mime) ? `${label}\n${parsed.bytes.toString('utf8').slice(0, 100_000)}` : label);
    }
  }
  return { ...message, content: [message.content, ...descriptions].filter(Boolean).join('\n'), ...(images.length ? { parts: images } : { parts: undefined }) };
});

// Retrying this single inference call cannot replay tools: their execution belongs to the caller.
export async function generateOpenCodeText({ messages, signal, timeoutMs = 0,
  retryEmptyTextUntilCancelled = false, forwardImageParts = false,
  generateCompletion = generateCleanCompletion, ...options }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('LLM inference timed out')), timeoutMs) : null;
  try {
    const prepared = prepareMessages(messages, forwardImageParts);
    const cacheKey = options.cacheKey || randomUUID();
    for (let attempt = 0; ; attempt++) {
      requestSignal.throwIfAborted();
      const result = await generateCompletion({ ...options, cacheKey, messages: prepared, signal: requestSignal });
      requestSignal.throwIfAborted();
      if (result.finishReason === 'length' || result.finishReason === 'content-filter' || result.finishReason === 'error') {
        throw Object.assign(new Error(`LLM inference ended with ${result.finishReason}`), { code: 'upstream_error' });
      }
      if (result.text?.trim() || result.toolCalls?.length) return result;
      if (!retryEmptyTextUntilCancelled && attempt >= 2) throw Object.assign(new Error('LLM returned no text or tool calls'), { code: 'upstream_error' });
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); requestSignal.removeEventListener('abort', onAbort); reject(requestSignal.reason); };
        const timer = setTimeout(() => { requestSignal.removeEventListener('abort', onAbort); resolve(); }, Math.min(500 * (2 ** Math.min(attempt, 6)), 30_000));
        requestSignal.addEventListener('abort', onAbort, { once: true });
        if (requestSignal.aborted) onAbort();
      });
    }
  } finally { if (timeout) clearTimeout(timeout); }
}
