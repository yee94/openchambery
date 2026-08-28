import { describe, expect, test } from "vitest"
import type { Part } from "@opencode-ai/sdk/v2/client"

import { createTaskDispatchEdgesReader, readTaskDispatchEdgesFromTranscript } from "../sync-context"
import { EMPTY_TASK_DISPATCH_EDGES } from "../scoped-blocking-requests"

const taskPart = (parentSessionId: string, sessionId: string, status = "running"): Part => ({
  type: "tool",
  tool: "task",
  state: { status, metadata: { parentSessionId, sessionId } },
} as unknown as Part)

describe("readTaskDispatchEdgesFromTranscript", () => {
  test("reads running task dispatch edges across the transcript", () => {
    const edges = readTaskDispatchEdgesFromTranscript({
      messageOrder: ["msg_1", "msg_2", "msg_3"],
      partsByMessageID: {
        msg_1: [taskPart("ses_fork", "ses_fixer")],
        msg_2: [taskPart("ses_fork", "ses_stale", "completed")],
        msg_3: [taskPart("ses_fork", "ses_second")],
      },
    })

    expect(edges).toEqual([
      { parentSessionId: "ses_fork", sessionId: "ses_fixer" },
      { parentSessionId: "ses_fork", sessionId: "ses_second" },
    ])
  })

  test("terminal tasks contribute no edge", () => {
    const edges = readTaskDispatchEdgesFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [taskPart("ses_fork", "ses_done", "completed")],
      },
    })

    expect(edges).toBe(EMPTY_TASK_DISPATCH_EDGES)
  })

  test("returns the shared empty edges for empty or missing transcripts", () => {
    expect(readTaskDispatchEdgesFromTranscript(null)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(readTaskDispatchEdgesFromTranscript(undefined)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(readTaskDispatchEdgesFromTranscript({ messageOrder: [], partsByMessageID: {} })).toBe(
      EMPTY_TASK_DISPATCH_EDGES,
    )
    expect(
      readTaskDispatchEdgesFromTranscript({ messageOrder: ["msg_missing"], partsByMessageID: {} }),
    ).toBe(EMPTY_TASK_DISPATCH_EDGES)
  })

  test("ignores non-task tool parts without failing", () => {
    const edges = readTaskDispatchEdgesFromTranscript({
      messageOrder: ["msg_1"],
      partsByMessageID: {
        msg_1: [
          { type: "text", text: "hi" } as unknown as Part,
          { type: "tool", tool: "bash", state: { status: "running" } } as unknown as Part,
          taskPart("ses_fork", "ses_fixer"),
        ],
      },
    })

    expect(edges).toEqual([{ parentSessionId: "ses_fork", sessionId: "ses_fixer" }])
  })
})

describe("createTaskDispatchEdgesReader (getSnapshot stability contract)", () => {
  const transcript = {
    messageOrder: ["msg_1"],
    partsByMessageID: { msg_1: [taskPart("ses_fork", "ses_fixer")] },
  }

  test("returns the same reference for repeated reads of an unchanged transcript", () => {
    const reader = createTaskDispatchEdgesReader()

    const first = reader(transcript)
    const second = reader(transcript)
    const third = reader(transcript)

    // useSyncExternalStore requires reference stability while data is
    // unchanged — a fresh array each read loops renders into a crash.
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(first).toEqual([{ parentSessionId: "ses_fork", sessionId: "ses_fixer" }])
  })

  test("returns the shared empty edges reference when there are no edges", () => {
    const quiet = { messageOrder: ["msg_1"], partsByMessageID: { msg_1: [] } }
    const reader = createTaskDispatchEdgesReader()

    expect(reader(quiet)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(reader(quiet)).toBe(EMPTY_TASK_DISPATCH_EDGES)
    expect(reader(undefined)).toBe(EMPTY_TASK_DISPATCH_EDGES)
  })

  test("recomputes when the transcript reference changes", () => {
    const reader = createTaskDispatchEdgesReader()
    const first = reader(transcript)

    const updated = {
      messageOrder: ["msg_1", "msg_2"],
      partsByMessageID: {
        msg_1: [taskPart("ses_fork", "ses_fixer")],
        msg_2: [taskPart("ses_fork", "ses_second")],
      },
    }
    const second = reader(updated)

    expect(second).not.toBe(first)
    expect(second).toEqual([
      { parentSessionId: "ses_fork", sessionId: "ses_fixer" },
      { parentSessionId: "ses_fork", sessionId: "ses_second" },
    ])
  })

  test("keeps a stable reference across equal-content transcripts rebuilt with new references", () => {
    // Store-adapter fallback rebuilds TranscriptData on every read; the
    // reader must still return the same edges reference when the extracted
    // edges are semantically unchanged.
    const reader = createTaskDispatchEdgesReader()

    const first = reader(transcript)
    const rebuilt = {
      messageOrder: [...transcript.messageOrder],
      partsByMessageID: { msg_1: [...transcript.partsByMessageID.msg_1] },
    }
    const second = reader(rebuilt)

    expect(second).toBe(first)
  })
})
