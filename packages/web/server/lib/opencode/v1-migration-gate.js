export const OPENCODE_V1_MIGRATION_PATH = '/api/experimental/migration/v1';

// Backfill notes must stay readable by UI and docs. Do not drop them when the
// gate blocks or later admits a migrated library.
export const V1_MIGRATION_USER_NOTICE = [
  'V1 history is backfilled in the opencode2 process.',
  'Message ids are reused.',
  'In-progress tools become interrupted.',
  'V1 subtasks do not appear in v2.',
].join(' ');

const MIGRATION_PHASES = new Set(['required', 'running', 'completed', 'error']);

const stringifyError = (error) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return 'V1 migration status request failed';
};

const blocked = (phase, extra = {}) => ({
  admitTranscript: false,
  phase,
  userNotice: V1_MIGRATION_USER_NOTICE,
  ...extra,
});

const admitted = (phase, extra = {}) => ({
  admitTranscript: true,
  phase,
  ...extra,
});

const normalizeProgress = (progress) => {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    return undefined;
  }
  const result = {
    label: typeof progress.label === 'string' ? progress.label : '',
  };
  if (Number.isFinite(progress.numerator) && progress.numerator >= 0) {
    result.numerator = progress.numerator;
  }
  if (Number.isFinite(progress.denominator) && progress.denominator >= 0) {
    result.denominator = progress.denominator;
  }
  return result;
};

const resolveHttpStatus = (input) => {
  if (typeof input.httpStatus === 'number') {
    return input.httpStatus;
  }
  if (typeof input.status === 'number') {
    return input.status;
  }
  return undefined;
};

const resolveBody = (input) => {
  if (input.body !== undefined) {
    return input.body;
  }
  if (typeof input.status === 'string') {
    return input;
  }
  return null;
};

const resolveTransportError = (input) => {
  if (input instanceof Error || typeof input === 'string') {
    return input;
  }
  if (input?.error instanceof Error || typeof input?.error === 'string') {
    if (input.body === undefined && typeof input.status !== 'string') {
      return input.error;
    }
  }
  return null;
};

// Pure admission decision for GET /api/experimental/migration/v1.
// required/running/error never become an empty-list success.
export const evaluateV1MigrationGate = (input = {}) => {
  if (input == null) {
    return blocked('error', { error: 'V1 migration status is missing or invalid' });
  }

  const transportError = resolveTransportError(input);
  if (transportError) {
    return blocked('error', { error: stringifyError(transportError) });
  }

  const httpStatus = resolveHttpStatus(input);
  if (httpStatus === 404) {
    return admitted('absent');
  }
  if (Number.isInteger(httpStatus) && httpStatus >= 400) {
    return blocked('error', { error: `V1 migration status HTTP ${httpStatus}` });
  }

  const body = resolveBody(input);
  const phase = body && typeof body === 'object' ? body.status : undefined;

  if (phase === 'required') {
    return blocked('required');
  }
  if (phase === 'running') {
    return blocked('running', { progress: normalizeProgress(body.progress) });
  }
  if (phase === 'completed') {
    return admitted('completed', { userNotice: V1_MIGRATION_USER_NOTICE });
  }
  if (phase === 'error') {
    return blocked('error', {
      error: typeof body.error === 'string' && body.error.trim()
        ? body.error
        : 'V1 migration failed',
    });
  }

  if (MIGRATION_PHASES.has(phase) === false) {
    return blocked('error', { error: 'V1 migration status is missing or invalid' });
  }

  return blocked('error', { error: 'V1 migration status is missing or invalid' });
};

// Official protocol only publishes GET status. Backfill is owned by opencode2;
// clients poll this helper and do not POST unless a later API requires it.
export const fetchV1MigrationGate = async ({
  url,
  headers = {},
  signal,
  fetchImpl = globalThis.fetch,
} = {}) => {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal,
    });
    const body = await response.json().catch(() => null);
    return evaluateV1MigrationGate({
      httpStatus: response.status,
      body,
    });
  } catch (error) {
    return evaluateV1MigrationGate({ error });
  }
};
