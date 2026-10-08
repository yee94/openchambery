import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkingPlaceholder } from './WorkingPlaceholder'
import { normalizeOpenCodeEvent, toLegacyEventShape } from '@/sync/opencode-event-normalizer'
import { applyDirectoryEvent } from '@/sync/event-reducer'
import { INITIAL_STATE, type Event } from '@/sync/types'
import { I18nProvider } from '@/lib/i18n'
vi.mock('./MorphOrb', () => ({ MorphOrb: () => null }))
afterEach(() => vi.useRealTimers())
it('maps native retry authority, paints reason/attempt/countdown and clears on settlement without releasing early', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000)
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); const root = createRoot(host)
  const state = structuredClone(INITIAL_STATE)
  const idle = vi.fn()
  const receive = (type: string, created: number, data: Record<string, unknown> = {}) => {
    const normalized = normalizeOpenCodeEvent({ type, created, data: { sessionID: 'ses_a', ...data } })
    if (normalized.action !== 'emit') throw new Error('missing normalized event')
    applyDirectoryEvent(state, toLegacyEventShape(normalized.event) as Event, { now: Date.now, onServerSessionIdle: idle })
  }
  const render = async () => {
    const status = state.session_status.ses_a
    await act(async () => root.render(<I18nProvider><WorkingPlaceholder isWorking={status?.type !== 'idle'} isMobile={false} statusText={null} retryInfo={status?.type === 'retry' ? status : null} /></I18nProvider>))
  }
  receive('session.retry.scheduled', 1000, { attempt: 1, at: 4000, error: { type: 'provider.rate-limit', message: 'slow down' } })
  await render()
  expect(host.textContent).toContain('slow down'); expect(host.textContent).toContain('1'); expect(host.textContent).toContain('3')
  await act(async () => vi.advanceTimersByTime(1000))
  expect(host.textContent).toContain('2')
  receive('session.retry.scheduled', 2000, { attempt: 2, at: 7000, error: { message: 'again' } })
  await render(); expect(host.textContent).toContain('again'); expect(host.textContent).toContain('5')
  expect(idle).not.toHaveBeenCalled()
  receive('session.execution.succeeded', 3000); await render()
  expect(host.textContent).not.toContain('again'); expect(idle).toHaveBeenCalledTimes(1)
  receive('session.retry.scheduled', 2000, { attempt: 2, at: 7000, error: { message: 'late' } })
  expect(state.session_status.ses_a?.type).toBe('idle')
  await act(async () => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
})
