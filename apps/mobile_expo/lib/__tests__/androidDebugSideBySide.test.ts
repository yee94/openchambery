import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  injectDebugSideBySide,
  injectEmbedJsInDebug,
} = require(
  path.resolve(__dirname, '../../plugins/withAndroidDebugSideBySide.js'),
) as {
  injectDebugSideBySide: (gradle: string) => string;
  injectEmbedJsInDebug: (gradle: string) => string;
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

describe('injectDebugSideBySide', () => {
  it('adds applicationIdSuffix into an existing debug buildType', () => {
    const input = `
android {
    defaultConfig {
        applicationId 'com.yee94.openchamber'
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            minifyEnabled false
        }
    }
}
${EXPO_REACT_BLOCK}
`;
    const out = injectDebugSideBySide(input);
    expect(out).toContain('applicationIdSuffix ".debug"');
    expect(out).toContain('versionNameSuffix "-debug"');
    expect(out).toContain('resValue "string", "app_name", "OpenChamber Expo"');
    expect(out.indexOf('applicationIdSuffix')).toBeGreaterThan(out.indexOf('debug {'));
    expect(out.indexOf('applicationIdSuffix')).toBeLessThan(out.indexOf('release {'));
    expect(out).toMatch(/^\s*debuggableVariants\s*=\s*\[\s*\]\s*$/m);
    expect(out).not.toMatch(/^\s*\/\/\s*debuggableVariants/m);
  });

  it('is idempotent when suffix and embed already present', () => {
    const once = injectDebugSideBySide(`
buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
}
${EXPO_REACT_BLOCK}
`);
    const twice = injectDebugSideBySide(once);
    expect(twice).toBe(once);
    expect(twice.split('applicationIdSuffix ".debug"').length - 1).toBe(1);
    expect(twice.split('debuggableVariants = []').length - 1).toBe(1);
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
