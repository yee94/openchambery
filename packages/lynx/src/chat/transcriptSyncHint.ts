/**
 * Cap `useMobileTranscriptSyncHint` semantics for Lynx.
 *
 * WeChat-style "syncing" whisper with show-delay / hide-grace hysteresis.
 * Portable inputs only — do **not** invent Cap Zustand transcript-authority /
 * resync flight registries. ChatScreen maps honest Lynx signals:
 * timeline hydrate / user overflow refresh / SSE live-tail connection phase.
 *
 * Source: packages/ui/src/mobile/chat/useMobileTranscriptSyncHint.ts
 */

export type LynxTranscriptSyncHintKind = 'syncing';

export type LynxTranscriptSyncHintInput = {
  sessionId: string;
  hasTranscript: boolean;
  loadStatus?: 'loading' | 'ready' | 'error';
  userRefreshInFlight: boolean;
  /**
   * Optional honest background catch-up. Cap uses dedicated flight registries;
   * Lynx leaves this false unless the shell has a real reload-in-flight signal
   * (never invent Zustand stores).
   */
  backgroundResyncInFlight: boolean;
  isConnected: boolean;
  connectionPhase: 'connecting' | 'connected' | 'reconnecting';
};

/**
 * When the chat title should show a WeChat-style sync whisper.
 *
 * Warm prefetch `loading` is ignored once a transcript is present. Live work
 * that proves the page is chasing the remote state shows even when a transcript
 * is already present: user refresh or an honest background resync flag. Socket
 * `reconnecting` alone stays hidden for warm transcripts. Cold first paint and
 * reconnect-before-any-messages keep their original signals.
 */
export function resolveLynxTranscriptSyncHint(
  input: LynxTranscriptSyncHintInput,
): LynxTranscriptSyncHintKind | null {
  if (!input.sessionId) return null;
  if (input.userRefreshInFlight) return 'syncing';
  if (input.backgroundResyncInFlight) return 'syncing';
  if (input.hasTranscript) return null;
  if (!input.isConnected && input.connectionPhase === 'reconnecting') return 'syncing';
  if (input.loadStatus === 'loading') return 'syncing';
  return null;
}

export const LYNX_SYNC_HINT_SHOW_DELAY_MS = 250;
export const LYNX_SYNC_HINT_HIDE_GRACE_MS = 1000;

/**
 * Display-level hysteresis for the sync whisper.
 * Delays showing (sub-delay blips never render) and grace-extends hiding
 * (relayed flights render as one continuous whisper).
 */
export function createLynxSyncHintSmoother(
  onChange: (visible: boolean) => void,
  options?: { showDelayMs?: number; hideGraceMs?: number },
) {
  const showDelayMs = options?.showDelayMs ?? LYNX_SYNC_HINT_SHOW_DELAY_MS;
  const hideGraceMs = options?.hideGraceMs ?? LYNX_SYNC_HINT_HIDE_GRACE_MS;
  let raw = false;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const apply = () => {
    timer = null;
    if (visible === raw) return;
    visible = raw;
    onChange(visible);
  };

  return {
    setRaw(next: boolean) {
      raw = next;
      if (timer) clearTimeout(timer);
      timer = setTimeout(apply, raw ? showDelayMs : hideGraceMs);
    },
    cancel() {
      raw = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export type LynxSyncHintConnectionPhase = LynxTranscriptSyncHintInput['connectionPhase'];

/**
 * Map Lynx live-tail connection state → Cap-shaped connection phase.
 * `idle` / `closed` / `failed` with a runtime still count as connected for the
 * warm-transcript gate (HTTP catch-up can finish while SSE backs off).
 */
export function mapLynxLiveConnectionToSyncPhase(
  live: 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed' | 'failed',
  hasRuntime: boolean,
): { isConnected: boolean; connectionPhase: LynxSyncHintConnectionPhase } {
  if (!hasRuntime) {
    return { isConnected: false, connectionPhase: 'connecting' };
  }
  if (live === 'connecting') {
    return { isConnected: false, connectionPhase: 'connecting' };
  }
  if (live === 'reconnecting') {
    return { isConnected: false, connectionPhase: 'reconnecting' };
  }
  return { isConnected: true, connectionPhase: 'connected' };
}

/** Derive Cap-shaped loadStatus from Lynx timeline hydrate / error flags. */
export function deriveLynxTranscriptLoadStatus(input: {
  hydrated: boolean;
  initialError: string | null;
}): 'loading' | 'ready' | 'error' {
  if (input.initialError) return 'error';
  if (!input.hydrated) return 'loading';
  return 'ready';
}
