import { describe, expect, test } from 'bun:test'
import type { OpenCodeClient } from '@/lib/opencode/v2-types'
import { isVisibleGlobalSession, listGlobalSessionPages } from './globalSessions'

describe('listGlobalSessionPages', () => {
  test('retries resolved transient SDK errors before returning data', async () => {
    let attempts = 0
    const apiClient = {
      session: {
        list: async () => {
          attempts += 1
          if (attempts < 3) {
            const error = new Error('warming up 503') as Error & { status?: number }
            error.status = 503
            throw error
          }
          return {
            data: [{ id: 'ses_ready', directory: '/repo/app', time: { created: 1, updated: 2 } }],
            cursor: {},
          }
        },
      },
    } as unknown as OpenCodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo/app',
      archived: false,
      pageSize: 20,
      maxItems: 20,
    })

    expect(attempts).toBe(3)
    expect(sessions.map((session) => session.id)).toEqual(['ses_ready'])
  })

  test('stops a directory-style load at the requested item limit', async () => {
    const calls: Array<Record<string, unknown>> = []
    const apiClient = {
      session: {
        list: async (input: { limit?: number; cursor?: string }) => {
          calls.push(input)
          return {
            data: Array.from({ length: input.limit ?? 0 }, (_, index) => ({
              id: `ses_${index}`,
              directory: '/repo/app',
              title: `Session ${index}`,
              time: { created: index, updated: 100 - index },
            })),
            cursor: { next: '80' },
          }
        },
      },
    } as unknown as OpenCodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo/app',
      archived: false,
      pageSize: 500,
      maxItems: 20,
    })

    expect(sessions).toHaveLength(20)
    expect(calls).toEqual([{ directory: '/repo/app', limit: 20 }])
  })

  test('sanitizes session list records before returning them', async () => {
    const apiClient = {
      session: {
        list: async () => ({
          data: [
            {
              id: 'ses_1',
              directory: '/repo/app',
              title: 'Alpha',
              time: { created: 1, updated: 2 },
              metadata: {
                openchamber: {
                  kind: 'review',
                  originalSessionID: 'ses_original',
                },
              },
              permission: [{ permission: 'todowrite' }],
              revert: { messageID: 'msg_1', snapshot: 'abc123', diff: 'diff --git a/x b/x' },
              summary: {
                additions: 5,
                deletions: 3,
                files: 2,
                diffs: [{ patch: '@@ -1 +1 @@', additions: 5, deletions: 3 }],
              },
            },
          ],
          cursor: {},
        }),
      },
    } as unknown as OpenCodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: false, pageSize: 500 })
    const session = sessions[0] as typeof sessions[number] & {
      metadata?: unknown
      permission?: unknown
      revert?: { messageID?: string; snapshot?: string; diff?: string }
      summary?: { additions?: number; deletions?: number; files?: number; diffs?: unknown[] }
    }

    expect(session.metadata).toEqual({
      openchamber: {
        kind: 'review',
        originalSessionID: 'ses_original',
      },
    })
    expect(session.permission).toBe(undefined)
    expect(session.revert).toEqual({ messageID: 'msg_1' })
    expect(session.summary).toEqual({ additions: 5, deletions: 3, files: 2 })
  })

  test('hides system sessions by metadata and keeps ordinary sessions visible', () => {
    expect(isVisibleGlobalSession({
      title: '[Assistant] Ops',
      metadata: { openchamber: { assistant: { assistantID: 'assistant_1', name: 'Ops' } } },
    } as never)).toBe(false)
    expect(isVisibleGlobalSession({
      title: 'Nightly build',
      metadata: { openchamber: { scheduledTask: { taskID: 'task_1' } } },
    } as never)).toBe(false)
    expect(isVisibleGlobalSession({
      title: '[Assistant] Looks system',
      metadata: { openchamber: { assistant: { name: 'no-id' } } },
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({
      title: 'Ordinary chat',
      metadata: { openchamber: { kind: 'review' } },
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({ title: 'smartfetch-secondary' } as never)).toBe(false)
  })

  test('hides subagent sessions with a parentID from the sidebar catalog', () => {
    expect(isVisibleGlobalSession({
      title: 'SA-1 事项总结梳理 (@explorer subagent)',
      parentID: 'ses_parent_scheduled',
    } as never)).toBe(false)
    expect(isVisibleGlobalSession({
      title: 'Ordinary chat',
      parentID: '',
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({
      title: 'Ordinary chat',
    } as never)).toBe(true)
  })

  test('excludes SmartFetch secondary sessions while continuing pagination', async () => {
    const calls: Array<{ cursor?: string }> = []
    const apiClient = {
      session: {
        list: async (options: { cursor?: string }) => {
          calls.push(options)
          if (options.cursor === undefined) {
            return {
              data: [
                { id: 'ses_temporary_1', title: 'smartfetch-secondary', time: { created: 1, updated: 2 } },
                { id: 'ses_temporary_2', title: 'smartfetch-secondary', time: { created: 2, updated: 1 } },
              ],
              cursor: { next: '1' },
            }
          }
          return {
            data: [{ id: 'ses_visible', title: 'Visible session', time: { created: 3, updated: 0 } }],
            cursor: {},
          }
        },
      },
    } as unknown as OpenCodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: false, pageSize: 2 })

    expect(sessions.map((session) => session.id)).toEqual(['ses_visible'])
    expect(calls).toHaveLength(2)
  })

  test('paginates through all session-list pages', async () => {
    const calls: Array<Record<string, unknown>> = []
    const apiClient = {
      session: {
        list: async (options: Record<string, unknown>) => {
          calls.push(options)
          if (options.cursor === undefined) {
            return {
              data: [
                { id: 'ses_root', time: { updated: 20 } },
                { id: 'ses_child_1', time: { updated: 10 } },
              ],
              cursor: { next: '10' },
            }
          }
          return {
            data: [
              { id: 'ses_child_2', time: { updated: 5 } },
            ],
            cursor: {},
          }
        },
      },
    } as unknown as OpenCodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo',
      archived: false,
      roots: false,
      pageSize: 2,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ directory: '/repo', limit: 2 })
    expect(calls[1]).toEqual({ directory: '/repo', limit: 2, cursor: '10' })
    expect(sessions.map((session) => session.id)).toEqual(['ses_root', 'ses_child_1', 'ses_child_2'])
  })

  test('keeps walking raw pages when a numeric cursor filters the first page empty', async () => {
    const calls: Array<Record<string, unknown>> = []
    const apiClient = {
      session: {
        list: async (options: Record<string, unknown>) => {
          calls.push(options)
          if (options.cursor === undefined) {
            return {
              data: [
                { id: 'ses_new', time: { updated: 90 } },
                { id: 'ses_newer', time: { updated: 81 } },
              ],
              cursor: { next: 'page-2' },
            }
          }
          return {
            data: [
              { id: 'ses_old', time: { updated: 60 } },
            ],
            cursor: {},
          }
        },
      },
    } as unknown as OpenCodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo',
      archived: false,
      pageSize: 2,
      maxItems: 2,
      cursor: 81,
    })

    expect(calls).toHaveLength(2)
    expect(sessions.map((session) => session.id)).toEqual(['ses_old'])
  })
})
