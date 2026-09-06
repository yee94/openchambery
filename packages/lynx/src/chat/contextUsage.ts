/**
 * Cap `mobileContextUsage.ts` port for Lynx.
 * Token display + model context limit from real Cap `/api/config/providers`.
 * Never invent limits; failure / missing catalog → hide display (null).
 */
import type { LynxRuntimeFetch } from '../runtime/fetch';
import {
  scanLynxContextTokenBaseline,
  type LynxContextBaselineMessage,
} from './contextTokenBaseline';

export type LynxContextDisplay = {
  percentage: number;
  tokens: string;
  /** Cap-compatible CSS color class using theme status vars. */
  colorClass: string;
  status: 'success' | 'warning' | 'error';
} | null;

export type LynxContextMessageLike = LynxContextBaselineMessage & {
  model?: { providerID?: string; modelID?: string };
};

export const getLynxNumericLimit = (
  limit: unknown,
  key: 'context' | 'output',
): number | undefined => {
  if (!limit || typeof limit !== 'object') return undefined;
  const value = (limit as Partial<Record<'context' | 'output', unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

export const getLynxTokenCount = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

export const formatLynxContextTokens = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
};

export const resolveLynxContextStatus = (
  percentage: number,
): 'success' | 'warning' | 'error' => {
  if (percentage >= 90) return 'error';
  if (percentage >= 75) return 'warning';
  return 'success';
};

export const resolveLynxContextColorClass = (percentage: number): string => {
  const status = resolveLynxContextStatus(percentage);
  if (status === 'error') return 'text-[var(--status-error)]';
  if (status === 'warning') return 'text-[var(--status-warning)]';
  return 'text-[var(--status-success)]';
};

export const buildLynxContextDisplay = (input: {
  totalTokens: number;
  contextLimit: number;
  isDraft: boolean;
}): LynxContextDisplay => {
  const { totalTokens, contextLimit, isDraft } = input;
  if (isDraft || totalTokens <= 0 || contextLimit <= 0) return null;
  const percentage = Math.min((totalTokens / contextLimit) * 100, 999);
  const status = resolveLynxContextStatus(percentage);
  return {
    percentage,
    tokens: `${formatLynxContextTokens(totalTokens)}/${formatLynxContextTokens(contextLimit)}`,
    colorClass: resolveLynxContextColorClass(percentage),
    status,
  };
};

export const getLynxLatestUserMessageModel = (
  messages: readonly LynxContextMessageLike[],
): { providerID: string; modelID: string } | null => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'user') continue;
    const providerID = typeof message.model?.providerID === 'string'
      && message.model.providerID.trim().length > 0
      ? message.model.providerID
      : undefined;
    const modelID = typeof message.model?.modelID === 'string'
      && message.model.modelID.trim().length > 0
      ? message.model.modelID
      : undefined;
    if (providerID && modelID) return { providerID, modelID };
  }
  return null;
};

export const getLynxLatestAssistantTotalTokens = (
  messages: readonly LynxContextMessageLike[],
  getParts?: (messageId: string) => readonly unknown[] | undefined,
): number => {
  const baseline = scanLynxContextTokenBaseline(
    messages,
    getParts ?? (() => undefined),
  );
  if (!baseline || 'compacted' in baseline) return 0;
  return baseline.totalTokens;
};

export type LynxProviderModelLimit = {
  providerID: string;
  modelID: string;
  contextLimit: number;
  outputLimit?: number;
};

export type LynxContextLimitResult =
  | { status: 'ok'; limit: LynxProviderModelLimit }
  | { status: 'ok'; limit: null }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: string; httpStatus?: number };

const asRecord = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

const listProviders = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  const record = asRecord(data);
  if (Array.isArray(record.providers)) return record.providers as unknown[];
  return [];
};

/** Pure parse of Cap `/api/config/providers` → context limit for a model ref. */
export const resolveLynxContextLimitFromProvidersPayload = (
  payload: unknown,
  modelRef: { providerID: string; modelID: string } | null,
): number => {
  if (!modelRef) return 0;
  const providers = listProviders(payload);
  for (const entry of providers) {
    const provider = asRecord(entry);
    const providerId = typeof provider.id === 'string' ? provider.id
      : typeof provider.providerID === 'string' ? provider.providerID
        : '';
    if (providerId !== modelRef.providerID) continue;
    const modelsRaw = provider.models;
    const models = Array.isArray(modelsRaw)
      ? modelsRaw
      : modelsRaw && typeof modelsRaw === 'object'
        ? Object.values(modelsRaw as Record<string, unknown>)
        : [];
    for (const modelEntry of models) {
      const model = asRecord(modelEntry);
      const modelId = typeof model.id === 'string' ? model.id : '';
      if (modelId !== modelRef.modelID) continue;
      return getLynxNumericLimit(model.limit, 'context') ?? 0;
    }
  }
  return 0;
};

/**
 * Fetch Cap `/api/config/providers` and resolve the live model context limit.
 * Failure ≠ invented default; callers hide the chrome chip when limit is 0.
 */
export async function fetchLynxModelContextLimit(
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  input: {
    directory?: string | null;
    modelRef: { providerID: string; modelID: string } | null;
    /** Optional composer fallback when transcript has no user model yet. */
    fallbackModel?: { providerID: string; modelID: string } | null;
  },
): Promise<LynxContextLimitResult> {
  if (!runtimeFetch) return { status: 'no-runtime' };
  const modelRef = input.modelRef ?? input.fallbackModel ?? null;
  if (!modelRef) return { status: 'ok', limit: null };

  const directory = input.directory?.trim();
  const query = directory
    ? `?directory=${encodeURIComponent(directory)}`
    : '';
  try {
    const response = await runtimeFetch(`/api/config/providers${query}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(directory ? { 'x-opencode-directory': directory } : {}),
      },
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      const body = asRecord(await response.json().catch(() => null));
      const message = typeof body.error === 'string' && body.error.trim()
        ? body.error.trim()
        : `HTTP ${response.status}`;
      return { status: 'failed', error: message, httpStatus: response.status };
    }
    const payload = await response.json().catch(() => null);
    const contextLimit = resolveLynxContextLimitFromProvidersPayload(payload, modelRef);
    if (contextLimit <= 0) return { status: 'ok', limit: null };
    return {
      status: 'ok',
      limit: {
        providerID: modelRef.providerID,
        modelID: modelRef.modelID,
        contextLimit,
        outputLimit: undefined,
      },
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Build chrome display from transcript messages + resolved limit. */
export const buildLynxChatContextChrome = (input: {
  messages: readonly LynxContextMessageLike[];
  contextLimit: number;
  isDraft?: boolean;
  getParts?: (messageId: string) => readonly unknown[] | undefined;
}): LynxContextDisplay => {
  const totalTokens = getLynxLatestAssistantTotalTokens(
    input.messages,
    input.getParts,
  );
  return buildLynxContextDisplay({
    totalTokens,
    contextLimit: input.contextLimit,
    isDraft: input.isDraft === true,
  });
};
