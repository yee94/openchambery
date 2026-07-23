import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
    assert.equal(normalizeDesktopProfileId({ OPENCHAMBER_DESKTOP_PROFILE: 'preview' }), 'preview');
    assert.equal(normalizeDesktopProfileId({ OPENCHAMBER_DESKTOP_PROFILE: 'assistant-preview' }), 'preview');
    assert.equal(resolveDesktopProfile({ OPENCHAMBER_DESKTOP_PROFILE: 'PREVIEW' }).productName, 'OpenChamber Preview');
  });

  it('rejects unknown profiles instead of silently falling back', () => {
    assert.throws(
      () => normalizeDesktopProfileId({ OPENCHAMBER_DESKTOP_PROFILE: 'nightly' }),
      /Unknown OPENCHAMBER_DESKTOP_PROFILE/,
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
    assert.ok(args.some((arg) => arg.includes('dev.openchamber.desktop.preview')));
    assert.ok(args.some((arg) => arg.includes('OpenChamber Preview')));
    assert.ok(args.some((arg) => arg.includes('dist-preview')));
    assert.ok(args.some((arg) => arg.includes('preview-icon.icns')));
    assert.ok(args.some((arg) => arg.includes('openchamber-preview')));
  });

  it('detects packaged preview identity from product name or exec path', () => {
    assert.equal(detectRuntimeDesktopProfileId({
      env: {},
      productName: 'OpenChamber Preview',
      execPath: '/Apps/OpenChamber.app/Contents/MacOS/OpenChamber',
    }), 'preview');
    assert.equal(detectRuntimeDesktopProfileId({
      env: {},
      productName: 'OpenChamber',
      execPath: '/tmp/OpenChamber Preview.app/Contents/MacOS/OpenChamber Preview',
    }), 'preview');
    assert.equal(detectRuntimeDesktopProfileId({
      env: {},
      productName: 'OpenChamber',
      execPath: '/Applications/OpenChamber.app/Contents/MacOS/OpenChamber',
    }), 'release');
    assert.equal(detectRuntimeDesktopProfileId({ buildTimeProfile: 'preview' }), 'preview');
  });
});
