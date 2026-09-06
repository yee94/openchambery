import type { ActiveRuntime } from '@/lib/connectionController';
import { openchamberFetch } from '@/lib/openchamberClient';

export class SettingsBlobError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'SettingsBlobError';
    this.status = status;
  }
}

export type ThemeMode = 'system' | 'light' | 'dark';

/** Writable settings blob fields Track 7 editors touch. Tokens never logged. */
export type SettingsBlob = {
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  showReasoningTraces?: boolean;
  collapsibleThinkingBlocks?: boolean;
  followUpBehavior?: 'steer' | 'queue';
  messageStreamTransport?: 'auto' | 'ws' | 'sse';
  codeBlockLineWrap?: boolean;
  stickyUserHeader?: boolean;
  persistDraftMessages?: boolean;
  showTurnChangedFiles?: boolean;
  showDotfiles?: boolean;
  allowPromptingSubagentSessions?: boolean;
  showAssistantTps?: boolean;
  nativeNotificationsEnabled?: boolean;
  notifyOnCompletion?: boolean;
  notifyOnSubtasks?: boolean;
  notifyOnError?: boolean;
  notifyOnQuestion?: boolean;
  showDeletionDialog?: boolean;
  defaultModel?: string;
  defaultVariant?: string;
  defaultAgent?: string;
  autoDeleteEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  smallModelUseDefault?: boolean;
  sessionTitleRefreshEnabled?: boolean;
  sessionGoalEnabled?: boolean;
  summaryModelMode?: 'provider' | 'custom';
  summaryProviderID?: string;
  summaryModelID?: string;
  summaryCustomBaseURL?: string;
  /** Presence only — never echo raw token values into logs/UI. */
  hasSummaryCustomAPIToken?: boolean;
  summaryCommitPrompt?: string;
  summarySessionTitlePrompt?: string;
  gitmojiEnabled?: boolean;
  defaultGitIdentityId?: string;
  showGitignored?: boolean;
  gitChangesView?: 'tree' | 'flat';
  responseStyle?: string;
  customResponseStyle?: string;
  usageDropdownProviders?: string[];
  projects?: unknown[];
  activeProjectId?: string | null;
  [key: string]: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const pickBool = (row: Record<string, unknown>, key: string): boolean | undefined =>
  typeof row[key] === 'boolean' ? row[key] : undefined;

const pickString = (row: Record<string, unknown>, key: string): string | undefined =>
  typeof row[key] === 'string' ? row[key] : undefined;

const pickNumber = (row: Record<string, unknown>, key: string): number | undefined =>
  typeof row[key] === 'number' && Number.isFinite(row[key]) ? (row[key] as number) : undefined;

export const parseSettingsBlob = (payload: unknown): SettingsBlob => {
  const row = asRecord(payload);
  if (!row) {
    throw new SettingsBlobError('invalid_settings_blob', 200);
  }
  const blob: SettingsBlob = { ...row };
  const follow = pickString(row, 'followUpBehavior');
  if (follow === 'steer' || follow === 'queue') blob.followUpBehavior = follow;
  const transport = pickString(row, 'messageStreamTransport');
  if (transport === 'auto' || transport === 'ws' || transport === 'sse') {
    blob.messageStreamTransport = transport;
  }
  const retention = pickString(row, 'sessionRetentionAction');
  if (retention === 'archive' || retention === 'delete') blob.sessionRetentionAction = retention;
  const themeVariant = pickString(row, 'themeVariant');
  if (themeVariant === 'light' || themeVariant === 'dark') blob.themeVariant = themeVariant;
  const summaryMode = pickString(row, 'summaryModelMode');
  if (summaryMode === 'provider' || summaryMode === 'custom') blob.summaryModelMode = summaryMode;
  const changesView = pickString(row, 'gitChangesView');
  if (changesView === 'tree' || changesView === 'flat') blob.gitChangesView = changesView;

  for (const key of [
    'useSystemTheme',
    'showReasoningTraces',
    'collapsibleThinkingBlocks',
    'codeBlockLineWrap',
    'stickyUserHeader',
    'persistDraftMessages',
    'showTurnChangedFiles',
    'showDotfiles',
    'allowPromptingSubagentSessions',
    'showAssistantTps',
    'nativeNotificationsEnabled',
    'notifyOnCompletion',
    'notifyOnSubtasks',
    'notifyOnError',
    'notifyOnQuestion',
    'showDeletionDialog',
    'autoDeleteEnabled',
    'smallModelUseDefault',
    'sessionTitleRefreshEnabled',
    'sessionGoalEnabled',
    'hasSummaryCustomAPIToken',
    'gitmojiEnabled',
    'showGitignored',
  ] as const) {
    const value = pickBool(row, key);
    if (value !== undefined) blob[key] = value;
  }

  for (const key of [
    'lightThemeId',
    'darkThemeId',
    'defaultModel',
    'defaultVariant',
    'defaultAgent',
    'summaryProviderID',
    'summaryModelID',
    'summaryCustomBaseURL',
    'summaryCommitPrompt',
    'summarySessionTitlePrompt',
    'defaultGitIdentityId',
    'responseStyle',
    'customResponseStyle',
  ] as const) {
    const value = pickString(row, key);
    if (value !== undefined) blob[key] = value;
  }

  const days = pickNumber(row, 'autoDeleteAfterDays');
  if (days !== undefined) blob.autoDeleteAfterDays = days;

  // Never retain raw summary API tokens in client blob views.
  if ('summaryCustomAPIToken' in blob) {
    delete blob.summaryCustomAPIToken;
  }
  return blob;
};

export const themeModeFromBlob = (blob: SettingsBlob): ThemeMode => {
  if (blob.useSystemTheme === true) return 'system';
  if (blob.themeVariant === 'light') return 'light';
  if (blob.themeVariant === 'dark') return 'dark';
  if (blob.useSystemTheme === false && blob.themeVariant) return blob.themeVariant;
  return 'system';
};

export const themeModeToPatch = (mode: ThemeMode): Partial<SettingsBlob> => {
  if (mode === 'system') return { useSystemTheme: true };
  return { useSystemTheme: false, themeVariant: mode };
};

/** GET /api/config/settings — failure must not look like empty success. */
export const loadSettingsBlob = async (
  active: ActiveRuntime,
  options?: { signal?: AbortSignal },
): Promise<SettingsBlob> => {
  const response = await openchamberFetch(active, '/api/config/settings', {
    method: 'GET',
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new SettingsBlobError('Failed to load settings', response.status);
  }
  return parseSettingsBlob(await response.json());
};

/**
 * PUT /api/config/settings — Cap merge PUT (partial changes only).
 * Never put raw token secrets into logs.
 */
export const putSettingsBlobMerge = async (
  active: ActiveRuntime,
  changes: Partial<SettingsBlob>,
  options?: { signal?: AbortSignal },
): Promise<SettingsBlob> => {
  const body = { ...changes };
  if ('summaryCustomAPIToken' in body && body.summaryCustomAPIToken === '') {
    // Explicit clear is allowed; omit undefined.
  }
  const response = await openchamberFetch(active, '/api/config/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  if (!response.ok) {
    throw new SettingsBlobError('Failed to save settings', response.status);
  }
  const payload = await response.json();
  if (payload == null || (typeof payload === 'object' && !Object.keys(payload as object).length)) {
    // Some hosts return empty body on success — re-fetch authoritative blob.
    return loadSettingsBlob(active, options);
  }
  return parseSettingsBlob(payload);
};
