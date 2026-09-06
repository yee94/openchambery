import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { injectDebugSideBySide } = require(
  path.resolve(__dirname, '../../plugins/withAndroidDebugSideBySide.js'),
) as { injectDebugSideBySide: (gradle: string) => string };

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
`;
    const out = injectDebugSideBySide(input);
    expect(out).toContain('applicationIdSuffix ".debug"');
    expect(out).toContain('versionNameSuffix "-debug"');
    expect(out).toContain('resValue "string", "app_name", "OpenChamber Expo"');
    expect(out.indexOf('applicationIdSuffix')).toBeGreaterThan(out.indexOf('debug {'));
    expect(out.indexOf('applicationIdSuffix')).toBeLessThan(out.indexOf('release {'));
  });

  it('is idempotent when suffix already present', () => {
    const once = injectDebugSideBySide(`
buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
}
`);
    const twice = injectDebugSideBySide(once);
    expect(twice).toBe(once);
    expect(twice.split('applicationIdSuffix ".debug"').length - 1).toBe(1);
  });
});
