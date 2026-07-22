import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createAscendingMessageID } from './message-id.js';

const safeStatus = (result) => Number.isInteger(result?.response?.status) ? result.response.status : undefined;
const runtimeToken = (config, generation) => JSON.stringify([generation ?? null, config?.apiBaseUrl ?? config?.baseUrl ?? null]);

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
} = {}) => {
  const captureRuntime = () => { const config = getRuntimeConfig(); const generation = getRuntimeGeneration(); return { config: { ...config, apiBaseUrl: config?.apiBaseUrl ?? config?.baseUrl ?? buildOpenCodeUrl('/', ''), authHeaders: { ...getOpenCodeAuthHeaders() } }, generation, token: runtimeToken(config, generation) }; };
  const isCurrent = (runtime) => !runtime || runtime.token === runtimeToken(getRuntimeConfig(), getRuntimeGeneration());
  const client = (runtime) => createOpencodeClient({ baseUrl: (runtime?.config?.apiBaseUrl ?? buildOpenCodeUrl('/', '')).replace(/\/$/, ''), headers: runtime?.config?.authHeaders ?? getOpenCodeAuthHeaders() });
  const checkEligibility = async (scope, runtime, { signal } = {}) => {
    try {
      const api = client(runtime); const status = getSessionEligibility ? await getSessionEligibility(scope, { signal }) : await api.session.status({ directory: scope.directory }, { signal });
      const messages = getLatestMessageID ? null : await api.session.messages({ sessionID: scope.sessionID, directory: scope.directory }, { signal });
      const injectedStatus = getSessionEligibility && status && typeof status === 'object' && typeof status.idle === 'boolean' && typeof status.settled === 'boolean';
      const apiStatus = !getSessionEligibility && status?.data && typeof status.data === 'object' && !Array.isArray(status.data);
      if (status?.error || messages?.error || (!injectedStatus && !apiStatus) || (!getSessionEligibility && !Array.isArray(messages?.data))) return { available: false, idle: false, settled: false };
      const latestMessageID = getLatestMessageID ? await getLatestMessageID(scope, { signal }) : (messages?.data ?? []).at(-1)?.info?.id ?? (messages?.data ?? []).at(-1)?.id;
      if (latestMessageID !== undefined && latestMessageID !== null && typeof latestMessageID !== 'string') return { available: false, idle: false, settled: false };
      const last = (messages?.data ?? []).at(-1);
      const settled = getSessionEligibility ? status?.settled === true : !last || (last?.info?.role === 'assistant' && Boolean(last?.info?.time?.completed));
      const statusMap = status?.data;
      const statusValue = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap) ? statusMap[scope.sessionID] : statusMap;
      const missingSessionStatus = statusMap && typeof statusMap === 'object' && !Array.isArray(statusMap) && !Object.hasOwn(statusMap, scope.sessionID);
      return { available: true, idle: getSessionEligibility ? status.idle : missingSessionStatus || statusValue?.type === 'idle' || statusValue?.status === 'idle' || status?.idle === true, settled: settled === true, latestMessageID };
    } catch { return { available: false, idle: false, settled: false }; }
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
      if (!result?.error) return { ok: true };
      const status = safeStatus(result);
      return { ok: false, status, kind: [408, 429].includes(status) || status >= 500 ? 'ambiguous' : 'failed' };
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, kind: 'ambiguous', code: 'aborted' };
      return { ok: false, kind: 'ambiguous', code: 'transport' };
    }
  };
  const findMessage = async (scope, messageID, { signal, runtime } = {}) => {
    try {
      if (getMessageByID) {
        const exact = await getMessageByID(scope, messageID, { signal, runtime });
        if (exact?.unavailable) return { unavailable: true };
        return { found: Boolean(exact?.found ?? exact?.data ?? exact?.id) };
      }
      const result = await client(runtime).session.messages({ sessionID: scope.sessionID, directory: scope.directory, limit: 100 }, { signal });
      if (result?.error) return { unavailable: true };
      const found = (result?.data ?? []).some((message) => (message?.info?.id ?? message?.id) === messageID);
      if (found) return { found: true };
      if (result?.data?.length >= 100 || result?.nextCursor || result?.hasMore) return { unavailable: true };
      return { found: false };
    } catch { return { unavailable: true }; }
  };
  return { captureRuntime, isCurrent, checkEligibility, createMessageID, send, findMessage, materializeAttachments, materializeAssistantDeliveryParts, waitForReady: typeof waitForReady === 'function' ? () => waitForReady() : undefined };
};
