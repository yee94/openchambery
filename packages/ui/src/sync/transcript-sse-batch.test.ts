import { describe, expect, test, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Event, Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"

import { createEventPipeline } from "./event-pipeline"
import {
  mergeSessionTranscript,
  type SessionTranscriptData,
} from "./transcript-merge"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import {
  createStoreTranscriptRepository,
  type TranscriptStoreSurface,
} from "./transcript-repository-store-adapter"
import type { TranscriptTransportPage } from "./transcript-repository"
import type { SessionHistoryBoundary } from "./types"

const SESSION = "ses_1"
const DIRECTORY = "/repo"
const TRANSPORT = "runtime-a"
const GENERATION = 1

function userMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "user", time: { created: 1 } } as Message
}

function assistantMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "assistant", time: { created: 1 } } as Message
}

function textPart(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text } as Part
}

function page(
  records: Array<{ info: Message; parts?: Part[] }>,
  options: { cursor?: string; complete?: boolean; turnCount?: number } = {},
): TranscriptTransportPage {
  return {
    records: records.map((record) => ({
      info: record.info,
      parts: record.parts ?? [],
    })),
    cursor: options.cursor,
    complete: options.complete ?? !options.cursor,
    turnCount: options.turnCount ?? 1,
  }
}

function seedTranscript(): SessionTranscriptData {
  return mergeSessionTranscript(undefined, SESSION, {
    type: "http-page",
    purpose: "initial",
    page: page(
      [
        { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "hello")] },
        { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "a")] },
      ],
      { complete: true, turnCount: 1 },
    ),
    liveRevision: 0,
  }).data!
}

function partUpdated(messageID: string, partID: string, text: string): Event {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: SESSION,
      part: textPart(partID, messageID, text),
    },
  } as Event
}

function partDelta(messageID: string, partID: string, delta: string): Event {
  return {
    type: "message.part.delta",
    properties: {
      sessionID: SESSION,
      messageID,
      partID,
      field: "text",
      delta,
    },
  } as Event
}

function messageUpdated(info: Message): Event {
  return {
    type: "message.updated",
    properties: { info },
  } as Event
}

function messageRemoved(messageID: string): Event {
  return {
    type: "message.removed",
    properties: { sessionID: SESSION, messageID },
  } as Event
}

function snapshotData(data: SessionTranscriptData | undefined) {
  if (!data) return null
  return {
    messageOrder: data.pages.flatMap((p) => [...p.messageOrder]),
    messages: Object.fromEntries(
      data.pages.flatMap((p) =>
        Object.entries(p.messagesByID).map(([id, msg]) => [id, msg]),
      ),
    ),
    parts: Object.fromEntries(
      data.pages.flatMap((p) =>
        Object.entries(p.partsByMessageID).map(([id, parts]) => [
          id,
          parts.map((part) => ({ ...part })),
        ]),
      ),
    ),
    boundary: {
      complete: data.pages[0]?.complete ?? false,
      cursor: data.pages[0]?.cursor ?? null,
    },
    liveRevision: data.pages[data.pages.length - 1]?.sync.liveRevision ?? 0,
  }
}

function applySequential(
  initial: SessionTranscriptData | undefined,
  events: readonly Event[],
): SessionTranscriptData | undefined {
  let data = initial
  for (const event of events) {
    data = mergeSessionTranscript(data, SESSION, {
      type: "sse-event",
      event,
    }).data
  }
  return data
}

describe("sse-event-batch merge", () => {
  test("behavior-equivalent final transcript vs sequential sse-event", () => {
    const initial = seedTranscript()
    const events: Event[] = [
      messageUpdated({
        ...assistantMessage("msg_2"),
        time: { created: 1, completed: 2 },
      } as Message),
      partUpdated("msg_2", "p2", "ab"),
      partUpdated("msg_2", "p2", "abc"),
      partDelta("msg_2", "p2", "!"),
      messageUpdated(assistantMessage("msg_3")),
      partUpdated("msg_3", "p3", "new"),
      messageRemoved("msg_1"),
    ]

    const sequential = applySequential(initial, events)
    const batched = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event-batch",
      events,
    })

    expect(batched.result.applied).toBe(true)
    expect(batched.result.changed).toBe(true)
    expect(snapshotData(batched.data)).toEqual(snapshotData(sequential))
  })

  test("preserves ordered intermediate part.updated + delta dedupe semantics", () => {
    const initial = seedTranscript()
    // part.updated to "abc" stamps __dedupeNextDeltaFields for overlapping text;
    // a following delta "bc" must not double-append when dedupe is active.
    const events: Event[] = [
      partUpdated("msg_2", "p2", "ab"),
      partUpdated("msg_2", "p2", "abc"),
      partDelta("msg_2", "p2", "bc"),
      partDelta("msg_2", "p2", "!"),
    ]

    const sequential = applySequential(initial, events)
    const batched = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event-batch",
      events,
    })

    const seqText = (
      sequential?.pages[0]?.partsByMessageID["msg_2"]?.[0] as { text?: string } | undefined
    )?.text
    const batchText = (
      batched.data?.pages[0]?.partsByMessageID["msg_2"]?.[0] as { text?: string } | undefined
    )?.text
    expect(batchText).toBe(seqText)
    expect(batchText).toBe("abc!")
  })

  test("duplicate payloads in a batch match a single apply", () => {
    const initial = seedTranscript()
    const event = partUpdated("msg_2", "p2", "updated")
    const once = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event",
      event,
    })
    const twice = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event-batch",
      events: [event, event],
    })
    expect(snapshotData(twice.data)).toEqual(snapshotData(once.data))
    expect(twice.result.changed).toBe(true)

    // Sequential second apply collapses payload-equal churn; batch matches that.
    const sequentialTwice = applySequential(initial, [event, event])
    expect(snapshotData(twice.data)).toEqual(snapshotData(sequentialTwice))
  })

  test("empty batch and non-transcript events are no-ops", () => {
    const initial = seedTranscript()
    const empty = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event-batch",
      events: [],
    })
    expect(empty.result).toEqual({ applied: false, changed: false })
    expect(empty.data).toBe(initial)

    const mixed = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event-batch",
      events: [
        { type: "session.updated", properties: { info: { id: SESSION } } } as unknown as Event,
        { type: "lsp.updated", properties: {} } as unknown as Event,
      ],
    })
    expect(mixed.result).toEqual({ applied: false, changed: false })
    expect(mixed.data).toBe(initial)

    const withOne = mergeSessionTranscript(initial, SESSION, {
      type: "sse-event-batch",
      events: [
        { type: "session.updated", properties: { info: { id: SESSION } } } as unknown as Event,
        partUpdated("msg_2", "p2", "z"),
      ],
    })
    expect(withOne.result.applied).toBe(true)
    expect(withOne.result.changed).toBe(true)
    expect(
      (withOne.data?.pages[0]?.partsByMessageID["msg_2"]?.[0] as { text?: string })?.text,
    ).toBe("z")
  })
})

describe("sse-event-batch query adapter", () => {
  const scope = {
    directory: DIRECTORY,
    sessionID: SESSION,
    transport: TRANSPORT,
    generation: GENERATION,
  }

  test("batch apply notifies once and clears seededAuthorityPending", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const setQueryData = vi.spyOn(client, "setQueryData")
    const repo = createQueryTranscriptRepository({
      client,
      transport: TRANSPORT,
      generation: GENERATION,
    })

    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
        ],
        { complete: true },
      ),
    })
    setQueryData.mockClear()

    let notifyCount = 0
    const unsub = repo.subscribe(scope, () => {
      notifyCount += 1
    })

    const events = [
      partUpdated("msg_2", "p2", "b1"),
      partUpdated("msg_2", "p2", "b2"),
      partUpdated("msg_2", "p2", "b3"),
    ]

    // Sequential path pays per-event setQueryData (+ cache-subscribe notify fanout).
    for (const event of events) {
      repo.apply(scope, { type: "sse-event", event })
    }
    const sequentialSetCount = setQueryData.mock.calls.length
    const sequentialNotify = notifyCount
    expect(sequentialSetCount).toBe(events.length)
    expect(sequentialNotify).toBeGreaterThanOrEqual(events.length)

    // Reset to same seed
    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
        ],
        { complete: true },
      ),
    })
    setQueryData.mockClear()
    notifyCount = 0

    const batchResult = repo.apply(scope, {
      type: "sse-event-batch",
      events,
    })
    expect(batchResult.applied).toBe(true)
    expect(batchResult.changed).toBe(true)
    // One merge write; notify is explicit apply notify + cache subscription (≤2).
    expect(setQueryData.mock.calls.length).toBe(1)
    expect(notifyCount).toBeLessThan(sequentialNotify)
    expect(notifyCount).toBeLessThanOrEqual(2)
    expect((repo.getParts(scope, "msg_2")[0] as { text?: string })?.text).toBe("b3")

    unsub()
    repo.destroy()
  })
})

describe("sse-event-batch store adapter", () => {
  type HarnessState = {
    message: Record<string, Message[]>
    part: Record<string, Part[]>
    session_history_boundary: Record<string, SessionHistoryBoundary>
    session_status: Record<string, unknown>
    session_status_observed_at: Record<string, number>
    session_diff: Record<string, unknown>
    todo: Record<string, unknown>
    permission: Record<string, unknown>
    question: Record<string, unknown>
    session: []
  }

  function createHarnessStore(): TranscriptStoreSurface {
    let state: HarnessState = {
      message: {},
      part: {},
      session_history_boundary: {},
      session_status: {},
      session_status_observed_at: {},
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      session: [],
    }
    const listeners = new Set<
      (
        next: ReturnType<TranscriptStoreSurface["getState"]>,
        prev: ReturnType<TranscriptStoreSurface["getState"]>,
      ) => void
    >()
    return {
      getState: () => state as ReturnType<TranscriptStoreSurface["getState"]>,
      setState: (partial) => {
        const prev = state
        const nextPartial =
          typeof partial === "function"
            ? partial(state as ReturnType<TranscriptStoreSurface["getState"]>)
            : partial
        state = { ...state, ...nextPartial } as HarnessState
        for (const listener of listeners) {
          listener(
            state as ReturnType<TranscriptStoreSurface["getState"]>,
            prev as ReturnType<TranscriptStoreSurface["getState"]>,
          )
        }
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }

  test("batch applies once setState and matches sequential final parts", () => {
    const store = createHarnessStore()
    let setStateCount = 0
    const rawSetState = store.setState.bind(store)
    store.setState = ((partial: Parameters<TranscriptStoreSurface["setState"]>[0]) => {
      setStateCount += 1
      return rawSetState(partial)
    }) as TranscriptStoreSurface["setState"]

    const repo = createStoreTranscriptRepository({
      getStore: () => store,
      getLiveRevision: () => 0,
    })
    const scope = { directory: DIRECTORY, sessionID: SESSION }

    repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [{ info: assistantMessage("msg_a"), parts: [textPart("part_a", "msg_a", "hel")] }],
        { complete: true },
      ),
    })
    setStateCount = 0

    const events: Event[] = [
      partUpdated("msg_a", "part_a", "hell"),
      partUpdated("msg_a", "part_a", "hello"),
      partDelta("msg_a", "part_a", "!"),
    ]

    const result = repo.apply(scope, {
      type: "sse-event-batch",
      events,
    })
    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(setStateCount).toBe(1)
    expect((repo.getParts(scope, "msg_a")[0] as { text?: string }).text).toBe("hello!")
  })
})

describe("event-pipeline onFlushStart/onFlushEnd", () => {
  const failAfter = (ms: number) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("Timed out waiting for event pipeline flush")), ms)
  })

  function createSdk(events: Event[], streamFinished: () => void): OpencodeClient {
    return {
      global: {
        event: async ({ signal }: { signal: AbortSignal }) => ({
          stream: (async function* () {
            for (const payload of events) {
              yield { directory: "/repo", payload }
            }
            streamFinished()
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve()
                return
              }
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
          })(),
        }),
      },
    } as unknown as OpencodeClient
  }

  test("hooks fire once around a non-empty flush frame", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })

    const starts: number[] = []
    const ends: number[] = []
    const delivered: Event[] = []

    const events = [
      partUpdated("msg_1", "p1", "a"),
      partUpdated("msg_1", "p1", "ab"),
    ]

    const pipeline = createEventPipeline({
      sdk: createSdk(events, resolveStreamFinished),
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
      onFlushStart: () => {
        starts.push(Date.now())
      },
      onFlushEnd: () => {
        ends.push(Date.now())
      },
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === events.length) resolveDelivered()
      },
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    expect(delivered).toHaveLength(2)
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(starts[0]!).toBeLessThanOrEqual(ends[0]!)
  })

  test("empty flush frames do not invoke hooks", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })

    const starts: number[] = []
    const ends: number[] = []

    const pipeline = createEventPipeline({
      sdk: createSdk([], resolveStreamFinished),
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
      onFlushStart: () => {
        starts.push(Date.now())
      },
      onFlushEnd: () => {
        ends.push(Date.now())
      },
      onEvent: () => {
        throw new Error("empty stream must not dispatch")
      },
    })

    try {
      await streamFinished
      await new Promise((r) => setTimeout(r, 80))
    } finally {
      pipeline.cleanup()
    }

    expect(starts).toHaveLength(0)
    expect(ends).toHaveLength(0)
  })
})
