/**
 * Expo config plugin — Track 9 side-by-side debug identity + embedded JS.
 *
 * Keeps android.package as com.yee94.openchamber (release identity) and adds
 * applicationIdSuffix ".debug" on the debug buildType so the installable id is
 * com.yee94.openchamber.debug — same as Cap/Flutter debug, beside Cap release.
 * Launcher label stays the Expo app name (OpenChamber Expo).
 *
 * Also forces the debug variant to embed the Hermes JS bundle (dev=false) so a
 * sideloaded prerelease APK launches offline without Metro. Default RN behavior
 * skips bundling for debuggableVariants=["debug"], which left the published
 * assembleDebug APK stuck forever on the Expo splash wireframe.
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

/** Active gradle assignment — empty list means every variant (incl. debug) embeds JS. */
const EMBED_JS_LINE = '    debuggableVariants = []';

/**
 * Inject Cap-style debug side-by-side fields into buildTypes.debug { ... }.
 * @param {string} buildGradle
 * @returns {string}
 */
function injectDebugIdentity(buildGradle) {
  if (
    buildGradle.includes('applicationIdSuffix ".debug"') ||
    buildGradle.includes("applicationIdSuffix '.debug'")
  ) {
    return buildGradle;
  }

  // Prefer an existing debug { ... } block inside buildTypes.
  const debugBlock = /((?:buildTypes\s*\{[\s\S]*?)(\bdebug\s*\{))/;
  if (debugBlock.test(buildGradle)) {
    return buildGradle.replace(
      debugBlock,
      `$1\n${DEBUG_SUFFIX_LINE}\n${DEBUG_VERSION_SUFFIX_LINE}\n${DEBUG_APP_NAME_LINE}`,
    );
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

/**
 * Force debug (and all) variants to run createBundle*JsAndAssets so the APK
 * embeds Hermes bytecode with export:embed / devEnabled=false.
 * @param {string} buildGradle
 * @returns {string}
 */
function injectEmbedJsInDebug(buildGradle) {
  // Already active empty list (idempotent). Ignore commented lines.
  if (/^\s*debuggableVariants\s*=\s*\[\s*\]\s*$/m.test(buildGradle)) {
    return buildGradle;
  }

  // Replace any active non-empty assignment.
  if (/^\s*debuggableVariants\s*=/m.test(buildGradle)) {
    return buildGradle.replace(/^\s*debuggableVariants\s*=.*$/m, EMBED_JS_LINE);
  }

  // Uncomment Expo template line under /* Variants */.
  if (/^\s*\/\/\s*debuggableVariants\s*=/m.test(buildGradle)) {
    return buildGradle.replace(/^\s*\/\/\s*debuggableVariants\s*=.*$/m, EMBED_JS_LINE);
  }

  // Inject inside react { ... } after the opening brace.
  const reactOpen = /(react\s*\{)/;
  if (reactOpen.test(buildGradle)) {
    return buildGradle.replace(
      reactOpen,
      `$1\n    // Track 9: embed JS in debug APK (sideload without Metro)\n${EMBED_JS_LINE}`,
    );
  }

  WarningAggregator.addWarningAndroid(
    'withAndroidDebugSideBySide',
    'Could not find react { } / debuggableVariants in app/build.gradle; debug APK may still require Metro',
  );
  return buildGradle;
}

/**
 * @param {string} buildGradle
 * @returns {string}
 */
function injectDebugSideBySide(buildGradle) {
  return injectEmbedJsInDebug(injectDebugIdentity(buildGradle));
}

const withAndroidDebugSideBySide = (config) => {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      WarningAggregator.addWarningAndroid(
        'withAndroidDebugSideBySide',
        'app/build.gradle is not groovy; skip debug suffix / embed-JS injection',
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
  '1.19.7-beta.7-embed',
);

module.exports.injectDebugSideBySide = injectDebugSideBySide;
module.exports.injectDebugIdentity = injectDebugIdentity;
module.exports.injectEmbedJsInDebug = injectEmbedJsInDebug;
