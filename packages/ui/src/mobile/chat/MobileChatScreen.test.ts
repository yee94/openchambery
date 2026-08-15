import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

test('phone chat title can show a live transcript sync whisper', async () => {
  const [screen, header, navigation] = await Promise.all([
    readFile(new URL('./MobileChatScreen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./MobileChatHeader.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../MobileDetailNavigation.tsx', import.meta.url), 'utf8'),
  ]);

  expect(screen).toContain('useMobileTranscriptSyncHint(isDraft ? \'\' : sessionId)');
  expect(screen).toContain('subtitle={syncHint}');
  expect(header).toContain('subtitle?: string | null');
  expect(header).toContain('subtitle={subtitle}');
  expect(navigation).toContain('subtitle?: ReactNode');
  expect(navigation).toContain('oc-mobile-detail-subtitle');
  expect(navigation).toContain('aria-live="polite"');
});
