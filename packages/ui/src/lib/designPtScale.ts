/** iPhone 1× baseline: 1pt = 1/163 inch. */
export const DESIGN_PT_PER_INCH = 163;
export const DESIGN_PT_SCALE_MIN = 0.85;
export const DESIGN_PT_SCALE_MAX = 1.2;
/** Temporary Android experiment: never let --dpt exceed 0.9. iOS stays 1. */
export const ANDROID_DESIGN_PT_SCALE_MAX = 0.9;
export const DESIGN_PT_STORAGE_KEY = 'openchamber.designPtScale.v1';

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
 * Scale so 1 design pt ≈ 1/163 inch. iOS stays 1.
 */
export function computeDesignPtScale(metrics: PhysicalScaleMetrics | null | undefined): number {
  if (!metrics) return ANDROID_DESIGN_PT_SCALE_MAX;
  const density = metrics.density;
  const ppi = (metrics.xdpi + metrics.ydpi) / 2;
  if (!(density > 0) || !(ppi >= 50) || ppi > 800) return ANDROID_DESIGN_PT_SCALE_MAX;
  return Math.min(
    ANDROID_DESIGN_PT_SCALE_MAX,
    clampDesignPtScale((ppi / density) / DESIGN_PT_PER_INCH),
  );
}

export function readCachedDesignPtScale(): number {
  if (typeof window === 'undefined') return 1;
  try {
    const raw = Number.parseFloat(window.localStorage.getItem(DESIGN_PT_STORAGE_KEY) ?? '');
    // Android Capacitor must never restore a pre-cap cache (e.g. 1.04 written
    // by early physical-math builds) above the experiment ceiling.
    const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    if (capacitor?.getPlatform?.() === 'android') {
      return Math.min(ANDROID_DESIGN_PT_SCALE_MAX, clampDesignPtScale(raw));
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
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
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
