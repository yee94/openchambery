import { AssistantError, createAssistantsService } from './service.js';
import { createChatCompletion } from '../llm/completions.js';
import { ensureLlmTempDirectory } from '../llm/temp-directory.js';
import { setAssignedSessionSettleHandler } from '../session-goal/runtime.js';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';

const respond = (res, work, success = 200) => Promise.resolve().then(work).then((body) => res.status(success).json(body)).catch((error) => { const code = error instanceof AssistantError ? error.code : error?.code || 'internal_error'; const status = code === 'not_found' ? 404 : ['revision_conflict', 'idempotency_conflict'].includes(code) ? 409 : code === 'assistant_disabled' ? 403 : code === 'no_provider' ? 400 : code === 'upstream_error' ? 502 : 400; res.status(status).json({ ok: false, error: code, message: typeof error?.message === 'string' && error.message.trim() ? error.message : code }); });
const gone = (_req, res) => res.status(410).json({ ok: false, error: 'assistant_topics_retired' });

export const registerAssistantRoutes = (app, dependencies) => {
  const boundCompletion = (input) => createChatCompletion({
    ...input,
    buildOpenCodeUrl: dependencies.buildOpenCodeUrl,
    getOpenCodeAuthHeaders: dependencies.getOpenCodeAuthHeaders,
    clientFactory: () => createOpencodeClient({
      baseUrl: dependencies.buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: dependencies.getOpenCodeAuthHeaders(),
    }),
    ensureTempDirectory: ensureLlmTempDirectory,
  });
  const service = createAssistantsService({ dbPath: dependencies.dbPath, dataDir: dependencies.openchamberDataDir, buildOpenCodeUrl: dependencies.buildOpenCodeUrl, getOpenCodeAuthHeaders: dependencies.getOpenCodeAuthHeaders, getServerId: dependencies.getServerId, getAllowedRoots: dependencies.getAllowedRoots, globalEventHub: dependencies.globalEventHub, onRevisionTip: dependencies.onRevisionTip, createChatCompletion: boundCompletion });
  setAssignedSessionSettleHandler(({ sessionId, status }) => service.reportAssignedSessionSettle(sessionId, status));
  app.use('/api/openchamber/assistants', (req, res, next) => Promise.resolve(dependencies.refreshAllowedRoots?.()).then(next).catch((error) => respond(res, () => { throw error; })));
  app.get('/api/openchamber/assistants/capability', (_req, res) => respond(res, () => service.capability()));
  app.get('/api/openchamber/assistants', (_req, res) => respond(res, () => service.snapshot())); app.get('/api/openchamber/assistants/snapshot', (_req, res) => respond(res, () => service.snapshot())); app.put('/api/openchamber/assistants/settings', (req, res) => respond(res, () => service.setEnabled(req.body)));
  app.post('/api/openchamber/assistants', (req, res) => respond(res, () => service.createAssistant(req.body), 201)); app.patch('/api/openchamber/assistants/:assistantID', (req, res) => respond(res, () => service.updateAssistant(req.params.assistantID, req.body))); app.delete('/api/openchamber/assistants/:assistantID', (req, res) => respond(res, () => service.removeAssistant(req.params.assistantID, req.body?.expectedRevision)));
  app.post('/api/openchamber/assistants/:assistantID/session/ensure', (req, res) => respond(res, () => service.ensure(req.params.assistantID))); app.post('/api/openchamber/assistants/:assistantID/session/new', (req, res) => respond(res, () => service.createNew(req.params.assistantID))); app.post('/api/openchamber/assistants/:assistantID/session/compact', (req, res) => respond(res, () => service.compact(req.params.assistantID, req.body))); app.post('/api/openchamber/assistants/:assistantID/session/abort', (req, res) => respond(res, () => service.abort(req.params.assistantID, req.body)));
  app.get('/api/openchamber/assistants/:assistantID/messages', (req, res) => respond(res, () => service.historicalMessages(req.params.assistantID, req.query)));
  app.get('/api/openchamber/assistants/:assistantID/contact/messages', (req, res) => respond(res, () => service.contactMessages(req.params.assistantID, req.query)));
  app.post('/api/openchamber/assistants/:assistantID/contact/cards', (req, res) => respond(res, () => service.appendContactCard(req.params.assistantID, req.body), 201));
  app.post('/api/openchamber/assistants/:assistantID/contact/dm', (req, res) => respond(res, () => service.deliverPeerMessage(req.params.assistantID, req.body), 201));
  app.post('/api/openchamber/assistants/:assistantID/messages', (req, res) => respond(res, () => service.send(req.params.assistantID, req.body))); app.post('/api/openchamber/assistants/:assistantID/share', (req, res) => respond(res, () => service.share(req.params.assistantID, req.body), 202)); app.get('/api/openchamber/assistants/share-operations/:operationID', (req, res) => respond(res, () => { const operation = service.shareOperation(req.params.operationID); if (!operation) throw new AssistantError('not_found'); return operation; }));
  app.use('/api/openchamber/assistants/topics', gone); app.use('/api/openchamber/assistants/:assistantID/topics', gone);
  return { service, close: () => { setAssignedSessionSettleHandler(null); service.close(); } };
};
