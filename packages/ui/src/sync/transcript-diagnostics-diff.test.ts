import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import {
  captureTranscriptCanonicalSnapshot,
  diffTranscriptCanonicalSnapshots,
  snapshotTranscriptDiff,
} from "./transcript-diagnostics"
import type { TranscriptData } from "./transcript-repository"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

function textPart(id: string, options: { slim?: boolean; optimistic?: boolean } = {}): Part {
  return {
    id,
    type: "text",
    text: "SECRET BODY",
    ...(options.slim ? { slim: true } : {}),
    ...(options.optimistic ? { __openchamberOptimistic: true } : {}),
  } as unknown as Part
}

function message(id: string, role: "user" | "assistant" | "system", completed = 0): Message {
  return {
    id,
    role,
    sessionID: "ses_1",
    time: { created: 1, completed },
  } as unknown as Message
}

function transcript(input: {
  order: string[]
  messages?: Record<string, Message>
  parts?: Record<string, Part[]>
  liveRevision?: number
}): TranscriptData {
  return {
    sessionID: "ses_1",
    messageOrder: input.order,
    messagesByID: input.messages ?? {},
    partsByMessageID: input.parts ?? {},
    boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
    liveRevision: input.liveRevision ?? 0,
  }
}

describe("captureTranscriptCanonicalSnapshot", () => {
  test("extracts IDs, part counts, slim/full, optimistic, and role without bodies", () => {
    const snapshot = captureTranscriptCanonicalSnapshot(transcript({
      order: ["m1", "m2"],
      messages: {
        m1: message("m1", "user", 10),
        m2: message("m2", "assistant", 0),
      },
      parts: {
        m1: [textPart("p1", { optimistic: true }), textPart("p2")],
        m2: [textPart("p3", { slim: true }), textPart("p4"), textPart("p5", { slim: true })],
      },
      liveRevision: 7,
    }))
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain("SECRET BODY")
    expect(snapshot.messageIDs).toEqual(["m1", "m2"])
    expect(snapshot.boundaryKind).toBe("unknown")
    expect(snapshot.liveRevision).toBe(7)
    expect(snapshot.messages).toEqual([
      {
        id: "m1",
        partCount: 2,
        slimCount: 0,
        fullCount: 2,
        optimistic: true,
        completed: true,
        role: "user",
      },
      {
        id: "m2",
        partCount: 3,
        slimCount: 2,
        identityMissing: true,
        fullCount: 1,
        optimistic: false,
        completed: false,
        role: "assistant",
      },
    ])
  })
})

describe("diffTranscriptCanonicalSnapshots", () => {
  test("identifies added, removed, and partsChanged", () => {
    const before = captureTranscriptCanonicalSnapshot(transcript({
      order: ["keep", "gone"],
      messages: {
        keep: message("keep", "user", 1),
        gone: message("gone", "assistant", 1),
      },
      parts: {
        keep: [textPart("p1")],
        gone: [textPart("p2")],
      },
    }))
    const after = captureTranscriptCanonicalSnapshot(transcript({
      order: ["keep", "new"],
      messages: {
        keep: message("keep", "user", 1),
        new: message("new", "user", 1),
      },
      parts: {
        keep: [textPart("p1"), textPart("p1b")],
        new: [textPart("p3")],
      },
    }))
    const diff = diffTranscriptCanonicalSnapshots(before, after)
    expect(diff.addedMessageIDs).toEqual(["new"])
    expect(diff.removedMessageIDs).toEqual(["gone"])
    expect(diff.partsChanged).toEqual([
      {
        id: "keep",
        before: { partCount: 1, slimCount: 0, fullCount: 1, optimistic: false },
        after: { partCount: 2, slimCount: 0, fullCount: 2, optimistic: false },
      },
    ])
    expect(diff.downgraded).toEqual([])
    expect(diff.optimisticLost).toEqual([])
  })

  test("marks full parts overwritten by slim-only as downgraded", () => {
    const before = captureTranscriptCanonicalSnapshot(transcript({
      order: ["a1"],
      messages: { a1: message("a1", "assistant", 20) },
      parts: { a1: [textPart("tool-full"), textPart("reason-full")] },
    }))
    const after = captureTranscriptCanonicalSnapshot(transcript({
      order: ["a1"],
      messages: { a1: message("a1", "assistant", 20) },
      parts: { a1: [textPart("tool-full", { slim: true }), textPart("reason-full", { slim: true })] },
    }))
    const diff = diffTranscriptCanonicalSnapshots(before, after)
    expect(diff.downgraded).toEqual(["a1"])
    expect(diff.partsChanged).toHaveLength(1)
    expect(diff.partsChanged[0]?.after).toEqual({
      partCount: 2,
      slimCount: 2,
      fullCount: 0,
      optimistic: false,
    })
  })

  test("marks optimistic rows replaced by empty non-optimistic parts as optimisticLost", () => {
    const before = captureTranscriptCanonicalSnapshot(transcript({
      order: ["opt1"],
      messages: { opt1: message("opt1", "user", 0) },
      parts: { opt1: [textPart("p-opt", { optimistic: true })] },
    }))
    const after = captureTranscriptCanonicalSnapshot(transcript({
      order: ["opt1"],
      messages: { opt1: message("opt1", "user", 0) },
      parts: { opt1: [] },
    }))
    expect(before.messages[0]?.optimistic).toBe(true)
    expect(after.messages[0]?.optimistic).toBe(false)
    expect(after.messages[0]?.partCount).toBe(0)
    expect(after.messages[0]?.completed).toBe(false)
    const diff = diffTranscriptCanonicalSnapshots(before, after)
    expect(diff.optimisticLost).toEqual(["opt1"])
  })

  test("marks optimistic rows missing after reconcile as optimisticLost", () => {
    const before = captureTranscriptCanonicalSnapshot(transcript({
      order: ["opt1", "keep"],
      messages: {
        opt1: message("opt1", "user", 0),
        keep: message("keep", "assistant", 5),
      },
      parts: {
        opt1: [textPart("p-opt", { optimistic: true })],
        keep: [textPart("p-keep")],
      },
    }))
    const after = captureTranscriptCanonicalSnapshot(transcript({
      order: ["keep"],
      messages: { keep: message("keep", "assistant", 5) },
      parts: { keep: [textPart("p-keep")] },
    }))
    const diff = diffTranscriptCanonicalSnapshots(before, after)
    expect(diff.removedMessageIDs).toEqual(["opt1"])
    expect(diff.optimisticLost).toEqual(["opt1"])
  })

  test("does not mark a confirmed optimistic row as optimisticLost", () => {
    const before = captureTranscriptCanonicalSnapshot(transcript({
      order: ["opt1"],
      messages: { opt1: message("opt1", "user", 0) },
      parts: { opt1: [textPart("p-opt", { optimistic: true })] },
    }))
    const after = captureTranscriptCanonicalSnapshot(transcript({
      order: ["opt1"],
      messages: { opt1: message("opt1", "user", 99) },
      parts: { opt1: [textPart("p-opt")] },
    }))
    const diff = diffTranscriptCanonicalSnapshots(before, after)
    expect(diff.optimisticLost).toEqual([])
    expect(diff.partsChanged).toHaveLength(1)
  })
})

describe("snapshotTranscriptDiff", () => {
  test("builds a transcript-diff event with identities only", () => {
    const before = captureTranscriptCanonicalSnapshot(transcript({
      order: ["m1"],
      messages: { m1: message("m1", "user", 0) },
      parts: { m1: [textPart("p1", { optimistic: true })] },
    }))
    const after = captureTranscriptCanonicalSnapshot(transcript({
      order: [],
      messages: {},
      parts: {},
    }))
    const event = snapshotTranscriptDiff({
      trigger: "reconnect-compensation-reconcile",
      sessionID: "ses_1",
      directory: "/repo",
      before,
      after,
      now: () => 42,
    })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain("SECRET BODY")
    expect(event.kind).toBe("transcript-diff")
    expect(event.trigger).toBe("reconnect-compensation-reconcile")
    expect(event.at).toBe(42)
    expect(event.diff?.removedMessageIDs).toEqual(["m1"])
    expect(event.diff?.optimisticLost).toEqual(["m1"])
  })
})
