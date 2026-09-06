/**
 * Cap `markdownPinReveal.ts` spirit for Lynx LegendList.
 *
 * Cold-open / jump-to-latest: hide timeline (visibility) until seed-window
 * rows report ready, then reveal once so highlight height thrash cannot yank
 * the end pin. Streaming live-tail must not re-arm.
 *
 * Lynx host may map `pending` → native list visibility; JS owns the pure
 * arm/ready/timeout state machine.
 *
 * Source: packages/ui/src/components/chat/lib/markdownPinReveal.ts
 */

export const LYNX_MARKDOWN_READY_ATTR = 'data-markdown-ready';
export const LYNX_MARKDOWN_PIN_REVEAL_ATTR = 'data-markdown-pin-reveal';
export const LYNX_MARKDOWN_PIN_REVEAL_TIMEOUT_MS = 600;
/** Cap INITIAL_MARKDOWN_HYDRATION_SEED — bottom-entering keys the pin waits on. */
export const LYNX_MARKDOWN_PIN_SEED_COUNT = 12;

export type LynxMarkdownPinRevealReason = 'session-open' | 'jump-to-latest';

export type LynxMarkdownPinRevealPhase = 'idle' | 'pending' | 'ready';

export const createLynxInitialMarkdownSeedKeys = (
  entryKeys: readonly string[],
  options?: {
    seedCount?: number;
    restore?: ReadonlySet<string> | null;
  },
): string[] => {
  const seedCount = Math.max(1, Math.floor(options?.seedCount ?? LYNX_MARKDOWN_PIN_SEED_COUNT));
  const seeded = new Set<string>();
  for (
    let index = Math.max(0, entryKeys.length - seedCount);
    index < entryKeys.length;
    index += 1
  ) {
    const key = entryKeys[index];
    if (key) seeded.add(key);
  }
  const restore = options?.restore;
  if (restore && restore.size > 0) {
    const valid = new Set(entryKeys);
    for (const key of restore) {
      if (valid.has(key)) seeded.add(key);
    }
  }
  return [...seeded];
};

export const resolveLynxMarkdownPinRevealKeys = (input: {
  entryKeys: readonly string[];
  seedCount?: number;
  restore?: ReadonlySet<string> | null;
}): string[] => createLynxInitialMarkdownSeedKeys(input.entryKeys, {
  seedCount: input.seedCount,
  restore: input.restore,
});

export const shouldArmLynxMarkdownPinReveal = (input: {
  reason: LynxMarkdownPinRevealReason;
  alreadyRevealedForScope: boolean;
}): boolean => {
  if (input.reason === 'jump-to-latest') return true;
  return !input.alreadyRevealedForScope;
};

export type LynxMarkdownPinRevealState = {
  phase: LynxMarkdownPinRevealPhase;
  generation: number;
  relevantKeys: readonly string[];
  alreadyRevealedForScope: boolean;
  scopeKey: string;
};

export const createLynxMarkdownPinRevealState = (
  scopeKey = '',
): LynxMarkdownPinRevealState => ({
  phase: 'idle',
  generation: 0,
  relevantKeys: [],
  alreadyRevealedForScope: false,
  scopeKey,
});

/**
 * Arm pin reveal for a session-open / jump-to-latest.
 * Live-tail growth must call with reason that does not re-arm after ready.
 */
export const armLynxMarkdownPinReveal = (
  state: LynxMarkdownPinRevealState,
  input: {
    reason: LynxMarkdownPinRevealReason;
    entryKeys: readonly string[];
    scopeKey: string;
    seedCount?: number;
  },
): LynxMarkdownPinRevealState => {
  const scopeChanged = input.scopeKey !== state.scopeKey;
  const already = scopeChanged ? false : state.alreadyRevealedForScope;
  if (!shouldArmLynxMarkdownPinReveal({
    reason: input.reason,
    alreadyRevealedForScope: already,
  })) {
    return {
      ...state,
      scopeKey: input.scopeKey,
      alreadyRevealedForScope: already,
      phase: already ? 'ready' : state.phase,
    };
  }
  const relevantKeys = resolveLynxMarkdownPinRevealKeys({
    entryKeys: input.entryKeys,
    seedCount: input.seedCount,
  });
  // Empty transcript is ready immediately.
  if (relevantKeys.length === 0) {
    return {
      phase: 'ready',
      generation: state.generation + 1,
      relevantKeys,
      alreadyRevealedForScope: true,
      scopeKey: input.scopeKey,
    };
  }
  return {
    phase: 'pending',
    generation: state.generation + 1,
    relevantKeys,
    alreadyRevealedForScope: false,
    scopeKey: input.scopeKey,
  };
};

export const markLynxMarkdownPinReady = (
  state: LynxMarkdownPinRevealState,
): LynxMarkdownPinRevealState => {
  if (state.phase !== 'pending') return state;
  return {
    ...state,
    phase: 'ready',
    alreadyRevealedForScope: true,
  };
};

/**
 * Pure readiness check — host reports which seed keys have painted ready.
 * Unreported keys are ignored only when `mountedReadyKeys` is the mounted set;
 * empty seed → ready.
 */
export const areLynxMarkdownSeedRowsReady = (input: {
  relevantKeys: readonly string[];
  mountedReadyKeys: ReadonlySet<string>;
}): boolean => {
  if (input.relevantKeys.length === 0) return true;
  let sawRelevant = false;
  for (const key of input.relevantKeys) {
    if (!input.mountedReadyKeys.has(key)) continue;
    sawRelevant = true;
  }
  // Cap: unmounted seed keys are ignored; if none of the seed mounted yet,
  // we are not ready (timeout still covers). If some mounted, all mounted
  // ones must be ready — here mountedReadyKeys is already the ready subset,
  // so we need every *mounted* relevant key to appear in mountedReadyKeys.
  // Caller passes only keys that are both mounted AND ready; we approximate
  // Cap by requiring at least one relevant key ready OR empty seed.
  return sawRelevant;
};

/**
 * Stronger check when host can report mounted keys separately from ready.
 */
export const areLynxMountedRelevantMarkdownRowsReady = (input: {
  relevantKeys: readonly string[];
  mountedKeys: ReadonlySet<string>;
  readyKeys: ReadonlySet<string>;
}): boolean => {
  if (input.relevantKeys.length === 0) return true;
  let sawRelevant = false;
  for (const key of input.relevantKeys) {
    if (!input.mountedKeys.has(key)) continue;
    sawRelevant = true;
    if (!input.readyKeys.has(key)) return false;
  }
  return sawRelevant;
};

export const lynxMarkdownPinRevealVisibility = (
  phase: LynxMarkdownPinRevealPhase,
): 'hidden' | 'visible' => (phase === 'pending' ? 'hidden' : 'visible');

export const mergeLynxMarkdownPinRevealStyle = (
  style: Record<string, string | number> | undefined,
  phase: LynxMarkdownPinRevealPhase,
): Record<string, string | number> | undefined => {
  if (phase !== 'pending') return style;
  return { ...(style ?? {}), visibility: 'hidden' };
};
