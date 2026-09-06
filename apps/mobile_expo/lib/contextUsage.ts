/**
 * Cap mobileContextUsage subset for Expo context-usage ring.
 * Ring hides when draft / no tokens / no context limit (honest empty).
 */

export type ContextTokenRecord = {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cache?: { read?: unknown; write?: unknown };
};

export type ContextUsageMessage = {
  id?: string;
  role?: string;
  tokens?: ContextTokenRecord;
  model?: { providerID?: string; modelID?: string };
};

export type MobileContextDisplay = {
  percentage: number;
  tokensLabel: string;
  tone: 'ok' | 'warn' | 'critical';
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

export const readContextTokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

export const sumContextTokenRecord = (tokens: ContextTokenRecord): number =>
  readContextTokenCount(tokens.input)
  + readContextTokenCount(tokens.output)
  + readContextTokenCount(tokens.reasoning)
  + readContextTokenCount(tokens.cache?.read)
  + readContextTokenCount(tokens.cache?.write);

export const formatContextTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

export const resolveContextTone = (percentage: number): MobileContextDisplay['tone'] => {
  if (percentage >= 90) return 'critical';
  if (percentage >= 75) return 'warn';
  return 'ok';
};

export const getNumericLimit = (limit: unknown, key: 'context' | 'output'): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

/**
 * Newest→oldest: first token-bearing assistant wins.
 * Compaction part newer than that assistant resets baseline to unknown (0).
 */
export const getLatestAssistantTotalTokens = (
  messages: readonly ContextUsageMessage[],
  getParts?: (messageId: string) => readonly { type?: string }[] | undefined,
): number => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') {
      if (message.id && getParts) {
        const parts = getParts(message.id);
        if (parts?.some((part) => part.type === 'compaction')) return 0;
      }
      continue;
    }
    if (!message.tokens) continue;
    const total = sumContextTokenRecord(message.tokens);
    if (total > 0) return total;
  }
  return 0;
};

export const getLatestUserMessageModel = (
  messages: readonly ContextUsageMessage[],
): { providerID: string; modelID: string } | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const providerID =
      typeof message.model?.providerID === 'string' && message.model.providerID.trim()
        ? message.model.providerID.trim()
        : undefined;
    const modelID =
      typeof message.model?.modelID === 'string' && message.model.modelID.trim()
        ? message.model.modelID.trim()
        : undefined;
    if (providerID && modelID) return { providerID, modelID };
  }
  return null;
};

export const buildMobileContextDisplay = (input: {
  totalTokens: number;
  contextLimit: number;
  isDraft: boolean;
}): MobileContextDisplay | null => {
  const { totalTokens, contextLimit, isDraft } = input;
  if (isDraft || totalTokens <= 0 || contextLimit <= 0) return null;
  const percentage = Math.min((totalTokens / contextLimit) * 100, 999);
  return {
    percentage,
    tokensLabel: `${formatContextTokens(totalTokens)}/${formatContextTokens(contextLimit)}`,
    tone: resolveContextTone(percentage),
  };
};

/** Resolve context window from Cap provider catalog payload (best effort). */
export const resolveContextLimitFromCatalog = (
  catalog: unknown,
  model: { providerID: string; modelID: string } | null,
): number => {
  if (!model) return 0;
  const body = asRecord(catalog);
  const providers = Array.isArray(body?.providers) ? body.providers : [];
  for (const providerEntry of providers) {
    const provider = asRecord(providerEntry);
    if (!provider || provider.id !== model.providerID) continue;
    const models = provider.models;
    if (Array.isArray(models)) {
      for (const modelEntry of models) {
        const row = asRecord(modelEntry);
        if (!row || row.id !== model.modelID) continue;
        return getNumericLimit(row.limit, 'context') ?? 0;
      }
    } else if (models && typeof models === 'object') {
      const row = asRecord((models as Record<string, unknown>)[model.modelID]);
      if (row) return getNumericLimit(row.limit, 'context') ?? 0;
      for (const value of Object.values(models as Record<string, unknown>)) {
        const candidate = asRecord(value);
        if (candidate?.id === model.modelID) {
          return getNumericLimit(candidate.limit, 'context') ?? 0;
        }
      }
    }
  }
  return 0;
};
