/**
 * Mobile Settings tab slugs. Must stay equal to Cap `MOBILE_SETTINGS_PAGE_SLUGS`.
 * Bodies are stubs in this slice — labeled, never fake-success.
 */
export const LYNX_MOBILE_SETTINGS_PAGE_SLUGS = [
  'instances',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'summary-ai',
  'projects',
  'git',
  'providers',
  'agents',
  'assistants',
  'behavior',
  'commands',
  'mcp',
  'plugins',
  'magic-prompts',
  'snippets',
  'skills.installed',
  'usage',
  'voice',
  'about',
] as const;

export type LynxMobileSettingsSlug = typeof LYNX_MOBILE_SETTINGS_PAGE_SLUGS[number];

/** Cap mobile list excludes these desktop/web-only slugs. */
export const LYNX_SETTINGS_SLUGS_NOT_ON_MOBILE = [
  'home',
  'shortcuts',
  'remote-instances',
  'global-config',
  'skills.catalog',
] as const;

/**
 * Voice is in the mobile slug list. This scaffold lists it and does not invent
 * a mic / ASR body. Port existing `/api/dictation/*` or omit the page later.
 */
export const LYNX_VOICE_SLUG_POLICY = 'list-only-until-routes' as const;
