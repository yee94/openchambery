import type { LynxRuntimeFetch } from '../runtime/fetch';

export const LYNX_SETTINGS_ENDPOINT = '/api/config/settings';
export const LYNX_SYSTEM_INFO_ENDPOINT = '/api/system/info';

/** Subset of Cap SettingsPayload used by Lynx mobile settings bodies. */
export type LynxSettingsBlob = {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  showReasoningTraces?: boolean;
  followUpBehavior?: 'steer' | 'queue';
  queueModeEnabled?: boolean;
  chatRenderMode?: 'sorted' | 'live';
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  showOpenCodeUpdateNotifications?: boolean;
  autoDeleteEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  gitmojiEnabled?: boolean;
  projects?: Array<{ id?: string; path?: string; name?: string; [key: string]: unknown }>;
  /** Summary AI (Cap SummarySettings) */
  summaryModelMode?: 'provider' | 'custom';
  summaryProviderID?: string;
  summaryModelID?: string;
  summaryCustomBaseURL?: string;
  hasSummaryCustomAPIToken?: boolean;
  summaryCommitPrompt?: string;
  summarySessionTitlePrompt?: string;
  /** Behavior response style (Cap BehaviorPage) */
  responseStyleEnabled?: boolean;
  responseStylePreset?: string;
  responseStyleCustomInstructions?: string;
  [key: string]: unknown;
};

export type LynxSettingsLoadResult =
  | { status: 'ok'; settings: LynxSettingsBlob }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxSettingsSaveResult =
  | { status: 'ok'; settings: LynxSettingsBlob }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error; httpStatus?: number };

export type LynxSystemInfo = {
  openchamberVersion: string | null;
  openCodeVersion?: string | null;
};

export type LynxSystemInfoResult =
  | { status: 'ok'; info: LynxSystemInfo }
  | { status: 'no-runtime' }
  | { status: 'failed'; error: Error };

const asObject = (data: unknown): Record<string, unknown> => (
  data && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {}
);

export const parseLynxSettingsBlob = (data: unknown): LynxSettingsBlob => asObject(data) as LynxSettingsBlob;

/**
 * Cap `GET /api/config/settings`. Failure ≠ empty success.
 */
export const loadLynxSettings = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxSettingsLoadResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch(LYNX_SETTINGS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`settings GET failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok', settings: parseLynxSettingsBlob(await response.json()) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/**
 * Cap `PUT /api/config/settings` with a partial patch. Never fake-success.
 */
export const saveLynxSettings = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  changes: Partial<LynxSettingsBlob>,
  options?: { signal?: AbortSignal },
): Promise<LynxSettingsSaveResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch(LYNX_SETTINGS_ENDPOINT, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(changes),
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return {
        status: 'failed',
        error: new Error(`settings PUT failed (${response.status})`),
        httpStatus: response.status,
      };
    }
    return { status: 'ok', settings: parseLynxSettingsBlob(await response.json()) };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Cap About: instance OpenChamber version from `/api/system/info`. */
export const loadLynxSystemInfo = async (
  runtimeFetch: LynxRuntimeFetch | null | undefined,
  options?: { signal?: AbortSignal },
): Promise<LynxSystemInfoResult> => {
  if (!runtimeFetch) return { status: 'no-runtime' };
  try {
    const response = await runtimeFetch(LYNX_SYSTEM_INFO_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal,
    });
    if (response.status === 0) return { status: 'no-runtime' };
    if (!response.ok) {
      return { status: 'failed', error: new Error(`system info failed (${response.status})`) };
    }
    const data = asObject(await response.json());
    const openchamberVersion = typeof data.openchamberVersion === 'string' && data.openchamberVersion.trim()
      ? data.openchamberVersion.trim()
      : null;
    return { status: 'ok', info: { openchamberVersion } };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
};

/** Flexoki theme ids — Cap defaults. No invented palette. */
export const LYNX_APPEARANCE_THEME_IDS = {
  light: 'flexoki-light',
  dark: 'flexoki-dark',
} as const;

export const appearancePatchFromThemeChoice = (
  choice: 'system' | 'light' | 'dark',
): Partial<LynxSettingsBlob> => {
  if (choice === 'system') {
    return { useSystemTheme: true };
  }
  return {
    useSystemTheme: false,
    themeVariant: choice,
    lightThemeId: LYNX_APPEARANCE_THEME_IDS.light,
    darkThemeId: LYNX_APPEARANCE_THEME_IDS.dark,
    themeId: choice === 'dark' ? LYNX_APPEARANCE_THEME_IDS.dark : LYNX_APPEARANCE_THEME_IDS.light,
  };
};
