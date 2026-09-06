import type { ActiveRuntime } from '@/lib/connectionController';
import {
  AssistantShareOperationError,
  fetchAssistantCapability,
  fetchAssistantSnapshot,
  sendAssistantShare,
  waitForAssistantShare,
  type AssistantCapability,
  type AssistantSnapshot,
} from '@/lib/assistantsApi';
import { ascendingId } from '@/lib/shareIn/messageId';
import {
  drainShareItems,
  retryShareCleanupStage,
  type ShareDrainItem,
} from '@/lib/shareIn/drain';
import {
  readShareOutbox,
  saveShareOutboxItem,
  type ShareOutboxItem,
} from '@/lib/shareIn/outbox';
import {
  buildShareParts,
  type ShareAttachmentReader,
} from '@/lib/shareIn/parts';
import {
  ackShare,
  listPendingShares,
  releaseShareFiles,
  type ShareEnvelope,
} from '@/lib/systemShell/share';

export type ShareDeliverDeps = {
  active: ActiveRuntime;
  /** Current connection id (catalog connectionKey). */
  connectionKey: string;
  /**
   * Map serverInstanceID → connectionKey from the published share catalog.
   * Used when an envelope targets a different saved instance.
   */
  connectionKeyByServerInstanceID?: Record<string, string>;
  /** Optional: switch to another saved connection by id before deliver. */
  connectByKey?: (connectionKey: string) => Promise<'connected' | 'auth-required' | 'offline'>;
  /** After connectByKey succeeds, return the new ActiveRuntime (required for multi-instance). */
  resolveActive?: () => ActiveRuntime | null;
  readAttachment?: ShareAttachmentReader;
  /** Generation guard — abort if connection flipped mid-flight. */
  isCurrent?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  onDelivered?: (sessionID: string, assistantID: string) => void;
};

const current = (deps: ShareDeliverDeps): boolean => !deps.isCurrent || deps.isCurrent();

const cleanupNativeDelivery = async (item: ShareOutboxItem): Promise<void> => {
  if (item.cleanupPhase === 'files-released') return;
  let next = item;
  if (next.cleanupPhase === 'server-completed') {
    await retryShareCleanupStage(() => ackShare(next.envelope.operationID));
    next = {
      ...next,
      state: 'delivered',
      cleanupPhase: 'native-acked',
      updatedAt: Date.now(),
    };
    await saveShareOutboxItem(next);
  }
  if (next.cleanupPhase === 'native-acked') {
    await retryShareCleanupStage(() => releaseShareFiles(next.envelope.operationID));
    await saveShareOutboxItem({
      ...next,
      state: 'delivered',
      cleanupPhase: 'files-released',
      updatedAt: Date.now(),
    });
  }
};

const resolveActiveForEnvelope = async (
  deps: ShareDeliverDeps,
  envelope: ShareEnvelope,
): Promise<{ active: ActiveRuntime; capability: AssistantCapability; snapshot: AssistantSnapshot } | 'auth-required' | 'offline' | 'target-stale'> => {
  let active = deps.active;
  let capability = await fetchAssistantCapability(active);
  if (!capability.supported || !capability.serverInstanceID) return 'target-stale';

  if (capability.serverInstanceID !== envelope.serverInstanceID) {
    const targetKey =
      deps.connectionKeyByServerInstanceID?.[envelope.serverInstanceID] ?? null;
    if (!targetKey || !deps.connectByKey || !deps.resolveActive) return 'target-stale';
    const switched = await deps.connectByKey(targetKey);
    if (switched === 'auth-required') return 'auth-required';
    if (switched !== 'connected') return 'offline';
    const next = deps.resolveActive();
    if (!next) return 'offline';
    active = next;
    capability = await fetchAssistantCapability(active);
    if (
      !capability.supported ||
      capability.serverInstanceID !== envelope.serverInstanceID
    ) {
      return 'target-stale';
    }
  }

  if (!capability.enabled) return 'target-stale';
  const snapshot = await fetchAssistantSnapshot(active);
  const assistant = snapshot.assistants.find(
    (candidate) => candidate.id === envelope.assistantID && candidate.enabled,
  );
  if (!snapshot.enabled || !assistant) return 'target-stale';
  return { active, capability, snapshot };
};

export const deliverShareEnvelope = async (
  envelope: ShareEnvelope,
  deps: ShareDeliverDeps,
): Promise<void> => {
  const existing = (await readShareOutbox())[envelope.operationID];
  if (existing?.cleanupPhase) {
    await cleanupNativeDelivery(existing);
    return;
  }

  let item: ShareOutboxItem = existing?.messageID
    ? existing
    : {
        envelope,
        messageID: existing?.messageID ?? ascendingId('msg'),
        state: existing?.state ?? 'pending',
        cleanupPhase: existing?.cleanupPhase,
        updatedAt: Date.now(),
        error: existing?.error,
      };
  await saveShareOutboxItem(item);

  item = { ...item, state: 'resolving-instance', updatedAt: Date.now() };
  await saveShareOutboxItem(item);

  item = { ...item, state: 'connecting', updatedAt: Date.now() };
  await saveShareOutboxItem(item);

  if (!current(deps)) return;

  const resolved = await resolveActiveForEnvelope(deps, envelope);
  if (resolved === 'auth-required') {
    await saveShareOutboxItem({ ...item, state: 'auth-required', updatedAt: Date.now() });
    return;
  }
  if (resolved === 'offline') {
    await saveShareOutboxItem({ ...item, state: 'offline', updatedAt: Date.now() });
    return;
  }
  if (resolved === 'target-stale') {
    await saveShareOutboxItem({ ...item, state: 'target-stale', updatedAt: Date.now() });
    return;
  }

  const { active, snapshot } = resolved;
  const assistant = snapshot.assistants.find((a) => a.id === envelope.assistantID)!;

  try {
    item = { ...item, state: 'dispatching', updatedAt: Date.now() };
    await saveShareOutboxItem(item);
    const parts = await buildShareParts(envelope, deps.readAttachment);
    if (!current(deps)) return;

    item = { ...item, state: 'reconciling', updatedAt: Date.now() };
    await saveShareOutboxItem(item);

    const operation = await sendAssistantShare(
      active,
      assistant.id,
      envelope.operationID,
      item.messageID,
      parts,
      envelope.source,
    );
    const completed = await waitForAssistantShare(active, operation, {
      sleep: deps.sleep,
      isCurrent: deps.isCurrent,
    });

    const refreshed = await fetchAssistantSnapshot(active).catch(async (error) => {
      await saveShareOutboxItem({
        ...item,
        state: 'reconciling',
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : 'snapshot_refresh_failed',
      });
      return null;
    });
    if (!refreshed) return;
    if (!current(deps)) {
      await saveShareOutboxItem({
        ...item,
        state: 'reconciling',
        updatedAt: Date.now(),
        error: 'runtime_stale',
      });
      return;
    }
    const refreshedAssistant = refreshed.assistants.find((a) => a.id === assistant.id);
    if (!refreshedAssistant || refreshedAssistant.sessionID !== completed.sessionID) {
      await saveShareOutboxItem({
        ...item,
        state: 'reconciling',
        updatedAt: Date.now(),
        error: 'assistant_binding_mismatch',
      });
      return;
    }

    item = {
      ...item,
      state: 'delivered',
      cleanupPhase: 'server-completed',
      updatedAt: Date.now(),
    };
    await saveShareOutboxItem(item);
    if (completed.sessionID) {
      deps.onDelivered?.(completed.sessionID, refreshedAssistant.id);
    }
    await cleanupNativeDelivery(item);
  } catch (error) {
    const retainReconciliation =
      (error instanceof AssistantShareOperationError && error.code === 'share_unresolved') ||
      (error instanceof Error && error.message === 'runtime_stale') ||
      (error instanceof AssistantShareOperationError && error.code === 'runtime_stale');
    if (retainReconciliation) {
      await saveShareOutboxItem({
        ...item,
        state: 'reconciling',
        updatedAt: Date.now(),
        error: error instanceof Error ? error.message : 'share_unresolved',
      });
      return;
    }
    await saveShareOutboxItem({
      ...item,
      state: 'failed',
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : 'dispatch_failed',
    });
  }
};

/** Drain App Group / Android share inbox → POST share + cleanup. */
export const drainShareInbox = async (deps: ShareDeliverDeps): Promise<void> => {
  const pending = await listPendingShares().catch(() => [] as ShareEnvelope[]);
  const envelopes = new Map(
    pending.filter((e) => !e.consumedAt).map((envelope) => [envelope.operationID, envelope]),
  );
  const outbox = await readShareOutbox();
  const items: ShareDrainItem[] = [
    ...[...envelopes.values()].map((envelope) => ({
      operationID: envelope.operationID,
      cleanupPhase: outbox[envelope.operationID]?.cleanupPhase,
    })),
    ...Object.values(outbox)
      .filter(
        (item) =>
          !envelopes.has(item.envelope.operationID) &&
          (Boolean(item.cleanupPhase && item.cleanupPhase !== 'files-released') ||
            (item.state !== 'delivered' &&
              item.state !== 'auth-required' &&
              item.state !== 'target-stale')),
      )
      .map((item) => ({
        operationID: item.envelope.operationID,
        cleanupPhase: item.cleanupPhase,
      })),
  ];

  await drainShareItems(
    items,
    {
      deliver: async (operationID) => {
        const envelope = envelopes.get(operationID) ?? outbox[operationID]?.envelope;
        if (envelope) await deliverShareEnvelope(envelope, deps);
      },
      cleanup: async (operationID) => {
        const item = (await readShareOutbox())[operationID];
        if (item) await cleanupNativeDelivery(item);
      },
    },
    1,
  );
};
