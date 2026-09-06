/**
 * Expo config plugin — Track 9 side-by-side debug identity + offline-capable APK.
 *
 * Keeps android.package as com.yee94.openchamber (release identity) and adds
 * applicationIdSuffix ".debug" so the installable id is com.yee94.openchamber.debug
 * — same as Cap/Flutter debug, beside Cap release. Launcher label stays the Expo
 * app name (OpenChamber Expo).
 *
 * Sideload path (preferred): assembleRelease signed with the debug keystore, with
 * the same .debug applicationIdSuffix. Release variants set BuildConfig.DEBUG /
 * ReactBuildConfig.DEBUG = false, so ReactHost useDevSupport is false and the app
 * loads assets/index.android.bundle without probing Metro. assembleDebug with
 * embedded JS can still hang or delay on Expo splash when useDevSupport stays true
 * (packager status check / infinite readTimeout on a black-holed debug_http_host).
 *
 * Also sets debuggableVariants=[] so local assembleDebug embeds Hermes too.
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
const DEBUG_SIGNING_LINE = '            signingConfig signingConfigs.debug';

/** Active gradle assignment — empty list means every variant (incl. debug) embeds JS. */
const EMBED_JS_LINE = '    debuggableVariants = []';

/**
 * Inject Cap-style side-by-side fields into an existing buildType block body.
 * @param {string} blockBody lines inside `debug { ... }` or `release { ... }`
 * @param {{ ensureSigningDebug?: boolean }} [opts]
 * @returns {string}
 */
function injectIdentityIntoBuildTypeBody(blockBody, opts = {}) {
  let body = blockBody;
  const ensure = (needle, line) => {
    if (
      body.includes(needle) ||
      (needle.includes('"') && body.includes(needle.replace(/"/g, "'")))
    ) {
      return;
    }
    body = `${line}\n${body}`;
  };
  ensure('applicationIdSuffix ".debug"', DEBUG_SUFFIX_LINE);
  ensure('versionNameSuffix "-debug"', DEBUG_VERSION_SUFFIX_LINE);
  ensure('resValue "string", "app_name", "OpenChamber Expo"', DEBUG_APP_NAME_LINE);
  if (opts.ensureSigningDebug) {
    // Prefer debug keystore for Track 9 sideload; replace any other signingConfig.
    if (/^\s*signingConfig\s+/m.test(body)) {
      body = body.replace(/^\s*signingConfig\s+.*$/m, DEBUG_SIGNING_LINE);
    } else {
      body = `${DEBUG_SIGNING_LINE}\n${body}`;
    }
  }
  return body;
}

/**
 * Replace the interior of the first matching `name { ... }` buildType, brace-aware.
 * @param {string} buildGradle
 * @param {string} typeName
 * @param {(body: string) => string} transformBody
 * @returns {{ text: string, replaced: boolean }}
 */
function rewriteBuildType(buildGradle, typeName, transformBody) {
  const re = new RegExp(`(\\b${typeName}\\s*\\{)`);
  const m = re.exec(buildGradle);
  if (!m || m.index == null) {
    return { text: buildGradle, replaced: false };
  }
  const openIdx = m.index + m[1].length - 1; // index of '{'
  let depth = 0;
  let i = openIdx;
  for (; i < buildGradle.length; i++) {
    const ch = buildGradle[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) {
    return { text: buildGradle, replaced: false };
  }
  const body = buildGradle.slice(openIdx + 1, i);
  const nextBody = transformBody(body);
  return {
    text: buildGradle.slice(0, openIdx + 1) + nextBody + buildGradle.slice(i),
    replaced: true,
  };
}

/**
 * Inject Cap-style debug side-by-side fields into buildTypes.debug { ... }.
 * @param {string} buildGradle
 * @returns {string}
 */
function injectDebugIdentity(buildGradle) {
  const rewritten = rewriteBuildType(buildGradle, 'debug', (body) =>
    injectIdentityIntoBuildTypeBody(body, { ensureSigningDebug: false }),
  );
  if (rewritten.replaced) {
    return rewritten.text;
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
 * Inject the same .debug identity + debug keystore into buildTypes.release.
 * This is the reliable Metro-less sideload path (assembleRelease).
 * @param {string} buildGradle
 * @returns {string}
 */
function injectReleaseSideloadIdentity(buildGradle) {
  const rewritten = rewriteBuildType(buildGradle, 'release', (body) =>
    injectIdentityIntoBuildTypeBody(body, { ensureSigningDebug: true }),
  );
  if (rewritten.replaced) {
    return rewritten.text;
  }

  WarningAggregator.addWarningAndroid(
    'withAndroidDebugSideBySide',
    'Could not find buildTypes/release in app/build.gradle; release sideload identity not applied',
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
  return injectEmbedJsInDebug(
    injectReleaseSideloadIdentity(injectDebugIdentity(buildGradle)),
  );
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
  '1.19.7-beta.7-release-sideload',
);

module.exports.injectDebugSideBySide = injectDebugSideBySide;
module.exports.injectDebugIdentity = injectDebugIdentity;
module.exports.injectReleaseSideloadIdentity = injectReleaseSideloadIdentity;
module.exports.injectEmbedJsInDebug = injectEmbedJsInDebug;
