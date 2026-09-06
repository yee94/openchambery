import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useConnection } from '@/context/ConnectionContext';
import {
  buildSessionHomeModel,
  type SessionHomeModel,
} from '@/lib/sessionHomeModel';
import {
  loadSessionIndexSnapshot,
  SessionIndexError,
  type SessionIndexSnapshot,
} from '@/lib/sessionIndex';

export type SessionHomeStatus = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export type SessionHomeState = {
  status: SessionHomeStatus;
  model: SessionHomeModel | null;
  snapshot: SessionIndexSnapshot | null;
  error: string | null;
  refresh: () => Promise<void>;
};

const emptyModel = (): SessionHomeModel => ({
  pinned: [],
  inProgress: [],
  directories: [],
  catalog: [],
});

/**
 * Live session-index home. Failure stays in `error` — never coerces to empty success.
 */
export function useSessionHome(options?: {
  unseenBySession?: Readonly<Record<string, number>>;
  runningSessionIds?: ReadonlySet<string>;
  untitledLabel?: string;
}): SessionHomeState {
  const { state } = useConnection();
  const active = state.active;
  const [status, setStatus] = useState<SessionHomeStatus>('idle');
  const [snapshot, setSnapshot] = useState<SessionIndexSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!active) {
      setStatus('idle');
      setSnapshot(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    setError(null);
    try {
      const next = await loadSessionIndexSnapshot(active);
      if (id !== requestId.current) return;
      if (next == null) {
        setSnapshot(null);
        setStatus('unsupported');
        return;
      }
      setSnapshot(next);
      setStatus('ready');
    } catch (err) {
      if (id !== requestId.current) return;
      const message =
        err instanceof SessionIndexError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'session index request failed';
      setError(message);
      setStatus('error');
      // Keep prior snapshot for display if we had one; do not clear to empty success.
    }
  }, [active]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = useMemo(() => {
    if (!snapshot) return status === 'ready' ? emptyModel() : null;
    return buildSessionHomeModel(snapshot, {
      unseenBySession: options?.unseenBySession,
      runningSessionIds: options?.runningSessionIds,
      untitledLabel: options?.untitledLabel,
    });
  }, [options?.runningSessionIds, options?.unseenBySession, options?.untitledLabel, snapshot, status]);

  return { status, model, snapshot, error, refresh };
}
