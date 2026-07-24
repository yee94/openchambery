import { MANAGED_SCHEDULED_TASK_TOOL_PATH } from './managed-tool-contract.js';

const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_OBJECT_KEYS = 24;
const OPEN_CODE_CONTEXT_TIMEOUT_MS = 10_000;
const OPEN_CODE_MESSAGE_LIMIT = 100;

const isValidationError = (message) => /^(body|context|input|operation|execution|schedule|messageID|Session directory|A user message|task\.name|task\.id)/.test(message)
  || message.includes(' is required')
  || message.includes(' is invalid')
  || message.includes('must identify');

const asString = (value, label, maxLength = MAX_ID_LENGTH) => {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${label} is invalid`);
  return trimmed;
};

const asObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_OBJECT_KEYS) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const hasOnlyKeys = (value, allowed, label) => {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(`${label} contains unsupported fields`);
};

const validatedDirectory = async (validateDirectoryPath, value, label, statusCode = 400) => {
  const raw = asString(value, label, 4096);
  let result;
  try {
    result = await validateDirectoryPath(raw);
  } catch {
    result = null;
  }
  if (!result?.ok || typeof result.directory !== 'string' || !result.directory.trim()) {
    const error = new Error(`${label} is invalid`);
    error.statusCode = statusCode;
    throw error;
  }
  return result.directory;
};

const isWithin = (path, parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const fetchOpenCodeJson = async ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, route, directory }) => {
  const url = new URL(buildOpenCodeUrl(route, ''));
  url.searchParams.set('directory', directory);
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(OPEN_CODE_CONTEXT_TIMEOUT_MS),
    });
  } catch {
    const error = new Error('OpenCode is unavailable');
    error.statusCode = 502;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(response.status === 404 ? 'OpenCode context was not found' : 'OpenCode context request failed');
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error('OpenCode returned invalid context');
    error.statusCode = 502;
    throw error;
  }
};

const userDefaultsForMessage = (messages, messageID) => {
  const current = messages.find((message) => message?.info?.id === messageID);
  if (!current || !['assistant', 'tool'].includes(current.info?.role)) {
    throw new Error('messageID must identify an assistant or tool message');
  }
  const byID = new Map(messages.map((message) => [message?.info?.id, message]));
  let candidate = current;
  const visited = new Set();
  while (candidate?.info?.parentID && !visited.has(candidate.info.id)) {
    visited.add(candidate.info.id);
    candidate = byID.get(candidate.info.parentID);
    if (candidate?.info?.role === 'user') return candidate.info;
  }
  throw new Error('messageID must have a user message parent in this session');
};

const lexicalPath = (path, value) => typeof value === 'string' && value.trim() ? path.resolve(value.trim()) : null;

const selectProject = async (path, validateDirectoryPath, projects, sessionDirectory, rawDirectories) => {
  const candidates = await Promise.all(projects
    .filter((project) => typeof project?.id === 'string' && typeof project?.path === 'string')
    .map(async (project) => {
      try {
        return { ...project, canonicalPath: await validatedDirectory(validateDirectoryPath, project.path, 'configured project path') };
      } catch {
        const lexicalProjectPath = lexicalPath(path, project.path);
        if (lexicalProjectPath && rawDirectories.some((directory) => {
          const lexicalDirectory = lexicalPath(path, directory);
          return lexicalDirectory && isWithin(path, lexicalProjectPath, lexicalDirectory);
        })) {
          const error = new Error('A configured project path containing this session requires attention');
          error.statusCode = 409;
          throw error;
        }
        return null;
      }
    }));
  const matches = candidates
    .filter(Boolean)
    .filter((project) => isWithin(path, project.canonicalPath, sessionDirectory))
    .sort((left, right) => {
      if (left.canonicalPath === sessionDirectory) return -1;
      if (right.canonicalPath === sessionDirectory) return 1;
      return right.canonicalPath.length - left.canonicalPath.length;
    });
  return matches[0] || null;
};

const validateEnvelope = (body) => {
  const envelope = asObject(body, 'body');
  hasOnlyKeys(envelope, new Set(['operation', 'context', 'input']), 'body');
  const operation = asString(envelope.operation, 'operation', 16);
  if (!['list', 'create', 'update', 'delete', 'run'].includes(operation)) throw new Error('operation is invalid');
  const context = asObject(envelope.context, 'context');
  hasOnlyKeys(context, new Set(['sessionID', 'messageID', 'directory', 'worktree', 'agent']), 'context');
  const input = asObject(envelope.input, 'input');
  return { operation, context, input };
};

const validateTaskInputFields = (input) => {
  if (input.name !== undefined) asString(input.name, 'input.name', MAX_NAME_LENGTH);
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('input.enabled is invalid');
  if (input.schedule !== undefined) {
    const schedule = asObject(input.schedule, 'input.schedule');
    hasOnlyKeys(schedule, new Set(['kind', 'time', 'times', 'weekdays', 'date', 'cron', 'timezone']), 'input.schedule');
    for (const key of ['kind', 'time', 'date', 'cron', 'timezone']) {
      if (schedule[key] !== undefined) asString(schedule[key], `input.schedule.${key}`, 200);
    }
    if (schedule.times !== undefined && (!Array.isArray(schedule.times) || schedule.times.length > 32 || schedule.times.some((value) => typeof value !== 'string'))) throw new Error('input.schedule.times is invalid');
    if (schedule.weekdays !== undefined && (!Array.isArray(schedule.weekdays) || schedule.weekdays.length > 7 || schedule.weekdays.some((value) => !Number.isInteger(value)))) throw new Error('input.schedule.weekdays is invalid');
  }
  if (input.execution !== undefined) {
    const execution = asObject(input.execution, 'input.execution');
    hasOnlyKeys(execution, new Set(['prompt', 'providerID', 'modelID', 'agent', 'variant', 'goalEnabled', 'goalTokenBudget']), 'input.execution');
    for (const key of ['prompt', 'providerID', 'modelID', 'agent', 'variant']) {
      if (execution[key] !== undefined) asString(execution[key], `input.execution.${key}`, key === 'prompt' ? MAX_PROMPT_LENGTH : MAX_ID_LENGTH);
    }
    if (execution.goalEnabled !== undefined && typeof execution.goalEnabled !== 'boolean') throw new Error('input.execution.goalEnabled is invalid');
    if (execution.goalTokenBudget !== undefined && (!Number.isFinite(execution.goalTokenBudget) || execution.goalTokenBudget <= 0)) throw new Error('input.execution.goalTokenBudget is invalid');
  }
};

export const registerScheduledTaskToolRoute = (app, dependencies) => {
  const {
    express,
    path,
    validateDirectoryPath,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readSettingsFromDiskMigrated,
    sanitizeProjects,
    projectConfigRuntime,
    scheduledTasksRuntime,
    logger = console,
    scheduleSyncRetry = (retry) => {
      const timer = setTimeout(retry, 1_000);
      timer.unref?.();
      return timer;
    },
  } = dependencies;

  const syncAfterMutation = async (projectID, operation) => {
    try {
      await scheduledTasksRuntime.syncProject(projectID);
      return true;
    } catch {
      logger.warn?.('[ScheduledTaskTool] scheduler sync failed', { projectID, operation });
      try {
        scheduleSyncRetry(() => {
          Promise.resolve(scheduledTasksRuntime.syncProject(projectID)).catch(() => {
            logger.warn?.('[ScheduledTaskTool] scheduler sync retry failed', { projectID, operation });
          });
        });
      } catch {
      }
      return false;
    }
  };

  app.post(MANAGED_SCHEDULED_TASK_TOOL_PATH, express.json({ limit: '64kb', strict: true }), async (req, res) => {
    try {
      const { operation, context, input } = validateEnvelope(req.body);
      const sessionID = asString(context.sessionID, 'context.sessionID');
      const messageID = asString(context.messageID, 'context.messageID');
      const contextDirectory = await validatedDirectory(validateDirectoryPath, context.directory, 'context.directory');
      const worktree = context.worktree === undefined ? null : await validatedDirectory(validateDirectoryPath, context.worktree, 'context.worktree');
      const contextAgent = context.agent === undefined ? null : asString(context.agent, 'context.agent', 256);

      const session = await fetchOpenCodeJson({
        buildOpenCodeUrl, getOpenCodeAuthHeaders, route: `/session/${encodeURIComponent(sessionID)}`, directory: contextDirectory,
      });
      if (typeof session?.id !== 'string' || session.id !== sessionID || typeof session.directory !== 'string') {
        const error = new Error('OpenCode returned invalid session context');
        error.statusCode = 502;
        throw error;
      }
      const sessionDirectory = await validatedDirectory(validateDirectoryPath, session.directory, 'OpenCode session directory', 502);
      if (contextDirectory !== sessionDirectory || (worktree && !isWithin(path, worktree, sessionDirectory))) {
        throw new Error('Session directory does not match the requested context');
      }

      const settings = await readSettingsFromDiskMigrated();
      const projects = sanitizeProjects(settings?.projects || []);
      const project = await selectProject(path, validateDirectoryPath, Array.isArray(projects) ? projects : [], sessionDirectory, [context.directory, session.directory, context.worktree]);
      if (!project) return res.status(404).json({ error: 'Configure a project containing this session directory before managing schedules' });

      const messages = await fetchOpenCodeJson({
        buildOpenCodeUrl, getOpenCodeAuthHeaders, route: `/session/${encodeURIComponent(sessionID)}/message?limit=${OPEN_CODE_MESSAGE_LIMIT}`, directory: contextDirectory,
      });
      if (!Array.isArray(messages)) {
        const error = new Error('OpenCode returned invalid message context');
        error.statusCode = 502;
        throw error;
      }
      const userInfo = userDefaultsForMessage(messages, messageID);
      if (contextAgent && contextAgent !== userInfo.agent) throw new Error('context.agent does not match the user message agent');

      if (operation === 'list') {
        hasOnlyKeys(input, new Set(), 'input');
        return res.json({ projectId: project.id, tasks: await projectConfigRuntime.listScheduledTasks(project.id) });
      }

      const taskID = operation === 'create' ? null : asString(input.taskId, 'input.taskId');
      if (operation === 'delete') {
        hasOnlyKeys(input, new Set(['taskId']), 'input');
        const deleted = await projectConfigRuntime.deleteScheduledTask(project.id, taskID);
        if (!deleted.deleted) return res.status(404).json({ error: 'Schedule not found' });
        const schedulerSynced = await syncAfterMutation(project.id, operation);
        return res.json({ projectId: project.id, tasks: deleted.tasks, schedulerSynced });
      }
      if (operation === 'run') {
        hasOnlyKeys(input, new Set(['taskId']), 'input');
        const result = await scheduledTasksRuntime.runNow(project.id, taskID);
        if (result.running || result.queued) return res.status(409).json({ error: result.error || 'Schedule already running' });
        if (result.skipped) return res.status(404).json({ error: 'Schedule not found or disabled' });
        if (!result.ok) return res.status(500).json({ error: 'Schedule run failed', task: result.task || null });
        return res.json({ ok: true, projectId: project.id, task: result.task, sessionId: result.sessionID });
      }

      hasOnlyKeys(input, operation === 'create'
        ? new Set(['name', 'enabled', 'schedule', 'execution'])
        : new Set(['taskId', 'name', 'enabled', 'schedule', 'execution']), 'input');
      validateTaskInputFields(input);

      if (operation === 'update') {
        const patch = {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
          ...(input.execution === undefined ? {} : { execution: input.execution }),
        };
        const patched = await projectConfigRuntime.patchScheduledTask(project.id, taskID, patch);
        if (!patched?.task) return res.status(404).json({ error: 'Schedule not found' });
        const schedulerSynced = await syncAfterMutation(project.id, operation);
        return res.json({ projectId: project.id, task: patched.task, tasks: patched.tasks, schedulerSynced });
      }
      const model = userInfo?.model && typeof userInfo.model === 'object' ? userInfo.model : {};
      const executionInput = input.execution === undefined ? {} : asObject(input.execution, 'input.execution');
      const execution = { ...executionInput };
      if (!execution.providerID) execution.providerID = model.providerID;
      if (!execution.modelID) execution.modelID = model.modelID;
      if (!execution.agent) execution.agent = userInfo.agent;
      if (!execution.variant) execution.variant = model.variant;
      if (operation === 'create' && (!execution.providerID || !execution.modelID)) {
        throw new Error('execution.providerID and execution.modelID are required from the user message or input');
      }
      const taskInput = {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        schedule: input.schedule === undefined ? {} : asObject(input.schedule, 'input.schedule'),
        execution,
      };
      const upserted = await projectConfigRuntime.upsertScheduledTask(project.id, taskInput);
      const schedulerSynced = await syncAfterMutation(project.id, operation);
      return res.status(201).json({ projectId: project.id, created: upserted.created, task: upserted.task, tasks: upserted.tasks, schedulerSynced });
    } catch (error) {
      const statusCode = error?.statusCode || (isValidationError(error?.message || '') ? 400 : 500);
      if (statusCode >= 500) logger.error?.('[ScheduledTaskTool] request failed', { operation: req.body?.operation, statusCode });
      return res.status(statusCode).json({ error: statusCode >= 500 ? 'Failed to manage schedule' : (error?.message || 'Invalid schedule request') });
    }
  });
};
