import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isMobileOverlayFocusRestoreSuppressed,
  SUPPRESS_WINDOW_MS,
  suppressMobileOverlayFocusRestore,
} from './mobileOverlayFocusRestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf-8');
const mobileWindowMotionSource = read('../components/ui/MobileWindowMotion.tsx');
const chatInputSource = read('../components/chat/ChatInput.tsx');
const mobileSessionStatusBarSource = read('../components/chat/MobileSessionStatusBar.tsx');
const mobileSessionsSheetSource = read('../apps/MobileSessionsSheet.tsx');

describe('mobileOverlayFocusRestore', () => {
  test('arms suppression for a bounded window', () => {
    expect(isMobileOverlayFocusRestoreSuppressed()).toBe(false);
    suppressMobileOverlayFocusRestore();
    expect(isMobileOverlayFocusRestoreSuppressed()).toBe(true);
  });

  test('expires after the suppression window', async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    suppressMobileOverlayFocusRestore();
    expect(isMobileOverlayFocusRestoreSuppressed()).toBe(true);
    await sleep(SUPPRESS_WINDOW_MS - 50);
    expect(isMobileOverlayFocusRestoreSuppressed()).toBe(true);
    await sleep(80);
    expect(isMobileOverlayFocusRestoreSuppressed()).toBe(false);
  });

  test('overlay focus restore sites honor the suppression', () => {
    expect(mobileWindowMotionSource).toContain('isMobileOverlayFocusRestoreSuppressed()');
    expect(mobileWindowMotionSource).toContain('previous?.focus({ preventScroll: true })');
    expect(chatInputSource.match(/isMobileOverlayFocusRestoreSuppressed\(\)/g)?.length).toBe(2);
  });

  test('session switch handlers arm the suppression before closing their overlay', () => {
    expect(mobileSessionStatusBarSource.match(/suppressMobileOverlayFocusRestore\(\);\s*\n\s*closeSessionPanel\(\)/)).toBeTruthy();
    expect(mobileSessionsSheetSource).toContain('suppressMobileOverlayFocusRestore();');
  });
});
