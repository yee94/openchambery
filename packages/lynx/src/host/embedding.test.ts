import { describe, expect, test } from 'vitest';

import { INITIAL_LYNX_NAVIGATION_STATE, reduceLynxNavigation } from '../shell/navigation';
import {
  createHostGlobalProps,
  isForbiddenHybridMode,
  resolveLynxEmbedding,
  shouldPaintLynxDock,
  shouldShowHostTabChrome,
} from './embedding';

describe('Lynx host embedding', () => {
  test('iOS 26+ with host tab chrome is Mode B and does not auto-skin glass', () => {
    const embedding = resolveLynxEmbedding({ platform: 'ios', iosMajorVersion: 26 });
    expect(embedding).toEqual({
      mode: 'B',
      chromeOwner: 'host',
      paintsLynxDock: false,
      fullPageAutoGlassSkin: false,
      androidGlassDowngrade: false,
    });
    expect(shouldPaintLynxDock({
      embedding,
      navigation: INITIAL_LYNX_NAVIGATION_STATE,
    })).toBe(false);
    expect(shouldShowHostTabChrome({
      embedding,
      navigation: INITIAL_LYNX_NAVIGATION_STATE,
    })).toBe(true);
  });

  test('older iOS is Mode A so Lynx may paint the dock', () => {
    const embedding = resolveLynxEmbedding({ platform: 'ios', iosMajorVersion: 18 });
    expect(embedding.mode).toBe('A');
    expect(embedding.paintsLynxDock).toBe(true);
    expect(embedding.fullPageAutoGlassSkin).toBe(true);
    expect(shouldPaintLynxDock({
      embedding,
      navigation: INITIAL_LYNX_NAVIGATION_STATE,
    })).toBe(true);
    expect(shouldShowHostTabChrome({
      embedding,
      navigation: INITIAL_LYNX_NAVIGATION_STATE,
    })).toBe(false);
  });

  test('Android is Mode A with an intentional glass downgrade', () => {
    const embedding = resolveLynxEmbedding({ platform: 'android' });
    expect(embedding.mode).toBe('A');
    expect(embedding.androidGlassDowngrade).toBe(true);
    expect(embedding.chromeOwner).toBe('lynx');
  });

  test('secondary chat hides host tab chrome and the Lynx dock', () => {
    const ios = resolveLynxEmbedding({ platform: 'ios', iosMajorVersion: 26 });
    const android = resolveLynxEmbedding({ platform: 'android' });
    const chat = reduceLynxNavigation(INITIAL_LYNX_NAVIGATION_STATE, {
      type: 'openChat',
      sessionId: 'ses_1',
    });
    expect(shouldShowHostTabChrome({ embedding: ios, navigation: chat })).toBe(false);
    expect(shouldPaintLynxDock({ embedding: android, navigation: chat })).toBe(false);
  });

  test('overlays hide chrome the same way secondary pages do', () => {
    const ios = resolveLynxEmbedding({ platform: 'ios', iosMajorVersion: 26 });
    expect(shouldShowHostTabChrome({
      embedding: ios,
      navigation: INITIAL_LYNX_NAVIGATION_STATE,
      overlayActive: true,
    })).toBe(false);
  });

  test('never resolves the Capacitor hybrid Mode C', () => {
    expect(isForbiddenHybridMode('C')).toBe(true);
    expect(isForbiddenHybridMode('hybrid')).toBe(true);
    expect(resolveLynxEmbedding({ platform: 'ios', iosMajorVersion: 26 }).mode).not.toBe('C' as never);
    expect(createHostGlobalProps({ platform: 'android' }).embeddingMode).toBe('A');
  });
});
