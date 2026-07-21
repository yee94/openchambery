import { AssistantError, createAssistantsService } from './service.js';

const respond = (res, work, success = 200) => Promise.resolve().then(work).then((body) => res.status(success).json(body)).catch((error) => {
  const code = error instanceof AssistantError ? error.code : 'internal_error';
  const status = code === 'not_found' ? 404 : code === 'revision_conflict' || code === 'idempotency_conflict' || code === 'topic_busy' ? 409 : code === 'assistant_disabled' ? 403 : code === 'upstream_error' ? 502 : 400;
  res.status(status).json({ ok: false, error: code });
});

export const registerAssistantRoutes = (app, dependencies) => {
  const service = createAssistantsService({ dbPath: dependencies.dbPath, dataDir: dependencies.openchamberDataDir, buildOpenCodeUrl: dependencies.buildOpenCodeUrl, getOpenCodeAuthHeaders: dependencies.getOpenCodeAuthHeaders, getServerId: dependencies.getServerId, getAllowedRoots: dependencies.getAllowedRoots });
  app.use('/api/openchamber/assistants', (req, res, next) => Promise.resolve(dependencies.refreshAllowedRoots?.()).then(next).catch((error) => respond(res, () => { throw error; })));
  app.get('/api/openchamber/assistants/capability', (_req, res) => respond(res, () => service.capability()));
  app.get('/api/openchamber/assistants', (_req, res) => respond(res, () => service.snapshot()));
  app.get('/api/openchamber/assistants/snapshot', (_req, res) => respond(res, () => service.snapshot()));
  app.put('/api/openchamber/assistants/settings', (req, res) => respond(res, () => service.setEnabled(req.body)));
  app.post('/api/openchamber/assistants', (req, res) => respond(res, () => service.createAssistant(req.body), 201));
  app.patch('/api/openchamber/assistants/:assistantID', (req, res) => respond(res, () => service.updateAssistant(req.params.assistantID, req.body)));
  app.delete('/api/openchamber/assistants/:assistantID', (req, res) => respond(res, () => service.removeAssistant(req.params.assistantID, req.body?.expectedRevision)));
  app.get('/api/openchamber/assistants/:assistantID/topics', (req, res) => respond(res, () => service.listTopics(req.params.assistantID)));
  app.post('/api/openchamber/assistants/:assistantID/topics', (req, res) => respond(res, () => service.createTopic(req.params.assistantID, req.body?.title), 201));
  app.patch('/api/openchamber/assistants/topics/:topicID', (req, res) => respond(res, () => service.updateTopic(req.params.topicID, req.body)));
  app.delete('/api/openchamber/assistants/topics/:topicID', (req, res) => respond(res, () => service.removeTopic(req.params.topicID, req.body?.expectedRevision)));
  app.get('/api/openchamber/assistants/topics/:topicID/messages', (req, res) => respond(res, () => service.getTurns(req.params.topicID)));
  app.post('/api/openchamber/assistants/topics/:topicID/messages', (req, res) => respond(res, () => service.submit(req.body?.operationID, req.params.topicID, req.body?.parts, req.body?.source), 202));
  app.post('/api/openchamber/assistants/topics/:topicID/new', (req, res) => respond(res, () => service.newTopic(req.body?.operationID, req.params.topicID), 202));
  app.post('/api/openchamber/assistants/topics/:topicID/compact', (req, res) => respond(res, () => service.compact(req.body?.operationID, req.params.topicID), 202));
  app.get('/api/openchamber/assistants/operations/:operationID', (req, res) => respond(res, async () => { const result = await service.operation(req.params.operationID); if (!result) throw new AssistantError('not_found'); return result; }));
  return { close: () => service.close() };
};
