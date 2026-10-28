import { createHash } from 'node:crypto';

const REVISION_HEADER = 'x-yuri-gui-revision';
const CODE_HEADER = 'x-yuri-gui-code';
const FULL_RESPONSE_HEADERS = new Set([
  REVISION_HEADER, CODE_HEADER, 'if-none-match', 'if-modified-since',
  'if-match', 'if-unmodified-since', 'if-range', 'range',
]);

/** Only the official GUI read opts into Yuri's code-only reuse protocol. */
export const preparePluginGuiRequest = (method, requestPath, headers) => {
  if (method !== 'GET') return null;
  const url = new URL(requestPath, 'http://yuri.invalid');
  if (url.pathname !== '/api/plugin/gui'
    || url.searchParams.getAll('id').length !== 1
    || !url.searchParams.get('id')) return null;

  let revision = null;
  const forwarded = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === REVISION_HEADER && /^[a-f0-9]{64}$/.test(value)) revision = value;
    if (!FULL_RESPONSE_HEADERS.has(name)) forwarded[key] = value;
  }
  forwarded['accept-encoding'] = 'identity';
  return { headers: forwarded, revision };
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** No history/cache: only this request's complete, validated upstream 200 can omit code. */
export const projectPluginGuiResponse = async (response, requestedRevision) => {
  if (response.status !== 200) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  headers.delete(REVISION_HEADER);
  headers.delete(CODE_HEADER);
  headers.delete('etag');
  headers.delete('last-modified');
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');

  // Fetch has decoded compression. Keep original bytes even for malformed JSON.
  let body = Buffer.from(await response.arrayBuffer());
  if (/^application\/(?:json|[^;]+\+json)(?:\s*;|$)/i.test(headers.get('content-type') || '')) {
    let envelope;
    try { envelope = JSON.parse(body.toString('utf8')); } catch { /* Preserve upstream bytes. */ }
    const bundle = isRecord(envelope) && isRecord(envelope.location) ? envelope.data : null;
    if (isRecord(bundle) && typeof bundle.code === 'string'
      && typeof bundle.revision === 'string' && bundle.revision.length > 0
      && isRecord(bundle.options)) {
      const revision = createHash('sha256').update(bundle.revision).digest('hex');
      headers.set(REVISION_HEADER, revision);
      if (requestedRevision === revision) {
        body = Buffer.from(JSON.stringify({ ...envelope, data: { ...bundle, code: '' } }));
        headers.set(CODE_HEADER, 'cached');
      }
    }
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
};
