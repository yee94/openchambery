import { isDockHidden, type LynxNavigationState } from '../shell/navigation';

/**
 * Host embedding modes from `docs/lynx-ia-ui.md` / `docs/lynx-acceptance.md`.
 *
 * Slice 1 lock:
 * - iOS 26+ with a real host tab bar → Mode B (host owns Tab/Nav; no Lynx dock)
 * - older iOS and Android → Mode A (Lynx owns chrome; glass / blur-radius)
 * - Mode C (Capacitor hybrid overlay) is forbidden
 *
 * Full-page auto glass skin is allowed only in Mode A.
 */
export type LynxEmbeddingMode = 'A' | 'B';

export type LynxChromeOwner = 'lynx' | 'host';

export type LynxHostPlatform = 'ios' | 'android';

export const IOS_LIQUID_GLASS_TAB_BAR_MAJOR = 26;

export type LynxEmbeddingInput = {
  platform: LynxHostPlatform;
  /** iOS major version. Ignored on Android. */
  iosMajorVersion?: number;
  /**
   * False when the host cannot present a system `UITabBarController`.
   * Defaults to true on iOS 26+.
   */
  hostTabChromeAvailable?: boolean;
};

export type LynxEmbeddingDecision = {
  mode: LynxEmbeddingMode;
  chromeOwner: LynxChromeOwner;
  /** Lynx may paint the four-tab dock (Mode A only). */
  paintsLynxDock: boolean;
  /** Official Lynx glass may skin full-page chrome. Mode B: never. */
  fullPageAutoGlassSkin: boolean;
  androidGlassDowngrade: boolean;
};

/**
 * Mode C exists only as a Capacitor WebView leftover. Lynx must not resolve it.
 */
export function isForbiddenHybridMode(mode: string): boolean {
  return mode === 'C' || mode === 'hybrid' || mode === 'capacitor-overlay';
}

export function resolveLynxEmbedding(input: LynxEmbeddingInput): LynxEmbeddingDecision {
  if (input.platform === 'ios') {
    const iosMajor = input.iosMajorVersion ?? 0;
    const hostCanOwnTabBar = input.hostTabChromeAvailable !== false
      && iosMajor >= IOS_LIQUID_GLASS_TAB_BAR_MAJOR;
    if (hostCanOwnTabBar) {
      return {
        mode: 'B',
        chromeOwner: 'host',
        paintsLynxDock: false,
        fullPageAutoGlassSkin: false,
        androidGlassDowngrade: false,
      };
    }
  }

  return {
    mode: 'A',
    chromeOwner: 'lynx',
    paintsLynxDock: true,
    fullPageAutoGlassSkin: true,
    androidGlassDowngrade: input.platform === 'android',
  };
}

export function shouldPaintLynxDock(input: {
  embedding: LynxEmbeddingDecision;
  navigation: LynxNavigationState;
  overlayActive?: boolean;
}): boolean {
  if (!input.embedding.paintsLynxDock) return false;
  if (input.overlayActive) return false;
  return !isDockHidden(input.navigation);
}

export function shouldShowHostTabChrome(input: {
  embedding: LynxEmbeddingDecision;
  navigation: LynxNavigationState;
  overlayActive?: boolean;
}): boolean {
  if (input.embedding.chromeOwner !== 'host') return false;
  if (input.overlayActive) return false;
  return !isDockHidden(input.navigation);
}

/**
 * Host global-props / LynxView data passed into the page.
 * Content pages in Mode B must not draw a second dock.
 */
export type LynxHostGlobalProps = {
  embeddingMode: LynxEmbeddingMode;
  chromeOwner: LynxChromeOwner;
  platform: LynxHostPlatform;
  iosMajorVersion?: number;
  themeId: 'flexoki-light' | 'flexoki-dark';
  locale: string;
};

export function createHostGlobalProps(
  input: LynxEmbeddingInput & {
    themeId?: 'flexoki-light' | 'flexoki-dark';
    locale?: string;
  },
): LynxHostGlobalProps {
  const embedding = resolveLynxEmbedding(input);
  return {
    embeddingMode: embedding.mode,
    chromeOwner: embedding.chromeOwner,
    platform: input.platform,
    iosMajorVersion: input.iosMajorVersion,
    themeId: input.themeId ?? 'flexoki-light',
    locale: input.locale ?? 'en',
  };
}
