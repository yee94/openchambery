/**
 * Scheduled session.create delivery.
 *
 * Only a Transport error whose cause chain is ECONNREFUSED+connect or
 * ENOTFOUND+getaddrinfo proves the request never left this process.
 * Anything that may have reached upstream is not retried.
 */

const CREATE_RETRY_DELAYS_MS = [1_000, 4_000, 10_000];
/** Strictly under 60s. Watchdog abort still wins when it is sooner. */
export const CREATE_PHASE_DEADLINE_MS = 45_000;
const SUMMARY_MAX = 300;
const CAPTURE_BYTES = 4_096;
const CAPTURE_MS = 250;
const CODE_MAX = 40;
const CAUSE_DEPTH = 6;

const firstString = (values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const causeChain = (error) => {
  const chain = [];
  let current = error;
  for (let depth = 0; depth < CAUSE_DEPTH && current; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
};

const isProvenUnsentCreateFailure = (error) => {
  if (!error || error.name === 'AbortError') return false;
  if (error.reason && error.reason !== 'Transport') return false;
  return causeChain(error).some((item) => (
    (item.code === 'ECONNREFUSED' && item.syscall === 'connect')
    || (item.code === 'ENOTFOUND' && item.syscall === 'getaddrinfo')
  ));
};

const provenUnsentCode = (error) => {
  for (const item of causeChain(error)) {
    if (item.code === 'ECONNREFUSED' && item.syscall === 'connect') return 'ECONNREFUSED';
    if (item.code === 'ENOTFOUND' && item.syscall === 'getaddrinfo') return 'ENOTFOUND';
  }
  return null;
};

const httpStatusFromError = (error) => {
  for (const item of causeChain(error)) {
    if (Number.isFinite(item?.status)) return Math.trunc(item.status);
  }
  const match = /UnexpectedStatus:\s*(\d{3})/.exec(typeof error?.message === 'string' ? error.message : '');
  return match ? Number(match[1]) : undefined;
};

const sanitizeCode = (value) => {
  const cleaned = firstString([value]).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, CODE_MAX);
  return cleaned || null;
};

const redact = (value) => String(value || '')
  .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
  .replace(/"(token|credential|password|secret|bearer)"\s*:\s*"[^"]*"/gi, '"$1":"<redacted>"')
  .replace(/((?:token|credential|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
  .replace(/https?:\/\/(?:[^/\s:@]+:[^/\s@]+@)[^\s]+/gi, '<redacted-url>')
  .replace(/https?:\/\/[^\s]*?(?:token|credential|bearer|password|secret)[^\s]*/gi, '<redacted-url>');

const extractBodyFields = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { message: '', code: null };
  }
  const dataError = parsed.data?.error && typeof parsed.data.error === 'object' ? parsed.data.error : null;
  const errorObject = parsed.error && typeof parsed.error === 'object' ? parsed.error : null;
  return {
    message: firstString([
      parsed.message,
      parsed.data?.message,
      dataError?.message,
      errorObject?.message,
    ]),
    code: sanitizeCode(firstString([
      parsed.code,
      parsed.data?.code,
      dataError?.code,
      errorObject?.code,
    ])),
  };
};

const formatFailureSummary = ({
  operation = 'session.create',
  status,
  message = '',
  code = null,
  retryable = false,
  outcome = null,
} = {}) => {
  const op = String(operation || 'session.create').replace(/[^\w.:-]/g, '').slice(0, 40) || 'session.create';
  const statusPart = Number.isFinite(status) ? ` HTTP ${Math.trunc(status)}` : '';
  const safeCode = sanitizeCode(code);
  const codePart = safeCode ? ` code=${safeCode}` : '';
  const retryPart = ` retryable=${retryable ? 'true' : 'false'}`;
  const outcomePart = outcome === 'unknown'
    ? ' creation outcome unknown'
    : outcome === 'not-sent'
      ? ' request not sent'
      : '';
  const reserved = `${op}${statusPart}${codePart}${retryPart}${outcomePart}`;
  const prefix = `${reserved}: `;
  const room = Math.max(0, SUMMARY_MAX - prefix.length);
  const text = redact(message).replace(/\s+/g, ' ').trim().slice(0, room);
  return (text ? `${prefix}${text}` : reserved).slice(0, SUMMARY_MAX);
};

export const formatAssistantFailure = (error) => {
  const message = firstString([
    error?.message,
    error?.data?.message,
    error?.data?.error?.message,
    error?.error?.message,
    error?.name,
    error?.type,
  ]) || 'assistant error';
  const code = sanitizeCode(firstString([
    error?.code,
    error?.data?.code,
    error?.data?.error?.code,
    error?.error?.code,
  ]));
  const status = [
    error?.status,
    error?.data?.status,
    error?.data?.error?.status,
    error?.error?.status,
  ].find((value) => Number.isFinite(value));
  if (!code && !Number.isFinite(status)) {
    const redacted = redact(message);
    return redacted.length > SUMMARY_MAX ? redacted.slice(0, SUMMARY_MAX) : redacted;
  }
  return formatFailureSummary({
    operation: 'assistant',
    status: Number.isFinite(status) ? status : undefined,
    message,
    code,
    retryable: false,
  });
};

const readBounded = async (response) => {
  let clone;
  try {
    clone = response.clone();
  } catch {
    return '';
  }
  const reader = clone.body?.getReader?.();
  if (!reader) {
    try {
      return (await clone.text()).slice(0, CAPTURE_BYTES);
    } catch {
      return '';
    }
  }
  const chunks = [];
  let total = 0;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), CAPTURE_MS);
  });
  try {
    while (total < CAPTURE_BYTES) {
      const next = await Promise.race([
        reader.read().then((value) => ({ value })),
        timeout,
      ]);
      if (next === 'timeout' || next?.value?.done) break;
      const bytes = next?.value?.value;
      if (!bytes) break;
      const remaining = CAPTURE_BYTES - total;
      const piece = bytes.byteLength > remaining ? bytes.subarray(0, remaining) : bytes;
      chunks.push(piece);
      total += piece.byteLength;
    }
  } catch {
    // A hung or unreadable clone must not replace the SDK error.
  } finally {
    clearTimeout(timer);
    // Do not await cancel. A tee waits for the original consumer, which is
    // the SDK, and the SDK is waiting for this function to return.
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, CAPTURE_BYTES).toString('utf8');
};

const captureFailure = async (response) => {
  const status = Number.isFinite(response?.status) ? response.status : undefined;
  const advertised = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(advertised) && advertised > CAPTURE_BYTES) {
    return { status, message: '', code: null };
  }
  try {
    const text = await readBounded(response);
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const fields = extractBodyFields(parsed);
    return { status, message: fields.message, code: fields.code };
  } catch {
    return { status, message: '', code: null };
  }
};

export const createRunDeliveryFetch = (baseFetch = fetch) => {
  const attempts = new WeakMap();
  const fetchImpl = async (input, init) => {
    // This attempt only. A body that arrives after the deadline must not
    // write the next attempt's slot.
    const attempt = init?.signal ? attempts.get(init.signal) : undefined;
    // session.create must not follow redirects. A 307/308 can be issued after
    // the session already exists; following it to a closed port looks like
    // ECONNREFUSED and would retry a second create.
    const response = await baseFetch(
      input,
      attempt ? { ...init, redirect: 'manual' } : init,
    );
    if (attempt && response && response.ok === false) {
      attempt.diagnostic = await captureFailure(response);
    }
    return response;
  };
  return {
    fetchImpl,
    createSession(options) {
      return createSessionWithUnsentRetry({ ...options, attempts });
    },
  };
};

const annotateCreateFailure = (error, diagnostic, unsent) => {
  const status = Number.isFinite(diagnostic?.status) ? diagnostic.status : httpStatusFromError(error);
  const message = diagnostic?.message || (error instanceof Error ? error.message : String(error || ''));
  const summary = formatFailureSummary({
    operation: 'session.create',
    status,
    message,
    code: diagnostic?.code || (unsent ? provenUnsentCode(error) : null),
    retryable: false,
    outcome: unsent ? 'not-sent' : 'unknown',
  });
  const wrapped = new Error(summary);
  wrapped.cause = error;
  return wrapped;
};

const aborted = (signal) => signal?.aborted
  || signal?.reason?.name === 'AbortError';

const createSessionWithUnsentRetry = async ({
  client,
  input,
  signal,
  deadlineMs = CREATE_PHASE_DEADLINE_MS,
  sleep,
  attempts,
}) => {
  const started = Date.now();
  const budget = Math.min(
    Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : CREATE_PHASE_DEADLINE_MS,
    CREATE_PHASE_DEADLINE_MS,
  );
  const deadline = started + budget;
  let lastFailure = null;
  const attemptCount = 1 + CREATE_RETRY_DELAYS_MS.length;

  for (let index = 0; index < attemptCount; index += 1) {
    if (aborted(signal)) {
      throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
    }
    if (Date.now() >= deadline) break;
    if (index > 0) {
      const delay = CREATE_RETRY_DELAYS_MS[index - 1];
      if (Date.now() + delay >= deadline) break;
      await sleep(delay, signal);
      if (aborted(signal)) {
        throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      if (Date.now() >= deadline) break;
    }
    const remaining = Math.max(1, deadline - Date.now());
    const attemptSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(remaining)])
      : AbortSignal.timeout(remaining);
    const attempt = { diagnostic: null };
    attempts.set(attemptSignal, attempt);
    try {
      const session = await client.session.create(input, { signal: attemptSignal });
      if (!session?.id) {
        throw annotateCreateFailure(new Error('failed to create session'), null, false);
      }
      return session;
    } catch (error) {
      const diagnostic = attempt.diagnostic;
      if (aborted(signal)) throw error;
      if (Date.now() >= deadline && !isProvenUnsentCreateFailure(error)) {
        throw annotateCreateFailure(error, diagnostic, false);
      }
      lastFailure = { error, diagnostic };
      const unsent = isProvenUnsentCreateFailure(error);
      if (!unsent || index === attemptCount - 1 || Date.now() >= deadline) {
        throw annotateCreateFailure(error, diagnostic, unsent);
      }
    }
  }

  throw annotateCreateFailure(
    lastFailure?.error || new Error('session.create deadline'),
    lastFailure?.diagnostic ?? null,
    isProvenUnsentCreateFailure(lastFailure?.error),
  );
};
