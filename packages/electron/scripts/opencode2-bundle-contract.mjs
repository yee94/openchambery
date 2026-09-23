import {
  PINNED_OPENCODE2_VERSION,
  npmPackageForOpenCode2,
  openCode2BinaryName,
  parseOpenCode2VersionOutput,
} from '../../web/server/lib/opencode/opencode2-pin.js';

export { PINNED_OPENCODE2_VERSION, npmPackageForOpenCode2, parseOpenCode2VersionOutput };

export const BUNDLED_OPENCODE2_DIR = 'opencode-cli';

export const bundledOpenCode2BinaryName = (platform = process.platform) => openCode2BinaryName(platform);

export const artifactForOpenCode2 = (platform, targetArchitecture) => {
  const arch = targetArchitecture?.opencode ?? targetArchitecture;
  if (platform === 'darwin') {
    if (arch === 'arm64') return { name: 'opencode-darwin-arm64.zip', binary: 'opencode' };
    if (arch === 'x64') return { name: 'opencode-darwin-x64-baseline.zip', binary: 'opencode' };
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return { name: 'opencode-windows-arm64.zip', binary: 'opencode.exe' };
    if (arch === 'x64') return { name: 'opencode-windows-x64-baseline.zip', binary: 'opencode.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { name: 'opencode-linux-arm64.tar.gz', binary: 'opencode' };
    if (arch === 'x64') return { name: 'opencode-linux-x64-baseline.tar.gz', binary: 'opencode' };
  }
  throw new Error(`No opencode2 CLI artifact mapping for ${platform}/${arch}`);
};
