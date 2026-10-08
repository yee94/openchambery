import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch'
import { normalizeDirectoryKey } from '@/lib/pathNormalization'
import type { State } from './types'

export const SESSION_LOCATION_DOMAINS = ['session_status', 'session_status_observed_at', 'session_status_event_at', 'session_status_event_sequence', 'session_interrupt_acknowledged_at',
  'session_execution_version', 'session_error_at', 'session_execution_recovery', 'session_diff', 'todo', 'permission', 'question'] as const

export function filterMovedSessionState(directory: string, previous: State, next: Partial<State>): Partial<State> {
  if (!current().size) return next
  let result = next
  if (next.session && next.session !== previous.session && next.session.some((session) => !sessionBelongsToDirectory(session.id, directory))) {
    result = { ...result, session: next.session.filter((session) => sessionBelongsToDirectory(session.id, directory)) }
  }
  for (const key of SESSION_LOCATION_DOMAINS) {
    const value = next[key]
    if (!value || value === previous[key]) continue
    const stale = Object.keys(value).filter((id) => !sessionBelongsToDirectory(id, directory))
    if (!stale.length) continue
    const clean = { ...value }
    for (const id of stale) delete clean[id]
    result = { ...result, [key]: clean }
  }
  return result
}

// Only move authority is retained; ordinary catalog reads never establish a fence.
let runtime = ''
const locations = new Map<string, { directory: string; clock: number; sequence?: number }>()
function current() {
  const key = `${getRuntimeTransportIdentity()}:${getRuntimeGeneration()}`
  if (runtime !== key) { runtime = key; locations.clear() }
  return locations
}
export function movedSessionDirectory(sessionID: string): string | undefined {
  return current().get(sessionID)?.directory
}
export function reconcileMovedSessionDirectory(sessionID: string, directory: string | undefined, updatedAt: number | undefined): string | undefined {
  const previous = current().get(sessionID)
  if (previous && directory && typeof updatedAt === 'number' && updatedAt > previous.clock
    && normalizeDirectoryKey(directory) !== previous.directory) {
    acceptSessionMove(sessionID, directory, updatedAt)
  }
  return movedSessionDirectory(sessionID)
}
export function acceptSessionMove(sessionID: string, directory: string, clock: number, sequence?: number): boolean {
  const entries = current()
  const previous = entries.get(sessionID)
  directory = normalizeDirectoryKey(directory)
  if (previous && (sequence !== undefined && previous.sequence !== undefined
    ? sequence <= previous.sequence
    : clock < previous.clock || (clock === previous.clock && directory === previous.directory))) return false
  entries.set(sessionID, { directory, clock, sequence })
  return true
}
export function sessionBelongsToDirectory(sessionID: string, directory: string): boolean {
  const owner = movedSessionDirectory(sessionID)
  return !owner || owner === normalizeDirectoryKey(directory)
}
