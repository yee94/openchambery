/** iPhone 1× baseline: 1pt = 1/163 inch. */
export const DESIGN_PT_PER_INCH = 163;
export const DESIGN_PT_SCALE_MIN = 0.85;
export const DESIGN_PT_SCALE_MAX = 1.2;
/** iOS --dpt. Confirmed readability lift from the previous 1.0. */
export const IOS_DESIGN_PT_SCALE = 10 / 9;
/**
 * Android --dpt. Forced to 1 (not physical math, which often lands at ~0.9
 * and looks unchanged). 10/9 matches iOS numerically but reads far too large
 * because WebView CSS px is 1 dp.
 */
export const ANDROID_DESIGN_PT_SCALE = 1;
export const ANDROID_DESIGN_PT_SCALE_MAX = ANDROID_DESIGN_PT_SCALE;
export const ANDROID_DESIGN_PT_SCALE_DEFAULT = ANDROID_DESIGN_PT_SCALE;
/** v5 invalidates v4 (shared 10/9) so Android is not stuck at the iOS trial. */
export const DESIGN_PT_STORAGE_KEY = 'openchamber.designPtScale.v5';

export interface PhysicalScaleMetrics {
  xdpi: number;
  ydpi: number;
  density: number;
}

export function clampDesignPtScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(DESIGN_PT_SCALE_MAX, Math.max(DESIGN_PT_SCALE_MIN, value));
}

/** Android scale is pinned to 1. Physical metrics are not applied. */
export function computeDesignPtScale(_metrics: PhysicalScaleMetrics | null | undefined): number {
  return ANDROID_DESIGN_PT_SCALE;
}

function nativeDesignPtScale(platform: string | undefined): number | null {
  if (platform === 'android') return ANDROID_DESIGN_PT_SCALE;
  if (platform === 'ios') return IOS_DESIGN_PT_SCALE;
  return null;
}

export function readCachedDesignPtScale(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const pinned = nativeDesignPtScale(capacitor?.getPlatform?.());
    if (pinned != null) return pinned;
    const raw = Number.parseFloat(window.localStorage.getItem(DESIGN_PT_STORAGE_KEY) ?? '');
    return clampDesignPtScale(raw);
  } catch {
    return 1;
  }
}

export function writeCachedDesignPtScale(scale: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, String(scale));
  } catch {
    // Restricted storage keeps the in-memory CSS variable for this session.
  }
}

export function applyDesignPtScaleToRoot(scale: number, root: HTMLElement = document.documentElement): void {
  const next = clampDesignPtScale(scale);
  root.style.setProperty('--dpt', `${next}px`);
  // Unitless twin for multiplying unitless scales (e.g. --padding-scale on
  // icons). `calc(1rem * var(--dpt))` would be invalid — lengths cannot
  // multiply lengths.
  root.style.setProperty('--dpt-n', String(next));
}

export async function applyDesignPtScaleFromNative(): Promise<number> {
  if (typeof document === 'undefined') return 1;
  const cached = readCachedDesignPtScale();
  applyDesignPtScaleToRoot(cached);
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) {
    applyDesignPtScaleToRoot(1);
    return 1;
  }
  const pinned = nativeDesignPtScale(Capacitor.getPlatform());
  if (pinned != null) {
    applyDesignPtScaleToRoot(pinned);
    writeCachedDesignPtScale(pinned);
    return pinned;
  }
  applyDesignPtScaleToRoot(1);
  return 1;
}
