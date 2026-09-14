import { useEffect, useRef } from 'react';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import { markLynxAssistantContactRead } from './api';
import { resolveLynxAssistantOpenReadPosition } from './unread';
import type { LynxAssistantReadPosition } from './types';

export type LynxAssistantReadMarkerProps = {
  runtimeFetch?: LynxRuntimeFetch | null;
  assistantId: string;
  /** Snapshot readTip — never invent a position when absent. */
  readTip?: LynxAssistantReadPosition | null;
  viewing?: boolean;
  onMarked?: () => void;
  onMarkFailed?: (error: Error) => void;
};

/**
 * Portable Lynx spirit of Cap `AssistantReadMarker`.
 *
 * Cap uses IntersectionObserver + transcript bottom + focus/visibility.
 * Lynx has no host geometry binder, so this marks **open / latest-visible**
 * using the snapshot `readTip` only while the assistant conversation is
 * showing. Failure stays failed — no fake mark-success.
 *
 * Host residual: IntersectionObserver, scroll-at-bottom, visualViewport,
 * document focus/visibility, 15s retry interval.
 */
export function LynxAssistantReadMarker({
  runtimeFetch = null,
  assistantId,
  readTip = null,
  viewing = true,
  onMarked,
  onMarkFailed,
}: LynxAssistantReadMarkerProps) {
  const flight = useRef(false);
  const position = resolveLynxAssistantOpenReadPosition({ viewing, readTip });

  useEffect(() => {
    if (!runtimeFetch || !assistantId.trim() || !position || flight.current) return;
    flight.current = true;
    let cancelled = false;
    void (async () => {
      const outcome = await markLynxAssistantContactRead(runtimeFetch, assistantId, position);
      if (cancelled) return;
      if (outcome.status === 'ok') {
        onMarked?.();
        return;
      }
      flight.current = false;
      if (outcome.status === 'failed') {
        onMarkFailed?.(outcome.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, assistantId, position?.generation, position?.ordinal, position?.messageID]);

  return null;
}
