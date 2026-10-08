import { beforeEach, expect, it, vi } from 'vitest'
import type { Session } from '@/lib/opencode/v2-types'
const fixture = vi.hoisted(() => ({ generation: 0, current: 'ses_a', directory: '/old', upsert: vi.fn(), reset: vi.fn(), register: vi.fn() }))
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => fixture.generation, getRuntimeTransportIdentity: () => 'runtime' }))
vi.mock('./session-ui-store', () => ({ useSessionUIStore: { getState: () => ({ setSessionDirectory: (id: string, directory: string) => { if (id === fixture.current) fixture.directory = directory } }) } }))
vi.mock('@/stores/useGlobalSessionsStore', () => ({ useGlobalSessionsStore: { getState: () => ({ upsertSession: fixture.upsert }) } }))
vi.mock('./sync-refs', () => ({ registerSessionDirectory: fixture.register }))
vi.mock('./transcript-repository-runtime', () => ({ getTranscriptRepository: () => ({ apply: fixture.reset }), transcriptScope: (directory: string, sessionID: string) => ({ directory, sessionID }) }))
import { ChildStoreManager } from './child-store'
import { acceptSessionMove, movedSessionDirectory, reconcileMovedSessionDirectory } from './session-location-authority'
import { adoptSessionMove } from './session-move'
beforeEach(() => { fixture.generation++; fixture.current = 'ses_a'; fixture.directory = '/old'; vi.clearAllMocks() })
const session = (directory: string, id = 'ses_a') => ({ id, directory, title: 'title', time: { created: 1, updated: 1 } }) as Session
it('moves active identity and live request/status domains, fences late old catalog writes', () => {
  const stores = new ChildStoreManager()
  const source = stores.ensureChild('/old', { bootstrap: false })
  const original = session('/old')
  source.setState({ session: [original], session_status: { ses_a: { type: 'retry', attempt: 2, next: 3000, message: 'rate' } } })
  expect(acceptSessionMove('ses_a', '/new', 10)).toBe(true)
  adoptSessionMove(session('/new'), stores)
  expect(source.getState().session).toEqual([])
  expect(source.getState().session_status.ses_a).toBeUndefined()
  expect(stores.getChild('/new')!.getState().session_status.ses_a?.type).toBe('retry')
  expect(fixture.directory).toBe('/new')
  expect(fixture.reset).toHaveBeenCalledWith({ directory: '/old', sessionID: 'ses_a' }, { type: 'reset' })
  source.setState({ session: [original] })
  expect(source.getState().session).toEqual([])
  source.getState().patch({ session: [original] })
  expect(source.getState().session).toEqual([])
  expect(acceptSessionMove('ses_a', '/new', 10)).toBe(false)
  expect(acceptSessionMove('ses_a', '/old', 9)).toBe(false)
  expect(reconcileMovedSessionDirectory('ses_a', '/old', 9)).toBe('/new')
  expect(reconcileMovedSessionDirectory('ses_a', '/reconnected', 11)).toBe('/reconnected')
})
it('adopts a background session with no surviving source directory without switching selection, and isolates runtime', () => {
  const stores = new ChildStoreManager()
  acceptSessionMove('ses_b', '/new', 10)
  adoptSessionMove(session('/new', 'ses_b'), stores)
  expect(stores.getChild('/new')!.getState().session.map((s) => s.id)).toEqual(['ses_b'])
  expect(fixture.directory).toBe('/old')
  fixture.generation++
  expect(movedSessionDirectory('ses_b')).toBeUndefined()
  expect(acceptSessionMove('ses_b', '/old', 1)).toBe(true)
})
