import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

mock.module('./markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: '' }));

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'FileAttachment.tsx'), 'utf8');
const messageBodySource = readFileSync(join(here, 'message/MessageBody.tsx'), 'utf8');
const messageDirectory = join(here, '../../lib/i18n/messages');
const localeFiles = ['en.ts', 'es.ts', 'fr.ts', 'ja.ts', 'ko.ts', 'pl.ts', 'pt-BR.ts', 'uk.ts', 'zh-CN.ts', 'zh-TW.ts'];

const { dedupeMessageFileParts, filePartDedupeKey } = await import('./FileAttachment');

describe('slim transcript image attachments', () => {
  test('uses part identity across slim to full replacement and keeps the full record in the same slot', () => {
    const slim = {
      id: 'part-image-1',
      type: 'file',
      mime: 'image/png',
      filename: 'capture.png',
      slim: true,
    };
    const full = {
      ...slim,
      slim: false,
      url: 'data:image/png;base64,full',
    };

    expect(filePartDedupeKey(slim)).toBe('part:part-image-1');
    expect(filePartDedupeKey(full)).toBe('part:part-image-1');
    expect(dedupeMessageFileParts([slim, full])).toEqual([full]);
  });

  test('keeps a visible aspect-video slot for a slim image without a URL', () => {
    expect(source).toContain("const imageFiles = dedupedFileItems.filter(f => f.mime?.startsWith('image/'));");
    expect(source).toContain('relative aspect-video min-w-0 overflow-hidden');
    expect(source).toContain('data-message-image-slot="true"');
    expect(source).toContain("materializationStatus === 'loading'");
    expect(source).toContain("materializationStatus === 'error'");
  });

  test('materializes once on visibility and supports explicit retry after failure', () => {
    expect(source).toContain('useIntersectionObserver(');
    expect(source).toContain('entries.some((entry) => entry.isIntersecting)');
    expect(source).toContain('if (!retry && autoRequestedRef.current) return;');
    expect(source).toContain('if (materializationFlightRef.current) return;');
    expect(source).toContain('materializeTranscriptMessage(effectiveDirectory, resolvedSessionID, messageID)');
    expect(source).toContain('materializationFailedRef.current = true;');
    expect(source).toContain('onRetry={() => requestImageMaterialization(true)}');
    expect(source).toContain("element.closest('[data-scrollbar=\"chat\"]')");
  });

  test('passes message identity from user and assistant bodies', () => {
    expect(messageBodySource.match(/<MessageFilesDisplay files=\{parts\} messageID=\{messageId\} sessionID=\{sessionId\}/g)).toHaveLength(2);
  });

  test('retains the existing full-image gallery popup', () => {
    expect(source).toContain('gallery: imageGallery');
    expect(source).toContain('const index = fullImageFiles.findIndex');
    expect(source).toContain('onOpen={() => handleImageClick(file)}');
  });

  test('localizes loading, failure, and retry copy in every locale', () => {
    for (const fileName of localeFiles) {
      const dictionary = readFileSync(join(messageDirectory, fileName), 'utf8');
      expect(dictionary).toContain('chat.fileAttachment.image.loading');
      expect(dictionary).toContain('chat.fileAttachment.image.loadFailed');
      expect(dictionary).toContain('chat.fileAttachment.image.retry');
    }
  });
});
