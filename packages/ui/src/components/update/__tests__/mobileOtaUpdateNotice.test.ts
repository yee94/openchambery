import { describe, expect, test } from 'vitest';

import {
  shouldRunMobileOtaStartupCheck,
  shouldShowMobileOtaUpdateNotice,
} from '../mobileOtaUpdateNoticeDecision';

describe('shouldRunMobileOtaStartupCheck', () => {
  test('runs once when native mobile and not yet checked', () => {
    expect(
      shouldRunMobileOtaStartupCheck({
        enabled: true,
        alreadyChecked: false,
      }),
    ).toBe(true);
  });

  test('does not run when already checked', () => {
    expect(
      shouldRunMobileOtaStartupCheck({
        enabled: true,
        alreadyChecked: true,
      }),
    ).toBe(false);
  });

  test('does not run outside native Capacitor', () => {
    expect(
      shouldRunMobileOtaStartupCheck({
        enabled: false,
        alreadyChecked: false,
      }),
    ).toBe(false);
  });
});

describe('shouldShowMobileOtaUpdateNotice', () => {
  test('shows notice for a fresh in-app OTA update on native mobile', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: true,
        inAppApply: true,
        version: '1.18.3',
        dismissedVersion: null,
        seenVersions: new Set(),
      }),
    ).toBe(true);
  });

  test('does not show outside native Capacitor', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: false,
        runtimeType: 'mobile',
        available: true,
        inAppApply: true,
        version: '1.18.3',
        dismissedVersion: null,
        seenVersions: new Set(),
      }),
    ).toBe(false);
  });

  test('does not show for non-mobile runtime', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'web',
        available: true,
        inAppApply: true,
        version: '1.18.3',
        dismissedVersion: null,
        seenVersions: new Set(),
      }),
    ).toBe(false);
  });

  test('does not show when no update is available', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: false,
        inAppApply: true,
        version: '1.18.3',
        dismissedVersion: null,
        seenVersions: new Set(),
      }),
    ).toBe(false);
  });

  test('does not show for native APK updates (inAppApply false)', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: true,
        inAppApply: false,
        version: '1.18.3',
        dismissedVersion: null,
        seenVersions: new Set(),
      }),
    ).toBe(false);
  });

  test('does not show for an empty version', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: true,
        inAppApply: true,
        version: '',
        dismissedVersion: null,
        seenVersions: new Set(),
      }),
    ).toBe(false);
  });

  test('does not show when the version was already seen this session', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: true,
        inAppApply: true,
        version: '1.18.3',
        dismissedVersion: null,
        seenVersions: new Set(['1.18.3']),
      }),
    ).toBe(false);
  });

  test('does not show when the dismissed version matches', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: true,
        inAppApply: true,
        version: '1.18.3',
        dismissedVersion: '1.18.3',
        seenVersions: new Set(),
      }),
    ).toBe(false);
  });

  test('shows again when a newer version appears after dismissal', () => {
    expect(
      shouldShowMobileOtaUpdateNotice({
        enabled: true,
        runtimeType: 'mobile',
        available: true,
        inAppApply: true,
        version: '1.18.4',
        dismissedVersion: '1.18.3',
        seenVersions: new Set(),
      }),
    ).toBe(true);
  });
});
