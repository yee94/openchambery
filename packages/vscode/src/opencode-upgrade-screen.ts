import { installPinnedOpenCode2Cli, readOpenCode2BinaryVersion } from '../../web/server/lib/opencode/ensure-cli.js';
import {
  describeUpgradeScreen,
  installRequiredOpenCode,
  platformSupportsUpgradeScreenInstall,
} from '../../web/server/lib/opencode/upgrade-screen.js';
import type { OpenCodeManager } from './opencode';

type DebugInfo = ReturnType<OpenCodeManager['getDebugInfo']>;

const externalGuidance = 'This is an external OpenCode serve. Upgrade it yourself; OpenChamber will not replace that process.';

export const compatibilityFromDebugInfo = (
  info: Partial<DebugInfo> | null | undefined,
  options: { platformCanInstall?: boolean; readBinaryVersion?: (binaryPath: string) => string } = {},
) => {
  const installation = info?.mode === 'external' ? 'external' : 'managed';
  const cliVersion = info?.cliPath && options.readBinaryVersion
    ? options.readBinaryVersion(info.cliPath)
    : null;
  return describeUpgradeScreen({
    version: info?.version || cliVersion || null,
    installation,
    platformCanInstall: options.platformCanInstall ?? platformSupportsUpgradeScreenInstall(),
    guidance: installation === 'external' ? externalGuidance : null,
  });
};

export const readManagedUpgradeScreen = (manager?: OpenCodeManager) => (
  compatibilityFromDebugInfo(manager?.getDebugInfo(), {
    readBinaryVersion: (binaryPath) => readOpenCode2BinaryVersion(binaryPath),
  })
);

export const installManagedRequiredOpenCode = async (
  manager: OpenCodeManager | undefined,
  deps: {
    persistBinary: (binaryPath: string) => Promise<void>;
    install?: (options: { version: string }) => Promise<string>;
    readBinaryVersion?: (binaryPath: string) => string;
    platformCanInstall?: boolean;
  },
) => {
  if (!manager) {
    const error = new Error('OpenCode manager unavailable');
    (error as Error & { status?: number; code?: string }).status = 503;
    (error as Error & { code?: string }).code = 'UPGRADE_SCREEN_UNAVAILABLE';
    throw error;
  }
  const readBinaryVersion = deps.readBinaryVersion ?? ((binaryPath: string) => readOpenCode2BinaryVersion(binaryPath));
  return installRequiredOpenCode({
    resolveOwnership: async () => {
      const mode = manager.getDebugInfo().mode;
      return {
        ownership: mode === 'external' ? 'external-serve' : 'managed',
        guidance: mode === 'external' ? externalGuidance : null,
      };
    },
    readServeVersion: async () => manager.getDebugInfo().version,
    readCliVersion: () => {
      const cliPath = manager.getDebugInfo().cliPath;
      return cliPath ? readBinaryVersion(cliPath) : null;
    },
    platformCanInstall: deps.platformCanInstall,
    install: deps.install ?? ((options: { version: string }) => installPinnedOpenCode2Cli(options)),
    readBinaryVersion,
    persistBinary: deps.persistBinary,
    forceBinary: (binaryPath: string) => {
      process.env.OPENCODE_BINARY = binaryPath;
    },
    restart: async () => {
      await manager.restart();
    },
    isSharedService: () => false,
  });
};
