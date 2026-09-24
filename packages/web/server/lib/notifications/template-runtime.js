import { projectSessionMessageRecords } from '../session-turn-pages/session-message-projection.js';
import { summarizeText as summarizeSharedText } from '../text/summarization.js';

const trimmedText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

const isSessionRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.id === 'string'
    || typeof value.sessionID === 'string'
    || typeof value.title === 'string'
    || typeof value.parentID === 'string'
    || (value.metadata && typeof value.metadata === 'object');
};

/**
 * OpenCode 2 `GET /api/session/:id` returns `{ data: Session }`.
 * Legacy responses and tests still return the session object itself.
 * @param {unknown} payload
 * @returns {object | null}
 */
export const readNotificationSessionRecord = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (isSessionRecord(payload.data)) return payload.data;
  return isSessionRecord(payload) ? payload : null;
};

const TITLE_EVENT_TYPES = new Set(['session.created', 'session.updated', 'session.renamed']);

/**
 * Title carried by a session lifecycle event.
 * v2 puts it on `data.title` (`session.created` / `session.renamed`).
 * Legacy events put it on `properties.info.title`.
 * @param {object | null | undefined} payload
 * @returns {{ sessionId: string, title: string } | null}
 */
export const readSessionTitleFromEvent = (payload) => {
  if (!payload || typeof payload !== 'object' || !TITLE_EVENT_TYPES.has(payload.type)) return null;
  const bodies = [payload.properties, payload.data].filter((body) => body && typeof body === 'object' && !Array.isArray(body));
  for (const body of bodies) {
    const info = body.info && typeof body.info === 'object' ? body.info : null;
    const title = trimmedText(info?.title) || trimmedText(body.title);
    const sessionId = trimmedText(info?.id)
      || trimmedText(info?.sessionID)
      || trimmedText(body.sessionID)
      || trimmedText(body.id);
    if (title && sessionId) return { sessionId, title };
  }
  return null;
};

const readNotificationDirectory = (payload) => {
  const properties = payload?.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? payload.data : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const dataInfo = data.info && typeof data.info === 'object' ? data.info : {};
  const candidates = [
    properties.directory,
    info.directory,
    info.location?.directory,
    payload?.location?.directory,
    data.directory,
    data.location?.directory,
    dataInfo.directory,
    dataInfo.location?.directory,
  ];
  for (const value of candidates) {
    const directory = trimmedText(value);
    if (directory) return directory;
  }
  return '';
};

export const createNotificationTemplateRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    resolveGitBinaryForSpawn,
  } = deps;

  const NOTIFICATION_BODY_MAX_CHARS = 1000;
  const SESSION_INFO_CACHE_TTL_MS = 60 * 1000;

  const cachedZenModels = { models: [] };

  const sessionTitleCache = new Map();
  const sessionInfoCache = new Map();

  const createTimeoutSignal = (timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  };

  const formatProjectLabel = (label) => {
    if (!label || typeof label !== 'string') return '';
    return label
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (char) => char.toUpperCase());
  };

  const resolveNotificationTemplate = (template, variables) => {
    if (!template || typeof template !== 'string') return '';
    return template.replace(/\{(\w+)\}/g, (_match, key) => {
      const value = variables[key];
      if (value === undefined || value === null) return '';
      return String(value);
    });
  };

  const shouldApplyResolvedTemplateMessage = (template, resolved, variables) => {
    if (!resolved) {
      return false;
    }

    if (typeof template !== 'string') {
      return true;
    }

    if (template.includes('{last_message}')) {
      return typeof variables?.last_message === 'string' && variables.last_message.trim().length > 0;
    }

    return true;
  };

  const fetchFreeZenModels = async () => [];

  const resolveZenModel = async (override) => {
    const overrideModel = typeof override === 'string' ? override.trim() : '';
    if (overrideModel) return overrideModel;
    const settings = await readSettingsFromDisk().catch(() => ({}));
    return typeof settings?.zenModel === 'string' && settings.zenModel.trim().length > 0
      ? settings.zenModel.trim()
      : '';
  };

  const validateZenModelAtStartup = async () => {};

  const summarizeText = async (text, targetLength, zenModel) => {
    if (!text || typeof text !== 'string' || text.trim().length === 0) return text;
    const result = await summarizeSharedText({
      text,
      threshold: 0,
      maxLength: targetLength,
        zenModel,
      mode: 'notification',
    });
    return typeof result?.summary === 'string' && result.summary.trim().length > 0
      ? result.summary
      : text;
  };

  const isNotificationTextPart = (part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type !== 'text') return false;
    return typeof part.text === 'string' || typeof part.content === 'string';
  };

  const extractTextFromParts = (parts, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    if (!Array.isArray(parts) || parts.length === 0) return '';

    const textParts = parts
      .filter(isNotificationTextPart)
      .map((part) => part.text || part.content || '')
      .filter(Boolean);

    let text = textParts.length > 0 ? textParts.join('\n').trim() : '';

    if (maxLength > 0 && text.length > maxLength) {
      text = text.slice(0, maxLength);
    }

    return text;
  };

  const extractLastMessageText = (payload, maxLength = NOTIFICATION_BODY_MAX_CHARS) => {
    const info = payload?.properties?.info;
    if (!info) return '';

    const parts = info.parts || payload?.properties?.parts;
    const text = extractTextFromParts(parts, maxLength);
    if (text) return text;

    const content = info.content;
    if (Array.isArray(content)) {
      const textContent = content
        .filter(isNotificationTextPart)
        .map((entry) => entry.text || '')
        .filter(Boolean);
      if (textContent.length > 0) {
        let result = textContent.join('\n').trim();
        if (maxLength > 0 && result.length > maxLength) {
          result = result.slice(0, maxLength);
        }
        return result;
      }
    }

    return '';
  };

  const fetchLastAssistantMessageText = async (sessionId, messageId, maxLength = NOTIFICATION_BODY_MAX_CHARS, directory) => {
    if (!sessionId) return '';

    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}/message`, '');
      const params = new URLSearchParams({ limit: '5', order: 'desc' });
      const scopedDirectory = trimmedText(directory);
      if (scopedDirectory) params.set('directory', scopedDirectory);
      const response = await fetch(`${base}?${params.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders() : {}),
        },
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) return '';

      const payload = await response.json().catch(() => null);
      // Legacy lists are a chronological array. OpenCode 2 returns `{ data }`
      // and `order=desc` puts the newest turn first.
      const newestFirst = !Array.isArray(payload);
      const records = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.data) ? payload.data : null);
      if (!records) return '';
      const projected = projectSessionMessageRecords(records);
      const messages = newestFirst ? projected : [...projected].reverse();

      let target = null;
      if (messageId) {
        target = messages.find((message) => message?.info?.id === messageId && message?.info?.role === 'assistant');
      }
      if (!target) {
        target = messages.find((message) => (
          message?.info?.role === 'assistant'
          && extractTextFromParts(message.parts, maxLength).length > 0
        ));
      }

      if (!target || !Array.isArray(target.parts)) return '';

      return extractTextFromParts(target.parts, maxLength);
    } catch {
      return '';
    }
  };

  const cacheSessionTitle = (sessionId, title) => {
    const id = trimmedText(sessionId);
    const name = trimmedText(title);
    if (id && name) sessionTitleCache.set(id, name);
  };

  const getCachedSessionTitle = (sessionId) => {
    return sessionTitleCache.get(sessionId) ?? null;
  };

  const maybeCacheSessionInfoFromEvent = (payload) => {
    const titled = readSessionTitleFromEvent(payload);
    if (!titled) return;
    cacheSessionTitle(titled.sessionId, titled.title);
  };

  const fetchSessionInfo = async (sessionId, directory) => {
    if (!sessionId) return null;

    const cached = sessionInfoCache.get(sessionId);
    if (cached && Date.now() - cached.at < SESSION_INFO_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders() : {}),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        console.warn(`[Notification] fetchSessionInfo: ${response.status} for session ${sessionId}`);
        return null;
      }
      const session = readNotificationSessionRecord(await response.json().catch(() => null));
      if (session) {
        sessionInfoCache.set(sessionId, { data: session, at: Date.now() });
        return session;
      }
      return null;
    } catch (error) {
      console.warn(`[Notification] fetchSessionInfo failed for ${sessionId}:`, error?.message || error);
      return null;
    }
  };

  const buildTemplateVariables = async (payload, sessionId) => {
    const info = payload?.properties?.info || {};

    const fromEvent = readSessionTitleFromEvent(payload);
    let sessionTitle = trimmedText(payload?.properties?.sessionTitle)
      || trimmedText(payload?.properties?.session?.title)
      || trimmedText(info.sessionTitle)
      || (fromEvent && (!sessionId || fromEvent.sessionId === sessionId) ? fromEvent.title : '');

    if (!sessionTitle && sessionId) {
      const cached = getCachedSessionTitle(sessionId);
      if (cached) {
        sessionTitle = cached;
      }
    }

    let sessionInfo = null;
    if (!sessionTitle && sessionId) {
      sessionInfo = await fetchSessionInfo(sessionId, readNotificationDirectory(payload));
      const fetchedTitle = trimmedText(sessionInfo?.title);
      if (fetchedTitle) {
        sessionTitle = fetchedTitle;
        cacheSessionTitle(sessionId, sessionTitle);
      }
    }

    const eventAgent = trimmedText(info.agent) || trimmedText(info.mode);
    const eventModel = trimmedText(info.modelID)
      || trimmedText(info.model?.modelID)
      || trimmedText(info.model?.id);
    if ((!eventAgent || !eventModel) && sessionId && !sessionInfo) {
      sessionInfo = await fetchSessionInfo(sessionId, readNotificationDirectory(payload));
    }

    const agentName = (() => {
      const mode = eventAgent || trimmedText(sessionInfo?.agent) || trimmedText(sessionInfo?.mode);
      if (!mode) return 'Agent';
      return mode.split(/[-_\s]+/).filter(Boolean)
        .map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(' ');
    })();

    const modelName = (() => {
      const raw = eventModel
        || trimmedText(sessionInfo?.model?.modelID)
        || trimmedText(sessionInfo?.model?.id)
        || trimmedText(sessionInfo?.modelID);
      if (!raw) return 'Assistant';
      return raw.split(/[-_]+/).filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    })();

    let projectName = '';
    let branch = '';
    let worktreeDir = '';

    const infoPath = info.path;
    if (typeof infoPath?.root === 'string' && infoPath.root.length > 0) {
      worktreeDir = infoPath.root;
    } else if (typeof infoPath?.cwd === 'string' && infoPath.cwd.length > 0) {
      worktreeDir = infoPath.cwd;
    }

    try {
      const settings = await readSettingsFromDisk();
      const projects = Array.isArray(settings.projects) ? settings.projects : [];

      if (worktreeDir) {
        const normalizedDir = worktreeDir.replace(/\/+$/, '');
        const matchedProject = projects.find((project) => {
          if (!project || typeof project.path !== 'string') return false;
          return project.path.replace(/\/+$/, '') === normalizedDir;
        });
        if (matchedProject && typeof matchedProject.label === 'string' && matchedProject.label.trim().length > 0) {
          projectName = matchedProject.label.trim();
        } else {
          projectName = normalizedDir.split('/').filter(Boolean).pop() || '';
        }
      } else {
        const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
        const activeProject = activeId ? projects.find((project) => project && project.id === activeId) : projects[0];
        if (activeProject) {
          projectName = typeof activeProject.label === 'string' && activeProject.label.trim().length > 0
            ? activeProject.label.trim()
            : typeof activeProject.path === 'string'
              ? activeProject.path.split('/').pop() || ''
              : '';
          worktreeDir = typeof activeProject.path === 'string' ? activeProject.path : '';
        }
      }
    } catch {
      if (worktreeDir && !projectName) {
        projectName = worktreeDir.split('/').filter(Boolean).pop() || '';
      }
    }

    if (worktreeDir) {
      try {
        const { simpleGit } = await import('simple-git');
        const git = simpleGit({
          baseDir: worktreeDir,
          spawnOptions: { windowsHide: true },
          binary: resolveGitBinaryForSpawn(),
        });
        branch = await Promise.race([
          git.revparse(['--abbrev-ref', 'HEAD']),
          new Promise((_, reject) => setTimeout(() => reject(new Error('git timeout')), 3000)),
        ]).catch(() => '');
      } catch {
      }
    }

    return {
      project_name: formatProjectLabel(projectName),
      worktree: worktreeDir,
      branch: typeof branch === 'string' ? branch.trim() : '',
      session_name: sessionTitle,
      agent_name: agentName,
      model_name: modelName,
      last_message: '',
      session_id: sessionId || '',
    };
  };

  const getCachedZenModels = () => cachedZenModels;

  return {
    createTimeoutSignal,
    formatProjectLabel,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    fetchFreeZenModels,
    resolveZenModel,
    validateZenModelAtStartup,
    summarizeText,
    extractTextFromParts,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    maybeCacheSessionInfoFromEvent,
    buildTemplateVariables,
    getCachedZenModels,
  };
};
