import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  injectDebugSideBySide,
  injectEmbedJsInDebug,
  injectReleaseSideloadIdentity,
} = require(
  path.resolve(__dirname, '../../plugins/withAndroidDebugSideBySide.js'),
) as {
  injectDebugSideBySide: (gradle: string) => string;
  injectEmbedJsInDebug: (gradle: string) => string;
  injectReleaseSideloadIdentity: (gradle: string) => string;
};

const EXPO_REACT_BLOCK = `
react {
    entryFile = file("index.js")
    bundleCommand = "export:embed"

    /* Variants */
    //   The list of variants to that are debuggable. For those we're going to
    //   skip the bundling of the JS bundle and the assets. By default is just 'debug'.
    //   If you add flavors like lite, prod, etc. you'll have to list your debuggableVariants.
    // debuggableVariants = ["liteDebug", "prodDebug"]

    autolinkLibrariesWithApp()
}
`;

const EXPO_BUILD_TYPES = `
android {
    defaultConfig {
        applicationId 'com.yee94.openchamber'
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

describe('injectDebugSideBySide', () => {
  it('adds applicationIdSuffix into debug and release buildTypes', () => {
    const input = `
${EXPO_BUILD_TYPES}
${EXPO_REACT_BLOCK}
`;
    const out = injectDebugSideBySide(input);
    expect(out).toContain('applicationIdSuffix ".debug"');
    expect(out).toContain('versionNameSuffix "-debug"');
    expect(out).toContain('resValue "string", "app_name", "OpenChamber Expo"');
    // Both buildTypes get the suffix (debug for local; release for sideload).
    const debugIdx = out.indexOf('debug {');
    const releaseIdx = out.indexOf('release {');
    expect(debugIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(debugIdx);
    const debugSlice = out.slice(debugIdx, releaseIdx);
    const releaseSlice = out.slice(releaseIdx, out.indexOf('}\n}', releaseIdx) + 1 || undefined);
    expect(debugSlice).toContain('applicationIdSuffix ".debug"');
    expect(out.slice(releaseIdx)).toContain('applicationIdSuffix ".debug"');
    expect(out.slice(releaseIdx)).toContain('signingConfig signingConfigs.debug');
    expect(out).toMatch(/^\s*debuggableVariants\s*=\s*\[\s*\]\s*$/m);
    expect(out).not.toMatch(/^\s*\/\/\s*debuggableVariants/m);
  });

  it('is idempotent when suffix and embed already present on both types', () => {
    const once = injectDebugSideBySide(`
${EXPO_BUILD_TYPES}
${EXPO_REACT_BLOCK}
`);
    const twice = injectDebugSideBySide(once);
    expect(twice).toBe(once);
    expect(twice.split('applicationIdSuffix ".debug"').length - 1).toBe(2);
    expect(twice.split('debuggableVariants = []').length - 1).toBe(1);
  });
});

describe('injectReleaseSideloadIdentity', () => {
  it('forces release to use debug keystore + .debug id', () => {
    const input = `
buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
        }
}
`;
    const out = injectReleaseSideloadIdentity(input);
    expect(out).toContain('applicationIdSuffix ".debug"');
    expect(out).toContain('signingConfig signingConfigs.debug');
    expect(out).not.toContain('signingConfig signingConfigs.release');
  });
});

describe('injectEmbedJsInDebug', () => {
  it('uncomments Expo template debuggableVariants into empty list', () => {
    const out = injectEmbedJsInDebug(EXPO_REACT_BLOCK);
    expect(out).toMatch(/^\s*debuggableVariants\s*=\s*\[\s*\]\s*$/m);
    expect(out).not.toContain('// debuggableVariants');
  });

  it('replaces a non-empty active debuggableVariants list', () => {
    const input = `
react {
    debuggableVariants = ["debug", "debugOptimized"]
    bundleCommand = "export:embed"
}
`;
    const out = injectEmbedJsInDebug(input);
    expect(out).toMatch(/^\s*debuggableVariants\s*=\s*\[\s*\]\s*$/m);
    expect(out).not.toContain('["debug"');
  });

  it('injects into react {} when Variants comment is missing', () => {
    const input = `
react {
    bundleCommand = "export:embed"
    autolinkLibrariesWithApp()
}
`;
    const out = injectEmbedJsInDebug(input);
    expect(out).toContain('debuggableVariants = []');
    expect(out.indexOf('debuggableVariants')).toBeGreaterThan(out.indexOf('react {'));
  });
});

describe('signingConfigs isolation', () => {
  it('does not inject applicationIdSuffix into signingConfigs.debug', () => {
    const input = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
${EXPO_REACT_BLOCK}
`;
    const out = injectDebugSideBySide(input);
    const signingSlice = out.slice(
      out.indexOf('signingConfigs'),
      out.indexOf('buildTypes'),
    );
    expect(signingSlice).not.toContain('applicationIdSuffix');
    expect(signingSlice).not.toContain('versionNameSuffix');
    const debugBt = out.slice(out.indexOf('buildTypes'));
    expect(debugBt).toContain('applicationIdSuffix ".debug"');
    expect(out.split('applicationIdSuffix ".debug"').length - 1).toBe(2);
  });
});


describe('withAndroidCleartextTraffic.ensureCleartext', () => {
  it('sets android:usesCleartextTraffic on application', () => {
    const { ensureCleartext } = require(
      path.resolve(__dirname, '../../plugins/withAndroidCleartextTraffic.js'),
    ) as {
      ensureCleartext: (manifest: {
        manifest: { application?: Array<{ $?: Record<string, string> }> };
      }) => {
        manifest: { application?: Array<{ $?: Record<string, string> }> };
      };
    };
    const input = { manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] } };
    const out = ensureCleartext(input);
    expect(out.manifest.application?.[0]?.$?.['android:usesCleartextTraffic']).toBe('true');
    const twice = ensureCleartext(out);
    expect(twice.manifest.application?.[0]?.$?.['android:usesCleartextTraffic']).toBe('true');
  });
});
