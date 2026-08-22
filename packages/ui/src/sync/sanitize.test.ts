import { describe, expect, test } from 'bun:test'
import type { Message, Session } from '@opencode-ai/sdk/v2'

import {
  projectSummaryDiffMarkers,
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

describe('projectSummaryDiffMarkers', () => {
  test('replaces diffs array with diffCount/hasDiffs', () => {
    const owner = {
      summary: {
        title: 'turn',
        diffs: [{ file: 'a.ts', patch: '@@' }, { file: 'b.ts' }],
      },
    }
    const next = projectSummaryDiffMarkers(owner)
    expect(next).toEqual({
      summary: {
        title: 'turn',
        diffCount: 2,
        hasDiffs: true,
      },
    })
    expect((next.summary as { diffs?: unknown }).diffs).toBeUndefined()
  })

  test('projects empty diffs to zero markers', () => {
    const owner = { summary: { diffs: [] } }
    expect(projectSummaryDiffMarkers(owner)).toEqual({
      summary: { diffCount: 0, hasDiffs: false },
    })
  })

  test('keeps identity when diffs key is absent', () => {
    const owner = { summary: { title: 'x', diffCount: 3, hasDiffs: true } }
    expect(projectSummaryDiffMarkers(owner)).toBe(owner)
  })
})

describe('stripSessionDiffSnapshots', () => {
  test('removes oversized revert payloads and L1-projects summary diffs', () => {
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
      summary?: { diffs?: unknown; diffCount?: number; hasDiffs?: boolean; additions?: number }
    }

    expect(next).not.toBe(session)
    expect(next.revert).toEqual({ messageID: 'msg_2', partID: 'part_3' })
    expect(next.summary?.diffs).toBeUndefined()
    expect(next.summary?.diffCount).toBe(1)
    expect(next.summary?.hasDiffs).toBe(true)
    expect(next.summary?.additions).toBe(2)
  })

  test('preserves object identity when diffs key is absent', () => {
    const session = {
      id: 'ses_1',
      slug: 'session-one',
      projectID: 'proj_1',
      directory: '/repo/app',
      title: 'Session',
      version: '1.0.0',
      time: { created: 1, updated: 2 },
      revert: { messageID: 'msg_2', partID: 'part_3' },
      summary: { additions: 2, deletions: 1, diffCount: 1, hasDiffs: true },
    } as unknown as Session

    expect(stripSessionDiffSnapshots(session)).toBe(session)
  })
})

describe('stripMessageDiffSnapshots', () => {
  test('projects message summary diffs to diffCount/hasDiffs', () => {
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
        diffs?: unknown
        diffCount?: number
        hasDiffs?: boolean
        additions?: number
      }
    }

    expect(next).not.toBe(message)
    expect(next.summary?.diffs).toBeUndefined()
    expect(next.summary?.diffCount).toBe(1)
    expect(next.summary?.hasDiffs).toBe(true)
    expect(next.summary?.additions).toBe(4)
  })

  test('preserves message identity when diffs key is absent', () => {
    const message = {
      id: 'msg_1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1 },
      summary: {
        diffCount: 1,
        hasDiffs: true,
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
