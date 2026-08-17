import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import { createAscendingMessageID } from './message-id.js';
import { createSessionTurnGate } from './session-turn-gate.js';

// SDK 1.18 result shapes vary: success may be 2xx with empty body (200/202/204),
// failures may place status on response, error, or the top-level result.
const isSuccessStatus = (status) => Number.isInteger(status) && status >= 200 && status < 300;
const runtimeToken = (config, generation) => JSON.stringify([generation ?? null, config?.apiBaseUrl ?? config?.baseUrl ?? null]);
const messageIdentity = (message) => message?.info?.id ?? message?.id;
const inboxItemIdentity = (item) => item?.id ?? item?.info?.id ?? messageIdentity(item);
const httpStatus = (error) => {
  for (const candidate of [error?.cause?.status, error?.status, error?.response?.status, error?.statusCode]) {
    if (Number.isInteger(candidate)) return candidate;
  }
  return undefined;
};
const isNotFoundError = (error) => {
  if (httpStatus(error) === 404) return true;
  const code = error?.code ?? error?.type ?? error?.error?.code ?? error?.error?.type;
  return code === 'not_found' || code === 'NotFound';
};
const messageType = (message) => {
  const info = message?.info ?? message;
  if (info?.type === 'assistant' || info?.type === 'user') return info.type;
  if (info?.role === 'assistant' || info?.role === 'user') return info.role;
  return message ? 'unknown' : null;
};

export const createOpenCodeMessageQueueAdapter = ({
  waitForReady,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  getSessionEligibility,
  getLatestMessageID,
  getMessageByID,
  readAttachment,
  getRuntimeConfig = () => null,
  getRuntimeGeneration = () => undefined,
  turnGate = createSessionTurnGate(),
} = {}) => {
  const captureRuntime = () => { const config = getRuntimeConfig(); const generation = getRuntimeGeneration(); return { config: { ...config, apiBaseUrl: config?.apiBaseUrl ?? config?.baseUrl ?? buildOpenCodeUrl('/', ''), authHeaders: { ...getOpenCodeAuthHeaders() } }, generation, token: runtimeToken(config, generation) }; };
  const isCurrent = (runtime) => !runtime || runtime.token === runtimeToken(getRuntimeConfig(), getRuntimeGeneration());
  const client = (runtime) => makeOpenCodeV2Client({ baseUrl: (runtime?.config?.apiBaseUrl ?? buildOpenCodeUrl('/', '')).replace(/\/$/, ''), authHeaders: runtime?.config?.authHeaders ?? getOpenCodeAuthHeaders() });
  const turnKey = (scope, runtime) => JSON.stringify([runtime?.token ?? runtimeToken(getRuntimeConfig(), getRuntimeGeneration()), scope.directory, scope.sessionID]);
  const checkEligibility = async (scope, runtime, { signal } = {}) => {
    const key = turnKey(scope, runtime);
    const unavailable = () => {
      if (!getSessionEligibility) turnGate.evaluate(key, { available: false, idle: false, tailID: null, tailRole: null, tailCompleted: false });
      return { available: false, idle: false, settled: false };
    };
    try {
      const api = client(runtime);
      const status = getSessionEligibility ? await getSessionEligibility(scope, { signal }) : await api.session.active({ signal });
      const listed = getLatestMessageID ? null : await api.message.list({ sessionID: scope.sessionID, limit: 1, order: 'desc' }, { signal });
      const messages = getLatestMessageID ? null : listed?.data;
      const injectedStatus = getSessionEligibility && status && typeof status === 'object' && typeof status.idle === 'boolean' && typeof status.settled === 'boolean';
      const activeMap = !getSessionEligibility && status && typeof status === 'object' && !Array.isArray(status);
      if (!injectedStatus && !activeMap) return unavailable();
      if (!getLatestMessageID && !Array.isArray(messages)) return unavailable();
      const latest = Array.isArray(messages) ? messages[0] : null;
      const latestMessageID = getLatestMessageID ? await getLatestMessageID(scope, { signal }) : latest?.id ?? latest?.info?.id;
      if (latestMessageID !== undefined && latestMessageID !== null && typeof latestMessageID !== 'string') return unavailable();
      const lastInfo = latest?.info ?? latest;
      const idle = getSessionEligibility ? status.idle : !Object.hasOwn(status, scope.sessionID);
      if (getSessionEligibility) return { available: true, idle, settled: status?.settled === true, latestMessageID };
      const settlement = turnGate.evaluate(key, {
        available: true,
        idle,
        tailID: typeof lastInfo?.id === 'string' ? lastInfo.id : null,
        tailRole: messageType(latest),
        tailCompleted: Boolean(lastInfo?.time?.completed),
      });
      return { available: true, idle, settled: settlement.ready, latestMessageID, settlementReason: settlement.reason, ...(settlement.nextCheckAt === undefined ? {} : { nextCheckAt: settlement.nextCheckAt }) };
    } catch { return unavailable(); }
  };
  const createMessageID = (floor) => createAscendingMessageID(floor);
  const materializeAttachments = async (item, { signal } = {}) => {
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const files = await Promise.all(attachments.map((attachment) => readAttachment(attachment, item, { signal })));
    return [{ type: 'text', text: item.content ?? '' }, ...files.filter(Boolean)];
  };
  const materializeAssistantDeliveryParts = async (item, { signal } = {}) => {
    const attachments = new Map((Array.isArray(item.attachments) ? item.attachments : []).map((attachment) => [attachment.attachmentID, attachment]));
    return Promise.all(item.deliveryParts.map(async (part) => {
      if (part.type === 'text' || typeof part.url === 'string') return part;
      const attachment = attachments.get(part.attachmentID);
      if (!attachment) throw Object.assign(new Error('assistant_attachment_missing'), { code: 'assistant_attachment_missing' });
      const file = await readAttachment(attachment, item, { signal });
      if (!file || file.type !== 'file') throw Object.assign(new Error('assistant_attachment_unavailable'), { code: 'assistant_attachment_unavailable' });
      return { type: 'file', mime: part.mime, url: file.url };
    }));
  };
  const openCodeUrl = (pathname, directory, runtime) => {
    const base = (runtime?.config?.apiBaseUrl ?? buildOpenCodeUrl('/', '')).replace(/\/$/, '');
    const url = new URL(`${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
    if (directory) url.searchParams.set('directory', directory);
    return url;
  };
  const authHeaders = (runtime) => runtime?.config?.authHeaders ?? getOpenCodeAuthHeaders();
  const promptBodyFromContext = (context) => {
    const parts = Array.isArray(context.parts) ? context.parts : [];
    const text = typeof context.content === 'string' && context.content
      ? context.content
      : parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
    const files = parts
      .filter((part) => part?.type === 'file' && typeof part.url === 'string')
      .map((part) => ({
        uri: part.url,
        ...(part.filename || part.name ? { name: part.filename || part.name } : {}),
        ...(part.mime ? { mime: part.mime } : {}),
      }));
    const config = context.sendConfig ?? context;
    return {
      id: context.messageID,
      text,
      delivery: context.delivery === 'queue' ? 'queue' : 'steer',
      ...(files.length ? { files } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.variant ? { variant: config.variant } : {}),
      ...(config.providerID && config.modelID ? { model: { providerID: config.providerID, modelID: config.modelID } } : {}),
    };
  };
  const classifyHttpStatus = (status, { ok } = {}) => {
    if (ok || isSuccessStatus(status)) return { ok: true, status };
    if (status === 408 || status === 429 || (Number.isInteger(status) && status >= 500)) {
      return { ok: false, status, kind: 'ambiguous' };
    }
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return { ok: false, status, kind: 'failed' };
    }
    return { ok: false, kind: 'ambiguous', code: 'malformed_result' };
  };
  const send = async (context, { signal } = {}) => {
    if (!isCurrent(context.runtime)) return { ok: false, kind: 'retry', code: 'runtime_stale' };
    try {
      const parts = context.parts ?? await materializeAttachments(context, { signal });
      const sessionID = context.scope?.sessionID ?? context.sessionID;
      const directory = context.scope?.directory ?? context.directory;
      const response = await fetch(openCodeUrl(`/api/session/${encodeURIComponent(sessionID)}/prompt`, directory, context.runtime), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(context.runtime) },
        body: JSON.stringify(promptBodyFromContext({ ...context, parts })),
        signal,
      });
      // Only an explicit 2xx (incl. empty 200/202/204) with no error is success.
      // undefined/malformed results must not be treated as accepted POSTs.
      if (!response || typeof response !== 'object') return { ok: false, kind: 'ambiguous', code: 'malformed_result' };
      return classifyHttpStatus(response.status, { ok: response.ok });
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, kind: 'ambiguous', code: 'aborted' };
      return { ok: false, kind: 'ambiguous', code: 'transport' };
    }
  };
  const findViaInbox = async (scope, messageID, { signal, runtime } = {}) => {
    try {
      const list = await client(runtime).session.inbox.list({ sessionID: scope.sessionID }, { signal });
      if (!Array.isArray(list)) throw Object.assign(new Error('upstream'), { code: 'upstream' });
      return { found: list.some((item) => inboxItemIdentity(item) === messageID) };
    } catch (error) {
      if (isNotFoundError(error)) return { found: false };
      throw error;
    }
  };
  // Prefer client.v2.session.message when the 1.18 SDK surface exposes it.
  // Ticket 12: after prompt admission, reconcile only asks inbox + projection.
  const findViaProjection = async (scope, messageID, { signal, runtime } = {}) => {
    try {
      const record = await client(runtime).session.message({ sessionID: scope.sessionID, messageID }, { signal });
      const id = messageIdentity(record);
      if (id === messageID || Boolean(record?.info ?? record?.id)) return { found: true };
      return { found: false };
    } catch (error) {
      if (isNotFoundError(error)) return { found: false };
      throw error;
    }
  };
  const findMessage = async (scope, messageID, { signal, runtime } = {}) => {
    try {
      if (getMessageByID) {
        const exact = await getMessageByID(scope, messageID, { signal, runtime });
        if (exact?.unavailable) return { unavailable: true };
        return { found: Boolean(exact?.found ?? exact?.data ?? exact?.id) };
      }
      const inbox = await findViaInbox(scope, messageID, { signal, runtime });
      if (inbox.unavailable) return { unavailable: true };
      if (inbox.found) return { found: true };
      return findViaProjection(scope, messageID, { signal, runtime });
    } catch { return { unavailable: true }; }
  };
  const observeSessionEvent = (scope, phase, runtime = captureRuntime()) => turnGate.observeEvent(turnKey(scope, runtime), phase);
  const noteClientOperation = (scope, runtime = captureRuntime()) => turnGate.noteClientOperation(turnKey(scope, runtime));
  const acquireAutomaticAdmission = (scope, runtime) => turnGate.acquireAutomatic(turnKey(scope, runtime));
  const validateAutomaticAdmission = (token) => turnGate.validateAutomatic(token);
  const finishAutomaticAdmission = (token, options) => turnGate.finishAutomatic(token, options);
  return { captureRuntime, isCurrent, checkEligibility, createMessageID, send, findMessage, materializeAttachments, materializeAssistantDeliveryParts, observeSessionEvent, noteClientOperation, acquireAutomaticAdmission, validateAutomaticAdmission, finishAutomaticAdmission, waitForReady: typeof waitForReady === 'function' ? () => waitForReady() : undefined };
};
