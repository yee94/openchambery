import { afterEach, expect, test, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient } from '@tanstack/react-query'
import { createStore } from 'zustand/vanilla'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'
import { bindTranscriptRepositoryInstance, unbindTranscriptRepository } from './transcript-repository-runtime'
import { normalizeSessionProjectionPage } from './session-projection-api'
import { INITIAL_STATE } from './types'

function makeStore(type: 'busy' | 'retry') {
  return createStore(() => ({ ...INITIAL_STATE, session_status: { ses_a: { type } } }))
}
const fixture = vi.hoisted(() => ({ store: null as ReturnType<typeof makeStore> | null }))
vi.mock('./sync-context', () => ({
  useDirectoryStore: () => fixture.store,
  useSyncDirectory: () => '/repo',
  useChildStoreManager: () => ({ ensureChild: () => fixture.store }),
  dropCachedSessionMessageRecordsSnapshots: vi.fn(),
}))
vi.mock('./session-status-reconciliation', () => ({ reconcileActiveSessionStatusAfterMessagePull: vi.fn() }))
import { useSync } from './use-sync'
import { reconcileActiveSessionStatusAfterMessagePull } from './session-status-reconciliation'

afterEach(() => { unbindTranscriptRepository(); vi.clearAllMocks() })

test.each(['busy', 'retry'] as const)('manual refresh repairs a partial transcript despite stale %s status', async (type) => {
  fixture.store = makeStore(type)
  const client = new QueryClient()
  const scope = { directory: '/repo', sessionID: 'ses_a' }
  const page = (text: string) => normalizeSessionProjectionPage({ data: [
    { id: 'msg_a', type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text }] },
  ] }, scope.sessionID)
  const fetcher = vi.fn(async () => page('complete final answer'))
  const repo = createQueryTranscriptRepository({ client, fetcher })
  bindTranscriptRepositoryInstance(repo)
  repo.apply(scope, { type: 'http-page', purpose: 'initial', page: page('partial') })
  let sync!: ReturnType<typeof useSync>
  function Harness() { sync = useSync(); return null }
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Harness />))
    await act(async () => sync.refreshSessionTranscript(scope.sessionID))
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(repo.getParts(scope, 'msg_a')).toEqual(page('complete final answer').records[0].parts)
    expect(reconcileActiveSessionStatusAfterMessagePull).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: scope.sessionID, statusBeforePull: { type }, hasMessages: true,
    }))
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(sync.refreshSessionTranscript(scope.sessionID)).rejects.toThrow('refresh transcript failed')
    expect(repo.getParts(scope, 'msg_a')).toEqual(page('complete final answer').records[0].parts)
  } finally {
    await act(async () => root.unmount())
    repo.destroy(); client.clear()
  }
})
