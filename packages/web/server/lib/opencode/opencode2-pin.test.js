import { describe, expect, it } from 'vitest';
import {
  OPENCODE2_NPM_PACKAGE,
  PINNED_OPENCODE2_VERSION,
  compareOpenCode2Versions,
  evaluateOpenCodeHealthBody,
  isAcceptableOpenCode2HealthVersion,
  isOpenCode1xVersion,
  isOpenCode2VersionAtLeast,
  npmPackageForOpenCode2,
  parseOpenCode2VersionOutput,
  rejectOpenCode1xUpgradeTarget,
  resolveOpenCode2UpgradeTarget,
} from './opencode2-pin.js';

describe('opencode2 pin (ticket 12)', () => {
  it('rejects 1.x version strings and accepts the pinned v2', () => {
    expect(isOpenCode1xVersion('1.18.4')).toBe(true);
    expect(isOpenCode1xVersion('v1.18.18')).toBe(true);
    expect(isOpenCode1xVersion('1.18.x')).toBe(true);
    expect(isOpenCode1xVersion('1')).toBe(true);
    expect(isOpenCode1xVersion(PINNED_OPENCODE2_VERSION)).toBe(false);
    expect(isOpenCode1xVersion('2.0.12')).toBe(false);
    expect(isOpenCode1xVersion('')).toBe(false);
    expect(isOpenCode1xVersion(null)).toBe(false);
  });

  it('throws on 1.x upgrade targets and defaults empty to the pin', () => {
    expect(() => rejectOpenCode1xUpgradeTarget('1.18.4')).toThrow(/1\.x/);
    expect(() => rejectOpenCode1xUpgradeTarget('1.18.4')).toThrow(expect.objectContaining({ code: 'OPENCODE_UPGRADE_1X_REFUSED' }));
    expect(resolveOpenCode2UpgradeTarget(undefined)).toBe(PINNED_OPENCODE2_VERSION);
    expect(resolveOpenCode2UpgradeTarget('')).toBe(PINNED_OPENCODE2_VERSION);
    expect(resolveOpenCode2UpgradeTarget(PINNED_OPENCODE2_VERSION)).toBe(PINNED_OPENCODE2_VERSION);
    expect(() => resolveOpenCode2UpgradeTarget('1.18.18')).toThrow(/1\.x/);
  });

  it('pins the opencode2 npm package name (not 1.x opencode-ai)', () => {
    expect(OPENCODE2_NPM_PACKAGE).toBe('@opencode/cli');
    expect(OPENCODE2_NPM_PACKAGE).not.toBe('opencode-ai');
    expect(OPENCODE2_NPM_PACKAGE).not.toBe('@opencode-ai/cli');
  });

  it('accepts authoritative v2 health/info versions and rejects 1.x / missing / noise', () => {
    expect(isAcceptableOpenCode2HealthVersion(PINNED_OPENCODE2_VERSION)).toBe(true);
    expect(isAcceptableOpenCode2HealthVersion('v2.0.12')).toBe(true);
    expect(isAcceptableOpenCode2HealthVersion('0.0.0-beta-18155')).toBe(false);
    expect(isAcceptableOpenCode2HealthVersion('1.15.0')).toBe(false);
    expect(isAcceptableOpenCode2HealthVersion('v1.18.18')).toBe(false);
    expect(isAcceptableOpenCode2HealthVersion('')).toBe(false);
    expect(isAcceptableOpenCode2HealthVersion(null)).toBe(false);
    expect(isAcceptableOpenCode2HealthVersion('not-a-version')).toBe(false);

    expect(evaluateOpenCodeHealthBody({ healthy: true, version: PINNED_OPENCODE2_VERSION })).toEqual({
      ok: true,
      version: PINNED_OPENCODE2_VERSION,
    });
    // Official 2.x ServerInfo from GET /api/info has version without healthy.
    expect(evaluateOpenCodeHealthBody({ version: PINNED_OPENCODE2_VERSION, pid: 1 })).toEqual({
      ok: true,
      version: PINNED_OPENCODE2_VERSION,
    });
    expect(evaluateOpenCodeHealthBody({ healthy: true, version: '1.15.0' })).toMatchObject({
      ok: false,
      version: '1.15.0',
      reason: '1x-version',
    });
    expect(evaluateOpenCodeHealthBody({ healthy: true })).toMatchObject({
      ok: false,
      reason: 'unknown-version',
    });
    expect(evaluateOpenCodeHealthBody({ healthy: false, version: PINNED_OPENCODE2_VERSION })).toMatchObject({
      ok: false,
      reason: 'unhealthy',
    });
    expect(evaluateOpenCodeHealthBody(null)).toMatchObject({ ok: false, reason: 'invalid-body' });
  });

  it('parses --version output and compares against the pin', () => {
    expect(parseOpenCode2VersionOutput('opencode2 v2.0.12\n')).toBe('2.0.12');
    expect(parseOpenCode2VersionOutput('1.18.18\n')).toBe('1.18.18');
    expect(compareOpenCode2Versions('2.0.12', '2.0.1')).toBeGreaterThan(0);
    expect(isOpenCode2VersionAtLeast('2.0.12', '2.0.12')).toBe(true);
    expect(isOpenCode2VersionAtLeast('2.0.1', '2.0.12')).toBe(false);
    expect(isOpenCode2VersionAtLeast('1.18.18', '2.0.12')).toBe(false);
    expect(npmPackageForOpenCode2('darwin', 'arm64')).toBe('@opencode/cli-darwin-arm64');
    expect(npmPackageForOpenCode2('darwin', { opencode: 'x64' })).toBe('@opencode/cli-darwin-x64-baseline');
  });
});
