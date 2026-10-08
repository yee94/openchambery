import type { Session } from '@/lib/opencode/v2-types'

const getSessionRecencyTimestamp = (session: Session): number => {
  const updatedAt = session.time?.updated
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) {
    return updatedAt
  }
  const createdAt = session.time?.created
  return typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0
}

export const shouldSkipStaleSessionEvent = (currentSession: Session | null, incomingSession: Session): boolean => {
  if (!currentSession) return false
  return getSessionRecencyTimestamp(incomingSession) < getSessionRecencyTimestamp(currentSession)
}

export const applySessionRename = (session: Session, properties: Record<string, unknown>): Session => {
  if (properties.sessionID !== session.id || typeof properties.title !== 'string') return session
  const updated = typeof properties.eventCreated === 'number' && Number.isFinite(properties.eventCreated)
    ? properties.eventCreated : getSessionRecencyTimestamp(session)
  if (updated < getSessionRecencyTimestamp(session)) return session
  if (session.title === properties.title && updated === getSessionRecencyTimestamp(session)) return session
  return { ...session, title: properties.title, time: { ...session.time, updated } }
}
