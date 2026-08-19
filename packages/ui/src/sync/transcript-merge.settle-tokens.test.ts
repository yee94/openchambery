/**
 * Regression coverage for the "assistant TPS missing after settle" bug.
 *
 * Event sequence captured from a real classic opencode 1.18.18 turn:
 * settle arrives as two `message.updated` ticks (finish+tokens, then
 * completed). Mid-turn HTTP snapshots (materialize / recovery / reconcile
 * upserts) always carry the all-zero `tokens` placeholder, so a late-landing
 * snapshot must not regress the settled token counts.
 */
import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { Event, Message, Part } from "@opencode-ai/sdk/v2/client"

import { mergeSessionTranscript, projectFlatFromTranscriptData } from "./transcript-merge"
import { createQueryTranscriptRepository } from "./transcript-repository-query-adapter"
import { computeAssistantTps } from "@/components/chat/message/assistantTps"

const SESSION = "ses_tps"
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

const transportPage = (records: Array<{ info: Message; parts?: Part[] }>) => ({
  records: records.map((record) => ({ info: record.info, parts: record.parts ?? [] })),
  complete: true,
  turnCount: 1,
})

describe("transcript settle token merge", () => {
  test("captured settle sequence yields TPS-renderable state", () => {
    // 1. Turn starts: initial page has user + streaming assistant (zero tokens).
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [textPart("p_1", "msg_a")] }]),
    }).data!

    // 2. Real event #4: finish + final tokens, NO completed yet.
    const withFinish = mergeSessionTranscript(live, SESSION, {
      type: "sse-event",
      event: messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
    })

    // 3. Real event #5: completed arrives, tokens still final.
    const settled = mergeSessionTranscript(withFinish.data!, SESSION, {
      type: "sse-event",
      event: messageUpdated({
        ...open,
        finish: "stop",
        tokens: { ...TOKENS_FINAL },
        time: { created: 2000, completed: 21000 },
      } as Message),
    })

    const flat = projectFlatFromTranscriptData(settled.data, SESSION)
    const info = flat.messagesByID.msg_a as Message & { tokens?: { output?: number; reasoning?: number } }

    // TPS inputs as MessageBody.tsx:2253-2280 would read them.
    const tokens = info.tokens
    const completedAt = (info.time as { completed?: number })?.completed
    const createdAt = (info.time as { created?: number })?.created

    const tps = computeAssistantTps({
      createdAt,
      completedAt,
      outputTokens: tokens?.output,
      reasoningTokens: tokens?.reasoning,
      parts: [],
    })

    expect(completedAt).toBe(21000)
    expect(tokens?.output ?? 0).toBeGreaterThan(0)
    expect(tps).not.toBe(null)
  })

  test("stale initial page racing between the two settle events keeps tokens", () => {
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [] }]),
    }).data!

    const withFinish = mergeSessionTranscript(live, SESSION, {
      type: "sse-event",
      event: messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
    }).data!

    // Stale HTTP page (fetched before finish) lands between the two events.
    const afterStalePage = mergeSessionTranscript(withFinish, SESSION, {
      type: "http-page",
      purpose: "recovery",
      page: transportPage([{ info: { ...userMsg("msg_u") }, parts: [] }, { info: open, parts: [] }]),
    })

    const settled = mergeSessionTranscript(afterStalePage.data!, SESSION, {
      type: "sse-event",
      event: messageUpdated({
        ...open,
        finish: "stop",
        tokens: { ...TOKENS_FINAL },
        time: { created: 2000, completed: 21000 },
      } as Message),
    })

    const info = projectFlatFromTranscriptData(settled.data, SESSION).messagesByID.msg_a as Message & {
      tokens?: { output?: number }
      time?: { completed?: number }
    }
    expect(info.time?.completed).toBe(21000)
    expect(info.tokens?.output).toBe(44)
  })

  test("late mid-turn page after both settle events must not blank tokens", () => {
    const open = assistantZero("msg_a")
    const live = mergeSessionTranscript(undefined, SESSION, {
      type: "http-page",
      purpose: "initial",
      page: transportPage([{ info: userMsg("msg_u"), parts: [] }, { info: open, parts: [] }]),
    }).data!

    const withFinish = mergeSessionTranscript(live, SESSION, {
      type: "sse-event",
      event: messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
    }).data!
    const settled = mergeSessionTranscript(withFinish, SESSION, {
      type: "sse-event",
      event: messageUpdated({
        ...open,
        finish: "stop",
        tokens: { ...TOKENS_FINAL },
        time: { created: 2000, completed: 21000 },
      } as Message),
    }).data!

    // A materialize/reconcile fetch that started mid-turn resolves AFTER the
    // settle events. Its snapshot still carries the zero-token assistant row.
    for (const purpose of ["recovery", "reconcile-page"] as const) {
      const afterLatePage = mergeSessionTranscript(settled, SESSION, {
        type: "http-page",
        purpose,
        page: transportPage([
          { info: userMsg("msg_u"), parts: [] },
          { info: open, parts: [textPart("p_1", "msg_a")] },
        ]),
      })
      const info = projectFlatFromTranscriptData(afterLatePage.data, SESSION).messagesByID.msg_a as Message & {
        tokens?: { output?: number; reasoning?: number }
        time?: { completed?: number }
        finish?: string
      }
      expect(`${purpose}:${info.time?.completed ?? null}`).toBe(`${purpose}:21000`)
      expect(`${purpose}:${info.finish ?? null}`).toBe(`${purpose}:stop`)
      expect(`${purpose}:${info.tokens?.output ?? 0}`).toBe(`${purpose}:44`)
    }
  })
})

describe("production query adapter settle replay", () => {
  const TRANSPORT = "browser" as const
  const GENERATION = 1
  const scope = { directory: DIRECTORY, sessionID: SESSION, transport: TRANSPORT, generation: GENERATION }

  test("captured settle sequence through createQueryTranscriptRepository", () => {
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

    // Captured event #4: finish + final tokens, no completed.
    const finishResult = repo.apply(scope, {
      type: "sse-event",
      event: messageUpdated({ ...open, finish: "stop", tokens: { ...TOKENS_FINAL } } as Message),
    })
    expect(finishResult.changed).toBe(true)

    // Captured event #5: completed arrives, tokens still final.
    const settleResult = repo.apply(scope, {
      type: "sse-event",
      event: messageUpdated({
        ...open,
        finish: "stop",
        tokens: { ...TOKENS_FINAL },
        time: { created: 2000, completed: 21000 },
      } as Message),
    })
    expect(settleResult.changed).toBe(true)
    expect(notifyCount).toBeGreaterThanOrEqual(2)

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
