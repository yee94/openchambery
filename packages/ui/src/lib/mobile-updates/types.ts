/** Request body for POST /v1/mobile/update/check. */
export type MobileUpdateChannel = 'beta' | 'stable';
export type MobileUpdatePlatform = 'ios' | 'android';

export interface MobileUpdateCheckRequest {
  channel: MobileUpdateChannel;
  platform: MobileUpdatePlatform;
  deviceId: string;
  nativeVersion: string;
  nativeBuild: number;
  shellApiVersion: number;
  /** Capgo bundle id, or `builtin` when no OTA bundle is applied. */
  currentBundleId: string;
  installSource?: string;
}

export type MobileOtaBundleState = 'current' | 'available' | 'outside_rollout' | 'incompatible';
export type MobileNativeUpdateState = 'current' | 'available' | 'required';
export type MobileUpdatePrimaryAction = 'none' | 'apply_ota' | 'install_native_required';

export interface MobileOtaBundleInfo {
  bundleId: string;
  releaseVersion: string;
  url: string;
  size: number;
  checksum: string;
  sessionKey?: string;
  minShellApiVersion: number;
}

export interface MobileUpdateDecision {
  status: 'ok';
  primaryAction: MobileUpdatePrimaryAction;
  ota: {
    state: MobileOtaBundleState;
    bundle?: MobileOtaBundleInfo;
  };
  native: {
    state: MobileNativeUpdateState;
    version?: string;
    build?: number;
    installUrl?: string;
  };
  nextCheckInSec: number;
  /** Changelog markdown between the current native version and the OTA release. */
  releaseNotes?: string;
  /**
   * True when the server is offering a stable-channel OTA that rolls the device
   * back from a newer prerelease (beta) bundle. Capgo snake_case responses use
   * `is_channel_rollback`; the coordinator normalizes both to this field.
   */
  isChannelRollback?: boolean;
}

export type MobileUpdatesPhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'pending_restart'
  | 'current'
  | 'outside_rollout'
  | 'native_required'
  | 'error';

export type MobileUpdatesState = {
  phase: MobileUpdatesPhase;
  bundle?: MobileOtaBundleInfo;
  decision?: MobileUpdateDecision;
  error?: string;
  currentBundleId?: string;
};

/** Thrown when the Capgo updater plugin is unavailable (web / non-native). */
export class MobileUpdatesUnsupportedError extends Error {
  readonly code = 'mobile_updates_unsupported' as const;

  constructor(message = 'Mobile OTA updates are only available in the Capacitor native app') {
    super(message);
    this.name = 'MobileUpdatesUnsupportedError';
  }
}
