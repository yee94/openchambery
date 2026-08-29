import { describe, expect, test } from 'vitest';

import {
  applyNativeComposerHeightVar,
  evaluateNativeIosComposerAvailability,
  nativeComposerStatesEqual,
  nativeIosComposerAppearanceFromRoot,
  NATIVE_IOS_COMPOSER_CLASS,
  NATIVE_IOS_COMPOSER_HEIGHT_VAR,
  parseNativeComposerHeight,
  setNativeComposerDocumentClass,
  type NativeIosComposerState,
} from './native-ios-composer';

const state = (overrides: Partial<NativeIosComposerState> = {}): NativeIosComposerState => ({
  text: '',
  placeholder: 'Tap to type',
  modelLabel: 'Grok',
  canSend: false,
  canAbort: false,
  attachmentCount: 0,
  appearance: 'dark',
  attachAria: 'Attach files',
  sendAria: 'Send message',
  stopAria: 'Stop generating',
  modelAria: 'Select model',
  suppressed: false,
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
    setNativeComposerDocumentClass(root, false);
    expect(root.classList.contains(NATIVE_IOS_COMPOSER_CLASS)).toBe(false);
    expect(root.style.getPropertyValue(NATIVE_IOS_COMPOSER_HEIGHT_VAR)).toBe('');
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
  });
});
