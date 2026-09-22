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
    if (arch === 'arm64') return { name: 'opencode2-darwin-arm64.zip', binary: 'opencode2' };
    if (arch === 'x64') return { name: 'opencode2-darwin-x64-baseline.zip', binary: 'opencode2' };
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return { name: 'opencode2-windows-arm64.zip', binary: 'opencode2.exe' };
    if (arch === 'x64') return { name: 'opencode2-windows-x64-baseline.zip', binary: 'opencode2.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { name: 'opencode2-linux-arm64.tar.gz', binary: 'opencode2' };
    if (arch === 'x64') return { name: 'opencode2-linux-x64-baseline.tar.gz', binary: 'opencode2' };
  }
  throw new Error(`No opencode2 CLI artifact mapping for ${platform}/${arch}`);
};
