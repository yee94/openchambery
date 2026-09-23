const TEST_TIMEOUT_MS = 15_000;
const MODELS_TIMEOUT_MS = 8_000;
const GENERATE_TIMEOUT_MS = 60_000;
// Generous default: thinking models that can't be switched off spend part of
// this budget on reasoning before the actual answer.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

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

/**
 * Summary AI custom mode: one non-streaming chat completion against the
 * user's own OpenAI-compatible endpoint. The token never leaves this process.
 */
export async function generateCustomSummaryText({
  baseURL,
  apiToken,
  modelID,
  prompt,
  system,
  maxOutputTokens,
  fetchImpl = globalThis.fetch.bind(globalThis),
}) {
  const parsedBaseURL = parseCustomApiBaseURL(baseURL);
  if (!parsedBaseURL) {
    throw Object.assign(new Error('Custom summary API Base URL is invalid'), { statusCode: 400 });
  }
  const response = await fetchImpl(`${parsedBaseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({
      model: modelID,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      max_tokens: Number(maxOutputTokens) > 0 ? Number(maxOutputTokens) : DEFAULT_MAX_OUTPUT_TOKENS,
      stream: false,
    }),
    signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
  });
  const bodyText = await response.text().catch(() => '');
  if (!response.ok) {
    const snippet = bodyText ? `: ${bodyText.slice(0, 300)}` : '';
    throw new Error(`Custom summary API request failed with ${response.status}${snippet}`);
  }
  const payload = parseJson(bodyText);
  const message = payload?.choices?.[0]?.message;
  // Providers disagree on the content shape: plain string, an array of typed
  // parts, or (thinking models) empty content with the budget spent on
  // reasoning_content.
  let text = '';
  if (typeof message?.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message?.content)) {
    text = message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  if (!text.trim() && typeof message?.reasoning_content === 'string' && message.reasoning_content.trim()) {
    const finishReason = payload?.choices?.[0]?.finish_reason;
    throw new Error(
      'Custom summary API spent the output budget on reasoning and returned no answer'
      + (finishReason ? ` (finish_reason: ${finishReason})` : ''),
    );
  }
  if (!text.trim()) {
    throw new Error('Custom summary API returned no message content');
  }
  return text;
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
