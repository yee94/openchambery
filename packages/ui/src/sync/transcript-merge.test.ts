import { describe, expect, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import {
  boundaryFromTranscriptData,
  mergeSessionTranscript,
  projectFlatFromTranscriptData,
  shareSessionTranscriptData,
  transportPageToTranscriptPage,
  type SessionTranscriptData,
} from "./transcript-merge"
import type { TranscriptTransportPage } from "./transcript-repository"

const SESSION = "ses_1"

function userMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "user", time: { created: 1 } } as Message
}

function assistantMessage(id: string): Message {
  return { id, sessionID: SESSION, role: "assistant", time: { created: 1 } } as Message
}

function textPart(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: SESSION, type: "text", text } as Part
}

function toolPart(id: string, messageID: string, state: Record<string, unknown>): Part {
  return { id, messageID, sessionID: SESSION, type: "tool", tool: "read", callID: `call_${id}`, state } as unknown as Part
}

function readToolState(
  data: SessionTranscriptData | undefined,
  messageID: string,
  partID: string,
): Record<string, unknown> | undefined {
  const parts = data?.pages.flatMap((page) => page.partsByMessageID[messageID] ?? [])
  const part = parts?.find((candidate) => candidate.id === partID)
  return (part as { state?: Record<string, unknown> } | undefined)?.state
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

describe("mergeSessionTranscript", () => {
  test("initial tail builds InfiniteData with one tail page", () => {
    const transport = page(
      [
        { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "hello")] },
        { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "hi")] },
      ],
      { cursor: "msg_1", complete: false, turnCount: 1 },
    )
    const { data, result } = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transport,
      liveRevision: 0,
    })
    expect(result.applied).toBe(true)
    expect(data?.pages).toHaveLength(1)
    expect(data?.pages[0]?.kind).toBe("tail")
    expect(data?.pages[0]?.messageOrder).toEqual(["msg_1", "msg_2"])
    expect(data?.pages[0]?.cursor).toBe("msg_1")
    expect(data?.pages[0]?.complete).toBe(false)
    expect(boundaryFromTranscriptData(data).kind).toBe("has-more")
  })

  test("fetchPreviousPage prepend inserts older history at pages[0]", () => {
    const initial = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [{ info: userMessage("msg_10") }, { info: assistantMessage("msg_11") }],
        { cursor: "msg_10", complete: false, turnCount: 1 },
      ),
    }).data!

    const { data, result } = mergeSessionTranscript(initial, SESSION, {
      type: "http-page",
      purpose: "prepend",
      page: page(
        [{ info: userMessage("msg_01") }, { info: assistantMessage("msg_02") }],
        { cursor: "msg_01", complete: false, turnCount: 1 },
      ),
    })
    expect(result.applied).toBe(true)
    expect(data?.pages).toHaveLength(2)
    expect(data?.pages[0]?.kind).toBe("history")
    expect(data?.pages[0]?.messageOrder).toContain("msg_01")
    expect(data?.pages[1]?.messageOrder).toContain("msg_10")
    const flat = projectFlatFromTranscriptData(data, SESSION)
    expect(flat.messageOrder[0]).toBe("msg_01")
  })

  test("complete page closes hasPreviousPage", () => {
    const { data } = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: userMessage("msg_1") }], { complete: true, turnCount: 1 }),
    })
    expect(data?.pages[0]?.complete).toBe(true)
    expect(data?.pages[0]?.cursor).toBe(null)
    expect(boundaryFromTranscriptData(data).kind).toBe("exhausted")
  })

  test("SSE updates preserve unaffected message/parts references", () => {
    const first = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "a")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "b")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const prevUser = first.pages[0]!.messagesByID["msg_1"]
    const prevUserParts = first.pages[0]!.partsByMessageID["msg_1"]

    const { data, result } = mergeSessionTranscript(first, SESSION, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: {
          part: textPart("p2", "msg_2", "b-updated"),
        },
      } as Event,
    })
    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(data?.pages[0]?.messagesByID["msg_1"]).toBe(prevUser)
    expect(data?.pages[0]?.partsByMessageID["msg_1"]).toBe(prevUserParts)
    expect((data?.pages[0]?.partsByMessageID["msg_2"]?.[0] as { text?: string })?.text).toBe("b-updated")
  })

  test("SSE tool lifecycle lands input, output and metadata", () => {
    const first = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          {
            info: assistantMessage("msg_1"),
            parts: [toolPart("p1", "msg_1", { status: "pending", input: {} })],
          },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const running = mergeSessionTranscript(first, SESSION, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: {
          part: toolPart("p1", "msg_1", {
            status: "running",
            input: { filePath: "/repo/README.md" },
            time: { start: 10 },
          }),
        },
      } as Event,
    })
    expect(running.result.changed).toBe(true)
    const runningState = readToolState(running.data, "msg_1", "p1")
    expect(runningState?.status).toBe("running")
    expect(runningState?.input).toEqual({ filePath: "/repo/README.md" })

    const completed = mergeSessionTranscript(running.data, SESSION, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: {
          part: toolPart("p1", "msg_1", {
            status: "completed",
            input: { filePath: "/repo/README.md" },
            output: "file contents",
            metadata: { preview: "# Title" },
            title: "README.md",
            time: { start: 10, end: 20 },
          }),
        },
      } as Event,
    })
    expect(completed.result.changed).toBe(true)
    const completedState = readToolState(completed.data, "msg_1", "p1")
    expect(completedState?.status).toBe("completed")
    expect(completedState?.input).toEqual({ filePath: "/repo/README.md" })
    expect(completedState?.output).toBe("file contents")
    expect(completedState?.title).toBe("README.md")
  })

  test("stale recovery uses insert-only when live revision advanced", () => {
    const initial = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "live")] },
        ],
        { complete: true, turnCount: 1 },
      ),
      liveRevision: 2,
    }).data!

    const liveMessage = initial.pages[0]!.messagesByID["msg_1"]

    // Recovery page with older snapshot of same message + a missing one.
    const { data, result } = mergeSessionTranscript(initial, SESSION, {
      type: "http-page",
      purpose: "recovery",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "stale")] },
          { info: userMessage("msg_0"), parts: [textPart("p0", "msg_0", "gap")] },
        ],
        { complete: true, turnCount: 2 },
      ),
      capturedLiveRevision: 1,
      liveRevision: 2,
    })
    expect(result.applied).toBe(true)
    // Stale recovery is insert-only for messages: keep live msg_1 reference.
    const flat = projectFlatFromTranscriptData(data, SESSION)
    expect(flat.messagesByID["msg_1"]).toBe(liveMessage)
    expect(flat.messagesByID["msg_0"]).toBeDefined()
  })

  test("optimistic add/confirm/remove", () => {
    const base = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: userMessage("msg_1") }], { complete: true }),
    }).data!

    const optimistic = userMessage("msg_opt")
    const parts = [textPart("p_opt", "msg_opt", "pending")]
    const added = mergeSessionTranscript(base, SESSION, {
      type: "optimistic-add",
      message: optimistic,
      parts,
    })
    expect(added.result.changed).toBe(true)
    expect(projectFlatFromTranscriptData(added.data, SESSION).messagesByID["msg_opt"]).toBeDefined()

    const confirmed = mergeSessionTranscript(added.data, SESSION, {
      type: "optimistic-confirm",
      messageID: "msg_opt",
    })
    expect(confirmed.result.applied).toBe(true)
    expect(confirmed.result.changed).toBe(false)
    expect(projectFlatFromTranscriptData(confirmed.data, SESSION).messagesByID["msg_opt"]).toBeDefined()

    const removed = mergeSessionTranscript(added.data, SESSION, {
      type: "optimistic-remove",
      messageID: "msg_opt",
    })
    expect(removed.result.changed).toBe(true)
    expect(projectFlatFromTranscriptData(removed.data, SESSION).messagesByID["msg_opt"]).toBeUndefined()
  })

  test("reset clears page chain and optional new tail", () => {
    const base = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: userMessage("msg_1") }], { cursor: "msg_1", complete: false }),
    }).data!

    const cleared = mergeSessionTranscript(base, SESSION, { type: "reset" })
    expect(cleared.result.changed).toBe(true)
    expect(cleared.data).toBeUndefined()

    const rebuilt = mergeSessionTranscript(base, SESSION, {
      type: "reset",
      page: page([{ info: userMessage("msg_9") }], { complete: true }),
    })
    expect(rebuilt.data?.pages).toHaveLength(1)
    expect(rebuilt.data?.pages[0]?.messageOrder).toEqual(["msg_9"])
  })

  test("shareSessionTranscriptData preserves equal page references", () => {
    const data = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info: userMessage("msg_1") }], { complete: true }),
    }).data!
    const shared = shareSessionTranscriptData(data, data, SESSION)
    expect(shared).toBe(data)
  })

  test("transportPageToTranscriptPage freezes records", () => {
    const pageData = transportPageToTranscriptPage(
      page([{ info: userMessage("msg_1") }], { complete: true }),
      "tail",
    )
    expect(Object.isFrozen(pageData)).toBe(true)
    expect(Object.isFrozen(pageData.messageOrder)).toBe(true)
  })
})
