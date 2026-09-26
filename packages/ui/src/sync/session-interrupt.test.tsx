import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createStore, useStore } from 'zustand'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DirectoryStore } from './child-store'
import { INITIAL_STATE, type Event } from './types'
import { applyDirectoryEvent } from './event-reducer'
import { dropSessionCaches } from './session-cache'
import { runSessionInterrupt, sessionDisplayStatus, sessionDisplayStatusObservedAt } from './session-interrupt'

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const store = createStore<DirectoryStore>((set) => ({
    ...structuredClone(INITIAL_STATE),
    session_status: { a: { type: 'busy' }, b: { type: 'busy' } },
    patch: (next) => set(next), replace: (next) => set(next),
  }))
  const idle = vi.fn()
  const event = (type: string, sessionID = 'a', extra = {}) => {
    const state = store.getState()
    const draft = { ...state, session_status: { ...state.session_status }, session_status_observed_at: { ...state.session_status_observed_at } }
    applyDirectoryEvent(draft, { type, properties: { sessionID, ...extra } } as Event, { now: () => Date.now(), onServerSessionIdle: idle })
    store.setState(draft)
  }
  const gate = deferred()
  let current = true
  let signal: AbortSignal | undefined
  const stop = () => runSessionInterrupt({ store, sessionID: 'a', isCurrent: () => current, request: (s) => { signal = s; return gate.promise } })
  return { store, idle, event, gate, stop, switchRuntime: () => { current = false }, signal: () => signal }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000) })
afterEach(() => vi.useRealTimers())

describe('interrupt acknowledgement and settlement', () => {
  test('ack releases display without opening the authoritative execution gate', async () => {
    const f = fixture()
    const stop = f.stop()
    f.gate.resolve()
    await expect(stop).resolves.toBe('accepted')
    expect(sessionDisplayStatus(f.store.getState(), 'a')).toEqual({ type: 'idle' })
    expect(sessionDisplayStatusObservedAt(f.store.getState(), 'a')).toBe(1000)
    expect(f.store.getState().session_status.a).toEqual({ type: 'busy' })
    expect(f.idle).not.toHaveBeenCalled()
    f.event('session.execution.interrupted', 'a', { reason: 'user' })
    expect(f.store.getState().session_status.a).toEqual({ type: 'idle' })
    expect(f.store.getState().session_interrupt_acknowledged_at.a).toBeUndefined()
    expect(f.idle).toHaveBeenCalledWith('a')
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['resolve', 'reject'] as const)('terminal event releases a hanging reply; late %s cannot overwrite the next turn', async (completion) => {
    const f = fixture()
    const stop = f.stop()
    f.event('session.execution.interrupted', 'a', { reason: 'user' })
    await expect(stop).resolves.toBe('settled')
    expect(f.signal()?.aborted).toBe(true)
    f.event('session.execution.started')
    if (completion === 'resolve') f.gate.resolve()
    else f.gate.reject(new Error('late relay failure'))
    await Promise.resolve()
    expect(sessionDisplayStatus(f.store.getState(), 'a')).toEqual({ type: 'busy' })
    expect(f.store.getState().session_interrupt_acknowledged_at.a).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('a new execution supersedes the stop even when status and clock are unchanged', async () => {
    const f = fixture()
    const stop = f.stop()
    f.event('session.execution.started')
    await expect(stop).resolves.toBe('superseded')
    f.gate.resolve()
    await Promise.resolve()
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('busy')
  })

  test('a switched runtime cannot receive an old receipt', async () => {
    const f = fixture()
    const stop = f.stop()
    f.switchRuntime()
    f.gate.resolve()
    await expect(stop).resolves.toBe('superseded')
    expect(f.store.getState().session_interrupt_acknowledged_at).toEqual({})
  })

  test('a newer authoritative reconnect snapshot supersedes the receipt', async () => {
    const f = fixture()
    const stop = f.stop()
    f.gate.resolve()
    await stop
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('idle')
    f.store.setState({ session_status_snapshot_at: 1001 })
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('busy')
  })

  test('timeout cancels transport, preserves busy, permits retry and ignores the old reply', async () => {
    const f = fixture()
    const stop = f.stop()
    await vi.advanceTimersByTimeAsync(5000)
    await expect(stop).resolves.toBe('unconfirmed')
    expect(f.signal()?.aborted).toBe(true)
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('busy')
    const retryGate = deferred()
    const retry = runSessionInterrupt({ store: f.store, sessionID: 'a', isCurrent: () => true, request: () => retryGate.promise })
    f.gate.resolve()
    await Promise.resolve()
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('busy')
    retryGate.resolve()
    await expect(retry).resolves.toBe('accepted')
  })

  test('rejection never invents idle and cleans its observer and timer', async () => {
    const f = fixture()
    const stop = f.stop()
    const assertion = expect(stop).rejects.toThrow('denied')
    f.gate.reject(new Error('denied'))
    await assertion
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('busy')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('other sessions do not settle a stop, and shutdown supersedes rather than confirms it', async () => {
    const f = fixture()
    const stop = f.stop()
    let settled = false
    void stop.then(() => { settled = true })
    f.event('session.execution.succeeded', 'b')
    await Promise.resolve()
    expect(settled).toBe(false)
    f.event('session.execution.interrupted', 'a', { reason: 'shutdown' })
    await expect(stop).resolves.toBe('superseded')
    f.gate.resolve()
    await Promise.resolve()
    expect(sessionDisplayStatus(f.store.getState(), 'a')?.type).toBe('busy')
  })

  test('new starts and deletion retire acknowledgement without touching other sessions', async () => {
    const f = fixture()
    f.store.setState({ session_interrupt_acknowledged_at: { a: 1000, b: 999 } })
    f.event('session.execution.started')
    expect(f.store.getState().session_interrupt_acknowledged_at).toEqual({ b: 999 })
    const state = { ...f.store.getState(), session_interrupt_acknowledged_at: { a: 1000, b: 999 }, session_execution_version: { a: 1, b: 2 } }
    dropSessionCaches(state, ['a'])
    expect(state.session_interrupt_acknowledged_at).toEqual({ b: 999 })
    expect(state.session_execution_version).toEqual({ b: 2 })
  })

  test('mounted display changes on ack and restart, not unrelated stream updates', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const f = fixture()
    const host = document.createElement('div')
    const root = createRoot(host)
    const render = vi.fn()
    function Display() {
      const status = useStore(f.store, (state) => sessionDisplayStatus(state, 'a'))
      render()
      return <span>{status?.type}</span>
    }
    try {
      await act(async () => root.render(<Display />))
      await act(async () => { const stop = f.stop(); f.gate.resolve(); await stop })
      expect(host.textContent).toBe('idle')
      render.mockClear()
      await act(async () => { for (let i = 0; i < 100; i++) f.event('session.execution.started', 'b') })
      expect(render).not.toHaveBeenCalled()
      await act(async () => f.event('session.execution.started'))
      expect(host.textContent).toBe('busy')
    } finally { await act(async () => root.unmount()) }
  })
})
