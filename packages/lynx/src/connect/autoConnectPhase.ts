export type LynxAutoConnectPhase = 'pending' | 'attempting' | 'done';

export type LynxConnectGate =
  | { kind: 'splash'; phase: Exclude<LynxAutoConnectPhase, 'done'>; label: string | null }
  | { kind: 'welcome' }
  | { kind: 'connected' };

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
