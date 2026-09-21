import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../.github/workflows/expo-mobile-ci.yml',
);

describe('expo-mobile-ci Android SDK setup', () => {
  it('does not ask sdkmanager for the removed legacy tools package', () => {
    const yaml = readFileSync(workflowPath, 'utf8');
    expect(yaml).toContain('android-actions/setup-android@');
    expect(yaml).toMatch(/packages:\s*platform-tools\b/);
    expect(yaml).not.toMatch(/packages:\s*['"]?tools(?:\s|['"]|$)/);
  });
});
