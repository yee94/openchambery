import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiles the actual renderer, then checks pixels beyond multiple viewports,
// PDF page boundaries, hostile inputs/network isolation and cancellation in UIKit.
const device = process.env.YURI_IOS_TEST_DEVICE;
const products = process.env.YURI_IOS_TEST_PRODUCTS;
const snapshot = process.env.YURI_IOS_EXPORT_SNAPSHOT;
const artifacts = process.env.YURI_IOS_EXPORT_ARTIFACTS;
test.skipIf(process.platform !== 'darwin' || !device)('production iOS view exporter renders bounded, isolated full snapshots', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yuri-view-export-'));
  const app = join(work, 'ViewExportProbe.app');
  const bundle = 'com.yuri.view-export-regression';
  const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 120_000 });
  try {
    await mkdir(app);
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios15.5-simulator',
      fileURLToPath(new URL('../ios/App/App/YuriViewExportRenderer.swift', import.meta.url)),
      fileURLToPath(new URL('./view-export-ios-probe.swift', import.meta.url)), '-o', join(app, 'ViewExportProbe')], { timeout: 120_000 });
    await writeFile(join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundleExecutable</key><string>ViewExportProbe</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>UILaunchScreen</key><dict/>
      <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
    </dict></plist>`);
    simctl('install', device, app);
    const output = simctl('launch', '--console', device, bundle);
    expect(output).toContain('LONG_IMAGE_PIXELS_PASSED');
    expect(output).toContain('A4_PAGINATION_PASSED');
    expect(output).toContain('LETTER_PAGINATION_PASSED');
    expect(output).toContain('PDF_SEARCHABLE_TAIL_PASSED');
    expect(output).toContain('VIEW_EXPORT_IOS_PASSED');
    expect(output).not.toContain('VIEW_EXPORT_IOS_FAILED');
  } finally {
    try { simctl('uninstall', device, bundle); } catch { /* Installation may not have completed. */ }
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);

test.skipIf(process.platform !== 'darwin' || !device || !snapshot || !artifacts)('real Eficy phone snapshot preserves its full PNG and searchable PDF footer', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yuri-view-export-real-'));
  const app = join(work, 'ViewExportRealProbe.app');
  const bundle = 'com.yuri.view-export-real-regression';
  const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 240_000 });
  let installed = false;
  try {
    await mkdir(app);
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios15.5-simulator',
      fileURLToPath(new URL('../ios/App/App/YuriViewExportRenderer.swift', import.meta.url)),
      fileURLToPath(new URL('./view-export-ios-real-probe.swift', import.meta.url)), '-o', join(app, 'ViewExportRealProbe')], { timeout: 120_000 });
    await cp(snapshot, join(app, 'snapshot.json'));
    await cp(join(dirname(snapshot), 'expected-footer.txt'), join(app, 'expected-footer.txt'));
    await writeFile(join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundleExecutable</key><string>ViewExportRealProbe</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>UILaunchScreen</key><dict/>
    </dict></plist>`);
    simctl('install', device, app);
    installed = true;
    const output = simctl('launch', '--console', device, bundle);
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, 'ios-probe.log'), output);
    expect(output).toContain('VIEW_EXPORT_REAL_PASSED');
    expect(output).not.toContain('VIEW_EXPORT_REAL_FAILED');
  } finally {
    if (installed) {
      const container = simctl('get_app_container', device, bundle, 'data').trim();
      await cp(join(container, 'Documents'), artifacts, { recursive: true });
    }
    try { simctl('uninstall', device, bundle); } catch { /* Installation may not have completed. */ }
    await rm(work, { recursive: true, force: true });
  }
}, 300_000);

test.skipIf(process.platform !== 'darwin' || !device || !products)('production Capacitor plugin saves PNG to Photos and PDF through the picker with cancellation and cleanup', async () => {
  const work = await mkdtemp(join(tmpdir(), 'yuri-view-export-bridge-'));
  const app = join(work, 'ViewExportBridgeProbe.app');
  const bundle = 'com.yuri.view-export-bridge-regression';
  const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 90_000 });
  // Inspect only this fixture's generated assets from the host, so the app under
  // test needs add-only access, never permission to read the user's library.
  const photoDatabase = join(simctl('getenv', device, 'HOME').trim(), 'Media/PhotoData/Photos.sqlite');
  const photoCount = () => Number(execFileSync('sqlite3', ['-readonly', photoDatabase,
    "SELECT count(*) FROM ZASSET a JOIN ZADDITIONALASSETATTRIBUTES d ON d.ZASSET=a.Z_PK WHERE a.ZWIDTH=600 AND a.ZHEIGHT=1000 AND d.ZORIGINALFILENAME='snapshot.png';"], { encoding: 'utf8' }).trim());
  const initialPhotos = photoCount();
  try {
    await mkdir(join(app, 'Frameworks'), { recursive: true });
    for (const [directory, name] of [['Capacitor', 'Capacitor'], ['CapacitorCordova', 'Cordova']]) {
      await cp(join(products, directory, `${name}.framework`), join(app, 'Frameworks', `${name}.framework`), { recursive: true });
    }
    const sdk = execFileSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim();
    execFileSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios15.5-simulator',
      '-F', join(app, 'Frameworks'), '-framework', 'Capacitor', '-framework', 'Cordova',
      '-Xlinker', '-rpath', '-Xlinker', '@executable_path/Frameworks',
      fileURLToPath(new URL('../ios/App/App/YuriViewExportRenderer.swift', import.meta.url)),
      fileURLToPath(new URL('../ios/App/App/YuriViewExportPlugin.swift', import.meta.url)),
      fileURLToPath(new URL('../ios/App/App/YuriMediaPlugin.swift', import.meta.url)),
      fileURLToPath(new URL('./view-export-ios-bridge-probe.swift', import.meta.url)), '-o', join(app, 'ViewExportBridgeProbe')], { timeout: 120_000 });
    await mkdir(join(app, 'public'));
    await writeFile(join(app, 'public', 'index.html'), '<!doctype html><html><body>Export probe owner</body></html>');
    await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({ appId: bundle, appName: 'Export probe', webDir: 'public', packageClassList: [] }));
    await writeFile(join(app, 'config.xml'), '<widget id="com.yuri.view-export-bridge-regression" version="1.0.0"/>');
    await writeFile(join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundleExecutable</key><string>ViewExportBridgeProbe</string>
      <key>CFBundlePackageType</key><string>APPL</string>
      <key>CFBundleVersion</key><string>1</string>
      <key>UILaunchScreen</key><dict/>
      <key>NSPhotoLibraryAddUsageDescription</key><string>Save exported image regression test</string>
    </dict></plist>`);
    simctl('install', device, app);
    simctl('privacy', device, 'grant', 'photos-add', bundle);
    const output = simctl('launch', '--console', device, bundle);
    expect(output).toContain('VIEW_EXPORT_BRIDGE_PASSED');
    expect(output).toContain('VIEW_EXPORT_PHOTOS_PASSED');
    expect(output).not.toContain('VIEW_EXPORT_BRIDGE_FAILED');
    expect(photoCount(), 'two complete PNG images must actually be committed to Photos').toBe(initialPhotos + 2);
    simctl('privacy', device, 'revoke', 'photos-add', bundle);
    const denied = simctl('launch', '--console', device, bundle, '--photos-denied');
    expect(denied).toContain('VIEW_EXPORT_PHOTOS_DENIED_PASSED');
    expect(denied).not.toContain('VIEW_EXPORT_BRIDGE_FAILED');
    expect(photoCount(), 'denied Photos saves must not create an asset').toBe(initialPhotos + 2);
  } finally {
    try { simctl('uninstall', device, bundle); } catch { /* Installation may not have completed. */ }
    await rm(work, { recursive: true, force: true });
  }
}, 180_000);
