/**
 * Expo config plugin — Track 9 side-by-side debug identity.
 *
 * Keeps android.package as com.yee94.openchamber (release identity) and adds
 * applicationIdSuffix ".debug" on the debug buildType so the installable id is
 * com.yee94.openchamber.debug — same as Cap/Flutter debug, beside Cap release.
 * Launcher label stays the Expo app name (OpenChamber Expo).
 *
 * Does not invent a second Firebase project; googleServicesFile points at Cap's
 * google-services.json which already lists the .debug client.
 */
const {
  withAppBuildGradle,
  createRunOncePlugin,
  WarningAggregator,
} = require('expo/config-plugins');

const DEBUG_SUFFIX_LINE = '            applicationIdSuffix ".debug"';
const DEBUG_VERSION_SUFFIX_LINE = '            versionNameSuffix "-debug"';
const DEBUG_APP_NAME_LINE =
  '            resValue "string", "app_name", "OpenChamber Expo"';

/**
 * Inject Cap-style debug side-by-side fields into buildTypes.debug { ... }.
 * @param {string} buildGradle
 * @returns {string}
 */
function injectDebugSideBySide(buildGradle) {
  if (buildGradle.includes('applicationIdSuffix ".debug"') || buildGradle.includes("applicationIdSuffix '.debug'")) {
    return buildGradle;
  }

  // Prefer an existing debug { ... } block inside buildTypes.
  const debugBlock = /((?:buildTypes\s*\{[\s\S]*?)(\bdebug\s*\{))/;
  if (debugBlock.test(buildGradle)) {
    return buildGradle.replace(debugBlock, `$1\n${DEBUG_SUFFIX_LINE}\n${DEBUG_VERSION_SUFFIX_LINE}\n${DEBUG_APP_NAME_LINE}`);
  }

  // Fallback: open a debug block before the closing of buildTypes.
  const buildTypesClose = /(buildTypes\s*\{)([\s\S]*?)(\n\s*\})/;
  if (buildTypesClose.test(buildGradle)) {
    return buildGradle.replace(
      buildTypesClose,
      `$1$2\n        debug {\n${DEBUG_SUFFIX_LINE}\n${DEBUG_VERSION_SUFFIX_LINE}\n${DEBUG_APP_NAME_LINE}\n        }$3`,
    );
  }

  WarningAggregator.addWarningAndroid(
    'withAndroidDebugSideBySide',
    'Could not find buildTypes/debug in app/build.gradle; applicationIdSuffix not applied',
  );
  return buildGradle;
}

const withAndroidDebugSideBySide = (config) => {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      WarningAggregator.addWarningAndroid(
        'withAndroidDebugSideBySide',
        'app/build.gradle is not groovy; skip debug suffix injection',
      );
      return cfg;
    }
    cfg.modResults.contents = injectDebugSideBySide(cfg.modResults.contents);
    return cfg;
  });
};

module.exports = createRunOncePlugin(
  withAndroidDebugSideBySide,
  'withAndroidDebugSideBySide',
  '1.19.7-beta.7',
);

module.exports.injectDebugSideBySide = injectDebugSideBySide;
