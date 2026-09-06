/**
 * Cap `OpenChamberHaptics` adapter for Lynx.
 *
 * Methods mirror packages/mobile/contracts/openchamber-haptics.mjs:
 *   impactLight | impactMedium | impactHeavy
 *
 * Host injects the native binder. Without a host adapter, calls return
 * `unavailable` — never fake-success.
 *
 * Source Cap JS: packages/ui/src/hooks/streamingHaptics.ts
 */

export type LynxHapticStrength = 'light' | 'medium' | 'heavy';

export type LynxHapticsNativeBinder = {
  impactLight: () => Promise<void>;
  impactMedium: () => Promise<void>;
  impactHeavy: () => Promise<void>;
};

export type LynxHapticResult =
  | { status: 'ok'; strength: LynxHapticStrength }
  | { status: 'unavailable'; reason: 'no-host' | 'host-rejected' }
  | { status: 'failed'; error: string };

export type LynxHapticsAdapter = {
  /** Host injects Cap OpenChamberHaptics-equivalent methods. */
  inject: (binder: LynxHapticsNativeBinder | null) => void;
  /** True when a host binder is present. */
  isAvailable: () => boolean;
  /** Fire impact. No host → unavailable (not ok). */
  impact: (strength?: LynxHapticStrength) => Promise<LynxHapticResult>;
};

export const resolveLynxHapticMethod = (
  strength: LynxHapticStrength,
): keyof LynxHapticsNativeBinder => {
  switch (strength) {
    case 'medium':
      return 'impactMedium';
    case 'heavy':
      return 'impactHeavy';
    case 'light':
    default:
      return 'impactLight';
  }
};

/** Cap contract method names — keep in sync with openchamber-haptics.mjs. */
export const LYNX_HAPTICS_CONTRACT = {
  pluginName: 'OpenChamberHaptics',
  methods: ['impactLight', 'impactMedium', 'impactHeavy'] as const,
  platforms: ['ios', 'android'] as const,
} as const;

export const createLynxHapticsAdapter = (): LynxHapticsAdapter => {
  let binder: LynxHapticsNativeBinder | null = null;

  return {
    inject: (next) => {
      binder = next;
    },
    isAvailable: () => binder !== null,
    impact: async (strength = 'light'): Promise<LynxHapticResult> => {
      if (!binder) return { status: 'unavailable', reason: 'no-host' };
      const method = resolveLynxHapticMethod(strength);
      const fn = binder[method];
      if (typeof fn !== 'function') {
        return { status: 'unavailable', reason: 'host-rejected' };
      }
      try {
        await fn.call(binder);
        return { status: 'ok', strength };
      } catch (error) {
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
};

/**
 * Apply edge-swipe haptic effects through the adapter.
 * Returns false when host is missing — callers must not treat that as success.
 */
export const applyLynxEdgeSwipeHaptic = async (
  adapter: LynxHapticsAdapter,
  strength: LynxHapticStrength,
): Promise<boolean> => {
  const result = await adapter.impact(strength);
  return result.status === 'ok';
};
