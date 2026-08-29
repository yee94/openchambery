/** iPhone 1× baseline: 1pt = 1/163 inch. */
export const DESIGN_PT_PER_INCH = 163;
export const DESIGN_PT_SCALE_MIN = 0.85;
export const DESIGN_PT_SCALE_MAX = 1.2;
/**
 * Shared Capacitor --dpt. Trial so Android matches the iOS readability lift
 * (previous Android 1.05 / cap 1 read smaller). Same number on both shells.
 */
export const MOBILE_DESIGN_PT_SCALE = 10 / 9;
export const IOS_DESIGN_PT_SCALE = MOBILE_DESIGN_PT_SCALE;
export const ANDROID_DESIGN_PT_SCALE_MAX = MOBILE_DESIGN_PT_SCALE;
export const ANDROID_DESIGN_PT_SCALE_DEFAULT = MOBILE_DESIGN_PT_SCALE;
/** v4 invalidates v3 (Android 1.05 / ~0.945) so the iOS-matched scale lands. */
export const DESIGN_PT_STORAGE_KEY = 'openchamber.designPtScale.v4';

export interface PhysicalScaleMetrics {
  xdpi: number;
  ydpi: number;
  density: number;
}

export function clampDesignPtScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(DESIGN_PT_SCALE_MAX, Math.max(DESIGN_PT_SCALE_MIN, value));
}

/**
 * Android used to scale from DisplayMetrics so 1dpt ≈ 1/163in. This trial
 * returns the shared mobile scale so Android matches iOS.
 */
export function computeDesignPtScale(_metrics: PhysicalScaleMetrics | null | undefined): number {
  return MOBILE_DESIGN_PT_SCALE;
}

export function readCachedDesignPtScale(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const platform = capacitor?.getPlatform?.();
    if (platform === 'android' || platform === 'ios') {
      return MOBILE_DESIGN_PT_SCALE;
    }
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
  if (Capacitor.getPlatform() === 'ios' || Capacitor.getPlatform() === 'android') {
    applyDesignPtScaleToRoot(MOBILE_DESIGN_PT_SCALE);
    writeCachedDesignPtScale(MOBILE_DESIGN_PT_SCALE);
    return MOBILE_DESIGN_PT_SCALE;
  }
  applyDesignPtScaleToRoot(1);
  return 1;
}
