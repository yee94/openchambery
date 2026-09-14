import { describe, expect, test } from 'vitest';

import {
  LYNX_MOBILE_SETTINGS_PAGE_SLUGS,
  LYNX_SETTINGS_SLUGS_NOT_ON_MOBILE,
  LYNX_VOICE_SLUG_POLICY,
} from './slugs';

/**
 * Cap main `MOBILE_SETTINGS_PAGE_SLUGS` (origin/main). Tip `packages/ui` may
 * still list 21; Lynx implements the Cap main 22-slug phone home.
 */
const CAP_MAIN_MOBILE_SETTINGS_PAGE_SLUGS = [
  'instances',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'archived-sessions',
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

describe('Lynx mobile settings slugs', () => {
  test('lists the same 22 Cap main mobile slugs', () => {
    expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).toHaveLength(22);
    expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).toEqual([...CAP_MAIN_MOBILE_SETTINGS_PAGE_SLUGS]);
    expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).toContain('archived-sessions');
    expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).toContain('voice');
    expect(LYNX_VOICE_SLUG_POLICY).toBe('status-and-models-only-no-invented-asr');
  });

  test('does not add desktop-only slugs to the phone list', () => {
    for (const slug of LYNX_SETTINGS_SLUGS_NOT_ON_MOBILE) {
      expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).not.toContain(slug as never);
    }
  });
});
