import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let classes;
beforeAll(() => {
  classes = mkdtempSync(path.join(tmpdir(), 'yuri-view-export-android-'));
  execFileSync('javac', ['-d', classes,
    path.resolve(here, '../android/app/src/main/java/com/yuri/app/ViewExportRequest.java'),
    path.join(here, 'view-export-android/RequestHarness.java')]);
});
afterAll(() => { if (classes) rmSync(classes, { recursive: true, force: true }); });

it('executes production Java validation at byte, dimension and pixel boundaries', () => {
  expect(execFileSync('java', ['-cp', classes, 'com.yuri.app.RequestHarness'], { encoding: 'utf8' }).trim())
    .toBe('PASS native validation and isolated document policy');
});

// Opt in after installing app-debug.apk and app-debug-androidTest.apk. No emulator
// or device is implicitly installed/launched by the regular workspace test suite.
it.skipIf(!process.env.YURI_ANDROID_TEST_DEVICE)('renders complete offscreen PNG/vector PDF and exercises native task lifecycle', () => {
  const output = execFileSync(process.env.YURI_ADB || 'adb', [
    '-s', process.env.YURI_ANDROID_TEST_DEVICE, 'shell', 'am', 'instrument', '-w',
    'com.yee94.yuri.debug.test/com.yuri.app.ViewExportInstrumentation',
  ], { encoding: 'utf8', timeout: 180_000 });
  expect(output).toContain('PASS view export Android runtime');
  expect(output).not.toContain('FAIL');
}, 190_000);
