import crypto from 'node:crypto';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { DateTime } from 'luxon';
import parser from 'cron-parser';
import { expandSnippets } from '../opencode/snippets.js';

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_PROJECT_CONCURRENCY = 2;
const DEFAULT_MAX_RUN_MS = 2 * 60 * 60 * 1000;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const SCHEDULED_TITLE_PREFIX = '[Scheduled] ';
const TASK_DUE_SLACK_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PROJECT_SYNC_RETRY_DELAY_MS = 1_000;
const MAX_PROJECT_SYNC_RETRIES = 3;
const ARCHIVE_404_RETRY_DELAY_MS = 250;
/** Poll interval while waiting for the OpenCode session turn (or goal) to settle. */
const SESSION_SETTLEMENT_POLL_MS = 1_000;
/**
 * Incomplete assistant tails while idle need a couple of stable polls before we
 * treat them as settled (OpenCode sometimes leaves time.completed unset).
 */
const INCOMPLETE_ASSISTANT_SETTLE_PROBES = 2;
/** Goal terminal statuses — active/paused mean the run is still open. */
const GOAL_TERMINAL_STATUSES = new Set(['complete', 'blocked', 'budgetLimited']);

const buildTaskKey = (projectID, taskID) => `${projectID}:${taskID}`;

const parseTimeParts = (time) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof time === 'string' ? time : '');
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const applyTimeToDate = (baseDateTime, time) => {
  const parsed = parseTimeParts(time);
  if (!parsed) {
    return null;
  }
  return baseDateTime.set({
    hour: parsed.hour,
    minute: parsed.minute,
    second: 0,
    millisecond: 0,
  });
};

const resolveScheduleTimes = (schedule) => {
  const times = [];
  if (Array.isArray(schedule?.times)) {
    for (const candidate of schedule.times) {
      if (typeof candidate === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(candidate)) {
        times.push(candidate);
      }
    }
  }
  if (times.length === 0 && typeof schedule?.time === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time)) {
    times.push(schedule.time);
  }
  return Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
};

const weekdayAsZeroBased = (dateTime) => {
  if (!dateTime || typeof dateTime.weekday !== 'number') {
    return null;
  }
  return dateTime.weekday % 7;
};

const safeErrorMessage = (error, maxLength = 2_000) => {
  const raw = error instanceof Error
    ? (error.message || String(error))
    : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export const parseScheduledCommandPrompt = (prompt) => {
  if (typeof prompt !== 'string') {
    return null;
  }

  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0] || '';
  const [head, ...tail] = firstLine.split(/\s+/);
  const commandName = (head || '').slice(1).trim();
  if (!commandName) {
    return null;
  }

  return {
    command: commandName,
    arguments: tail.join(' ').trim(),
  };
};

export const computeNextRunAt = (task, nowMs = Date.now()) => {
  if (!task?.enabled) {
    return null;
  }

  const schedule = task.schedule;
  if (!schedule || typeof schedule !== 'object') {
    return null;
  }

  const zone = typeof schedule.timezone === 'string' && schedule.timezone.trim().length > 0
    ? schedule.timezone.trim()
    : DateTime.local().zoneName;

  const now = DateTime.fromMillis(nowMs, { zone });
  if (!now.isValid) {
    return null;
  }

  if (schedule.kind === 'daily') {
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (const time of times) {
      const candidateToday = applyTimeToDate(now, time);
      if (!candidateToday || !candidateToday.isValid) {
        continue;
      }
      if (candidateToday > minAllowed) {
        return candidateToday.toMillis();
      }
    }

    const tomorrow = now.plus({ days: 1 });
    const firstTomorrow = applyTimeToDate(tomorrow, times[0]);
    return firstTomorrow?.isValid ? firstTomorrow.toMillis() : null;
  }

  if (schedule.kind === 'weekly') {
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length === 0) {
      return null;
    }
    const times = resolveScheduleTimes(schedule);
    if (times.length === 0) {
      return null;
    }
    const weekdaysSet = new Set(schedule.weekdays);
    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });

    for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
      const dayCandidate = now.plus({ days: dayOffset });
      const zeroBasedWeekday = weekdayAsZeroBased(dayCandidate);
      if (zeroBasedWeekday === null || !weekdaysSet.has(zeroBasedWeekday)) {
        continue;
      }
      for (const time of times) {
        const withTime = applyTimeToDate(dayCandidate, time);
        if (!withTime || !withTime.isValid) {
          continue;
        }
        if (withTime > minAllowed) {
          return withTime.toMillis();
        }
      }
    }
    return null;
  }

  if (schedule.kind === 'once') {
    if (typeof schedule.date !== 'string' || typeof schedule.time !== 'string') {
      return null;
    }

    const parsed = DateTime.fromFormat(
      `${schedule.date} ${schedule.time}`,
      'yyyy-LL-dd HH:mm',
      { zone },
    );
    if (!parsed.isValid) {
      return null;
    }

    const minAllowed = now.plus({ milliseconds: TASK_DUE_SLACK_MS });
    if (parsed <= minAllowed) {
      return null;
    }

    return parsed.toMillis();
  }

  if (schedule.kind === 'cron') {
    try {
      const iterator = parser.parseExpression(schedule.cron, {
        tz: zone,
        currentDate: new Date(nowMs),
      });
      return iterator.next().getTime();
    } catch {
      return null;
    }
  }

  return null;
};

export const formatScheduledSessionTitle = (task, nowMs = Date.now()) => {
  const timezone = typeof task?.schedule?.timezone === 'string' && task.schedule.timezone.trim().length > 0
    ? task.schedule.timezone.trim()
    : DateTime.local().zoneName;
  const stamp = DateTime.fromMillis(nowMs, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm');
  const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
    ? task.name.trim()
    : 'Schedule';
  const suffix = ` ${stamp}`;
  const maxTaskNameLength = Math.max(
    1,
    TASK_TITLE_MAX_LENGTH - SCHEDULED_TITLE_PREFIX.length - suffix.length,
  );
  const trimmedName = taskName.length > maxTaskNameLength
    ? taskName.slice(0, maxTaskNameLength)
    : taskName;
  return `${SCHEDULED_TITLE_PREFIX}${trimmedName}${suffix}`;
};

const buildScheduledTaskMetadata = ({ projectID, taskID, runID, name }) => ({
  openchamber: {
    scheduledTask: {
      projectID,
      taskID,
      runID,
      name,
    },
  },
});

const isMissingSessionError = (result) => {
  const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status;
  return status === 404 || result?.error?.code === 'not_found';
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return;
  }
  const timer = setTimeout(() => {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

const readMessageInfo = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  const info = entry.info && typeof entry.info === 'object' ? entry.info : entry;
  if (!info || typeof info !== 'object') return null;
  return info;
};

const formatAssistantError = (error) => {
  if (!error || typeof error !== 'object') {
    return 'assistant error';
  }
  if (typeof error.name === 'string' && error.name.trim()) {
    return error.name.trim();
  }
  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return 'assistant error';
};

const extractGoalFromSession = (session) => {
  const metadata = session?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const namespace = metadata.openchamber;
  if (!namespace || typeof namespace !== 'object') return null;
  const goal = namespace.goal;
  if (!goal || typeof goal !== 'object') return null;
  const status = typeof goal.status === 'string' ? goal.status.trim() : '';
  if (!status) return null;
  return {
    status,
    note: typeof goal.note === 'string' ? goal.note.trim() : '',
  };
};

/**
 * Single-shot session outcome for post-run continuation (no polling).
 * Goal-enabled: terminal complete → success; blocked/budgetLimited → error;
 * otherwise not-yet-success. Non-goal: busy/retry, assistant error, or
 * completed assistant; incomplete/empty tails are not treated as success.
 */
const snapshotSessionOutcome = async ({
  client,
  sessionID,
  projectPath,
  goalEnabled,
  signal,
}) => {
  const requestOptions = signal ? { signal } : undefined;

  if (goalEnabled && typeof client?.session?.get === 'function') {
    try {
      const sessionResult = await client.session.get({
        sessionID,
        directory: projectPath,
      }, requestOptions);
      if (!sessionResult?.error) {
        const goal = extractGoalFromSession(sessionResult?.data);
        if (goal && GOAL_TERMINAL_STATUSES.has(goal.status)) {
          if (goal.status === 'complete') {
            return { outcome: 'success' };
          }
          return {
            outcome: 'error',
            error: goal.note || `goal ${goal.status}`,
          };
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return { outcome: 'busy' };
  }

  if (typeof client?.session?.status === 'function') {
    try {
      const statusResult = await client.session.status({
        directory: projectPath,
      }, requestOptions);
      if (!statusResult?.error && statusResult?.data && typeof statusResult.data === 'object') {
        const statusValue = statusResult.data[sessionID];
        const type = statusValue?.type ?? statusValue?.status;
        if (type === 'busy' || type === 'retry') {
          return { outcome: 'busy' };
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  if (typeof client?.session?.messages === 'function') {
    try {
      const messagesResult = await client.session.messages({
        sessionID,
        directory: projectPath,
        limit: 50,
      }, requestOptions);
      if (!messagesResult?.error && Array.isArray(messagesResult?.data)) {
        const lastInfo = readMessageInfo(messagesResult.data.at(-1));
        if (lastInfo?.role === 'assistant') {
          if (lastInfo.error) {
            return {
              outcome: 'error',
              error: formatAssistantError(lastInfo.error),
            };
          }
          if (lastInfo.time?.completed) {
            return { outcome: 'success' };
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }

  return { outcome: 'busy' };
};

const parseSessionEventIdle = (event) => {
  const payload = event?.payload?.payload ?? event?.payload;
  const properties = payload?.properties;
  const sessionID = typeof properties?.sessionID === 'string' ? properties.sessionID : '';
  if (!sessionID) {
    return { idle: false, sessionID: '' };
  }
  if (payload?.type === 'session.idle') {
    return { idle: true, sessionID };
  }
  if (payload?.type === 'session.status') {
    const type = properties?.status?.type ?? properties?.info?.type;
    return { idle: type === 'idle', sessionID };
  }
  return { idle: false, sessionID };
};

export const createScheduledTasksRuntime = (deps) => {
  const {
    projectConfigRuntime,
    listProjects,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    getSmallModelService,
    waitForOpenCodeReady,
    emitTaskRunEvent,
    runHistoryStore = null,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxProjectConcurrency = DEFAULT_PROJECT_CONCURRENCY,
    maxRunDurationMs = DEFAULT_MAX_RUN_MS,
  } = deps;

  let started = false;
  const tasksByProject = new Map();
  const projectPathByID = new Map();
  const timersByTaskKey = new Map();
  const projectSyncRetriesByProjectID = new Map();
  const queuedTaskKeys = new Set();
  const runningTaskKeys = new Set();
  const runningCountByProject = new Map();
  let runningGlobalCount = 0;
  const queue = [];
  /** sessionID → { projectID, taskID } for post-run continuation correction. */
  const lastSessionOwners = new Map();

  const rememberLastSession = (projectID, task) => {
    const sessionID = task?.state?.lastSessionId;
    if (typeof sessionID !== 'string' || !sessionID || !task?.id) {
      return;
    }
    lastSessionOwners.set(sessionID, { projectID, taskID: task.id });
  };

  const forgetLastSessionsForProject = (projectID) => {
    for (const [sessionID, owner] of [...lastSessionOwners.entries()]) {
      if (owner.projectID === projectID) {
        lastSessionOwners.delete(sessionID);
      }
    }
  };

  const forgetLastSessionIfOwned = (projectID, taskID, sessionID) => {
    if (typeof sessionID !== 'string' || !sessionID) {
      return;
    }
    const owner = lastSessionOwners.get(sessionID);
    if (owner?.projectID === projectID && owner?.taskID === taskID) {
      lastSessionOwners.delete(sessionID);
    }
  };

  const clearTimerForKey = (taskKey) => {
    const timer = timersByTaskKey.get(taskKey);
    if (timer) {
      clearTimeout(timer);
      timersByTaskKey.delete(taskKey);
    }
  };

  const clearProjectTimers = (projectID) => {
    const tasks = tasksByProject.get(projectID);
    if (!tasks) {
      return;
    }
    for (const task of tasks.values()) {
      clearTimerForKey(buildTaskKey(projectID, task.id));
      queuedTaskKeys.delete(buildTaskKey(projectID, task.id));
    }
  };

  const clearProjectSyncRetry = (projectID) => {
    const retry = projectSyncRetriesByProjectID.get(projectID);
    if (retry?.timer) {
      clearTimeout(retry.timer);
    }
    projectSyncRetriesByProjectID.delete(projectID);
  };

  const setProjectTasks = (projectID, tasks) => {
    clearProjectTimers(projectID);
    forgetLastSessionsForProject(projectID);
    const taskMap = new Map();
    for (const task of tasks) {
      taskMap.set(task.id, task);
      rememberLastSession(projectID, task);
    }
    tasksByProject.set(projectID, taskMap);
  };

  const scheduleTask = (projectID, taskID, nextRunAt) => {
    const taskKey = buildTaskKey(projectID, taskID);
    clearTimerForKey(taskKey);

    if (!started) {
      return;
    }

    if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
      return;
    }

    const delayBase = Math.max(0, Math.round(nextRunAt - Date.now()));
    const jitter = Math.floor(Math.random() * (JITTER_MAX_MS + 1));
    const delay = delayBase + jitter;
    const boundedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(async () => {
      if (delay > MAX_TIMER_DELAY_MS) {
        scheduleTask(projectID, taskID, nextRunAt);
        return;
      }

      clearTimerForKey(taskKey);
      const taskMap = tasksByProject.get(projectID);
      const task = taskMap?.get(taskID);
      if (!task || !task.enabled) {
        return;
      }
      queueTaskRun(projectID, taskID, 'scheduled');
      pumpQueue();
    }, boundedDelay);

    timersByTaskKey.set(taskKey, timer);
  };

  const updateInMemoryTask = (projectID, nextTask) => {
    if (!nextTask) {
      return;
    }
    const taskMap = tasksByProject.get(projectID);
    if (!taskMap) {
      return;
    }
    const previous = taskMap.get(nextTask.id);
    const previousSessionID = previous?.state?.lastSessionId;
    const nextSessionID = nextTask.state?.lastSessionId;
    if (previousSessionID && previousSessionID !== nextSessionID) {
      forgetLastSessionIfOwned(projectID, nextTask.id, previousSessionID);
    }
    taskMap.set(nextTask.id, nextTask);
    rememberLastSession(projectID, nextTask);
  };

  const syncTaskSchedule = async (projectID, task) => {
    if (!task) {
      return;
    }
    const nextRunAt = computeNextRunAt(task, Date.now());
    const statePatch = {
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: Date.now(),
    };
    const result = await projectConfigRuntime.updateScheduledTaskState(projectID, task.id, statePatch);
    if (result.task) {
      updateInMemoryTask(projectID, result.task);
      if (result.task.enabled && Number.isFinite(result.task.state?.nextRunAt)) {
        scheduleTask(projectID, result.task.id, result.task.state.nextRunAt);
      }
    }
  };

  const ensureProjectPath = async (projectID) => {
    if (projectPathByID.has(projectID)) {
      return projectPathByID.get(projectID) || null;
    }

    try {
      const projects = await listProjects();
      const project = projects.find((item) => item?.id === projectID && item?.path);
      if (project?.path) {
        projectPathByID.set(projectID, project.path);
        return project.path;
      }
    } catch {
    }

    return null;
  };

  const syncProject = async (projectID) => {
    await ensureProjectPath(projectID);

    const tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    setProjectTasks(projectID, tasks);

    for (const task of tasks) {
      await syncTaskSchedule(projectID, task);
    }

    return tasks;
  };

  const scheduleProjectSyncRetry = (projectID, previousAttempts = 0) => {
    if (!started || previousAttempts >= MAX_PROJECT_SYNC_RETRIES || projectSyncRetriesByProjectID.has(projectID)) {
      return;
    }

    const attempts = previousAttempts + 1;
    const timer = setTimeout(() => {
      projectSyncRetriesByProjectID.delete(projectID);
      if (!started) {
        return;
      }
      void syncProject(projectID).then(() => {
        clearProjectSyncRetry(projectID);
      }).catch((error) => {
        logger.warn?.('[ScheduledTasks] project sync retry failed', {
          projectID,
          attempt: attempts,
          error: safeErrorMessage(error),
        });
        scheduleProjectSyncRetry(projectID, attempts);
      });
    }, PROJECT_SYNC_RETRY_DELAY_MS);
    timer.unref?.();
    projectSyncRetriesByProjectID.set(projectID, { timer, attempts });
  };

  const syncAllProjects = async () => {
    const projects = await listProjects();
    const activeProjectIDs = new Set();
    projectPathByID.clear();
    for (const project of projects) {
      if (!project?.id || !project?.path) {
        continue;
      }
      activeProjectIDs.add(project.id);
      projectPathByID.set(project.id, project.path);
    }

    for (const existingProjectID of Array.from(tasksByProject.keys())) {
      if (!activeProjectIDs.has(existingProjectID)) {
        clearProjectTimers(existingProjectID);
        clearProjectSyncRetry(existingProjectID);
        tasksByProject.delete(existingProjectID);
      }
    }

    for (const projectID of activeProjectIDs) {
      try {
        await syncProject(projectID);
        clearProjectSyncRetry(projectID);
      } catch (error) {
        logger.warn?.('[ScheduledTasks] project sync failed', {
          projectID,
          error: safeErrorMessage(error),
        });
        scheduleProjectSyncRetry(projectID);
      }
    }
  };

  const queueTaskRun = (projectID, taskID, reason) => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (queuedTaskKeys.has(taskKey) || runningTaskKeys.has(taskKey)) {
      return;
    }
    queuedTaskKeys.add(taskKey);
    queue.push({ projectID, taskID, reason });
  };

  const canRunTask = (projectID) => {
    if (runningGlobalCount >= maxGlobalConcurrency) {
      return false;
    }
    const projectRunning = runningCountByProject.get(projectID) || 0;
    return projectRunning < maxProjectConcurrency;
  };

  // Same instruction the composer attaches on an armed goal send: the agent
  // must know goal mode is on from turn one, and each turn has to end with a
  // factual report for the independent audit.
  const buildGoalIntroText = (tokenBudget) => {
    const budgetLine = tokenBudget
      ? ` A token budget of ${tokenBudget} tokens applies to this goal.`
      : '';
    return '<system-reminder>\n'
      + 'Goal mode is active for this session. The user message above defines the goal objective. '
      + 'Work toward it across turns; whenever you stop before the objective is verifiably complete, the system will automatically prompt you to continue. '
      + 'Progress is evaluated independently after each turn, so end every turn with a clear, factual statement of what is done, what was verified, and what remains.'
      + budgetLine
      + '\n</system-reminder>';
  };

  const buildPromptAsyncPayload = (task, projectPath) => ({
    model: {
      providerID: task.execution.providerID,
      modelID: task.execution.modelID,
    },
    ...(task.execution.agent ? { agent: task.execution.agent } : {}),
    ...(task.execution.variant ? { variant: task.execution.variant } : {}),
    parts: [
      {
        type: 'text',
        text: expandSnippets(task.execution.prompt, projectPath),
      },
      ...(task.execution.goalEnabled
        ? [{ type: 'text', text: buildGoalIntroText(task.execution.goalTokenBudget), synthetic: true }]
        : []),
    ],
  });

  // Scheduled goal runs: stamp the goal onto the fresh session's metadata
  // before the prompt goes out; the session-goal runtime picks the loop up
  // from session events like any other goal.
  const createTaskGoal = async ({
    baseUrl,
    authHeaders,
    sessionID,
    projectPath,
    task,
    scheduledTaskMarker,
    signal,
  }) => {
    signal?.throwIfAborted?.();
    const now = Date.now();
    // File-backed objective keyed by session id: metadata stays light, the
    // full expanded prompt lives under the OpenChamber data dir. If the file
    // write fails, fall back to an inline (clamped) objective.
    // Oversized prompts are distilled into audit criteria by the small model
    // (the working agent gets the full prompt in chat anyway); on distill
    // failure a head+tail excerpt keeps intent and acceptance criteria.
    let objectiveText = expandSnippets(task.execution.prompt, projectPath);
    if (objectiveText.length > 5000) {
      let distilled = null;
      try {
        signal?.throwIfAborted?.();
        const service = typeof getSmallModelService === 'function'
          ? await getSmallModelService()
          : null;
        signal?.throwIfAborted?.();
        if (!service?.generateSmallModelText) {
          throw new Error('Small model service is not configured');
        }
        const generated = await service.generateSmallModelText({
          restrictToPreferredProvider: true,
          prompt: objectiveText,
          system: [
            'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
            'Return ONLY the criteria text — no preamble, no headers, no markdown fences.',
            'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
            'Preserve verbatim any file paths, commands, and identifiers that define the task.',
            'Stay under 4000 characters.',
            'Write in the same language as the task text.',
          ].join('\n'),
          directory: projectPath,
          preferredProviderID: task.execution.providerID,
          preferredModelID: task.execution.modelID,
        });
        signal?.throwIfAborted?.();
        distilled = typeof generated?.text === 'string' ? generated.text.trim() : null;
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        console.warn('[scheduled-tasks] goal objective distillation failed:', error?.message || error);
      }
      if (distilled) {
        objectiveText = distilled;
      } else {
        const marker = '\n\n[… objective trimmed for the auditor — the full prompt was delivered in the chat message …]\n\n';
        const half = Math.max(0, Math.floor((5000 - marker.length) / 2));
        objectiveText = `${objectiveText.slice(0, half)}${marker}${objectiveText.slice(-half)}`;
      }
    }
    signal?.throwIfAborted?.();
    let objectiveFile = false;
    try {
      const { writeObjective } = await import('../session-goal/objectives.js');
      await writeObjective(sessionID, objectiveText);
      signal?.throwIfAborted?.();
      objectiveFile = true;
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      console.warn('[scheduled-tasks] goal objective file write failed, falling back to inline:', error?.message || error);
    }
    signal?.throwIfAborted?.();
    const goal = {
      id: `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      objective: objectiveFile ? '' : objectiveText.slice(0, 5000),
      objectiveFile,
      status: 'active',
      tokenBudget: task.execution.goalTokenBudget || null,
      tokensUsed: 0,
      turnsUsed: 0,
      blockedStreak: 0,
      note: '',
      statusReason: '',
      lastAccountedMessageID: '',
      createdAt: now,
      updatedAt: now,
    };
    const url = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}`);
    url.searchParams.set('directory', projectPath);
    // Preserve the scheduledTask marker when goal metadata is patched; a full
    // openchamber replace would otherwise drop ownership for history/UI.
    const response = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        metadata: {
          openchamber: {
            ...(scheduledTaskMarker ? { scheduledTask: scheduledTaskMarker } : {}),
            goal,
          },
        },
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`goal metadata patch failed (${response.status})`);
    }
  };

  const archiveSessionBeforePrompt = async ({ client, sessionID, projectPath, signal }) => {
    const archivePayload = {
      sessionID,
      directory: projectPath,
      time: { archived: Date.now() },
    };
    const requestOptions = signal ? { signal } : undefined;
    let result = await client.session.update(archivePayload, requestOptions);
    if (isMissingSessionError(result)) {
      await sleep(ARCHIVE_404_RETRY_DELAY_MS, signal);
      signal?.throwIfAborted?.();
      result = await client.session.update(archivePayload, requestOptions);
    }
    if (result?.error || (result?.data == null && result?.response?.ok === false)) {
      const status = result?.error?.status ?? result?.error?.statusCode ?? result?.status;
      const message = result?.error?.message || result?.error?.data?.message || 'session archive failed';
      throw new Error(`session archive failed${status ? ` (${status})` : ''}: ${message}`);
    }
  };

  const runPromptAsync = async ({ baseUrl, authHeaders, sessionID, projectPath, task, signal }) => {
    signal?.throwIfAborted?.();
    const promptUrl = new URL(`${baseUrl}/session/${encodeURIComponent(sessionID)}/prompt_async`);
    promptUrl.searchParams.set('directory', projectPath);
    const response = await fetch(promptUrl.toString(), {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildPromptAsyncPayload(task, projectPath)),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`prompt_async failed (${response.status})${body ? `: ${body}` : ''}`);
    }
  };

  /**
   * prompt_async / command return when the turn is *admitted*, not when the
   * agent finishes. History must reflect the real session (or goal) outcome and
   * wall-clock duration — poll OpenCode until idle+settled or a terminal goal.
   */
  const waitForRunOutcome = async ({
    client,
    sessionID,
    projectPath,
    goalEnabled,
    signal,
  }) => {
    const requestOptions = signal ? { signal } : undefined;
    let incompleteAssistantProbes = 0;
    let emptyIdleProbes = 0;

    for (;;) {
      signal?.throwIfAborted?.();

      if (goalEnabled && typeof client?.session?.get === 'function') {
        try {
          const sessionResult = await client.session.get({
            sessionID,
            directory: projectPath,
          }, requestOptions);
          if (!sessionResult?.error) {
            const goal = extractGoalFromSession(sessionResult?.data);
            if (goal && GOAL_TERMINAL_STATUSES.has(goal.status)) {
              if (goal.status === 'complete') {
                return { outcome: 'success' };
              }
              return {
                outcome: 'error',
                error: goal.note || `goal ${goal.status}`,
              };
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          // Transient get failures: keep polling until watchdog aborts.
        }
      }

      let sessionBusy = false;
      if (typeof client?.session?.status === 'function') {
        try {
          const statusResult = await client.session.status({
            directory: projectPath,
          }, requestOptions);
          if (!statusResult?.error && statusResult?.data && typeof statusResult.data === 'object') {
            const statusValue = statusResult.data[sessionID];
            const type = statusValue?.type ?? statusValue?.status;
            sessionBusy = type === 'busy' || type === 'retry';
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }

      if (sessionBusy) {
        incompleteAssistantProbes = 0;
        emptyIdleProbes = 0;
        await sleep(SESSION_SETTLEMENT_POLL_MS, signal);
        continue;
      }

      // Non-goal runs settle on the first idle assistant tail. Goal runs only
      // finish via terminal goal status above — idle between goal turns is normal.
      if (!goalEnabled && typeof client?.session?.messages === 'function') {
        try {
          const messagesResult = await client.session.messages({
            sessionID,
            directory: projectPath,
            limit: 50,
          }, requestOptions);
          if (!messagesResult?.error && Array.isArray(messagesResult?.data)) {
            const lastInfo = readMessageInfo(messagesResult.data.at(-1));
            if (lastInfo?.role === 'assistant') {
              emptyIdleProbes = 0;
              if (lastInfo.error) {
                return {
                  outcome: 'error',
                  error: formatAssistantError(lastInfo.error),
                };
              }
              if (lastInfo.time?.completed) {
                return { outcome: 'success' };
              }
              incompleteAssistantProbes += 1;
              if (incompleteAssistantProbes >= INCOMPLETE_ASSISTANT_SETTLE_PROBES) {
                return { outcome: 'success' };
              }
            } else {
              incompleteAssistantProbes = 0;
              emptyIdleProbes += 1;
              // Prompt admitted but no assistant yet, or aborted before reply.
              // Allow several idle probes so we don't race the first token.
              if (emptyIdleProbes >= 5 && lastInfo?.role === 'user') {
                return {
                  outcome: 'error',
                  error: 'session ended without assistant response',
                };
              }
            }
          }
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }

      await sleep(SESSION_SETTLEMENT_POLL_MS, signal);
    }
  };

  const runScheduledCommandIfApplicable = async ({ client, projectPath, sessionID, task, signal }) => {
    signal?.throwIfAborted?.();
    const parsed = parseScheduledCommandPrompt(task?.execution?.prompt);
    if (!parsed) {
      return false;
    }

    const requestOptions = signal ? { signal } : undefined;
    let commands = [];
    try {
      const response = await client.command.list({ directory: projectPath }, requestOptions);
      commands = Array.isArray(response?.data) ? response.data : [];
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return false;
    }

    signal?.throwIfAborted?.();
    const hasMatchingCommand = commands.some((command) => command?.name === parsed.command);
    if (!hasMatchingCommand) {
      return false;
    }

    await client.session.command({
      sessionID,
      directory: projectPath,
      command: parsed.command,
      arguments: parsed.arguments,
      ...(task.execution.agent ? { agent: task.execution.agent } : {}),
      model: `${task.execution.providerID}/${task.execution.modelID}`,
      ...(task.execution.variant ? { variant: task.execution.variant } : {}),
    }, requestOptions);

    return true;
  };

  const abortCreatedSessionBestEffort = async ({ client, sessionID, projectPath }) => {
    if (!sessionID || !client?.session?.abort) {
      return;
    }
    try {
      await client.session.abort({
        sessionID,
        directory: projectPath,
      });
    } catch {
      // Never let upstream abort failure replace the watchdog timeout error.
    }
  };

  const runTaskWithWatchdog = async (projectID, task, reason, runID, signal) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const projectPath = projectPathByID.get(projectID);
    if (!projectPath) {
      throw new Error('project path is unavailable');
    }

    signal?.throwIfAborted?.();

    if (typeof waitForOpenCodeReady === 'function') {
      await waitForOpenCodeReady(10_000, 250);
      signal?.throwIfAborted?.();
    }

    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const authHeaders = getOpenCodeAuthHeaders();
    const client = createOpencodeClient({
      baseUrl,
      headers: authHeaders,
    });
    const requestOptions = signal ? { signal } : undefined;

    const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
      ? task.name.trim()
      : 'Schedule';
    const scheduledTaskMarker = {
      projectID,
      taskID: task.id,
      runID,
      name: taskName,
    };

    let sessionID;
    // Watchdog abort must fire session.abort even while awaiting non-cancellable
    // work (small-model distill / writeObjective). Register once after create;
    // never on ordinary non-timeout failures or success.
    let sessionAbortStarted = false;
    let onWatchdogAbort = null;
    const triggerSessionAbortOnce = () => {
      if (sessionAbortStarted || !sessionID) {
        return;
      }
      sessionAbortStarted = true;
      void abortCreatedSessionBestEffort({ client, sessionID, projectPath });
    };
    const clearWatchdogAbortListener = () => {
      if (onWatchdogAbort && signal) {
        signal.removeEventListener('abort', onWatchdogAbort);
        onWatchdogAbort = null;
      }
    };

    try {
      const sessionResponse = await client.session.create({
        directory: projectPath,
        title,
        metadata: buildScheduledTaskMetadata(scheduledTaskMarker),
      }, requestOptions);
      sessionID = sessionResponse?.data?.id;
      if (!sessionID) {
        throw new Error('failed to create session');
      }

      if (signal) {
        if (signal.aborted) {
          // Timeout raced create: session exists — abort immediately.
          triggerSessionAbortOnce();
        } else {
          onWatchdogAbort = () => {
            triggerSessionAbortOnce();
          };
          signal.addEventListener('abort', onWatchdogAbort, { once: true });
        }
      }

      let attachFailed = null;
      if (runHistoryStore && typeof runHistoryStore.attachSession === 'function') {
        try {
          runHistoryStore.attachSession(runID, sessionID);
        } catch (error) {
          attachFailed = error;
        }
      }

      try {
        // Archive must succeed before any goal/prompt/command work. A 404 gets
        // one short bounded retry; any other failure aborts without prompting.
        await archiveSessionBeforePrompt({ client, sessionID, projectPath, signal });
      } catch (archiveError) {
        if (attachFailed) {
          throw new Error(
            `attachSession failed (${safeErrorMessage(attachFailed)}); archive also failed: ${safeErrorMessage(archiveError)}`,
          );
        }
        throw archiveError;
      }

      if (attachFailed) {
        throw new Error(`attachSession failed: ${safeErrorMessage(attachFailed)}`);
      }

      signal?.throwIfAborted?.();

      try {
        emitTaskRunEvent?.({
          projectID,
          taskID: task.id,
          ranAt: startedAt,
          status: 'running',
          sessionID,
        });
      } catch {
      }

      if (task.execution.goalEnabled) {
        await createTaskGoal({
          baseUrl,
          authHeaders,
          sessionID,
          projectPath,
          task,
          scheduledTaskMarker,
          signal,
        });
      }

      signal?.throwIfAborted?.();

      const executedAsCommand = await runScheduledCommandIfApplicable({
        client,
        projectPath,
        sessionID,
        task,
        signal,
      });
      if (!executedAsCommand) {
        await runPromptAsync({
          baseUrl,
          authHeaders,
          sessionID,
          projectPath,
          task,
          signal,
        });
      }

      // Do not finalize on admission alone — wait for the real agent turn (or
      // goal loop) so history status/duration match what the user sees in chat.
      const settlement = await waitForRunOutcome({
        client,
        sessionID,
        projectPath,
        goalEnabled: Boolean(task.execution?.goalEnabled),
        signal,
      });

      const finishedAt = Date.now();
      return {
        sessionID,
        durationMs: Math.max(0, finishedAt - startedAt),
        outcome: settlement.outcome === 'error' ? 'error' : 'success',
        ...(settlement.error ? { error: settlement.error } : {}),
        reason,
        startedAt,
        finishedAt,
      };
    } finally {
      clearWatchdogAbortListener();
    }
  };

  const finalizeRunHistory = (runID, payload) => {
    if (!runID || !runHistoryStore || typeof runHistoryStore.finishRun !== 'function') {
      return null;
    }
    try {
      return runHistoryStore.finishRun(runID, payload);
    } catch (error) {
      logger.warn?.('[ScheduledTasks] failed to finalize run history', {
        runID,
        error: safeErrorMessage(error),
      });
      return { error };
    }
  };

  const runTask = async (projectID, taskID, reason) => {
    const taskMap = tasksByProject.get(projectID);
    const task = taskMap?.get(taskID);
    if (!task || !task.enabled) {
      return { ok: false, skipped: true };
    }

    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return { ok: false, running: true };
    }

    runningTaskKeys.add(taskKey);
    runningGlobalCount += 1;
    runningCountByProject.set(projectID, (runningCountByProject.get(projectID) || 0) + 1);

    const runStartedAt = Date.now();
    let status = 'error';
    let sessionID;
    let durationMs = 0;
    let errorMessage;
    let stateResult = { task: null };
    let runID = null;

    try {
      const projectPath = projectPathByID.get(projectID) || null;
      const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
        ? task.name.trim()
        : 'Schedule';

      if (runHistoryStore && typeof runHistoryStore.startRun === 'function') {
        try {
          runID = crypto.randomUUID();
          runHistoryStore.startRun({
            id: runID,
            projectId: projectID,
            taskId: taskID,
            taskName,
            trigger: reason === 'manual' ? 'manual' : 'scheduled',
            directory: projectPath,
            startedAt: runStartedAt,
          });
        } catch (error) {
          errorMessage = safeErrorMessage(error);
          runID = null;
          logger.warn?.('[ScheduledTasks] failed to start run history', {
            projectID,
            taskID,
            error: errorMessage,
          });
        }
      } else {
        runID = crypto.randomUUID();
      }

      if (!errorMessage) {
        try {
          const runningState = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
            lastRunAt: runStartedAt,
            lastStatus: 'running',
            lastError: undefined,
            updatedAt: runStartedAt,
          });
          if (runningState.task) {
            updateInMemoryTask(projectID, runningState.task);
          }
        } catch (error) {
          errorMessage = safeErrorMessage(error);
          logger.warn?.('[ScheduledTasks] failed to persist running state', {
            projectID,
            taskID,
            error: errorMessage,
          });
        }
      }

      if (!errorMessage) {
        // Per-run abort: only the watchdog timeout aborts in-flight SDK/HTTP
        // work. Manual stop/service stop must not trigger this controller.
        const runAbort = new AbortController();
        const timeoutError = new Error('schedule run timed out');
        let timeoutID;
        try {
          const runPromise = runTaskWithWatchdog(
            projectID,
            task,
            reason,
            runID,
            runAbort.signal,
          );
          // Absorb both settle paths so a late rejection after timeout never
          // becomes an unhandledRejection (timeout must not await the run).
          const runSettled = runPromise.then(
            (result) => ({ ok: true, result }),
            (error) => ({ ok: false, error }),
          );
          const timeoutPromise = new Promise((resolve) => {
            timeoutID = setTimeout(() => {
              try {
                runAbort.abort(timeoutError);
              } catch {
              }
              resolve({ timedOut: true });
            }, maxRunDurationMs);
          });

          const raced = await Promise.race([
            runSettled.then((settled) => ({ timedOut: false, settled })),
            timeoutPromise,
          ]);

          if (raced.timedOut) {
            // Bound: do not await uncancellable steps (distill / writeObjective).
            // session.abort is started by the signal listener on create; later
            // throwIfAborted gates stop goal PATCH / command / prompt.
            throw timeoutError;
          }

          if (!raced.settled.ok) {
            throw raced.settled.error;
          }

          const result = raced.settled.result;
          sessionID = result.sessionID;
          durationMs = result.durationMs;
          if (result.outcome === 'error') {
            status = 'error';
            errorMessage = typeof result.error === 'string' && result.error.trim()
              ? result.error.trim()
              : 'scheduled run failed';
            logger.warn?.(
              '[ScheduledTasks] run completed with error outcome',
              { projectID, taskID, status, reason, sessionID, durationMs, runID, error: errorMessage },
            );
          } else {
            status = 'success';
            logger.info?.(
              '[ScheduledTasks] run completed',
              { projectID, taskID, status, reason, sessionID, durationMs, runID },
            );
          }
        } catch (error) {
          errorMessage = safeErrorMessage(error);
          // Prefer the canonical timeout message when the watchdog fired,
          // even if a racing abort surfaces as AbortError first.
          if (runAbort.signal.aborted) {
            const abortReason = runAbort.signal.reason;
            if (abortReason instanceof Error && abortReason.message === 'schedule run timed out') {
              errorMessage = abortReason.message;
            } else if (errorMessage === 'Aborted' || /abort/i.test(errorMessage)) {
              errorMessage = 'schedule run timed out';
            }
          }
          logger.warn?.('[ScheduledTasks] run failed', {
            projectID,
            taskID,
            reason,
            status,
            error: errorMessage,
          });
        } finally {
          if (timeoutID) {
            clearTimeout(timeoutID);
          }
        }
      }

      const finishedAt = Date.now();
      if (!durationMs) {
        durationMs = Math.max(0, finishedAt - runStartedAt);
      }
      let latestTask = (tasksByProject.get(projectID)?.get(taskID)) || task;
      const shouldConsumeOneTimeTask = latestTask?.schedule?.kind === 'once' && reason === 'scheduled';
      if (shouldConsumeOneTimeTask && latestTask?.enabled) {
        try {
          const consumed = await projectConfigRuntime.upsertScheduledTask(projectID, {
            ...latestTask,
            enabled: false,
          });
          latestTask = consumed.task || latestTask;
          updateInMemoryTask(projectID, latestTask);
        } catch (consumeError) {
          logger.warn?.('[ScheduledTasks] failed to consume one-time task', {
            projectID,
            taskID,
            error: safeErrorMessage(consumeError),
          });
        }
      }

      const nextRunAt = computeNextRunAt(latestTask, finishedAt);
      try {
        const statePatch = {
          lastStatus: status,
          lastDurationMs: durationMs,
          lastError: status === 'error' ? errorMessage : undefined,
          nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
          updatedAt: finishedAt,
        };
        if (sessionID) {
          statePatch.lastSessionId = sessionID;
        }
        stateResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, statePatch);
        if (stateResult.task) {
          updateInMemoryTask(projectID, stateResult.task);
          if (stateResult.task.enabled && Number.isFinite(stateResult.task.state?.nextRunAt)) {
            scheduleTask(projectID, taskID, stateResult.task.state.nextRunAt);
          }
        }
      } catch (error) {
        status = 'error';
        errorMessage = safeErrorMessage(error);
        logger.warn?.('[ScheduledTasks] failed to persist final state', {
          projectID,
          taskID,
          error: errorMessage,
        });
      }
      if (sessionID) {
        lastSessionOwners.set(sessionID, { projectID, taskID });
      }

      // History final status reflects the ultimate run outcome, including
      // state-persistence failures. A failed finalize leaves the row running
      // so the next store open can converge it to error.
      const historyFinalize = finalizeRunHistory(runID, {
        status,
        finishedAt,
        durationMs,
        ...(sessionID ? { sessionId: sessionID } : {}),
        ...(status === 'error' ? { error: errorMessage || 'Unknown error' } : {}),
      });
      if (historyFinalize?.error) {
        status = 'error';
        errorMessage = errorMessage || safeErrorMessage(historyFinalize.error);
      }

      try {
        emitTaskRunEvent?.({
          projectID,
          taskID,
          ranAt: finishedAt,
          status,
          ...(sessionID ? { sessionID } : {}),
        });
      } catch {
      }

      return {
        ok: status === 'success',
        status,
        sessionID,
        task: stateResult.task || null,
        error: errorMessage,
        runID,
      };
    } finally {
      runningTaskKeys.delete(taskKey);
      runningGlobalCount = Math.max(0, runningGlobalCount - 1);
      const nextProjectCount = Math.max(0, (runningCountByProject.get(projectID) || 1) - 1);
      if (nextProjectCount === 0) {
        runningCountByProject.delete(projectID);
      } else {
        runningCountByProject.set(projectID, nextProjectCount);
      }
    }
  };

  const pumpQueue = () => {
    if (!started) {
      return;
    }

    let consumed = false;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!canRunTask(item.projectID)) {
        continue;
      }

      queue.splice(index, 1);
      index -= 1;

      const taskKey = buildTaskKey(item.projectID, item.taskID);
      queuedTaskKeys.delete(taskKey);
      consumed = true;

      void runTask(item.projectID, item.taskID, item.reason).finally(() => {
        pumpQueue();
      });
    }

    if (!consumed && queue.length > 0) {
      return;
    }
  };

  const runNow = async (projectID, taskID) => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return {
        ok: false,
        running: true,
        error: 'task is already running',
      };
    }
    if (queuedTaskKeys.has(taskKey)) {
      return {
        ok: false,
        queued: true,
        error: 'task is already queued',
      };
    }

    return runTask(projectID, taskID, 'manual');
  };

  const start = async () => {
    if (started) {
      return;
    }
    started = true;
    await syncAllProjects();
  };

  const stop = () => {
    if (!started) {
      return;
    }
    started = false;
    for (const timer of timersByTaskKey.values()) {
      clearTimeout(timer);
    }
    timersByTaskKey.clear();
    for (const retry of projectSyncRetriesByProjectID.values()) {
      clearTimeout(retry.timer);
    }
    projectSyncRetriesByProjectID.clear();
    queuedTaskKeys.clear();
    queue.length = 0;
  };

  const getStatus = () => {
    let enabledCount = 0;
    for (const taskMap of tasksByProject.values()) {
      for (const task of taskMap.values()) {
        if (task?.enabled) {
          enabledCount += 1;
        }
      }
    }

    const runningCount = runningTaskKeys.size;
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  const handleSessionIdleCorrection = async (event) => {
    const { idle, sessionID } = parseSessionEventIdle(event);
    if (!idle || !sessionID) {
      return;
    }

    const owner = lastSessionOwners.get(sessionID);
    if (!owner) {
      return;
    }

    const { projectID, taskID } = owner;
    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return;
    }

    const task = tasksByProject.get(projectID)?.get(taskID);
    const lastStatus = task?.state?.lastStatus;
    if (lastStatus === 'success' || lastStatus === 'running') {
      return;
    }
    if (lastStatus !== 'error') {
      return;
    }

    const projectPath = projectPathByID.get(projectID) || await ensureProjectPath(projectID);
    if (!projectPath) {
      return;
    }

    const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
    const authHeaders = getOpenCodeAuthHeaders();
    const client = createOpencodeClient({
      baseUrl,
      headers: authHeaders,
    });
    const snapshot = await snapshotSessionOutcome({
      client,
      sessionID,
      projectPath,
      goalEnabled: Boolean(task.execution?.goalEnabled),
    });
    if (snapshot.outcome !== 'success') {
      return;
    }

    if (runningTaskKeys.has(taskKey)) {
      return;
    }
    const latest = tasksByProject.get(projectID)?.get(taskID);
    if (latest?.state?.lastStatus !== 'error') {
      return;
    }

    const stateResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
      lastStatus: 'success',
      lastError: undefined,
      lastSessionId: sessionID,
      updatedAt: Date.now(),
    });
    if (stateResult.task) {
      updateInMemoryTask(projectID, stateResult.task);
    }

    try {
      emitTaskRunEvent?.({
        projectID,
        taskID,
        ranAt: Date.now(),
        status: 'success',
        sessionID,
      });
    } catch {
    }
  };

  const observeSessionEvent = (event) => {
    return handleSessionIdleCorrection(event).catch((error) => {
      logger.warn?.('[ScheduledTasks] observeSessionEvent failed', {
        error: safeErrorMessage(error),
      });
    });
  };

  return {
    start,
    stop,
    syncAllProjects,
    syncProject,
    runNow,
    getStatus,
    observeSessionEvent,
  };
};
