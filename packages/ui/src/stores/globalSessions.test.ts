import { describe, expect, test } from 'bun:test'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

import { isVisibleGlobalSession, listGlobalSessionPages } from './globalSessions'

describe('listGlobalSessionPages', () => {
  test('retries resolved transient SDK errors before returning data', async () => {
    let attempts = 0
    const apiClient = {
      experimental: {
        session: {
          list: async () => {
            attempts += 1
            if (attempts < 3) {
              return {
                data: undefined,
                error: { message: 'warming up' },
                response: new Response(null, { status: 503 }),
              }
            }
            return {
              data: [{ id: 'ses_ready', directory: '/repo/app', time: { created: 1, updated: 2 } }],
              error: undefined,
              response: new Response(null, { status: 200 }),
            }
          },
        },
      },
    } as unknown as OpencodeClient

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
    const calls: Array<{ limit?: number; cursor?: number }> = []
    const apiClient = {
      experimental: {
        session: {
          list: async (input: { limit?: number; cursor?: number }) => {
            calls.push(input)
            return {
              data: Array.from({ length: input.limit ?? 0 }, (_, index) => ({
                id: `ses_${index}`,
                directory: '/repo/app',
                title: `Session ${index}`,
                time: { created: index, updated: 100 - index },
              })),
              response: { headers: new Headers({ 'x-next-cursor': '80' }) },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo/app',
      archived: false,
      pageSize: 500,
      maxItems: 20,
    })

    expect(sessions).toHaveLength(20)
    expect(calls).toEqual([{ directory: '/repo/app', archived: false, limit: 20 }])
  })

  test('sanitizes session list records before returning them', async () => {
    const apiClient = {
      experimental: {
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
            response: { headers: new Headers() },
          }),
        },
      },
    } as unknown as OpencodeClient

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
      title: 'Title refresh helper',
      metadata: { openchamber: { smallModel: { purpose: 'session-title' } } },
    } as never)).toBe(false)
    expect(isVisibleGlobalSession({
      title: '[Assistant] Looks system',
      metadata: { openchamber: { assistant: { name: 'no-id' } } },
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({
      title: 'Looks like small model',
      metadata: { openchamber: { smallModel: { purpose: '' } } },
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({
      title: 'Ordinary chat',
      metadata: { openchamber: { kind: 'review' } },
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({ title: 'smartfetch-secondary' } as never)).toBe(false)
    expect(isVisibleGlobalSession({
      title: 'Login',
      metadata: { openchamber: { assigned: { from: 'contact', assistantID: 'assistant_1' } } },
    } as never)).toBe(true)
    expect(isVisibleGlobalSession({
      title: 'Login',
      metadata: {
        openchamber: {
          assistant: { assistantID: 'assistant_1', name: 'Ops' },
          assigned: { from: 'contact' },
        },
      },
    } as never)).toBe(true)
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
    const calls: Array<{ cursor?: number }> = []
    const apiClient = {
      experimental: {
        session: {
          list: async (options: { cursor?: number }) => {
            calls.push(options)
            if (options.cursor === undefined) {
              return {
                data: [
                  { id: 'ses_temporary_1', title: 'smartfetch-secondary', time: { created: 1, updated: 2 } },
                  { id: 'ses_temporary_2', title: 'smartfetch-secondary', time: { created: 2, updated: 1 } },
                ],
                response: { headers: new Headers({ 'x-next-cursor': '1' }) },
              }
            }
            return {
              data: [{ id: 'ses_visible', title: 'Visible session', time: { created: 3, updated: 0 } }],
              response: { headers: new Headers() },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, { archived: false, pageSize: 2 })

    expect(sessions.map((session) => session.id)).toEqual(['ses_visible'])
    expect(calls).toHaveLength(2)
  })

  test('paginates through all session-list pages', async () => {
    const calls: Array<Record<string, unknown>> = []
    const apiClient = {
      experimental: {
        session: {
          list: async (options: Record<string, unknown>) => {
            calls.push(options)
            if (options.cursor === undefined) {
              return {
                data: [
                  { id: 'ses_root', time: { updated: 20 } },
                  { id: 'ses_child_1', time: { updated: 10 } },
                ],
                response: { headers: new Headers({ 'x-next-cursor': '10' }) },
              }
            }
            return {
              data: [
                { id: 'ses_child_2', time: { updated: 5 } },
              ],
              response: { headers: new Headers() },
            }
          },
        },
      },
    } as unknown as OpencodeClient

    const sessions = await listGlobalSessionPages(apiClient, {
      directory: '/repo',
      archived: false,
      roots: false,
      pageSize: 2,
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ directory: '/repo', archived: false, roots: false, limit: 2 })
    expect(calls[1]).toEqual({ directory: '/repo', archived: false, roots: false, limit: 2, cursor: 10 })
    expect(sessions.map((session) => session.id)).toEqual(['ses_root', 'ses_child_1', 'ses_child_2'])
  })
})
