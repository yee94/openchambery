import { describe, expect, test } from 'vitest';

import {
  applyNativeComposerAccessoryVar,
  applyNativeComposerHeightVar,
  evaluateNativeIosComposerAvailability,
  filesFromNativeComposerPayload,
  nativeComposerStatesEqual,
  nativeIosComposerAppearanceFromRoot,
  NATIVE_IOS_COMPOSER_CLASS,
  NATIVE_IOS_COMPOSER_HEIGHT_VAR,
  packNativeIosComposerIdenticon,
  parseNativeComposerHeight,
  parseNativeComposerRemoveAttachmentId,
  rasterizeAttachmentThumbnailBase64,
  rasterizeLogoPngBase64,
  resolveCssVarToHex,
  resolveNativeComposerTextWrite,
  shouldApplyNativeComposerText,
  setNativeComposerDocumentClass,
  skippedNamesFromNativeComposerPayload,
  type NativeIosComposerState,
} from './native-ios-composer';

const state = (overrides: Partial<NativeIosComposerState> = {}): NativeIosComposerState => ({
  text: '',
  placeholder: 'Tap to type',
  modelLabel: 'Grok',
  modelVariantLabel: '',
  modelIcon: '',
  canSend: false,
  canAbort: false,
  attachmentCount: 0,
  attachmentPreviews: [],
  citationRanges: [],
  appearance: 'dark',
  attachAria: 'Add attachment',
  attachTitle: 'Add attachment',
  attachPhotosLabel: 'Attach photos',
  attachFilesLabel: 'Attach files',
  attachCancelLabel: 'Cancel',
  sendAria: 'Send message',
  queueAria: 'Queue message',
  stopAria: 'Stop generating',
  modelAria: 'Select model',
  agentAria: 'Select agent',
  agentLabel: 'Build',
  agentColor: '#22c55e',
  agentIdenticon: Array.from({ length: 25 }, () => 0),
  suppressed: false,
  showScrollToBottom: false,
  scrollAria: 'Scroll to bottom',
  ...overrides,
});

describe('native iOS composer contract', () => {
  test('is available only on Capacitor iOS with the plugin and a mobile layout', () => {
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      isMobile: true,
    })).toBe(true);
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: true,
      platform: 'android',
      pluginAvailable: true,
      isMobile: true,
    })).toBe(false);
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: false,
      platform: 'ios',
      pluginAvailable: true,
      isMobile: true,
    })).toBe(false);
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: false,
      isMobile: true,
    })).toBe(false);
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      isMobile: false,
    })).toBe(false);
  });

  test('parses overlay height and ignores invalid payloads', () => {
    expect(parseNativeComposerHeight({ height: 72.4 })).toBe(72.4);
    expect(parseNativeComposerHeight({ height: 0 })).toBe(0);
    expect(parseNativeComposerHeight({ height: -4 })).toBe(0);
    expect(parseNativeComposerHeight({ height: Number.NaN })).toBe(0);
    expect(parseNativeComposerHeight({})).toBe(0);
    expect(parseNativeComposerHeight(null)).toBe(0);
  });

  test('toggles the document class and height var without writing the web foot inset', () => {
    const root = document.createElement('html');
    setNativeComposerDocumentClass(root, true);
    applyNativeComposerHeightVar(root, 84);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(true);
    expect(root.style.getPropertyValue(NATIVE_IOS_COMPOSER_HEIGHT_VAR)).toBe('84px');
    expect(root.style.getPropertyValue('--oc-chat-foot-inset')).toBe('');
    applyNativeComposerAccessoryVar(root, 24);
    expect(root.style.getPropertyValue('--oc-native-composer-accessory')).toBe('24px');
    setNativeComposerDocumentClass(root, false);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);
    expect(root.style.getPropertyValue(NATIVE_IOS_COMPOSER_HEIGHT_VAR)).toBe('');
    expect(root.style.getPropertyValue('--oc-native-composer-accessory')).toBe('');
  });

  test('reads appearance from the root dark class', () => {
    const root = document.createElement('html');
    expect(nativeIosComposerAppearanceFromRoot(root)).toBe('light');
    root.classList.add('dark');
    expect(nativeIosComposerAppearanceFromRoot(root)).toBe('dark');
  });

  test('treats identical composer states as equal so updates can skip', () => {
    expect(nativeComposerStatesEqual(state(), state())).toBe(true);
    expect(nativeComposerStatesEqual(state(), state({ text: 'hello' }))).toBe(false);
    expect(nativeComposerStatesEqual(state({ canAbort: true }), state({ canAbort: true, canSend: false }))).toBe(true);
    expect(nativeComposerStatesEqual(state(), state({ agentColor: '#111111' }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ agentLabel: 'Explore' }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ modelIcon: 'abc' }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ modelVariantLabel: 'Fast' }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ queueAria: 'Queue' }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ attachPhotosLabel: 'Photos' }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ showScrollToBottom: true }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({
      attachmentPreviews: [{ id: 'a', filename: 'a.png', mime: 'image/png', thumbnailBase64: '', removeAria: 'Remove a.png' }],
    }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({ citationRanges: [{ start: 0, end: 4 }] }))).toBe(false);
  });

  test('reads a remove-attachment id and ignores empty payloads', () => {
    expect(parseNativeComposerRemoveAttachmentId({ id: 'att-1' })).toBe('att-1');
    expect(parseNativeComposerRemoveAttachmentId({ id: '  ' })).toBe('');
    expect(parseNativeComposerRemoveAttachmentId({})).toBe('');
  });

  test('does not write echoed native text back while composing or focused', () => {
    expect(resolveNativeComposerTextWrite({
      nextText: 'ni',
      nativeOwnedText: 'ni',
      echoingNative: false,
    })).toEqual({ omitText: true, forceText: false });
    expect(resolveNativeComposerTextWrite({
      nextText: '你好',
      nativeOwnedText: 'ni',
      echoingNative: true,
    })).toEqual({ omitText: true, forceText: false });
    expect(resolveNativeComposerTextWrite({
      nextText: '[file] hi',
      nativeOwnedText: 'hi',
      echoingNative: false,
    })).toEqual({ omitText: false, forceText: true });
    expect(shouldApplyNativeComposerText({
      incoming: 'ni',
      current: 'n',
      isComposing: true,
      isFirstResponder: true,
      forceText: false,
    })).toBe(false);
    expect(shouldApplyNativeComposerText({
      incoming: '[file] hi',
      current: 'hi',
      isComposing: false,
      isFirstResponder: true,
      forceText: true,
    })).toBe(true);
    expect(shouldApplyNativeComposerText({
      incoming: undefined,
      current: 'hi',
      isComposing: false,
      isFirstResponder: false,
      forceText: false,
    })).toBe(false);
  });

  test('decodes native picker files and skips oversize or malformed payloads', () => {
    const files = filesFromNativeComposerPayload({
      files: [
        { name: 'note.txt', mime: 'text/plain', dataBase64: btoa('hi') },
        { name: 'bad.bin', mime: 'application/octet-stream', dataBase64: '%%%' },
        { name: 'huge.bin', mime: 'application/octet-stream', dataBase64: btoa('12345') },
      ],
    }, 4);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('note.txt');
    expect(files[0]?.type).toBe('text/plain');
    expect(skippedNamesFromNativeComposerPayload({
      skipped: [{ name: 'huge.bin', reason: 'tooLarge' }, { name: '' }],
    })).toEqual(['huge.bin']);
  });

  test('rasterizeLogoPngBase64 returns null without a paintable source', async () => {
    await expect(rasterizeLogoPngBase64('')).resolves.toBeNull();
    await expect(rasterizeLogoPngBase64('data:text/plain,nope')).resolves.toBeNull();
  });

  test('rasterizeAttachmentThumbnailBase64 ignores non-image sources', async () => {
    await expect(rasterizeAttachmentThumbnailBase64('')).resolves.toBeNull();
    await expect(rasterizeAttachmentThumbnailBase64('data:text/plain,nope')).resolves.toBeNull();
  });

  test('packs a stable 5x5 identicon for the native agent avatar', () => {
    const packed = packNativeIosComposerIdenticon('build');
    expect(packed).toHaveLength(25);
    expect(packed.every((bit) => bit === 0 || bit === 1)).toBe(true);
    expect(packNativeIosComposerIdenticon('build')).toEqual(packed);
    expect(packNativeIosComposerIdenticon('explore')).not.toEqual(packed);
  });

  test('resolves a CSS variable to a hex color the native overlay can paint', () => {
    document.documentElement.style.setProperty('--status-success', 'rgb(16, 185, 129)');
    expect(resolveCssVarToHex('--status-success')).toBe('#10b981');
  });
});
