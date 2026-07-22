const IDENTIFIER_MAX_LENGTH = 512;
const URL_MAX_LENGTH = 4_096;
const LANGUAGE_MAX_LENGTH = 64;
const CUSTOM_INSTRUCTIONS_MAX_LENGTH = 200_000;

const identifier = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= IDENTIFIER_MAX_LENGTH ? normalized : undefined;
};

const url = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > URL_MAX_LENGTH) return undefined;
  try {
    const parsed = new URL(normalized);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return undefined;
    }
    return normalized;
  } catch {
    return undefined;
  }
};

const language = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length <= LANGUAGE_MAX_LENGTH ? normalized : undefined;
};

const boolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;

const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | undefined => {
  return typeof value === 'string' && values.includes(value as T) ? value as T : undefined;
};

export const projectSettingsBootstrap = (settings: Record<string, unknown>) => {
  const projected: Record<string, unknown> = { schemaVersion: 1 };
  const add = (key: string, value: unknown) => {
    if (value !== undefined) projected[key] = value;
  };

  add('defaultModel', identifier(settings.defaultModel));
  add('defaultVariant', identifier(settings.defaultVariant));
  add('defaultAgent', identifier(settings.defaultAgent));
  add('autoCreateWorktree', boolean(settings.autoCreateWorktree));
  add('gitmojiEnabled', boolean(settings.gitmojiEnabled));
  add('defaultFileViewerPreview', boolean(settings.defaultFileViewerPreview));
  add('zenModel', identifier(settings.zenModel));
  add('messageStreamTransport', oneOf(settings.messageStreamTransport, ['auto', 'ws', 'sse']));
  add('sttProvider', oneOf(settings.sttProvider, ['local', 'openai-compatible']));
  add('sttServerUrl', url(settings.sttServerUrl));
  add('sttModel', identifier(settings.sttModel));
  add('sttLocalModel', identifier(settings.sttLocalModel));
  add('sttLanguage', language(settings.sttLanguage));
  add('responseStyleEnabled', boolean(settings.responseStyleEnabled));
  add('responseStylePreset', oneOf(settings.responseStylePreset, [
    'concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom',
  ]));
  if (typeof settings.responseStyleCustomInstructions === 'string'
    && settings.responseStyleCustomInstructions.length <= CUSTOM_INSTRUCTIONS_MAX_LENGTH) {
    projected.responseStyleCustomInstructions = settings.responseStyleCustomInstructions;
  }

  return projected;
};

export const isSettingsBootstrapRequest = (searchParams: URLSearchParams): boolean => searchParams.get('bootstrap') === 'true';

export const getSettingsBridgeMessageType = (
  pathname: string,
  method: string,
  searchParams: URLSearchParams,
): 'api:config/settings:bootstrap' | 'api:config/settings:get' | 'api:config/settings:save' | null => {
  if (pathname === '/api/config/settings/bootstrap' && method === 'GET') {
    return 'api:config/settings:bootstrap';
  }
  if (!pathname.startsWith('/api/config/settings')) {
    return null;
  }
  if (method === 'GET') {
    return isSettingsBootstrapRequest(searchParams)
      ? 'api:config/settings:bootstrap'
      : 'api:config/settings:get';
  }
  return 'api:config/settings:save';
};
