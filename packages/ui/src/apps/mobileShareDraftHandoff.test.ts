import { describe, expect, test } from 'bun:test';
import { draftRootAttachmentOccurrenceRefID, type DraftAttachmentMetadata, type DraftKey } from '@/sync/input-draft-types';
import { clearMobileShareDraftHandoffMarker, finalizeMobileShareDraftHandoff, handoffMobileShareDraft, mobileShareHandoffMarkerPartID, MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY, retryMobileShareDraftCancellations, type NativeShareDraft } from './mobileShareDraftHandoff';
import type { DraftCommitResult } from '@/sync/input-store';

const draft = (overrides: Partial<NativeShareDraft> = {}): NativeShareDraft => ({ version: 1, draftID: 'share-1', serverInstanceID: 'server', assistantID: 'assistant', name: 'Assistant', avatarSeed: 'assistant', serverLabel: 'Server', connectionKey: 'connection', text: 'shared', attachments: [{ stagedPath: '/native/image.png', originalName: 'image.png', mime: 'image/png', byteSize: 3 }], source: 'android-share', createdAt: 1, expiresAt: 2, ...overrides });
const storage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), values };
};
const result = (status: DraftCommitResult['status'] = 'committed'): DraftCommitResult => ({ status, durable: status === 'committed', current: status === 'committed', errors: [], cleanupErrors: [] });
const input = (initial?: { text: string; attachments: DraftAttachmentMetadata[]; syntheticParts?: Array<{ partID: string; text: string; attachments: DraftAttachmentMetadata[]; synthetic?: boolean }>; revision: number }) => {
  let current = initial;
  const commits: Array<{ snapshot: { text: string; attachments: DraftAttachmentMetadata[]; syntheticParts: Array<{ partID: string; text: string; attachments: DraftAttachmentMetadata[]; synthetic?: boolean }> }; values: ReadonlyMap<string, Blob> }> = [];
  return {
    commits,
    getDraft: (key: DraftKey) => { void key; return current && { ...current, syntheticParts: current.syntheticParts ?? [], mentions: [] }; },
    captureDraftRuntime: () => ({ transportIdentity: 'runtime', generation: 1 }),
    commitDraftSnapshot: async (request: { snapshot: { text: string; attachments: DraftAttachmentMetadata[]; syntheticParts: Array<{ partID: string; text: string; attachments: DraftAttachmentMetadata[]; synthetic?: boolean }> }; values: ReadonlyMap<string, Blob> }) => {
      commits.push(request);
      current = { ...request.snapshot, revision: (current?.revision ?? 0) + 1 };
      return result();
    },
    flushDraftPersistence: async () => undefined,
  };
};

describe('mobile share draft handoff', () => {
  test('merges text and preserves existing attachments in one durable snapshot', async () => {
    const existing: DraftAttachmentMetadata = { attachmentID: 'existing', attachmentRefID: draftRootAttachmentOccurrenceRefID('existing'), filename: 'old.png', mimeType: 'image/png', size: 1, locator: { kind: 'blob', blobID: 'old' }, source: 'local' };
    const state = input({ text: 'existing text', attachments: [existing], revision: 4 });
    let cancels = 0;
    await handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => { cancels++; }, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: storage() });
    expect(state.commits).toHaveLength(1);
    expect(state.commits[0]!.snapshot.text).toBe('existing text\n\nshared');
    expect(state.commits[0]!.snapshot.attachments).toHaveLength(2);
    expect(state.commits[0]!.snapshot.syntheticParts).toEqual([{ partID: mobileShareHandoffMarkerPartID('share-1'), text: '', attachments: [], synthetic: true }]);
    expect(state.commits[0]!.values.get(draftRootAttachmentOccurrenceRefID('native-share:share-1:0'))).toBeInstanceOf(Blob);
    expect(cancels).toBe(1);
  });

  test('retains the native draft while durable commit fails', async () => {
    const state = input();
    state.commitDraftSnapshot = async () => ({ ...result(), durable: false, current: false, status: 'failed' });
    let cancels = 0;
    await expect(handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => { cancels++; }, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: storage() })).rejects.toThrow('draft_handoff_failed');
    expect(cancels).toBe(0);
  });

  test('recovery after cancel failure only cancels and never appends again', async () => {
    const state = input();
    const journal = storage();
    let cancels = 0;
    await handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => { cancels++; throw new Error('native_busy'); }, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: journal });
    await handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => { cancels++; }, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: journal });
    expect(state.commits).toHaveLength(1);
    expect(cancels).toBe(2);
  });

  test('recovery transitions materialized journals to cancelled and retains them for navigation finalization', async () => {
    const journal = storage();
    journal.setItem(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY, JSON.stringify({
      materializing: { draftID: 'materializing', serverInstanceID: 'server', connectionKey: 'connection', assistantID: 'first', transportIdentity: 'runtime', targetDraftKey: { transportIdentity: 'runtime', owner: { kind: 'surface', ownerID: 'assistant:first' } }, baseRevision: 'absent', resultText: 'first', attachmentIDs: [], phase: 'materializing' },
      materialized: { draftID: 'materialized', serverInstanceID: 'server', connectionKey: 'connection', assistantID: 'second', transportIdentity: 'runtime', targetDraftKey: { transportIdentity: 'runtime', owner: { kind: 'surface', ownerID: 'assistant:second' } }, baseRevision: 'absent', resultText: 'second', attachmentIDs: [], phase: 'materialized' },
    }));
    const cancelled: string[] = [];
    const targets = await retryMobileShareDraftCancellations(async (draftID) => { cancelled.push(draftID); }, journal);
    expect(cancelled).toEqual(['materialized']);
    expect(targets).toEqual([{ draftID: 'materialized', serverInstanceID: 'server', connectionKey: 'connection', assistantID: 'second', transportIdentity: 'runtime' }]);
    expect(journal.values.get(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY)).toContain('materializing');
    expect(journal.values.get(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY)).toContain('cancelled');
    expect(await retryMobileShareDraftCancellations(async (draftID) => { cancelled.push(draftID); }, journal)).toEqual(targets);
    expect(cancelled).toEqual(['materialized']);
    expect(finalizeMobileShareDraftHandoff(targets[0]!, journal)).toBe(true);
    expect(journal.values.get(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY)).toContain('materializing');
  });

  test('retains the native draft when phase persistence fails after a durable commit', async () => {
    const state = input();
    let writes = 0;
    const journal = {
      ...storage(),
      setItem: (key: string, value: string) => {
        writes += 1;
        if (writes === 3) throw new Error('storage_full');
        journal.values.set(key, value);
      },
    };
    let cancels = 0;
    await expect(handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => { cancels += 1; }, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: journal })).rejects.toThrow('handoff_journal_unavailable');
    expect(state.commits).toHaveLength(1);
    expect(cancels).toBe(0);
  });

  test('marker preserves durable handoff through later user text edits and attachment deletion', async () => {
    const marker = { partID: mobileShareHandoffMarkerPartID('share-1'), text: '', attachments: [], synthetic: true };
    const state = input({ text: 'edited by user', attachments: [], syntheticParts: [marker], revision: 5 });
    const journal = storage();
    journal.setItem(MOBILE_SHARE_DRAFT_HANDOFF_JOURNAL_KEY, JSON.stringify({
      'share-1': { draftID: 'share-1', serverInstanceID: 'server', connectionKey: 'connection', assistantID: 'assistant', transportIdentity: 'runtime', targetDraftKey: { transportIdentity: 'runtime', owner: { kind: 'surface', ownerID: 'assistant:assistant' } }, baseRevision: 4, resultText: 'shared', attachmentIDs: ['native-share:share-1:0'], phase: 'materializing' },
    }));
    await handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => undefined, readAttachment: async () => new Blob(), storage: journal });
    expect(state.commits).toHaveLength(0);
  });

  test('durably clears only the target marker before journal finalization', async () => {
    const marker = { partID: mobileShareHandoffMarkerPartID('share-1'), text: '', attachments: [], synthetic: true };
    const other = { partID: mobileShareHandoffMarkerPartID('share-2'), text: '', attachments: [], synthetic: true };
    const state = input({ text: 'shared', attachments: [], syntheticParts: [marker, other], revision: 4 });
    let flushed = 0;
    state.flushDraftPersistence = async () => { flushed += 1; };
    expect(await clearMobileShareDraftHandoffMarker({ draftID: 'share-1', serverInstanceID: 'server', connectionKey: 'connection', assistantID: 'assistant', transportIdentity: 'runtime' }, state)).toBe(true);
    expect(state.commits[0]!.snapshot.syntheticParts).toEqual([other]);
    expect(flushed).toBe(1);
  });

  test('retries a CAS conflict with the current composer snapshot', async () => {
    const state = input({ text: 'first', attachments: [], revision: 1 });
    let attempts = 0;
    const commit = state.commitDraftSnapshot;
    state.commitDraftSnapshot = async (request) => {
      attempts++;
      if (attempts === 1) return result('conflict');
      return commit(request);
    };
    await handoffMobileShareDraft(draft(), { input: state, transportIdentity: 'runtime', cancelDraft: async () => undefined, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: storage() });
    expect(attempts).toBe(2);
    expect(state.commits).toHaveLength(1);
  });

  test('a failed draft leaves a later draft eligible for handoff', async () => {
    const failed = input();
    failed.commitDraftSnapshot = async () => result('failed');
    const succeeding = input();
    const dependencies = (state: typeof failed) => ({ input: state, transportIdentity: 'runtime', cancelDraft: async () => undefined, readAttachment: async () => new Blob(['img'], { type: 'image/png' }), storage: storage() });
    await handoffMobileShareDraft(draft(), dependencies(failed)).catch(() => undefined);
    await handoffMobileShareDraft(draft({ draftID: 'share-2', assistantID: 'assistant-2' }), dependencies(succeeding));
    expect(succeeding.commits).toHaveLength(1);
  });
});
