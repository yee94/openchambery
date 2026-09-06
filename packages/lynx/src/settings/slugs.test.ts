import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import {
  LYNX_MOBILE_SETTINGS_PAGE_SLUGS,
  LYNX_SETTINGS_SLUGS_NOT_ON_MOBILE,
  LYNX_VOICE_SLUG_POLICY,
} from './slugs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('Lynx mobile settings slugs', () => {
  test('lists the same 21 Cap mobile slugs', async () => {
    const source = await readFile(join(repoRoot, 'packages/ui/src/lib/settings/metadata.ts'), 'utf8');
    expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).toHaveLength(21);
    for (const slug of LYNX_MOBILE_SETTINGS_PAGE_SLUGS) {
      expect(source).toContain(`'${slug}'`);
    }
    expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).toContain('voice');
    expect(LYNX_VOICE_SLUG_POLICY).toBe('list-only-until-routes');
  });

  test('does not add desktop-only slugs to the phone list', () => {
    for (const slug of LYNX_SETTINGS_SLUGS_NOT_ON_MOBILE) {
      expect(LYNX_MOBILE_SETTINGS_PAGE_SLUGS).not.toContain(slug as never);
    }
  });
});
