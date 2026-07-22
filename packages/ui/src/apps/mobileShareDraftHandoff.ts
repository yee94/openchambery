import { draftKeyString, draftRootAttachmentOccurrenceRefID, surfaceDraftKey, type DraftAttachmentMetadata, type DraftKey } from '@/sync/input-draft-types';
import type { DraftCommitResult, DraftSnapshot, InputDraftRuntimeCapture } from '@/sync/input-store';

export type NativeShareDraftAttachment = { stagedPath: string; originalName: string; mime: string; byteSize: number };
export type NativeShareDraft = { version: 1; draftID: string; serverInstanceID: string; assistantID: string; name: string; avatarSeed: string; serverLabel: string; connectionKey: string; text?: string; attachments: NativeShareDraftAttachment[]; source: 'android-share'; createdAt: number; expiresAt: number };

export type MobileShareDraftHandoffTarget = { draftID: string; serverInstanceID: string; connectionKey: string; assistantID: string; transportIdentity: string };
type JournalRecord = MobileShareDraftHandoffTarget & { targetDraftKey: DraftKey; baseRevision: number | 'absent'; resultText: string; attachmentIDs: string[]; phase: 'materializing' | 'materialized' | 'cancelled' };
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY = 'openchamber.mobile-share.draft-handoff.v1';
export const MOBILE_SHARE_HANDOFF_MARKER_PREFIX = 'mobile-share-handoff:';
export const mobileShareHandoffMarkerPartID = (draftID: string): string => `${MOBILE_SHARE_HANDOFF_MARKER_PREFIX}${draftID}`;
export const isMobileShareHandoffMarkerPart = (part: { partID?: string }): boolean => typeof part.partID === 'string' && part.partID.startsWith(MOBILE_SHARE_HANDOFF_MARKER_PREFIX);

export type MobileShareDraftInput = {
  getDraft: (key: DraftKey) => { revision: number; text: string; attachments: DraftAttachmentMetadata[]; syntheticParts: DraftSnapshot['syntheticParts']; mentions: DraftSnapshot['mentions']; composerReferences?: DraftSnapshot['composerReferences'] } | undefined;
  captureDraftRuntime: () => InputDraftRuntimeCapture;
  commitDraftSnapshot: (input: { key: DraftKey; expectedRevision: number | 'absent'; snapshot: DraftSnapshot; values: ReadonlyMap<string, Blob>; runtime: InputDraftRuntimeCapture }) => Promise<DraftCommitResult>;
  flushDraftPersistence: () => Promise<void>;
};

export type MobileShareDraftHandoffDependencies = {
  input: MobileShareDraftInput;
  transportIdentity: string;
  cancelDraft: (draftID: string) => Promise<void>;
  readAttachment: (attachment: NativeShareDraftAttachment) => Promise<Blob>;
  storage?: Storage;
};

const storageFor = (storage?: Storage): Storage | null => storage ?? (typeof window === 'undefined' ? null : window.localStorage);
const readJournal = (storage: Storage | null): Record<string, JournalRecord> => {
  if (!storage) return {};
  try {
    const records = JSON.parse(storage.getItem(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY) || '{}') as Record<string, JournalRecord>;
    return Object.fromEntries(Object.entries(records).flatMap(([draftID, record]) => {
      const assistantID = typeof record.assistantID === 'string' ? record.assistantID : assistantIDFor(record);
      const transportIdentity = typeof record.transportIdentity === 'string' ? record.transportIdentity : record.targetDraftKey?.transportIdentity;
      if (!assistantID || typeof record.serverInstanceID !== 'string' || typeof record.connectionKey !== 'string' || !transportIdentity) return [];
      const phase = record.phase === 'cancelled' ? 'cancelled' : record.phase === 'materialized' ? 'materialized' : 'materializing';
      return [[draftID, { ...record, draftID, assistantID, transportIdentity, phase }]];
    }));
  } catch { return {}; }
};
const writeJournal = (storage: Storage | null, records: Record<string, JournalRecord>): boolean => {
  if (!storage) return false;
  try { storage.setItem(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY, JSON.stringify(records)); return true; } catch { return false; }
};
const deleteJournal = (storage: Storage | null, draftID: string): void => {
  const records = readJournal(storage);
  delete records[draftID];
  if (!storage) return;
  try { storage.setItem(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY, JSON.stringify(records)); } catch { return; }
};
const persistJournal = (storage: Storage | null, record: JournalRecord): boolean => writeJournal(storage, { ...readJournal(storage), [record.draftID]: record });
const attachmentIDFor = (draftID: string, index: number): string => `native-share:${draftID}:${index}`;
const resultTextFor = (existing: string, incoming: string | undefined): string => incoming ? (existing ? `${existing}\n\n${incoming}` : incoming) : existing;
const isValidAttachment = (attachment: NativeShareDraftAttachment): boolean => attachment.mime.startsWith('image/') && attachment.byteSize > 0 && attachment.byteSize <= 8 * 1024 * 1024;
const materialized = (record: JournalRecord, current: ReturnType<MobileShareDraftInput['getDraft']>): boolean => Boolean(current?.syntheticParts.some((part) => part.partID === mobileShareHandoffMarkerPartID(record.draftID) && part.text === '' && part.attachments.length === 0 && part.synthetic === true));
const assistantIDFor = (record: JournalRecord): string | null => {
  const owner = record.targetDraftKey?.owner;
  if (owner?.kind !== 'surface' || typeof owner.ownerID !== 'string' || !owner.ownerID.startsWith('assistant:')) return null;
  const assistantID = owner.ownerID.slice('assistant:'.length);
  return assistantID || null;
};

const targetFor = (record: JournalRecord): MobileShareDraftHandoffTarget => ({ draftID: record.draftID, serverInstanceID: record.serverInstanceID, connectionKey: record.connectionKey, assistantID: record.assistantID, transportIdentity: record.transportIdentity });

/** Cancels materialized native drafts and returns every cancelled handoff navigation target. */
export const retryMobileShareDraftCancellations = async (cancelDraft: (draftID: string) => Promise<void>, storage?: Storage): Promise<MobileShareDraftHandoffTarget[]> => {
  const target = storageFor(storage);
  const targets: MobileShareDraftHandoffTarget[] = [];
  for (const record of Object.values(readJournal(target))) {
    if (record.phase === 'cancelled') { targets.push(targetFor(record)); continue; }
    if (record.phase !== 'materialized') continue;
    try {
      await cancelDraft(record.draftID);
      const cancelled = { ...record, phase: 'cancelled' as const };
      if (!persistJournal(target, cancelled)) continue;
      targets.push(targetFor(cancelled));
    } catch { continue; }
  }
  return targets;
};

/** Removes a cancelled journal only after its exact runtime target has opened successfully. */
export const finalizeMobileShareDraftHandoff = (target: MobileShareDraftHandoffTarget, storage?: Storage): boolean => {
  const resolvedStorage = storageFor(storage);
  const record = readJournal(resolvedStorage)[target.draftID];
  if (!record || record.phase !== 'cancelled' || record.serverInstanceID !== target.serverInstanceID || record.connectionKey !== target.connectionKey || record.assistantID !== target.assistantID || record.transportIdentity !== target.transportIdentity) return false;
  deleteJournal(resolvedStorage, target.draftID);
  return !readJournal(resolvedStorage)[target.draftID];
};

/** Removes one cancelled handoff receipt after its target navigation has opened. */
export const clearMobileShareDraftHandoffMarker = async (target: MobileShareDraftHandoffTarget, input: MobileShareDraftInput): Promise<boolean> => {
  const key = surfaceDraftKey({ transportIdentity: target.transportIdentity }, `assistant:${target.assistantID}`);
  const runtime = input.captureDraftRuntime();
  if (runtime.transportIdentity !== target.transportIdentity) return false;
  const current = input.getDraft(key);
  const markerID = mobileShareHandoffMarkerPartID(target.draftID);
  try {
    if (!current || !current.syntheticParts.some((part) => part.partID === markerID)) {
      await input.flushDraftPersistence();
      const currentRuntime = input.captureDraftRuntime();
      return currentRuntime.transportIdentity === target.transportIdentity && currentRuntime.generation === runtime.generation;
    }
    const result = await input.commitDraftSnapshot({
      key,
      expectedRevision: current.revision,
      runtime,
      values: new Map(),
      snapshot: {
        text: current.text,
        attachments: current.attachments,
        syntheticParts: current.syntheticParts.filter((part) => part.partID !== markerID),
        mentions: current.mentions,
        ...(current.composerReferences === undefined ? {} : { composerReferences: current.composerReferences }),
      },
    });
    if (!result.current || !result.durable) return false;
    await input.flushDraftPersistence();
    const currentRuntime = input.captureDraftRuntime();
    return currentRuntime.transportIdentity === target.transportIdentity && currentRuntime.generation === runtime.generation;
  } catch {
    return false;
  }
};

/** Materializes one native Android draft exactly once before cancelling its native durable copy. */
export const handoffMobileShareDraft = async (draft: NativeShareDraft, dependencies: MobileShareDraftHandoffDependencies): Promise<{ durable: boolean; cancelled: boolean }> => {
  if (draft.attachments.length > 10 || !draft.attachments.every(isValidAttachment) || draft.attachments.reduce((sum, attachment) => sum + attachment.byteSize, 0) > 16 * 1024 * 1024) throw new Error('invalid_share_attachment');
  const storage = storageFor(dependencies.storage);
  const key = surfaceDraftKey({ transportIdentity: dependencies.transportIdentity }, `assistant:${draft.assistantID}`);
  let journal = readJournal(storage)[draft.draftID];
  let durable = false;
  if (!journal || draftKeyString(journal.targetDraftKey) !== draftKeyString(key)) {
    const current = dependencies.input.getDraft(key);
    journal = { draftID: draft.draftID, serverInstanceID: draft.serverInstanceID, connectionKey: draft.connectionKey, assistantID: draft.assistantID, transportIdentity: dependencies.transportIdentity, targetDraftKey: key, baseRevision: current?.revision ?? 'absent', resultText: resultTextFor(current?.text ?? '', draft.text), attachmentIDs: draft.attachments.map((_, index) => attachmentIDFor(draft.draftID, index)), phase: 'materializing' };
    if (!persistJournal(storage, journal)) throw new Error('handoff_journal_unavailable');
  }
  if (journal.phase === 'cancelled') return { durable: true, cancelled: true };
  if (journal.phase === 'materialized' || materialized(journal, dependencies.input.getDraft(key))) durable = true;
  for (let attempt = 0; !durable && attempt < 3; attempt++) {
    const current = dependencies.input.getDraft(key);
    const nextJournal: JournalRecord = { ...journal, baseRevision: current?.revision ?? 'absent', resultText: resultTextFor(current?.text ?? '', draft.text), phase: 'materializing' };
    if (!persistJournal(storage, nextJournal)) throw new Error('handoff_journal_unavailable');
    journal = nextJournal;
    const values = new Map<string, Blob>();
    const attachments: DraftAttachmentMetadata[] = [];
    for (let index = 0; index < draft.attachments.length; index++) {
      const nativeAttachment = draft.attachments[index]!;
      const attachmentID = journal.attachmentIDs[index]!;
      const attachmentRefID = draftRootAttachmentOccurrenceRefID(attachmentID);
      const blob = await dependencies.readAttachment(nativeAttachment);
      if (blob.size !== nativeAttachment.byteSize) throw new Error('staged_file_unavailable');
      values.set(attachmentRefID, blob.type === nativeAttachment.mime ? blob : new Blob([blob], { type: nativeAttachment.mime }));
      attachments.push({ attachmentID, attachmentRefID, filename: nativeAttachment.originalName, mimeType: nativeAttachment.mime, size: nativeAttachment.byteSize, locator: { kind: 'blob', blobID: attachmentID }, source: 'local' });
    }
    const marker = { partID: mobileShareHandoffMarkerPartID(draft.draftID), text: '', attachments: [], synthetic: true as const };
    const syntheticParts = current?.syntheticParts ?? [];
    const result = await dependencies.input.commitDraftSnapshot({ key, expectedRevision: current?.revision ?? 'absent', runtime: dependencies.input.captureDraftRuntime(), snapshot: { text: journal.resultText, attachments: [...(current?.attachments ?? []), ...attachments], syntheticParts: syntheticParts.some((part) => part.partID === marker.partID) ? syntheticParts : [...syntheticParts, marker], mentions: current?.mentions ?? [], ...(current?.composerReferences === undefined ? {} : { composerReferences: current.composerReferences }) }, values });
    if (result.durable && result.current) durable = true;
    else if (result.status !== 'conflict') throw new Error(`draft_handoff_${result.status}`);
  }
  if (!durable) throw new Error('draft_handoff_conflict');
  if (journal.phase !== 'materialized') {
    journal = { ...journal, phase: 'materialized' };
    if (!persistJournal(storage, journal)) throw new Error('handoff_journal_unavailable');
  }
  try { await dependencies.cancelDraft(draft.draftID); } catch { return { durable: true, cancelled: false }; }
  journal = { ...journal, phase: 'cancelled' };
  if (!persistJournal(storage, journal)) throw new Error('handoff_journal_unavailable');
  return { durable: true, cancelled: true };
};
