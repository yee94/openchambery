import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'useNativeIosComposer.ts'), 'utf-8');

describe('useNativeIosComposer', () => {
  test('keeps send, attach, model, and agent as ChatInput events and uses useEvent', () => {
    expect(source).toContain("from '@reactuses/core'");
    expect(source).toContain('useEvent');
    expect(source).not.toContain('useCallback');
    expect(source).toContain('onSend');
    expect(source).toContain('onAttach');
    expect(source).toContain('onFiles');
    expect(source).toContain('onRemoveAttachment');
    expect(source).toContain('attachmentPreviews');
    expect(source).toContain('citationRanges');
    expect(source).toContain('rasterizeAttachmentThumbnailBase64');
    expect(source).toContain('findAttachmentCitationRanges');
    expect(source).toContain('resolveModelLogoSrc');
    expect(source).toContain('rasterizeLogoPngBase64');
    expect(source).toContain('onOpenModel');
    expect(source).toContain('onCycleAgent');
    expect(source).toContain('onOpenAgent');
    expect(source).toContain('onScrollToBottom');
    expect(source).toContain('showScrollToBottom: args.showScrollToBottom');
    expect(source).toContain('resolveNativeComposerTextWrite');
    expect(source).toContain('echoingNativeRef');
    expect(source).toContain('forceText');
    expect(source).toContain('nativeIosComposerSession.retain');
    expect(source).toContain('nativeIosComposerSession.release');
    expect(source).toContain('nativeIosComposerSession.bind');
    expect(source).toContain('nativeIosComposerSession.rememberState');
    expect(source).toContain('attachNativeIosComposerLeaveConceal');
    expect(source).toContain('nativeIosComposerSession.rememberState');
    expect(source).toContain('getNativeIosComposerPlugin().update');
    expect(source).toContain('applyNativeComposerHeightVar');
    expect(source).toContain('packNativeIosComposerIdenticon');
    expect(source).toContain('modelVariantLabel');
    expect(source).toContain('queueAria');
    expect(source).toContain('attachPhotosLabel');
    expect(source).toContain('attachFilesLabel');
    expect(source).toContain('attachCancelLabel');
  });
});
