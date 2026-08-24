import { describe, expect, test } from 'bun:test';
import { formatMobileClientVersionLabel, resolveMobileClientVersion } from './mobileAppVersion';

describe('resolveMobileClientVersion', () => {
  test('prefers the bundled complete version over a stripped iOS marketing version', () => {
    // iOS strips -beta.N for TestFlight; the bundle carries the full version.
    expect(resolveMobileClientVersion('1.16.87', '1.16.87-beta.3')).toBe('1.16.87-beta.3');
  });

  test('falls back to the native version when the bundled version is unknown', () => {
    expect(resolveMobileClientVersion(' 1.16.87 ', '')).toBe('1.16.87');
  });

  test('handles empty values', () => {
    expect(resolveMobileClientVersion('', '')).toBeNull();
  });
});

describe('formatMobileClientVersionLabel', () => {
  test('appends the native build number to a full release version', () => {
    expect(formatMobileClientVersionLabel('1.18.2-beta.33', 370)).toBe('1.18.2-beta.33 (370)');
  });

  test('falls back to the bare version when the build number is unknown', () => {
    expect(formatMobileClientVersionLabel('1.18.2-beta.33', null)).toBe('1.18.2-beta.33');
    expect(formatMobileClientVersionLabel('1.18.2', Number.NaN)).toBe('1.18.2');
  });

  test('returns null for an empty version', () => {
    expect(formatMobileClientVersionLabel('', 370)).toBeNull();
    expect(formatMobileClientVersionLabel(null, 370)).toBeNull();
  });
});
