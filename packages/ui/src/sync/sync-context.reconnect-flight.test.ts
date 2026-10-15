import { expect, test, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { createStore } from 'zustand/vanilla'
import { INITIAL_STATE } from './types'
import type { DirectoryStore } from './child-store'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'
import { bindTranscriptRepositoryInstance, unbindTranscriptRepository } from './transcript-repository-runtime'
import { normalizeSessionProjectionPage } from './session-projection-api'

const fixture = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
  return { legacyFetch: vi.fn() }
})
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: {
  setDirectory: vi.fn(),
  getDirectory: () => '/repo',
  getFilesystemHome: async () => '/repo',
  getScopedSdkClient: () => ({ session: { get: async () => null } }),
} }))
vi.mock('./session-status-reconciliation', () => ({
  resyncDirectorySessionStatuses: vi.fn(async () => ({})),
  reconcileActiveSessionStatusAfterMessagePull: vi.fn(),
}))
vi.mock('./session-inbox-query', () => ({ refreshSessionInbox: vi.fn(async () => undefined) }))
vi.mock('./transcript-repository-production', async (original) => ({
  ...await original<typeof import('./transcript-repository-production')>(),
  fetchProductionTranscriptTransportPage: fixture.legacyFetch,
}))
import { resyncDirectoryAfterReconnect, setActiveSession } from './sync-context'

test('directory recovery shares the compensation read instead of overwriting it with an independent old page', async () => {
  const scope = { directory: '/repo', sessionID: 'ses_a' }
  const page = (text: string) => normalizeSessionProjectionPage({ data: [
    { id: 'msg_a', type: 'assistant', time: { created: 1 }, content: [{ type: 'text', text }] },
  ] }, scope.sessionID)
  fixture.legacyFetch.mockResolvedValue(page('old partial response'))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn(async () => { await gate; return page('complete final answer') })
  const client = new QueryClient()
  const repo = createQueryTranscriptRepository({ client, fetcher })
  const refresh = vi.spyOn(repo, 'refreshFromAuthority')
  bindTranscriptRepositoryInstance(repo)
  repo.apply(scope, { type: 'http-page', purpose: 'initial', page: page('partial') })
  const store = createStore<DirectoryStore>(set => ({ ...INITIAL_STATE,
    patch: partial => set(partial), replace: next => set(next),
  }))
  const routing = { sessionDirectoryById: new Map(), messageSessionById: new Map(), sessionMessageIdsById: new Map() }
  setActiveSession(scope.directory, scope.sessionID)
  try {
    const compensation = repo.refreshFromAuthority(scope)
    const recovery = resyncDirectoryAfterReconnect(scope.directory, store, routing, 'stream-reconnect', () => 0)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
    release()
    await Promise.all([compensation, recovery])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fixture.legacyFetch).not.toHaveBeenCalled()
    expect(repo.getParts(scope, 'msg_a')).toEqual(page('complete final answer').records[0].parts)
  } finally {
    release()
    setActiveSession('', '')
    unbindTranscriptRepository(); repo.destroy(); client.clear()
  }
})
