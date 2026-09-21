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
/**
 * Real `@opencode/client` throws declared JSON with `_tag` (no status).
 * MessageNotFoundError / SessionNotFoundError must map to found:false, not unavailable.
 */
const isNotFoundError = (error) => {
  if (!error || typeof error !== 'object') return false;
  const tag = error._tag ?? error.name;
  if (tag === 'MessageNotFoundError' || tag === 'SessionNotFoundError') return true;
  if (httpStatus(error) === 404) return true;
  const code = error.code ?? error.type ?? error.error?.code ?? error.error?.type ?? error.error?._tag;
  return code === 'not_found'
    || code === 'NotFound'
    || code === 'MessageNotFoundError'
    || code === 'SessionNotFoundError';
};
const isSessionBusyError = (error) => {
  if (!error || typeof error !== 'object') return false;
  if ((error._tag ?? error.name) === 'SessionBusyError') return true;
  const code = error.code ?? error.type ?? error.error?._tag;
  return code === 'session_busy' || code === 'SessionBusyError';
};
const isAbortError = (error) => (
  error?.name === 'AbortError'
  || error?.code === 'aborted'
  || error?.cause?.name === 'AbortError'
);
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
  /**
   * Official v2 SessionPrompt body: id/text/files/delivery only.
   * model/agent/variant are NOT accepted on prompt — applied via
   * session.switchAgent / session.switchModel at the serial submit boundary.
   */
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
    return {
      id: context.messageID,
      text,
      delivery: context.delivery === 'queue' ? 'queue' : 'steer',
      ...(files.length ? { files } : {}),
    };
  };
  const classifyHttpStatus = (status, { ok } = {}) => {
    if (ok || isSuccessStatus(status)) return { ok: true, status };
    // 409 conflict / busy: definitive rejection before admission — retry later,
    // do not mark accepted or re-POST as a new success path.
    if (status === 409) return { ok: false, kind: 'retry', code: 'session_busy' };
    if (status === 408 || status === 429 || (Number.isInteger(status) && status >= 500)) {
      return { ok: false, status, kind: 'ambiguous' };
    }
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return { ok: false, status, kind: 'failed' };
    }
    return { ok: false, kind: 'ambiguous', code: 'malformed_result' };
  };
  const classifySwitchStatus = (status, { ok } = {}) => {
    if (ok || isSuccessStatus(status)) return { ok: true, status };
    if (status === 409) return { ok: false, kind: 'retry', code: 'session_busy' };
    if (status === 408 || status === 429 || (Number.isInteger(status) && status >= 500)) {
      return { ok: false, status, kind: 'ambiguous', code: 'config_switch_ambiguous' };
    }
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return { ok: false, status, kind: 'failed', code: 'config_switch_failed' };
    }
    return { ok: false, kind: 'ambiguous', code: 'config_switch_ambiguous' };
  };
  /**
   * Apply captured per-item sendConfig before prompt on the session serial
   * boundary. Failure returns without POSTing prompt (no accidental re-send
   * under the wrong model/agent). Order: agent → model(+variant).
   */
  const applySendConfig = async (sessionID, directory, runtime, sendConfig, { signal } = {}) => {
    if (!sendConfig || typeof sendConfig !== 'object') return { ok: true };
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeaders(runtime) };
    if (typeof sendConfig.agent === 'string' && sendConfig.agent) {
      const response = await fetch(openCodeUrl(`/api/session/${encodeURIComponent(sessionID)}/agent`, directory, runtime), {
        method: 'POST',
        headers,
        body: JSON.stringify({ agent: sendConfig.agent }),
        signal,
      });
      if (!response || typeof response !== 'object') {
        return { ok: false, kind: 'ambiguous', code: 'config_switch_ambiguous' };
      }
      const classified = classifySwitchStatus(response.status, { ok: response.ok });
      if (!classified.ok) return classified;
    }
    if (typeof sendConfig.providerID === 'string' && sendConfig.providerID
      && typeof sendConfig.modelID === 'string' && sendConfig.modelID) {
      const model = {
        id: sendConfig.modelID,
        providerID: sendConfig.providerID,
        ...(typeof sendConfig.variant === 'string' && sendConfig.variant
          ? { variant: sendConfig.variant }
          : {}),
      };
      const response = await fetch(openCodeUrl(`/api/session/${encodeURIComponent(sessionID)}/model`, directory, runtime), {
        method: 'POST',
        headers,
        body: JSON.stringify({ model }),
        signal,
      });
      if (!response || typeof response !== 'object') {
        return { ok: false, kind: 'ambiguous', code: 'config_switch_ambiguous' };
      }
      const classified = classifySwitchStatus(response.status, { ok: response.ok });
      if (!classified.ok) return classified;
    }
    return { ok: true };
  };
  const send = async (context, { signal } = {}) => {
    if (!isCurrent(context.runtime)) return { ok: false, kind: 'retry', code: 'runtime_stale' };
    try {
      const parts = context.parts ?? await materializeAttachments(context, { signal });
      const sessionID = context.scope?.sessionID ?? context.sessionID;
      const directory = context.scope?.directory ?? context.directory;
      const sendConfig = context.sendConfig && typeof context.sendConfig === 'object'
        ? context.sendConfig
        : null;
      // Serial session boundary: switch captured config, then prompt once.
      if (sendConfig) {
        const switched = await applySendConfig(sessionID, directory, context.runtime, sendConfig, { signal });
        if (!switched.ok) return switched;
      }
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
      if (isAbortError(error)) return { ok: false, kind: 'ambiguous', code: 'aborted' };
      if (isSessionBusyError(error)) return { ok: false, kind: 'retry', code: 'session_busy' };
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
      // Must await so projection rejections stay inside this try/catch
      // (bare return of a Promise lets rejections escape as unhandled).
      return await findViaProjection(scope, messageID, { signal, runtime });
    } catch { return { unavailable: true }; }
  };
  const observeSessionEvent = (scope, phase, runtime = captureRuntime()) => turnGate.observeEvent(turnKey(scope, runtime), phase);
  const noteClientOperation = (scope, runtime = captureRuntime()) => turnGate.noteClientOperation(turnKey(scope, runtime));
  const acquireAutomaticAdmission = (scope, runtime) => turnGate.acquireAutomatic(turnKey(scope, runtime));
  const validateAutomaticAdmission = (token) => turnGate.validateAutomatic(token);
  const finishAutomaticAdmission = (token, options) => turnGate.finishAutomatic(token, options);
  return { captureRuntime, isCurrent, checkEligibility, createMessageID, send, findMessage, materializeAttachments, materializeAssistantDeliveryParts, observeSessionEvent, noteClientOperation, acquireAutomaticAdmission, validateAutomaticAdmission, finishAutomaticAdmission, waitForReady: typeof waitForReady === 'function' ? () => waitForReady() : undefined };
};
