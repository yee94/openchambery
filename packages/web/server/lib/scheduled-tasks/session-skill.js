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
  express, openchamberDataDir, buildOpenCodeUrl, getOpenCodeAuthHeaders,
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
      const directory = path.join(openchamberDataDir, 'session-skills', hash);
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
        metadata: { ...body.metadata, openchamber: { ...body.metadata?.openchamber, scheduledTaskSkill: { hostOrigin } } },
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
        value: `OpenChamber built-in skill: scheduled tasks. When the user asks to turn this conversation into a scheduled/recurring task, load the skill by running:\n${scheduledTaskSkillCommand(executable, script, encoded, 'describe')}\nThe result supplies the workflow and authenticated create/list commands bound to this session. Do not ask for credentials or project IDs.`,
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
      if (typeof sessionID !== 'string' || !sessionID || !['check', 'describe', 'list', 'create'].includes(operation)) {
        return res.status(400).json({ error: 'Invalid skill request' });
      }
      const client = createClient();
      const session = await client.session.get({ sessionID });
      if (session.metadata?.openchamber?.scheduledTaskSkill?.hostOrigin !== hostOriginFor(req)) {
        return res.status(403).json({ error: 'Session is not bound to this Host' });
      }
      if (operation === 'check') return res.json({ ready: true });
      const directoryResult = await validateDirectoryPath(session.location?.directory);
      if (!directoryResult?.ok) return res.status(409).json({ error: 'Session directory unavailable' });
      const directory = directoryResult.directory;
      const settings = await readSettingsFromDiskMigrated();
      const project = await selectScheduledTaskProject(path, validateDirectoryPath, sanitizeProjects(settings.projects || []), directory, [directory]);
      if (!project) return res.status(409).json({ error: 'Session does not belong to a configured project' });
      if (operation === 'describe') {
        const { skill } = await prepareResources();
        return res.json({ skill, project: { id: project.id, name: project.name }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      }
      const route = `/api/projects/${encodeURIComponent(project.id)}/scheduled-tasks`;
      if (operation === 'create') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['name', 'enabled', 'schedule', 'execution'].includes(key)) || typeof taskID !== 'string' || !/^[0-9a-f-]{36}$/.test(taskID)) {
          return res.status(400).json({ error: 'Expected a new task' });
        }
        const execution = input.execution;
        if (!execution || typeof execution !== 'object' || Array.isArray(execution)) return res.status(400).json({ error: 'Execution is required' });
        const model = session.model ?? (await client.model.default({ directory })).data;
        req.body = { task: { ...input, id: taskID, execution: {
          providerID: model?.providerID, modelID: model?.id, agent: session.agent, variant: model?.variant,
          ...execution,
        } } };
        req.method = 'PUT';
        req.scheduledTaskCreateOnly = true;
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
