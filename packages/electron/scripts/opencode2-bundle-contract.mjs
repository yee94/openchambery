import { PINNED_OPENCODE2_VERSION } from '../../web/server/lib/opencode/opencode2-pin.js';

export { PINNED_OPENCODE2_VERSION };

export const BUNDLED_OPENCODE2_DIR = 'opencode-cli';

export const bundledOpenCode2BinaryName = (platform = process.platform) => (
  platform === 'win32' ? 'opencode2.exe' : 'opencode2'
);

/**
 * opencode2 v2 发布在 npm 平台包（@opencode/cli-<os>-<arch>[-baseline]），
 * 上游不再为 v2 提供 GitHub release 二进制。
 */
export const npmPackageForOpenCode2 = (platform, targetArchitecture) => {
  const arch = targetArchitecture?.opencode ?? targetArchitecture;
  const os = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[platform];
  if (!os) throw new Error(`No opencode2 npm package mapping for platform ${platform}`);
  // x64 统一使用 baseline 变体，与旧 GitHub artifact 的 *-x64-baseline 对齐。
  const suffix = arch === 'x64' ? '-baseline' : '';
  return `@opencode/cli-${os}-${arch}${suffix}`;
};

/**
 * 解析 opencode2 `--version` 输出。
 * v2 输出形如 `opencode2 v2.0.12`（首 token 是名字），
 * 1.x 输出形如 `1.18.18`（首 token 即版本）。
 */
export const parseOpenCode2VersionOutput = (stdout) => {
  const tokens = String(stdout || '').trim().split(/\s+/);
  const versionToken = tokens.find((token) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(token));
  if (!versionToken) return '';
  return versionToken.replace(/^v/, '');
};

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
