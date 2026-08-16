import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import {
  fetchExactSessionMessageRecord,
  findMissingAssistantParentUserIDs,
  loadSessionMessage,
  MAX_ASSISTANT_TAIL_PARENT_LOADS,
  recoverAssistantTailBoundary,
  transcriptExactMessageRuntimeKey,
} from "./transcript-parent-recovery"

const record = (id: string, role: "user" | "assistant", parentID?: string) => ({
  info: { id, role, parentID } as Message & { role: string; parentID?: string },
  parts: [] as Part[],
})

describe("assistant-tail parent recovery", () => {
  test("recovers missing user parents for an assistant-only tail", async () => {
    const recovered = await recoverAssistantTailBoundary({
      records: [record("assistant", "assistant", "user")],
      complete: false,
      requestMessage: async (messageID) => record(messageID, "user"),
    })

    expect(recovered.records.map((item) => item.info.id)).toEqual(["assistant", "user"])
    expect(recovered.boundaryFound).toBe(true)
    expect(recovered.partial).toBe(false)
  })

  test("recovers orphan assistant parents even when a newer user turn is already present", async () => {
    const requested: string[] = []
    const recovered = await recoverAssistantTailBoundary({
      records: [
        record("assistant-old", "assistant", "user-old"),
        record("assistant-old-2", "assistant", "user-old"),
        record("user-new", "user"),
        record("assistant-new", "assistant", "user-new"),
      ],
      complete: false,
      requestMessage: async (messageID) => {
        requested.push(messageID)
        return record(messageID, "user")
      },
    })

    expect(requested).toEqual(["user-old"])
    expect(recovered.records.map((item) => item.info.id)).toEqual([
      "assistant-new",
      "assistant-old",
      "assistant-old-2",
      "user-new",
      "user-old",
    ])
    expect(recovered.boundaryFound).toBe(true)
    expect(recovered.partial).toBe(false)
  })

  test("skips parent recovery when every assistant parent is already on the page", async () => {
    let calls = 0
    const recovered = await recoverAssistantTailBoundary({
      records: [
        record("user", "user"),
        record("assistant", "assistant", "user"),
      ],
      complete: false,
      requestMessage: async (messageID) => {
        calls += 1
        return record(messageID, "user")
      },
    })
    expect(calls).toBe(0)
    expect(recovered.boundaryFound).toBe(true)
    expect(recovered.partial).toBe(false)
  })

  test("keeps complete pages free of parent requests", async () => {
    let calls = 0
    await recoverAssistantTailBoundary({
      records: [record("assistant", "assistant", "missing")],
      complete: true,
      requestMessage: async (messageID) => {
        calls += 1
        return record(messageID, "user")
      },
    })
    expect(calls).toBe(0)
  })

  test("deduplicates parent IDs and caps exact parent requests", () => {
    const records = Array.from({ length: MAX_ASSISTANT_TAIL_PARENT_LOADS + 3 }, (_, index) =>
      record(`assistant-${index}`, "assistant", `user-${index}`),
    )
    records.push(record("assistant-duplicate", "assistant", "user-0"))
    records.push(record("user-new", "user"))
    expect(findMissingAssistantParentUserIDs(records)).toEqual(
      Array.from({ length: MAX_ASSISTANT_TAIL_PARENT_LOADS }, (_, index) => `user-${index}`),
    )
  })

  test("clears a failed parent request for retry", async () => {
    let calls = 0
    const input = {
      runtimeKey: "runtime-a",
      directory: "/repo",
      sessionID: "ses_1",
      messageID: "msg_1",
      request: async () => {
        calls += 1
        if (calls === 1) throw new Error("not ready")
        return "recovered"
      },
    }
    await expect(loadSessionMessage(input)).rejects.toThrow("not ready")
    expect(await loadSessionMessage(input)).toBe("recovered")
    expect(calls).toBe(2)
  })
})

describe("exact session.message helper", () => {
  test("shares one request for the same transport + generation", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const request = () => fetchExactSessionMessageRecord({
      transport: "runtime-a",
      generation: 1,
      directory: "/repo",
      sessionID: "ses_1",
      messageID: "msg_1",
      request: async () => {
        calls += 1
        await gate
        return { data: { info: { id: "msg_1" } as Message, parts: [] } }
      },
    })
    const first = request()
    const second = request()
    release()
    const [a, b] = await Promise.all([first, second])
    expect(calls).toBe(1)
    expect(a.info.id).toBe("msg_1")
    expect(b.info.id).toBe("msg_1")
  })

  test("does not share flights across generations", async () => {
    let calls = 0
    await Promise.all([
      fetchExactSessionMessageRecord({
        transport: "runtime-a",
        generation: 1,
        directory: "/repo",
        sessionID: "ses_1",
        messageID: "msg_1",
        request: async () => {
          calls += 1
          return { data: { info: { id: "msg_1" } as Message, parts: [] } }
        },
      }),
      fetchExactSessionMessageRecord({
        transport: "runtime-a",
        generation: 2,
        directory: "/repo",
        sessionID: "ses_1",
        messageID: "msg_1",
        request: async () => {
          calls += 1
          return { data: { info: { id: "msg_1" } as Message, parts: [] } }
        },
      }),
    ])
    expect(calls).toBe(2)
    expect(transcriptExactMessageRuntimeKey("runtime-a", 1)).not.toBe(
      transcriptExactMessageRuntimeKey("runtime-a", 2),
    )
  })

  test("rejects an error envelope so the flight can retry", async () => {
    let calls = 0
    const input = {
      transport: "runtime-a",
      generation: 1,
      directory: "/repo",
      sessionID: "ses_1",
      messageID: "msg_err",
      request: async () => {
        calls += 1
        if (calls === 1) return { error: { message: "unavailable" } }
        return { data: { info: { id: "msg_err" } as Message, parts: [] } }
      },
    }
    await expect(fetchExactSessionMessageRecord(input)).rejects.toThrow("session.message failed")
    expect((await fetchExactSessionMessageRecord(input)).info.id).toBe("msg_err")
    expect(calls).toBe(2)
  })
})
