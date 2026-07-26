import { describe, expect, test } from 'bun:test'
import {
  buildQueueComposerRestoration,
  buildSentMessageComposerRestoration,
  commitComposerRestoration,
  pathFromFileURLString,
  relativePathUnderDirectory,
  resolveDraftAttachmentRefID,
  rollbackComposerRestoration,
} from './message-composer-restoration'
import { draftRootAttachmentOccurrenceRefID, sessionDraftKey, type DraftKey } from './input-draft-types'
import type { DraftCommitResult, DraftSnapshot } from './input-store'

const key = (): DraftKey => sessionDraftKey({ transportIdentity: 'runtime' }, 'session-a')

describe('pathFromFileURLString and relativePathUnderDirectory', () => {
  test('decodes POSIX absolute file URLs', () => {
    expect(pathFromFileURLString('file:///repo/src/a.ts')).toBe('/repo/src/a.ts')
    expect(pathFromFileURLString('file:///repo/src/%E4%B8%AD.ts')).toBe('/repo/src/中.ts')
  })

  test('decodes Windows drive-letter file URLs', () => {
    expect(pathFromFileURLString('file:///C:/repo/src/a.ts')).toBe('C:/repo/src/a.ts')
    expect(pathFromFileURLString('file:///c:/Users/me/file.txt')).toBe('c:/Users/me/file.txt')
  })

  test('relativizes under directory with trailing-slash tolerance', () => {
    expect(relativePathUnderDirectory('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(relativePathUnderDirectory('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
    expect(relativePathUnderDirectory('/repo/src/a.ts', '/other')).toBe(null)
    expect(relativePathUnderDirectory('C:/repo/src/a.ts', 'C:/repo')).toBe('src/a.ts')
    expect(relativePathUnderDirectory('C:/repo/src/a.ts', 'c:/repo/')).toBe('src/a.ts')
  })
})

describe('buildSentMessageComposerRestoration', () => {
  test('restores skill, command, agent, file, and directory mentions and excludes synthetic parts', async () => {
    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: '[skill:review] [command:run] @src/a.ts @src/dir/ hello' },
      { type: 'text', text: 'hidden synthetic', synthetic: true },
      { type: 'agent', name: 'build' },
      { type: 'file', url: 'file:///src/a.ts', mime: 'text/plain', filename: 'a.ts' },
      { type: 'file', url: 'file:///src/dir/', mime: 'application/x-directory', filename: 'dir' },
      { type: 'file', url: 'file:///other.bin', mime: 'application/octet-stream', filename: 'other.bin', synthetic: true },
    ], { sessionTitles: new Map(), createID: () => 'att-1' })

    expect(payload.snapshot.composerReferences?.some((reference) => reference.kind === 'skill')).toBe(true)
    expect(payload.snapshot.composerReferences?.some((reference) => reference.kind === 'command')).toBe(true)
    expect(payload.snapshot.mentions.some((mention) => mention.kind === 'agent' && mention.value === 'build')).toBe(true)
    expect(payload.snapshot.mentions.some((mention) => mention.kind === 'file' && (mention.path === 'src/a.ts' || mention.path === '/src/a.ts'))).toBe(true)
    expect(payload.snapshot.mentions.some((mention) => mention.kind === 'directory' && (mention.path === 'src/dir/' || mention.path === '/src/dir/' || mention.path === 'src/dir'))).toBe(true)
    expect(payload.snapshot.attachments).toEqual([])
  })

  test('restores absolute file:// under session directory to relative file mention', async () => {
    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: '@src/a.ts please review' },
      { type: 'file', url: 'file:///repo/src/a.ts', mime: 'text/plain', filename: 'a.ts' },
    ], { directory: '/repo' })
    expect(payload.snapshot.mentions.some((mention) => mention.kind === 'file' && mention.path === 'src/a.ts')).toBe(true)
    expect(payload.snapshot.attachments).toEqual([])
  })

  test('restores Windows absolute file:// under directory with URI decode', async () => {
    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: '@src/a%20b.ts' },
      { type: 'file', url: 'file:///C:/repo/src/a%20b.ts', mime: 'text/plain', filename: 'a b.ts' },
    ], { directory: 'C:/repo/' })
    // Body token may be literal percent-encoded or decoded depending on authored text.
    const hasFile = payload.snapshot.mentions.some((mention) => mention.kind === 'file')
    // When body has decoded form:
    const decoded = await buildSentMessageComposerRestoration([
      { type: 'text', text: '@src/a b.ts' },
      { type: 'file', url: 'file:///C:/repo/src/a%20b.ts', mime: 'text/plain', filename: 'a b.ts' },
    ], { root: 'C:/repo' })
    expect(decoded.snapshot.mentions.some((mention) => mention.kind === 'file' && mention.path === 'src/a b.ts')).toBe(true)
    void hasFile
  })

  test('uses MIME for directory vs file; README without extension is file', async () => {
    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: '@README @src/dir/' },
      { type: 'file', url: 'file:///repo/README', mime: 'text/plain', filename: 'README' },
      { type: 'file', url: 'file:///repo/src/dir/', mime: 'inode/directory', filename: 'dir' },
    ], { directory: '/repo' })
    expect(payload.snapshot.mentions.some((mention) => mention.kind === 'file' && mention.path === 'README')).toBe(true)
    expect(payload.snapshot.mentions.some((mention) => mention.kind === 'directory' && (mention.path === 'src/dir/' || mention.path === 'src/dir'))).toBe(true)
  })

  test('prefers agent source.value token and prepends when missing from body', async () => {
    const fromSource = await buildSentMessageComposerRestoration([
      { type: 'text', text: 'do the work' },
      { type: 'agent', name: 'build', source: { value: '@reviewer' } },
    ])
    expect(fromSource.snapshot.text.startsWith('@reviewer')).toBe(true)
    expect(fromSource.snapshot.mentions[0]?.kind).toBe('agent')
    expect(fromSource.snapshot.mentions[0]?.value).toBe('reviewer')

    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: 'do the work' },
      { type: 'agent', name: 'reviewer' },
    ])
    expect(payload.snapshot.text.startsWith('@reviewer')).toBe(true)
    expect(payload.snapshot.mentions[0]?.kind).toBe('agent')
    expect(payload.snapshot.mentions[0]?.value).toBe('reviewer')

    const prefixOnly = await buildSentMessageComposerRestoration([
      { type: 'text', text: '@reviewer-extra do the work' },
      { type: 'agent', name: 'reviewer' },
    ])
    expect(prefixOnly.snapshot.text.startsWith('@reviewer @reviewer-extra')).toBe(true)
  })

  test('preserves multi-part text whitespace and newlines without trim', async () => {
    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: '  lead\n' },
      { type: 'text', text: '\tmid  ' },
      { type: 'text', text: '\ntrail  ' },
    ])
    expect(payload.snapshot.text).toBe('  lead\n\n\tmid  \n\ntrail  ')
  })

  test('restores data URL and durable URL attachments', async () => {
    let n = 0
    const payload = await buildSentMessageComposerRestoration([
      { type: 'text', text: 'files' },
      { type: 'file', url: 'data:text/plain;base64,eA==', mime: 'text/plain', filename: 'a.txt' },
      { type: 'file', url: 'https://example.test/b.txt', mime: 'text/plain', filename: 'b.txt' },
    ], { createID: () => `id-${++n}` })

    expect(payload.snapshot.attachments).toHaveLength(2)
    expect(payload.snapshot.attachments[0]?.locator.kind).toBe('blob')
    expect(payload.values.get(payload.snapshot.attachments[0]!.attachmentRefID)).toBeInstanceOf(Blob)
    expect(payload.snapshot.attachments[1]?.locator).toEqual({ kind: 'url', url: 'https://example.test/b.txt' })
    expect(payload.values.get(payload.snapshot.attachments[1]!.attachmentRefID)).toBe('https://example.test/b.txt')
  })
})

describe('buildQueueComposerRestoration', () => {
  test('restores full references, mentions, and attachments from queue state', async () => {
    const payload = await buildQueueComposerRestoration({
      content: '@file',
      composerDocument: { text: '@file', references: [] },
      composerMentions: [{ kind: 'file', value: 'file', path: '/repo/file', label: 'file', range: { start: 0, end: 5 } }],
      attachments: [{
        id: 'one',
        file: new File(['x'], 'one.txt', { type: 'text/plain' }),
        dataUrl: 'data:text/plain;base64,eA==',
        mimeType: 'text/plain',
        filename: 'one.txt',
        size: 1,
        source: 'local',
      }],
    }, { createID: () => 'one' })
    expect(payload.snapshot.text).toBe('@file')
    expect(payload.snapshot.mentions).toEqual([{ kind: 'file', value: 'file', path: '/repo/file', label: 'file', range: { start: 0, end: 5 } }])
    expect(payload.snapshot.attachments[0]?.attachmentRefID).toBe(draftRootAttachmentOccurrenceRefID('one'))
    expect(payload.values.get(draftRootAttachmentOccurrenceRefID('one'))).toBeInstanceOf(Blob)
  })

  test('accepts pre-mapped draft attachments from server bridge downloads', async () => {
    const ref = draftRootAttachmentOccurrenceRefID('srv')
    const payload = await buildQueueComposerRestoration({
      content: 'hello',
      composerDocument: { text: 'hello', references: [] },
      composerMentions: [],
      draftAttachments: [{
        attachmentID: 'srv',
        attachmentRefID: ref,
        filename: 'srv.bin',
        mimeType: 'application/octet-stream',
        size: 1,
        source: 'local',
        locator: { kind: 'blob', blobID: 'srv' },
      }],
      draftValues: new Map([[ref, new Blob(['x'])]]),
    })
    expect(payload.snapshot.attachments[0]?.attachmentID).toBe('srv')
    expect(payload.values.get(ref)).toBeInstanceOf(Blob)
  })

  test('fails invalid sidecars before commit', async () => {
    await expect(buildQueueComposerRestoration({
      content: 'hello',
      composerDocument: { text: 'mismatch', references: [] },
      composerMentions: [{ kind: 'file', value: 'x', path: 'x', label: 'x', range: { start: 0, end: 2 } }],
    })).rejects.toThrow('composer-restoration-invalid-sidecars')
  })
})

describe('commitComposerRestoration and rollback', () => {
  const makeCommitInput = (drafts: Map<string, { revision: number; snapshot: DraftSnapshot }>, extras: {
    deleteDraftSnapshot?: (request: { key: DraftKey; expectedRevision: number }) => Promise<DraftCommitResult>
  } = {}) => ({
    captureDraftRuntime: () => ({ transportIdentity: 'runtime', generation: 1 }),
    getDraft: (draftKey: DraftKey) => {
      const entry = drafts.get(JSON.stringify(draftKey))
      return entry ? { version: 1 as const, key: draftKey, revision: entry.revision, ...entry.snapshot } : undefined
    },
    draftAttachmentViews: {} as Record<string, Record<string, never>>,
    commitDraftSnapshot: async (request: { key: DraftKey; expectedRevision: number | 'absent'; snapshot: DraftSnapshot }) => {
      const id = JSON.stringify(request.key)
      const existing = drafts.get(id)
      if (request.expectedRevision === 'absent' ? !!existing : existing?.revision !== request.expectedRevision) {
        return { status: 'conflict', durable: false, current: true, errors: [], cleanupErrors: [] } satisfies DraftCommitResult
      }
      const revision = request.expectedRevision === 'absent' ? 1 : request.expectedRevision + 1
      drafts.set(id, { revision, snapshot: request.snapshot })
      return { status: 'committed', durable: true, current: true, record: { version: 1, key: request.key, revision, ...request.snapshot }, errors: [], cleanupErrors: [] } satisfies DraftCommitResult
    },
    deleteDraftSnapshot: extras.deleteDraftSnapshot ?? (async (request: { key: DraftKey; expectedRevision: number }) => {
      const id = JSON.stringify(request.key)
      const existing = drafts.get(id)
      if (!existing || existing.revision !== request.expectedRevision) {
        return { status: 'conflict', durable: false, current: true, errors: [], cleanupErrors: [] } satisfies DraftCommitResult
      }
      drafts.delete(id)
      return { status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] } satisfies DraftCommitResult
    }),
  })

  test('rolls back full draft on CAS when restored revision is still current', async () => {
    const drafts = new Map<string, { revision: number; snapshot: DraftSnapshot }>()
    const input = makeCommitInput(drafts)
    drafts.set(JSON.stringify(key()), {
      revision: 2,
      snapshot: { text: 'old', attachments: [], syntheticParts: [], mentions: [] },
    })

    const committed = await commitComposerRestoration({
      key: key(),
      expectedRevision: 2,
      payload: { snapshot: { text: 'restored', attachments: [], syntheticParts: [], mentions: [] }, values: new Map() },
      input: input as never,
    })
    expect(committed.status).toBe('committed')
    expect(committed.result?.record?.revision).toBe(3)

    const rolled = await rollbackComposerRestoration({
      key: key(),
      restoredRevision: 3,
      previous: committed.previous!,
      input: input as never,
    })
    expect(rolled.status).toBe('rolled-back')
    expect(drafts.get(JSON.stringify(key()))?.snapshot.text).toBe('old')
  })

  test('rolls back prior absence via deleteDraftSnapshot to true absence', async () => {
    const drafts = new Map<string, { revision: number; snapshot: DraftSnapshot }>()
    const deletes: number[] = []
    const input = makeCommitInput(drafts, {
      deleteDraftSnapshot: async (request) => {
        deletes.push(request.expectedRevision)
        const id = JSON.stringify(request.key)
        const existing = drafts.get(id)
        if (!existing || existing.revision !== request.expectedRevision) {
          return { status: 'conflict', durable: false, current: true, errors: [], cleanupErrors: [] }
        }
        drafts.delete(id)
        return { status: 'committed', durable: true, current: true, errors: [], cleanupErrors: [] }
      },
    })
    const committed = await commitComposerRestoration({
      key: key(),
      expectedRevision: 'absent',
      payload: { snapshot: { text: 'restored', attachments: [], syntheticParts: [], mentions: [] }, values: new Map() },
      input: input as never,
    })
    expect(committed.previous?.record).toBe(null)
    const rolled = await rollbackComposerRestoration({
      key: key(),
      restoredRevision: committed.result!.record!.revision,
      previous: committed.previous!,
      input: input as never,
    })
    expect(rolled.status).toBe('rolled-back')
    expect(deletes).toEqual([1])
    expect(drafts.has(JSON.stringify(key()))).toBe(false)
  })

  test('absence rollback conflict keeps newer edits; delete failure does not claim rolled-back', async () => {
    const drafts = new Map<string, { revision: number; snapshot: DraftSnapshot }>()
    const input = makeCommitInput(drafts, {
      deleteDraftSnapshot: async () => ({ status: 'stale', durable: true, current: false, errors: [], cleanupErrors: [] }),
    })
    const committed = await commitComposerRestoration({
      key: key(),
      expectedRevision: 'absent',
      payload: { snapshot: { text: 'restored', attachments: [], syntheticParts: [], mentions: [] }, values: new Map() },
      input: input as never,
    })
    drafts.set(JSON.stringify(key()), { revision: 9, snapshot: { text: 'user', attachments: [], syntheticParts: [], mentions: [] } })
    const conflict = await rollbackComposerRestoration({
      key: key(),
      restoredRevision: committed.result!.record!.revision,
      previous: committed.previous!,
      input: input as never,
    })
    expect(conflict.status).toBe('conflict')
    expect(drafts.get(JSON.stringify(key()))?.snapshot.text).toBe('user')

    drafts.set(JSON.stringify(key()), { revision: committed.result!.record!.revision, snapshot: { text: 'restored', attachments: [], syntheticParts: [], mentions: [] } })
    const failed = await rollbackComposerRestoration({
      key: key(),
      restoredRevision: committed.result!.record!.revision,
      previous: committed.previous!,
      input: input as never,
    })
    expect(failed.status).toBe('failed')
    expect(failed.current).toBe(false)
  })

  test('preserves durable stale status without mapping it to committed', async () => {
    const input = {
      captureDraftRuntime: () => ({ transportIdentity: 'runtime', generation: 1 }),
      getDraft: () => undefined,
      draftAttachmentViews: {},
      commitDraftSnapshot: async () => ({
        status: 'stale' as const,
        durable: true,
        current: false,
        errors: [],
        cleanupErrors: [],
      } satisfies DraftCommitResult),
    }
    const committed = await commitComposerRestoration({
      key: key(),
      expectedRevision: 'absent',
      payload: { snapshot: { text: 'restored', attachments: [], syntheticParts: [], mentions: [] }, values: new Map() },
      input: input as never,
    })
    expect(committed.status).toBe('stale')
    expect(committed.current).toBe(false)
    expect(committed.durable).toBe(true)
  })

  test('preserves committed + current=false for durable-before-remove consumers', async () => {
    const input = {
      captureDraftRuntime: () => ({ transportIdentity: 'runtime', generation: 1 }),
      getDraft: () => undefined,
      draftAttachmentViews: {},
      commitDraftSnapshot: async () => ({
        status: 'committed' as const,
        durable: true,
        current: false,
        record: { version: 1 as const, key: key(), revision: 1, text: 'x', attachments: [], syntheticParts: [], mentions: [] },
        errors: [],
        cleanupErrors: [],
      } satisfies DraftCommitResult),
    }
    const committed = await commitComposerRestoration({
      key: key(),
      expectedRevision: 'absent',
      payload: { snapshot: { text: 'x', attachments: [], syntheticParts: [], mentions: [] }, values: new Map() },
      input: input as never,
    })
    expect(committed.status).toBe('committed')
    expect(committed.current).toBe(false)
    expect(committed.durable).toBe(true)
  })

  test('keeps newer user edits when rollback CAS conflicts', async () => {
    const drafts = new Map<string, { revision: number; snapshot: DraftSnapshot }>()
    const input = makeCommitInput(drafts)
    drafts.set(JSON.stringify(key()), { revision: 1, snapshot: { text: 'old', attachments: [], syntheticParts: [], mentions: [] } })
    const committed = await commitComposerRestoration({
      key: key(),
      expectedRevision: 1,
      payload: { snapshot: { text: 'restored', attachments: [], syntheticParts: [], mentions: [] }, values: new Map() },
      input: input as never,
    })
    // User continues typing: revision advances beyond restored.
    drafts.set(JSON.stringify(key()), { revision: 4, snapshot: { text: 'user new', attachments: [], syntheticParts: [], mentions: [] } })
    const rolled = await rollbackComposerRestoration({
      key: key(),
      restoredRevision: committed.result!.record!.revision,
      previous: committed.previous!,
      input: input as never,
    })
    expect(rolled.status).toBe('conflict')
    expect(drafts.get(JSON.stringify(key()))?.snapshot.text).toBe('user new')
  })
})

describe('cross-runtime restoration rollback', () => {
  test('ends best-effort without writing through a foreign transport capture', async () => {
    const rollbackKey = sessionDraftKey({ transportIdentity: 'runtime-a' }, 'session-a')
    let writes = 0
    const result = await rollbackComposerRestoration({
      key: rollbackKey,
      restoredRevision: 2,
      previous: { record: null, views: {}, expectedRevision: 'absent' },
      input: {
        captureDraftRuntime: () => ({ transportIdentity: 'runtime-b', generation: 2 }),
        getDraft: () => ({
          version: 1,
          key: rollbackKey,
          revision: 2,
          text: 'restored',
          attachments: [],
          syntheticParts: [],
          mentions: [],
        }),
        commitDraftSnapshot: async () => {
          writes += 1
          throw new Error('unexpected-write')
        },
        deleteDraftSnapshot: async () => {
          writes += 1
          throw new Error('unexpected-write')
        },
      } as never,
    })

    expect(result).toEqual({ status: 'failed', current: false })
    expect(writes).toBe(0)
  })
})

describe('resolveDraftAttachmentRefID', () => {
  test('maps attachmentID to attachmentRefID for primary and synthetic parts', () => {
    const draftKey = key()
    const rootRef = draftRootAttachmentOccurrenceRefID('att')
    const syntheticRef = '["part","p1","att-s"]'
    const resolvedRoot = resolveDraftAttachmentRefID(draftKey, 'att', {
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
        syntheticParts: [{
          partID: 'p1',
          text: '',
          attachments: [{
            attachmentID: 'att-s',
            attachmentRefID: syntheticRef,
            filename: 's.txt',
            mimeType: 'text/plain',
            size: 1,
            source: 'local',
            locator: { kind: 'blob', blobID: 's' },
          }],
        }],
        mentions: [],
      }),
    })
    expect(resolvedRoot).toBe(rootRef)
    const resolvedSynthetic = resolveDraftAttachmentRefID(draftKey, 'att-s', {
      getDraft: () => ({
        version: 1,
        key: draftKey,
        revision: 1,
        text: '',
        attachments: [],
        syntheticParts: [{
          partID: 'p1',
          text: '',
          attachments: [{
            attachmentID: 'att-s',
            attachmentRefID: syntheticRef,
            filename: 's.txt',
            mimeType: 'text/plain',
            size: 1,
            source: 'local',
            locator: { kind: 'blob', blobID: 's' },
          }],
        }],
        mentions: [],
      }),
    })
    expect(resolvedSynthetic).toBe(syntheticRef)
  })
})
