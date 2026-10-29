import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { readSharedServiceRegistration, resolveSharedServiceRegistrationPath } from '../opencode/shared-service.js';
import { selectScheduledTaskProject } from './managed-tool-route.js';
import { authorizeScheduledTaskSkillRequest, SCHEDULED_TASK_SKILL_KEY, SCHEDULED_TASK_SKILL_PATH } from './session-skill-contract.js';
import { scheduledTaskSkillCommand } from './session-skill-client.mjs';

const execFileAsync = promisify(execFile);
const sourceClient = new URL('./session-skill-client.mjs', import.meta.url);
const sourceSkill = new URL('./SESSION_SKILL.md', import.meta.url);

const hostOriginFor = (req) => `http://${req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'}:${req.socket.localPort}`;

export const registerScheduledTaskSessionSkill = (app, {
  express, yuriDataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders,
  getIsSharedOpenCodeService, waitForOpenCodeReady, getRuntimeContract,
  readSettingsFromDiskMigrated, sanitizeProjects, validateDirectoryPath,
  scheduledTaskRouter,
  registrationFile = resolveSharedServiceRegistrationPath(),
  createClient = () => makeOpenCodeV2Client({
    baseUrl: buildOpenCodeUrl('/', ''), authHeaders: getOpenCodeAuthHeaders(), getRuntimeContract,
  }),
  runClient = execFileAsync,
}) => {
  let resources;
  const prepareResources = () => {
    resources ??= (async () => {
      const [client, skill] = await Promise.all([readFile(sourceClient, 'utf8'), readFile(sourceSkill, 'utf8')]);
      const hash = createHash('sha256').update(client).update(skill).digest('hex').slice(0, 16);
      const directory = path.join(yuriDataDir, 'session-skills', hash);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const script = path.join(directory, 'scheduled-task.mjs');
      const temporary = `${script}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, client, { mode: 0o600 });
        await rename(temporary, script);
      } finally {
        await rm(temporary, { force: true });
      }
      return { script, skill };
    })().catch((error) => { resources = undefined; throw error; });
    return resources;
  };

  // Only new sessions admitted through this Host receive the entry. No global
  // OpenCode config, user project files or existing sessions are modified.
  app.post('/api/session', express.json({ limit: '1mb' }), async (req, res, next) => {
    if (!getIsSharedOpenCodeService()) return next();
    let created;
    let client;
    try {
      await waitForOpenCodeReady();
      const registration = await readSharedServiceRegistration({ file: registrationFile });
      const upstreamOrigin = new URL(buildOpenCodeUrl('/', '')).origin;
      const expected = getOpenCodeAuthHeaders().Authorization;
      if (!registration?.password || registration.origin !== upstreamOrigin || expected !== `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}`) {
        throw new Error('Service registration unavailable');
      }
      const { script } = await prepareResources();
      const hostOrigin = hostOriginFor(req);
      client = createClient();
      const body = req.body ?? {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Session input must be an object' });
      created = await client.session.create({
        ...body,
        metadata: { ...body.metadata, yuri: { ...body.metadata?.yuri, scheduledTaskSkill: { hostOrigin } } },
      });
      if (!created?.id) throw new Error('Session creation was not confirmed');
      const encoded = Buffer.from(JSON.stringify({ hostOrigin, upstreamOrigin, registrationFile, sessionID: created.id })).toString('base64url');
      const executable = process.execPath;
      const args = [script, encoded];
      // Preflight the exact packaged helper against the authenticated bridge,
      // before advertising it to the model. No credential enters instructions.
      const checked = await runClient(executable, [...args, 'check'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 35_000, maxBuffer: 64 * 1024,
      });
      if (JSON.parse(checked.stdout)?.ready !== true) throw new Error('Skill preflight was not confirmed');
      await client.session.instructions.entry.put({
        sessionID: created.id,
        key: SCHEDULED_TASK_SKILL_KEY,
        value: `Yuri built-in skill: scheduled tasks. When the user asks to create, find, edit, pause, resume or delete scheduled tasks (including other projects and global tasks), load the skill by running:\n${scheduledTaskSkillCommand(executable, script, encoded, 'describe')}\nThe result supplies the workflow and authenticated task-management commands. Prefer this session's tasks when the target is unspecified. Do not ask for credentials or project IDs.`,
      });
      return res.json({ data: created });
    } catch {
      let retainedSessionID = created?.id;
      if (created?.id && !req.body?.id) {
        try {
          await client.session.remove({ sessionID: created.id });
          retainedSessionID = undefined;
        } catch { /* Keep the ID visible when rollback cannot be confirmed. */ }
      }
      return res.status(503).json({
        error: 'New session capability initialization failed; retry after the Host connection is restored',
        code: 'session_skill_initialization_failed',
        ...(retainedSessionID ? { sessionID: retainedSessionID } : {}),
      });
    }
  });

  app.post(SCHEDULED_TASK_SKILL_PATH, express.json({ limit: '64kb' }), async (req, res, next) => {
    if (!getIsSharedOpenCodeService() || !authorizeScheduledTaskSkillRequest(req, getOpenCodeAuthHeaders())) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    try {
      const { sessionID, operation, input, taskID } = req.body ?? {};
      if (typeof sessionID !== 'string' || !sessionID || !['check', 'describe', 'list', 'get', 'create', 'update', 'pause', 'resume', 'delete'].includes(operation)) {
        return res.status(400).json({ error: 'Invalid skill request' });
      }
      const client = createClient();
      const session = await client.session.get({ sessionID });
      if (session.metadata?.yuri?.scheduledTaskSkill?.hostOrigin !== hostOriginFor(req)) {
        return res.status(403).json({ error: 'Session is not bound to this Host' });
      }
      if (operation === 'check') return res.json({ ready: true });
      const directoryResult = await validateDirectoryPath(session.location?.directory);
      const directory = directoryResult?.ok ? directoryResult.directory : null;
      const settings = await readSettingsFromDiskMigrated();
      const projects = sanitizeProjects(settings?.projects || []);
      const currentProject = directory ? await selectScheduledTaskProject(path, validateDirectoryPath, projects, directory, [directory]) : null;
      if (operation === 'describe') {
        const { skill } = await prepareResources();
        return res.json({ skill, project: currentProject ? { id: currentProject.id, name: currentProject.name } : null,
          projects: projects.map(({ id, name }) => ({ id, name })), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      }
      const payload = input ?? {};
      const allowed = operation === 'create' ? ['projectId', 'name', 'enabled', 'schedule', 'execution']
        : operation === 'update' ? ['projectId', 'taskId', 'name', 'enabled', 'schedule', 'execution']
          : operation === 'list' ? ['projectId'] : ['projectId', 'taskId'];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some((key) => !allowed.includes(key))
        || (payload.projectId !== undefined && (typeof payload.projectId !== 'string' || !payload.projectId.trim()))
        || (payload.enabled !== undefined && typeof payload.enabled !== 'boolean')
        || ['schedule', 'execution'].some((key) => payload[key] !== undefined && (!payload[key] || typeof payload[key] !== 'object' || Array.isArray(payload[key])))) {
        return res.status(400).json({ error: 'Invalid task input' });
      }
      const project = payload.projectId === undefined ? currentProject : projects.find(({ id }) => id === payload.projectId);
      const globalList = operation === 'list' && payload.projectId === undefined;
      if (!globalList && !project) return res.status(404).json({ error: 'Configured project not found; choose a project from describe' });
      const targetID = payload.taskId;
      if (!['create', 'list'].includes(operation) && (typeof targetID !== 'string' || !targetID.trim())) {
        return res.status(400).json({ error: 'taskId is required' });
      }
      let route = globalList ? '/api/yuri/scheduled-tasks' : `/api/projects/${encodeURIComponent(project.id)}/scheduled-tasks`;
      const json = res.json.bind(res);
      res.json = (result) => {
        if (res.statusCode >= 400) return json(result);
        if (operation === 'list') {
          const rows = globalList ? result.tasks : result.tasks.map((task) => ({ projectId: project.id, task }));
          const tasks = rows.map(({ projectId, task }) => ({ ...task, projectId,
            own: task.sourceSessionID === sessionID,
            currentProject: projectId === currentProject?.id,
          })).sort((a, b) => Number(b.own) - Number(a.own) || Number(b.currentProject) - Number(a.currentProject));
          return json({ tasks, failedProjectIds: result.failedProjectIds ?? [] });
        }
        if (operation === 'get') {
          const task = result.tasks.find(({ id }) => id === targetID);
          return task ? json({ projectId: project.id, task }) : res.status(404).json({ error: 'Schedule not found' });
        }
        return json({ ...result, projectId: project.id, ...(operation === 'delete' ? { deleted: true, taskId: targetID } : {}) });
      };
      if (operation === 'create') {
        if (typeof taskID !== 'string' || !/^[0-9a-f-]{36}$/.test(taskID)) {
          return res.status(400).json({ error: 'Expected a new task' });
        }
        const { projectId: _projectId, ...taskInput } = payload;
        const execution = taskInput.execution;
        if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return res.status(400).json({ error: 'Execution is required' });
        const model = session.model ?? (await client.model.default({ directory: project.path })).data;
        req.body = { task: { ...taskInput, id: taskID, sourceSessionID: sessionID, execution: {
          providerID: model?.providerID, modelID: model?.id, agent: session.agent, variant: model?.variant,
          ...execution,
        } } };
        req.method = 'PUT';
        req.scheduledTaskCreateOnly = true;
      } else if (['update', 'pause', 'resume'].includes(operation)) {
        const { projectId: _projectId, taskId: _taskId, ...patch } = payload;
        req.body = { task: { ...(operation === 'update' ? patch : { enabled: operation === 'resume' }), id: targetID } };
        req.method = 'PATCH';
      } else if (operation === 'delete') {
        route += `/${encodeURIComponent(targetID)}`;
        req.method = 'DELETE';
      } else {
        req.method = 'GET';
      }
      // Dispatch through the same CRUD/catalog/write-lock/scheduler contract as
      // the UI, after the bridge has resolved authoritative session ownership.
      req.url = route;
      return scheduledTaskRouter.handle(req, res, next);
    } catch {
      return res.status(503).json({ error: 'Scheduled task capability is temporarily unavailable' });
    }
  });
};
