/** iPhone 1× baseline: 1pt = 1/163 inch. */
export const DESIGN_PT_PER_INCH = 163;
export const DESIGN_PT_SCALE_MIN = 0.85;
export const DESIGN_PT_SCALE_MAX = 1.2;
/** iOS --dpt. Confirmed readability lift from the previous 1.0. */
export const IOS_DESIGN_PT_SCALE = 10 / 9;
/**
 * Previous Android ceiling. Typical xdpi/density math already lands at or
 * below this, so raising only the cap is a no-op — the result stays 0.9.
 */
export const ANDROID_DESIGN_PT_PREVIOUS_CAP = 0.9;
/**
 * Android --dpt ceiling. Halfway from the old 0.9 (a bit small) toward 1
 * (too large). Applied as a multiply so phones already at ~0.9 actually move.
 */
export const ANDROID_DESIGN_PT_SCALE_MAX = 0.95;
export const ANDROID_DESIGN_PT_READABILITY_BUMP =
  ANDROID_DESIGN_PT_SCALE_MAX / ANDROID_DESIGN_PT_PREVIOUS_CAP;
/** v7 invalidates v6 (raw 0.9) so the 0.95 lift is not masked. */
export const DESIGN_PT_STORAGE_KEY = 'openchamber.designPtScale.v7';

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
 * CSS px per physical inch is ppi/density in Android WebView (1 CSS px = 1 dp).
 * Scale so 1 design pt ≈ 1/163 inch, multiply by the 0.9→0.95 lift, then cap.
 */
export function computeDesignPtScale(metrics: PhysicalScaleMetrics | null | undefined): number {
  if (!metrics) return ANDROID_DESIGN_PT_SCALE_MAX;
  const density = metrics.density;
  const ppi = (metrics.xdpi + metrics.ydpi) / 2;
  if (!(density > 0) || !(ppi >= 50) || ppi > 800) return ANDROID_DESIGN_PT_SCALE_MAX;
  const physical = clampDesignPtScale((ppi / density) / DESIGN_PT_PER_INCH);
  return Math.min(ANDROID_DESIGN_PT_SCALE_MAX, physical * ANDROID_DESIGN_PT_READABILITY_BUMP);
}

export function readCachedDesignPtScale(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = Number.parseFloat(window.localStorage.getItem(DESIGN_PT_STORAGE_KEY) ?? '');
    const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const platform = capacitor?.getPlatform?.();
    if (platform === 'android') {
      return Math.min(ANDROID_DESIGN_PT_SCALE_MAX, clampDesignPtScale(raw));
    }
    if (platform === 'ios') {
      return IOS_DESIGN_PT_SCALE;
    }
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
  const { Capacitor, registerPlugin } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) {
    applyDesignPtScaleToRoot(1);
    return 1;
  }
  if (Capacitor.getPlatform() === 'ios') {
    applyDesignPtScaleToRoot(IOS_DESIGN_PT_SCALE);
    writeCachedDesignPtScale(IOS_DESIGN_PT_SCALE);
    return IOS_DESIGN_PT_SCALE;
  }
  if (Capacitor.getPlatform() !== 'android') {
    applyDesignPtScaleToRoot(1);
    return 1;
  }
  if (!Capacitor.isPluginAvailable('OpenChamberPhysicalScale')) {
    applyDesignPtScaleToRoot(ANDROID_DESIGN_PT_SCALE_MAX);
    writeCachedDesignPtScale(ANDROID_DESIGN_PT_SCALE_MAX);
    return ANDROID_DESIGN_PT_SCALE_MAX;
  }
  try {
    const PhysicalScale = registerPlugin<{ getMetrics: () => Promise<PhysicalScaleMetrics> }>(
      'OpenChamberPhysicalScale',
    );
    const metrics = await PhysicalScale.getMetrics();
    const scale = computeDesignPtScale(metrics);
    writeCachedDesignPtScale(scale);
    applyDesignPtScaleToRoot(scale);
    return scale;
  } catch {
    applyDesignPtScaleToRoot(ANDROID_DESIGN_PT_SCALE_MAX);
    writeCachedDesignPtScale(ANDROID_DESIGN_PT_SCALE_MAX);
    return ANDROID_DESIGN_PT_SCALE_MAX;
  }
}
