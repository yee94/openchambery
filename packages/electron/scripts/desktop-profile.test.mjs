import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  DESKTOP_PROFILES,
  detectRuntimeDesktopProfileId,
  electronBuilderArgsForProfile,
  electronBuilderConfigForProfile,
  normalizeDesktopProfileId,
  resolveDesktopProfile,
} from './desktop-profile.mjs';

describe('desktop-profile', () => {
  it('defaults to release when the env is unset', () => {
    assert.equal(normalizeDesktopProfileId({}), 'release');
    assert.equal(resolveDesktopProfile({}).id, 'release');
    assert.deepEqual(electronBuilderArgsForProfile(DESKTOP_PROFILES.release), []);
    assert.equal(electronBuilderConfigForProfile(DESKTOP_PROFILES.release), null);
  });

  it('accepts preview and historical assistant-preview aliases', () => {
    assert.equal(normalizeDesktopProfileId({ YURI_DESKTOP_PROFILE: 'preview' }), 'preview');
    assert.equal(normalizeDesktopProfileId({ YURI_DESKTOP_PROFILE: 'assistant-preview' }), 'preview');
    assert.equal(resolveDesktopProfile({ YURI_DESKTOP_PROFILE: 'PREVIEW' }).productName, 'Yuri Preview');
  });

  it('rejects unknown profiles instead of silently falling back', () => {
    assert.throws(
      () => normalizeDesktopProfileId({ YURI_DESKTOP_PROFILE: 'nightly' }),
      /Unknown YURI_DESKTOP_PROFILE/,
    );
  });

  it('keeps preview packaging identity isolated from release', () => {
    const preview = DESKTOP_PROFILES.preview;
    const release = DESKTOP_PROFILES.release;
    assert.notEqual(preview.appId, release.appId);
    assert.notEqual(preview.productName, release.productName);
    assert.notEqual(preview.userDataDirName, release.userDataDirName);
    assert.notEqual(preview.outputDir, release.outputDir);
    assert.match(preview.icons.mac, /preview-icon\.icns$/);
  });

  it('emits electron-builder overrides only for preview', () => {
    const args = electronBuilderArgsForProfile(DESKTOP_PROFILES.preview);
    assert.ok(args.some((arg) => arg.includes('dev.yuri.desktop.preview')));
    assert.ok(args.some((arg) => arg.includes('Yuri Preview')));
    assert.ok(args.some((arg) => arg.includes('dist-preview')));
    assert.ok(args.some((arg) => arg.includes('preview-icon.icns')));
    assert.ok(args.some((arg) => arg.includes('yuri-preview')));
  });

  it('detects packaged preview identity from product name or exec path', () => {
    assert.equal(detectRuntimeDesktopProfileId({
      env: {},
      productName: 'Yuri Preview',
      execPath: '/Apps/Yuri.app/Contents/MacOS/Yuri',
    }), 'preview');
    assert.equal(detectRuntimeDesktopProfileId({
      env: {},
      productName: 'Yuri',
      execPath: '/tmp/Yuri Preview.app/Contents/MacOS/Yuri Preview',
    }), 'preview');
    assert.equal(detectRuntimeDesktopProfileId({
      env: {},
      productName: 'Yuri',
      execPath: '/Applications/Yuri.app/Contents/MacOS/Yuri',
    }), 'release');
    assert.equal(detectRuntimeDesktopProfileId({ buildTimeProfile: 'preview' }), 'preview');
  });
});
