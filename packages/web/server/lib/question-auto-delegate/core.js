export const QUESTION_AUTO_DELEGATE_DELAY_MS = 30_000;

export const QUESTION_AUTO_DELEGATE_ANSWER =
  '当前用户暂未响应，请根据任务目标和已有上下文自行判断，选择合理方案并继续执行。';

export const QUESTION_SUBMISSION_CLAIMED_CODE = 'question_submission_claimed';

/** Definitive client/upstream rejections that did not leave an ambiguous send. */
const DEFINITIVE_REJECT_STATUSES = new Set([400, 409, 422]);

const TERMINAL_SETTLED = 'settled';
const BLOCKING_STATES = new Set(['counting', 'paused', 'disabled', 'submitting', 'uncertain']);

const asTrimmedString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

export const buildAutoDelegateAnswers = (questionCount, answerText = QUESTION_AUTO_DELEGATE_ANSWER) => {
  const count = Number.isFinite(questionCount) && questionCount > 0 ? Math.floor(questionCount) : 1;
  const text = typeof answerText === 'string' && answerText ? answerText : QUESTION_AUTO_DELEGATE_ANSWER;
  return Array.from({ length: count }, () => [text]);
};

const normalizeQuestion = (raw, directoryHint = '') => {
  if (!raw || typeof raw !== 'object') return null;
  const requestID = asTrimmedString(raw.id) || asTrimmedString(raw.requestID);
  const sessionID = asTrimmedString(raw.sessionID);
  if (!requestID || !sessionID) return null;
  const directory = asTrimmedString(raw.directory) || asTrimmedString(directoryHint);
  const questions = Array.isArray(raw.questions) ? raw.questions : [];
  return {
    requestID,
    sessionID,
    directory,
    questionCount: questions.length > 0 ? questions.length : 1,
    questions,
  };
};

const publicRequest = (entry) => ({
  requestID: entry.requestID,
  sessionID: entry.sessionID,
  directory: entry.directory,
  questionCount: entry.questionCount,
  state: entry.state,
  deadlineAt: entry.deadlineAt,
  pauseReason: entry.pauseReason,
  submittedBy: entry.submittedBy,
  resolution: entry.resolution,
});

const mergeDirectoryLists = (...lists) => {
  const out = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const value = asTrimmedString(item);
      if (value) out.add(value);
    }
  }
  return Array.from(out);
};

export function createQuestionAutoDelegateCore({
  io,
  delayMs = QUESTION_AUTO_DELEGATE_DELAY_MS,
  autoAnswer = QUESTION_AUTO_DELEGATE_ANSWER,
} = {}) {
  if (!io || typeof io !== 'object') {
    throw new TypeError('createQuestionAutoDelegateCore requires io');
  }

  const epoch = typeof io.createEpoch === 'function' ? io.createEpoch() : `qad-${Date.now()}`;
  let revision = 0;
  /** @type {'loading' | 'ready' | 'unavailable'} */
  let settingsStatus = 'loading';
  let enabled = false;
  /** Bumped on every applyEnabled so a late start() read cannot overwrite newer settings. */
  let settingsGeneration = 0;
  let disposed = false;
  let coverageState = 'ready';
  /** @type {string[]} */
  let failedDirectories = [];
  /** @type {Map<string, any>} */
  const requests = new Map();
  /** @type {Map<string, { parentID: string | null, directory: string }>} */
  const sessions = new Map();
  /** Directories observed from events / requests (worktree child paths etc.). */
  const observedDirectories = new Set();
  let reconcilePromise = null;
  /** @type {string[] | null} */
  let trailingReconcileDirectories = null;
  let started = false;
  /** @type {null | (() => void)} */
  let stopHub = null;

  const noteDirectory = (directory) => {
    const value = asTrimmedString(directory);
    if (value) observedDirectories.add(value);
  };

  const bump = () => {
    revision += 1;
    try {
      io.onChanged?.({ epoch, revision });
    } catch {
      // Tip broadcast must never break core transitions.
    }
  };

  const snapshot = () => ({
    epoch,
    revision,
    serverNow: io.now(),
    enabled: settingsStatus === 'ready' ? enabled : false,
    delayMs,
    coverage: {
      state: settingsStatus === 'unavailable' && coverageState === 'ready' ? 'partial' : coverageState,
      failedDirectories: failedDirectories.slice(),
    },
    requests: Array.from(requests.values()).map(publicRequest),
  });

  const rememberSession = (info, directoryHint = '') => {
    if (!info || typeof info !== 'object') return;
    const id = asTrimmedString(info.id);
    if (!id) return;
    const existing = sessions.get(id);
    const parentID = asTrimmedString(info.parentID) || existing?.parentID || null;
    const directory = asTrimmedString(info.directory)
      || asTrimmedString(directoryHint)
      || existing?.directory
      || '';
    sessions.set(id, { parentID, directory });
    noteDirectory(directory);
  };

  const clearTimer = (entry) => {
    if (entry?.timer) {
      try {
        entry.timer.clear();
      } catch {
        // ignore
      }
      entry.timer = null;
    }
  };

  const fireTakeover = (entry, reason) => {
    try {
      io.onUserTakeover?.({
        requestID: entry.requestID,
        sessionID: entry.sessionID,
        directory: entry.directory,
        reason,
      });
    } catch {
      // ignore
    }
  };

  const settingsAllowAuto = () => settingsStatus === 'ready' && enabled === true;

  /** Auto-submit requires ready settings, enabled flag, and an authoritative directory binding. */
  const canAutoSubmit = (entry) => (
    settingsAllowAuto()
    && entry
    && entry.state === 'counting'
    && Boolean(asTrimmedString(entry.directory))
  );

  const scheduleAuto = (entry) => {
    clearTimer(entry);
    if (disposed || !canAutoSubmit(entry)) return;
    const now = io.now();
    if (entry.deadlineAt == null) {
      entry.deadlineAt = now + delayMs;
    }
    const remaining = Math.max(0, entry.deadlineAt - now);
    entry.timer = io.createTimer(() => {
      entry.timer = null;
      if (disposed || !canAutoSubmit(entry)) return;
      void submitInternal({
        requestID: entry.requestID,
        sessionID: entry.sessionID,
        directory: entry.directory,
        kind: 'reply',
        authority: 'auto',
        answers: buildAutoDelegateAnswers(entry.questionCount, autoAnswer),
      });
    }, remaining);
  };

  const ensureCounting = (entry, { resetDeadline } = { resetDeadline: true }) => {
    if (entry.state === TERMINAL_SETTLED || entry.state === 'uncertain' || entry.state === 'submitting') {
      return false;
    }
    if (!settingsAllowAuto()) {
      // Settings loading/unavailable or feature off: never arm auto timers.
      clearTimer(entry);
      if (settingsStatus === 'ready' && !enabled) {
        entry.state = 'disabled';
        entry.deadlineAt = null;
        entry.pauseReason = null;
      } else if (entry.state !== 'paused') {
        // Keep identity but do not count until settings + directory are ready.
        entry.state = entry.state === 'paused' ? 'paused' : 'counting';
        entry.deadlineAt = null;
      }
      return false;
    }
    if (entry.state === 'paused') return false;
    entry.state = 'counting';
    entry.pauseReason = null;
    if (!asTrimmedString(entry.directory)) {
      // Bound directory required before any auto timer.
      clearTimer(entry);
      entry.deadlineAt = null;
      return false;
    }
    if (resetDeadline || entry.deadlineAt == null) {
      entry.deadlineAt = io.now() + delayMs;
    }
    scheduleAuto(entry);
    return true;
  };

  const bindDirectoryToEntry = (entry, directory, { restartTimer = true } = {}) => {
    const next = asTrimmedString(directory);
    if (!next) return false;
    if (entry.directory && entry.directory !== next) return false;
    const wasMissing = !entry.directory;
    entry.directory = next;
    noteDirectory(next);
    if (wasMissing && restartTimer && entry.state !== 'paused' && entry.state !== 'disabled') {
      ensureCounting(entry, { resetDeadline: true });
      return true;
    }
    if (entry.state === 'counting' && !entry.timer && canAutoSubmit(entry)) {
      scheduleAuto(entry);
      return true;
    }
    return wasMissing;
  };

  const trackQuestion = (normalized, { resetIfDuplicate = false } = {}) => {
    const existing = requests.get(normalized.requestID);
    if (existing) {
      if (existing.state === TERMINAL_SETTLED || existing.state === 'uncertain' || existing.state === 'submitting') {
        return { entry: existing, changed: false };
      }
      let changed = false;
      if (normalized.directory) {
        if (!existing.directory) {
          existing.directory = normalized.directory;
          noteDirectory(normalized.directory);
          changed = true;
        }
        // Authoritative same-directory refine only; never clobber a different binding here.
      }
      if (normalized.sessionID && !existing.sessionID) {
        existing.sessionID = normalized.sessionID;
        changed = true;
      }
      if (normalized.questionCount > 0 && normalized.questionCount !== existing.questionCount) {
        existing.questionCount = normalized.questionCount;
        changed = true;
      }
      if (resetIfDuplicate) {
        const counting = ensureCounting(existing, { resetDeadline: true });
        return { entry: existing, changed: counting || changed };
      }
      if (changed && existing.state === 'counting') {
        ensureCounting(existing, { resetDeadline: false });
      }
      return { entry: existing, changed };
    }

    const entry = {
      requestID: normalized.requestID,
      sessionID: normalized.sessionID,
      directory: normalized.directory || '',
      questionCount: normalized.questionCount,
      state: 'counting',
      deadlineAt: null,
      pauseReason: null,
      submittedBy: null,
      resolution: null,
      claimAuthority: null,
      /** True once an upstream POST body left this process (or uncertain result). */
      upstreamDispatched: false,
      timer: null,
    };
    noteDirectory(entry.directory);
    requests.set(entry.requestID, entry);
    ensureCounting(entry, { resetDeadline: true });
    return { entry, changed: true };
  };

  const markSettled = (entry, resolution, submittedBy = entry.submittedBy) => {
    clearTimer(entry);
    entry.state = TERMINAL_SETTLED;
    entry.deadlineAt = null;
    entry.pauseReason = null;
    entry.resolution = resolution;
    entry.claimAuthority = entry.claimAuthority || 'done';
    if (submittedBy) entry.submittedBy = submittedBy;
  };

  const markUncertain = (entry, submittedBy) => {
    clearTimer(entry);
    entry.state = 'uncertain';
    entry.deadlineAt = null;
    entry.pauseReason = null;
    entry.resolution = null;
    entry.upstreamDispatched = true;
    // Keep claimAuthority tombstone so concurrent POSTs stay 409.
    if (!entry.claimAuthority) entry.claimAuthority = 'uncertain';
    if (submittedBy) entry.submittedBy = submittedBy;
  };

  /** Release claim after a definitive pre-send / clear reject so a human can retry. */
  const releaseClaimToPaused = (entry, pauseReason = 'user') => {
    clearTimer(entry);
    entry.claimAuthority = null;
    entry.upstreamDispatched = false;
    entry.state = 'paused';
    entry.deadlineAt = null;
    entry.pauseReason = pauseReason;
    entry.submittedBy = null;
    entry.resolution = null;
  };

  const resolveRootSession = (sessionID) => {
    const id = asTrimmedString(sessionID);
    if (!id) return { sessionID: '', directory: '' };
    const seen = new Set();
    let current = id;
    let directory = sessions.get(id)?.directory || '';
    while (current && !seen.has(current)) {
      seen.add(current);
      const info = sessions.get(current);
      if (!info?.parentID) {
        return { sessionID: current, directory: info?.directory || directory };
      }
      directory = info.directory || directory;
      current = info.parentID;
    }
    return { sessionID: current || id, directory };
  };

  /**
   * Recover a pending question identity via scoped list (never invent questionCount=1).
   * @returns {Promise<ReturnType<typeof normalizeQuestion> | null>}
   */
  const recoverPendingIdentity = async ({ requestID, sessionID, directoryHint }) => {
    const scopes = mergeDirectoryLists(
      [directoryHint],
      sessionID ? [sessions.get(sessionID)?.directory] : [],
      Array.from(observedDirectories),
    );
    if (scopes.length === 0) {
      try {
        const listed = await io.listDirectories();
        scopes.push(...mergeDirectoryLists(listed));
      } catch {
        // ignore
      }
    }
    // Prefer scoped directories; unscoped last and never treated as authoritative alone for identity.
    for (const directory of scopes) {
      let listed;
      try {
        listed = await io.listQuestions(directory);
      } catch {
        listed = null;
      }
      if (!listed) continue;
      for (const item of listed) {
        const normalized = normalizeQuestion(item, directory);
        if (!normalized || normalized.requestID !== requestID) continue;
        if (sessionID && normalized.sessionID && normalized.sessionID !== sessionID) continue;
        if (!normalized.directory) normalized.directory = directory;
        return normalized;
      }
    }
    return null;
  };

  /** Best-effort parent walk + write directory write-back. */
  const ensureSessionLineage = async (sessionID, directoryHint = '', requestID = '') => {
    const id = asTrimmedString(sessionID);
    if (!id || typeof io.getSession !== 'function') return;
    const seen = new Set();
    let current = id;
    let directory = asTrimmedString(directoryHint);
    let writebackDirectory = '';
    while (current && !seen.has(current)) {
      seen.add(current);
      const cached = sessions.get(current);
      if (cached?.parentID) {
        directory = cached.directory || directory;
        if (current === id && cached.directory) writebackDirectory = cached.directory;
        current = cached.parentID;
        continue;
      }
      let info = null;
      try {
        info = await io.getSession(current, directory || undefined);
      } catch {
        break;
      }
      if (!info) break;
      rememberSession(info, directory);
      directory = asTrimmedString(info.directory) || directory;
      if (current === id && directory) writebackDirectory = directory;
      const parentID = asTrimmedString(info.parentID) || null;
      if (!parentID) break;
      current = parentID;
    }

    if (writebackDirectory && requestID) {
      const entry = requests.get(requestID);
      if (entry && bindDirectoryToEntry(entry, writebackDirectory, { restartTimer: true })) {
        bump();
      }
    } else if (writebackDirectory) {
      // Still refresh any counting entries for this session missing a directory.
      let changed = false;
      for (const entry of requests.values()) {
        if (entry.sessionID !== id) continue;
        if (bindDirectoryToEntry(entry, writebackDirectory, { restartTimer: true })) changed = true;
      }
      if (changed) bump();
    }
  };

  /**
   * Synchronous claim. Client session/directory hints never override bound identity.
   * @returns {{ ok: true, entry: any } | { ok: false, reason: string, entry?: any }}
   */
  const claim = (requestID, authority, meta = {}) => {
    let entry = requests.get(requestID);
    const hintSession = asTrimmedString(meta.sessionID);
    const hintDirectory = asTrimmedString(meta.directory);

    if (!entry) {
      entry = {
        requestID,
        sessionID: hintSession,
        directory: hintDirectory,
        questionCount: Number.isFinite(meta.questionCount) && meta.questionCount > 0
          ? Math.floor(meta.questionCount)
          : 0,
        state: 'counting',
        deadlineAt: null,
        pauseReason: null,
        submittedBy: null,
        resolution: null,
        claimAuthority: null,
        upstreamDispatched: false,
        timer: null,
      };
      noteDirectory(entry.directory);
      requests.set(requestID, entry);
    } else {
      if (entry.state === TERMINAL_SETTLED) {
        return { ok: false, reason: 'settled', entry };
      }
      if (entry.state === 'uncertain' || entry.claimAuthority || entry.state === 'submitting') {
        return { ok: false, reason: 'claimed', entry };
      }
      // Bound identity wins — conflicting client hints are rejected.
      if (entry.sessionID && hintSession && entry.sessionID !== hintSession) {
        return { ok: false, reason: 'conflict', entry };
      }
      if (entry.directory && hintDirectory && entry.directory !== hintDirectory) {
        return { ok: false, reason: 'conflict', entry };
      }
      if (!entry.sessionID && hintSession) entry.sessionID = hintSession;
      if (!entry.directory && hintDirectory) {
        entry.directory = hintDirectory;
        noteDirectory(hintDirectory);
      }
      if (
        Number.isFinite(meta.questionCount)
        && meta.questionCount > 0
        && (!entry.questionCount || entry.questionCount < 1)
      ) {
        entry.questionCount = Math.floor(meta.questionCount);
      }
    }

    clearTimer(entry);
    entry.claimAuthority = authority;
    entry.state = 'submitting';
    entry.deadlineAt = null;
    entry.pauseReason = null;
    entry.submittedBy = authority === 'manual' ? 'manual' : 'auto';
    return { ok: true, entry };
  };

  const submitInternal = async (input) => {
    if (disposed) {
      return { outcome: 'error', snapshot: snapshot(), error: 'disposed', status: 500 };
    }
    const requestID = asTrimmedString(input?.requestID);
    if (!requestID) {
      return { outcome: 'error', snapshot: snapshot(), error: 'requestID is required', status: 400 };
    }
    const authority = input.authority === 'manual' || input.authority === 'delegate' || input.authority === 'auto'
      ? input.authority
      : 'auto';
    const kind = input.kind === 'reject' ? 'reject' : 'reply';

    // Manual reply: never substitute the auto-delegate fixed text. Require an array
    // (including empty) and forward it as-is.
    if (authority === 'manual' && kind === 'reply') {
      if (!Array.isArray(input.answers)) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          error: 'answers must be an array',
          status: 400,
        };
      }
    }

    // Auto path needs settings ready + directory; refuse without claiming when not eligible.
    if (authority === 'auto') {
      if (!settingsAllowAuto()) {
        return {
          outcome: 'disabled',
          snapshot: snapshot(),
          status: 409,
          error: settingsStatus === 'unavailable'
            ? 'Question auto-delegate settings unavailable'
            : 'Question auto-delegate is not ready',
        };
      }
      const existing = requests.get(requestID);
      if (existing && !asTrimmedString(existing.directory) && !asTrimmedString(input.directory)) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          error: 'Authoritative directory required before auto-submit',
          status: 409,
        };
      }
    }

    const claimed = claim(requestID, authority, {
      sessionID: input.sessionID,
      directory: input.directory,
      questionCount: Array.isArray(input.answers) && input.answers.length > 0
        ? input.answers.length
        : undefined,
    });

    if (!claimed.ok) {
      if (claimed.reason === 'conflict') {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'sessionID/directory conflicts with bound request identity',
        };
      }
      if (claimed.reason === 'settled') {
        return {
          outcome: 'settled',
          snapshot: snapshot(),
          upstreamStatus: 409,
          error: 'Question already settled',
        };
      }
      return {
        outcome: 'claimed',
        code: QUESTION_SUBMISSION_CLAIMED_CODE,
        snapshot: snapshot(),
        status: 409,
        error: 'Question submission already claimed',
      };
    }

    const entry = claimed.entry;
    // Manual claim is a user takeover for goal linkage.
    if (authority === 'manual') {
      fireTakeover(entry, 'interaction');
    }
    bump();

    const directory = asTrimmedString(entry.directory) || asTrimmedString(input.directory) || undefined;

    // Auto still needs directory at POST time.
    if (authority === 'auto' && !directory) {
      releaseClaimToPaused(entry, null);
      entry.state = 'counting';
      entry.pauseReason = null;
      bump();
      return {
        outcome: 'error',
        snapshot: snapshot(),
        error: 'Authoritative directory required before auto-submit',
        status: 409,
      };
    }

    let upstream;
    try {
      if (kind === 'reject') {
        entry.upstreamDispatched = true;
        upstream = await io.postReject(requestID, directory, input.body);
      } else if (authority === 'manual') {
        entry.upstreamDispatched = true;
        // Forward the caller payload exactly (answers may be empty).
        upstream = await io.postReply(requestID, directory, input.answers);
      } else {
        const count = entry.questionCount > 0 ? entry.questionCount : 1;
        const answers = Array.isArray(input.answers) && input.answers.length > 0
          ? input.answers
          : buildAutoDelegateAnswers(count, autoAnswer);
        entry.upstreamDispatched = true;
        upstream = await io.postReply(requestID, directory, answers);
      }
    } catch (error) {
      // Throw before a classified upstream result: treat as pre-send failure → release for retry.
      if (entry.state === TERMINAL_SETTLED) {
        return { outcome: 'settled', snapshot: snapshot() };
      }
      releaseClaimToPaused(entry, authority === 'manual' ? 'interaction' : 'user');
      bump();
      return {
        outcome: 'error',
        snapshot: snapshot(),
        error: error?.message ?? 'Upstream submission failed before confirmation',
        status: 502,
      };
    }

    // Late authoritative settle must not be downgraded by a slow POST failure.
    if (entry.state === TERMINAL_SETTLED) {
      return {
        outcome: 'settled',
        snapshot: snapshot(),
        upstreamStatus: upstream?.status,
        upstreamBody: upstream?.body,
      };
    }

    // Compatible extension: only an explicit notSent===true means the request
    // never left the process. Release claim for human retry. Unknown status:0
    // without notSent stays uncertain (may have been sent).
    if (upstream?.notSent === true) {
      releaseClaimToPaused(entry, authority === 'manual' ? 'interaction' : 'user');
      bump();
      return {
        outcome: 'error',
        snapshot: snapshot(),
        upstreamStatus: upstream.status ?? 0,
        upstreamBody: upstream.body,
        error: 'Upstream submission was not sent',
        status: 502,
      };
    }

    if (upstream?.uncertain) {
      markUncertain(entry, entry.submittedBy);
      bump();
      return {
        outcome: 'uncertain',
        snapshot: snapshot(),
        upstreamStatus: upstream.status,
        upstreamBody: upstream.body,
      };
    }

    if (upstream?.ok) {
      markSettled(entry, kind === 'reject' ? 'rejected' : 'replied', entry.submittedBy);
      bump();
      return {
        outcome: 'submitted',
        snapshot: snapshot(),
        upstreamStatus: upstream.status,
        upstreamBody: upstream.body,
      };
    }

    if (upstream?.status === 404) {
      markSettled(entry, 'external', entry.submittedBy);
      bump();
      return {
        outcome: 'settled',
        snapshot: snapshot(),
        upstreamStatus: upstream.status,
        upstreamBody: upstream.body,
      };
    }

    // Clear reject (400/409/422): release claim and pause so a human can retry.
    // Never auto-retry immediately.
    if (DEFINITIVE_REJECT_STATUSES.has(upstream?.status)) {
      releaseClaimToPaused(entry, authority === 'manual' ? 'interaction' : 'user');
      bump();
      return {
        outcome: 'error',
        snapshot: snapshot(),
        upstreamStatus: upstream.status,
        upstreamBody: upstream.body,
        error: 'Upstream rejected the submission',
        status: upstream.status,
      };
    }

    // Ambiguous non-ok after dispatch (incl. bare status:0) → uncertain tombstone.
    markUncertain(entry, entry.submittedBy);
    bump();
    return {
      outcome: 'uncertain',
      snapshot: snapshot(),
      upstreamStatus: upstream?.status ?? 502,
      upstreamBody: upstream?.body,
      error: 'Upstream submission did not confirm success',
    };
  };

  const applyEnabled = (nextEnabled) => {
    if (disposed) return snapshot();
    if (typeof nextEnabled !== 'boolean') {
      // Invalid input must not change runtime state.
      return snapshot();
    }
    settingsGeneration += 1;
    const wasReady = settingsStatus === 'ready';
    const wasEnabled = enabled;
    settingsStatus = 'ready';

    // Repeat true/false after ready: no deadline reset; true may arm eligible missing timers.
    if (wasReady && wasEnabled === nextEnabled) {
      if (nextEnabled) {
        for (const entry of requests.values()) {
          if (entry.state === 'counting' && !entry.timer && canAutoSubmit(entry)) {
            scheduleAuto(entry);
          }
        }
      }
      bump();
      return snapshot();
    }

    enabled = nextEnabled;

    if (!enabled) {
      for (const entry of requests.values()) {
        if (entry.state === TERMINAL_SETTLED || entry.state === 'uncertain' || entry.state === 'submitting') continue;
        clearTimer(entry);
        entry.state = 'disabled';
        entry.deadlineAt = null;
        entry.pauseReason = null;
        fireTakeover(entry, 'disabled');
      }
      bump();
      return snapshot();
    }

    // false → true (or loading → true): still-pending restart a fresh 30s when directory-bound.
    for (const entry of requests.values()) {
      if (entry.state === TERMINAL_SETTLED || entry.state === 'uncertain' || entry.state === 'submitting') continue;
      if (entry.state === 'paused') continue;
      ensureCounting(entry, { resetDeadline: true });
    }
    bump();
    return snapshot();
  };

  const pause = async (input) => {
    if (disposed) {
      return { outcome: 'error', snapshot: snapshot(), error: 'disposed', status: 500 };
    }
    const requestID = asTrimmedString(input?.requestID);
    const sessionID = asTrimmedString(input?.sessionID);
    const reason = input?.reason === 'interaction' || input?.reason === 'user' || input?.reason === 'goal'
      ? input.reason
      : null;
    if (!requestID || !sessionID || !reason) {
      return {
        outcome: 'error',
        snapshot: snapshot(),
        error: 'requestID, sessionID, and reason (interaction|user|goal) are required',
        status: 400,
      };
    }
    const hintDirectory = asTrimmedString(input?.directory);

    let entry = requests.get(requestID);
    if (!entry) {
      const recovered = await recoverPendingIdentity({
        requestID,
        sessionID,
        directoryHint: hintDirectory,
      });
      if (!recovered) {
        return {
          outcome: 'not_found',
          snapshot: snapshot(),
          status: 404,
          error: 'Question request not found',
        };
      }
      if (recovered.sessionID && recovered.sessionID !== sessionID) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'sessionID conflicts with pending question identity',
        };
      }
      if (hintDirectory && recovered.directory && hintDirectory !== recovered.directory) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'directory conflicts with pending question identity',
        };
      }
      const tracked = trackQuestion(recovered);
      entry = tracked.entry;
    } else {
      if (entry.state === TERMINAL_SETTLED) {
        return { outcome: 'settled', snapshot: snapshot() };
      }
      if (entry.state === 'submitting' || entry.state === 'uncertain') {
        return {
          outcome: 'claimed',
          code: QUESTION_SUBMISSION_CLAIMED_CODE,
          status: 409,
          snapshot: snapshot(),
        };
      }
      if (entry.sessionID && entry.sessionID !== sessionID) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'sessionID conflicts with bound request identity',
        };
      }
      if (entry.directory && hintDirectory && entry.directory !== hintDirectory) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'directory conflicts with bound request identity',
        };
      }
      if (!entry.sessionID) entry.sessionID = sessionID;
      if (!entry.directory && hintDirectory) {
        entry.directory = hintDirectory;
        noteDirectory(hintDirectory);
      }
    }

    clearTimer(entry);
    entry.state = 'paused';
    entry.deadlineAt = null;
    entry.pauseReason = reason === 'goal' ? 'goal' : reason;
    if (reason !== 'goal') {
      fireTakeover(entry, reason);
    }
    bump();
    return { outcome: 'paused', snapshot: snapshot() };
  };

  const delegate = async (input) => {
    const requestID = asTrimmedString(input?.requestID);
    const sessionID = asTrimmedString(input?.sessionID);
    if (!requestID || !sessionID) {
      return {
        outcome: 'error',
        snapshot: snapshot(),
        error: 'requestID and sessionID are required',
        status: 400,
      };
    }
    // Explicit single-shot delegate is allowed even when the feature toggle is off.
    if (settingsStatus === 'unavailable') {
      return {
        outcome: 'error',
        snapshot: snapshot(),
        status: 503,
        error: 'Question auto-delegate settings unavailable',
      };
    }

    const hintDirectory = asTrimmedString(input?.directory);
    let entry = requests.get(requestID);
    if (!entry || !entry.questionCount || entry.questionCount < 1 || !entry.directory) {
      const recovered = await recoverPendingIdentity({
        requestID,
        sessionID,
        directoryHint: hintDirectory || entry?.directory,
      });
      if (recovered) {
        if (recovered.sessionID && recovered.sessionID !== sessionID) {
          return {
            outcome: 'error',
            snapshot: snapshot(),
            status: 409,
            error: 'sessionID conflicts with pending question identity',
          };
        }
        if (hintDirectory && recovered.directory && hintDirectory !== recovered.directory) {
          return {
            outcome: 'error',
            snapshot: snapshot(),
            status: 409,
            error: 'directory conflicts with pending question identity',
          };
        }
        const tracked = trackQuestion(recovered);
        entry = tracked.entry;
      }
    } else {
      if (entry.sessionID && entry.sessionID !== sessionID) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'sessionID conflicts with bound request identity',
        };
      }
      if (entry.directory && hintDirectory && entry.directory !== hintDirectory) {
        return {
          outcome: 'error',
          snapshot: snapshot(),
          status: 409,
          error: 'directory conflicts with bound request identity',
        };
      }
    }

    if (!entry || !entry.questionCount || entry.questionCount < 1) {
      return {
        outcome: 'not_found',
        snapshot: snapshot(),
        status: 404,
        error: 'Question request not found or question count unknown',
      };
    }

    const directory = entry.directory || hintDirectory;
    if (!directory) {
      return {
        outcome: 'error',
        snapshot: snapshot(),
        status: 409,
        error: 'Authoritative directory required before delegate',
      };
    }

    const result = await submitInternal({
      requestID,
      sessionID: entry.sessionID || sessionID,
      directory,
      kind: 'reply',
      authority: 'delegate',
      answers: buildAutoDelegateAnswers(entry.questionCount, autoAnswer),
    });
    if (result.outcome === 'submitted') {
      return { ...result, outcome: 'delegated' };
    }
    return result;
  };

  const collectInventoryDirectories = async (explicit) => {
    const fromExplicit = Array.isArray(explicit) ? explicit : null;
    let fromIo = [];
    let inventoryFailed = false;
    if (!fromExplicit || fromExplicit.length === 0) {
      try {
        const listed = await io.listDirectories();
        if (!Array.isArray(listed)) {
          inventoryFailed = true;
        } else {
          fromIo = listed;
        }
      } catch {
        inventoryFailed = true;
        fromIo = [];
      }
    }
    const fromRequests = Array.from(requests.values()).map((entry) => entry.directory);
    const scopes = mergeDirectoryLists(
      fromExplicit,
      fromIo,
      fromRequests,
      Array.from(observedDirectories),
    );
    return { scopes, inventoryFailed };
  };

  const runReconcileOnce = async (directories) => {
    coverageState = 'reconciling';
    bump();

    const knownAtStart = new Set(requests.keys());
    const { scopes, inventoryFailed } = await collectInventoryDirectories(directories);

    const nextFailed = [];
    if (inventoryFailed && (!Array.isArray(directories) || directories.length === 0)) {
      // Full inventory failure — do not settle anything; surface partial.
      failedDirectories = mergeDirectoryLists(failedDirectories, scopes, Array.from(observedDirectories));
      if (failedDirectories.length === 0) failedDirectories = ['_inventory'];
      coverageState = 'partial';
      bump();
      return snapshot();
    }

    /** @type {Set<string>} directories whose list call returned authoritative data */
    const successfulDirectories = new Set();
    /** @type {Map<string, ReturnType<typeof normalizeQuestion>>} */
    const pendingById = new Map();

    for (const directory of scopes) {
      let listed;
      try {
        listed = await io.listQuestions(directory);
      } catch {
        listed = null;
      }
      if (listed == null) {
        nextFailed.push(directory);
        continue;
      }
      successfulDirectories.add(directory);
      for (const item of listed) {
        const normalized = normalizeQuestion(item, directory);
        if (!normalized) continue;
        if (!normalized.directory) normalized.directory = directory;
        pendingById.set(normalized.requestID, normalized);
        rememberSession({ id: normalized.sessionID, directory: normalized.directory }, normalized.directory);
      }
    }

    // Optional unscoped pass only discovers unknowns; never settles whole catalog.
    let unscopedListed = null;
    try {
      unscopedListed = await io.listQuestions(undefined);
    } catch {
      unscopedListed = null;
    }
    if (Array.isArray(unscopedListed)) {
      for (const item of unscopedListed) {
        const normalized = normalizeQuestion(item, '');
        if (!normalized) continue;
        // Prefer directory already known from scoped success.
        if (!normalized.directory) {
          const existing = pendingById.get(normalized.requestID);
          if (existing?.directory) normalized.directory = existing.directory;
        }
        if (!pendingById.has(normalized.requestID)) {
          pendingById.set(normalized.requestID, normalized);
        }
        if (normalized.directory) {
          rememberSession({ id: normalized.sessionID, directory: normalized.directory }, normalized.directory);
        }
      }
    }

    failedDirectories = Array.from(new Set(nextFailed));
    let changed = false;
    /** @type {Array<Promise<void>>} */
    const lineageWork = [];

    for (const normalized of pendingById.values()) {
      const result = trackQuestion(normalized, { resetIfDuplicate: false });
      if (result.changed) changed = true;
      if (settingsAllowAuto() && result.entry.state === 'disabled') {
        ensureCounting(result.entry, { resetDeadline: true });
        changed = true;
      } else if (settingsAllowAuto() && result.entry.state === 'counting' && !result.entry.timer) {
        scheduleAuto(result.entry);
      }
      // Unscoped (or otherwise unbound) pending must resolve real directory via
      // session lineage before any auto timer can arm.
      if (
        result.entry
        && !asTrimmedString(result.entry.directory)
        && result.entry.state === 'counting'
      ) {
        lineageWork.push(
          ensureSessionLineage(result.entry.sessionID, '', result.entry.requestID),
        );
      }
    }
    if (lineageWork.length > 0) {
      await Promise.all(lineageWork);
      // Lineage write-back may have armed timers; recount change signal.
      changed = true;
    }

    // Settle only entries whose authoritative directory was successfully listed empty/missing.
    for (const entry of requests.values()) {
      if (!knownAtStart.has(entry.requestID)) continue;
      if (pendingById.has(entry.requestID)) continue;
      const dir = asTrimmedString(entry.directory);
      if (!dir || !successfulDirectories.has(dir)) continue;
      if (entry.state === 'submitting') continue;
      // counting/paused/disabled/uncertain with scoped authoritative absence → external.
      if (
        entry.state === 'counting'
        || entry.state === 'paused'
        || entry.state === 'disabled'
        || entry.state === 'uncertain'
      ) {
        markSettled(entry, 'external', entry.submittedBy);
        changed = true;
      }
    }

    coverageState = failedDirectories.length > 0 || inventoryFailed ? 'partial' : 'ready';
    if (changed || true) bump();
    return snapshot();
  };

  const reconcile = async ({ directories } = {}) => {
    if (disposed) return snapshot();

    const requested = Array.isArray(directories)
      ? directories.map(asTrimmedString).filter(Boolean)
      : null;

    if (reconcilePromise) {
      trailingReconcileDirectories = mergeDirectoryLists(
        trailingReconcileDirectories,
        requested,
      );
      return reconcilePromise.then(async () => {
        if (!trailingReconcileDirectories) return snapshot();
        const next = trailingReconcileDirectories;
        trailingReconcileDirectories = null;
        return reconcile({ directories: next });
      });
    }

    reconcilePromise = runReconcileOnce(requested)
      .catch((error) => {
        coverageState = 'partial';
        console.warn('[question-auto-delegate] reconcile failed:', error?.message ?? error);
        return snapshot();
      })
      .finally(() => {
        reconcilePromise = null;
      });

    return reconcilePromise;
  };

  const processEvent = (payload, directoryHint = '') => {
    if (disposed || !payload || typeof payload !== 'object') return;
    const type = typeof payload.type === 'string' ? payload.type : '';
    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    const hint = asTrimmedString(directoryHint);

    if (type === 'session.created' || type === 'session.updated') {
      rememberSession(properties.info, hint);
      const info = properties.info;
      const sessionId = asTrimmedString(info?.id);
      const directory = asTrimmedString(info?.directory) || hint;
      if (sessionId && directory) {
        let changed = false;
        for (const entry of requests.values()) {
          if (entry.sessionID !== sessionId) continue;
          if (bindDirectoryToEntry(entry, directory, { restartTimer: true })) changed = true;
        }
        if (changed) bump();
      }
      return;
    }

    if (type === 'question.asked') {
      const normalized = normalizeQuestion(properties, hint);
      if (!normalized) return;
      rememberSession({ id: normalized.sessionID, directory: normalized.directory }, normalized.directory || hint);
      if (!normalized.directory) {
        const cached = sessions.get(normalized.sessionID);
        if (cached?.directory) normalized.directory = cached.directory;
      }
      const { changed } = trackQuestion(normalized, { resetIfDuplicate: false });
      if (changed) bump();
      // Lineage + directory write-back; timer only arms after authoritative directory binds.
      void ensureSessionLineage(normalized.sessionID, normalized.directory || hint, normalized.requestID);
      return;
    }

    if (type === 'question.replied' || type === 'question.rejected') {
      const requestID = asTrimmedString(properties.id) || asTrimmedString(properties.requestID);
      if (!requestID) return;
      const entry = requests.get(requestID);
      if (!entry) return;
      if (entry.state === TERMINAL_SETTLED) return;
      const resolution = type === 'question.rejected' ? 'rejected' : 'replied';
      if (entry.state === 'uncertain' || entry.state === 'submitting') {
        markSettled(entry, resolution, entry.submittedBy ?? null);
        bump();
        return;
      }
      markSettled(entry, 'external', entry.submittedBy);
      bump();
    }
  };

  const collectDescendants = (rootId) => {
    const out = new Set([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, info] of sessions.entries()) {
        if (out.has(id)) continue;
        if (info.parentID && out.has(info.parentID)) {
          out.add(id);
          grew = true;
        }
      }
    }
    return out;
  };

  const isBlockingSession = (sessionID) => {
    const id = asTrimmedString(sessionID);
    if (!id) return false;
    const scope = collectDescendants(id);
    for (const entry of requests.values()) {
      if (!BLOCKING_STATES.has(entry.state)) continue;
      if (scope.has(entry.sessionID)) return true;
    }
    return false;
  };

  const isAutoHandling = (sessionID, requestID) => {
    if (!settingsAllowAuto()) return false;
    if (requestID) {
      const entry = requests.get(asTrimmedString(requestID));
      if (!entry) return settingsAllowAuto();
      return entry.state === 'counting' || entry.state === 'submitting';
    }
    const id = asTrimmedString(sessionID);
    if (!id) return settingsAllowAuto();
    for (const entry of requests.values()) {
      if (entry.sessionID !== id) continue;
      if (entry.state === 'counting' || entry.state === 'submitting') return true;
    }
    return settingsAllowAuto();
  };

  /**
   * Goal pause/abort reverse path: pause all related question timers for a session tree.
   * Uses owner/root directory from lineage when available.
   */
  const pauseForSessionTree = async (sessionID, directoryHint = '') => {
    const id = asTrimmedString(sessionID);
    if (!id) return snapshot();
    const root = resolveRootSession(id);
    const scope = collectDescendants(root.sessionID || id);
    // Also include the provided session and its descendants if root resolution was incomplete.
    for (const child of collectDescendants(id)) scope.add(child);

    let changed = false;
    for (const entry of requests.values()) {
      if (!scope.has(entry.sessionID)) continue;
      if (entry.state === TERMINAL_SETTLED || entry.state === 'uncertain' || entry.state === 'submitting') continue;
      clearTimer(entry);
      if (entry.state !== 'paused' || entry.pauseReason !== 'goal') {
        entry.state = 'paused';
        entry.deadlineAt = null;
        entry.pauseReason = 'goal';
        changed = true;
      }
      if (!entry.directory && (root.directory || directoryHint)) {
        entry.directory = root.directory || asTrimmedString(directoryHint);
        noteDirectory(entry.directory);
      }
    }
    if (changed) bump();
    return snapshot();
  };

  const start = () => {
    if (started) return () => {};
    started = true;
    const bootGeneration = settingsGeneration;
    void (async () => {
      let readResult;
      try {
        readResult = await io.readEnabled();
      } catch {
        readResult = null;
      }
      // applyEnabled (before or during boot) always wins over a stale disk read.
      if (settingsGeneration !== bootGeneration || settingsStatus === 'ready') {
        await reconcile();
        return;
      }
      if (readResult === null || readResult === undefined) {
        settingsStatus = 'unavailable';
        enabled = false;
        coverageState = 'partial';
        for (const entry of requests.values()) {
          clearTimer(entry);
          entry.deadlineAt = null;
        }
        bump();
        await reconcile();
        return;
      }
      settingsStatus = 'ready';
      enabled = readResult !== false;
      bump();
      if (enabled) {
        for (const entry of requests.values()) {
          if (entry.state === 'counting') ensureCounting(entry, { resetDeadline: false });
        }
      } else {
        for (const entry of requests.values()) {
          if (entry.state === TERMINAL_SETTLED || entry.state === 'uncertain' || entry.state === 'submitting') continue;
          clearTimer(entry);
          entry.state = 'disabled';
          entry.deadlineAt = null;
        }
      }
      await reconcile();
    })();

    return () => {
      dispose();
    };
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const entry of requests.values()) clearTimer(entry);
    if (typeof stopHub === 'function') {
      try {
        stopHub();
      } catch {
        // ignore
      }
      stopHub = null;
    }
  };

  const attachStop = (fn) => {
    stopHub = typeof fn === 'function' ? fn : null;
  };

  return {
    start,
    dispose,
    snapshot,
    applyEnabled,
    pause,
    delegate,
    submit: submitInternal,
    reconcile,
    processEvent,
    isBlockingSession,
    isAutoHandling,
    pauseForSessionTree,
    resolveRootSession,
    /** @internal */
    _attachStop: attachStop,
  };
}
