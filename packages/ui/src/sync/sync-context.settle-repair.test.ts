/**
 * Regression coverage for the "assistant TPS missing after settle" repair.
 *
 * The settle `message.updated` tick that carries `time.completed` can be lost
 * on the live channel (observed on mobile relay/WS). The tail assistant then
 * keeps its terminal finish without a completion timestamp, turn duration and
 * assistant TPS cannot render, and a cold start is the only recovery. These
 * tests pin the two self-heal triggers added around session materialization:
 *
 * 1. A cooldown-suppressed enqueue still repairs when the live tail shows the
 *    settle gap (the suppression check is deferred one microtask so a settle
 *    tick lost earlier in the same event frame is visible).
 * 2. A completed materialization whose page could not repair the gap (e.g.
 *    stale-dropped against live SSE) reconciles once from authority.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Message, Part } from "@/lib/opencode/v2-types"
import type { Event } from "@/sync/types"
import { QueryClient } from '@tanstack/react-query'
import { createQueryTranscriptRepository } from './transcript-repository-query-adapter'
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch'

const { fetchPageMock } = vi.hoisted(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })))
  return { fetchPageMock: vi.fn() }
})

vi.mock("./transcript-repository-production", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transcript-repository-production")>()
  return {
    ...actual,
    fetchProductionTranscriptTransportPage: fetchPageMock,
  }
})

import { handleEvent, handleNormalizedOpenCodeHints, setActiveSession } from "./sync-context"
import { normalizeOpenCodeEvent } from './opencode-event-normalizer'
import {
  bindTranscriptRepositoryInstance,
  unbindTranscriptRepository,
} from "./transcript-repository-runtime"
import type { TranscriptRepository, TranscriptScope } from "./transcript-repository"
import type { ChildStoreManager } from "./child-store"

const DIRECTORY = "/proj"
const SESSION = "ses_settle"

type RoutingIndex = Parameters<typeof handleEvent>[3]

const routingIndex: RoutingIndex = {
  sessionDirectoryById: new Map(),
  messageSessionById: new Map(),
  sessionMessageIdsById: new Map(),
} as RoutingIndex

const idleEvent: Event = {
  type: "session.idle",
  properties: { sessionID: SESSION },
} as Event

const assistantWith = (extra: Partial<Message>): Message =>
  ({
    id: "msg_a",
    sessionID: SESSION,
    role: "assistant",
    time: { created: 2000 },
    ...extra,
  }) as Message

const gapTail = assistantWith({
  finish: "stop",
  tokens: { input: 1, output: 44, reasoning: 9, cache: { read: 0, write: 0 } },
})
const settledTail = assistantWith({
  finish: "stop",
  tokens: { input: 1, output: 44, reasoning: 9, cache: { read: 0, write: 0 } },
  time: { created: 2000, completed: 21000 },
})

const transcriptFor = (tail: Message) => ({
  sessionID: SESSION,
  messageOrder: ["msg_u", tail.id],
  messagesByID: { msg_u: { id: "msg_u", sessionID: SESSION, role: "user", time: { created: 1000 } } as Message, [tail.id]: tail },
  partsByMessageID: {} as Record<string, readonly Part[]>,
  boundary: { kind: "exhausted", loadedTurns: 1 } as const,
  liveRevision: 3,
})

const createStore = () => {
  const state: Record<string, unknown> = {
    session: [],
    session_status: {},
    session_status_observed_at: {},
    permission: {},
    question: {},
    todo: {},
    session_diff: {},
    lsp: [],
  }
  return {
    getState: () => state,
    setState: (next: Record<string, unknown>) => Object.assign(state, next),
    subscribe: () => () => {},
  }
}

const stableStore = createStore()
const childStores = {
  getChild: () => stableStore,
  children: new Map(),
  ensureChild: () => undefined,
  mark: () => undefined,
} as unknown as ChildStoreManager

const bindRepository = (tail: Message) => {
  const refreshFromAuthority = vi.fn(async (_scope: TranscriptScope) => transcriptFor(tail))
  const repository = {
    getTranscript: () => transcriptFor(tail),
    apply: () => ({ applied: true, changed: true }),
    refreshFromAuthority,
  } as unknown as TranscriptRepository
  bindTranscriptRepositoryInstance(repository)
  return refreshFromAuthority
}

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("settle-gap repair around session materialization", () => {
  beforeEach(() => {
    fetchPageMock.mockReset()
    setActiveSession(DIRECTORY, SESSION)
  })

  afterEach(() => {
    setActiveSession("", "")
    unbindTranscriptRepository()
  })

  test("cooldown-suppressed idle enqueue repairs a missing settle tick", async () => {
    const refreshFromAuthority = bindRepository(gapTail)
    fetchPageMock.mockRejectedValue(new Error("offline"))

    // Both receipts arrive before the scheduled reconciliation starts and
    // share one authoritative tail read.
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)

    await vi.waitFor(() => {
      expect(refreshFromAuthority).toHaveBeenCalledTimes(1)
    })
    const scope = refreshFromAuthority.mock.calls[0]![0] as TranscriptScope
    expect(scope.directory).toBe(DIRECTORY)
    expect(scope.sessionID).toBe(SESSION)
  })

  test("duplicate idle receipts coalesce even when the known tail looks complete", async () => {
    const refreshFromAuthority = bindRepository(settledTail)
    fetchPageMock.mockRejectedValue(new Error("offline"))

    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    await flushAsync()
    await flushAsync()

    expect(refreshFromAuthority).toHaveBeenCalledTimes(1)
  })

  test("materialize that cannot repair the gap reconciles from authority", async () => {
    const refreshFromAuthority = bindRepository(gapTail)
    fetchPageMock.mockResolvedValue({
      records: [
        { info: { id: "msg_u", sessionID: SESSION, role: "user", time: { created: 1000 } }, parts: [] },
        { info: settledTail, parts: [] },
      ],
      complete: true,
      turnCount: 1,
    })

    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)

    await vi.waitFor(() => {
      expect(refreshFromAuthority).toHaveBeenCalledTimes(1)
    })
  })

  test.each(['tool-calls', 'stop'])('idle recovers an entirely missing final message after a completed %s step', async (finish) => {
    const client = new QueryClient()
    const toolTail = assistantWith({ finish, time: { created: 2, completed: 3 }, tokens: settledTail.tokens })
    const final = { ...settledTail, id: 'msg_final' }
    const records = [
      { info: transcriptFor(toolTail).messagesByID.msg_u, parts: [] },
      { info: toolTail, parts: [] },
      { info: final, parts: [{ id: 'final-text', type: 'text', messageID: final.id, sessionID: SESSION, text: 'Final answer retained' } as Part] },
    ]
    const fetcher = vi.fn(async () => ({ records, complete: true }))
    const repo = createQueryTranscriptRepository({ client, fetcher, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() })
    bindTranscriptRepositoryInstance(repo)
    const scope = { directory: DIRECTORY, sessionID: SESSION }
    repo.apply(scope, { type: 'materialize-snapshots', records: records.slice(0, 2) })
    // A recovery page can predate the missing final step without exhibiting
    // missing completion fields on any locally known message.
    fetchPageMock.mockResolvedValue({ records: records.slice(0, 2), complete: true })
    try {
      handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
      await vi.waitFor(() => expect(repo.getParts(scope, final.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: 'Final answer retained' }),
      ])))
      expect(repo.getTranscript(scope).messageOrder).toEqual(['msg_u', 'msg_a', 'msg_final'])
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      unbindTranscriptRepository()
      repo.destroy()
      client.clear()
    }
  })

  test('idle during a pre-terminal fetch reconciles after that fetch, not inside its old flight', async () => {
    const refresh = bindRepository(settledTail)
    let finishPage!: (page: { records: never[]; complete: boolean }) => void
    fetchPageMock.mockImplementation(() => new Promise(resolve => { finishPage = resolve }))
    const normalized = normalizeOpenCodeEvent({
      id: 'evt_step_end', type: 'session.step.ended', created: 100,
      data: { sessionID: SESSION, assistantMessageID: 'msg_a', finish: 'tool-calls' },
      location: { directory: DIRECTORY },
    })
    if (normalized.action !== 'emit') throw new Error('Expected native step event')
    handleNormalizedOpenCodeHints(DIRECTORY, normalized.event, childStores)
    await vi.waitFor(() => expect(fetchPageMock).toHaveBeenCalledTimes(1))
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
    await flushAsync()
    expect(refresh).not.toHaveBeenCalled()
    finishPage({ records: [], complete: true })
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  })

  test('failed idle reconciliation preserves content and another idle can retry', async () => {
    const client = new QueryClient()
    const scope = { directory: DIRECTORY, sessionID: SESSION }
    const records = [{ info: settledTail, parts: [{ id: 'kept', messageID: settledTail.id, sessionID: SESSION, type: 'text', text: 'Already shown' } as Part] }]
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ records, complete: true })
    const repo = createQueryTranscriptRepository({ client, fetcher, transport: getRuntimeTransportIdentity(), generation: getRuntimeGeneration() })
    bindTranscriptRepositoryInstance(repo)
    repo.apply(scope, { type: 'materialize-snapshots', records })
    try {
      handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
      await flushAsync()
      await flushAsync()
      expect(repo.getParts(scope, settledTail.id)).toEqual(records[0].parts)
      handleEvent(DIRECTORY, idleEvent, childStores, routingIndex)
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
      await flushAsync()
      expect(repo.getParts(scope, settledTail.id)).toEqual(records[0].parts)
    } finally {
      unbindTranscriptRepository()
      repo.destroy()
      client.clear()
    }
  })
})
