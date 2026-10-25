import type { I18nKey } from '@/lib/i18n';

export const MANAGED_SSH_BOOTSTRAP_ERROR_CODES = [
  'nodeRuntimeMissing',
  'packageManagerMissing',
  'nativeBinding',
  'yuriCliMissing',
  'yuriRegistry',
  'yuriInstall',
  'yuriCliIncompatible',
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
  if (/Yuri installation completed but the executable is unavailable/i.test(text)) {
    return 'yuriCliMissing';
  }
  if (/could not reach the npm registry|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|CERT_HAS_EXPIRED|UNABLE_TO_GET_ISSUER_CERT|self-signed certificate|registry\.npmjs|npm error code E404|npm ERR! code E404|getaddrinfo/i.test(text)) {
    return 'yuriRegistry';
  }
  if (/Failed to install Yuri/i.test(text)) {
    return 'yuriInstall';
  }
  if (/Unknown option:\s*--relay-host|does not advertise --relay-host|does not support --relay-host/i.test(text)) {
    return 'yuriCliIncompatible';
  }
  if (/Unknown option:/i.test(text)) return 'yuriCliIncompatible';
  if (/Failed to install OpenCode|OpenCode CLI/i.test(text)) return 'opencodeInstall';
  if (/failed to become reachable|Managed Yuri server failed/i.test(text)) return 'serverStart';
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
    case 'yuriCliMissing':
      return 'desktopHostSwitcher.sshError.yuriCliMissing.title';
    case 'yuriRegistry':
      return 'desktopHostSwitcher.sshError.yuriRegistry.title';
    case 'yuriInstall':
      return 'desktopHostSwitcher.sshError.yuriInstall.title';
    case 'yuriCliIncompatible':
      return 'desktopHostSwitcher.sshError.yuriCliIncompatible.title';
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
    case 'yuriCliMissing':
      return 'desktopHostSwitcher.sshError.yuriCliMissing.guidance';
    case 'yuriRegistry':
      return 'desktopHostSwitcher.sshError.yuriRegistry.guidance';
    case 'yuriInstall':
      return 'desktopHostSwitcher.sshError.yuriInstall.guidance';
    case 'yuriCliIncompatible':
      return 'desktopHostSwitcher.sshError.yuriCliIncompatible.guidance';
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

export const sshBootstrapErrorShowsRawDetail = (code: ManagedSshBootstrapErrorCode): boolean => {
  return code === 'unknown' || code === 'yuriCliIncompatible';
};

export const formatSshBootstrapErrorDescription = (
  guidance: string,
  code: ManagedSshBootstrapErrorCode,
  detail?: string | null,
): string => {
  const raw = typeof detail === 'string' ? detail.trim() : '';
  if (!sshBootstrapErrorShowsRawDetail(code) || !raw || raw === guidance) return guidance;
  return `${guidance}\n${raw}`;
};
