import type { I18nKey } from '@/lib/i18n';

export const MANAGED_SSH_BOOTSTRAP_ERROR_CODES = [
  'nodeRuntimeMissing',
  'packageManagerMissing',
  'nativeBinding',
  'openchamberInstall',
  'opencodeInstall',
  'serverStart',
  'sshAuth',
  'sshUnreachable',
  'timeout',
  'unknown',
] as const;

export type ManagedSshBootstrapErrorCode = (typeof MANAGED_SSH_BOOTSTRAP_ERROR_CODES)[number];

const CODE_SET = new Set<string>(MANAGED_SSH_BOOTSTRAP_ERROR_CODES);

export const isManagedSshBootstrapErrorCode = (value: unknown): value is ManagedSshBootstrapErrorCode => {
  return typeof value === 'string' && CODE_SET.has(value);
};

export const classifyManagedSshBootstrapError = (raw: string | null | undefined): ManagedSshBootstrapErrorCode => {
  const text = String(raw || '');
  if (/requires Node\.js \d+|no supported Node runtime/i.test(text)) return 'nodeRuntimeMissing';
  if (/neither bun nor npm/i.test(text)) return 'packageManagerMissing';
  if (/better-sqlite3|node_gyp_bins|gyp ERR|failed to prepare better-sqlite3/i.test(text)) return 'nativeBinding';
  if (/Failed to install OpenChamber|OpenChamber installation completed but the executable is unavailable/i.test(text)) {
    return 'openchamberInstall';
  }
  if (/Failed to install OpenCode|OpenCode CLI/i.test(text)) return 'opencodeInstall';
  if (/failed to become reachable|Managed OpenChamber server failed/i.test(text)) return 'serverStart';
  if (/Permission denied|Authentication failed|publickey|keyboard-interactive/i.test(text)) return 'sshAuth';
  if (/Could not resolve hostname|Connection refused|Connection timed out|ControlMaster connection timed out|SSH master process exited|Network is unreachable/i.test(text)) {
    return 'sshUnreachable';
  }
  if (/Timed out waiting for SSH|Timed out waiting for forwarded/i.test(text)) return 'timeout';
  return 'unknown';
};

export const resolveManagedSshBootstrapErrorCode = (
  errorCode: string | null | undefined,
  detail?: string | null,
): ManagedSshBootstrapErrorCode => {
  if (isManagedSshBootstrapErrorCode(errorCode)) return errorCode;
  return classifyManagedSshBootstrapError(detail);
};

export const sshBootstrapErrorTitleKey = (code: ManagedSshBootstrapErrorCode): I18nKey => {
  switch (code) {
    case 'nodeRuntimeMissing':
      return 'desktopHostSwitcher.sshError.nodeRuntimeMissing.title';
    case 'packageManagerMissing':
      return 'desktopHostSwitcher.sshError.packageManagerMissing.title';
    case 'nativeBinding':
      return 'desktopHostSwitcher.sshError.nativeBinding.title';
    case 'openchamberInstall':
      return 'desktopHostSwitcher.sshError.openchamberInstall.title';
    case 'opencodeInstall':
      return 'desktopHostSwitcher.sshError.opencodeInstall.title';
    case 'serverStart':
      return 'desktopHostSwitcher.sshError.serverStart.title';
    case 'sshAuth':
      return 'desktopHostSwitcher.sshError.sshAuth.title';
    case 'sshUnreachable':
      return 'desktopHostSwitcher.sshError.sshUnreachable.title';
    case 'timeout':
      return 'desktopHostSwitcher.sshError.timeout.title';
    default:
      return 'desktopHostSwitcher.sshError.unknown.title';
  }
};

export const sshBootstrapErrorGuidanceKey = (code: ManagedSshBootstrapErrorCode): I18nKey => {
  switch (code) {
    case 'nodeRuntimeMissing':
      return 'desktopHostSwitcher.sshError.nodeRuntimeMissing.guidance';
    case 'packageManagerMissing':
      return 'desktopHostSwitcher.sshError.packageManagerMissing.guidance';
    case 'nativeBinding':
      return 'desktopHostSwitcher.sshError.nativeBinding.guidance';
    case 'openchamberInstall':
      return 'desktopHostSwitcher.sshError.openchamberInstall.guidance';
    case 'opencodeInstall':
      return 'desktopHostSwitcher.sshError.opencodeInstall.guidance';
    case 'serverStart':
      return 'desktopHostSwitcher.sshError.serverStart.guidance';
    case 'sshAuth':
      return 'desktopHostSwitcher.sshError.sshAuth.guidance';
    case 'sshUnreachable':
      return 'desktopHostSwitcher.sshError.sshUnreachable.guidance';
    case 'timeout':
      return 'desktopHostSwitcher.sshError.timeout.guidance';
    default:
      return 'desktopHostSwitcher.sshError.unknown.guidance';
  }
};
