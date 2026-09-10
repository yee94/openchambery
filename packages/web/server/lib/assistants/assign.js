import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class AssignError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AssignError';
    this.code = code;
    if (details.ambiguous === true) this.ambiguous = true;
    if (typeof details.sessionID === 'string' && details.sessionID) this.sessionID = details.sessionID;
    if (typeof details.messageID === 'string' && details.messageID) this.messageID = details.messageID;
  }
}

export const ASSIGN_CODES = Object.freeze({
  PROJECT_REQUIRED: 'project_required',
  WORKSPACE_FORBIDDEN: 'workspace_forbidden',
  WORKTREE_NOT_FOUND: 'worktree_not_found',
  VALIDATION: 'validation_error',
  UPSTREAM: 'upstream_error',
  MODEL_NOT_FOUND: 'model_not_found',
  MODEL_AMBIGUOUS: 'model_ambiguous',
  IMAGE_NOT_SUPPORTED: 'image_not_supported',
  NO_PROVIDER: 'no_provider',
  PROMPT_AMBIGUOUS: 'prompt_ambiguous',
});

export const PROJECT_REQUIRED_MESSAGE = 'No registered project is configured. Add a project in Settings before assigning work. Do not use assistant-workspaces.';

/** Bounded deadlines for worker session side effects (Promise.race + optional signal). */
export const ASSIGN_CREATE_TIMEOUT_MS = 30_000;
export const ASSIGN_PROMPT_TIMEOUT_MS = 45_000;
export const ASSIGN_DELETE_TIMEOUT_MS = 10_000;
export const ASSIGN_LOOKUP_TIMEOUT_MS = 8_000;

const contained = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

/** Soft trim for optional path/title fields — missing stays null. */
const trim = (value, max = 10_000) => {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  if (!next || next.length > max) return null;
  return next;
};

/**
 * Fail-closed string when the caller *provided* a field (not undefined).
 * Objects, blank strings, and over-max lengths throw — never silent null fallback.
 */
export function requireProvidedString(value, { field, max }) {
  if (value === undefined) return null;
  if (value === null) {
    throw new AssignError(
      ASSIGN_CODES.VALIDATION,
      `assign_session ${field} must be a non-empty string when provided.`,
    );
  }
  if (typeof value !== 'string') {
    throw new AssignError(
      ASSIGN_CODES.VALIDATION,
      `assign_session ${field} must be a string (got ${typeof value}).`,
    );
  }
  const next = value.trim();
  if (!next) {
    throw new AssignError(
      ASSIGN_CODES.VALIDATION,
      `assign_session ${field} must be a non-empty string when provided.`,
    );
  }
  if (next.length > max) {
    throw new AssignError(
      ASSIGN_CODES.VALIDATION,
      `assign_session ${field} exceeds ${max} characters.`,
    );
  }
  return next;
}

const promptAdmitted = (result) => (
  !result?.error
  && (result?.response?.status === 204 || result?.status === 204 || result?.data !== undefined || result?.response?.ok === true)
);

const isTransportError = (error) => {
  if (!error) return false;
  if (error.name === 'TypeError' || error.name === 'FetchError' || error.name === 'AbortError') return true;
  const code = error.cause?.code || error.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'ABORT_ERR') {
    return true;
  }
  if (error.timedOut === true) return true;
  if (typeof error.message === 'string' && /timed out|aborted|network|fetch failed/i.test(error.message)) return true;
  return false;
};

const resultHttpStatus = (result) => {
  const status = result?.response?.status
    ?? result?.error?.status
    ?? result?.error?.statusCode
    ?? result?.status;
  return Number.isFinite(status) ? status : null;
};

/** Ambiguous: transport/timeout/5xx/no status — prompt may already be admitted upstream. */
export function isAmbiguousPromptFailure(error, result) {
  if (error && isTransportError(error)) return true;
  if (error?.timedOut === true) return true;
  if (!result && error) return isTransportError(error);
  if (!result) return true;
  if (promptAdmitted(result)) return false;
  const status = resultHttpStatus(result);
  if (status == null) return true;
  return status === 408 || status === 429 || status >= 500;
}

function raceDeadline(work, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.code = ASSIGN_CODES.UPSTREAM;
      error.timedOut = true;
      reject(error);
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function normalizeProjectRoots(allowedRoots = []) {
  const seen = new Set();
  const roots = [];
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const resolved = path.resolve(root.trim());
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

export function isManagedAssistantWorkspace(candidate, managedWorkspaceRoot) {
  if (!candidate || !managedWorkspaceRoot) return false;
  return contained(path.resolve(candidate), path.resolve(managedWorkspaceRoot));
}

export function resolveAssignDirectory({
  projectPath,
  directory,
  branch,
  allowedRoots,
  managedWorkspaceRoot,
  defaultProjectPath = null,
  worktrees = [],
}) {
  const roots = normalizeProjectRoots(allowedRoots);
  if (roots.length === 0) {
    throw new AssignError(ASSIGN_CODES.PROJECT_REQUIRED, PROJECT_REQUIRED_MESSAGE);
  }

  const rejectManaged = (resolved) => {
    if (isManagedAssistantWorkspace(resolved, managedWorkspaceRoot)) {
      throw new AssignError(
        ASSIGN_CODES.WORKSPACE_FORBIDDEN,
        'Assign cannot use assistant-workspaces. Choose a registered project path.',
      );
    }
  };

  const underRoots = (resolved) => roots.some((root) => contained(resolved, root));

  const resolveExisting = (candidate) => {
    const raw = trim(candidate, 4096);
    if (!raw) return null;
    const resolved = path.resolve(raw);
    rejectManaged(resolved);
    if (!underRoots(resolved)) {
      throw new AssignError(
        ASSIGN_CODES.WORKSPACE_FORBIDDEN,
        'That path is not a registered project. Add it in Settings, then assign again.',
      );
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'The project directory does not exist.');
    }
    try {
      return fs.realpathSync(resolved);
    } catch {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'The project directory does not exist.');
    }
  };

  let target = resolveExisting(directory) || resolveExisting(projectPath) || resolveExisting(defaultProjectPath);

  if (!target && roots.length === 1) {
    rejectManaged(roots[0]);
    if (fs.existsSync(roots[0]) && fs.statSync(roots[0]).isDirectory()) {
      target = fs.realpathSync(roots[0]);
    }
  }

  if (!target) {
    throw new AssignError(
      ASSIGN_CODES.PROJECT_REQUIRED,
      'Choose a registered project path. Several projects are configured; assign cannot guess.',
    );
  }

  const branchName = trim(branch, 256);
  if (!branchName) return target;

  const match = (Array.isArray(worktrees) ? worktrees : []).find((entry) => {
    const entryBranch = trim(entry?.branch, 256);
    if (!entryBranch) return false;
    return entryBranch === branchName || entryBranch === `refs/heads/${branchName}`;
  });
  if (!match?.path) {
    throw new AssignError(
      ASSIGN_CODES.WORKTREE_NOT_FOUND,
      `No existing worktree is checked out on ${branchName}. Create that worktree in Chat first, then assign again.`,
    );
  }
  return resolveExisting(match.path);
}

/** Safe OpenCode file parts only — no base64 logging, no path inventing. */
export function sanitizeAssignFileParts(parts = []) {
  const out = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object' || part.type !== 'file') continue;
    const mime = trim(part.mime, 256);
    const url = typeof part.url === 'string' && part.url.trim() ? part.url.trim() : '';
    if (!mime || !url) continue;
    const filename = trim(part.filename, 512);
    out.push(filename ? { type: 'file', mime, url, filename } : { type: 'file', mime, url });
  }
  return out;
}

/** Stable attachment fingerprint for same-turn assign dedup (no file bodies). */
export function attachmentScopeKey(parts = []) {
  return sanitizeAssignFileParts(parts).map((part) => (
    crypto.createHash('sha256').update(JSON.stringify(part)).digest('hex')
  ));
}

export function buildAssignParts({ prompt, fileParts = [] }) {
  const text = trim(prompt, 200_000);
  if (!text) {
    throw new AssignError(ASSIGN_CODES.VALIDATION, 'assign_session requires a coding prompt for the worker session.');
  }
  const files = sanitizeAssignFileParts(fileParts);
  return [{ type: 'text', text }, ...files];
}

export function hasAssignImageParts(parts = []) {
  return sanitizeAssignFileParts(parts).some((part) => String(part.mime).toLowerCase().startsWith('image/'));
}

/**
 * Normalize a session/message model object to { providerID, modelID }.
 * Accepts `{ providerID, id }` or `{ providerID, modelID }`. Lookup failures stay null.
 */
export function normalizeAssignSessionModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const providerID = trim(model.providerID, 256);
  const modelID = trim(model.modelID, 256) || trim(model.id, 256);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

/**
 * Extract the last worker model from a session.get payload and optional messages list.
 * Priority: session.model → newest user/assistant info.model. Never throws.
 */
export function extractAssignSessionModel({ session = null, messages = null } = {}) {
  const payload = session?.data && typeof session.data === 'object' && !Array.isArray(session.data)
    ? session.data
    : session;
  const fromSession = normalizeAssignSessionModel(payload?.model);
  if (fromSession) return fromSession;

  const rows = Array.isArray(messages)
    ? messages
    : (Array.isArray(messages?.data) ? messages.data : []);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const info = row?.info && typeof row.info === 'object' ? row.info : row;
    const role = info?.role || row?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const hit = normalizeAssignSessionModel(info?.model || row?.model);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve worker model for assign.
 * - No explicit selection → reused session model (catalog match, source session) else assistant default.
 * - Explicit selection → must resolve uniquely against the connected catalog; never silent fallback.
 * - Provided but illegal/blank/overlong/conflicting fields fail closed (validation_error).
 * - Session model missing/not-in-catalog degrades to assistant default (never fails assign).
 */
export function resolveAssignWorkerModel({
  providerID,
  modelID,
  model,
  fallback = {},
  sessionModel = null,
  catalog = null,
} = {}) {
  const explicitProvider = requireProvidedString(providerID, { field: 'providerID', max: 256 });
  const explicitModel = requireProvidedString(modelID, { field: 'modelID', max: 256 });
  const combined = requireProvidedString(model, { field: 'model', max: 512 });
  const hasExplicit = Boolean(explicitProvider || explicitModel || combined);

  const fallbackProvider = trim(fallback.providerID, 256);
  const fallbackModel = trim(fallback.modelID, 256);

  if (!hasExplicit) {
    const session = normalizeAssignSessionModel(sessionModel);
    if (session && catalog && Array.isArray(catalog.models)) {
      const hit = catalog.models.find((item) => (
        item?.providerID === session.providerID && item?.modelID === session.modelID
      ));
      if (hit) {
        return {
          providerID: session.providerID,
          modelID: session.modelID,
          source: 'session',
          name: typeof hit.name === 'string' ? hit.name : null,
          acceptsImages: hit.acceptsImages === true ? true : hit.acceptsImages === false ? false : null,
        };
      }
    }
    if (!fallbackProvider || !fallbackModel) {
      throw new AssignError(ASSIGN_CODES.VALIDATION, 'Assistant is missing a connected provider/model.');
    }
    return {
      providerID: fallbackProvider,
      modelID: fallbackModel,
      source: 'assistant',
      name: null,
      acceptsImages: null,
    };
  }

  if (!catalog || !Array.isArray(catalog.models)) {
    throw new AssignError(
      ASSIGN_CODES.UPSTREAM,
      'Connected model catalog is unavailable. Cannot resolve an explicit worker model.',
    );
  }

  let wantedProvider = explicitProvider;
  let wantedModel = explicitModel;
  let fromCombinedProvider = null;
  let fromCombinedModel = null;

  if (combined) {
    if (combined.includes('/')) {
      const slash = combined.indexOf('/');
      fromCombinedProvider = combined.slice(0, slash).trim();
      fromCombinedModel = combined.slice(slash + 1).trim();
      if (!fromCombinedProvider || !fromCombinedModel) {
        throw new AssignError(
          ASSIGN_CODES.VALIDATION,
          'assign_session model must be provider/modelID when it contains a slash.',
        );
      }
    } else if (!wantedModel) {
      wantedModel = combined;
    } else {
      // model without slash while modelID already set — treat as conflicting alias only if different
      if (combined !== wantedModel && combined.toLowerCase() !== wantedModel.toLowerCase()) {
        throw new AssignError(
          ASSIGN_CODES.VALIDATION,
          'assign_session model conflicts with modelID.',
        );
      }
    }
  }

  if (fromCombinedProvider && fromCombinedModel) {
    if (wantedProvider && wantedProvider !== fromCombinedProvider) {
      throw new AssignError(
        ASSIGN_CODES.VALIDATION,
        'assign_session providerID conflicts with model provider/modelID.',
      );
    }
    if (wantedModel && wantedModel !== fromCombinedModel) {
      throw new AssignError(
        ASSIGN_CODES.VALIDATION,
        'assign_session modelID conflicts with model provider/modelID.',
      );
    }
    wantedProvider = wantedProvider || fromCombinedProvider;
    wantedModel = wantedModel || fromCombinedModel;
  }

  if (wantedProvider && !wantedModel && !fromCombinedModel && !combined) {
    // provider only — may be ambiguous across that provider's models
  }

  const models = catalog.models.filter((entry) => entry && typeof entry === 'object');
  const matches = models.filter((entry) => {
    const entryProvider = trim(entry.providerID, 256);
    const entryModel = trim(entry.modelID, 256);
    const entryName = trim(entry.name, 512);
    if (!entryProvider || !entryModel) return false;
    if (wantedProvider && wantedModel) {
      return entryProvider === wantedProvider && entryModel === wantedModel;
    }
    if (wantedProvider && !wantedModel) {
      return entryProvider === wantedProvider;
    }
    if (!wantedProvider && wantedModel) {
      const needle = wantedModel.toLowerCase();
      return entryModel.toLowerCase() === needle
        || (entryName && entryName.toLowerCase() === needle)
        || `${entryProvider}/${entryModel}`.toLowerCase() === needle;
    }
    return false;
  });

  if (matches.length === 0) {
    const label = wantedProvider && wantedModel
      ? `${wantedProvider}/${wantedModel}`
      : (wantedModel || wantedProvider || combined || 'model');
    throw new AssignError(
      ASSIGN_CODES.MODEL_NOT_FOUND,
      `No connected OpenCode model matches ${label}. Use a model from the connected catalog.`,
    );
  }
  if (matches.length > 1) {
    const options = matches
      .slice(0, 8)
      .map((entry) => `${entry.providerID}/${entry.modelID}`)
      .join(', ');
    throw new AssignError(
      ASSIGN_CODES.MODEL_AMBIGUOUS,
      `Several connected models match that selection (${options}). Pass providerID and modelID.`,
    );
  }

  const chosen = matches[0];
  return {
    providerID: chosen.providerID,
    modelID: chosen.modelID,
    source: 'explicit',
    name: typeof chosen.name === 'string' ? chosen.name : null,
    acceptsImages: chosen.acceptsImages === true,
  };
}

/**
 * Variant strategy for the worker prompt:
 * - Explicit tool variant wins (fail-closed if illegal).
 * - Default/same-as-assistant model may reuse the contact assistant variant.
 * - Cross-model explicit worker never reuses the contact variant (unsupported elsewhere).
 */
export function resolveAssignWorkerVariant({
  source,
  workerProviderID,
  workerModelID,
  assistant = {},
  variant,
} = {}) {
  if (variant !== undefined) {
    if (variant === null) return null;
    return requireProvidedString(variant, { field: 'variant', max: 256 });
  }
  const assistantVariant = trim(assistant.variant, 256);
  if (!assistantVariant) return null;
  const sameModel = trim(assistant.providerID, 256) === trim(workerProviderID, 256)
    && trim(assistant.modelID, 256) === trim(workerModelID, 256);
  if (source === 'assistant' || sameModel) return assistantVariant;
  // Cross-model: do not forward a contact-only variant onto a different worker model.
  return null;
}

function assertAssignFileCapability({ fileParts = [], acceptsImages = null } = {}) {
  if (!hasAssignImageParts(fileParts)) return;
  if (acceptsImages === true) return;
  throw new AssignError(
    ASSIGN_CODES.IMAGE_NOT_SUPPORTED,
    'The worker model does not accept images. Choose a vision-capable connected model, or assign without image attachments.',
  );
}

async function bestEffortDeleteSession(deleteSession, { sessionID, directory }) {
  if (typeof deleteSession !== 'function' || !sessionID) return;
  try {
    await raceDeadline(
      deleteSession({ sessionID, directory }),
      ASSIGN_DELETE_TIMEOUT_MS,
      'assign session.delete',
    );
  } catch {
    // Cleanup is best-effort; surface the original prompt failure.
  }
}

async function lookupAdmittedMessage(lookupMessage, { sessionID, messageID, directory }) {
  if (typeof lookupMessage !== 'function' || !sessionID || !messageID) return null;
  try {
    const found = await raceDeadline(
      lookupMessage({ sessionID, messageID, directory }),
      ASSIGN_LOOKUP_TIMEOUT_MS,
      'assign message lookup',
    );
    if (found === true) return true;
    if (found && typeof found === 'object' && (found.admitted === true || found.found === true || found.id || found.messageID)) {
      return true;
    }
    return false;
  } catch {
    return null;
  }
}

export async function assignSession(input = {}) {
  if (input.prompt === undefined || input.prompt === null) {
    throw new AssignError(ASSIGN_CODES.VALIDATION, 'assign_session requires a coding prompt for the worker session.');
  }
  const codingPrompt = requireProvidedString(input.prompt, { field: 'prompt', max: 200_000 });

  const projectDirectory = resolveAssignDirectory({
    projectPath: input.projectPath,
    directory: input.directory,
    branch: null,
    allowedRoots: input.allowedRoots,
    managedWorkspaceRoot: input.managedWorkspaceRoot,
    defaultProjectPath: input.defaultProjectPath,
    worktrees: [],
  });

  let directory = projectDirectory;
  const branchName = trim(input.branch, 256);
  if (branchName && !trim(input.directory, 4096)) {
    const worktrees = typeof input.listWorktrees === 'function'
      ? await input.listWorktrees(projectDirectory)
      : (input.worktrees || []);
    directory = resolveAssignDirectory({
      projectPath: projectDirectory,
      directory: projectDirectory,
      branch: branchName,
      allowedRoots: input.allowedRoots,
      managedWorkspaceRoot: input.managedWorkspaceRoot,
      worktrees,
    });
  }

  const assistant = input.assistant && typeof input.assistant === 'object' ? input.assistant : {};
  let resolvedModel;
  if (input.model && typeof input.model === 'object' && !Array.isArray(input.model)) {
    const objectProvider = trim(input.model.providerID, 256);
    const objectModel = trim(input.model.modelID, 256);
    if (!objectProvider || !objectModel) {
      throw new AssignError(
        ASSIGN_CODES.VALIDATION,
        'assign_session model object requires providerID and modelID.',
      );
    }
    resolvedModel = {
      providerID: objectProvider,
      modelID: objectModel,
      source: input.model.source || 'explicit',
      acceptsImages: input.model.acceptsImages === true ? true : input.model.acceptsImages === false ? false : null,
    };
  } else {
    if (input.model !== undefined && input.model !== null && typeof input.model !== 'string') {
      throw new AssignError(
        ASSIGN_CODES.VALIDATION,
        'assign_session model must be a string or resolved {providerID,modelID} object.',
      );
    }
    resolvedModel = resolveAssignWorkerModel({
      providerID: input.providerID,
      modelID: input.modelID,
      model: input.model,
      fallback: {
        providerID: assistant.providerID,
        modelID: assistant.modelID,
      },
      sessionModel: input.sessionModel,
      catalog: input.catalog,
    });
  }

  const fileParts = sanitizeAssignFileParts(input.fileParts || input.parts || []);
  assertAssignFileCapability({
    fileParts,
    acceptsImages: input.acceptsImages == null ? resolvedModel.acceptsImages : input.acceptsImages,
  });

  const sessionID = trim(input.sessionID, 256);
  const title = trim(input.title, 256) || codingPrompt.slice(0, 80);
  const messageID = trim(input.messageID, 256) || `msg_assign_${crypto.randomUUID()}`;
  const model = { providerID: resolvedModel.providerID, modelID: resolvedModel.modelID };
  const parts = buildAssignParts({ prompt: codingPrompt, fileParts });
  const workerVariant = resolveAssignWorkerVariant({
    source: resolvedModel.source,
    workerProviderID: model.providerID,
    workerModelID: model.modelID,
    assistant,
    variant: input.variant,
  });
  // Subscriber identity lives on `assigned`, not `assistant`.
  // `openchamber.assistant.assistantID` marks a hidden system binding.
  const metadata = {
    openchamber: {
      assigned: {
        from: 'contact',
        assistantID: assistant.id || assistant.assistantID || null,
        name: assistant.name || null,
      },
    },
  };
  const promptInput = {
    directory,
    messageID,
    model,
    parts,
    ...(trim(assistant.agent, 256) ? { agent: trim(assistant.agent, 256) } : {}),
    ...(workerVariant ? { variant: workerVariant } : {}),
  };

  const createTimeoutMs = Number.isFinite(input.createTimeoutMs) ? input.createTimeoutMs : ASSIGN_CREATE_TIMEOUT_MS;
  const promptTimeoutMs = Number.isFinite(input.promptTimeoutMs) ? input.promptTimeoutMs : ASSIGN_PROMPT_TIMEOUT_MS;

  if (typeof input.promptExisting !== 'function' || (!sessionID && typeof input.createSession !== 'function')) {
    throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Worker session APIs are unavailable.');
  }

  let targetSessionID = sessionID;
  if (!targetSessionID) {
    let created;
    try {
      created = await raceDeadline(
        input.createSession({ directory, title, metadata }),
        createTimeoutMs,
        'assign session.create',
      );
    } catch (error) {
      throw error instanceof AssignError
        ? error
        : new AssignError(ASSIGN_CODES.UPSTREAM, error?.timedOut ? error.message : 'Failed to create a coding session.');
    }
    targetSessionID = created?.data?.id || created?.id;
    if (created?.error || !targetSessionID) {
      throw new AssignError(ASSIGN_CODES.UPSTREAM, 'Failed to create a coding session.');
    }
  }

  let prompted;
  let promptError;
  try {
    prompted = await raceDeadline(
      input.promptExisting({ ...promptInput, sessionID: targetSessionID }),
      promptTimeoutMs,
      'assign promptAsync',
    );
  } catch (error) {
    promptError = error;
  }

  let promptStatus = 'admitted';
  if (promptError || !promptAdmitted(prompted)) {
    if (!isAmbiguousPromptFailure(promptError, prompted)) {
      if (!sessionID) await bestEffortDeleteSession(input.deleteSession, { sessionID: targetSessionID, directory });
      throw promptError instanceof AssignError
        ? promptError
        : new AssignError(ASSIGN_CODES.UPSTREAM, 'Failed to submit the prompt to the worker session.');
    }
    const found = await lookupAdmittedMessage(input.lookupMessage, { sessionID: targetSessionID, messageID, directory });
    // Keep the worker while admission is unknown; retry uses the same identities.
    if (found !== true) {
      throw new AssignError(
        ASSIGN_CODES.PROMPT_AMBIGUOUS,
        'Worker prompt admission is unknown. Resume with the same sessionID and messageID.',
        { ambiguous: true, sessionID: targetSessionID, messageID },
      );
    }
    promptStatus = 'confirmed';
  }

  return {
    sessionID: targetSessionID,
    directory,
    title,
    status: 'busy',
    reused: Boolean(sessionID),
    messageID,
    branch: branchName,
    model,
    attachmentCount: fileParts.length,
    promptStatus,
  };
}
