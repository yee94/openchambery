export function readOpenCode2BinaryVersion(binaryPath: string): string;

export function installPinnedOpenCode2Cli(options?: {
  version?: string;
  platform?: string;
  arch?: string;
  dataDir?: string;
}): Promise<string>;
