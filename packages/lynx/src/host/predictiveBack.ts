/**
 * Predictive / edge-back contract for Lynx shell.
 *
 * Cap + Flutter history: two owners of the back edge = 真机残差.
 * Lynx JS publishes ownership policy; host binds pan / OnBackInvokedCallback
 * and feeds progress into the bridge (`backProgress` / `backCommit` / `backCancel`
 * and predictive* variants).
 *
 * See docs/lynx-ia-ui.md (gesture arena) and host/README.md.
 */

export const LYNX_PREDICTIVE_BACK_EDGE_WIDTH = 28;

export type LynxPredictiveBackOwner = 'host' | 'lynx';

export type LynxPredictiveBackPolicy = {
  owner: LynxPredictiveBackOwner;
  edgeWidthPoints: number;
  /** When true, host must not steal the composer session-swipe surface. */
  composerSessionSwipeActive: boolean;
  secondaryVisible: boolean;
};

export type LynxPredictiveBackInput = {
  secondaryVisible: boolean;
  /** Composer edge-swipe machine is actively tracking a pan. */
  composerSessionSwipeActive?: boolean;
  edgeWidthPoints?: number;
};

/**
 * Resolve who owns the screen-edge back gesture.
 * Composer session swipe (explicit surface) temporarily claims Lynx ownership
 * so Predictive Back does not fight session switch.
 */
export const resolveLynxPredictiveBackPolicy = (
  input: LynxPredictiveBackInput,
): LynxPredictiveBackPolicy => {
  const edgeWidthPoints = input.edgeWidthPoints ?? LYNX_PREDICTIVE_BACK_EDGE_WIDTH;
  const composerSessionSwipeActive = Boolean(input.composerSessionSwipeActive);
  if (composerSessionSwipeActive) {
    return {
      owner: 'lynx',
      edgeWidthPoints,
      composerSessionSwipeActive: true,
      secondaryVisible: input.secondaryVisible,
    };
  }
  return {
    owner: 'host',
    edgeWidthPoints,
    composerSessionSwipeActive: false,
    secondaryVisible: input.secondaryVisible,
  };
};

export type LynxPredictiveBackBridgeEvent =
  | { type: 'predictiveBackProgress'; progress: number }
  | { type: 'predictiveBackCommit' }
  | { type: 'predictiveBackCancel' };

/** Clamp host-reported progress into [0, 1]. */
export const clampLynxBackProgress = (progress: number): number => {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
};

/**
 * Shell wiring notes (for host + docs — not runtime):
 * 1. Mode B host tab chrome: UINavigationController interactive pop OR Predictive Back.
 * 2. Mode A Lynx dock: host still owns system back; Lynx secondary listens to bridge.
 * 3. Android API 34+: OnBackInvokedCallback → predictiveBackProgress/Commit.
 * 4. Never install both a Lynx full-screen edge pan and host Predictive Back on the same edge.
 */
export const LYNX_PREDICTIVE_BACK_WIRING_NOTES = [
  'Host owns Predictive Back / system edge unless composer session-swipe is active.',
  'Feed progress via LynxHostBridgeEvent backProgress / predictiveBack* variants.',
  'On commit: Lynx reduceLynxNavigation({ type: "pop" }) — native must not pop a parallel stack.',
  'Android enableOnBackInvokedCallback=true in Manifest (host scaffold).',
] as const;
