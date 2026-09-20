const TEST_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 8_000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function parseCustomApiBaseURL(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return null;
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function classifyCustomSummaryApiFailure({ status, bodyText, cause } = {}) {
  const text = typeof bodyText === 'string' ? bodyText : '';
  if (status === 401 || status === 403) return 'token';
  if (status === 404) return 'model';
  if (/model_not_found|invalid_model|model[_ ]?not[_ ]found/i.test(text)) return 'model';
  if (status === 400 && /model/i.test(text)) return 'model';

  const code = typeof cause?.code === 'string' ? cause.code : '';
  const name = typeof cause?.name === 'string' ? cause.name : '';
  if (
    name === 'AbortError'
    || name === 'TimeoutError'
    || code === 'ENOTFOUND'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'ERR_INVALID_URL'
    || code === 'ENETUNREACH'
  ) {
    return 'baseURL';
  }
  if (!status) return 'baseURL';
  return 'baseURL';
}

const parseJson = (bodyText) => {
  try {
    return JSON.parse(bodyText);
  } catch {
    return null;
  }
};

export async function testCustomSummaryApi({
  baseURL,
  modelID,
  apiToken,
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  const parsedBaseURL = parseCustomApiBaseURL(baseURL);
  const trimmedModelID = typeof modelID === 'string' ? modelID.trim() : '';
  const trimmedToken = typeof apiToken === 'string' ? apiToken.trim() : '';
  if (!parsedBaseURL || !trimmedModelID || !trimmedToken) {
    return { ok: false, code: 'incomplete' };
  }

  try {
    const response = await fetchImpl(`${parsedBaseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({
        model: trimmedModelID,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    const bodyText = await response.text().catch(() => '');
    if (!response.ok) {
      return {
        ok: false,
        code: classifyCustomSummaryApiFailure({ status: response.status, bodyText }),
      };
    }
    const payload = parseJson(bodyText);
    if (!isRecord(payload) || !Array.isArray(payload.choices)) {
      return { ok: false, code: 'baseURL' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: classifyCustomSummaryApiFailure({ cause: error }) };
  }
}

export async function listCustomSummaryModels({
  baseURL,
  apiToken,
  fetchImpl = globalThis.fetch.bind(globalThis),
} = {}) {
  const parsedBaseURL = parseCustomApiBaseURL(baseURL);
  const trimmedToken = typeof apiToken === 'string' ? apiToken.trim() : '';
  if (!parsedBaseURL || !trimmedToken) {
    return [];
  }

  try {
    const response = await fetchImpl(`${parsedBaseURL}/models`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${trimmedToken}`,
      },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const payload = parseJson(await response.text().catch(() => ''));
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : [];
    const ids = [];
    for (const row of rows) {
      const id = typeof row === 'string'
        ? row.trim()
        : typeof row?.id === 'string'
          ? row.id.trim()
          : '';
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}
