import type { StoreApi } from "zustand"
import type { DirectoryStore } from "./child-store"
import type { State, SessionStatus } from "./types"

const IDLE: SessionStatus = { type: "idle" }

function acknowledgementAt(state: State, sessionID: string): number | undefined {
  const acknowledged = state.session_interrupt_acknowledged_at?.[sessionID]
  const authority = Math.max(state.session_status_observed_at[sessionID] ?? 0, state.session_status_snapshot_at ?? 0)
  return acknowledged !== undefined && acknowledged >= authority ? acknowledged : undefined
}

/** An acknowledgement releases interaction, not the authoritative execution gate. */
export function sessionDisplayStatus(state: State, sessionID: string): SessionStatus | undefined {
  return acknowledgementAt(state, sessionID) !== undefined
    ? IDLE
    : state.session_status[sessionID]
}

export function sessionDisplayStatusObservedAt(state: State, sessionID: string): number | undefined {
  return acknowledgementAt(state, sessionID) ?? state.session_status_observed_at[sessionID]
}

export function clearSessionInterruptAcknowledgement(state: State, sessionID: string): boolean {
  if (state.session_interrupt_acknowledged_at?.[sessionID] === undefined) return false
  state.session_interrupt_acknowledged_at = { ...state.session_interrupt_acknowledged_at }
  delete state.session_interrupt_acknowledged_at[sessionID]
  return true
}

export function runSessionInterrupt(input: {
  store: StoreApi<DirectoryStore>
  sessionID: string
  isCurrent: () => boolean
  request: (signal: AbortSignal) => Promise<void>
}): Promise<"accepted" | "settled" | "superseded" | "unconfirmed"> {
  const { store, sessionID, isCurrent, request } = input
  const initial = store.getState()
  const version = initial.session_execution_version?.[sessionID] ?? 0
  const hadStatus = initial.session_status[sessionID] !== undefined
  const recovery = initial.session_execution_recovery?.[sessionID]
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let finished = false
    let unsubscribe = () => {}
    const current = () => {
      const state = store.getState()
      return isCurrent()
        && (state.session_execution_version?.[sessionID] ?? 0) === version
        && (!hadStatus || state.session_status[sessionID] !== undefined)
        && state.session_execution_recovery?.[sessionID] === recovery
    }
    const finish = (result: "accepted" | "settled" | "superseded" | "unconfirmed", error?: unknown) => {
      if (finished) return
      finished = true
      unsubscribe()
      clearTimeout(timeout)
      controller.abort()
      if (result === "accepted") {
        store.setState((state) => ({ session_interrupt_acknowledged_at: {
          ...state.session_interrupt_acknowledged_at, [sessionID]: Date.now(),
        } }))
      }
      if (error !== undefined) reject(error)
      else resolve(result)
    }
    unsubscribe = store.subscribe((state, previous) => {
      if (!current()) return finish("superseded")
      if (state.session_status[sessionID]?.type === "idle"
        && (state.session_status[sessionID] !== previous.session_status[sessionID]
          || state.session_status_observed_at[sessionID] !== previous.session_status_observed_at[sessionID])) {
        finish("settled")
      }
    })
    // Bound the operation even when a runtime bridge ignores AbortSignal.
    const timeout = setTimeout(() => finish(current() ? "unconfirmed" : "superseded"), 5_000)
    try {
      void request(controller.signal).then(
        () => finish(current() ? "accepted" : "superseded"),
        (error: unknown) => current() ? finish("unconfirmed", error) : finish("superseded"),
      )
    } catch (error) {
      finish("unconfirmed", error)
    }
  })
}
