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

  test("optimistic add of a queued message stays at the conversation tail, not the id slot", () => {
    // Queue items often keep a messageID minted while the previous turn was
    // still streaming. Id-insert then drops the new user row into the middle.
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_9") },
          { info: assistantMessage("msg_1") },
          { info: userMessage("msg_2") },
          { info: assistantMessage("msg_3") },
        ],
        { complete: true, turnCount: 2 },
      ),
    }).data!

    const queued = userMessage("msg_15")
    const added = mergeSessionTranscript(live, SESSION, {
      type: "optimistic-add",
      message: queued,
      parts: [textPart("p_queued", "msg_15", "queued")],
    })
    expect(projectFlatFromTranscriptData(added.data, SESSION).messageOrder).toEqual([
      "msg_9",
      "msg_1",
      "msg_2",
      "msg_3",
      "msg_15",
    ])
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

  test("idle materialize keeps a live last turn omitted by a lagging snapshot", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "older")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "older-reply")] },
          { info: userMessage("msg_3"), parts: [textPart("p3", "msg_3", "just sent")] },
          { info: assistantMessage("msg_4"), parts: [textPart("p4", "msg_4", "just finished")] },
        ],
        { complete: true, turnCount: 2 },
      ),
    }).data!

    const { data, result } = mergeSessionTranscript(live, SESSION, {
      type: "http-page",
      purpose: "materialize",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "older")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "older-reply")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    })

    expect(result.applied).toBe(true)
    const flat = projectFlatFromTranscriptData(data, SESSION)
    expect(flat.messageOrder).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect((flat.partsByMessageID["msg_3"]?.[0] as { text?: string })?.text).toBe("just sent")
    expect((flat.partsByMessageID["msg_4"]?.[0] as { text?: string })?.text).toBe("just finished")
  })

  test("idle materialize does not wipe live parts when the snapshot returns empty shells", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "just finished")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const { data } = mergeSessionTranscript(live, SESSION, {
      type: "http-page",
      purpose: "materialize",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [] },
          { info: assistantMessage("msg_2"), parts: [] },
        ],
        { complete: true, turnCount: 1 },
      ),
    })

    const flat = projectFlatFromTranscriptData(data, SESSION)
    expect(flat.messageOrder).toEqual(["msg_1", "msg_2"])
    expect((flat.partsByMessageID["msg_1"]?.[0] as { text?: string })?.text).toBe("just sent")
    expect((flat.partsByMessageID["msg_2"]?.[0] as { text?: string })?.text).toBe("just finished")
  })

  test("idle materialize fills missing finish on a live last turn", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "just finished")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const { data, result } = mergeSessionTranscript(live, SESSION, {
      type: "http-page",
      purpose: "materialize",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          {
            info: {
              ...assistantMessage("msg_2"),
              finish: "stop",
              time: { created: 1, completed: 9 },
            } as Message,
            parts: [textPart("p2", "msg_2", "just finished")],
          },
        ],
        { complete: true, turnCount: 1 },
      ),
    })

    expect(result.applied).toBe(true)
    const flat = projectFlatFromTranscriptData(data, SESSION)
    const assistant = flat.messagesByID["msg_2"] as Message & {
      finish?: string
      time?: { created?: number; completed?: number }
    }
    expect(assistant?.finish).toBe("stop")
    expect(assistant?.time?.completed).toBe(9)
    expect((flat.partsByMessageID["msg_2"]?.[0] as { text?: string })?.text).toBe("just finished")
  })

  test("idle materialize does not strip live finish when the snapshot is still open", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          {
            info: {
              ...assistantMessage("msg_2"),
              finish: "stop",
              time: { created: 1, completed: 9 },
            } as Message,
            parts: [textPart("p2", "msg_2", "just finished")],
          },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!
    const liveAssistant = live.pages[0]!.messagesByID["msg_2"]

    const { data } = mergeSessionTranscript(live, SESSION, {
      type: "http-page",
      purpose: "materialize",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "just finished")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    })

    const flat = projectFlatFromTranscriptData(data, SESSION)
    expect(flat.messagesByID["msg_2"]).toBe(liveAssistant)
    expect((flat.messagesByID["msg_2"] as { finish?: string }).finish).toBe("stop")
  })

  test("shareSessionTranscriptData fills missing finish on a same-length settled tail", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "just finished")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const settled = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "just sent")] },
          {
            info: {
              ...assistantMessage("msg_2"),
              finish: "stop",
              time: { created: 1, completed: 9 },
            } as Message,
            parts: [textPart("p2", "msg_2", "just finished")],
          },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const shared = shareSessionTranscriptData(live, settled, SESSION)
    const flat = projectFlatFromTranscriptData(shared, SESSION)
    expect((flat.messagesByID["msg_2"] as { finish?: string }).finish).toBe("stop")
    expect((flat.messagesByID["msg_2"] as { time?: { completed?: number } }).time?.completed).toBe(9)
  })

  test("shareSessionTranscriptData keeps a live last turn on a same-length lagging tail", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "older")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "older-reply")] },
          { info: userMessage("msg_3"), parts: [textPart("p3", "msg_3", "just sent")] },
          { info: assistantMessage("msg_4"), parts: [textPart("p4", "msg_4", "just finished")] },
        ],
        { complete: true, turnCount: 2 },
      ),
    }).data!

    const lagging = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "older")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "older-reply")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const shared = shareSessionTranscriptData(live, lagging, SESSION)
    const flat = projectFlatFromTranscriptData(shared, SESSION)
    expect(flat.messageOrder).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    expect((flat.partsByMessageID["msg_3"]?.[0] as { text?: string })?.text).toBe("just sent")
    expect((flat.partsByMessageID["msg_4"]?.[0] as { text?: string })?.text).toBe("just finished")
  })

  test("shareSessionTranscriptData keeps a ref-stable remove-message subset", () => {
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "keep")] },
          { info: assistantMessage("msg_2"), parts: [textPart("p2", "msg_2", "gone")] },
          { info: userMessage("msg_3"), parts: [textPart("p3", "msg_3", "keep")] },
        ],
        { complete: true, turnCount: 2 },
      ),
    }).data!
    const removed = mergeSessionTranscript(live, SESSION, {
      type: "optimistic-remove",
      messageID: "msg_2",
    }).data!

    const shared = shareSessionTranscriptData(live, removed, SESSION)
    const flat = projectFlatFromTranscriptData(shared, SESSION)
    expect(flat.messageOrder).toEqual(["msg_1", "msg_3"])
    expect(flat.messagesByID.msg_2).toBeUndefined()
  })

  test("shareSessionTranscriptData keeps reconcile created-time order on a same-length superset", () => {
    const dated = (id: string, created: number, role: "user" | "assistant") => ({
      ...(role === "user" ? userMessage(id) : assistantMessage(id)),
      time: { created },
    } as Message)
    const initial = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: dated("msg_01", 1001, "user"), parts: [textPart("p01", "msg_01")] },
          { info: dated("msg_02", 1002, "assistant"), parts: [textPart("p02", "msg_02")] },
        ],
        { cursor: "cur_older", complete: false, turnCount: 1 },
      ),
    }).data!
    const newer = mergeSessionTranscript(initial, SESSION, {
      type: "http-page",
      purpose: "reconcile-page",
      page: page(
        [
          { info: dated("msg_07", 1007, "user"), parts: [textPart("p07", "msg_07")] },
          { info: dated("msg_08", 1008, "assistant"), parts: [textPart("p08", "msg_08")] },
        ],
        { complete: false, turnCount: 0 },
      ),
    }).data!
    const ordered = mergeSessionTranscript(newer, SESSION, {
      type: "http-page",
      purpose: "reconcile-page",
      page: page(
        [
          { info: dated("msg_03", 1003, "user"), parts: [textPart("p03", "msg_03")] },
          { info: dated("msg_04", 1004, "assistant"), parts: [textPart("p04", "msg_04")] },
        ],
        { complete: false, turnCount: 0 },
      ),
    }).data!

    const shared = shareSessionTranscriptData(newer, ordered, SESSION)
    expect(projectFlatFromTranscriptData(shared, SESSION).messageOrder).toEqual([
      "msg_01",
      "msg_02",
      "msg_03",
      "msg_04",
      "msg_07",
      "msg_08",
    ])
    expect(shared?.pages[0]?.cursor).toBe("cur_older")
  })

  test("shareSessionTranscriptData keeps a live last turn when Query collapses to one tail", () => {
    const tail = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_10"), parts: [textPart("p10", "msg_10", "recent")] },
          { info: assistantMessage("msg_11"), parts: [textPart("p11", "msg_11", "recent-reply")] },
          { info: userMessage("msg_12"), parts: [textPart("p12", "msg_12", "just sent")] },
          { info: assistantMessage("msg_13"), parts: [textPart("p13", "msg_13", "just finished")] },
        ],
        { cursor: "msg_10", complete: false, turnCount: 2 },
      ),
    }).data!

    const live = mergeSessionTranscript(tail, SESSION, {
      type: "http-page",
      purpose: "prepend",
      page: page(
        [{ info: userMessage("msg_01"), parts: [textPart("p01", "msg_01", "old")] }],
        { complete: true, turnCount: 1 },
      ),
    }).data!
    expect(live.pages.length).toBe(2)

    const collapsed = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page(
        [
          { info: userMessage("msg_10"), parts: [textPart("p10", "msg_10", "recent")] },
          { info: assistantMessage("msg_11"), parts: [textPart("p11", "msg_11", "recent-reply")] },
        ],
        { complete: true, turnCount: 1 },
      ),
    }).data!

    const shared = shareSessionTranscriptData(live, collapsed, SESSION)
    const flat = projectFlatFromTranscriptData(shared, SESSION)
    expect(flat.messageOrder).toContain("msg_12")
    expect(flat.messageOrder).toContain("msg_13")
    expect((flat.partsByMessageID["msg_12"]?.[0] as { text?: string })?.text).toBe("just sent")
    expect((flat.partsByMessageID["msg_13"]?.[0] as { text?: string })?.text).toBe("just finished")
  })

  test("durable-seed writes messages and parts with an unknown pagination boundary", () => {
    const { data, result } = mergeSessionTranscript(undefined, SESSION, {
      type: "durable-seed",
      records: [{ info: userMessage("msg_1"), parts: [textPart("p1", "msg_1", "cached")] }],
    })
    expect(result.applied).toBe(true)
    expect(result.changed).toBe(true)
    expect(data?.pages[0]?.messageOrder).toEqual(["msg_1"])
    expect((data?.pages[0]?.partsByMessageID.msg_1?.[0] as { text?: string })?.text).toBe("cached")
    expect(data?.pages[0]?.complete).toBe(false)
    expect(data?.pages[0]?.cursor).toBe(null)
    expect(boundaryFromTranscriptData(data)).toEqual({ kind: "unknown", loadedTurns: 0 })
  })

  test("authority slim does not replace a durable-seeded full part", () => {
    const info = {
      id: "msg_a",
      sessionID: SESSION,
      role: "assistant",
      time: { created: 2 },
      finish: "stop",
    } as Message
    const full = { id: "p_a", messageID: "msg_a", sessionID: SESSION, type: "text", text: "full body" } as Part
    const slim = { id: "p_a", messageID: "msg_a", sessionID: SESSION, type: "text", text: "summary", slim: true } as Part
    const seeded = mergeSessionTranscript(undefined, SESSION, {
      type: "durable-seed",
      records: [{ info, parts: [full] }],
    })
    const { data } = mergeSessionTranscript(seeded.data, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info, parts: [slim] }], { complete: true, turnCount: 1 }),
    })
    const part = data?.pages[0]?.partsByMessageID.msg_a?.[0] as { text?: string; slim?: boolean } | undefined
    expect(part?.text).toBe("full body")
    expect(part?.slim).not.toBe(true)
  })

  test("durable-seed overlays a slim file part with the exact url fill", () => {
    const info = {
      id: "msg_u",
      sessionID: SESSION,
      role: "user",
      time: { created: 1 },
    } as Message
    const slim = {
      id: "p_file",
      messageID: "msg_u",
      sessionID: SESSION,
      type: "file",
      mime: "image/png",
      filename: "shot.png",
      slim: true,
    } as unknown as Part
    const full = {
      ...slim,
      slim: false,
      url: "data:image/png;base64,full",
    } as unknown as Part
    const paged = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: page([{ info, parts: [slim] }], { complete: true, turnCount: 1 }),
    })
    const { data, result } = mergeSessionTranscript(paged.data, SESSION, {
      type: "durable-seed",
      records: [{ info, parts: [full] }],
    })
    expect(result.changed).toBe(true)
    const part = data?.pages[0]?.partsByMessageID.msg_u?.[0] as { url?: string; slim?: boolean } | undefined
    expect(part?.url).toBe("data:image/png;base64,full")
    expect(part?.slim).not.toBe(true)
  })
})
