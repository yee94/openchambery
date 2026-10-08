import type { Session } from '@/lib/opencode/v2-types'
import type { ChildStoreManager } from './child-store'
import type { State } from './types'
import { useSessionUIStore } from './session-ui-store'
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore'
import { registerSessionDirectory } from './sync-refs'
import { getTranscriptRepository, transcriptScope } from './transcript-repository-runtime'
import { SESSION_LOCATION_DOMAINS as domains } from './session-location-authority'

function transfer<K extends typeof domains[number]>(key: K, id: string, source: State, target: State) {
  const value = source[key][id]
  if (value === undefined) return
  target[key] = { ...target[key], [id]: value }
  source[key] = { ...source[key] }
  delete source[key][id]
}

/** Adopt server identity; session-keyed composer drafts deliberately keep their owner. */
export function adoptSessionMove(session: Session, stores: ChildStoreManager): void {
  const directory = session.directory
  if (!directory) return
  const destination = stores.ensureChild(directory, { bootstrap: false })
  const next: State = { ...destination.getState() }
  for (const [sourceDirectory, store] of stores.children) {
    if (store === destination) continue
    const source: State = { ...store.getState() }
    const owned = source.session.some((item) => item.id === session.id)
      || domains.some((key) => source[key][session.id] !== undefined)
    if (!owned) continue
    source.session = source.session.filter((item) => item.id !== session.id)
    for (const key of domains) transfer(key, session.id, source, next)
    store.setState(source)
    getTranscriptRepository()?.apply(transcriptScope(sourceDirectory, session.id), { type: 'reset' })
  }
  next.session = [...next.session.filter((item) => item.id !== session.id), session].sort((a, b) => a.id.localeCompare(b.id))
  destination.setState(next)
  registerSessionDirectory(session.id, directory)
  useGlobalSessionsStore.getState().upsertSession(session)
  useSessionUIStore.getState().setSessionDirectory(session.id, directory)
}
