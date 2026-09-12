import { raceWithTimeout } from '../connection/http';

export type LynxAutoConnectPhase = 'pending' | 'attempting' | 'done';

export type LynxConnectGate =
  | { kind: 'splash'; phase: Exclude<LynxAutoConnectPhase, 'done'>; label: string | null }
  | { kind: 'welcome' }
  | { kind: 'connected' };

/** Cap-like bound so a hanging probe cannot keep the splash forever. */
export const AUTO_CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

/**
 * Cap MobileApp auto-connect gate:
 * - splash while auto-connect resolves
 * - welcome when done and not connected
 * - connected shell when runtime is live
 */
export function resolveLynxConnectGate(input: {
  phase: LynxAutoConnectPhase;
  connected: boolean;
  autoConnectLabel?: string | null;
}): LynxConnectGate {
  if (input.connected) return { kind: 'connected' };
  if (input.phase !== 'done') {
    return {
      kind: 'splash',
      phase: input.phase,
      label: input.autoConnectLabel ?? null,
    };
  }
  return { kind: 'welcome' };
}

export function nextAutoConnectPhase(
  current: LynxAutoConnectPhase,
  event: 'start' | 'finish',
): LynxAutoConnectPhase {
  if (event === 'start' && current === 'pending') return 'attempting';
  if (event === 'finish') return 'done';
  return current;
}

/**
 * Initial gate phase. Skip splash when auto-connect is disabled or there is no
 * saved token to attempt — otherwise a Lynx useEffect that never settles leaves
 * the user forever on "Connecting…".
 */
export function initialAutoConnectPhase(input: {
  skipAutoConnect?: boolean;
  hasSavedToken: boolean;
}): LynxAutoConnectPhase {
  if (input.skipAutoConnect || !input.hasSavedToken) return 'done';
  return 'pending';
}

export function shouldAttemptAutoConnect(input: {
  skipAutoConnect?: boolean;
  hasSavedToken: boolean;
}): boolean {
  return !input.skipAutoConnect && input.hasSavedToken;
}

/**
 * Race an auto-connect attempt with a short timeout. Timeout / reject → false
 * so the caller can always finish the phase machine → welcome UI.
 */
export async function raceAutoConnectAttempt(
  attempt: Promise<boolean>,
  timeoutMs: number = AUTO_CONNECT_ATTEMPT_TIMEOUT_MS,
): Promise<boolean> {
  const settled = await raceWithTimeout(
    timeoutMs,
    attempt.then((ok) => ok).catch(() => false),
  );
  return settled === true;
}
