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

const {
  dedupeMessageFileParts,
  filePartDedupeKey,
  filePartImageKnownBytes,
  filePartImageManualLoadRequired,
  isDirectImageUrl,
  messageSlimImageManualLoadRequired,
} = await import('./FileAttachment');
const { RELAY_IMAGE_AUTO_LOAD_MAX_BYTES } = await import('./imageSource');

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
      expect(dictionary).toContain('chat.fileAttachment.image.loadManually');
    }
  });
});

describe('relay image auto-load size gate', () => {
  const relay = 'relay:{"serverId":"srv_123"}';
  const direct = 'direct:url:http://127.0.0.1:4096';
  const oversized = RELAY_IMAGE_AUTO_LOAD_MAX_BYTES + 1;
  const small = 64 * 1024;

  test('filePartImageKnownBytes prefers measured byteSize over declared size', () => {
    expect(filePartImageKnownBytes({ type: 'file', byteSize: 500, size: 1 })).toBe(500);
    expect(filePartImageKnownBytes({ type: 'file', size: 500 })).toBe(500);
    expect(filePartImageKnownBytes({ type: 'file' })).toBeUndefined();
    expect(filePartImageKnownBytes({ type: 'file', size: 0, byteSize: -1 })).toBeUndefined();
  });

  test('isDirectImageUrl classifies URLs that never touch the runtime file stream', () => {
    expect(isDirectImageUrl('data:image/png;base64,AA')).toBe(true);
    expect(isDirectImageUrl('https://example.com/a.png')).toBe(true);
    expect(isDirectImageUrl('blob:https://example.com/x')).toBe(true);
    expect(isDirectImageUrl('file:///tmp/a.png')).toBe(false);
    expect(isDirectImageUrl('/tmp/a.png')).toBe(false);
  });

  test('messageSlimImageManualLoadRequired gates only oversized url-less slim images on relay', () => {
    const slimBig = { type: 'file', mime: 'image/png', slim: true, byteSize: oversized };
    const slimSmall = { type: 'file', mime: 'image/png', slim: true, byteSize: small };
    const slimUnknown = { type: 'file', mime: 'image/png', slim: true };

    expect(messageSlimImageManualLoadRequired(relay, [slimBig])).toBe(true);
    expect(messageSlimImageManualLoadRequired(relay, [slimSmall])).toBe(false);
    expect(messageSlimImageManualLoadRequired(relay, [slimUnknown])).toBe(false);
    expect(messageSlimImageManualLoadRequired(direct, [slimBig])).toBe(false);
  });

  test('filePartImageManualLoadRequired gates only file-stream urls with known oversized bytes', () => {
    const fileBig = { type: 'file', mime: 'image/png', url: 'file:///tmp/big.png', byteSize: oversized };
    const fileSmall = { type: 'file', mime: 'image/png', url: 'file:///tmp/small.png', byteSize: small };
    const dataBig = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA', byteSize: oversized };
    const unknown = { type: 'file', mime: 'image/png', url: 'file:///tmp/unknown.png' };

    expect(filePartImageManualLoadRequired(relay, fileBig)).toBe(true);
    expect(filePartImageManualLoadRequired(relay, fileSmall)).toBe(false);
    expect(filePartImageManualLoadRequired(relay, dataBig)).toBe(false);
    expect(filePartImageManualLoadRequired(relay, unknown)).toBe(false);
    expect(filePartImageManualLoadRequired(direct, fileBig)).toBe(false);
  });

  test('renders a manual load action and holds visibility materialization while gated', () => {
    expect(source).toContain('manualLoad={{ onLoad: approveManualImageLoad }}');
    expect(source).toContain('manualLoad={!file.url && slimImageLoadGateActive ? { onLoad: approveManualImageLoad } : undefined}');
    expect(source).toContain('hasSlimImage && !slimImageLoadGateActive ? hydrationRootRef : null');
    expect(source).toContain('if (slimImageLoadGateActive) return;');
    expect(source).toContain("t('chat.fileAttachment.image.loadManually')");
    expect(source).toContain('gatedImageKeys={gatedImageKeys}');
    expect(source).toContain('const displaySource = useResolvedImageSource(manualLoad ? \'\' : (source ?? \'\'), effectiveDirectory);');
  });
});
