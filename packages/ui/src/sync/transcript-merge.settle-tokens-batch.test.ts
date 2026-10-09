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
import type { Message, Part } from "@/lib/opencode/v2-types"
import type { Event } from "@/sync/types"

import { mergeSessionTranscript, projectFlatFromTranscriptData } from "./transcript-merge"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { computeAssistantTps } from "@/components/chat/message/assistantTps"
import { normalizeOpenCodeEvent, toLegacyEventShape } from "./opencode-event-normalizer"
import { projectTurnRecords } from "@/components/chat/lib/turns/projectTurnRecords"

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
    | (Message & { tokens?: { output?: number; reasoning?: number }; time?: { created?: number; streamed?: number } })
    | undefined
  if (!info) return { info: null, tps: null }
  const tps = computeAssistantTps([{
    createdAt: info.time?.created,
    streamedAt: info.time?.streamed,
    outputTokens: info.tokens?.output,
    reasoningTokens: info.tokens?.reasoning,
  }])
  return { info, tps }
}

describe("settle tokens through sse-event-batch (mergeSessionTranscript)", () => {
  test("idle materialization repairs a missed streamed event on an otherwise settled step", () => {
    const settled = {
      ...assistantZero("msg_a"), finish: "stop", tokens: TOKENS_FINAL,
      time: { created: 2000, completed: 21000 },
    } as Message
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page", purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u") }, { info: settled }]),
    }).data
    const repaired = mergeSessionTranscript(live, SESSION, {
      type: "http-page", purpose: "materialize",
      page: transportPage([{ info: { ...settled, time: { ...settled.time, streamed: 20000 } } }]),
    }).data
    const { info, tps } = readTpsInputs(projectFlatFromTranscriptData(repaired, SESSION))
    expect(info?.time.streamed).toBe(20000)
    expect(tps).toBeCloseTo(142 / 18)
  })

  test("native streamed clock survives separate production batches", () => {
    let data = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page", purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u") }]),
    }).data
    for (const [type, created, fields] of [
      ["session.step.started", 2000, {}],
      ["session.step.streamed", 20000, {}],
      ["session.step.ended", 21000, { finish: "stop", tokens: TOKENS_FINAL }],
    ] as const) {
      const normalized = normalizeOpenCodeEvent({
        id: `evt_${created}`, type, created,
        location: { directory: DIRECTORY },
        durable: { aggregateID: `session:${SESSION}`, seq: created, version: 1 },
        data: { sessionID: SESSION, assistantMessageID: "msg_a", ...fields },
      })
      expect(normalized.action).toBe("emit")
      if (normalized.action !== "emit") throw new Error("Missing lifecycle event")
      data = mergeSessionTranscript(data, SESSION, {
        type: "sse-event-batch", events: [toLegacyEventShape(normalized.event) as Event],
      }).data
    }
    const { info, tps } = readTpsInputs(projectFlatFromTranscriptData(data, SESSION))
    expect(info?.time.streamed).toBe(20000)
    expect(tps).toBeCloseTo(142 / 18)
  })

  test("materialization preserves an existing live streamed clock", () => {
    const settled = {
      ...assistantZero("msg_a"), finish: "stop", tokens: TOKENS_FINAL,
      time: { created: 2000, streamed: 20000, completed: 21000 },
    } as Message
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page", purpose: "initial", page: transportPage([{ info: settled }]),
    }).data
    const after = mergeSessionTranscript(live, SESSION, {
      type: "http-page", purpose: "materialize",
      page: transportPage([{ info: { ...settled, time: { ...settled.time, streamed: 19000 } } }]),
    }).data
    expect(projectFlatFromTranscriptData(after, SESSION).messagesByID.msg_a).toBe(
      projectFlatFromTranscriptData(live, SESSION).messagesByID.msg_a,
    )
  })

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
          time: { created: 2000, streamed: 20000, completed: 21000 },
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
          time: { created: 2000, streamed: 20000, completed: 21000 },
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
          time: { created: 2000, streamed: 20000, completed: 21000 },
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
          time: { created: 2000, streamed: 20000, completed: 21000 },
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

  test("missing timing recovers on both sides of an aborted turn without contaminating later turns", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createQueryTranscriptRepository({ client, transport: TRANSPORT, generation: GENERATION })
    const users = [0, 1, 2].map((index) => ({
      ...userMsg(`msg_u${index}`), time: { created: index * 30000 + 1000 },
    }))
    const assistants = [0, 1, 2].map((index) => ({
      ...assistantZero(`msg_a${index}`),
      time: { created: index * 30000 + 2000, completed: index * 30000 + 21000 },
      finish: index === 1 ? "error" : "stop",
      tokens: index === 1 ? TOKENS_ZERO : TOKENS_FINAL,
      ...(index === 1 ? { error: { type: "aborted", message: "aborted" } } : {}),
    }) as Message)
    const records = users.flatMap((info, index) => [
      { info, parts: [] }, { info: assistants[index], parts: [textPart(`p_${index}`, assistants[index].id)] },
    ])
    repo.apply(scope, { type: "http-page", purpose: "initial", page: transportPage(records) })
    const before = repo.getTranscript(scope)
    let notifications = 0
    const unsubscribe = repo.subscribe(scope, () => { notifications += 1 })
    const authority = records.map((record) => record.info.role === "assistant" && record.info.finish === "stop"
      ? { ...record, info: { ...record.info, time: { ...record.info.time, streamed: record.info.time.created + 18000 } } }
      : record)
    repo.apply(scope, { type: "http-page", purpose: "materialize", page: transportPage(authority) })
    const after = repo.getTranscript(scope)
    const turns = projectTurnRecords(after.messageOrder.map((id) => ({
      info: after.messagesByID[id], parts: [...(after.partsByMessageID[id] ?? [])],
    }))).turns
    expect(turns).toHaveLength(3)
    const rates = turns.map((turn) => computeAssistantTps(turn.assistantMessages.map(({ info }) => ({
      createdAt: info.time.created, streamedAt: info.time.streamed,
      outputTokens: info.tokens?.output, reasoningTokens: info.tokens?.reasoning,
    }))))
    expect(rates[0]).toBeCloseTo(142 / 18)
    expect(rates[1]).toBeNull()
    expect(rates[2]).toBeCloseTo(142 / 18)
    expect(after.messagesByID.msg_a1).toBe(before.messagesByID.msg_a1)
    expect(notifications).toBeGreaterThan(0)
    repo.apply(scope, { type: "http-page", purpose: "materialize", page: transportPage(authority) })
    expect(repo.getMessage(scope, "msg_a0")).toBe(after.messagesByID.msg_a0)
    unsubscribe()
    repo.destroy()
    client.clear()
  })

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
          time: { created: 2000, streamed: 20000, completed: 21000 },
        } as Message),
      ],
    })
    expect(settleResult.changed).toBe(true)
    expect(notifyCount).toBeGreaterThanOrEqual(1)

    const info = repo.getMessage(scope, "msg_a") as Message & {
      tokens?: { output?: number; reasoning?: number }
      time?: { created?: number; streamed?: number; completed?: number }
    }
    expect(info.time?.completed).toBe(21000)
    expect(info.tokens?.output).toBe(44)

    const tps = computeAssistantTps([{
      createdAt: info.time?.created,
      streamedAt: info.time?.streamed,
      outputTokens: info.tokens?.output,
      reasoningTokens: info.tokens?.reasoning,
    }])
    expect(tps).not.toBe(null)

    unsub()
    repo.destroy()
  })
})
