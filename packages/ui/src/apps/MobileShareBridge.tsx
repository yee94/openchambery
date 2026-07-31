/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEvent } from '@reactuses/core';

import { connectMobileShareConnection, loadMobileConnections, mobileConnectionKey } from './mobileConnections';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { AssistantShareOperationError, fetchAssistantCapability, forceRefreshAssistantSnapshot, ensureAssistantSnapshot, sendAssistantShare, waitForAssistantShare, type AssistantPart } from '@/queries/assistantQueries';
import { useAssistantUIStore, type AssistantCatalogEntry } from '@/stores/useAssistantUIStore';
import { drainMobileShareItems, retryMobileShareCleanupStage, type MobileShareDrainItem } from './mobileShareDrain';
import { ascendingId } from '@/sync/message-id';
import { clearMobileShareDraftHandoffMarker, finalizeMobileShareDraftHandoff, handoffMobileShareDraft, isAssignedNativeShareDraft, retryMobileShareDraftCancellations, type AssignedNativeShareDraft, type MobileShareDraftHandoffTarget, type NativeShareDraft } from './mobileShareDraftHandoff';
import { useInputStore } from '@/sync/input-store';
import { handlePendingNativeAssistantOpen, openNativeAssistantConversation } from './nativeAssistantShortcut';
import { MobileShareRecipientPicker } from './MobileShareRecipientPicker';
import { getAssistantPresentation } from '@/components/assistants/assistantPresentation';

type NativeAssistantCatalogEntry = Omit<AssistantCatalogEntry, 'name'> & { name: string; avatarEmoji?: string };
type NativeAssistantInteraction = { serverInstanceID: string; assistantID: string; name: string; avatarSeed: string; avatarEmoji?: string };
type NativeShareAttachment = { stagedPath: string; originalName: string; mime: string; byteSize: number };
export type NativeShareEnvelope = { version: 1; operationID: string; serverInstanceID: string; assistantID: string; text?: string; attachments: NativeShareAttachment[]; source: 'ios-share' | 'android-share'; createdAt: number; expiresAt: number };
type OpenChamberSharePlugin = {
  updateCatalog(options: { entries: NativeAssistantCatalogEntry[] }): Promise<void>;
  donateAssistantInteraction(options: NativeAssistantInteraction): Promise<void>;
  listPending(): Promise<{ envelopes: NativeShareEnvelope[] }>;
  ack(options: { operationID: string }): Promise<void>;
  releaseFiles(options: { operationID: string }): Promise<void>;
  listDrafts(): Promise<{ drafts: NativeShareDraft[] }>;
  cancelDraft(options: { draftID: string }): Promise<void>;
  addListener(eventName: 'shareReceived', listener: (event: { operationID: string }) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'shareDraftReceived', listener: (event: { draftID: string }) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'assistantOpenRequested', listener: (event: { requestID: string }) => void): Promise<{ remove: () => Promise<void> }>;
};

const OpenChamberShare = registerPlugin<OpenChamberSharePlugin>('OpenChamberShare');
const OUTBOX_KEY = 'openchamber.mobile-share.outbox.v1';
export type MobileShareState = 'pending' | 'resolving-instance' | 'connecting' | 'auth-required' | 'offline' | 'target-stale' | 'dispatching' | 'reconciling' | 'delivered' | 'failed';
type OutboxItem = { envelope: NativeShareEnvelope; messageID: string; state: MobileShareState; cleanupPhase?: 'server-completed' | 'native-acked' | 'files-released'; updatedAt: number; error?: string };

const nativeAvailable = (): boolean => Capacitor.isNativePlatform();
const readOutbox = (): Record<string, OutboxItem> => {
  try { return JSON.parse(window.localStorage.getItem(OUTBOX_KEY) || '{}') as Record<string, OutboxItem>; } catch { return {}; }
};
const writeOutbox = (items: Record<string, OutboxItem>): void => { try { window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(items)); } catch { /* Local storage may be unavailable. */ } };
const save = (item: OutboxItem): void => {
  const all = readOutbox();
  const existing = all[item.envelope.operationID];
  // One operation mutex owns transitions. This CAS also preserves a newer durable state after a restart.
  if (existing && existing.updatedAt > item.updatedAt) return;
  all[item.envelope.operationID] = item;
  writeOutbox(all);
};
const current = (key: string, generation: number): boolean => getRuntimeKey() === key && getRuntimeGeneration() === generation;
const deliveryFlights = new Map<string, Promise<void>>();
let drainFlight: Promise<void> | null = null;
let nativeDraftDrainFlight: Promise<void> | null = null;
let nativeDraftDrainRequested = false;
let pendingNativeRecipientDrafts: readonly NativeShareDraft[] = [];
let pendingNativeRecipientDraftRevision = 0;
const pendingNativeRecipientDraftListeners = new Set<() => void>();
const nativeDraftHandoffFlights = new Map<string, Promise<boolean>>();
const DRAIN_CONCURRENCY = 1;

const setPendingNativeRecipientDrafts = (drafts: readonly NativeShareDraft[]): void => {
  const nextIDs = drafts.map((draft) => draft.draftID).join('\n');
  const currentIDs = pendingNativeRecipientDrafts.map((draft) => draft.draftID).join('\n');
  if (nextIDs === currentIDs) return;
  pendingNativeRecipientDrafts = drafts;
  pendingNativeRecipientDraftRevision += 1;
  pendingNativeRecipientDraftListeners.forEach((listener) => listener());
};
const removePendingNativeRecipientDraft = (draftID: string): void => setPendingNativeRecipientDrafts(pendingNativeRecipientDrafts.filter((draft) => draft.draftID !== draftID));
const subscribePendingNativeRecipientDrafts = (listener: () => void): (() => void) => { pendingNativeRecipientDraftListeners.add(listener); return () => pendingNativeRecipientDraftListeners.delete(listener); };
const getPendingNativeRecipientDraftRevision = (): number => pendingNativeRecipientDraftRevision;

const stagedImageBlob = async (attachment: NativeShareAttachment): Promise<Blob> => {
  if (!attachment.mime.startsWith('image/')) throw new Error('unsupported_share_attachment');
  const stagedPath = attachment.stagedPath.trim();
  if (!stagedPath) throw new Error('staged_file_unavailable');
  const source = /^(?:data:|https?:|content:|file:)/i.test(stagedPath) ? stagedPath : `file://${stagedPath}`;
  const url = /^(?:data:|https?:)/i.test(source) ? source : Capacitor.convertFileSrc(source);
  return await fetch(url).then((response) => {
    if (!response.ok) throw new Error('staged_file_unavailable');
    return response.blob();
  });
};

const imageDataUrl = async (attachment: NativeShareAttachment): Promise<string> => {
  const blob = await stagedImageBlob(attachment);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('staged_file_unavailable'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('staged_file_unavailable'));
    reader.readAsDataURL(blob);
  });
};

const partsFor = async (envelope: NativeShareEnvelope): Promise<AssistantPart[]> => {
  const parts: AssistantPart[] = [];
  if (envelope.text?.trim()) parts.push({ type: 'text', text: envelope.text });
  if (envelope.attachments.length > 10) throw new Error('too_many_share_attachments');
  for (const attachment of envelope.attachments) {
    if (attachment.byteSize <= 0 || attachment.byteSize > 20 * 1024 * 1024) throw new Error('invalid_share_attachment');
    parts.push({ type: 'file', mime: attachment.mime, url: await imageDataUrl(attachment) });
  }
  if (parts.length === 0) throw new Error('empty_share');
  return parts;
};

export const refreshNativeAssistantCatalog = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  const connectionKey = getRuntimeKey();
  const connection = (await loadMobileConnections()).find((item) => mobileConnectionKey(item) === connectionKey);
  if (!connection) return;
  const generation = getRuntimeGeneration();
  try {
    const [capability, snapshot] = await Promise.all([fetchAssistantCapability(), ensureAssistantSnapshot()]);
    if (!current(connectionKey, generation)) return;
    if (!capability.supported || !capability.serverInstanceID) return;
    const serverInstanceID = capability.serverInstanceID;
    const entries = snapshot.assistants.map((assistant) => ({
      serverInstanceID,
      assistantID: assistant.id,
      name: assistant.name,
      avatarSeed: assistant.id,
      serverLabel: connection.label,
      connectionKey,
      enabled: capability.enabled && assistant.enabled,
      isDefaultShareTarget: false,
    }));
    useAssistantUIStore.getState().replaceCatalogPartition({ serverInstanceID, connectionKey, revision: snapshot.revision, lastLoadedAt: Date.now(), entries });
    await publishNativeAssistantCatalog();
  } catch {
    // Failed authoritative reads preserve the last complete partition.
  }
};

export const publishNativeAssistantCatalog = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  const entries = Object.values(useAssistantUIStore.getState().assistantCatalogByConnection).flatMap((partition) => partition.entries).map((entry): NativeAssistantCatalogEntry => {
    const presentation = getAssistantPresentation(entry.name);
    return {
      ...entry,
      name: presentation.displayName || entry.name,
      ...(presentation.avatarEmoji ? { avatarEmoji: presentation.avatarEmoji } : {}),
    };
  });
  await OpenChamberShare.updateCatalog({ entries });
};

export const donateNativeAssistantInteraction = async (target: NativeAssistantInteraction): Promise<void> => {
  if (Capacitor.getPlatform() !== 'ios') return;
  await OpenChamberShare.donateAssistantInteraction(target);
};

const deliver = (envelope: NativeShareEnvelope): Promise<void> => {
  const active = deliveryFlights.get(envelope.operationID);
  if (active) return active;
  const flight = deliverOne(envelope);
  deliveryFlights.set(envelope.operationID, flight);
  void flight.finally(() => { if (deliveryFlights.get(envelope.operationID) === flight) deliveryFlights.delete(envelope.operationID); }).catch(() => undefined);
  return flight;
};

const cleanupNativeDelivery = async (item: OutboxItem): Promise<void> => {
  if (item.cleanupPhase === 'files-released') return;
  if (item.cleanupPhase === 'server-completed') {
    await retryMobileShareCleanupStage(() => OpenChamberShare.ack({ operationID: item.envelope.operationID }));
    item = { ...item, state: 'delivered', cleanupPhase: 'native-acked', updatedAt: Date.now() }; save(item);
  }
  if (item.cleanupPhase === 'native-acked') {
    await retryMobileShareCleanupStage(() => OpenChamberShare.releaseFiles({ operationID: item.envelope.operationID }));
    save({ ...item, state: 'delivered', cleanupPhase: 'files-released', updatedAt: Date.now() });
  }
};

const deliverOne = async (envelope: NativeShareEnvelope): Promise<void> => {
  const existing = readOutbox()[envelope.operationID];
  if (existing?.cleanupPhase) { await cleanupNativeDelivery(existing); return; }
  let item: OutboxItem = existing?.messageID
    ? existing
    : { envelope, messageID: ascendingId('msg'), state: existing?.state ?? 'pending', cleanupPhase: existing?.cleanupPhase, updatedAt: Date.now(), error: existing?.error };
  save(item); // Durable admission precedes every native share mutation.
  item = { ...item, state: 'resolving-instance', updatedAt: Date.now() }; save(item);
  const partition = Object.values(useAssistantUIStore.getState().assistantCatalogByConnection).find((entry) => entry.serverInstanceID === envelope.serverInstanceID && entry.entries.some((candidate) => candidate.assistantID === envelope.assistantID));
  if (!partition) { save({ ...item, state: 'target-stale', updatedAt: Date.now() }); return; }
  item = { ...item, state: 'connecting', updatedAt: Date.now() }; save(item);
  const result = await connectMobileShareConnection(partition.connectionKey);
  if (result === 'auth-required') { save({ ...item, state: 'auth-required', updatedAt: Date.now() }); return; }
  if (result !== 'connected') { save({ ...item, state: 'offline', updatedAt: Date.now() }); return; }
  const generation = getRuntimeGeneration();
  let deliveredAssistantID: string | null = null;
  if (!current(partition.connectionKey, generation)) return;
  try {
    // Settings hydration confirms the newly switched runtime has completed its auth gate.
    await runtimeFetch('/api/config/settings').catch(() => undefined);
    if (!current(partition.connectionKey, generation)) return;
    const [capability, snapshot] = await Promise.all([fetchAssistantCapability(), ensureAssistantSnapshot()]);
    if (!current(partition.connectionKey, generation) || !capability.supported || capability.serverInstanceID !== envelope.serverInstanceID) { save({ ...item, state: 'target-stale', updatedAt: Date.now() }); return; }
    const assistant = snapshot.assistants.find((candidate) => candidate.id === envelope.assistantID && candidate.enabled);
    if (!capability.enabled || !assistant) { save({ ...item, state: 'target-stale', updatedAt: Date.now() }); return; }
    item = { ...item, state: 'dispatching', updatedAt: Date.now() }; save(item);
    const parts = await partsFor(envelope);
    if (!current(partition.connectionKey, generation)) return;
    item = { ...item, state: 'reconciling', updatedAt: Date.now() }; save(item);
    const operation = await sendAssistantShare(assistant.id, envelope.operationID, item.messageID, parts, envelope.source);
    const completedOperation = await waitForAssistantShare(operation, getRuntimeTransportIdentity(), generation);
    const refreshedSnapshot = await forceRefreshAssistantSnapshot().catch((error): null => { save({ ...item, state: 'reconciling', updatedAt: Date.now(), error: error instanceof Error ? error.message : 'snapshot_refresh_failed' }); return null; });
    if (!refreshedSnapshot) return;
    if (!current(partition.connectionKey, generation)) { save({ ...item, state: 'reconciling', updatedAt: Date.now(), error: 'runtime_stale' }); return; }
    const refreshedAssistant = refreshedSnapshot.assistants.find((candidate) => candidate.id === assistant.id);
    if (!refreshedAssistant || refreshedAssistant.sessionID !== completedOperation.sessionID) { save({ ...item, state: 'reconciling', updatedAt: Date.now(), error: 'assistant_binding_mismatch' }); return; }
    deliveredAssistantID = refreshedAssistant.id;
  } catch (error) {
    const retainReconciliation = (error instanceof AssistantShareOperationError && error.code === 'share_unresolved') || (error instanceof Error && error.message === 'runtime_stale');
    if (retainReconciliation) {
      save({ ...item, state: 'reconciling', updatedAt: Date.now(), error: error instanceof Error ? error.message : 'share_unresolved' });
      return;
    }
    save({ ...item, state: 'failed', updatedAt: Date.now(), error: error instanceof Error ? error.message : 'dispatch_failed' });
    return;
  }
  item = { ...item, state: 'delivered', cleanupPhase: 'server-completed', updatedAt: Date.now() }; save(item);
  openNativeAssistantConversation(deliveredAssistantID);
  await cleanupNativeDelivery(item);
};

const drain = async (): Promise<void> => {
  if (drainFlight) return drainFlight;
  drainFlight = drainOne().finally(() => { drainFlight = null; });
  return drainFlight;
};

const drainOne = async (): Promise<void> => {
  if (!nativeAvailable()) return;
  const pending = await OpenChamberShare.listPending().catch(() => null);
  const envelopes = new Map((pending?.envelopes ?? []).map((envelope) => [envelope.operationID, envelope]));
  const outbox = readOutbox();
  const items: MobileShareDrainItem[] = [
    ...[...envelopes.values()].map((envelope) => ({ operationID: envelope.operationID, cleanupPhase: outbox[envelope.operationID]?.cleanupPhase })),
    ...Object.values(outbox).filter((item) => !envelopes.has(item.envelope.operationID) && (Boolean(item.cleanupPhase && item.cleanupPhase !== 'files-released') || (item.state !== 'delivered' && item.state !== 'auth-required' && item.state !== 'target-stale'))).map((item) => ({ operationID: item.envelope.operationID, cleanupPhase: item.cleanupPhase })),
  ];
  await drainMobileShareItems(items, {
    deliver: async (operationID) => { const envelope = envelopes.get(operationID) ?? outbox[operationID]?.envelope; if (envelope) await deliver(envelope); },
    cleanup: async (operationID) => { const item = readOutbox()[operationID]; if (item) await cleanupNativeDelivery(item); },
  }, DRAIN_CONCURRENCY);
};

const drainNativeDrafts = async (): Promise<void> => {
  nativeDraftDrainRequested = true;
  if (nativeDraftDrainFlight) return nativeDraftDrainFlight;
  nativeDraftDrainFlight = (async () => {
    do {
      nativeDraftDrainRequested = false;
      await drainNativeDraftsOne();
    } while (nativeDraftDrainRequested);
  })().finally(() => {
    nativeDraftDrainFlight = null;
    if (nativeDraftDrainRequested) void drainNativeDrafts();
  });
  return nativeDraftDrainFlight;
};

const openRecoveredNativeDraftTarget = async (target: MobileShareDraftHandoffTarget): Promise<boolean> => {
  if (getRuntimeKey() !== target.connectionKey) {
    const result = await connectMobileShareConnection(target.connectionKey);
    if (result !== 'connected') return false;
  }
  const generation = getRuntimeGeneration();
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity) return false;
  await runtimeFetch('/api/config/settings').catch(() => undefined);
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity) return false;
  if (!await useInputStore.getState().hydrateDraftMetadata(target.transportIdentity)) return false;
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity) return false;
  const [capability, snapshot] = await Promise.all([fetchAssistantCapability(), forceRefreshAssistantSnapshot()]);
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity || !capability.supported || !capability.enabled || capability.serverInstanceID !== target.serverInstanceID || !snapshot.assistants.some((assistant) => assistant.id === target.assistantID && assistant.enabled)) return false;
  openNativeAssistantConversation(target.assistantID);
  return true;
};

type ValidatedNativeDraftRuntime = { runtimeKey: string; generation: number; transportIdentity: string };

const validateNativeDraftTargetOnCurrentRuntime = async (target: { serverInstanceID: string; assistantID: string }): Promise<ValidatedNativeDraftRuntime | null> => {
  const runtimeKey = getRuntimeKey();
  const generation = getRuntimeGeneration();
  await runtimeFetch('/api/config/settings').catch(() => undefined);
  if (!current(runtimeKey, generation)) return null;
  try {
    const [capability, snapshot] = await Promise.all([fetchAssistantCapability(), forceRefreshAssistantSnapshot()]);
    if (!current(runtimeKey, generation) || !capability.supported || !capability.enabled || capability.serverInstanceID !== target.serverInstanceID || !snapshot.assistants.some((assistant) => assistant.id === target.assistantID && assistant.enabled)) return null;
    return { runtimeKey, generation, transportIdentity: getRuntimeTransportIdentity() };
  } catch {
    return null;
  }
};

const processAssignedNativeDraftOne = async (draft: AssignedNativeShareDraft): Promise<boolean> => {
  const partition = Object.values(useAssistantUIStore.getState().assistantCatalogByConnection).find((entry) => entry.serverInstanceID === draft.serverInstanceID && entry.connectionKey === draft.connectionKey && entry.entries.some((candidate) => candidate.assistantID === draft.assistantID));
  if (!partition) return false;
  let runtime = await validateNativeDraftTargetOnCurrentRuntime(draft);
  if (!runtime) {
    // Android WebView can reject an otherwise reachable plain-HTTP LAN runtime
    // as mixed content. The persisted catalog's relay identity gives this
    // share-specific recovery path an authenticated HTTPS transport.
    const result = await connectMobileShareConnection(partition.connectionKey, { transportPreference: 'relay' });
    if (result !== 'connected') return false;
    runtime = await validateNativeDraftTargetOnCurrentRuntime(draft);
    if (!runtime) return false;
  }
  const { runtimeKey, generation, transportIdentity } = runtime;
  const hydrated = await useInputStore.getState().hydrateDraftMetadata(transportIdentity);
  if (!hydrated) return false;
  if (!current(runtimeKey, generation) || getRuntimeTransportIdentity() !== transportIdentity) return false;
  const handoff = await handoffMobileShareDraft(draft, {
    input: useInputStore.getState(),
    transportIdentity,
    cancelDraft: (draftID) => OpenChamberShare.cancelDraft({ draftID }),
    readAttachment: stagedImageBlob,
  });
  if (!handoff.durable || !handoff.cancelled || !current(runtimeKey, generation) || getRuntimeTransportIdentity() !== transportIdentity) return false;
  const target = { draftID: draft.draftID, serverInstanceID: draft.serverInstanceID, connectionKey: draft.connectionKey, assistantID: draft.assistantID, transportIdentity };
  openNativeAssistantConversation(draft.assistantID);
  if (await clearMobileShareDraftHandoffMarker(target, useInputStore.getState())) finalizeMobileShareDraftHandoff(target);
  return true;
};

const processAssignedNativeDraft = (draft: AssignedNativeShareDraft): Promise<boolean> => {
  const active = nativeDraftHandoffFlights.get(draft.draftID);
  if (active) return active;
  const flight = processAssignedNativeDraftOne(draft).catch(() => false).finally(() => {
    if (nativeDraftHandoffFlights.get(draft.draftID) === flight) nativeDraftHandoffFlights.delete(draft.draftID);
  });
  nativeDraftHandoffFlights.set(draft.draftID, flight);
  return flight;
};

const drainNativeDraftsOne = async (): Promise<void> => {
  if (Capacitor.getPlatform() !== 'android') return;
  const recoveredTargets = await retryMobileShareDraftCancellations((draftID) => OpenChamberShare.cancelDraft({ draftID }));
  for (const target of recoveredTargets) {
    try {
      if (await openRecoveredNativeDraftTarget(target) && await clearMobileShareDraftHandoffMarker(target, useInputStore.getState())) finalizeMobileShareDraftHandoff(target);
    } catch {
      // The cancelled journal remains available for the next runtime recovery.
    }
  }
  const pending = await OpenChamberShare.listDrafts().catch(() => null);
  if (!pending) return;
  const drafts = [...(pending?.drafts ?? [])].sort((left, right) => left.createdAt - right.createdAt);
  setPendingNativeRecipientDrafts(drafts.filter((draft) => !isAssignedNativeShareDraft(draft)));
  for (const draft of drafts) {
    if (!isAssignedNativeShareDraft(draft)) continue;
    await processAssignedNativeDraft(draft);
    // A failed native draft remains durable and subsequent drafts continue independently.
  }
};

export const MobileShareBridge: React.FC = () => {
  React.useSyncExternalStore(subscribePendingNativeRecipientDrafts, getPendingNativeRecipientDraftRevision, getPendingNativeRecipientDraftRevision);
  const catalog = useAssistantUIStore((state) => state.assistantCatalogByConnection);
  const [selectedDraftID, setSelectedDraftID] = React.useState<string | null>(null);
  const selectedDraftIDRef = React.useRef<string | null>(null);
  const entries = React.useMemo(() => Object.values(catalog)
    .flatMap((partition) => partition.entries)
    .filter((entry) => entry.enabled)
    .sort((left, right) => Number(right.isDefaultShareTarget) - Number(left.isDefaultShareTarget) || left.serverLabel.localeCompare(right.serverLabel) || left.name.localeCompare(right.name)), [catalog]);
  const draft = pendingNativeRecipientDrafts[0] ?? null;
  const selectRecipient = useEvent((pendingDraft: NativeShareDraft, entry: AssistantCatalogEntry): void => {
    if (selectedDraftIDRef.current) return;
    selectedDraftIDRef.current = pendingDraft.draftID;
    setSelectedDraftID(pendingDraft.draftID);
    const assigned: AssignedNativeShareDraft = { ...pendingDraft, serverInstanceID: entry.serverInstanceID, assistantID: entry.assistantID, name: entry.name, avatarSeed: entry.avatarSeed, serverLabel: entry.serverLabel, connectionKey: entry.connectionKey };
    void processAssignedNativeDraft(assigned).then((completed) => {
      if (completed) removePendingNativeRecipientDraft(pendingDraft.draftID);
    }).finally(() => {
      if (selectedDraftIDRef.current === pendingDraft.draftID) selectedDraftIDRef.current = null;
      setSelectedDraftID((currentDraftID) => currentDraftID === pendingDraft.draftID ? null : currentDraftID);
    });
  });
  const cancelRecipientSelection = useEvent((pendingDraft: NativeShareDraft): void => {
    if (selectedDraftID === pendingDraft.draftID) return;
    removePendingNativeRecipientDraft(pendingDraft.draftID);
    void OpenChamberShare.cancelDraft({ draftID: pendingDraft.draftID }).catch(() => { void drainNativeDrafts(); });
  });
  React.useEffect(() => {
    if (!nativeAvailable()) return;
    void refreshNativeAssistantCatalog();
    void drain();
    void drainNativeDrafts();
    void handlePendingNativeAssistantOpen();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => { void refreshNativeAssistantCatalog(); void drainNativeDrafts(); void handlePendingNativeAssistantOpen(); });
    const resume = () => { void refreshNativeAssistantCatalog(); void drain(); void drainNativeDrafts(); void handlePendingNativeAssistantOpen(); };
    window.addEventListener('openchamber:system-resume', resume);
    let removed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    let draftListener: { remove: () => Promise<void> } | null = null;
    let assistantOpenListener: { remove: () => Promise<void> } | null = null;
    void OpenChamberShare.addListener('shareReceived', () => { void drain(); }).then((value) => { if (removed) void value.remove(); else listener = value; }).catch(() => undefined);
    void OpenChamberShare.addListener('shareDraftReceived', () => { void drainNativeDrafts(); }).then((value) => { if (removed) void value.remove(); else draftListener = value; }).catch(() => undefined);
    void OpenChamberShare.addListener('assistantOpenRequested', () => { void handlePendingNativeAssistantOpen(); }).then((value) => { if (removed) void value.remove(); else assistantOpenListener = value; }).catch(() => undefined);
    return () => { removed = true; unsubscribe(); window.removeEventListener('openchamber:system-resume', resume); if (listener) void listener.remove(); if (draftListener) void draftListener.remove(); if (assistantOpenListener) void assistantOpenListener.remove(); };
  }, []);
  return <MobileShareRecipientPicker draft={draft} entries={entries} busy={selectedDraftID === draft?.draftID} onSelect={selectRecipient} onCancel={cancelRecipientSelection} />;
};
