import { ClientError, OpenCode } from '@opencode-ai/client';
import type { JsonValue, SessionInfo } from '@opencode-ai/client';
import type { BridgeContext, BridgeResponse } from './bridge';

// =========================================================================
// Inline types: mirror @openchamber/ui/lib/api/types exactly by re-using
// the SDK-native types that the shared contract now aliases. This avoids
// cross-package transitive path-alias issues while keeping type fidelity.
// Keep in sync with:
//   packages/ui/src/lib/api/types.ts
// =========================================================================

type ConversationTextPart = {
  type: 'text';
  text: string;
  id?: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: { [key: string]: unknown };
};

type ConversationFilePart = {
  type: 'file';
  mime: string;
  url: string;
  id?: string;
  filename?: string;
  source?: unknown;
};

type ConversationAgentPart = {
  type: 'agent';
  name: string;
  id?: string;
  source?: unknown;
};

type ConversationMessagePart =
  | ConversationTextPart
  | ConversationFilePart
  | ConversationAgentPart;

type ConversationCreateWithPromptInput = {
  input: { type: 'prompt' };
  directory: string;
  title?: string;
  parentID?: string;
  metadata?: Record<string, unknown>;
  messageID: string;
  model: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  parts: ConversationMessagePart[];
};

type ConversationSession = SessionInfo;

type ConversationCreateWithPromptResult =
  | { ok: true; session: ConversationSession; messageID: string }
  | { ok: false; phase: 'validate'; error: string; errors: string[] }
  | { ok: false; phase: 'create'; error: string; status?: number }
  | { ok: false; phase: 'prompt'; session: ConversationSession; messageID: string; ambiguous: boolean; error: string; status?: number }
  | { ok: false; phase: 'conflict'; error: string }
  | { ok: false; phase: 'unavailable'; error: string }
  | { ok: false; phase: 'internal'; error: string };

// =========================================================================

// --- shared helpers (mirror server service.js logic) ---

const CLIENT_SAFE_ERRORS = {
  create: 'Failed to create session',
  prompt: 'Failed to submit prompt',
  internal: 'Internal server error',
} as const;

const safeError = (phase: keyof typeof CLIENT_SAFE_ERRORS): string =>
  CLIENT_SAFE_ERRORS[phase];

const isTransportError = (error: unknown): boolean => {
  if (!error) return true;
  if (error instanceof ClientError) return error.reason === 'Transport';
  if (error instanceof Error) {
    const err = error as Error & { name?: string; code?: string; cause?: { code?: string } };
    if (err.name === 'TypeError' || err.name === 'FetchError' || err.name === 'AbortError') return true;
    const code = err.cause?.code || err.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') return true;
  }
  return false;
};

const extractHttpStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const rec = error as { status?: unknown; cause?: { status?: unknown }; _tag?: unknown };
  if (typeof rec.status === 'number' && Number.isFinite(rec.status)) return rec.status;
  if (rec.cause && typeof rec.cause.status === 'number' && Number.isFinite(rec.cause.status)) return rec.cause.status;
  if (rec._tag === 'InvalidRequestError') return 400;
  if (rec._tag === 'UnauthorizedError') return 401;
  return undefined;
};

const isRetryableHttpStatus = (status: unknown): boolean => {
  if (typeof status !== 'number' || !Number.isFinite(status)) return true;
  return status === 408 || status === 429 || status >= 500;
};

const isAmbiguousPromptError = (
  _error: unknown,
  response: { status?: number } | undefined,
): boolean => {
  if (!response) return true;
  const status = response?.status;
  if (typeof status !== 'number' || !Number.isFinite(status)) return true;
  return isRetryableHttpStatus(status);
};

// --- abort controller map ---

const abortControllers = new Map<string, AbortController>();

// --- request type ---

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

// --- validation (mirrors server validation.js contract) ---

const ALLOWED_TOP_KEYS = new Set([
  'input', 'directory', 'messageID', 'model', 'parts',
  'title', 'parentID', 'agent', 'variant', 'metadata',
]);

type ValidatedInput =
  | { valid: true; sanitized: ConversationCreateWithPromptInput }
  | { valid: false; errors: string[] };

const validateConversationInput = (body: unknown): ValidatedInput => {
  const errors: string[] = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { valid: false, errors: ['Request body must be a JSON object'] };
  }

  const obj = body as Record<string, unknown>;

  // Reject unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      errors.push(`Unknown field "${key}" is not allowed`);
    }
  }

  // input.type
  if (!obj.input || typeof obj.input !== 'object' || (obj.input as Record<string, unknown>).type !== 'prompt') {
    errors.push('input.type must be "prompt"');
  }

  // directory (required)
  if (typeof obj.directory !== 'string' || obj.directory.trim().length === 0) {
    errors.push('directory must be a non-empty string');
  }

  // messageID (required)
  if (typeof obj.messageID !== 'string' || obj.messageID.trim().length === 0) {
    errors.push('messageID must be a non-empty string');
  }

  // model (required)
  let model: { providerID: string; modelID: string } | null = null;
  if (!obj.model || typeof obj.model !== 'object' || Array.isArray(obj.model)) {
    errors.push('model must be an object with providerID and modelID');
  } else {
    const m = obj.model as Record<string, unknown>;
    if (typeof m.providerID !== 'string' || m.providerID.trim().length === 0) {
      errors.push('model.providerID must be a non-empty string');
    }
    if (typeof m.modelID !== 'string' || m.modelID.trim().length === 0) {
      errors.push('model.modelID must be a non-empty string');
    }
    if (typeof m.providerID === 'string' && typeof m.modelID === 'string'
        && m.providerID.trim().length > 0 && m.modelID.trim().length > 0) {
      model = {
        providerID: m.providerID.trim(),
        modelID: m.modelID.trim(),
      };
    }
  }

  // parts (required, at least one content-carrying part)
  const sanitizedParts: ConversationCreateWithPromptInput['parts'] = [];
  if (!Array.isArray(obj.parts)) {
    errors.push('parts must be an array');
  } else if (obj.parts.length === 0) {
    errors.push('parts must contain at least one part');
  } else {
    for (let i = 0; i < (obj.parts as unknown[]).length; i++) {
      const part = (obj.parts as unknown[])[i] as Record<string, unknown> | undefined;
      if (!part || typeof part !== 'object' || Array.isArray(part)) {
        errors.push(`parts[${i}]: Each part must be an object`);
        continue;
      }
      if (typeof part.type !== 'string' || !['text', 'file', 'agent'].includes(part.type)) {
        errors.push(`parts[${i}]: Part type must be one of: text, file, agent`);
        continue;
      }
      switch (part.type) {
        case 'text': {
          if (typeof part.text !== 'string' || part.text.trim().length === 0) {
            errors.push(`parts[${i}]: Text part must have a non-empty "text" string field`);
            break;
          }
          const tp: ConversationCreateWithPromptInput['parts'][number] = {
            type: 'text',
            text: part.text,
          };
          if (typeof part.id === 'string' && part.id.length > 0) tp.id = part.id;
          if (typeof part.synthetic === 'boolean') tp.synthetic = part.synthetic;
          if (typeof part.ignored === 'boolean') tp.ignored = part.ignored;
          if (part.time && typeof part.time === 'object' && !Array.isArray(part.time)) tp.time = part.time as { start: number; end?: number };
          if (part.metadata && typeof part.metadata === 'object' && !Array.isArray(part.metadata)) tp.metadata = part.metadata as { [key: string]: unknown };
          sanitizedParts.push(tp);
          break;
        }
        case 'file': {
          if (typeof part.mime !== 'string' || part.mime.trim().length === 0) {
            errors.push(`parts[${i}]: File part must have a non-empty "mime" string field`);
          }
          if (typeof part.url !== 'string' || part.url.trim().length === 0) {
            errors.push(`parts[${i}]: File part must have a non-empty "url" string field`);
          }
          if (typeof part.mime === 'string' && part.mime.trim().length > 0
              && typeof part.url === 'string' && part.url.trim().length > 0) {
            const fp: ConversationCreateWithPromptInput['parts'][number] = {
              type: 'file',
              mime: part.mime,
              url: part.url,
            };
            if (typeof part.id === 'string' && part.id.length > 0) fp.id = part.id;
            if (typeof part.filename === 'string' && part.filename.length > 0) fp.filename = part.filename;
            if (part.source && typeof part.source === 'object' && !Array.isArray(part.source)) {
              (fp as Record<string, unknown>).source = part.source;
            }
            sanitizedParts.push(fp);
          }
          break;
        }
        case 'agent': {
          if (typeof part.name !== 'string' || part.name.trim().length === 0) {
            errors.push(`parts[${i}]: Agent part must have a non-empty "name" string field`);
            break;
          }
          const ap: ConversationCreateWithPromptInput['parts'][number] = {
            type: 'agent',
            name: part.name,
          };
          if (typeof part.id === 'string' && part.id.length > 0) ap.id = part.id;
          if (part.source && typeof part.source === 'object' && !Array.isArray(part.source)) {
            (ap as Record<string, unknown>).source = part.source;
          }
          sanitizedParts.push(ap);
          break;
        }
      }
    }

    if (errors.length === 0 && sanitizedParts.length === 0) {
      errors.push('parts must contain at least one content-carrying part (text, file, or agent)');
    }
  }

  // Optional field validation
  let title: string | undefined;
  if (obj.title !== undefined) {
    if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
      errors.push('title must be a non-empty string if provided');
    } else {
      title = obj.title.trim();
    }
  }

  let parentID: string | undefined;
  if (obj.parentID !== undefined) {
    if (typeof obj.parentID !== 'string' || obj.parentID.trim().length === 0) {
      errors.push('parentID must be a non-empty string if provided');
    } else {
      parentID = obj.parentID.trim();
    }
  }

  let agent: string | undefined;
  if (obj.agent !== undefined) {
    if (typeof obj.agent !== 'string' || obj.agent.trim().length === 0) {
      errors.push('agent must be a non-empty string if provided');
    } else {
      agent = obj.agent.trim();
    }
  }

  let variant: string | undefined;
  if (obj.variant !== undefined) {
    if (typeof obj.variant !== 'string' || obj.variant.trim().length === 0) {
      errors.push('variant must be a non-empty string if provided');
    } else {
      variant = obj.variant.trim();
    }
  }

  let metadata: Record<string, unknown> | undefined;
  if (obj.metadata !== undefined) {
    if (typeof obj.metadata !== 'object' || Array.isArray(obj.metadata) || obj.metadata === null) {
      errors.push('metadata must be an object if provided');
    } else {
      metadata = obj.metadata as Record<string, unknown>;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    sanitized: {
      input: { type: 'prompt' },
      directory: (obj.directory as string).trim(),
      messageID: (obj.messageID as string).trim(),
      model: model!,
      parts: sanitizedParts,
      title,
      parentID,
      agent,
      variant,
      metadata,
    },
  };
};

// --- internal result helper ---

const internalResult = (id: string, type: string): BridgeResponse => ({
  id,
  type,
  success: true,
  data: {
    ok: false,
    phase: 'internal',
    error: safeError('internal'),
  } satisfies ConversationCreateWithPromptResult,
});

// --- build promptAsync params (returns SDK parameter type directly) ---

const buildV2PromptInput = (
  sessionID: string,
  input: ConversationCreateWithPromptInput,
) => {
  const text = input.parts
    .filter((part): part is ConversationTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const files = input.parts
    .filter((part): part is ConversationFilePart => part.type === 'file')
    .map((part) => ({
      uri: part.url,
      ...(part.filename ? { name: part.filename } : {}),
    }));
  const agents = input.parts
    .filter((part): part is ConversationAgentPart => part.type === 'agent')
    .map((part) => ({ name: part.name }));

  return {
    sessionID,
    id: input.messageID,
    text,
    delivery: 'steer' as const,
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(input.metadata ? { metadata: input.metadata as { readonly [key: string]: JsonValue } } : {}),
  };
};

// --- main handler ---

// --- VSCode host-side operation registry (mirrors server registry semantics) ---

const VSCodeRegistryEntryMax = 500;
const VSCodeRegistryTtlMs = 5 * 60 * 1000; // 5 min

type RegistryEntry =
  | { status: 'inflight'; promise: Promise<ConversationCreateWithPromptResult>; fingerprint: string }
  | { status: 'completed'; result: ConversationCreateWithPromptResult; fingerprint: string; completedAt: number };

const vscodeRegistry = new Map<string, RegistryEntry>();

export const resetVSCodeRegistry = (): void => {
  vscodeRegistry.clear();
};

const isRegistryExpired = (entry: RegistryEntry): boolean => {
  if (entry.status !== 'completed') return false;
  return Date.now() - entry.completedAt >= VSCodeRegistryTtlMs;
};

const evictRegistryExpired = (): void => {
  for (const [key, entry] of vscodeRegistry) {
    if (isRegistryExpired(entry)) vscodeRegistry.delete(key);
  }
};

const evictOldestCompleted = (): void => {
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of vscodeRegistry) {
    if (entry.status === 'completed' && entry.completedAt < oldestTime) {
      oldestTime = entry.completedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) vscodeRegistry.delete(oldestKey);
};

// --- Stable fingerprint (mirrors packages/web/server/lib/conversations/registry.js) ---
// Keep in sync with registry.js stableStringify.
const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  // object — skip null/undefined values
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    const v = (value as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;
    pairs.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
  }
  return `{${pairs.join(',')}}`;
};

/** Stable fingerprint matching server registry.js semantics */
const registryFingerprint = (input: { messageID: string; directory: string; model: { providerID: string; modelID: string }; parts: unknown[]; title?: string; parentID?: string; agent?: string; variant?: string; metadata?: Record<string, unknown> }): string =>
  stableStringify({
    directory: input.directory,
    messageID: input.messageID,
    model: input.model,
    parts: input.parts,
    title: input.title ?? null,
    parentID: input.parentID ?? null,
    agent: input.agent ?? null,
    variant: input.variant ?? null,
    metadata: input.metadata ?? null,
  });

export async function handleConversationsBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  if (type === 'api:conversations:abort') {
    const { requestID } = (payload || {}) as { requestID?: string };
    if (typeof requestID === 'string' && requestID.length > 0) {
      abortControllers.get(requestID)?.abort();
      abortControllers.delete(requestID);
    }
    return { id, type, success: true, data: { aborted: true } };
  }

  if (type !== 'api:conversations:createWithPrompt') {
    return null;
  }

  try {
    const validation = validateConversationInput(payload);
    if (!validation.valid) {
      return {
        id,
        type,
        success: true,
        data: {
          ok: false,
          phase: 'validate',
          error: 'Invalid request',
          errors: validation.errors,
        } satisfies ConversationCreateWithPromptResult,
      };
    }

    const input = validation.sanitized;
    const key = input.messageID;
    const fp = registryFingerprint(input);

    // --- registry dedup ---
    evictRegistryExpired();

    const existing = vscodeRegistry.get(key);
    if (existing?.status === 'inflight') {
      if (existing.fingerprint !== fp) {
        return {
          id, type, success: true,
          data: { ok: false, phase: 'conflict', error: 'Conversation operation conflict' } satisfies ConversationCreateWithPromptResult,
        };
      }
      const result = await existing.promise;
      return { id, type, success: true, data: result };
    }

    if (existing?.status === 'completed') {
      if (existing.fingerprint !== fp) {
        return {
          id, type, success: true,
          data: { ok: false, phase: 'conflict', error: 'Conversation operation conflict' } satisfies ConversationCreateWithPromptResult,
        };
      }
      return { id, type, success: true, data: existing.result };
    }

    // Capacity check
    if (vscodeRegistry.size >= VSCodeRegistryEntryMax) {
      const completedCount = [...vscodeRegistry.values()].filter((e) => e.status === 'completed').length;
      if (completedCount > 0) {
        evictOldestCompleted();
      } else {
        return {
          id, type, success: true,
          data: { ok: false, phase: 'unavailable', error: 'Conversation service busy' } satisfies ConversationCreateWithPromptResult,
        };
      }
    }

    // Register inflight — the factory promise
    const factoryPromise = (async (): Promise<ConversationCreateWithPromptResult> => {
      const apiUrl = ctx?.manager?.getApiUrl();
      if (!apiUrl) {
        return { ok: false, phase: 'create', error: safeError('create') };
      }

      const authHeaders = ctx?.manager?.getOpenCodeAuthHeaders() ?? {};
      const client = OpenCode.make({
        baseUrl: apiUrl.replace(/\/+$/, ''),
        headers: authHeaders,
        fetch: globalThis.fetch,
      });

      const requestAbort = new AbortController();
      abortControllers.set(id, requestAbort);

      try {
        if (input.parentID) {
          console.warn('[bridge:conversations] session.create has no v2 parentID; failing closed');
          return { ok: false, phase: 'create', error: safeError('create') };
        }

        // Phase 1: create session
        let session: ConversationSession;
        try {
          session = await client.session.create(
            {
              location: { directory: input.directory },
              ...(input.title ? { title: input.title } : {}),
              ...(input.agent ? { agent: input.agent } : {}),
              model: {
                id: input.model.modelID,
                providerID: input.model.providerID,
                ...(input.variant ? { variant: input.variant } : {}),
              },
            },
            {
              signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(30_000)]),
            },
          );
        } catch (err) {
          const createStatus = extractHttpStatus(err);
          console.warn(`[bridge:conversations] session.create ${isTransportError(err) ? 'transport' : 'client'} error (${createStatus || 'no status'})`);
          return {
            ok: false, phase: 'create', error: safeError('create'),
            ...(typeof createStatus === 'number' && Number.isFinite(createStatus) ? { status: createStatus } : {}),
          };
        }

        const sessionID = typeof session?.id === 'string' ? session.id : '';
        if (!sessionID) {
          console.warn('[bridge:conversations] session.create returned no session ID');
          return { ok: false, phase: 'create', error: safeError('create') };
        }

        // Phase 2: promptAsync
        try {
          await client.session.prompt(
            buildV2PromptInput(sessionID, input),
            { signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(45_000)]) },
          );
        } catch (err) {
          const httpStatus = extractHttpStatus(err);
          const ambiguous = isAmbiguousPromptError(err, httpStatus !== undefined ? { status: httpStatus } : undefined);
          console.warn(`[bridge:conversations] prompt throw (${httpStatus || 'no status'}, ambiguous=${ambiguous})`);
          return {
            ok: false, phase: 'prompt', session, messageID: input.messageID,
            ambiguous, error: safeError('prompt'),
            ...(typeof httpStatus === 'number' && Number.isFinite(httpStatus) ? { status: httpStatus } : {}),
          };
        }

        return { ok: true, session, messageID: input.messageID };
      } finally {
        abortControllers.delete(id);
      }
    })();

    vscodeRegistry.set(key, { status: 'inflight', promise: factoryPromise, fingerprint: fp });

    try {
      const result = await factoryPromise;
      vscodeRegistry.set(key, { status: 'completed', result, fingerprint: fp, completedAt: Date.now() });
      return { id, type, success: true, data: result };
    } catch {
      vscodeRegistry.delete(key);
      return internalResult(id, type);
    }
  } catch {
    return internalResult(id, type);
  }
}
