import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateAndroidAttachPickSheet } from './native-media-pick';

const sourceRoot = dirname(fileURLToPath(import.meta.url));

describe('evaluateAndroidAttachPickSheet', () => {
  test('is true only for Android clients', () => {
    expect(evaluateAndroidAttachPickSheet({
      platform: 'android',
      userAgent: 'Mozilla/5.0',
    })).toBe(true);
    expect(evaluateAndroidAttachPickSheet({
      platform: 'web',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36',
    })).toBe(true);
    expect(evaluateAndroidAttachPickSheet({
      platform: 'web',
      userAgent: 'Mozilla/5.0',
      userAgentDataPlatform: 'Android',
    })).toBe(true);
    expect(evaluateAndroidAttachPickSheet({
      platform: 'ios',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
    })).toBe(false);
    expect(evaluateAndroidAttachPickSheet({
      platform: 'web',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    })).toBe(false);
    expect(evaluateAndroidAttachPickSheet({
      platform: 'desktop',
      userAgent: '',
    })).toBe(false);
    expect(evaluateAndroidAttachPickSheet({
      platform: 'vscode',
      userAgent: '',
    })).toBe(false);
  });

  test('chat attach surfaces open the half-sheet only through the Android gate', () => {
    const chatInput = readFileSync(join(sourceRoot, '../components/chat/ChatInput.tsx'), 'utf-8');
    const promptComposer = readFileSync(join(sourceRoot, '../components/chat/ChatPromptComposer.tsx'), 'utf-8');
    expect(chatInput).toContain('usesAndroidAttachPickSheet');
    expect(chatInput).toContain('onOpenAndroidPickSheet={androidAttachPickSheet ? openAndroidMediaPickSheet : undefined}');
    expect(chatInput).toContain('{androidAttachPickSheet ? (');
    expect(chatInput).not.toContain('onOpenAndroidPickSheet={openAndroidMediaPickSheet}');
    expect(promptComposer).toContain('const androidAttachSheet = usesAndroidAttachPickSheet()');
    expect(promptComposer).toContain('androidAttachSheet ? openAttachSheet() : fileInputRef.current?.click()');
    expect(promptComposer).toContain('{androidAttachSheet && onAddFiles ? (');
    expect(promptComposer).not.toContain('isMobile ? openAttachSheet()');
  });
});
