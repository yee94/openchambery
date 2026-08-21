/**
 * Diagnostic reproduction for "assistant TPS missing after settle" through the
 * PRODUCTION batch path (`sse-event-batch`), which the sequential settle-tokens
 * regression test does not cover.
 *
 * Frame splits mirror realistic event-pipeline flush frames (33ms):
 * 1. both settle ticks in one batch
 * 2. settle ticks split across two batches
 * 3. settle ticks split with a stale mid-turn HTTP page landing in between
 * 4. full streaming sequence (initial page -> part stream batch -> settle batch)
 */
import { describe, expect, test } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import { mergeSessionTranscript, projectFlatFromTranscriptData } from "./transcript-merge"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { computeAssistantTps } from "@/components/chat/message/assistantTps"

const SESSION = "ses_tps_batch"
const DIRECTORY = "/workspace"

const TOKENS_FINAL = { input: 24047, output: 44, reasoning: 98, cache: { read: 0, write: 0 } }
const TOKENS_ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const userMsg = (id: string): Message =>
  ({ id, sessionID: SESSION, role: "user", time: { created: 1000 } }) as Message

const assistantZero = (id: string): Message =>
  ({
    id,
    sessionID: SESSION,
    role: "assistant",
    agent: "build",
    providerID: "p",
    modelID: "m",
    tokens: { ...TOKENS_ZERO },
    time: { created: 2000 },
  }) as Message

const textPart = (id: string, messageID: string): Part =>
  ({ id, messageID, sessionID: SESSION, type: "text", text: "hello" }) as Part

const messageUpdated = (info: Message): Event =>
  ({ type: "message.updated", properties: { info } }) as Event

const partUpdated = (part: Part): Event =>
  ({ type: "message.part.updated", properties: { sessionID: SESSION, part } }) as Event

const transportPage = (records: Array<{ info: Message; parts?: Part[] }>) => ({
  records: records.map((record) => ({ info: record.info, parts: record.parts ?? [] })),
  complete: true,
  turnCount: 1,
})

const readTpsInputs = (data: ReturnType<typeof projectFlatFromTranscriptData> | undefined) => {
  const info = data?.messagesByID.msg_a as
    | (Message & { tokens?: { output?: number; reasoning?: number }; time?: { created?: number; completed?: number } })
    | undefined
  if (!info) return { info: null, tps: null }
  const tps = computeAssistantTps({
    createdAt: info.time?.created,
    completedAt: info.time?.completed,
    outputTokens: info.tokens?.output,
    reasoningTokens: info.tokens?.reasoning,
    parts: [],
  })
  return { info, tps }
}

describe("settle tokens through sse-event-batch (mergeSessionTranscript)", () => {
  test("both settle ticks in one batch", () => {
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [textPart("p_1", "msg_a")] }]),
    }).data!

    const settled = mergeSessionTranscript(live, SESSION, {
      type: "sse-event-batch",
      events: [
        messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
        messageUpdated({
          ...open,
          finish: "stop",
          tokens: { ...TOKENS_FINAL },
          time: { created: 2000, completed: 21000 },
        } as Message),
      ],
    })

    const { info, tps } = readTpsInputs(projectFlatFromTranscriptData(settled.data, SESSION))
    expect(info?.time?.completed).toBe(21000)
    expect(info?.tokens?.output).toBe(44)
    expect(tps).not.toBe(null)
  })

  test("settle ticks split across two batches", () => {
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [textPart("p_1", "msg_a")] }]),
    }).data!

    const withFinish = mergeSessionTranscript(live, SESSION, {
      type: "sse-event-batch",
      events: [messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message)],
    }).data!

    const settled = mergeSessionTranscript(withFinish, SESSION, {
      type: "sse-event-batch",
      events: [
        messageUpdated({
          ...open,
          finish: "stop",
          tokens: { ...TOKENS_FINAL },
          time: { created: 2000, completed: 21000 },
        } as Message),
      ],
    })

    const { info, tps } = readTpsInputs(projectFlatFromTranscriptData(settled.data, SESSION))
    expect(info?.time?.completed).toBe(21000)
    expect(info?.tokens?.output).toBe(44)
    expect(tps).not.toBe(null)
  })

  test("stale mid-turn HTTP page lands between the two settle batches", () => {
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [] }]),
    }).data!

    const withFinish = mergeSessionTranscript(live, SESSION, {
      type: "sse-event-batch",
      events: [messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message)],
    }).data!

    const afterStalePage = mergeSessionTranscript(withFinish, SESSION, {
      type: "http-page",
      purpose: "recovery",
      page: transportPage([{ info: { ...userMsg("msg_u") }, parts: [] }, { info: open, parts: [] }]),
    }).data!

    const settled = mergeSessionTranscript(afterStalePage, SESSION, {
      type: "sse-event-batch",
      events: [
        messageUpdated({
          ...open,
          finish: "stop",
          tokens: { ...TOKENS_FINAL },
          time: { created: 2000, completed: 21000 },
        } as Message),
      ],
    })

    const { info, tps } = readTpsInputs(projectFlatFromTranscriptData(settled.data, SESSION))
    expect(info?.time?.completed).toBe(21000)
    expect(info?.tokens?.output).toBe(44)
    expect(tps).not.toBe(null)
  })

  test("full streaming sequence: initial page -> part stream batch -> settle batch", () => {
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [] }]),
    }).data!

    const streamed = mergeSessionTranscript(live, SESSION, {
      type: "sse-event-batch",
      events: [
        partUpdated(textPart("p_1", "msg_a")),
        { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_a", partID: "p_1", field: "text", delta: "hello" } } as unknown as Event,
        messageUpdated({ ...open, tokens: { ...TOKENS_ZERO } } as Message),
      ],
    }).data!

    const settled = mergeSessionTranscript(streamed, SESSION, {
      type: "sse-event-batch",
      events: [
        messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
        messageUpdated({
          ...open,
          finish: "stop",
          tokens: { ...TOKENS_FINAL },
          time: { created: 2000, completed: 21000 },
        } as Message),
      ],
    })

    const { info, tps } = readTpsInputs(projectFlatFromTranscriptData(settled.data, SESSION))
    expect(info?.time?.completed).toBe(21000)
    expect(info?.tokens?.output).toBe(44)
    expect(tps).not.toBe(null)
  })
})

describe("settle tokens through production query adapter with sse-event-batch", () => {
  const TRANSPORT = "browser" as const
  const GENERATION = 1
  const scope = { directory: DIRECTORY, sessionID: SESSION, transport: TRANSPORT, generation: GENERATION }

  test("captured settle sequence batched through createQueryTranscriptRepository", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 } } })
    const repo = createQueryTranscriptRepository({ client, transport: TRANSPORT, generation: GENERATION })

    let notifyCount = 0
    const unsub = repo.subscribe(scope, () => { notifyCount += 1 })

    const open = assistantZero("msg_a")
    const applied = repo.apply(scope, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([
        { info: userMsg("msg_u"), parts: [] },
        { info: open, parts: [textPart("p_1", "msg_a")] },
      ]),
    })
    expect(applied.applied).toBe(true)

    // Settle frame: both ticks in one production batch command.
    const settleResult = repo.apply(scope, {
      type: "sse-event-batch",
      events: [
        messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
        messageUpdated({
          ...open,
          finish: "stop",
          tokens: { ...TOKENS_FINAL },
          time: { created: 2000, completed: 21000 },
        } as Message),
      ],
    })
    expect(settleResult.changed).toBe(true)
    expect(notifyCount).toBeGreaterThanOrEqual(1)

    const info = repo.getMessage(scope, "msg_a") as Message & {
      tokens?: { output?: number; reasoning?: number }
      time?: { created?: number; completed?: number }
    }
    expect(info.time?.completed).toBe(21000)
    expect(info.tokens?.output).toBe(44)

    const tps = computeAssistantTps({
      createdAt: info.time?.created,
      completedAt: info.time?.completed,
      outputTokens: info.tokens?.output,
      reasoningTokens: info.tokens?.reasoning,
      parts: repo.getParts(scope, "msg_a") as Part[],
    })
    expect(tps).not.toBe(null)

    unsub()
    repo.destroy()
  })
})
