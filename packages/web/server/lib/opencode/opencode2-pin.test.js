import { describe, expect, it } from 'vitest';
import {
  PINNED_OPENCODE2_VERSION,
  isOpenCode1xVersion,
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
    expect(isOpenCode1xVersion('0.0.0-next-17444')).toBe(false);
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
});
