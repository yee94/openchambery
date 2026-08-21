import { scanContextTokenBaseline } from '@/sync/context-token-baseline';

export type MobileContextDisplay = {
  percentage: number;
  tokens: string;
  colorClass: string;
} | null;

export const getNumericLimit = (limit: unknown, key: 'context' | 'output'): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const getTokenCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

export const formatContextTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

export const resolveContextColorClass = (percentage: number): string => {
  if (percentage >= 90) return 'text-[var(--status-error)]';
  if (percentage >= 75) return 'text-[var(--status-warning)]';
  return 'text-[var(--status-success)]';
};

export const buildMobileContextDisplay = (input: {
  totalTokens: number;
  contextLimit: number;
  isDraft: boolean;
}): MobileContextDisplay => {
  const { totalTokens, contextLimit, isDraft } = input;
  if (isDraft || totalTokens <= 0 || contextLimit <= 0) return null;
  const percentage = Math.min((totalTokens / contextLimit) * 100, 999);
  return {
    percentage,
    tokens: `${formatContextTokens(totalTokens)}/${formatContextTokens(contextLimit)}`,
    colorClass: resolveContextColorClass(percentage),
  };
};

type MessageLike = {
  id?: string;
  role?: string;
  model?: { providerID?: string; modelID?: string };
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
};

export const getLatestUserMessageModel = (
  messages: readonly MessageLike[],
): { providerID: string; modelID: string } | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user') continue;
    const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
      ? message.model.providerID
      : undefined;
    const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
      ? message.model.modelID
      : undefined;
    if (providerID && modelID) return { providerID, modelID };
  }
  return null;
};

export const getLatestAssistantTotalTokens = (
  messages: readonly MessageLike[],
  getParts?: (messageId: string) => readonly unknown[] | undefined,
): number => {
  // A compaction row newer than the last token-bearing assistant resets the
  // baseline: pre-compaction counts no longer describe the live context
  // window, so usage stays unknown (0 hides the display) until a
  // post-compaction assistant publishes tokens.
  const baseline = scanContextTokenBaseline(messages, getParts ?? (() => undefined));
  if (!baseline || 'compacted' in baseline) return 0;
  return baseline.totalTokens;
};
