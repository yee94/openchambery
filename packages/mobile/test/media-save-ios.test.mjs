import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Opt-in: uses a booted simulator and Capacitor frameworks from a simulator build.
const device = process.env.YURI_IOS_TEST_DEVICE;
const products = process.env.YURI_IOS_TEST_PRODUCTS;
const webp = 'UklGRhgCAABXRUJQVlA4WAoAAAAgAAAADwAADwAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggKgAAAJABAJ0BKhAAEAABQCYloAJ0ugADmAD+7U3fFsUhuZ/8/M/3T/O/RIAAAA==';

test.skipIf(process.platform !== 'darwin' || !device || !products)('production iOS plugin saves a displayable WebP to Photos', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yuri-photo-save-'));
  const app = join(work, 'MediaSaveProbe.app');
  const bundle = 'com.yuri.media-save-regression';
  const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 60_000 });
  try {
    await mkdir(join(app, 'Frameworks'), { recursive: true });
    const frameworks = [['Capacitor', 'Capacitor'], ['CapacitorCordova', 'Cordova']];
    for (const [directory, name] of frameworks) await cp(join(products, directory, `${name}.framework`), join(app, 'Frameworks', `${name}.framework`), { recursive: true });
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    execFileSync('xcrun', ['swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios18.0-simulator',
      '-F', join(app, 'Frameworks'), '-framework', 'Capacitor', '-framework', 'Cordova',
      '-Xlinker', '-rpath', '-Xlinker', '@executable_path/Frameworks',
      fileURLToPath(new URL('../ios/App/App/YuriMediaPlugin.swift', import.meta.url)),
      fileURLToPath(new URL('./fixtures/MediaSaveProbe.swift', import.meta.url)), '-o', join(app, 'MediaSaveProbe')]);
    await writeFile(join(app, 'source.webp'), Buffer.from(webp, 'base64'));
    await writeFile(join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundleExecutable</key><string>MediaSaveProbe</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>NSPhotoLibraryAddUsageDescription</key><string>Photo save regression test</string>
      <key>UILaunchScreen</key><dict/>
    </dict></plist>`);
    simctl('install', device, app);
    simctl('privacy', device, 'grant', 'photos-add', bundle);
    const output = simctl('launch', '--console', device, bundle);
    expect(output).toContain('PHOTO_SAVE_PASSED');
    expect(output).not.toContain('PHOTO_SAVE_FAILED');
  } finally {
    try { simctl('uninstall', device, bundle); } catch { /* Install may not have completed. */ }
    await rm(work, { recursive: true, force: true });
  }
}, 120_000);
