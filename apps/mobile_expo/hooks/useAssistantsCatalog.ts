import { useCallback, useEffect, useRef, useState } from 'react';

import { useConnection } from '@/context/ConnectionContext';
import {
  AssistantsApiError,
  deleteAssistant,
  fetchAssistantCapability,
  fetchAssistantSnapshot,
  newAssistantSession,
  setAssistantsEnabled,
  type AssistantCapability,
  type AssistantDTO,
  type AssistantSnapshot,
  type SessionBinding,
} from '@/lib/assistantsApi';

export type AssistantsCatalogStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'unsupported'
  | 'disabled'
  | 'empty'
  | 'unavailable'
  | 'error';

export type AssistantsCatalogState = {
  status: AssistantsCatalogStatus;
  capability: AssistantCapability | null;
  snapshot: AssistantSnapshot | null;
  assistants: AssistantDTO[];
  error: string | null;
  enabling: boolean;
  openingId: string | null;
  refresh: () => Promise<void>;
  enableAssistants: () => Promise<boolean>;
  openAssistantSession: (assistant: AssistantDTO) => Promise<SessionBinding | null>;
  removeAssistant: (assistant: AssistantDTO) => Promise<boolean>;
};

/**
 * Live Assistant catalog (Cap MobileAssistantTab data path).
 * Failure stays in `error` / `unavailable` — never coerced to empty success.
 */
export function useAssistantsCatalog(): AssistantsCatalogState {
  const { state } = useConnection();
  const active = state.active;
  const [status, setStatus] = useState<AssistantsCatalogStatus>('idle');
  const [capability, setCapability] = useState<AssistantCapability | null>(null);
  const [snapshot, setSnapshot] = useState<AssistantSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!active) {
      setStatus('idle');
      setCapability(null);
      setSnapshot(null);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    setStatus((prev) => (prev === 'ready' || prev === 'empty' || prev === 'disabled' ? prev : 'loading'));
    setError(null);
    try {
      const nextCapability = await fetchAssistantCapability(active);
      if (id !== requestId.current) return;
      setCapability(nextCapability);
      if (!nextCapability.supported) {
        setSnapshot(null);
        setStatus('unsupported');
        return;
      }
      if (!nextCapability.enabled) {
        setSnapshot(null);
        setStatus('disabled');
        return;
      }
      const nextSnapshot = await fetchAssistantSnapshot(active);
      if (id !== requestId.current) return;
      setSnapshot(nextSnapshot);
      if (!nextSnapshot.enabled) {
        setStatus('disabled');
        return;
      }
      setStatus(nextSnapshot.assistants.length === 0 ? 'empty' : 'ready');
    } catch (err) {
      if (id !== requestId.current) return;
      const message =
        err instanceof AssistantsApiError ? err.code : err instanceof Error ? err.message : 'request_failed';
      setError(message);
      setStatus('unavailable');
    }
  }, [active]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enableAssistants = useCallback(async (): Promise<boolean> => {
    if (!active || enabling) return false;
    const revision = capability?.revision ?? snapshot?.revision;
    if (revision === undefined) return false;
    setEnabling(true);
    try {
      await setAssistantsEnabled(active, true, revision);
      await refresh();
      return true;
    } catch (err) {
      const message =
        err instanceof AssistantsApiError ? err.code : err instanceof Error ? err.message : 'request_failed';
      setError(message);
      return false;
    } finally {
      setEnabling(false);
    }
  }, [active, capability?.revision, enabling, refresh, snapshot?.revision]);

  const openAssistantSession = useCallback(
    async (assistant: AssistantDTO): Promise<SessionBinding | null> => {
      if (!active || openingId) return null;
      if (assistant.sessionID) {
        return {
          sessionID: assistant.sessionID,
          directory: assistant.effectiveWorkspacePath,
          sessionGeneration: assistant.sessionGeneration,
        };
      }
      setOpeningId(assistant.id);
      try {
        const binding = await newAssistantSession(active, assistant.id);
        await refresh();
        return binding;
      } catch (err) {
        const message =
          err instanceof AssistantsApiError ? err.code : err instanceof Error ? err.message : 'request_failed';
        setError(message);
        return null;
      } finally {
        setOpeningId(null);
      }
    },
    [active, openingId, refresh],
  );

  const removeAssistant = useCallback(
    async (assistant: AssistantDTO): Promise<boolean> => {
      if (!active) return false;
      try {
        await deleteAssistant(active, assistant);
        await refresh();
        return true;
      } catch (err) {
        const message =
          err instanceof AssistantsApiError ? err.code : err instanceof Error ? err.message : 'request_failed';
        setError(message);
        return false;
      }
    },
    [active, refresh],
  );

  return {
    status,
    capability,
    snapshot,
    assistants: snapshot?.assistants ?? [],
    error,
    enabling,
    openingId,
    refresh,
    enableAssistants,
    openAssistantSession,
    removeAssistant,
  };
}
