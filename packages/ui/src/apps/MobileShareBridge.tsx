import React from 'react';
import { Capacitor, registerPlugin } from '@capacitor/core';

import { connectMobileShareConnection, loadMobileConnections, mobileConnectionKey } from './mobileConnections';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { AssistantShareOperationError, fetchAssistantCapability, forceRefreshAssistantSnapshot, ensureAssistantSnapshot, sendAssistantShare, waitForAssistantShare, type AssistantPart } from '@/queries/assistantQueries';
import { openAssistant, useAssistantUIStore, type AssistantCatalogEntry } from '@/stores/useAssistantUIStore';
import { drainMobileShareItems, retryMobileShareCleanupStage, type MobileShareDrainItem } from './mobileShareDrain';
import { ascendingId } from '@/sync/message-id';
import { clearMobileShareDraftHandoffMarker, finalizeMobileShareDraftHandoff, handoffMobileShareDraft, retryMobileShareDraftCancellations, type MobileShareDraftHandoffTarget, type NativeShareDraft } from './mobileShareDraftHandoff';
import { useInputStore } from '@/sync/input-store';

type NativeAssistantCatalogEntry = AssistantCatalogEntry;
type NativeShareAttachment = { stagedPath: string; originalName: string; mime: string; byteSize: number };
export type NativeShareEnvelope = { version: 1; operationID: string; serverInstanceID: string; assistantID: string; text?: string; attachments: NativeShareAttachment[]; source: 'ios-share' | 'android-share'; createdAt: number; expiresAt: number };
type OpenChamberSharePlugin = {
  updateCatalog(options: { entries: NativeAssistantCatalogEntry[] }): Promise<void>;
  donateAssistantInteraction(options: { serverInstanceID: string; assistantID: string; name: string; avatarSeed: string }): Promise<void>;
  listPending(): Promise<{ envelopes: NativeShareEnvelope[] }>;
  ack(options: { operationID: string }): Promise<void>;
  releaseFiles(options: { operationID: string }): Promise<void>;
  listDrafts(): Promise<{ drafts: NativeShareDraft[] }>;
  cancelDraft(options: { draftID: string }): Promise<void>;
  addListener(eventName: 'shareReceived', listener: (event: { operationID: string }) => void): Promise<{ remove: () => Promise<void> }>;
  addListener(eventName: 'shareDraftReceived', listener: (event: { draftID: string }) => void): Promise<{ remove: () => Promise<void> }>;
};

const OpenChamberShare = registerPlugin<OpenChamberSharePlugin>('OpenChamberShare');
const OUTBOX_KEY = 'openchamber.mobile-share.outbox.v1';
export type MobileShareState = 'pending' | 'resolving-instance' | 'connecting' | 'auth-required' | 'offline' | 'target-stale' | 'dispatching' | 'reconciling' | 'delivered' | 'failed';
type OutboxItem = { envelope: NativeShareEnvelope; messageID: string; state: MobileShareState; cleanupPhase?: 'server-completed' | 'native-acked' | 'files-released'; updatedAt: number; error?: string };

const nativeAvailable = (): boolean => Capacitor.isNativePlatform();
const readOutbox = (): Record<string, OutboxItem> => {
  try { return JSON.parse(window.localStorage.getItem(OUTBOX_KEY) || '{}') as Record<string, OutboxItem>; } catch { return {}; }
};
const writeOutbox = (items: Record<string, OutboxItem>): void => { try { window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(items)); } catch {} };
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
const DRAIN_CONCURRENCY = 1;

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
  const entries = Object.values(useAssistantUIStore.getState().assistantCatalogByConnection).flatMap((partition) => partition.entries);
  await OpenChamberShare.updateCatalog({ entries });
};

export const donateNativeAssistantInteraction = async (target: { serverInstanceID: string; assistantID: string; name: string; avatarSeed: string }): Promise<void> => {
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
  openAssistant(deliveredAssistantID);
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
  const result = await connectMobileShareConnection(target.connectionKey);
  if (result !== 'connected') return false;
  const generation = getRuntimeGeneration();
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity) return false;
  await runtimeFetch('/api/config/settings').catch(() => undefined);
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity) return false;
  if (!await useInputStore.getState().hydrateDraftMetadata(target.transportIdentity)) return false;
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity) return false;
  const [capability, snapshot] = await Promise.all([fetchAssistantCapability(), forceRefreshAssistantSnapshot()]);
  if (!current(target.connectionKey, generation) || getRuntimeTransportIdentity() !== target.transportIdentity || !capability.supported || !capability.enabled || capability.serverInstanceID !== target.serverInstanceID || !snapshot.assistants.some((assistant) => assistant.id === target.assistantID && assistant.enabled)) return false;
  openAssistant(target.assistantID);
  return true;
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
  const drafts = [...(pending?.drafts ?? [])].sort((left, right) => left.createdAt - right.createdAt);
  for (const draft of drafts) {
    try {
      const partition = Object.values(useAssistantUIStore.getState().assistantCatalogByConnection).find((entry) => entry.serverInstanceID === draft.serverInstanceID && entry.connectionKey === draft.connectionKey && entry.entries.some((candidate) => candidate.assistantID === draft.assistantID));
      if (!partition) continue;
      const result = await connectMobileShareConnection(partition.connectionKey);
      if (result !== 'connected') continue;
      const generation = getRuntimeGeneration();
      if (!current(partition.connectionKey, generation)) continue;
      await runtimeFetch('/api/config/settings').catch(() => undefined);
      if (!current(partition.connectionKey, generation)) continue;
      const [capability, snapshot] = await Promise.all([fetchAssistantCapability(), forceRefreshAssistantSnapshot()]);
      if (!current(partition.connectionKey, generation) || !capability.supported || !capability.enabled || capability.serverInstanceID !== draft.serverInstanceID || !snapshot.assistants.some((assistant) => assistant.id === draft.assistantID && assistant.enabled)) continue;
      const transportIdentity = getRuntimeTransportIdentity();
      const hydrated = await useInputStore.getState().hydrateDraftMetadata(transportIdentity);
      if (!hydrated) continue;
      if (!current(partition.connectionKey, generation) || getRuntimeTransportIdentity() !== transportIdentity) continue;
      const handoff = await handoffMobileShareDraft(draft, {
        input: useInputStore.getState(),
        transportIdentity,
        cancelDraft: (draftID) => OpenChamberShare.cancelDraft({ draftID }),
        readAttachment: stagedImageBlob,
      });
      if (handoff.durable && handoff.cancelled && current(partition.connectionKey, generation) && getRuntimeTransportIdentity() === transportIdentity) {
        const target = { draftID: draft.draftID, serverInstanceID: draft.serverInstanceID, connectionKey: draft.connectionKey, assistantID: draft.assistantID, transportIdentity };
        openAssistant(draft.assistantID);
        if (await clearMobileShareDraftHandoffMarker(target, useInputStore.getState())) finalizeMobileShareDraftHandoff(target);
      }
    } catch {
      // The native draft remains durable and subsequent drafts continue independently.
    }
  }
};

export const MobileShareBridge: React.FC = () => {
  React.useEffect(() => {
    if (!nativeAvailable()) return;
    void refreshNativeAssistantCatalog();
    void drain();
    void drainNativeDrafts();
    const unsubscribe = subscribeRuntimeEndpointChanged(() => { void refreshNativeAssistantCatalog(); void drainNativeDrafts(); });
    const resume = () => { void refreshNativeAssistantCatalog(); void drain(); void drainNativeDrafts(); };
    window.addEventListener('openchamber:system-resume', resume);
    let removed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    let draftListener: { remove: () => Promise<void> } | null = null;
    void OpenChamberShare.addListener('shareReceived', () => { void drain(); }).then((value) => { if (removed) void value.remove(); else listener = value; }).catch(() => undefined);
    void OpenChamberShare.addListener('shareDraftReceived', () => { void drainNativeDrafts(); }).then((value) => { if (removed) void value.remove(); else draftListener = value; }).catch(() => undefined);
    return () => { removed = true; unsubscribe(); window.removeEventListener('openchamber:system-resume', resume); if (listener) void listener.remove(); if (draftListener) void draftListener.remove(); };
  }, []);
  return null;
};
