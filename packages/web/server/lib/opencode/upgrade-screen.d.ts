export const REQUIRED_OPENCODE_VERSION: string;

export type UpgradeScreen = {
  state: 'unavailable' | 'compatible' | 'incompatible';
  version: string | null;
  installation: 'managed' | 'external' | 'bundled';
  minimumVersion: string;
  targetVersion: string;
  canInstall: boolean;
  guidance: string | null;
};

export function describeUpgradeScreen(input?: {
  version?: string | null;
  installation?: 'managed' | 'external' | 'bundled';
  platformCanInstall?: boolean;
  guidance?: string | null;
  pin?: string;
}): UpgradeScreen;

export function platformSupportsUpgradeScreenInstall(platform?: string, arch?: string): boolean;

export function installRequiredOpenCode(deps: object): Promise<{
  ok: true;
  upgraded: true;
  version: string;
  targetVersion: string;
  error: null;
  errorCode: null;
}>;
