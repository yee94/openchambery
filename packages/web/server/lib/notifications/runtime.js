export const createNotificationTriggerRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    prepareNotificationLastMessage,
    buildTemplateVariables,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    sendLiveActivityEnd,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = deps;
  let getIsSessionAutoAccepting = deps.getIsSessionAutoAccepting;
  const setGetIsSessionAutoAccepting = (resolver) => {
    getIsSessionAutoAccepting = typeof resolver === 'function' ? resolver : undefined;
  };

  // App-icon badge for native push: the set of DISTINCT collapse-ids (the push
  // `tag`, e.g. `ready-<sessionId>` / `permission-<requestKey>`) we've sent since
  // the app was last foregrounded. The badge is the absolute APNs `aps.badge`.
  //
  // We key by `tag`, not sessionId, because the tag IS the banner identity: iOS
  // uses it as `apns-collapse-id`, so same-tag pushes REPLACE one banner while
  // different tags are distinct banners. One session can raise several banners
  // (ready + question + permission are different tags), so counting sessionIds
  // both over- and under-counts the lock-screen stack; counting tags mirrors it.
  //
  // We deliberately do NOT derive this from the live attention snapshot
  // (needsAttention/isViewed): that machinery is for in-app indicators on
  // connected clients — a backgrounded client stays "viewing", and needsAttention
  // is set by a separate session.status event that races the push trigger. The
  // set is cleared when a UI client reports visible (`clearPendingPushBadge`),
  // the same moment the device zeroes its icon badge on becomeActive.
  const pendingPushTags = new Set();
  const clearPendingPushBadge = () => {
    pendingPushTags.clear();
  };
  const trackPushAndCountBadge = (tag) => {
    if (typeof tag === 'string' && tag.length > 0) {
      pendingPushTags.add(tag);
    }
    return pendingPushTags.size;
  };

  const stringifyApnsData = (data) => {
    if (!data || typeof data !== 'object') return undefined;
    const next = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      next[key] = value;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };

  // Generic notification for native push (per the mobile design): a fixed, scenario-based
  // title + the session name as the body. No model/project/message content crosses the relay.
  // Title strings are localized per device token locale inside sendApnsToAllUiSessions.
  // Contact turns opt out via preserveAlert — those keep nickname + spoken text.
  const toApnsGenericPayload = (payload) => {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const sessionName = typeof data.sessionName === 'string' && data.sessionName.trim().length > 0
      ? data.sessionName.trim()
      : '';
    const type = typeof data.type === 'string' ? data.type : undefined;
    return {
      type,
      sessionName,
      badge: trackPushAndCountBadge(typeof payload?.tag === 'string' ? payload.tag : undefined),
      tag: payload?.tag,
      // sessionId is forwarded so a tapped push can deep-link; it is an opaque id, not content.
      data: typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : undefined,
    };
  };

  const toApnsContactPayload = (payload) => {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const title = typeof payload?.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'Assistant';
    const body = typeof payload?.body === 'string' ? payload.body : '';
    return {
      title,
      body,
      badge: trackPushAndCountBadge(typeof payload?.tag === 'string' ? payload.tag : undefined),
      tag: payload?.tag,
      data: stringifyApnsData({
        assistantID: data.assistantID,
        url: typeof data.assistantID === 'string' && data.assistantID.trim()
          ? `openchamber://assistant/${encodeURIComponent(data.assistantID.trim())}`
          : (typeof data.url === 'string' ? data.url : undefined),
      }),
    };
  };

  // Fan a notification out to every delivery channel: browser web-push (full templated
  // payload) and native iOS APNs (generic model-based text, unless preserveAlert).
  // Both share the dedup tag; a failure in one channel must not block the other.
  // Visibility on any other client never suppresses delivery — every subscribed
  // surface gets the push.
  const fanoutPush = (payload, options = {}) => Promise.all([
    Promise.resolve(sendPushToAllUiSessions?.(payload, options)).catch((error) => {
      console.warn('[Push] web-push fanout failed:', error?.message ?? error);
    }),
    Promise.resolve(sendApnsToAllUiSessions?.(
      options.preserveAlert === true ? toApnsContactPayload(payload) : toApnsGenericPayload(payload),
      options,
    )).catch((error) => {
      console.warn('[APNs] fanout failed:', error?.message ?? error);
    }),
  ]);

  let getIsWindowFocused = typeof deps.getIsWindowFocused === 'function'
    ? deps.getIsWindowFocused
    : null;

  const setGetIsWindowFocused = (cb) => {
    getIsWindowFocused = typeof cb === 'function' ? cb : null;
  };

  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  const pushQuestionDebounceTimers = new Map();
  const pushPermissionDebounceTimers = new Map();
  const notifiedPermissionRequests = new Set();
  const lastReadyNotificationAt = new Map();

  const sessionMetaCache = new Map();
  const SESSION_META_CACHE_TTL_MS = 60 * 1000;
  const HIDDEN_SESSION_TITLES = new Set(['smartfetch-secondary']);
  const nonEmptySystemID = (value) => typeof value === 'string' && value.length > 0;

  // Sessions where the client has enabled Permission Auto-Accept. Mirrored
  // from the client-side permissionStore via POST /api/notifications/auto-accept
  // so the server can suppress permission notifications BEFORE dispatch (the
  // 500ms debounce race otherwise leaks notifications for auto-accepted
  // permissions when the replied round-trip is slower than the debounce).
  const autoAcceptingSessions = new Set();
  const setAutoAcceptSession = (sessionId, enabled) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (enabled) {
      autoAcceptingSessions.add(sessionId);
    } else {
      autoAcceptingSessions.delete(sessionId);
    }
  };

  const buildSessionDeepLinkUrl = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') {
      return '/';
    }
    return `/?session=${encodeURIComponent(sessionId)}`;
  };

  const getSessionMetaCacheKey = (sessionId, directory) => `${directory || ''}\0${sessionId}`;

  const normalizeParentID = (value) => (
    typeof value === 'string' && value.length > 0 ? value : null
  );

  const normalizeSmallModelPurpose = (value) => (
    typeof value === 'string' && value.length > 0 ? value : null
  );

  const getCachedSessionMeta = (sessionId, directory) => {
    const cacheKey = getSessionMetaCacheKey(sessionId, directory);
    const entry = sessionMetaCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SESSION_META_CACHE_TTL_MS) {
      sessionMetaCache.delete(cacheKey);
      return undefined;
    }
    return entry;
  };

  const setCachedSessionMeta = (sessionId, directory, meta) => {
    const previous = getCachedSessionMeta(sessionId, directory);
    sessionMetaCache.set(getSessionMetaCacheKey(sessionId, directory), {
      parentID: meta.parentID !== undefined ? meta.parentID : (previous?.parentID ?? null),
      smallModelPurpose: meta.smallModelPurpose !== undefined
        ? meta.smallModelPurpose
        : (previous?.smallModelPurpose ?? null),
      assistantID: meta.assistantID !== undefined ? meta.assistantID : (previous?.assistantID ?? null),
      assignedFrom: meta.assignedFrom !== undefined ? meta.assignedFrom : (previous?.assignedFrom ?? null),
      scheduledTaskID: meta.scheduledTaskID !== undefined
        ? meta.scheduledTaskID
        : (previous?.scheduledTaskID ?? null),
      title: meta.title !== undefined ? meta.title : (previous?.title ?? null),
      complete: meta.complete === true || previous?.complete === true,
      at: Date.now(),
    });
  };

  const metaFromOpenchamber = (openchamber, extras = {}) => {
    const assignedFrom = typeof openchamber?.assigned?.from === 'string'
      ? openchamber.assigned.from
      : null;
    return {
      smallModelPurpose: normalizeSmallModelPurpose(openchamber?.smallModel?.purpose),
      assistantID: nonEmptySystemID(openchamber?.assistant?.assistantID)
        ? openchamber.assistant.assistantID
        : null,
      assignedFrom,
      scheduledTaskID: nonEmptySystemID(openchamber?.scheduledTask?.taskID)
        ? openchamber.scheduledTask.taskID
        : null,
      ...extras,
    };
  };

  const maybeCacheSessionMetaFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type !== 'session.created' && payload.type !== 'session.updated') return;
    const info = payload.properties?.info;
    if (!info || typeof info !== 'object') return;
    const sessionId = extractSessionIdFromPayload(payload);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const directory = extractDirectoryFromPayload(payload);
    setCachedSessionMeta(sessionId, directory, {
      parentID: normalizeParentID(info.parentID),
      title: typeof info.title === 'string' ? info.title : null,
      complete: true,
      ...metaFromOpenchamber(info.metadata?.openchamber),
    });
  };

  const fetchSessionMeta = async (sessionId, directory) => {
    if (!sessionId) return undefined;

    const cached = getCachedSessionMeta(sessionId, directory);
    if (cached?.complete) return cached;

    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        return cached;
      }
      const session = await response.json().catch(() => null);
      if (!session || typeof session !== 'object') {
        return cached;
      }

      const meta = {
        parentID: normalizeParentID(session.parentID),
        title: typeof session.title === 'string' ? session.title : null,
        complete: true,
        ...metaFromOpenchamber(session.metadata?.openchamber),
      };
      setCachedSessionMeta(sessionId, directory, meta);
      return getCachedSessionMeta(sessionId, directory) ?? meta;
    } catch {
      return cached;
    }
  };

  const fetchSessionParentId = async (sessionId, directory) => {
    const meta = await fetchSessionMeta(sessionId, directory);
    return meta?.parentID;
  };

  // Mirrors client-side autoRespondsPermission: a session auto-accepts if it
  // OR any ancestor is flagged. Walks the parent chain via fetchSessionParentId.
  const isSessionAutoAccepting = async (sessionId, directory) => {
    if (!sessionId || autoAcceptingSessions.size === 0) return false;
    let current = sessionId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      if (autoAcceptingSessions.has(current)) return true;
      seen.add(current);
      const parent = await fetchSessionParentId(current, directory);
      if (!parent) return false;
      current = parent;
    }
    return false;
  };

  const isHiddenFromNavSession = (meta) => {
    if (!meta) return false;
    if (typeof meta.parentID === 'string' && meta.parentID.length > 0) return true;
    if (typeof meta.smallModelPurpose === 'string' && meta.smallModelPurpose.length > 0) return true;
    if (typeof meta.assistantID === 'string' && meta.assistantID.length > 0 && meta.assignedFrom !== 'contact') {
      return true;
    }
    if (typeof meta.scheduledTaskID === 'string' && meta.scheduledTaskID.length > 0) return true;
    if (typeof meta.title === 'string' && HIDDEN_SESSION_TITLES.has(meta.title)) return true;
    return false;
  };

  // Only sessions that can appear as sidebar roots get ordinary push. Child /
  // subagent sessions, archived Assistant bindings, scheduled-task sessions,
  // small-model system sessions, and SmartFetch secondaries are excluded.
  // Contact-assigned worker sessions stay visible and still notify.
  const shouldSkipSystemSessionNotification = async (sessionId, directory) => {
    const meta = await fetchSessionMeta(sessionId, directory);
    return isHiddenFromNavSession(meta);
  };

  const extractSessionIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const props = payload.properties;
    const info = props?.info;
    const sessionId =
      info?.sessionID ??
      info?.sessionId ??
      props?.sessionID ??
      props?.sessionId ??
      props?.session ??
      null;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  };

  const extractDirectoryFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return undefined;
    const props = payload.properties;
    const directory = props?.directory ?? props?.info?.directory;
    if (typeof directory !== 'string') return undefined;
    const trimmed = directory.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  // A session with an ACTIVE goal suppresses per-turn ready notifications;
  // the session-goal runtime sends its own notification when the goal
  // settles. Fetch failures fall through to normal notification behavior.
  const hasActiveSessionGoal = async (sessionId, directory) => {
    if (!sessionId) return false;
    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return false;
      const session = await response.json().catch(() => null);
      const goal = session?.metadata?.openchamber?.goal;
      return Boolean(goal && typeof goal === 'object' && goal.status === 'active');
    } catch {
      return false;
    }
  };

  const maybeSendPushForTrigger = async (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    maybeCacheSessionMetaFromPayload(payload);

    const sessionId = extractSessionIdFromPayload(payload);
    const notificationDirectory = extractDirectoryFromPayload(payload);
    if ((payload.type === 'session.updated' || payload.type === 'session.created') && sessionId) {
      const title = payload.properties?.info?.title;
      if (
        typeof title === 'string'
        && title.trim()
        && !(await shouldSkipSystemSessionNotification(sessionId, notificationDirectory))
      ) {
        try {
          await sendLiveActivityEnd?.({ sessionId, title: title.trim() });
        } catch (error) {
          console.warn('[Live Activity] title update failed:', error?.message ?? error);
        }
      }
    }
    if ((payload.type === 'session.idle' || payload.type === 'session.error') && sessionId) {
      const error = payload.properties?.error;
      const errorText = typeof error?.message === 'string'
        ? error.message
        : typeof error === 'string' ? error : '';
      await maybeSendPushForTrigger({
        ...payload,
        type: 'message.updated',
        properties: {
          ...payload.properties,
          info: {
            sessionID: sessionId,
            role: 'assistant',
            finish: payload.type === 'session.error' ? 'error' : 'stop',
            ...(errorText ? { parts: [{ type: 'text', text: errorText }] } : {}),
          },
        },
      });
      return;
    }

    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      const isAssistantTerminal = Boolean(
        sessionId
        && info?.role === 'assistant'
        && (info?.finish === 'stop' || info?.finish === 'error'),
      );
      if (isAssistantTerminal && await shouldSkipSystemSessionNotification(sessionId, notificationDirectory)) {
        return;
      }
      if (isAssistantTerminal) {
        try {
          await sendLiveActivityEnd?.({
            sessionId,
            status: info.finish === 'error' ? 'error' : 'complete',
          });
        } catch (error) {
          console.warn('[Live Activity] end failed:', error?.message ?? error);
        }
      }
      if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId) {
        const settings = await readSettingsFromDisk();

        if (settings.notifyOnCompletion === false) {
          return;
        }

        // While a goal drives the session, per-turn "ready" notifications are
        // noise produced by the goal loop itself — the goal's own settle
        // notification (complete/blocked/budget) is the final word instead.
        if (await hasActiveSessionGoal(sessionId, notificationDirectory)) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const now = Date.now();
        const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
          return;
        }
        lastReadyNotificationAt.set(sessionId, now);

        let title = 'Task completed';
        let body = '';
        let sessionName = '';

        try {
          const templates = settings.notificationTemplates || {};
          const completionTemplate = templates.completion || { title: 'Task completed', message: '{session_name}' };

          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;

          const messageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });

          const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
          if (!body) body = sessionName || resolvedBody || 'Session';
        } catch (error) {
          console.warn('[Notification] Template resolution failed, using defaults:', error?.message || error);
          if (!body) body = sessionName || 'Session';
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `ready-${sessionId}`,
            kind: 'ready',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        await fanoutPush(
          {
            title,
            body,
            tag: `ready-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'ready',
            },
          },
          { requireNoSse: true },
        );
      }

      return;
    }

    if (payload.type === 'question.asked' && sessionId) {
      if (await shouldSkipSystemSessionNotification(sessionId, notificationDirectory)) {
        return;
      }
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnQuestion === false) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const firstQuestion = payload.properties?.questions?.[0];
        const header = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
        const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';

        let title = 'Needs your answer';
        let body = '';
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Needs your answer', message: '{session_name}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
          if (!body) body = sessionName || resolvedBody || 'Session';
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', error?.message || error);
          if (!body) body = sessionName || 'Session';
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        void fanoutPush(
          {
            title,
            body,
            tag: `question-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'question',
            },
          },
          { requireNoSse: true },
        );
      }, PUSH_QUESTION_DEBOUNCE_MS);

      pushQuestionDebounceTimers.set(sessionId, timer);
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        return;
      }

      // Some runtimes may omit requestID on permission.replied.
      // When request ID is missing, clear session debounce to avoid
      // showing stale permission notifications for auto-approved prompts.
      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      if (await shouldSkipSystemSessionNotification(sessionId, notificationDirectory)) {
        return;
      }
      const requestId = payload.properties?.id ?? payload.properties?.requestID ?? payload.properties?.requestId;
      const permission = payload.properties?.permission;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      if (requestKey && notifiedPermissionRequests.has(requestKey)) {
        return;
      }

      // Client may be in Permission Auto-Accept for this session (or any
      // ancestor). Skip the whole notification path — the client responds
      // directly and the user has opted out of approval prompts.
      if (await (getIsSessionAutoAccepting?.(sessionId, notificationDirectory)
        ?? isSessionAutoAccepting(sessionId, notificationDirectory))) {
        if (requestKey) notifiedPermissionRequests.add(requestKey);
        return;
      }

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);

        if (await (getIsSessionAutoAccepting?.(sessionId, notificationDirectory)
          ?? isSessionAutoAccepting(sessionId, notificationDirectory))) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          return;
        }

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
        const fallbackMessage = typeof sessionTitle === 'string' && sessionTitle.trim().length > 0
          ? sessionTitle.trim()
          : permissionText || 'Agent is waiting for your approval';

        let title = 'Needs permission';
        let body = '';
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Needs permission', message: '{session_name}' };

          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
          if (!body) body = sessionName || fallbackMessage || 'Session';
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', error?.message || error);
          if (!body) body = sessionName || fallbackMessage || 'Session';
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        if (requestKey) {
          notifiedPermissionRequests.add(requestKey);
        }

        void fanoutPush(
          {
            title,
            body,
            tag: `permission-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'permission',
            },
          },
          { requireNoSse: true },
        );
      }, PUSH_PERMISSION_DEBOUNCE_MS);

      pushPermissionDebounceTimers.set(sessionId, { timer, requestKey });
    }
  };

  // Goal settle push: same fanout as the trigger paths (web-push with the
  // full text; APNs with the generic per-type title and the session name as
  // body, so the relay never sees content).
  const sendGoalSettlePush = async ({ sessionId, directory, status, title, body }) => {
    let sessionName = '';
    try {
      const base = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const session = await response.json().catch(() => null);
        if (typeof session?.title === 'string') sessionName = session.title.trim();
      }
    } catch {
      // Session name is presentation sugar for the mobile push — never block on it.
    }
    const type = status === 'complete' ? 'goal_complete' : (status === 'budgetLimited' ? 'goal_budget' : 'goal_blocked');
    await fanoutPush(
      {
        title,
        body,
        tag: `goal-${sessionId}`,
        data: {
          url: buildSessionDeepLinkUrl(sessionId),
          sessionId,
          sessionName,
          type,
        },
      },
      { requireNoSse: true },
    );
  };

  const contactNotificationTitle = (name) => {
    if (typeof name !== 'string' || !name.trim()) return 'Assistant';
    const stripped = name.replace(/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\uFE0F\u200D])+\s*/u, '').trim();
    return stripped || name.trim();
  };

  const sendContactTurnNotification = async ({ assistantID, name, body, status } = {}) => {
    if (typeof assistantID !== 'string' || !assistantID.trim()) return;
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;

    const title = contactNotificationTitle(name);
    const rawBody = typeof body === 'string' ? body : '';
    let text = '';
    try {
      text = await prepareNotificationLastMessage({ message: rawBody, settings });
    } catch {
      text = '';
    }
    if (!text) text = status === 'error' ? 'Something went wrong' : 'New message';
    const tag = `contact-${assistantID.trim()}`;

    if (settings.nativeNotificationsEnabled) {
      const notificationPayload = {
        title,
        body: text,
        tag,
        kind: 'contact',
        assistantID: assistantID.trim(),
        requireHidden: false,
      };
      const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
      broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
    }

    const assistantPath = `/assistant/${encodeURIComponent(assistantID.trim())}`;
    await fanoutPush(
      {
        title,
        body: text,
        tag,
        data: {
          url: assistantPath,
          assistantID: assistantID.trim(),
          type: 'contact',
        },
      },
      { requireNoSse: true, preserveAlert: true },
    );
  };

  return {
    maybeSendPushForTrigger,
    setAutoAcceptSession,
    setGetIsWindowFocused,
    setGetIsSessionAutoAccepting,
    clearPendingPushBadge,
    sendGoalSettlePush,
    sendContactTurnNotification,
  };
};
