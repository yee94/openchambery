/** iPhone 1× baseline: 1pt = 1/163 inch. */
export const DESIGN_PT_PER_INCH = 163;
export const DESIGN_PT_SCALE_MIN = 0.85;
export const DESIGN_PT_SCALE_MAX = 1.2;
/** Android --dpt ceiling. Was 0.9 as a visibility experiment. */
export const ANDROID_DESIGN_PT_SCALE_MAX = 1;
/**
 * iOS --dpt. Same 10/9 bump as lifting the Android ceiling from 0.9 → 1,
 * so fonts and `--padding-scale` grow together on both native platforms.
 */
export const IOS_DESIGN_PT_SCALE = 10 / 9;
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
 * Scale so 1 design pt ≈ 1/163 inch, then cap at ANDROID_DESIGN_PT_SCALE_MAX.
 * iOS uses IOS_DESIGN_PT_SCALE (same 10/9 bump as lifting the Android ceiling).
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
    // by early physical-math builds) above the Android ceiling. iOS always
    // uses the readability bump — do not restore a stale 1.0 from before it.
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
