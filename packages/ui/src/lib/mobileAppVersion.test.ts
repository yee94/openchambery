import { describe, expect, test } from 'bun:test';
import { resolveMobileClientVersion } from './mobileAppVersion';

describe('resolveMobileClientVersion', () => {
  test('uses the native app version when it is available', () => {
    expect(resolveMobileClientVersion(' 1.16.87 ', '1.16.86')).toBe('1.16.87');
  });

  test('falls back to the bundled client version', () => {
    expect(resolveMobileClientVersion('', '1.16.87')).toBe('1.16.87');
  });
});
