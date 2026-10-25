import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mobileCss = readFileSync(join(here, 'mobile.css'), 'utf-8');
const mobileAppSource = readFileSync(join(here, '../apps/MobileApp.tsx'), 'utf-8');
const questionCardSource = readFileSync(join(here, '../components/chat/QuestionCard.tsx'), 'utf-8');

describe('native keyboard chat-scroll inset contract', () => {
  test('iOS chat-scroll pads with --yuri-kb-scroll-inset for non-composer fields', () => {
    expect(mobileCss).toMatch(
      /:root\.yuri-capacitor-app:not\(\.yuri-platform-android\)\s+\.yuri-mobile-app-shell\s+\.chat-scroll\s*\{[^}]*padding-bottom:\s*var\(--yuri-kb-scroll-inset,\s*0px\)/s,
    );
    expect(mobileCss).toContain('Question / other non-composer fields keep --yuri-kb-layout at 0');
  });

  test('Android chat-scroll still consumes --yuri-kb-scroll-inset during field focus', () => {
    expect(mobileCss).toMatch(
      /:root\.yuri-capacitor-app\.yuri-platform-android\s+\.yuri-mobile-app-shell\s+\.chat-scroll\s*\{[^}]*padding-bottom:\s*var\(--yuri-kb-scroll-inset/s,
    );
  });

  test('iOS composer shell shrink clears scroll inset; question path publishes it', () => {
    // Composer path: shell owns the lift via --yuri-kb-layout; scroll inset must stay 0.
    expect(mobileAppSource).toMatch(
      /const applyIosKeyboardLayout[\s\S]*?setVar\('--yuri-kb-layout',\s*height\);[\s\S]*?setVar\('--yuri-kb-scroll-inset',\s*0\);/,
    );
    // Non-composer path: keep full-height shell and publish scroll inset for chat-scroll padding.
    expect(mobileAppSource).toContain("setVar('--yuri-kb-layout', 0)");
    expect(mobileAppSource).toContain(
      "setVar('--yuri-kb-scroll-inset', Math.max(0, keyboardHeight - safeBottomPx))",
    );
  });

  test('QuestionCard reveals against the published scroll inset', () => {
    expect(questionCardSource).toContain("getPropertyValue('--yuri-kb-scroll-inset')");
    expect(questionCardSource).toContain('yuri:keyboard-settled');
    expect(questionCardSource).toContain('scrollIntoKeyboardViewport');
  });
});
