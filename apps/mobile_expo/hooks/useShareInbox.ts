import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { useConnection } from '@/context/ConnectionContext';
import {
  fetchAssistantCapability,
  fetchAssistantSnapshot,
  type AssistantDTO,
} from '@/lib/assistantsApi';
import { publishShareCatalogFromCapability } from '@/lib/shareIn/catalog';
import { drainShareInbox } from '@/lib/shareIn/deliver';
import { deliverAssignedShareDraft } from '@/lib/shareIn/draftDeliver';
import {
  assignShareDraftRecipient,
  isAssignedShareDraft,
  sortShareRecipientEntries,
  type ShareDraft,
} from '@/lib/shareIn/drafts';
import {
  cancelShareDraft,
  listShareDrafts,
  type ShareCatalogEntry,
} from '@/lib/systemShell/share';

export type ShareInboxController = {
  recipientDraft: ShareDraft | null;
  recipientEntries: ShareCatalogEntry[];
  recipientBusy: boolean;
  selectRecipient: (draft: ShareDraft, entry: ShareCatalogEntry) => void;
  cancelRecipient: (draft: ShareDraft) => void;
  refresh: () => Promise<void>;
};

/**
 * Cap MobileShareBridge (Expo): publish catalog, drain inbox → POST share,
 * Android unassigned-draft recipient picker. Share Extension UI = device residual.
 */
export function useShareInbox(options?: {
  enabled?: boolean;
  onOpenSession?: (sessionId: string) => void;
}): ShareInboxController {
  const enabled = options?.enabled ?? true;
  const onOpenSession = options?.onOpenSession;
  const { state, controller } = useConnection();
  const active = state.active;
  const connectionKey = active?.connectionId ?? '';
  const serverLabel = active?.label ?? state.splashLabel ?? 'OpenChamber';

  const [catalogEntries, setCatalogEntries] = useState<ShareCatalogEntry[]>([]);
  const [pendingDrafts, setPendingDrafts] = useState<ShareDraft[]>([]);
  const [selectedDraftID, setSelectedDraftID] = useState<string | null>(null);
  const selectedDraftIDRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const drainFlight = useRef<Promise<void> | null>(null);

  const isCurrent = useCallback(() => {
    const s = controller.getState();
    return s.phase === 'connected' && s.active?.connectionId === connectionKey && !!s.active;
  }, [connectionKey, controller]);

  const publishAndDrain = useCallback(async () => {
    if (!enabled || !active || state.phase !== 'connected') return;
    const gen = ++generationRef.current;
    try {
      const [capability, snapshot] = await Promise.all([
        fetchAssistantCapability(active),
        fetchAssistantSnapshot(active).catch(() => null),
      ]);
      if (gen !== generationRef.current || !isCurrent()) return;

      const assistants: AssistantDTO[] = snapshot?.assistants ?? [];
      await publishShareCatalogFromCapability({
        capability,
        assistants,
        connectionKey,
        serverLabel,
        defaultAssistantID: null, // Exact pick only — no silent default.
      });
      if (gen !== generationRef.current || !isCurrent()) return;

      const entries =
        capability.supported && capability.serverInstanceID
          ? assistants
              .filter((a) => capability.enabled && a.enabled)
              .map((a) => ({
                serverInstanceID: capability.serverInstanceID!,
                assistantID: a.id,
                name: a.name,
                avatarSeed: a.id,
                serverLabel,
                connectionKey,
                enabled: true,
                isDefaultShareTarget: false,
              }))
          : [];
      setCatalogEntries(entries);

      const connectionKeyByServerInstanceID: Record<string, string> = {};
      for (const entry of entries) {
        connectionKeyByServerInstanceID[entry.serverInstanceID] = entry.connectionKey;
      }

      const deps = {
        active,
        connectionKey,
        connectionKeyByServerInstanceID,
        connectByKey: async (key: string) => {
          const ok = await controller.connectSaved(key);
          if (!ok) {
            const phase = controller.getState().phase;
            if (phase === 'password') return 'auth-required' as const;
            return 'offline' as const;
          }
          return 'connected' as const;
        },
        resolveActive: () => controller.getState().active,
        isCurrent,
        onDelivered: (sessionID: string) => {
          onOpenSession?.(sessionID);
        },
      };

      if (!drainFlight.current) {
        drainFlight.current = drainShareInbox(deps).finally(() => {
          drainFlight.current = null;
        });
      }
      await drainFlight.current;
      if (gen !== generationRef.current) return;

      const drafts = await listShareDrafts().catch(() => [] as ShareDraft[]);
      if (gen !== generationRef.current) return;

      // Assigned drafts: deliver via share API without picker.
      for (const draft of drafts) {
        if (!isAssignedShareDraft(draft)) continue;
        await deliverAssignedShareDraft(draft, deps).catch(() => undefined);
      }

      const unassigned = (await listShareDrafts().catch(() => [] as ShareDraft[])).filter(
        (d) => !isAssignedShareDraft(d),
      );
      setPendingDrafts(unassigned);
    } catch {
      // Preserve last catalog / drafts on transient failure.
    }
  }, [
    active,
    connectionKey,
    controller,
    enabled,
    isCurrent,
    onOpenSession,
    serverLabel,
    state.phase,
  ]);

  const refresh = useCallback(async () => {
    await publishAndDrain();
  }, [publishAndDrain]);

  useEffect(() => {
    void refresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const recipientDraft = pendingDrafts[0] ?? null;
  const recipientEntries = useMemo(
    () => sortShareRecipientEntries(catalogEntries),
    [catalogEntries],
  );
  const recipientBusy = selectedDraftID === recipientDraft?.draftID;

  const selectRecipient = useCallback(
    (draft: ShareDraft, entry: ShareCatalogEntry) => {
      if (selectedDraftIDRef.current || !active) return;
      selectedDraftIDRef.current = draft.draftID;
      setSelectedDraftID(draft.draftID);
      const assigned = assignShareDraftRecipient(draft, entry);
      const deps = {
        active,
        connectionKey: entry.connectionKey,
        connectionKeyByServerInstanceID: {
          [entry.serverInstanceID]: entry.connectionKey,
        },
        connectByKey: async (key: string) => {
          const ok = await controller.connectSaved(key);
          if (!ok) {
            const phase = controller.getState().phase;
            if (phase === 'password') return 'auth-required' as const;
            return 'offline' as const;
          }
          return 'connected' as const;
        },
        resolveActive: () => controller.getState().active,
        isCurrent,
        onDelivered: (sessionID: string) => {
          onOpenSession?.(sessionID);
        },
      };
      void deliverAssignedShareDraft(assigned, deps)
        .then(() => {
          setPendingDrafts((prev) => prev.filter((d) => d.draftID !== draft.draftID));
        })
        .finally(() => {
          if (selectedDraftIDRef.current === draft.draftID) selectedDraftIDRef.current = null;
          setSelectedDraftID((cur) => (cur === draft.draftID ? null : cur));
        });
    },
    [active, controller, isCurrent, onOpenSession],
  );

  const cancelRecipient = useCallback((draft: ShareDraft) => {
    if (selectedDraftIDRef.current === draft.draftID) return;
    setPendingDrafts((prev) => prev.filter((d) => d.draftID !== draft.draftID));
    void cancelShareDraft(draft.draftID).catch(() => undefined);
  }, []);

  return {
    recipientDraft,
    recipientEntries,
    recipientBusy,
    selectRecipient,
    cancelRecipient,
    refresh,
  };
}
