/**
 * Desktop packaging profiles.
 *
 * Default / CI / release: OPENCHAMBER_DESKTOP_PROFILE unset or "release"
 * Local side-by-side QA: OPENCHAMBER_DESKTOP_PROFILE=preview
 *
 * Preview is intentionally opt-in so normal electron-builder / GitHub release
 * flows keep production appId, productName, icons, and dist/ output.
 */

export const DESKTOP_PROFILE_ENV = 'OPENCHAMBER_DESKTOP_PROFILE';

/** @typedef {'release' | 'preview'} DesktopProfileId */

/**
 * @typedef {object} DesktopProfile
 * @property {DesktopProfileId} id
 * @property {string} appId
 * @property {string} productName
 * @property {string} appUserModelId
 * @property {string} userDataDirName
 * @property {string} linuxDesktopName
 * @property {string} linuxExecutableName
 * @property {string} outputDir
 * @property {{ mac: string, win: string, linux: string, packagedPng: string, packagedIco: string }} icons
 */

/** @type {Readonly<Record<DesktopProfileId, DesktopProfile>>} */
export const DESKTOP_PROFILES = Object.freeze({
  release: Object.freeze({
    id: 'release',
    appId: 'dev.openchamber.desktop',
    productName: 'OpenChamber',
    appUserModelId: 'dev.openchamber.desktop',
    userDataDirName: 'OpenChamber',
    linuxDesktopName: 'openchamber.desktop',
    linuxExecutableName: 'openchamber',
    outputDir: 'dist',
    icons: Object.freeze({
      mac: 'resources/icons/icon.icns',
      win: 'resources/icons/icon.ico',
      linux: 'resources/icons/icon.png',
      packagedPng: 'resources/icons/icon.png',
      packagedIco: 'resources/icons/icon.ico',
    }),
  }),
  preview: Object.freeze({
    id: 'preview',
    appId: 'dev.openchamber.desktop.preview',
    productName: 'OpenChamber Preview',
    appUserModelId: 'dev.openchamber.desktop.preview',
    userDataDirName: 'OpenChamber Preview',
    linuxDesktopName: 'openchamber-preview.desktop',
    linuxExecutableName: 'openchamber-preview',
    outputDir: 'dist-preview',
    icons: Object.freeze({
      mac: 'resources/icons/preview-icon.icns',
      win: 'resources/icons/preview-icon.ico',
      linux: 'resources/icons/preview-icon.png',
      packagedPng: 'resources/icons/preview-icon.png',
      packagedIco: 'resources/icons/preview-icon.ico',
    }),
  }),
});

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [environment]
 * @returns {DesktopProfileId}
 */
export const normalizeDesktopProfileId = (environment = process.env) => {
  const raw = String(environment[DESKTOP_PROFILE_ENV] || 'release').trim().toLowerCase();
  if (raw === '' || raw === 'release' || raw === 'default' || raw === 'production') return 'release';
  // Accept historical aliases used during early assistant QA builds.
  if (raw === 'preview' || raw === 'assistant-preview' || raw === 'assistant_preview') return 'preview';
  throw new Error(
    `Unknown ${DESKTOP_PROFILE_ENV}=${JSON.stringify(environment[DESKTOP_PROFILE_ENV])}. Use "release" or "preview".`,
  );
};

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [environment]
 * @returns {DesktopProfile}
 */
export const resolveDesktopProfile = (environment = process.env) => DESKTOP_PROFILES[normalizeDesktopProfileId(environment)];

/**
 * Runtime detection for a packaged app when the build-time define is missing.
 * Prefer product name / executable path so preview never collides with release locks.
 *
 * @param {{ env?: NodeJS.ProcessEnv, productName?: string, execPath?: string, buildTimeProfile?: string | null }} [input]
 * @returns {DesktopProfileId}
 */
export const detectRuntimeDesktopProfileId = ({
  env = process.env,
  productName = '',
  execPath = '',
  buildTimeProfile = null,
} = {}) => {
  if (buildTimeProfile === 'preview' || buildTimeProfile === 'release') return buildTimeProfile;
  // Only honor an *explicit* env profile. An unset env must not mask
  // packaged identity heuristics (product name / exec path).
  const raw = String(env?.[DESKTOP_PROFILE_ENV] ?? '').trim();
  if (raw) {
    try {
      return normalizeDesktopProfileId(env);
    } catch {
      // Fall through to packaged identity heuristics.
    }
  }
  const haystack = `${productName}\n${execPath}`;
  if (/openchamber[\s-]*preview/i.test(haystack) || /assistant[\s-]*preview/i.test(haystack)) {
    return 'preview';
  }
  return 'release';
};

/**
 * electron-builder CLI `-c.*` overrides merged on top of package.json "build".
 * Release returns an empty list so CI stays on the committed production config only.
 *
 * Field-level `-c` flags are used instead of a replacement config file so we never
 * accidentally drop production files/extraResources/protocols for release packaging.
 *
 * @param {DesktopProfile} profile
 * @returns {string[]}
 */
export const electronBuilderArgsForProfile = (profile) => {
  if (profile.id === 'release') return [];
  return [
    `-c.appId=${profile.appId}`,
    `-c.productName=${profile.productName}`,
    `-c.directories.output=${profile.outputDir}`,
    `-c.mac.icon=${profile.icons.mac}`,
    // Avoid the production AppIcon Assets.car name; preview uses the badged icns.
    `-c.mac.extendInfo.CFBundleDisplayName=${profile.productName}`,
    `-c.win.icon=${profile.icons.win}`,
    `-c.linux.icon=${profile.icons.linux}`,
    `-c.linux.executableName=${profile.linuxExecutableName}`,
    `-c.linux.desktop.entry.Name=${profile.productName}`,
    `-c.linux.desktop.entry.Comment=Preview desktop runtime for OpenChamber`,
    `-c.linux.desktop.entry.Icon=${profile.linuxExecutableName}`,
    `-c.linux.desktop.entry.StartupWMClass=${profile.linuxExecutableName}`,
    `-c.nsis.installerIcon=${profile.icons.win}`,
    `-c.nsis.uninstallerIcon=${profile.icons.win}`,
    `-c.nsis.installerHeaderIcon=${profile.icons.win}`,
  ];
};

/**
 * @deprecated Use electronBuilderArgsForProfile. Kept for call-site clarity in tests.
 * @param {DesktopProfile} profile
 */
export const electronBuilderConfigForProfile = (profile) => {
  if (profile.id === 'release') return null;
  return {
    appId: profile.appId,
    productName: profile.productName,
    directories: { output: profile.outputDir },
    mac: { icon: profile.icons.mac },
    win: { icon: profile.icons.win },
    linux: {
      icon: profile.icons.linux,
      executableName: profile.linuxExecutableName,
    },
  };
};
