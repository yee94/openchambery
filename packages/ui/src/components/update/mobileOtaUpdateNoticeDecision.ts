/**
 * Pure decision helpers for the Capacitor in-app OTA update notice.
 *
 * Extracted so startup-check and toast-dedup gates can be unit-tested without
 * React, storage, or Capgo. The React surface (`MobileOtaUpdateNotice.tsx`)
 * owns side effects.
 */

export interface MobileOtaUpdateNoticeDecisionInput {
  /** True only inside the native Capacitor shell. */
  readonly enabled: boolean;
  readonly runtimeType: string | null | undefined;
  readonly available: boolean;
  /** Web-bundle OTA path; native APK updates use MobileAppUpdateToast instead. */
  readonly inAppApply: boolean;
  readonly version: string;
  /** Most recent version the user dismissed, or `null` if none. */
  readonly dismissedVersion: string | null;
  /** Versions already surfaced in this app session. */
  readonly seenVersions: ReadonlySet<string>;
}

/**
 * Returns `true` when the in-app OTA notice toast should be shown.
 *
 * Gates (any failure short-circuits):
 *  1. Native Capacitor only.
 *  2. Store reports a mobile in-app OTA update.
 *  3. Non-empty version that has not been dismissed or already seen this session.
 */
export const shouldShowMobileOtaUpdateNotice = (
  input: MobileOtaUpdateNoticeDecisionInput,
): boolean => {
  if (!input.enabled) return false;
  if (input.runtimeType !== 'mobile') return false;
  if (!input.available) return false;
  if (!input.inAppApply) return false;
  if (!input.version) return false;
  if (input.seenVersions.has(input.version)) return false;
  if (input.dismissedVersion !== null && input.dismissedVersion === input.version) {
    return false;
  }
  return true;
};

export interface MobileOtaStartupCheckDecisionInput {
  readonly enabled: boolean;
  /** Ref/session flag: the mount effect already kicked off one check. */
  readonly alreadyChecked: boolean;
}

/** Returns `true` when the component should call `checkForUpdates()` once on mount. */
export const shouldRunMobileOtaStartupCheck = (
  input: MobileOtaStartupCheckDecisionInput,
): boolean => input.enabled && !input.alreadyChecked;
