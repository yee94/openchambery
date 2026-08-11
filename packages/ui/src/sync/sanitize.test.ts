import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '@opencode-ai/sdk/v2'

import {
  stripMessageDiffSnapshots,
  stripSessionDiffSnapshots,
  stripSessionListDetails,
  summarizeFileDiff,
  summarizeFileDiffs,
} from './sanitize'

describe('summarizeFileDiff', () => {
  test('keeps display scalars and drops large body fields', () => {
    const full = {
      file: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@ -1,3 +1,5 @@\n+line',
      before: 'old content',
      after: 'new content',
      from: 'from-blob',
      to: 'to-blob',
    }

    expect(summarizeFileDiff(full)).toEqual({
      file: 'src/a.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
    })
  })

  test('preserves object identity when already a summary', () => {
    const summary = {
      file: 'src/a.ts',
      status: 'added',
      additions: 2,
      deletions: 0,
    }
    expect(summarizeFileDiff(summary)).toBe(summary)
  })

  test('tolerates invalid entries', () => {
    expect(summarizeFileDiff(null)).toBe(null)
    expect(summarizeFileDiff(undefined)).toBe(undefined)
    expect(summarizeFileDiff('nope' as never)).toBe('nope')
  })
})

describe('summarizeFileDiffs', () => {
  test('maps entries and preserves array identity when nothing changes', () => {
    const already = [
      { file: 'a.ts', additions: 1, deletions: 0 },
      { file: 'b.ts', additions: 0, deletions: 2, status: 'deleted' },
    ]
    expect(summarizeFileDiffs(already)).toBe(already)
  })

  test('summarizes heavy entries and keeps light ones by identity', () => {
    const light = { file: 'light.ts', additions: 1, deletions: 0 }
    const heavy = {
      file: 'heavy.ts',
      additions: 5,
      deletions: 2,
      patch: '@@ big patch @@',
      before: 'x',
      after: 'y',
    }
    const input = [light, heavy]
    const next = summarizeFileDiffs(input)

    expect(next).not.toBe(input)
    expect(next[0]).toBe(light)
    expect(next[1]).toEqual({ file: 'heavy.ts', additions: 5, deletions: 2 })
    expect((next[1] as { patch?: string }).patch).toBeUndefined()
  })

  test('tolerates non-array input', () => {
    expect(summarizeFileDiffs(null as never)).toBe(null)
    expect(summarizeFileDiffs(undefined as never)).toBe(undefined)
  })
})

describe('stripSessionDiffSnapshots', () => {
  test('removes oversized revert and summary diff payloads', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      version: '1.0.0',
      time: { created: 1, updated: 2 },
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        snapshot: 'gitsha',
        diff: 'diff --git a/file b/file',
      },
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ additions: 2, deletions: 1, before: 'a', after: 'b', patch: '@@ -1 +1 @@' }],
      },
    } as unknown as Session

    const next = stripSessionDiffSnapshots(session) as Session & {
      revert?: { messageID?: string; partID?: string; snapshot?: string; diff?: string }
      summary?: { diffs?: Array<{ before?: string; after?: string; patch?: string }> }
    }

    expect(next).not.toBe(session)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
    expect(next.summary?.diffs).toEqual([{ additions: 2, deletions: 1 }])
  })

  test('preserves object identity when nothing changes', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      version: '1.0.0',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'msg_2', partID: 'part_3' },
      summary: { additions: 2, deletions: 1, diffs: [{ additions: 2, deletions: 1 }] },
    } as unknown as Session

    expect(stripSessionDiffSnapshots(session)).toBe(session)
  })
})

describe('stripMessageDiffSnapshots', () => {
  test('strips patch and snapshot bodies from message summary diffs', () => {
    const message = {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1 },
      summary: {
        additions: 4,
        deletions: 2,
        diffs: [
          {
            file: 'src/a.ts',
            status: 'modified',
            additions: 4,
            deletions: 2,
            patch: '@@ -1 +1 @@ huge',
            before: 'old',
            after: 'new',
            from: 'from',
            to: 'to',
          },
        ],
      },
    } as unknown as Message

    const next = stripMessageDiffSnapshots(message) as Message & {
      summary?: {
        diffs?: Array<{
          file?: string
          status?: string
          additions?: number
          deletions?: number
          patch?: string
          before?: string
          after?: string
        }>
      }
    }

    expect(next).not.toBe(message)
    expect(next.summary?.diffs).toEqual([
      { file: 'src/a.ts', status: 'modified', additions: 4, deletions: 2 },
    ])
    expect(next.summary?.diffs?.[0]?.patch).toBeUndefined()
  })

  test('preserves message identity when diffs are already summaries', () => {
    const message = {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1 },
      summary: {
        diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }],
      },
    } as unknown as Message

    expect(stripMessageDiffSnapshots(message)).toBe(message)
  })
})

describe('stripSessionListDetails', () => {
  test('removes detail-only fields from session list records', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      time: { created: 1, updated: 2 },
      metadata: {
        openchamber: {
          kind: 'review',
          originalSessionID: 'ses_original',
        },
      },
      permission: [{ permission: 'todowrite' }],
      revert: {
        messageID: 'msg_2',
        partID: 'part_3',
        snapshot: 'gitsha',
        diff: 'diff --git a/file b/file',
      },
      summary: {
        additions: 2,
        deletions: 1,
        files: 1,
        diffs: [{ additions: 2, deletions: 1, patch: '@@ -1 +1 @@' }],
      },
    } as unknown as Session

    const next = stripSessionListDetails(session) as Session & {
      metadata?: unknown
      permission?: unknown
      revert?: { messageID?: string; partID?: string; snapshot?: string; diff?: string }
      summary?: { additions?: number; deletions?: number; files?: number; diffs?: unknown[] }
    }

    expect(next).not.toBe(session)
    expect(next.metadata).toEqual({
      openchamber: {
        kind: 'review',
        originalSessionID: 'ses_original',
      },
    })
    expect(next.permission).toBe(undefined)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
    expect(next.summary).toEqual({ additions: 2, deletions: 1, files: 1 })
  })

  test('preserves metadata extension fields in session list records', () => {
    const session = {
      id: 'ses_1',
      directory: '/repo/app',
      title: 'Session',
      time: { created: 1, updated: 2 },
      metadata: { custom: { value: 'kept' } },
      summary: { additions: 2, deletions: 1, files: 1, diffs: [{ patch: '@@ -1 +1 @@' }] },
    } as unknown as Session

    const next = stripSessionListDetails(session) as Session & {
      metadata?: unknown
      summary?: { diffs?: unknown[] }
    }

    expect(next).not.toBe(session)
    expect(next.metadata).toEqual({ custom: { value: 'kept' } })
    expect(next.summary?.diffs).toBe(undefined)
  })

  test('keeps summary fields other than list-only diffs', () => {
    const session = {
      id: 'ses_1',
      directory: '/repo/app',
      title: 'Session',
      time: { created: 1, updated: 2 },
      summary: { custom: 'kept', diffs: [{ patch: '@@ -1 +1 @@' }] },
    } as unknown as Session

    const next = stripSessionListDetails(session) as Session & {
      summary?: { custom?: string; diffs?: unknown[] }
    }

    expect(next.summary).toEqual({ custom: 'kept' })
  })

  test('preserves object identity for already lightweight records with revert markers', () => {
    const session = {
      id: 'ses_1',
      directory: '/repo/app',
      title: 'Session',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'msg_2', partID: 'part_3' },
      summary: { additions: 2, deletions: 1, files: 1 },
    } as unknown as Session

    expect(stripSessionListDetails(session)).toBe(session)
  })
})
