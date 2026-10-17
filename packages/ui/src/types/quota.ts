export type QuotaProviderId =
  | `magpie:${string}`
  | 'openai'
  | 'codex'
  | 'cursor'
  | 'claude'
  | 'github-copilot'
  | 'github-copilot-addon'
  | 'google'
  | 'kimi-for-coding'
  | 'nano-gpt'
  | 'openrouter'
  | 'zai-coding-plan'
  | 'zhipuai-coding-plan'
  | 'minimax-coding-plan'
  | 'minimax-cn-coding-plan'
  | 'ollama-cloud'
  | 'wafer'
  | 'opencode-go'
  | 'xai';

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
  label?: string;
  disablePace?: boolean;
}

export interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
  accounts?: Array<UsageWindows & {
    id: string;
    name: string;
    user: string;
    plan: string;
    kind: string;
    from: string;
    balance: string;
    error?: string;
    readAt: number | null;
    stale: boolean;
  }>;
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  usage: ProviderUsage | null;
  fetchedAt: number;
  source?: 'magpie';
  sourceId?: string;
  upstreamProviderId?: string;
}
