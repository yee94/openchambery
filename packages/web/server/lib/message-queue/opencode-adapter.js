import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createAscendingMessageID } from './message-id.js';
import { createSessionTurnGate } from './session-turn-gate.js';

// SDK 1.18 result shapes vary: success may be 2xx with empty body (200/202/204),
// failures may place status on response, error, or the top-level result.
const safeStatus = (result) => {
  for (const candidate of [result?.response?.status, result?.error?.status, result?.status]) {
    if (Number.isInteger(candidate)) return candidate;
  }
  return undefined;
};
const isSuccessStatus = (status) => Number.isInteger(status) && status >= 200 && status < 300;
const runtimeToken = (config, generation) => JSON.stringify([generation ?? null, config?.apiBaseUrl ?? config?.baseUrl ?? null]);
const messageIdentity = (message) => message?.info?.id ?? message?.id;
const isNotFoundOrUnsupported = (status) => status === 404 || status === 405 || status === 501;
const isUnsupportedLookupError = (error) => {
  if (!error) return false;
  if (error instanceof TypeError) return true;
  const message = typeof error?.message === 'string' ? error.message : '';
  return /is not a function|not a function|undefined is not|Cannot read properties of undefined/i.test(message);
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
  const client = (runtime) => createOpencodeClient({ baseUrl: (runtime?.config?.apiBaseUrl ?? buildOpenCodeUrl('/', '')).replace(/\/$/, ''), headers: runtime?.config?.authHeaders ?? getOpenCodeAuthHeaders() });
  const turnKey = (scope, runtime) => JSON.stringify([runtime?.token ?? runtimeToken(getRuntimeConfig(), getRuntimeGeneration()), scope.directory, scope.sessionID]);
  const checkEligibility = async (scope, runtime, { signal } = {}) => {
    const key = turnKey(scope, runtime);
    const unavailable = () => {
      if (!getSessionEligibility) turnGate.evaluate(key, { available: false, idle: false, tailID: null, tailRole: null, tailCompleted: false });
      return { available: false, idle: false, settled: false };
    };
    try {
      const api = client(runtime); const status = getSessionEligibility ? await getSessionEligibility(scope, { signal }) : await api.session.status({ directory: scope.directory }, { signal });
      const messages = getLatestMessageID ? null : await api.session.messages({ sessionID: scope.sessionID, directory: scope.directory }, { signal });
      const injectedStatus = getSessionEligibility && status && typeof status === 'object' && typeof status.idle === 'boolean' && typeof status.settled === 'boolean';
      const apiStatus = !getSessionEligibility && status?.data && typeof status.data === 'object' && !Array.isArray(status.data);
      if (status?.error || messages?.error || (!injectedStatus && !apiStatus) || (!getSessionEligibility && !Array.isArray(messages?.data))) return unavailable();
      const latestMessageID = getLatestMessageID ? await getLatestMessageID(scope, { signal }) : (messages?.data ?? []).at(-1)?.info?.id ?? (messages?.data ?? []).at(-1)?.id;
      if (latestMessageID !== undefined && latestMessageID !== null && typeof latestMessageID !== 'string') return unavailable();
      const last = (messages?.data ?? []).at(-1); const lastInfo = last?.info ?? last;
      const statusMap = status?.data;
      const statusValue = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap) ? statusMap[scope.sessionID] : statusMap;
      const missingSessionStatus = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap) && !Object.hasOwn(statusMap, scope.sessionID);
      const idle = getSessionEligibility ? status.idle : missingSessionStatus || statusValue?.type === 'idle' || statusValue?.status === 'idle' || status?.idle === true;
      if (getSessionEligibility) return { available: true, idle, settled: status?.settled === true, latestMessageID };
      const settlement = turnGate.evaluate(key, {
        available: true,
        idle,
        tailID: typeof lastInfo?.id === 'string' ? lastInfo.id : null,
        tailRole: lastInfo?.role === 'assistant' || lastInfo?.role === 'user' ? lastInfo.role : last ? 'unknown' : null,
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
  const send = async (context, { signal } = {}) => {
    if (!isCurrent(context.runtime)) return { ok: false, kind: 'retry', code: 'runtime_stale' };
    try {
      const config = context.sendConfig ?? context;
      const result = await client(context.runtime).session.promptAsync({
        sessionID: context.scope?.sessionID ?? context.sessionID,
        directory: context.scope?.directory ?? context.directory,
        messageID: context.messageID,
        model: { providerID: config.providerID, modelID: config.modelID },
        ...(config.agent ? { agent: config.agent } : {}),
        ...(config.variant ? { variant: config.variant } : {}),
        parts: context.parts ?? await materializeAttachments(context, { signal }),
      }, { signal });
      // Only an explicit 2xx (incl. empty 200/202/204) with no error is success.
      // undefined/malformed results must not be treated as accepted POSTs.
      if (!result || typeof result !== 'object') return { ok: false, kind: 'ambiguous', code: 'malformed_result' };
      const status = safeStatus(result);
      if (result.error) {
        return {
          ok: false,
          status,
          kind: status === 408 || status === 429 || (Number.isInteger(status) && status >= 500) || status === undefined
            ? 'ambiguous'
            : Number.isInteger(status) && status >= 400 && status < 500
              ? 'failed'
              : 'ambiguous',
        };
      }
      if (isSuccessStatus(status)) return { ok: true, status };
      if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        return { ok: false, status, kind: 'failed' };
      }
      if (status === 408 || status === 429 || (Number.isInteger(status) && status >= 500)) {
        return { ok: false, status, kind: 'ambiguous' };
      }
      // Missing status without error is ambiguous (empty/malformed transport), not ok.
      return { ok: false, kind: 'ambiguous', code: 'malformed_result' };
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, kind: 'ambiguous', code: 'aborted' };
      return { ok: false, kind: 'ambiguous', code: 'transport' };
    }
  };
  const findViaBoundedMessages = async (api, scope, messageID, { signal } = {}) => {
    const result = await api.session.messages({ sessionID: scope.sessionID, directory: scope.directory, limit: 100 }, { signal });
    if (result?.error) return { unavailable: true };
    const found = (result?.data ?? []).some((message) => messageIdentity(message) === messageID);
    if (found) return { found: true };
    if (result?.data?.length >= 100 || result?.nextCursor || result?.hasMore) return { unavailable: true };
    return { found: false };
  };
  const findViaLegacySessionMessage = async (api, scope, messageID, { signal } = {}) => {
    const legacy = api?.session?.message;
    if (typeof legacy !== 'function') return null;
    try {
      const result = await legacy.call(api.session, { sessionID: scope.sessionID, messageID, directory: scope.directory }, { signal });
      const status = safeStatus(result);
      if (result?.error) {
        if (status === 404) return { found: false };
        if (isNotFoundOrUnsupported(status)) return null;
        return { unavailable: true };
      }
      const record = result?.data ?? result;
      const id = messageIdentity(record);
      if (id === messageID || Boolean(record?.info ?? record?.id)) return { found: true };
      return { found: false };
    } catch (error) {
      if (isUnsupportedLookupError(error)) return null;
      return { unavailable: true };
    }
  };
  const findViaExactV2Message = async (api, scope, messageID, { signal } = {}) => {
    // Prefer client.v2.session.message when the 1.18 SDK surface exposes it.
    const exact = api?.v2?.session?.message;
    if (typeof exact !== 'function') return { kind: 'unsupported' };
    try {
      const result = await exact.call(api.v2.session, { sessionID: scope.sessionID, messageID, directory: scope.directory }, { signal });
      const status = safeStatus(result);
      if (result?.error) {
        if (status === 404) return { kind: 'result', value: { found: false } };
        if (isNotFoundOrUnsupported(status)) return { kind: 'unsupported' };
        return { kind: 'result', value: { unavailable: true } };
      }
      const record = result?.data ?? result;
      const id = messageIdentity(record);
      if (id === messageID || Boolean(record?.info ?? record?.id)) return { kind: 'result', value: { found: true } };
      return { kind: 'result', value: { found: false } };
    } catch (error) {
      if (isUnsupportedLookupError(error)) return { kind: 'unsupported' };
      return { kind: 'result', value: { unavailable: true } };
    }
  };
  const findMessage = async (scope, messageID, { signal, runtime } = {}) => {
    try {
      if (getMessageByID) {
        const exact = await getMessageByID(scope, messageID, { signal, runtime });
        if (exact?.unavailable) return { unavailable: true };
        return { found: Boolean(exact?.found ?? exact?.data ?? exact?.id) };
      }
      const api = client(runtime);
      const v2 = await findViaExactV2Message(api, scope, messageID, { signal });
      if (v2.kind === 'result') return v2.value;
      // Missing/unsupported v2 endpoint (or 405/501): try legacy client.session.message, then bounded list.
      const legacy = await findViaLegacySessionMessage(api, scope, messageID, { signal });
      if (legacy) return legacy;
      return findViaBoundedMessages(api, scope, messageID, { signal });
    } catch { return { unavailable: true }; }
  };
  const observeSessionEvent = (scope, phase, runtime = captureRuntime()) => turnGate.observeEvent(turnKey(scope, runtime), phase);
  const noteClientOperation = (scope, runtime = captureRuntime()) => turnGate.noteClientOperation(turnKey(scope, runtime));
  const acquireAutomaticAdmission = (scope, runtime) => turnGate.acquireAutomatic(turnKey(scope, runtime));
  const validateAutomaticAdmission = (token) => turnGate.validateAutomatic(token);
  const finishAutomaticAdmission = (token, options) => turnGate.finishAutomatic(token, options);
  return { captureRuntime, isCurrent, checkEligibility, createMessageID, send, findMessage, materializeAttachments, materializeAssistantDeliveryParts, observeSessionEvent, noteClientOperation, acquireAutomaticAdmission, validateAutomaticAdmission, finishAutomaticAdmission, waitForReady: typeof waitForReady === 'function' ? () => waitForReady() : undefined };
};
