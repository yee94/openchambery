import type { LynxHostPlatform } from '../host/embedding';

/**
 * Lynx 3.8 `<blur-view>` contract.
 *
 * iOS liquid glass maps to UIKit:
 * - `blur-effect="glass"` → `UIGlassEffect`
 * - `blur-effect="glass-container"` → `UIGlassContainerEffect`
 * - `glass-style` → `UIGlassEffect.Style` (`regular` | `clear`)
 * - `glass-interactive` → interactive glass
 * - `glass-tint-color` → tint
 * - `spacing` → fusion distance inside a glass-container
 *
 * Android is an intentional downgrade: `blur-radius` (+ sampling), never a
 * fake `UIGlassEffect` clone.
 */
export type LynxBlurEffect = 'light' | 'extra-light' | 'dark' | 'glass' | 'glass-container';

export type LynxGlassStyle = 'regular' | 'clear';

export type GlassSurfaceKind =
  | 'dock'
  | 'dockItem'
  | 'searchChip'
  | 'headerButton'
  | 'composerPill'
  | 'composerCard';

export type ForbiddenGlassSurface = 'transcript' | 'settingsRow';

export type BlurViewAttributes = {
  'blur-effect'?: LynxBlurEffect;
  'glass-style'?: LynxGlassStyle;
  'glass-interactive'?: boolean;
  'glass-tint-color'?: string;
  spacing?: number;
  'blur-radius'?: string;
  'blur-sampling'?: number;
  'enable-auto-blur'?: boolean;
  'android-capture-target'?: string;
};

export type GlassResolveInput = {
  surface: GlassSurfaceKind;
  platform: LynxHostPlatform;
  iosMajorVersion?: number;
  themeVariant: 'light' | 'dark';
  /** Mode B host chrome already owns the dock — Lynx must not skin it. */
  fullPageAutoGlassSkin: boolean;
  tintToken?: string;
};

export const IOS_GLASS_MAJOR = 26;

export const ANDROID_DOCK_BLUR_RADIUS = '20px';
export const ANDROID_BLUR_SAMPLING = 6;

export type GlassNativeMapping =
  | {
    platform: 'ios';
    uiKitClass: 'UIGlassEffect' | 'UIGlassContainerEffect' | 'UIBlurEffect' | null;
  }
  | {
    platform: 'android';
    uiKitClass: null;
    downgrade: 'blur-radius';
  };

export function mapsToUiKitClass(attrs: BlurViewAttributes): GlassNativeMapping['uiKitClass'] {
  if (attrs['blur-effect'] === 'glass-container') return 'UIGlassContainerEffect';
  if (attrs['blur-effect'] === 'glass') return 'UIGlassEffect';
  if (attrs['blur-effect'] === 'light' || attrs['blur-effect'] === 'dark' || attrs['blur-effect'] === 'extra-light') {
    return 'UIBlurEffect';
  }
  return null;
}

export function isGlassChromeSurface(surface: string): surface is GlassSurfaceKind {
  return surface === 'dock'
    || surface === 'dockItem'
    || surface === 'searchChip'
    || surface === 'headerButton'
    || surface === 'composerPill'
    || surface === 'composerCard';
}

export function mustNotWrapWithGlass(surface: ForbiddenGlassSurface): true {
  return surface === 'transcript' || surface === 'settingsRow';
}

function iosLegacyBlur(themeVariant: 'light' | 'dark'): LynxBlurEffect {
  return themeVariant === 'dark' ? 'dark' : 'light';
}

function iosGlassAvailable(iosMajorVersion: number | undefined): boolean {
  return (iosMajorVersion ?? 0) >= IOS_GLASS_MAJOR;
}

/**
 * Resolve `<blur-view>` attributes for chrome. Returns null when Lynx must not
 * paint glass (Mode B dock, or a non-chrome surface).
 */
export function resolveBlurViewAttributes(input: GlassResolveInput): BlurViewAttributes | null {
  if (input.surface === 'dock' && !input.fullPageAutoGlassSkin) {
    return null;
  }

  if (input.platform === 'android') {
    return {
      'blur-radius': ANDROID_DOCK_BLUR_RADIUS,
      'blur-sampling': ANDROID_BLUR_SAMPLING,
      'enable-auto-blur': true,
    };
  }

  if (!iosGlassAvailable(input.iosMajorVersion)) {
    return { 'blur-effect': iosLegacyBlur(input.themeVariant) };
  }

  const interactive = input.surface === 'dockItem'
    || input.surface === 'composerPill'
    || input.surface === 'composerCard'
    || input.surface === 'searchChip'
    || input.surface === 'headerButton';

  if (input.surface === 'dock') {
    return {
      'blur-effect': 'glass-container',
      'glass-style': 'regular',
      'glass-interactive': false,
      'glass-tint-color': input.tintToken ?? 'transparent',
      spacing: 12,
    };
  }

  return {
    'blur-effect': 'glass',
    'glass-style': input.surface === 'composerCard' ? 'regular' : 'regular',
    'glass-interactive': interactive,
    'glass-tint-color': input.tintToken ?? 'transparent',
  };
}

export function describeGlassMapping(attrs: BlurViewAttributes | null, platform: LynxHostPlatform): GlassNativeMapping {
  if (platform === 'android') {
    return { platform: 'android', uiKitClass: null, downgrade: 'blur-radius' };
  }
  return { platform: 'ios', uiKitClass: attrs ? mapsToUiKitClass(attrs) : null };
}

export function androidAttrsContainIosGlass(attrs: BlurViewAttributes): boolean {
  return attrs['blur-effect'] === 'glass'
    || attrs['blur-effect'] === 'glass-container'
    || attrs['glass-style'] !== undefined
    || attrs['glass-interactive'] !== undefined
    || attrs['glass-tint-color'] !== undefined
    || attrs.spacing !== undefined;
}
