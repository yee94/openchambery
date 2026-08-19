import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));

test('phone chat title can show a live transcript sync whisper', async () => {
  const [screen, header, navigation] = await Promise.all([
    readFile(join(directory, 'MobileChatScreen.tsx'), 'utf8'),
    readFile(join(directory, 'MobileChatHeader.tsx'), 'utf8'),
    readFile(join(directory, '../MobileDetailNavigation.tsx'), 'utf8'),
  ]);

  expect(screen).toContain('useMobileTranscriptSyncHint(');
  expect(screen).toContain("isDraft ? '' : sessionId");
  expect(screen).toContain('directory || undefined');
  expect(screen).toContain('subtitle={syncHint}');
  expect(header).toContain('subtitle?: string | null');
  expect(header).toContain('subtitle={subtitle}');
  expect(navigation).toContain('subtitle?: ReactNode');
  expect(navigation).toContain('oc-mobile-detail-subtitle');
  expect(navigation).toContain('aria-live="polite"');
});
