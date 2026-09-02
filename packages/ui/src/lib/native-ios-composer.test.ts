import { describe, expect, test, vi } from 'vitest';

import {
  applyNativeComposerAccessoryVar,
  applyNativeComposerHeightVar,
  buildNativeComposerUpdatePayload,
  emptyNativeComposerAutocomplete,
  evaluateNativeIosComposerAvailability,
  filesFromNativeComposerPayload,
  hiddenNativeIosComposerWarmState,
  handoffNativeComposerSendToWeb,
  buildNativeComposerChipRanges,
  nativeComposerChipRangesEqual,
  nativeComposerChipSpecsFromHighlights,
  nativeComposerStatesEqual,
  nativeIosComposerAppearanceFromRoot,
  NATIVE_IOS_COMPOSER_CLASS,
  NATIVE_IOS_COMPOSER_HEIGHT_VAR,
  packNativeIosComposerIdenticon,
  parseNativeComposerAcceptIndex,
  parseNativeComposerHeight,
  parseNativeComposerRemoveAttachmentId,
  parseNativeComposerSelection,
  resolveComposerInsertCaret,
  rasterizeAttachmentThumbnailBase64,
  rasterizeLogoPngBase64,
  resolveCssVarToHex,
  resolveNativeComposerSendHandoff,
  resolveNativeComposerTextWrite,
  shouldApplyNativeComposerText,
  shouldIgnoreNativeComposerTextEcho,
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
  chipRanges: [],
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
  autocomplete: emptyNativeComposerAutocomplete(),
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
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      isMobile: true,
      nativeUiEnabled: false,
    })).toBe(false);
    expect(evaluateNativeIosComposerAvailability({
      isCapacitor: true,
      platform: 'ios',
      pluginAvailable: true,
      isMobile: true,
      nativeUiEnabled: true,
    })).toBe(true);
  });

  test('parses overlay height and ignores invalid payloads', () => {
    expect(parseNativeComposerHeight({ height: 72.4 })).toBe(72.4);
    expect(parseNativeComposerHeight({ height: 0 })).toBe(0);
    expect(parseNativeComposerHeight({ height: -4 })).toBe(0);
    expect(parseNativeComposerHeight({ height: Number.NaN })).toBe(0);
    expect(parseNativeComposerHeight({})).toBe(0);
    expect(parseNativeComposerHeight(null)).toBe(0);
  });

  test('warm state installs hidden without claiming the document class', () => {
    const warm = hiddenNativeIosComposerWarmState();
    expect(warm.suppressed).toBe(true);
    expect(warm.text).toBe('');
    expect(warm.attachmentPreviews).toEqual([]);
    expect(warm.chipRanges).toEqual([]);
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
    expect(nativeComposerStatesEqual(state(), state({
      chipRanges: [{ start: 0, end: 8, triggerLength: 2, color: '#22c55e' }],
    }))).toBe(false);
    expect(nativeComposerStatesEqual(state(), state({
      autocomplete: { open: true, highlightedIndex: 0, rows: [{ id: 'a', title: '/undo', subtitle: '', badge: '', iconBase64: '' }] },
    }))).toBe(false);
  });

  test('builds highlight-only chip ranges from highlight parts without changing source glyphs', () => {
    const slot = '\u2003';
    const text = `/${slot}review please`;
    const specs = nativeComposerChipSpecsFromHighlights(text, [
      { text: `/${slot}review`, visual: { trigger: `/${slot}`, icon: 'book-open' } },
      { text: ' please' },
    ]);
    expect(specs).toEqual([
      { start: 0, end: 8, triggerLength: 2, iconName: 'book-open' },
    ]);
    expect(text.slice(specs[0].start, specs[0].end)).toBe(`/${slot}review`);
    const painted = buildNativeComposerChipRanges(specs, '#22c55e');
    expect(painted).toEqual([{
      start: 0,
      end: 8,
      triggerLength: 2,
      color: '#22c55e',
    }]);
    expect(nativeComposerChipRangesEqual(painted, painted)).toBe(true);
    expect(nativeComposerChipRangesEqual(painted, [{ ...painted[0], color: '#000000' }])).toBe(false);
    expect(nativeComposerChipSpecsFromHighlights(text, null)).toEqual([]);
    expect(nativeComposerChipSpecsFromHighlights('', [{ text: '/x', visual: { trigger: '/', icon: 'command' } }])).toEqual([]);
    expect(nativeComposerChipSpecsFromHighlights(text, [
      { text: '/', visual: { trigger: `/${slot}`, icon: 'book-open' } },
    ])).toEqual([]);
    const payload = buildNativeComposerUpdatePayload(
      state(),
      state({ chipRanges: painted }),
      { omitText: true, forceText: false },
    );
    expect(payload).toEqual({ chipRanges: painted });
  });

  test('parses native text selection and accept index', () => {
    expect(parseNativeComposerSelection({ selectionStart: 3, selectionEnd: 5 })).toEqual({ start: 3, end: 5 });
    expect(parseNativeComposerSelection({ selectionStart: 2 })).toEqual({ start: 2, end: 2 });
    expect(parseNativeComposerSelection({})).toBeNull();
    expect(parseNativeComposerAcceptIndex({ index: 2 })).toBe(2);
    expect(parseNativeComposerAcceptIndex({ index: -1 })).toBe(0);
    expect(parseNativeComposerAcceptIndex({})).toBe(0);
    expect(parseNativeComposerAcceptIndex({ index: '3' as unknown as number })).toBe(3);
    expect(parseNativeComposerSelection({
      selectionStart: '4' as unknown as number,
      selectionEnd: '4' as unknown as number,
    })).toEqual({ start: 4, end: 4 });
    expect(resolveComposerInsertCaret(8, 3)).toBe(3);
    expect(resolveComposerInsertCaret(8, 99)).toBe(8);
    expect(resolveComposerInsertCaret(8, undefined)).toBe(8);
    expect(resolveComposerInsertCaret(8, -2)).toBe(0);
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
    expect(resolveNativeComposerTextWrite({
      nextText: 'restored message',
      nativeOwnedText: 'draft in flight',
      echoingNative: true,
      preset: true,
    })).toEqual({ omitText: false, forceText: true });
    expect(shouldIgnoreNativeComposerTextEcho({
      incoming: 'draft in flight',
      replacedText: 'draft in flight',
    })).toBe(true);
    expect(shouldIgnoreNativeComposerTextEcho({
      incoming: 'restored message',
      replacedText: 'draft in flight',
    })).toBe(false);
    expect(shouldIgnoreNativeComposerTextEcho({
      incoming: 'draft in flight',
      replacedText: null,
    })).toBe(false);
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

  test('session model switch republishes name, thinking, and icon together', () => {
    expect(buildNativeComposerUpdatePayload(
      state({ modelLabel: 'Claude', modelVariantLabel: 'High', modelIcon: 'old' }),
      state({ modelLabel: 'Grok', modelVariantLabel: 'Low', modelIcon: '' }),
      { omitText: true, forceText: false },
    )).toEqual({
      modelLabel: 'Grok',
      modelVariantLabel: 'Low',
      modelIcon: '',
    });
  });

  test('echoed keystrokes skip the bridge and never resend preview or icon bytes', () => {
    const previous = state({
      text: 'hel',
      canSend: true,
      modelIcon: 'icon-bytes',
      attachmentPreviews: [{
        id: 'a',
        filename: 'a.png',
        mime: 'image/png',
        thumbnailBase64: 'thumb-bytes',
        removeAria: 'Remove a.png',
      }],
    });
    const echoed = state({
      ...previous,
      text: 'hello',
    });
    expect(buildNativeComposerUpdatePayload(previous, echoed, {
      omitText: true,
      forceText: false,
    })).toBeNull();

    const canSendFlipped = state({
      ...echoed,
      canSend: false,
      chipRanges: [{ start: 0, end: 8, triggerLength: 2, color: '#22c55e' }],
    });
    const previousWithChips = state({
      ...previous,
      chipRanges: [{ start: 0, end: 8, triggerLength: 2, color: '#22c55e' }],
    });
    expect(buildNativeComposerUpdatePayload(previousWithChips, canSendFlipped, {
      omitText: true,
      forceText: false,
    })).toEqual({ canSend: false });

    const jsClear = state({
      ...previous,
      text: '',
      canSend: false,
    });
    expect(buildNativeComposerUpdatePayload(previous, jsClear, {
      omitText: false,
      forceText: true,
    })).toEqual({
      text: '',
      forceText: true,
      canSend: false,
    });
    expect(buildNativeComposerUpdatePayload(previous, state({
      ...previous,
      text: 'see @src/foo.ts ',
    }), {
      omitText: false,
      forceText: true,
    }, { caret: 16 })).toEqual({
      text: 'see @src/foo.ts ',
      forceText: true,
      caret: 16,
    });
  });

  test('native send is a web handoff: no forceText and submit waits for the next macrotask', () => {
    expect(resolveNativeComposerSendHandoff()).toEqual({ omitText: true, forceText: false });
    expect(resolveNativeComposerTextWrite({
      nextText: 'burst then send',
      nativeOwnedText: 'burst then send',
      echoingNative: true,
    })).toEqual({ omitText: true, forceText: false });
    expect(resolveNativeComposerTextWrite({
      nextText: '',
      nativeOwnedText: 'burst then send',
      echoingNative: true,
    })).toEqual({ omitText: false, forceText: true });
    expect(buildNativeComposerUpdatePayload(
      state({ text: 'burst then send', canSend: true }),
      state({ text: '', canSend: false }),
      { omitText: false, forceText: true },
    )).toEqual({
      text: '',
      forceText: true,
      canSend: false,
    });

    const applyDocument = vi.fn();
    const submit = vi.fn();
    vi.useFakeTimers();
    try {
      handoffNativeComposerSendToWeb({
        text: 'burst then send',
        applyDocument,
        submit,
      });
      expect(applyDocument).toHaveBeenCalledWith('burst then send');
      expect(submit).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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

  test('caches a CSS variable hex so a second lookup does not create a probe', async () => {
    document.documentElement.style.setProperty('--oc-composer-cache-hit', 'rgb(16, 185, 129)');
    await Promise.resolve();
    const first = resolveCssVarToHex('--oc-composer-cache-hit');
    expect(first).toBe('#10b981');
    const createElement = vi.spyOn(document, 'createElement');
    const getComputedStyleSpy = vi.spyOn(window, 'getComputedStyle');
    try {
      expect(resolveCssVarToHex('--oc-composer-cache-hit')).toBe(first);
      expect(createElement).not.toHaveBeenCalled();
      expect(getComputedStyleSpy).not.toHaveBeenCalled();
    } finally {
      createElement.mockRestore();
      getComputedStyleSpy.mockRestore();
    }
  });

  test('invalidates the CSS variable hex cache when the root class or style changes', async () => {
    const previousClassName = document.documentElement.className;
    document.documentElement.style.setProperty('--oc-composer-cache-invalidate', 'rgb(16, 185, 129)');
    await Promise.resolve();
    expect(resolveCssVarToHex('--oc-composer-cache-invalidate')).toBe('#10b981');
    document.documentElement.style.setProperty('--oc-composer-cache-invalidate', 'rgb(59, 130, 246)');
    document.documentElement.className = previousClassName ? `${previousClassName} dark` : 'dark';
    try {
      await vi.waitFor(() => {
        expect(resolveCssVarToHex('--oc-composer-cache-invalidate')).toBe('#3b82f6');
      });
    } finally {
      document.documentElement.className = previousClassName;
      document.documentElement.style.removeProperty('--oc-composer-cache-invalidate');
    }
  });
});
