/**
 * Official v2 step lifecycle: real envelope → normalizer → transcript reducer
 * → turn projection; GET projection keeps usage for TPS.
 *
 * Field shapes match `@opencode/client@0.0.0-next-17444` SessionStep* /
 * SessionMessageAssistant (no guessed properties).
 */
import { describe, expect, test } from "vitest"
import type { Message, Part } from "@/lib/opencode/v2-types"
import type { Event } from "@/sync/types"

import { projectTurnRecords } from "../components/chat/lib/turns/projectTurnRecords"
import { applyDirectoryEvent } from "./event-reducer"
import { normalizeOpenCodeEvent, toLegacyEventShape } from "./opencode-event-normalizer"
import {
  normalizeSessionProjectionMessage,
  normalizeSessionProjectionPage,
} from "./session-projection-api"
import { applyTranscriptDirectoryEvent, type TranscriptEventDraft } from "./transcript-event-reducer"
import { isTranscriptSseEventType } from "./transcript-repository"
import { INITIAL_STATE, type State } from "./types"

const SESSION = "ses_step"
const DIRECTORY = "/repo"
const USER_CREATED = 1_700_000_000_100
const STEP_STARTED_AT = 1_700_000_000_200
const STEP_ENDED_AT = 1_700_000_000_500
const TOKENS = {
  input: 12,
  output: 44,
  reasoning: 3,
  cache: { read: 1, write: 0 },
} as const

const userMessage = (id: string, created = USER_CREATED): Message =>
  ({ id, sessionID: SESSION, role: "user", time: { created } }) as Message

const textPart = (messageID: string, text: string): Part =>
  ({
    id: `${messageID}:text:0`,
    messageID,
    sessionID: SESSION,
    type: "text",
    text,
  }) as Part

function draft(messages: Message[] = [], parts: Record<string, Part[]> = {}): TranscriptEventDraft {
  return { message: { [SESSION]: messages }, part: parts }
}

function directory(): State {
  return { ...INITIAL_STATE, session_status: {}, session_status_observed_at: {} }
}

/** Official durable envelope shape from @opencode/client. */
function officialEnvelope(
  type: string,
  data: Record<string, unknown>,
  created: number,
): Record<string, unknown> {
  return {
    id: `evt_${type.replace(/\./g, "_")}`,
    created,
    type,
    durable: {
      aggregateID: `session:${SESSION}`,
      seq: created,
      version: 1 as const,
    },
    location: { directory: DIRECTORY },
    data,
  }
}

function reduceNormalized(raw: unknown, state: TranscriptEventDraft = draft()): TranscriptEventDraft {
  const normalized = normalizeOpenCodeEvent(raw)
  expect(normalized.action).toBe("emit")
  if (normalized.action !== "emit") return state
  const event = toLegacyEventShape(normalized.event) as Event
  expect(applyTranscriptDirectoryEvent(state, event)).not.toBe(false)
  return state
}

describe("official session.step lifecycle (envelope → normalizer → reducer)", () => {
  test("normalizer keeps session.step.* and stamps eventCreated from envelope", () => {
    const started = normalizeOpenCodeEvent(officialEnvelope("session.step.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { id: "gpt-4.1", providerID: "openai", variant: "high" },
    }, STEP_STARTED_AT))
    expect(started.action).toBe("emit")
    if (started.action !== "emit") return
    expect(started.event.type).toBe("session.step.started")
    expect(started.event.properties.eventCreated).toBe(STEP_STARTED_AT)
    expect(started.event.domainActivityHint).toEqual({ sessionID: SESSION, kind: "activity" })
    expect(started.event.locationDirectory).toBe(DIRECTORY)

    const ended = normalizeOpenCodeEvent(officialEnvelope("session.step.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      finish: "stop",
      cost: 0.0021,
      tokens: { ...TOKENS },
    }, STEP_ENDED_AT))
    expect(ended.action).toBe("emit")
    if (ended.action !== "emit") return
    expect(ended.event.domainActivityHint).toEqual({ sessionID: SESSION, kind: "terminal" })
    expect(ended.event.properties.finish).toBe("stop")
    expect(ended.event.properties.tokens).toEqual(TOKENS)

    const failed = normalizeOpenCodeEvent(officialEnvelope("session.step.failed", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      error: { type: "ProviderError", message: "rate limited" },
      cost: 0.0001,
      tokens: { input: 2, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }, STEP_ENDED_AT + 1))
    expect(failed.action).toBe("emit")
    if (failed.action !== "emit") return
    expect(failed.event.domainActivityHint).toEqual({ sessionID: SESSION, kind: "terminal" })
  })

  test("step types are transcript SSE whitelist members", () => {
    expect(isTranscriptSseEventType("session.step.started")).toBe(true)
    expect(isTranscriptSseEventType("session.step.ended")).toBe(true)
    expect(isTranscriptSseEventType("session.step.failed")).toBe(true)
  })

  test("step.started bootstraps live assistant with envelope time + identity (not created:0)", () => {
    const state = draft([userMessage("msg_u")])
    reduceNormalized(officialEnvelope("session.step.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { id: "gpt-4.1", providerID: "openai", variant: "high" },
    }, STEP_STARTED_AT), state)

    const assistant = state.message[SESSION]?.find((message) => message.id === "msg_a")
    expect(assistant).toBeTruthy()
    expect(assistant?.time.created).toBe(STEP_STARTED_AT)
    expect(assistant?.time.created).toBeGreaterThan(0)
    expect(assistant?.agent).toBe("build")
    expect(assistant?.modelID).toBe("gpt-4.1")
    expect(assistant?.providerID).toBe("openai")
    expect(assistant?.variant).toBe("high")
    expect(assistant?.model).toEqual({
      modelID: "gpt-4.1",
      providerID: "openai",
      variant: "high",
    })
  })

  test("step.ended stamps finish/cost/tokens for TPS; failed stamps error", () => {
    const state = draft([userMessage("msg_u")])
    reduceNormalized(officialEnvelope("session.step.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { id: "gpt-4.1", providerID: "openai" },
    }, STEP_STARTED_AT), state)
    reduceNormalized(officialEnvelope("session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "Hello",
    }, STEP_STARTED_AT + 10), state)
    reduceNormalized(officialEnvelope("session.step.ended", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      finish: "stop",
      cost: 0.0021,
      tokens: { ...TOKENS },
    }, STEP_ENDED_AT), state)

    const assistant = state.message[SESSION]?.find((message) => message.id === "msg_a") as Message & {
      tokens?: { output?: number; reasoning?: number }
      cost?: number
      finish?: string
    }
    expect(assistant?.finish).toBe("stop")
    expect(assistant?.cost).toBe(0.0021)
    expect(assistant?.tokens?.output).toBe(44)
    expect(assistant?.tokens?.reasoning).toBe(3)
    expect(assistant?.time.completed).toBe(STEP_ENDED_AT)
    // TPS chrome reads tokens.output / tokens.reasoning off message.info.
    expect(typeof assistant?.tokens?.output === "number" && assistant.tokens.output > 0).toBe(true)

    const failedState = draft([userMessage("msg_u")])
    reduceNormalized(officialEnvelope("session.step.failed", {
      sessionID: SESSION,
      assistantMessageID: "msg_fail",
      error: { type: "ProviderError", message: "rate limited" },
    }, STEP_ENDED_AT), failedState)
    const failed = failedState.message[SESSION]?.find((message) => message.id === "msg_fail") as Message & {
      finish?: string
      error?: { type?: string; message?: string }
    }
    expect(failed?.finish).toBe("error")
    expect(failed?.error).toEqual({ type: "ProviderError", message: "rate limited" })
  })

  test("live assistant without parentID still attaches to the preceding user turn", () => {
    const state = draft([userMessage("msg_u")])
    reduceNormalized(officialEnvelope("session.step.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { id: "gpt-4.1", providerID: "openai" },
    }, STEP_STARTED_AT), state)
    reduceNormalized(officialEnvelope("session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "live",
    }, STEP_STARTED_AT + 5), state)

    const messages = (state.message[SESSION] ?? []).map((info) => ({
      info,
      parts: state.part[info.id] ?? (info.role === "user" ? [] : [textPart(info.id, "")]),
    }))
    const projection = projectTurnRecords(messages)
    expect(projection.turns).toHaveLength(1)
    expect(projection.turns[0]?.assistantMessageIds).toEqual(["msg_a"])
    expect(projection.turns[0]?.assistantMessages[0]?.info.time.created).toBe(STEP_STARTED_AT)
    // Regression: created:0 made candidateCreated <= 0 fail and dropped the live row.
    expect(projection.turns[0]?.assistantMessages[0]?.info.time.created).not.toBe(0)
  })

  test("text-first bootstrap later repaired by step.started keeps turn ownership", () => {
    const state = draft([userMessage("msg_u")])
    // text.delta may arrive before step.started; still must not stamp created:0.
    reduceNormalized(officialEnvelope("session.text.delta", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      ordinal: 0,
      delta: "Hi",
    }, STEP_STARTED_AT - 1), state)
    const before = state.message[SESSION]?.find((message) => message.id === "msg_a")
    expect(before?.time.created).toBe(STEP_STARTED_AT - 1)
    expect(before?.time.created).toBeGreaterThan(USER_CREATED)

    reduceNormalized(officialEnvelope("session.step.started", {
      sessionID: SESSION,
      assistantMessageID: "msg_a",
      agent: "build",
      model: { id: "gpt-4.1", providerID: "openai" },
    }, STEP_STARTED_AT), state)
    const after = state.message[SESSION]?.find((message) => message.id === "msg_a")
    expect(after?.agent).toBe("build")
    expect(after?.time.created).toBe(STEP_STARTED_AT - 1)

    const projection = projectTurnRecords(
      (state.message[SESSION] ?? []).map((info) => ({
        info,
        parts: state.part[info.id] ?? [],
      })),
    )
    expect(projection.turns[0]?.assistantMessageIds).toContain("msg_a")
  })
})

describe("session.execution terminals release onServerSessionIdle", () => {
  test("succeeded / failed / interrupted call the idle callback even when already idle", () => {
    const state = directory()
    state.session_status[SESSION] = { type: "idle" }
    const released: string[] = []
    const callbacks = {
      onServerSessionIdle: (sessionID: string) => {
        released.push(sessionID)
      },
      now: () => 99,
    }

    expect(applyDirectoryEvent(state, {
      type: "session.execution.succeeded",
      properties: { sessionID: SESSION },
    } as Event, callbacks)).toBe(true)
    expect(applyDirectoryEvent(state, {
      type: "session.execution.failed",
      properties: { sessionID: SESSION },
    } as Event, callbacks)).toBe(true)
    expect(applyDirectoryEvent(state, {
      type: "session.execution.interrupted",
      properties: { sessionID: SESSION },
    } as Event, callbacks)).toBe(true)

    expect(released).toEqual([SESSION, SESSION, SESSION])
    expect(state.session_status[SESSION]).toEqual({ type: "idle" })
  })
})

describe("GET projection keeps usage for TPS", () => {
  test("assistant tokens/cost survive normalizeSessionProjectionMessage", () => {
    const normalized = normalizeSessionProjectionMessage(SESSION, {
      id: "msg_a",
      type: "assistant",
      time: { created: STEP_STARTED_AT, completed: STEP_ENDED_AT },
      agent: "build",
      model: { id: "gpt-4.1", providerID: "openai" },
      finish: "stop",
      cost: 0.0021,
      tokens: { ...TOKENS },
      content: [{ type: "text", text: "done" }],
    })
    expect(normalized).toBeTruthy()
    const info = normalized!.info as Message & {
      tokens?: { output?: number; reasoning?: number; input?: number }
      cost?: number
      finish?: string
    }
    expect(info.finish).toBe("stop")
    expect(info.cost).toBe(0.0021)
    expect(info.tokens).toEqual(TOKENS)
    // ChatMessage TPS path: tokens.output / tokens.reasoning.
    expect(info.tokens?.output).toBe(44)
    expect(info.tokens?.reasoning).toBe(3)
  })

  test("projection page order=desc still carries usage on the assistant row", () => {
    const page = normalizeSessionProjectionPage({
      data: [
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 20, completed: 30 },
          finish: "stop",
          cost: 1.5,
          tokens: { ...TOKENS },
          content: [{ type: "text", text: "answer" }],
        },
        {
          id: "msg_u",
          type: "user",
          time: { created: 10 },
          text: "hi",
        },
      ],
      cursor: { previous: null, next: null },
    }, SESSION, "desc")

    const assistant = page.records.find((record) => record.info.id === "msg_a")
    expect(assistant?.info.cost).toBe(1.5)
    expect((assistant?.info as { tokens?: { output?: number } }).tokens?.output).toBe(44)
  })
})
