// Session title refresh: after a session goes idle, regenerate the sidebar
// title from the conversation's MAIN SUBJECT (overall feature / goal), not
// just the last wrap-up utterance. OpenCode only titles once from the first
// user message; long sessions need refresh, but continuing the same work
// should keep naming the thing being done — not "commit and push". This
// watcher throttles to at most one refresh per session every TITLE_THROTTLE_MS
// and never overwrites a user-renamed title.
//
// Purely event-driven: only sessions that transition busy→idle while the
// server is running ever generate anything. No backfill, no session scans.

import fs from 'fs';
import os from 'os';
import path from 'path';

const OPENCHAMBER_SETTINGS_FILE = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

/** Quiet settle after idle before we spend a small-model call. */
export const TITLE_QUIET_MS = 15_000;
/** At most one auto title refresh per session in this window. */
export const TITLE_THROTTLE_MS = 5 * 60_000;
/** Fetch enough recent messages to find a subject anchor around the title window. */
const TRANSCRIPT_MESSAGE_LIMIT = 16;
/** Latest user/assistant turns used for title generation. */
const TRANSCRIPT_MAX_TURNS = 5;
const TRANSCRIPT_USER_CHAR_LIMIT = 2_000;
const TRANSCRIPT_ASSISTANT_CHAR_LIMIT = 1_200;
/** Hard cap so long sessions / huge parts stay under small-model budget. */
const TRANSCRIPT_MAX_CHARS = 20_000;
const TITLE_CHAR_LIMIT = 80;
const FETCH_TIMEOUT_MS = 5_000;

const PARENT_TITLE_PREFIX = 'New session - ';
const CHILD_TITLE_PREFIX = 'Child session - ';
const DEFAULT_TITLE_RE = new RegExp(
  `^(${PARENT_TITLE_PREFIX}|${CHILD_TITLE_PREFIX})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
);
const FORK_TITLE_RE = / \(fork #\d+\)$/;
const MULTI_RUN_GROUP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const MULTI_RUN_GROUP = /^g[1-9]\d*$/;

// Hard generation switch (default on). When off, no small-model calls and no
// title writes happen. Existing titles stay untouched.
const isSessionTitleRefreshEnabled = () => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(raw);
    return settings?.sessionTitleRefreshEnabled !== false;
  } catch {
    return true;
  }
};

/** Matches OpenCode's Session.isDefaultTitle — still waiting for first auto title. */
export const isDefaultSessionTitle = (title) => {
  if (typeof title !== 'string' || !title) return false;
  return DEFAULT_TITLE_RE.test(title);
};

export const isForkedSessionTitle = (title) => typeof title === 'string' && FORK_TITLE_RE.test(title);

/**
 * Multi-run / fusion session titles are structural (`slug/provider/model[/n]`).
 * Never rewrite those — the UI parses them for grouping.
 */
export const looksLikeMultiRunSessionTitle = (title) => {
  if (typeof title !== 'string' || !title) return false;
  const segments = title.split('/');
  if (segments.length < 3 || segments.length > 5) return false;
  const [groupSlug] = segments;
  if (!MULTI_RUN_GROUP_SLUG.test(groupSlug)) return false;
  if (segments.length === 3) {
    return Boolean(segments[1]?.trim() && segments[2]?.trim());
  }
  if (segments.length === 4) {
    if (MULTI_RUN_GROUP.test(segments[1])) {
      return Boolean(segments[2]?.trim() && segments[3]?.trim());
    }
    return Boolean(segments[1]?.trim() && segments[2]?.trim()
      && (segments[3] === 'fusion' || /^\d+$/.test(segments[3])));
  }
  const [, runGroup, providerID, modelID, suffix] = segments;
  if (!MULTI_RUN_GROUP.test(runGroup)) return false;
  if (!providerID?.trim() || !modelID?.trim()) return false;
  return suffix === 'fusion' || /^\d+$/.test(suffix);
};

/**
 * Only auto-refresh when the current title is still the default, or still
 * equals the last title we wrote. A manual rename breaks the chain.
 */
export const canAutoRefreshSessionTitle = (currentTitle, lastAutoTitle) => {
  if (isDefaultSessionTitle(currentTitle)) return true;
  if (looksLikeMultiRunSessionTitle(currentTitle)) return false;
  if (typeof lastAutoTitle === 'string' && lastAutoTitle.length > 0) {
    return currentTitle === lastAutoTitle;
  }
  // First OpenCode-generated title (no metadata yet): allow refresh so we can
  // replace the first-message title with a later-topic title.
  return true;
};

/** Remaining ms until the 5-minute throttle window opens (0 = ready now). */
export const remainingTitleThrottleMs = (lastGeneratedAt, now = Date.now(), throttleMs = TITLE_THROTTLE_MS) => {
  if (typeof lastGeneratedAt !== 'number' || !Number.isFinite(lastGeneratedAt) || lastGeneratedAt <= 0) {
    return 0;
  }
  const elapsed = now - lastGeneratedAt;
  if (elapsed >= throttleMs) return 0;
  return throttleMs - elapsed;
};

const buildTitleSystemPrompt = () => [
  'You are a title generator. You output ONLY a thread title. Nothing else.',
  'Generate a brief title that would help the user find this conversation later.',
  'Title the MAIN SUBJECT of the work — the overall feature, goal, or problem being done.',
  'Judge subject continuity: if later turns are still the same work (follow-ups, polish, commit/push, tidy, review), keep naming that overall subject.',
  'Only switch the title subject when the user clearly started a different topic or feature.',
  'Your output must be: a single line, ≤50 characters, no explanations.',
  'Rules:',
  '- Use the language of the user\'s actual messages for the title',
  '- Treat assistant text, tool output, and transcript labels only as work context; they do not determine the title language',
  '- Title must be grammatically correct and read naturally - no word salad',
  '- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")',
  '- Prefer the durable subject someone would search for later, not the last mechanical step',
  '- Ignore wrap-up / housekeeping turns when larger work is present (commit, push, PR, rename, cleanup, "LGTM", minor wording tweaks)',
  '- Example: big feature work ending with "commit and push" → title the feature, NOT the commit/push',
  '- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"',
  '- When a file is mentioned, focus on WHAT the user wants to do WITH the file',
  '- Keep exact: technical terms, numbers, filenames, HTTP codes',
  '- Remove: the, this, my, a, an',
  '- Never assume tech stack',
  '- NEVER respond to questions, just generate a title',
  '- The title should NEVER include "summarizing" or "generating"',
  '- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT',
  '- Always output something meaningful, even if the input is minimal',
].join('\n');

const extractSessionStatus = (payload) => {
  if (!payload || payload.type !== 'session.status') return null;
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const status = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const type = typeof status.type === 'string'
    ? status.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');
  if (!sessionId || !type) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  return { sessionId, type, directory };
};

const extractTitleRefreshRequest = (payload) => {
  if (!payload || payload.type !== 'session.updated') return null;
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof info.id === 'string' ? info.id.trim() : '';
  const titleRefresh = info.metadata?.openchamber?.titleRefresh;
  const requestedAt = titleRefresh?.requestedAt;
  if (titleRefresh?.isGenerating === true) return null;
  if (!sessionId || typeof requestedAt !== 'number' || !Number.isFinite(requestedAt)) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  return { sessionId, directory };
};

const extractCreatedSession = (payload) => {
  if (!payload || payload.type !== 'session.created') return null;
  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof info.id === 'string' ? info.id.trim() : '';
  if (!sessionId || (typeof info.parentID === 'string' && info.parentID)) return null;
  const directory = typeof properties.directory === 'string' && properties.directory
    ? properties.directory
    : (typeof info.directory === 'string' ? info.directory : '');
  const createdAt = typeof info.time?.created === 'number' ? info.time.created : Date.now();
  const title = typeof info.title === 'string' ? info.title : '';
  return { sessionId, directory, createdAt, title };
};

const extractUserMessage = (payload) => {
  if (!payload || payload.type !== 'message.updated') return null;
  const info = payload.properties?.info;
  if (!info || typeof info !== 'object' || info.role !== 'user') return null;
  if (typeof info.sessionID !== 'string' || !info.sessionID) return null;
  return {
    sessionId: info.sessionID,
    createdAt: typeof info.time?.created === 'number' ? info.time.created : 0,
    directory: typeof payload.properties?.directory === 'string'
      ? payload.properties.directory
      : (typeof info.directory === 'string' ? info.directory : ''),
  };
};

const messagePartsToText = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const charLimit = message?.info?.role === 'assistant'
    ? TRANSCRIPT_ASSISTANT_CHAR_LIMIT
    : TRANSCRIPT_USER_CHAR_LIMIT;
  return parts
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
    .slice(0, charLimit);
};

const isRealUserMessage = (message) => {
  const info = message?.info;
  if (!info || info.role !== 'user') return false;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  if (parts.length === 0) return true;
  return !parts.every((part) => part && typeof part === 'object' && part.synthetic === true);
};

/** Compaction marks a hard history boundary — title context stops there. */
const messageHasCompaction = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts.some((part) => part && typeof part === 'object' && part.type === 'compaction');
};

/** Keep only messages after the most recent compaction part (if any). */
const scopeMessagesAfterCompaction = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messageHasCompaction(messages[i])) {
      return messages.slice(i + 1);
    }
  }
  return messages;
};

const clampTranscriptChars = (transcript, maxChars = TRANSCRIPT_MAX_CHARS) => {
  if (typeof transcript !== 'string' || transcript.length <= maxChars) return transcript || '';
  // Prefer the latest content when over budget.
  return `…\n${transcript.slice(-(maxChars - 2))}`;
};

const cleanGeneratedTitle = (raw) => {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!cleaned) return '';
  if (cleaned.length > TITLE_CHAR_LIMIT) {
    return `${cleaned.slice(0, TITLE_CHAR_LIMIT - 1).trim()}…`;
  }
  return cleaned;
};

const readTitleRefreshMeta = (session) => {
  const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  const openchamber = metadata.openchamber && typeof metadata.openchamber === 'object'
    ? metadata.openchamber
    : {};
  const titleRefresh = openchamber.titleRefresh && typeof openchamber.titleRefresh === 'object'
    ? openchamber.titleRefresh
    : {};
  return {
    metadata,
    openchamber,
    titleRefresh,
    lastAutoTitle: typeof titleRefresh.lastAutoTitle === 'string' ? titleRefresh.lastAutoTitle : '',
    generatedAt: typeof titleRefresh.generatedAt === 'number' ? titleRefresh.generatedAt : 0,
    forMessageID: typeof titleRefresh.forMessageID === 'string' ? titleRefresh.forMessageID : '',
  };
};

/**
 * Build a short transcript for title generation.
 * Uses only the latest N turns (default 5) from a bounded recent fetch —
 * never the full session. Stops at the most recent compaction boundary.
 * When the latest window does not include the first real user message after
 * that boundary, prepend that subject anchor so wrap-up turns do not erase
 * the feature being done. Final transcript is hard-capped under 20K chars.
 */
export const buildLatestTitleTranscript = (
  messages,
  { maxTurns = TRANSCRIPT_MAX_TURNS, maxChars = TRANSCRIPT_MAX_CHARS } = {},
) => {
  const scoped = scopeMessagesAfterCompaction(messages);
  const turns = [];
  for (let i = scoped.length - 1; i >= 0 && turns.length < maxTurns * 2; i -= 1) {
    const message = scoped[i];
    // Defensive: never walk past a compaction part even if scoping missed one.
    if (messageHasCompaction(message)) break;
    const role = message?.info?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'user' && !isRealUserMessage(message)) continue;
    const text = messagePartsToText(message);
    if (!text) continue;
    turns.unshift({ role, text, id: message?.info?.id });
  }
  if (turns.length === 0) return { transcript: '', lastAssistantId: '', realUserCount: 0 };

  const realUserCount = scoped.filter(isRealUserMessage).length;
  let lastAssistantId = '';
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].role === 'assistant') {
      lastAssistantId = turns[i].id || '';
      break;
    }
  }

  // First real user turn after compaction as subject anchor when it fell
  // outside the latest window (still within the compact-scoped slice only).
  let subjectAnchor = '';
  const latestIds = new Set(turns.map((turn) => turn.id).filter(Boolean));
  for (let i = 0; i < scoped.length; i += 1) {
    const message = scoped[i];
    if (!isRealUserMessage(message)) continue;
    const text = messagePartsToText(message);
    if (!text) continue;
    const id = message?.info?.id;
    if (id && latestIds.has(id)) break;
    subjectAnchor = text;
    break;
  }

  const latestTranscript = turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}:\n${turn.text}`)
    .join('\n\n');
  const transcript = clampTranscriptChars(
    subjectAnchor
      ? `Earlier subject anchor:\nUser:\n${subjectAnchor}\n\nLatest turns:\n${latestTranscript}`
      : latestTranscript,
    maxChars,
  );
  // Language sample from real user text only — transcript wrappers are English labels.
  const latestUserText = [...turns].reverse().find((turn) => turn.role === 'user')?.text || '';
  const languageSample = (latestUserText || subjectAnchor || transcript)
    .slice(0, 200)
    .replace(/\s+/g, ' ')
    .trim();
  return { transcript, lastAssistantId, realUserCount, subjectAnchor, languageSample };
};

export const createSessionTitleRuntime = ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSmallModelService,
  quietMs = TITLE_QUIET_MS,
  throttleMs = TITLE_THROTTLE_MS,
  now = () => Date.now(),
  isTitleRefreshEnabled = isSessionTitleRefreshEnabled,
}) => {
  const timers = new Map();
  const inflight = new Set();
  const forcedRefreshes = new Set();
  const initialRefreshes = new Set();
  const newSessions = new Set();
  const forkFirstSendPending = new Map();
  const forkFirstRefreshes = new Set();
  /** In-memory throttle timestamps (metadata also persists across restarts). */
  const lastGeneratedAtBySession = new Map();
  let stopped = false;

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing.timer);
      timers.delete(sessionId);
    }
  };

  const openCodeFetch = async (pathname, { directory, method = 'GET', body } = {}) => {
    const base = buildOpenCodeUrl(pathname, '');
    const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`OpenCode ${method} ${pathname} failed with ${response.status}`);
    }
    return response.json().catch(() => null);
  };

  const fetchRecentMessages = async (sessionId, directory) => {
    const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
    const params = new URLSearchParams({ limit: String(TRANSCRIPT_MESSAGE_LIMIT) });
    if (directory) params.set('directory', directory);
    const response = await fetch(`${base}?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const messages = await response.json().catch(() => null);
    return Array.isArray(messages) ? messages : null;
  };

  const resolveLastGeneratedAt = (sessionId, metaGeneratedAt) => {
    const memory = lastGeneratedAtBySession.get(sessionId) || 0;
    return Math.max(memory, metaGeneratedAt || 0);
  };

  const clearTitleGenerationState = async (sessionId, directory) => {
    const session = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    if (!session || typeof session !== 'object') return;

    const meta = readTitleRefreshMeta(session);
    if (meta.titleRefresh.isGenerating !== true) return;
    const {
      isGenerating: _isGenerating,
      requestedAt: _requestedAt,
      ...titleRefresh
    } = meta.titleRefresh;
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...meta.metadata,
          openchamber: {
            ...meta.openchamber,
            titleRefresh,
          },
        },
      },
    });
  };

  const setTitleGenerationError = async (sessionId, directory, error) => {
    const session = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    if (!session || typeof session !== 'object') return;

    const meta = readTitleRefreshMeta(session);
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...meta.metadata,
          openchamber: {
            ...meta.openchamber,
            titleRefresh: {
              ...meta.titleRefresh,
              lastError: error instanceof Error ? error.message : String(error),
              failedAt: now(),
            },
          },
        },
      },
    });
  };

  const recordUserActivity = async (sessionId, directory, createdAt) => {
    if (!Number.isFinite(createdAt) || createdAt <= 0) return;
    const session = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    if (!session || typeof session !== 'object') return;

    const meta = readTitleRefreshMeta(session);
    const previous = Number(meta.titleRefresh.activityUpdatedAt);
    const activityUpdatedAt = Number.isFinite(previous) ? Math.max(previous, createdAt) : createdAt;
    if (activityUpdatedAt === previous) return;
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...meta.metadata,
          openchamber: {
            ...meta.openchamber,
            titleRefresh: {
              ...meta.titleRefresh,
              activityUpdatedAt,
            },
          },
        },
      },
    });
  };

  // Declared early so generateTitle can re-arm when still inside the throttle window.
  let armTimer = (_sessionId, _directory, _delayMs) => {};

  const generateTitle = async (sessionId, directory) => {
    const forceRefresh = forcedRefreshes.delete(sessionId);
    const initialRefresh = initialRefreshes.delete(sessionId);
    const forkFirstRefresh = forkFirstRefreshes.delete(sessionId);
    if (!forceRefresh && !isTitleRefreshEnabled()) return;

    const session = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch((error) => {
        console.warn(`[session-title] session fetch failed: ${error?.message || error}`);
        return null;
      });
    if (!session || typeof session !== 'object') return;
    // Sub-agent/task sessions never surface as top-level sidebar rows.
    if (typeof session.parentID === 'string' && session.parentID) return;

    const currentTitle = typeof session.title === 'string' ? session.title : '';
    if (looksLikeMultiRunSessionTitle(currentTitle)) return;

    const meta = readTitleRefreshMeta(session);
    const canRefreshForkTitle = forkFirstRefresh && isForkedSessionTitle(currentTitle);
    if (!canAutoRefreshSessionTitle(currentTitle, meta.lastAutoTitle) && !canRefreshForkTitle) {
      return;
    }

    const throttleLeft = remainingTitleThrottleMs(
      resolveLastGeneratedAt(sessionId, meta.generatedAt),
      now(),
      throttleMs,
    );
    if (throttleLeft > 0 && !forceRefresh && !initialRefresh && !forkFirstRefresh) {
      // Re-arm for when the window opens — do not drop the pending refresh.
      armTimer(sessionId, directory, throttleLeft);
      return;
    }

    const messages = await fetchRecentMessages(sessionId, directory);
    if (!messages || messages.length === 0) return;

    const { transcript, lastAssistantId, realUserCount, languageSample } = buildLatestTitleTranscript(messages);
    if (!transcript) return;

    // Let OpenCode's first-message title land first. We only refresh once the
    // conversation has moved on (2+ real user turns), unless the title is
    // still the default placeholder.
    if (!forceRefresh && !initialRefresh && !forkFirstRefresh && realUserCount < 2 && !isDefaultSessionTitle(currentTitle)) {
      return;
    }

    // Same tail as last refresh — nothing new to summarize.
    if (!forceRefresh && !initialRefresh && !forkFirstRefresh && lastAssistantId && lastAssistantId === meta.forMessageID && !isDefaultSessionTitle(currentTitle)) {
      return;
    }

    let lastAssistantInfo = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]?.info;
      if (info?.role === 'assistant') {
        lastAssistantInfo = info;
        break;
      }
    }

    // Keep a durable subject hint when we already have a non-default auto title.
    // Helps the model stay on the feature when the latest turns are wrap-up only.
    const currentSubjectHint = (!isDefaultSessionTitle(currentTitle) && currentTitle)
      ? `\n\nCurrent title (keep this subject unless the user clearly switched topics): "${currentTitle}"`
      : '';
    const { generateSmallModelText } = await getSmallModelService();
    let generated;
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        metadata: {
          ...meta.metadata,
          openchamber: {
            ...meta.openchamber,
            titleRefresh: {
              ...meta.titleRefresh,
              isGenerating: true,
              lastError: undefined,
              failedAt: undefined,
            },
          },
        },
      },
    }).catch((error) => {
      console.warn('[session-title] failed to set generation state:', error?.message || error);
    });
    try {
      generated = await generateSmallModelText({
        // Background feature: use the configured or displayed default Summary
        // AI model, while arbitrary small-model fallbacks stay on the session
        // provider.
        restrictToPreferredProvider: true,
        purpose: 'session-title',
        prompt: `Conversation turns for title generation (name the MAIN SUBJECT of the work, not the last wrap-up step):\n\n${transcript}${currentSubjectHint}\n\nWrite the title in the user's language. Use this actual user-message sample as the language source: "${languageSample}"`,
        system: buildTitleSystemPrompt(),
        maxOutputTokens: 64,
        directory,
        preferredProviderID: typeof lastAssistantInfo?.providerID === 'string' ? lastAssistantInfo.providerID : undefined,
        preferredModelID: typeof lastAssistantInfo?.modelID === 'string' ? lastAssistantInfo.modelID : undefined,
      });
    } catch (error) {
      if (Number(error?.statusCode) !== 404) {
        console.warn('[session-title] generation failed:', error?.message || error);
      }
      await setTitleGenerationError(sessionId, directory, error).catch((metadataError) => {
        console.warn('[session-title] failed to publish generation error:', metadataError?.message || metadataError);
      });
      return;
    } finally {
      await clearTitleGenerationState(sessionId, directory).catch((error) => {
        console.warn('[session-title] failed to clear generation state:', error?.message || error);
      });
    }

    const nextTitle = cleanGeneratedTitle(generated?.text);
    if (!nextTitle) return;
    if (nextTitle === currentTitle) {
      // Still stamp metadata so we do not keep re-calling for the same tail.
      lastGeneratedAtBySession.set(sessionId, now());
      return;
    }

    // Re-check before write: user may have renamed, or a new message arrived.
    const freshSession = await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, { directory })
      .catch(() => null);
    if (!freshSession || typeof freshSession !== 'object') return;
    const freshTitle = typeof freshSession.title === 'string' ? freshSession.title : '';
    const freshMeta = readTitleRefreshMeta(freshSession);
    if (!canAutoRefreshSessionTitle(freshTitle, freshMeta.lastAutoTitle || meta.lastAutoTitle)
      && !(forkFirstRefresh && isForkedSessionTitle(freshTitle))) {
      return;
    }

    const latestMessages = await fetchRecentMessages(sessionId, directory);
    const latestAssistantId = (() => {
      if (!latestMessages) return null;
      for (let i = latestMessages.length - 1; i >= 0; i -= 1) {
        const info = latestMessages[i]?.info;
        if (info?.role === 'assistant') return info.id;
        if (info?.role === 'user') return null;
      }
      return null;
    })();
    if (lastAssistantId && latestAssistantId && latestAssistantId !== lastAssistantId) {
      console.log('[session-title] tail moved on, dropping result');
      return;
    }

    const generatedAt = now();
    lastGeneratedAtBySession.set(sessionId, generatedAt);

    const currentMetadata = freshMeta.metadata;
    const currentNamespace = freshMeta.openchamber;

    console.log(`[session-title] refreshed ${sessionId} → "${nextTitle}" via ${generated.providerID}/${generated.modelID}`);
    await openCodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
      directory,
      method: 'PATCH',
      body: {
        title: nextTitle,
        metadata: {
          ...currentMetadata,
          openchamber: {
            ...currentNamespace,
            titleRefresh: {
              ...freshMeta.titleRefresh,
              lastAutoTitle: nextTitle,
              forMessageID: lastAssistantId || latestAssistantId || '',
              generatedAt,
            },
          },
        },
      },
    });
  };

  armTimer = (sessionId, directory, delayMs = quietMs) => {
    clearTimer(sessionId);
    const wait = Math.max(0, delayMs);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      if (stopped || inflight.has(sessionId)) return;
      inflight.add(sessionId);
      generateTitle(sessionId, directory)
        .catch((error) => {
          console.warn('[session-title] failed:', error?.message || error);
        })
        .finally(() => {
          inflight.delete(sessionId);
        });
    }, wait);
    if (typeof timer?.unref === 'function') timer.unref();
    timers.set(sessionId, { timer, armedAt: now() });
  };

  const processPayload = (payload, directoryHint = '') => {
    if (stopped) return;
    const createdSession = extractCreatedSession(payload);
    if (createdSession) {
      if (isForkedSessionTitle(createdSession.title)) {
        forkFirstSendPending.set(createdSession.sessionId, {
          createdAt: createdSession.createdAt,
          directory: createdSession.directory || directoryHint,
          hasNewUserMessage: false,
        });
        return;
      }
      newSessions.add(createdSession.sessionId);
      return;
    }
    const titleRefreshRequest = extractTitleRefreshRequest(payload);
    if (titleRefreshRequest) {
      forcedRefreshes.add(titleRefreshRequest.sessionId);
      armTimer(titleRefreshRequest.sessionId, titleRefreshRequest.directory || directoryHint, 0);
      return;
    }
    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type === 'idle') {
        const pendingFork = forkFirstSendPending.get(status.sessionId);
        if (pendingFork) {
          if (pendingFork.hasNewUserMessage) {
            forkFirstSendPending.delete(status.sessionId);
            forkFirstRefreshes.add(status.sessionId);
            armTimer(status.sessionId, status.directory || pendingFork.directory || directoryHint, 0);
          }
          return;
        }
        if (newSessions.delete(status.sessionId)) {
          initialRefreshes.add(status.sessionId);
          armTimer(status.sessionId, status.directory || directoryHint, 0);
        } else {
          armTimer(status.sessionId, status.directory || directoryHint, quietMs);
        }
      } else {
        clearTimer(status.sessionId);
      }
      return;
    }
    const userMessage = extractUserMessage(payload);
    if (userMessage) {
      const pendingFork = forkFirstSendPending.get(userMessage.sessionId);
      if (pendingFork && userMessage.createdAt > pendingFork.createdAt) {
        pendingFork.hasNewUserMessage = true;
      }
      void recordUserActivity(
        userMessage.sessionId,
        userMessage.directory || directoryHint,
        userMessage.createdAt,
      ).catch((error) => {
        console.warn('[session-title] failed to record user activity:', error?.message || error);
      });
      // OpenCode re-emits message.updated for OLD user messages after the
      // session settles. Only a message created after the timer was armed
      // means the user actually moved on.
      const armed = timers.get(userMessage.sessionId);
      if (armed && userMessage.createdAt >= armed.armedAt) {
        clearTimer(userMessage.sessionId);
      }
    }
  };

  const stop = () => {
    stopped = true;
    for (const { timer } of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  return { processPayload, stop, armTimer };
};
