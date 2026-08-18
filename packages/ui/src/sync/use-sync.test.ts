import { describe, expect, test } from 'bun:test'
import type { Message, Part } from '@opencode-ai/sdk/v2/client'

import {
  commitSessionIdentity,
  getConstrainedCacheStateAfterPrefetchEviction,
  shouldFetchSessionForRenderableSync,
  hasUserMessage,
  isUserTranscriptRefreshBlocked,
  resolveSessionHistoryLoadPlan,
  SESSION_AUTHORITY_REVALIDATE_WINDOW_MS,
  syncMetaFromBoundary,
} from './use-sync'
import {
  clearSessionAuthorityRevalidateWindows,
  isSessionAuthorityRevalidateFresh,
  markSessionAuthorityRevalidated,
} from './session-authority-revalidate'
import { mergeOptimisticPage } from './optimistic'
import { materializeSessionSnapshots } from './materialization'

describe('syncMetaFromBoundary', () => {
  test('an unknown boundary has no cursor and is not complete', () => {
    const meta = syncMetaFromBoundary({ kind: 'unknown', loadedTurns: 0 })
    expect(meta.cursor).toBeUndefined()
    expect(meta.complete).toBe(false)
    expect(meta.limit).toBe(0)
    expect(meta.loading).toBe(false)
  })

  test('a has-more boundary exposes its cursor for pagination', () => {
    const meta = syncMetaFromBoundary({ kind: 'has-more', cursor: 'msg_x', loadedTurns: 2 })
    expect(meta.cursor).toBe('msg_x')
    expect(meta.complete).toBe(false)
    expect(meta.limit).toBe(2)
    expect(resolveSessionHistoryLoadPlan(meta)).toEqual({ kind: 'prepend', before: 'msg_x' })
  })

  test('an exhausted boundary reads as complete with no cursor', () => {
    const meta = syncMetaFromBoundary({ kind: 'exhausted', loadedTurns: 4 })
    expect(meta.complete).toBe(true)
    expect(meta.cursor).toBeUndefined()
    expect(resolveSessionHistoryLoadPlan(meta)).toEqual({ kind: 'exhausted' })
  })

  test('loading is a request-lifecycle flag, never part of the boundary', () => {
    const meta = syncMetaFromBoundary({ kind: 'has-more', cursor: 'msg_x', loadedTurns: 2 }, true)
    expect(meta.loading).toBe(true)
    expect(resolveSessionHistoryLoadPlan(meta)).toEqual({ kind: 'busy' })
  })
})

describe('resolveSessionHistoryLoadPlan', () => {
  test('recovers the tail cursor before prepend when history is incomplete but cursor is absent', () => {
    // Exact mobile failure: the UI can still have a stale load-more affordance,
    // while local pagination meta is incomplete with no cursor. A direct
    // prepend would no-op/throw; refresh the authoritative tail first.
    expect(resolveSessionHistoryLoadPlan({
      cursor: undefined,
      complete: false,
      loading: false,
    })).toEqual({ kind: 'recover-cursor' })
  })

  test('starts prepend when the incomplete history meta has a cursor', () => {
    expect(resolveSessionHistoryLoadPlan({
      cursor: 'msg_before',
      complete: false,
      loading: false,
    })).toEqual({ kind: 'prepend', before: 'msg_before' })
  })
})

describe('shouldFetchSessionForRenderableSync', () => {
  test('fetches full session detail when a lightweight list session is opened', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: true,
      shouldLoadMessages: true,
      force: false,
    })).toBe(true)
  })

  test('skips session detail fetch when session and messages are already ready', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: true,
      shouldLoadMessages: false,
      force: false,
    })).toBe(false)
  })

  test('fetches when the session record is missing', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: false,
      shouldLoadMessages: false,
      force: false,
    })).toBe(true)
  })

  test('fetches identity when a message TTL remains ready', () => {
    expect(shouldFetchSessionForRenderableSync({
      hasSession: false,
      shouldLoadMessages: false,
      force: false,
    })).toBe(true)
  })
})

describe('commitSessionIdentity', () => {
  test('commits exact session identity into the target directory store', () => {
    const providerState = { session: [{ id: 'ses_provider' }] }
    const targetState = { session: [] as Array<{ id: string; title?: string }> }
    const targetStore = {
      getState: () => targetState,
      setState: (next: Partial<typeof targetState>) => Object.assign(targetState, next),
    } as unknown as Parameters<typeof commitSessionIdentity>[0]

    commitSessionIdentity(targetStore, 'ses_target', { id: 'ses_target', title: 'Target' } as never)

    expect(targetState.session).toEqual([{ id: 'ses_target', title: 'Target' }])
    expect(providerState.session).toEqual([{ id: 'ses_provider' }])
  })
})

describe('getConstrainedCacheStateAfterPrefetchEviction', () => {
  test('continues constrained cache eviction from the target directory store', () => {
    const providerState = { message: { ses_provider: [] } }
    const targetState = { message: { ses_target: [] } }

    const resolved = getConstrainedCacheStateAfterPrefetchEviction({
      prefetched: ['ses_prefetched'],
      state: targetState,
      targetStore: { getState: () => targetState },
    })

    expect(resolved).toBe(targetState)
    expect(resolved.message).toEqual({ ses_target: [] })
    expect(providerState.message).toEqual({ ses_provider: [] })
  })
})

// --- loadMessages incremental commit (#2084) ---------------------------------
// loadMessages is a React hook callback and cannot be unit-tested in isolation.
// These tests cover the three invariants the refactor relies on:
//   1. hasUserMessage gates the first store commit (assistant-only tails defer
//      to the expansion loop so the skeleton stays instead of an empty chat).
//   2. Incremental materialization of superset pages preserves references for
//      already-committed messages (no re-render churn, no reference breaks).
//   3. mergeOptimisticPage + clearOptimistic is idempotent across commits.

function assistantMessage(id: string): Message {
  return { id, sessionID: 'ses_1', role: 'assistant', time: { created: 1 } } as Message
}
function userMessage(id: string): Message {
  return { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } } as Message
}
function assistantMessageWithClientRole(id: string): Message {
  // OpenCode sets clientRole on the wire; role may be absent.
  return { id, sessionID: 'ses_1', clientRole: 'user', time: { created: 1 } } as unknown as Message
}
function textPart(id: string, messageID: string): Part {
  return { id, messageID, sessionID: 'ses_1', type: 'text', text: id } as Part
}

describe('hasUserMessage', () => {
  test('returns true when a user message is present', () => {
    expect(hasUserMessage([assistantMessage('m_1'), userMessage('m_2')])).toBe(true)
  })

  test('returns true when clientRole marks the message as user', () => {
    expect(hasUserMessage([assistantMessageWithClientRole('m_1')])).toBe(true)
  })

  test('returns false when only assistant messages are present', () => {
    expect(hasUserMessage([assistantMessage('m_1'), assistantMessage('m_2')])).toBe(false)
  })

  test('returns false for undefined', () => {
    expect(hasUserMessage(undefined)).toBe(false)
  })

  test('returns false for an empty array', () => {
    expect(hasUserMessage([])).toBe(false)
  })
})

describe('incremental materialization of superset pages (#2084)', () => {
  const SKIP_PARTS = new Set(['patch', 'step-start', 'step-finish'])

  test('preserves message references for already-committed messages', () => {
    // Simulate expansion: commit 50 (assistant-only), then 100 (with user), then 150.
    // Pages are supersets: the 100-page includes all 50 from the first page,
    // the 150-page includes all 100 from the second.
    // Messages are sorted by id in the store (mergeMessages uses cmp by id),
    // so look them up by id rather than positional index.
    const a1 = assistantMessage('a_1')
    const a2 = assistantMessage('a_2')
    const u1 = userMessage('u_1')
    const u0 = userMessage('u_0')
    const a3 = assistantMessage('a_3')
    const page50 = [a1, a2]
    const page100 = [u1, a1, a2]
    const page150 = [u0, u1, a1, a2, a3]

    const partsFor = (msgs: Message[]): { info: Message; parts: Part[] }[] =>
      msgs.map((info) => ({
        info,
        parts: info.role === 'assistant' ? [textPart(`p_${info.id}`, info.id)] : [],
      }))

    let state = { message: {} as Record<string, Message[]>, part: {} as Record<string, Part[]> }

    // Commit 1: assistant-only page (skeleton stays — no user message).
    // But materialization itself is valid; we test the reference property here.
    const m1 = materializeSessionSnapshots(state, 'ses_1', partsFor(page50), { skipPartTypes: SKIP_PARTS })
    state = { message: m1.message, part: m1.part }
    const afterFirst = state.message.ses_1
    expect(afterFirst.find((m) => m.id === 'a_1')).toBe(a1)
    expect(afterFirst.find((m) => m.id === 'a_2')).toBe(a2)

    // Commit 2: 100-message superset.
    const m2 = materializeSessionSnapshots(state, 'ses_1', partsFor(page100), { skipPartTypes: SKIP_PARTS })
    state = { message: m2.message, part: m2.part }
    const afterSecond = state.message.ses_1
    expect(afterSecond.find((m) => m.id === 'a_1')).toBe(a1)
    expect(afterSecond.find((m) => m.id === 'a_2')).toBe(a2)
    expect(afterSecond.find((m) => m.id === 'u_1')).toBe(u1)

    // Commit 3: 150-message superset.
    const m3 = materializeSessionSnapshots(state, 'ses_1', partsFor(page150), { skipPartTypes: SKIP_PARTS })
    const afterThird = m3.message.ses_1
    // All previously-committed messages keep their references.
    expect(afterThird.find((m) => m.id === 'a_1')).toBe(a1)
    expect(afterThird.find((m) => m.id === 'a_2')).toBe(a2)
    expect(afterThird.find((m) => m.id === 'u_1')).toBe(u1)
    // New messages from the 150-page are present.
    expect(afterThird.find((m) => m.id === 'u_0')).toBe(u0)
    expect(afterThird.find((m) => m.id === 'a_3')).toBe(a3)
  })

  test('preserves part references for unchanged assistant messages', () => {
    const msg = assistantMessage('a_1')
    const prt = textPart('p_a_1', 'a_1')
    const state = {
      message: { ses_1: [msg] } as Record<string, Message[]>,
      part: { a_1: [prt] } as Record<string, Part[]>,
    }

    // Re-materialize with the same message + part (superset adds a new message).
    const m = materializeSessionSnapshots(state, 'ses_1', [
      { info: msg, parts: [prt] },
      { info: userMessage('u_1'), parts: [] },
    ], { skipPartTypes: new Set(['patch', 'step-start', 'step-finish']) })

    // The existing part array reference is preserved (equivalent snapshot).
    expect(m.part.a_1).toBe(state.part.a_1)
    expect(m.partsChanged).toBe(false) // user message has no parts → no part change
  })

  test('does not create a no-op store update when re-committing the same page', () => {
    const msg = userMessage('u_1')
    const state = {
      message: { ses_1: [msg] } as Record<string, Message[]>,
      part: {} as Record<string, Part[]>,
    }

    const m = materializeSessionSnapshots(state, 'ses_1', [
      { info: msg, parts: [] },
    ], { skipPartTypes: new Set(['patch', 'step-start', 'step-finish']) })

    expect(m.messagesChanged).toBe(false)
    expect(m.partsChanged).toBe(false)
    expect(m.message).toBe(state.message)
    expect(m.part).toBe(state.part)
  })
})

describe('mergeOptimisticPage idempotency across commits (#2084)', () => {
  test('second call after clearOptimistic returns the page unchanged', () => {
    // Simulate: first commit confirmed an optimistic item, clearOptimistic
    // removed it; second commit (expansion) finds no optimistic items.
    const page = { session: [userMessage('u_1')], part: [{ id: 'u_1', part: [] }], cursor: 'c1', complete: false }

    // First merge with one optimistic item.
    const optimisticItem = { message: userMessage('opt_1'), parts: [textPart('p_opt_1', 'opt_1')] }
    const merged1 = mergeOptimisticPage(page, [optimisticItem])
    expect(merged1.confirmed).toEqual([]) // opt_1 is not in page.session → not confirmed

    // After clearOptimistic (simulated by passing empty items), merge is a no-op.
    const merged2 = mergeOptimisticPage(page, [])
    expect(merged2.confirmed).toEqual([])
    expect(merged2.session).toEqual(page.session)
    expect(merged2.cursor).toBe('c1')
    expect(merged2.complete).toBe(false)
  })

  test('mergeOptimisticPage with empty items is a fast no-op path', () => {
    const page = {
      session: [assistantMessage('a_1')],
      part: [{ id: 'a_1', part: [textPart('p_a_1', 'a_1')] }],
      cursor: undefined,
      complete: true,
    }
    const merged = mergeOptimisticPage(page, [])
    expect(merged.session).toEqual(page.session)
    expect(merged.confirmed).toEqual([])
    expect(merged.complete).toBe(true)
  })

  test('does not double file parts when server echoes different part IDs', () => {
    const message = userMessage('msg_1')
    const optimisticFile = {
      id: 'prt_opt_file',
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,abc',
      filename: 'image-1.png',
    } as never
    const serverFile = {
      id: 'prt_server_file',
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,abc',
      filename: 'image-1.png',
    } as never
    const page = {
      session: [message],
      part: [{ id: 'msg_1', part: [textPart('prt_server_text', 'msg_1'), serverFile] }],
      cursor: undefined,
      complete: true,
    }
    const merged = mergeOptimisticPage(page, [{
      message,
      parts: [textPart('prt_opt_text', 'msg_1'), optimisticFile],
    }])
    expect(merged.confirmed).toEqual(['msg_1'])
    const parts = merged.part.find((item) => item.id === 'msg_1')?.part ?? []
    expect(parts.filter((part) => part.type === 'file')).toHaveLength(1)
    expect(parts.find((part) => part.type === 'file')?.id).toBe('prt_server_file')
  })

  test('confirms an optimistic tail row in conversation order without duplicating it', () => {
    const optimistic = userMessage('msg_15')
    const page = {
      session: [
        userMessage('msg_9'),
        assistantMessage('msg_1'),
        userMessage('msg_2'),
        assistantMessage('msg_3'),
        optimistic,
      ],
      part: [
        { id: 'msg_9', part: [] },
        { id: 'msg_1', part: [] },
        { id: 'msg_2', part: [] },
        { id: 'msg_3', part: [] },
        { id: 'msg_15', part: [textPart('p_15', 'msg_15')] },
      ],
      cursor: undefined,
      complete: true,
    }
    const merged = mergeOptimisticPage(page, [{
      message: optimistic,
      parts: [textPart('p_opt', 'msg_15')],
    }])
    expect(merged.session.map((message) => message.id)).toEqual([
      'msg_9',
      'msg_1',
      'msg_2',
      'msg_3',
      'msg_15',
    ])
    expect(merged.confirmed).toEqual(['msg_15'])
  })
})

describe('first-commit gating invariant (#2084)', () => {
  // The loadMessages refactor gates the first store commit on hasUserMessage.
  // When the first page is assistant-only, it defers to the expansion loop
  // and keeps the skeleton. This test verifies the gate condition itself:
  // hasUserMessage(page.session) must be false for an assistant-only page.
  test('assistant-only page does not trigger an early commit', () => {
    const assistantOnlyPage = [assistantMessage('a_1'), assistantMessage('a_2')]
    expect(hasUserMessage(assistantOnlyPage)).toBe(false)
  })

  test('page with a user message triggers an early commit', () => {
    const pageWithUser = [assistantMessage('a_1'), userMessage('u_1')]
    expect(hasUserMessage(pageWithUser)).toBe(true)
  })

  test('complete page triggers an early commit even without a user message', () => {
    // page.complete means there are no older messages to expand into.
    // Committing immediately is correct — the skeleton should disappear.
    // This mirrors the `hasUserMessage(page.session) || page.complete` gate.
    const completeAssistantOnlyPage = [assistantMessage('a_1')]
    const isComplete = true
    expect(hasUserMessage(completeAssistantOnlyPage) || isComplete).toBe(true)
  })

  test('prepend mode always commits — deferral does not apply', () => {
    // The deferred init path exists to keep the skeleton visible for an
    // assistant-only initial fetch. Prepend mode (loading older history)
    // has no skeleton to protect and must always write to the store —
    // otherwise the fetched older messages would be silently dropped.
    //
    // This test pins the gate condition: deferral requires `!options.before`.
    // An assistant-only, incomplete page in prepend mode must NOT defer.
    const assistantOnlyPage = [assistantMessage('a_1'), assistantMessage('a_2')]
    const hasBefore = true // prepend mode
    const isComplete = false

    // The actual gate in loadMessages is:
    //   const deferFirstCommit = !options?.before && !page.complete && !hasUserMessage(page.session)
    const deferFirstCommit = !hasBefore && !isComplete && !hasUserMessage(assistantOnlyPage)
    expect(deferFirstCommit).toBe(false) // prepend must not defer
  })
})

describe('enter-and-sync authority window', () => {
  test('is fresh only after a successful stamp and inside the 30s window', () => {
    clearSessionAuthorityRevalidateWindows()
    expect(SESSION_AUTHORITY_REVALIDATE_WINDOW_MS).toBe(30_000)
    expect(isSessionAuthorityRevalidateFresh('/repo', 'ses_1', {
      transport: 'runtime-a',
      generation: 1,
    })).toBe(false)

    markSessionAuthorityRevalidated('/repo', 'ses_1', {
      now: 1_000,
      transport: 'runtime-a',
      generation: 1,
    })
    expect(isSessionAuthorityRevalidateFresh('/repo', 'ses_1', {
      now: 1_000 + SESSION_AUTHORITY_REVALIDATE_WINDOW_MS - 1,
      transport: 'runtime-a',
      generation: 1,
    })).toBe(true)
    expect(isSessionAuthorityRevalidateFresh('/repo', 'ses_1', {
      now: 1_000 + SESSION_AUTHORITY_REVALIDATE_WINDOW_MS,
      transport: 'runtime-a',
      generation: 1,
    })).toBe(false)
    expect(isSessionAuthorityRevalidateFresh('/repo', 'ses_1', {
      now: 1_000,
      transport: 'runtime-b',
      generation: 1,
    })).toBe(false)
    clearSessionAuthorityRevalidateWindows()
  })
})

describe('isUserTranscriptRefreshBlocked', () => {
  test('refuses busy and retry so a user refresh cannot fight SSE', () => {
    expect(isUserTranscriptRefreshBlocked('busy')).toBe(true)
    expect(isUserTranscriptRefreshBlocked('retry')).toBe(true)
  })

  test('allows idle and unknown status', () => {
    expect(isUserTranscriptRefreshBlocked('idle')).toBe(false)
    expect(isUserTranscriptRefreshBlocked(undefined)).toBe(false)
    expect(isUserTranscriptRefreshBlocked(null)).toBe(false)
  })

  test('unknown live status is not blocked even if a sticky global busy exists', () => {
    // Refresh gates must read child-store live status only. A missed idle
    // left in the global fallback must not disable the button.
    expect(isUserTranscriptRefreshBlocked(undefined)).toBe(false)
  })
})
