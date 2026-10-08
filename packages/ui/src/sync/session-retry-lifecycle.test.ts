import { beforeEach, expect, it, vi } from 'vitest'
import { normalizeOpenCodeEvent, toLegacyEventShape } from './opencode-event-normalizer'
import { applyDirectoryEvent } from './event-reducer'
import { applyGlobalSessionStatusEvent, useGlobalSessionStatusStore } from './global-session-status'
import { INITIAL_STATE, type Event } from './types'

beforeEach(() => useGlobalSessionStatusStore.setState({ statusById: new Map() }))
const native = (type: string, sessionID: string, created: number, data: Record<string, unknown> = {}): Event => {
  const result = normalizeOpenCodeEvent({ type, created, data: { sessionID, ...data } })
  if (result.action !== 'emit') throw new Error('Invalid event')
  return toLegacyEventShape(result.event) as Event
}
it.each(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'])('clears retry on %s and rejects older waits in directory and global status', (terminal) => {
  const state = structuredClone(INITIAL_STATE)
  const idle = vi.fn()
  const id = `ses_${terminal}`
  const scheduled = native('session.retry.scheduled', id, 100, { attempt: 1, at: 3000, error: { message: 'limited' } })
  applyDirectoryEvent(state, scheduled, { now: () => 100, onServerSessionIdle: idle })
  applyGlobalSessionStatusEvent('/a', scheduled)
  expect(state.session_status[id]?.type).toBe('retry')
  expect(useGlobalSessionStatusStore.getState().statusById.get(id)?.status).toBe('retry')
  expect(idle).not.toHaveBeenCalled()
  const ended = native(terminal, id, 200, { reason: 'user' })
  applyDirectoryEvent(state, ended, { now: () => 200, onServerSessionIdle: idle })
  applyGlobalSessionStatusEvent('/a', ended)
  applyDirectoryEvent(state, scheduled)
  applyGlobalSessionStatusEvent('/a', scheduled)
  expect(state.session_status[id]?.type).toBe('idle')
  expect(useGlobalSessionStatusStore.getState().statusById.has(id)).toBe(false)
  expect(idle).toHaveBeenCalledTimes(1)
})
it('shutdown clears the countdown but preserves execution and queue ownership', () => {
  const state = structuredClone(INITIAL_STATE); const idle = vi.fn()
  applyDirectoryEvent(state, native('session.retry.scheduled', 'ses_shutdown', 100, { attempt: 3, at: 9000, error: { message: 'limited' } }))
  applyDirectoryEvent(state, native('session.execution.interrupted', 'ses_shutdown', 200, { reason: 'shutdown' }), { now: () => 200, onServerSessionIdle: idle })
  expect(state.session_status.ses_shutdown).toEqual({ type: 'busy' })
  expect(state.session_execution_recovery.ses_shutdown?.reason).toBe('shutdown')
  expect(idle).not.toHaveBeenCalled()
})
it('uses durable sequence for equal-clock terminal/retry races and duplicate frames', () => {
  const state = structuredClone(INITIAL_STATE); const idle = vi.fn()
  const receive = (type: string, seq: number, data: Record<string, unknown> = {}) => {
    const result = normalizeOpenCodeEvent({ type, created: 100, durable: { aggregateID: 'ses_seq', seq, version: 1 }, data: { sessionID: 'ses_seq', ...data } })
    if (result.action !== 'emit') throw new Error('Invalid event')
    const event = toLegacyEventShape(result.event) as Event
    applyDirectoryEvent(state, event, { onServerSessionIdle: idle })
    applyGlobalSessionStatusEvent('/a', event)
  }
  receive('session.execution.succeeded', 3)
  receive('session.retry.scheduled', 2, { attempt: 1, at: 1000, error: { message: 'late' } })
  receive('session.execution.succeeded', 3)
  expect(state.session_status.ses_seq?.type).toBe('idle')
  expect(useGlobalSessionStatusStore.getState().statusById.has('ses_seq')).toBe(false)
  expect(idle).toHaveBeenCalledTimes(1)
})
it('direct and wrapped relay frames preserve identical authority, without inventing malformed waits', () => {
  const frame = { type: 'session.retry.scheduled', created: 100, data: { sessionID: 'ses_a', assistantMessageID: 'msg_a', attempt: 1, at: 3000, error: { message: 'rate' } } }
  const direct = normalizeOpenCodeEvent(frame)
  const relay = normalizeOpenCodeEvent({ directory: '/a', payload: frame })
  expect(direct.action === 'emit' && direct.event.properties).toEqual(relay.action === 'emit' && relay.event.properties)
  expect(normalizeOpenCodeEvent({ ...frame, data: { sessionID: 'ses_a' } }).action).toBe('drop')
})
