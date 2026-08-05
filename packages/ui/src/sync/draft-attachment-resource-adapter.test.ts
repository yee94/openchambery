import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  createDraftAttachmentResourceAdapter,
  isRootAttachmentReplaceCommitted,
  resolveDraftAttachmentRefID,
} from './draft-attachment-resource-adapter'
import { createInputDraftBlobStore, MemoryInputDraftBlobDriver } from './input-draft-blob-store'
import { createInputDraftMetadataStorageSink } from './input-draft-metadata-store'
import {
  draftRootAttachmentOccurrenceRefID,
  draftSyntheticPartAttachmentOccurrenceRefID,
  sessionDraftKey,
  type DraftKey,
} from './input-draft-types'
import { createInputStore, type DraftCommitResult } from './input-store'

const TRANSPORT = 'runtime-adapter'
const key = (id = 'ses_adapter'): DraftKey => sessionDraftKey({ transportIdentity: TRANSPORT }, id)

class MemoryStorage {
  values = new Map<string, string>()
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(k: string) { return this.values.get(k) ?? null }
  setItem(k: string, value: string) { this.values.set(k, value) }
  removeItem(k: string) { this.values.delete(k) }
}

/** Auto-resolving FileReader so commitDraftSnapshot view rebuilds do not hang. */
class AutoFileReader {
  result: string | ArrayBuffer | null = 'data:text/plain;base64,eA=='
  onload: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  onabort: ((event: ProgressEvent<FileReader>) => unknown) | null = null
  readAsDataURL() {
    queueMicrotask(() => this.onload?.({} as ProgressEvent<FileReader>))
  }
}

describe('draft-attachment-resource-adapter', () => {
  let store: ReturnType<typeof createInputStore>
  let runtime = { transportIdentity: TRANSPORT, generation: 1 }
  const OriginalFileReader = globalThis.FileReader

  beforeEach(async () => {
    runtime = { transportIdentity: TRANSPORT, generation: 1 }
    globalThis.FileReader = AutoFileReader as unknown as typeof FileReader
    store = createInputStore({
      sink: createInputDraftMetadataStorageSink(new MemoryStorage() as unknown as Storage),
      blobStore: createInputDraftBlobStore(new MemoryInputDraftBlobDriver()),
      runtimeCapture: () => runtime,
    })
    await store.getState().hydrateDraftMetadata(TRANSPORT)
  })

  afterEach(() => {
    globalThis.FileReader = OriginalFileReader
  })

  test('clearRootAttachments preserves synthetic-part attachments', async () => {
    const draftKey = key()
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [{ partID: 'part', text: 'ctx', attachments: [] }])
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    await adapter.addLocal(new File(['root'], 'root.txt', { type: 'text/plain' }))
    await store.getState().addDraftLocalAttachment(
      draftKey,
      new File(['syn'], 'syn.txt', { type: 'text/plain' }),
      { partID: 'part' },
    )

    const cleared = await adapter.clearRootAttachments()
    expect(cleared).toBe(true)
    expect(store.getState().getDraft(draftKey)?.attachments).toEqual([])
    expect(store.getState().getDraft(draftKey)?.syntheticParts[0]?.attachments.length).toBeGreaterThan(0)
  })

  test('clearRootAttachments clears memory without waiting for replacement CAS', async () => {
    const draftKey = key('ses_clear_false')
    store.getState().ensureDraft(draftKey)
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'keep',
      filename: 'keep.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/keep.txt',
      url: 'https://example.test/keep.txt',
    })
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => ({
      ...store.getState(),
      replaceDraftRootAttachments: async () => { throw new Error('replacement CAS should not run') },
    }))
    expect(await adapter.clearRootAttachments()).toBe(true)
    expect(store.getState().getDraft(draftKey)?.attachments).toEqual([])
  })

  test('restoreRootAttachments merges failed with live extras by attachmentID', async () => {
    const draftKey = key('ses_restore_merge')
    store.getState().ensureDraft(draftKey)
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    const failed = [{
      id: 'failed',
      file: new File([], 'failed.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/failed.txt',
      mimeType: 'text/plain',
      filename: 'failed.txt',
      size: 6,
      source: 'server' as const,
      serverPath: '/failed.txt',
    }]
    // Live extra added while send was in flight.
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'live-extra',
      filename: 'extra.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/extra.txt',
      url: 'https://example.test/extra.txt',
    })
    expect(await adapter.restoreRootAttachments(failed)).toBe(true)
    const ids = store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID) ?? []
    expect(ids).toEqual(['failed', 'live-extra'])
  })

  test('clear then user add then restore ends with original plus new', async () => {
    const draftKey = key('ses_clear_add_restore')
    store.getState().ensureDraft(draftKey)
    const clearAdapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    const restoreAdapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'original',
      filename: 'original.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/original.txt',
      url: 'https://example.test/original.txt',
    })
    const originalViews = store.getState().getDraftAttachmentViews(draftKey)
    expect(await clearAdapter.clearRootAttachments()).toBe(true)
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'user-new',
      filename: 'new.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/new.txt',
      url: 'https://example.test/new.txt',
    })
    expect(await restoreAdapter.restoreRootAttachments(originalViews)).toBe(true)
    const ids = store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID) ?? []
    expect(ids).toContain('original')
    expect(ids).toContain('user-new')
  })

  test('removeByAttachmentID resolves synthetic attachmentID', async () => {
    const draftKey = key('ses_remove')
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [{ partID: 'part', text: 'ctx', attachments: [] }])
    await store.getState().addDraftLocalAttachment(
      draftKey,
      new File(['syn'], 'syn.txt', { type: 'text/plain' }),
      { partID: 'part', attachmentID: 'att-s' },
    )
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    expect(resolveDraftAttachmentRefID(draftKey, 'att-s', store.getState())).toBe(
      draftSyntheticPartAttachmentOccurrenceRefID('part', 'att-s'),
    )
    await adapter.removeByAttachmentID('att-s')
    expect(store.getState().getDraft(draftKey)?.syntheticParts[0]?.attachments).toEqual([])
  })

  test('replaceRootAttachments preserves server and vscode file metadata', async () => {
    const draftKey = key('ses_replace')
    store.getState().ensureDraft(draftKey)
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    const serverFile = {
      id: 'srv-1',
      file: new File([], 'server.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/server.txt',
      mimeType: 'text/plain',
      filename: 'server.txt',
      size: 4,
      source: 'server' as const,
      serverPath: '/server.txt',
    }
    const vscodeFile = {
      id: 'vs-1',
      file: new File([], 'hello.ts', { type: 'text/plain' }),
      dataUrl: 'file:///workspace/hello.ts',
      mimeType: 'text/plain',
      filename: 'hello.ts',
      size: 12,
      source: 'vscode' as const,
      vscodePath: '/workspace/hello.ts',
      vscodeSource: 'file' as const,
    }
    const result = await adapter.replaceRootAttachments([serverFile, vscodeFile])
    expect(result?.status).toBe('committed')
    const draft = store.getState().getDraft(draftKey)
    expect(draft?.attachments).toHaveLength(2)
    const server = draft?.attachments.find((a) => a.attachmentID === 'srv-1')
    const vscode = draft?.attachments.find((a) => a.attachmentID === 'vs-1')
    expect(server?.source).toBe('server')
    expect(server?.serverPath).toBe('/server.txt')
    expect(server?.locator).toEqual({ kind: 'url', url: 'https://example.test/server.txt' })
    expect(vscode?.source).toBe('vscode')
    expect(vscode?.vscodeSource).toBe('file')
    expect(vscode?.vscodePath).toBe('/workspace/hello.ts')
    expect(vscode?.locator).toEqual({ kind: 'url', url: 'file:///workspace/hello.ts' })
  })

  test('replaceRootAttachments uses a single commit with no per-item remove', async () => {
    const draftKey = key('ses_single_commit')
    store.getState().ensureDraft(draftKey)
    const commits: unknown[] = []
    const removes: string[] = []
    const state = store.getState()
    const originalCommit = state.commitDraftSnapshot.bind(state)
    const originalRemove = state.removeDraftAttachment.bind(state)
    const originalReplace = state.replaceDraftRootAttachments.bind(state)

    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => ({
      getDraft: store.getState().getDraft,
      getDraftAttachmentViews: store.getState().getDraftAttachmentViews,
      setDraftAttachments: store.getState().setDraftAttachments,
      addDraftLocalAttachment: store.getState().addDraftLocalAttachment,
      addDraftDurableAttachment: store.getState().addDraftDurableAttachment,
      removeDraftAttachment: async (k, ref) => {
        removes.push(ref)
        return originalRemove(k, ref)
      },
      addDraftVSCodeFileAttachment: store.getState().addDraftVSCodeFileAttachment,
      addDraftVSCodeSelectionAttachment: store.getState().addDraftVSCodeSelectionAttachment,
      restoreDraftRootAttachments: store.getState().restoreDraftRootAttachments,
      replaceDraftRootAttachments: async (k, attachments) => {
        const live = store.getState()
        const prev = live.commitDraftSnapshot
        live.commitDraftSnapshot = async (request) => {
          commits.push(request)
          return originalCommit(request)
        }
        try {
          return await originalReplace(k, attachments)
        } finally {
          live.commitDraftSnapshot = prev
        }
      },
    }))

    await adapter.replaceRootAttachments([{
      id: 'one',
      file: new File(['a'], 'a.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/a.txt',
      mimeType: 'text/plain',
      filename: 'a.txt',
      size: 1,
      source: 'server',
      serverPath: '/a.txt',
    }])
    expect(commits).toHaveLength(1)
    expect(removes).toEqual([])
  })

  test('replaceRootAttachments commit failure leaves original root unchanged', async () => {
    const draftKey = key('ses_fail')
    store.getState().ensureDraft(draftKey)
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'keep',
      filename: 'keep.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/keep.txt',
      url: 'https://example.test/keep.txt',
    })
    const before = store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID)
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => ({
      ...store.getState(),
      replaceDraftRootAttachments: async () => ({
        status: 'failed',
        durable: false,
        current: false,
        errors: [],
        cleanupErrors: [],
      } satisfies DraftCommitResult),
    }))
    await adapter.replaceRootAttachments([{
      id: 'new',
      file: new File(['n'], 'n.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/n.txt',
      mimeType: 'text/plain',
      filename: 'n.txt',
      size: 1,
      source: 'server',
      serverPath: '/n.txt',
    }])
    expect(store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID)).toEqual(before)
  })

  test('clear then restore across two adapter instances ends at restore target', async () => {
    const draftKey = key('ses_clear_restore')
    store.getState().ensureDraft(draftKey)
    const first = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    const second = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'old',
      filename: 'old.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/old.txt',
      url: 'https://example.test/old.txt',
    })
    const restored = [{
      id: 'restored',
      file: new File([], 'restored.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/restored.txt',
      mimeType: 'text/plain',
      filename: 'restored.txt',
      size: 8,
      source: 'server' as const,
      serverPath: '/restored.txt',
    }]
    // Fire-and-forget: same key lane must order clear → restore.
    const clearP = first.clearRootAttachments()
    const restoreP = second.replaceRootAttachments(restored)
    await Promise.all([clearP, restoreP])
    const ids = store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID)
    expect(ids).toEqual(['restored'])
  })

  test('replacement CAS conflict retains concurrent root add', async () => {
    const draftKey = key('ses_cas')
    store.getState().ensureDraft(draftKey)
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'orig',
      filename: 'orig.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/orig.txt',
      url: 'https://example.test/orig.txt',
    })
    const expectedRevision = store.getState().getDraft(draftKey)!.revision
    // Concurrent add bumps revision before CAS commit with stale expectedRevision.
    store.getState().addDraftDurableAttachment(draftKey, {
      attachmentID: 'concurrent',
      filename: 'c.txt',
      mimeType: 'text/plain',
      size: 1,
      source: 'server',
      serverPath: '/c.txt',
      url: 'https://example.test/c.txt',
    })
    const result = await store.getState().commitDraftSnapshot({
      key: draftKey,
      expectedRevision,
      snapshot: {
        text: '',
        attachments: [{
          attachmentID: 'replace-target',
          attachmentRefID: draftRootAttachmentOccurrenceRefID('replace-target'),
          filename: 'r.txt',
          mimeType: 'text/plain',
          size: 1,
          source: 'server',
          locator: { kind: 'url', url: 'https://example.test/r.txt' },
          serverPath: '/r.txt',
        }],
        syntheticParts: [],
        mentions: [],
      },
      values: new Map([[draftRootAttachmentOccurrenceRefID('replace-target'), 'https://example.test/r.txt']]),
      runtime: store.getState().captureDraftRuntime(),
    })
    expect(result.status).toBe('conflict')
    const ids = store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID) ?? []
    expect(ids).toContain('concurrent')
    expect(ids).not.toContain('replace-target')
  })

  test('replaceRootAttachments preserves synthetic metadata and views', async () => {
    const draftKey = key('ses_syn')
    store.getState().ensureDraft(draftKey)
    store.getState().setDraftSyntheticParts(draftKey, [{ partID: 'part', text: 'ctx', attachments: [] }])
    await store.getState().addDraftLocalAttachment(
      draftKey,
      new File(['syn'], 'syn.txt', { type: 'text/plain' }),
      { partID: 'part', attachmentID: 'syn-1' },
    )
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    await adapter.replaceRootAttachments([{
      id: 'root-1',
      file: new File([], 'root.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/root.txt',
      mimeType: 'text/plain',
      filename: 'root.txt',
      size: 4,
      source: 'server',
      serverPath: '/root.txt',
    }])
    const draft = store.getState().getDraft(draftKey)
    expect(draft?.attachments.map((a) => a.attachmentID)).toEqual(['root-1'])
    expect(draft?.syntheticParts[0]?.attachments[0]?.attachmentID).toBe('syn-1')
    const views = store.getState().getDraftAttachmentViews(draftKey)
    expect(views.some((v) => v.id === 'syn-1')).toBe(true)
    expect(views.some((v) => v.id === 'root-1')).toBe(true)
  })

  test('replaceRootAttachments local and vscode selection use blob values', async () => {
    const draftKey = key('ses_local')
    store.getState().ensureDraft(draftKey)
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    const localFile = new File(['local'], 'local.txt', { type: 'text/plain' })
    const selectionFile = new File(['sel'], 'sel.ts:1-2', { type: 'text/plain' })
    const result = await adapter.replaceRootAttachments([
      {
        id: 'loc-1',
        file: localFile,
        dataUrl: 'data:text/plain;base64,bG9jYWw=',
        mimeType: 'text/plain',
        filename: 'local.txt',
        size: localFile.size,
        source: 'local',
      },
      {
        id: 'sel-1',
        file: selectionFile,
        dataUrl: 'data:text/plain;base64,c2Vs',
        mimeType: 'text/plain',
        filename: 'sel.ts:1-2',
        size: selectionFile.size,
        source: 'vscode',
        vscodePath: '/workspace/sel.ts',
        vscodeSource: 'selection',
      },
    ])
    expect(result?.status).toBe('committed')
    const draft = store.getState().getDraft(draftKey)
    const local = draft?.attachments.find((a) => a.attachmentID === 'loc-1')
    const selection = draft?.attachments.find((a) => a.attachmentID === 'sel-1')
    expect(local?.source).toBe('local')
    expect(local?.locator.kind).toBe('blob')
    expect(selection?.source).toBe('vscode')
    expect(selection?.vscodeSource).toBe('selection')
    expect(selection?.locator.kind).toBe('blob')
    expect(selection?.vscodePath).toBe('/workspace/sel.ts')
  })

  test('lane continues after a prior root mutation failure', async () => {
    const draftKey = key('ses_lane_fail')
    store.getState().ensureDraft(draftKey)
    let first = true
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => {
      const state = store.getState()
      return {
        ...state,
        replaceDraftRootAttachments: async (k, attachments) => {
          if (first) {
            first = false
            throw new Error('boom')
          }
          return state.replaceDraftRootAttachments(k, attachments)
        },
      }
    })
    const failed = await adapter.replaceRootAttachments([{
      id: 'fail',
      file: new File([], 'f.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/f.txt',
      mimeType: 'text/plain',
      filename: 'f.txt',
      size: 1,
      source: 'server',
      serverPath: '/f.txt',
    }])
    expect(failed).toBe(undefined)
    const ok = await adapter.replaceRootAttachments([{
      id: 'ok',
      file: new File([], 'ok.txt', { type: 'text/plain' }),
      dataUrl: 'https://example.test/ok.txt',
      mimeType: 'text/plain',
      filename: 'ok.txt',
      size: 1,
      source: 'server',
      serverPath: '/ok.txt',
    }])
    expect(ok?.status).toBe('committed')
    expect(store.getState().getDraft(draftKey)?.attachments.map((a) => a.attachmentID)).toEqual(['ok'])
  })

  test('addVSCodeFile writes the captured DraftKey after active key switches', async () => {
    const target = key('ses_target')
    const other = key('ses_other')
    store.getState().setActiveAttachmentDraft(other)
    const adapter = createDraftAttachmentResourceAdapter(target, () => store.getState())
    await adapter.addVSCodeFile('/workspace/a.ts', 'a.ts', 10)
    expect(store.getState().getDraftAttachmentViews(target)).toHaveLength(1)
    expect(store.getState().getDraftAttachmentViews(other)).toHaveLength(0)
    expect(store.getState().getDraft(target)?.attachments[0]?.vscodePath).toBe('/workspace/a.ts')
  })

  test('addVSCodeSelection is duplicate and in-flight protected for explicit key', async () => {
    const draftKey = key('ses_sel')
    const adapter = createDraftAttachmentResourceAdapter(draftKey, () => store.getState())
    const file = new File(['sel'], 'a.ts:1-2', { type: 'text/plain' })
    const first = adapter.addVSCodeSelection('/workspace/a.ts', file)
    const concurrent = adapter.addVSCodeSelection('/workspace/a.ts', file)
    await Promise.all([first, concurrent])
    expect(store.getState().getDraftAttachmentViews(draftKey)).toHaveLength(1)
    await adapter.addVSCodeSelection('/workspace/a.ts', file)
    expect(store.getState().getDraftAttachmentViews(draftKey)).toHaveLength(1)
  })

  test('pure helper: committed gate', () => {
    expect(isRootAttachmentReplaceCommitted({ status: 'committed', current: true, durable: true, errors: [], cleanupErrors: [] })).toBe(true)
    expect(isRootAttachmentReplaceCommitted({ status: 'committed', current: false, durable: true, errors: [], cleanupErrors: [] })).toBe(false)
    expect(isRootAttachmentReplaceCommitted({ status: 'stale', current: false, durable: false, errors: [], cleanupErrors: [] })).toBe(false)
    expect(isRootAttachmentReplaceCommitted(undefined)).toBe(false)
  })

  test('resolveDraftAttachmentRefID maps root attachmentID', () => {
    const draftKey = key('ses_ref')
    const rootRef = draftRootAttachmentOccurrenceRefID('att')
    expect(resolveDraftAttachmentRefID(draftKey, 'att', {
      getDraft: () => ({
        version: 1,
        key: draftKey,
        revision: 1,
        text: '',
        attachments: [{
          attachmentID: 'att',
          attachmentRefID: rootRef,
          filename: 'a.txt',
          mimeType: 'text/plain',
          size: 1,
          source: 'local',
          locator: { kind: 'blob', blobID: 'b' },
        }],
        syntheticParts: [],
        mentions: [],
      }),
    })).toBe(rootRef)
  })
})
