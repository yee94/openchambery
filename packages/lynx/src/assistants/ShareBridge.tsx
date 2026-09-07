/**
 * Cap MobileShareBridge spirit for Lynx (JS picker path).
 * Pending unassigned Android drafts → full-page recipient picker;
 * assigned → dispatch; never silent-default Assistant for generic share.
 * Host Share extension / ShareReceiverActivity remain host-only.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { LynxRuntimeFetch } from '../runtime/fetch';
import { loadAssistantCapability, loadAssistantSnapshot } from './api';
import { LynxShareRecipientPicker } from './ShareRecipientPicker';
import {
  assignLynxShareDraftRecipient,
  buildLynxShareCatalogEntries,
  isAssignedLynxShareDraft,
  type LynxShareCatalogEntry,
  type LynxShareDraft,
} from './shareDraft';
import { createLynxShareInbox, type LynxShareInbox } from './shareInbox';

export type LynxShareBridgeProps = {
  locale: string;
  runtimeFetch?: LynxRuntimeFetch | null;
  /** Injected inbox (host / tests). Default creates an in-memory inbox. */
  inbox?: LynxShareInbox;
  connectionKey?: string;
  serverLabel?: string;
  /** Called after a successful assigned-draft dispatch. */
  onDelivered?: (assistantID: string) => void;
};

/**
 * Cap MobileShareBridge: catalog + unassigned-draft picker + assigned dispatch.
 * Does not invent host ShareReceiverActivity / iOS Share Extension.
 */
export function LynxShareBridge({
  locale,
  runtimeFetch = null,
  inbox: inboxProp,
  connectionKey = '',
  serverLabel = 'OpenChamber',
  onDelivered,
}: LynxShareBridgeProps) {
  const [ownedInbox] = useState(() => createLynxShareInbox());
  const inbox = inboxProp ?? ownedInbox;
  const revision = useSyncExternalStore(inbox.subscribe, inbox.getRevision, inbox.getRevision);

  const [entries, setEntries] = useState<LynxShareCatalogEntry[]>([]);
  const [selectedDraftID, setSelectedDraftID] = useState<string | null>(null);
  const selectedDraftIDRef = useRef<string | null>(null);
  const dispatchFlightsRef = useRef(new Map<string, Promise<void>>());
  const onDeliveredRef = useRef(onDelivered);
  onDeliveredRef.current = onDelivered;

  const unassigned = useMemo(
    () => inbox.listUnassignedDrafts().sort((a, b) => a.createdAt - b.createdAt),
    [inbox, revision],
  );
  const draft = unassigned[0] ?? null;
  const busy = selectedDraftID === draft?.draftID;

  const dispatchAssigned = (assigned: ReturnType<typeof assignLynxShareDraftRecipient>): Promise<void> => {
    const active = dispatchFlightsRef.current.get(assigned.draftID);
    if (active) return active;
    const flight = (async () => {
      const result = await inbox.dispatchAssignedDraft(runtimeFetch, assigned);
      if (result.status === 'ok') {
        onDeliveredRef.current?.(assigned.assistantID);
      }
      // Failure ≠ fake-success — draft remains for retry / cancel.
    })().finally(() => {
      if (dispatchFlightsRef.current.get(assigned.draftID) === flight) {
        dispatchFlightsRef.current.delete(assigned.draftID);
      }
    });
    dispatchFlightsRef.current.set(assigned.draftID, flight);
    return flight;
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [capability, snapshotResult] = await Promise.all([
        loadAssistantCapability(runtimeFetch),
        loadAssistantSnapshot(runtimeFetch),
      ]);
      if (cancelled) return;
      const assistants = snapshotResult.status === 'ok'
        ? snapshotResult.snapshot.assistants
        : [];
      setEntries(buildLynxShareCatalogEntries({
        capability,
        assistants,
        connectionKey,
        serverLabel,
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeFetch, connectionKey, serverLabel]);

  useEffect(() => {
    // Cap drainNativeDraftsOne: assigned drafts (Direct Share) dispatch without picker.
    for (const pending of inbox.listDrafts()) {
      if (!isAssignedLynxShareDraft(pending)) continue;
      void dispatchAssigned(pending);
    }
    // dispatchAssigned / inbox stable enough via refs+maps; revision drives re-scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox, revision, runtimeFetch]);

  const selectRecipient = (pendingDraft: LynxShareDraft, entry: LynxShareCatalogEntry): void => {
    if (selectedDraftIDRef.current) return;
    selectedDraftIDRef.current = pendingDraft.draftID;
    setSelectedDraftID(pendingDraft.draftID);
    // Cap: keep unassigned pending until dispatch succeeds — picker stays open + busy.
    const assigned = assignLynxShareDraftRecipient(pendingDraft, entry);
    void dispatchAssigned(assigned).finally(() => {
      if (selectedDraftIDRef.current === pendingDraft.draftID) {
        selectedDraftIDRef.current = null;
      }
      setSelectedDraftID((current) => (current === pendingDraft.draftID ? null : current));
    });
  };

  const cancelRecipient = (pendingDraft: LynxShareDraft): void => {
    if (selectedDraftIDRef.current === pendingDraft.draftID) return;
    // Cap: drop pending + cancel native draft — no invented success toast.
    inbox.cancelDraft(pendingDraft.draftID);
  };

  return (
    <LynxShareRecipientPicker
      locale={locale}
      draft={draft}
      entries={entries}
      busy={busy}
      onSelect={selectRecipient}
      onCancel={cancelRecipient}
    />
  );
}

export type { LynxShareInbox };
