import { describe, expect, test } from "bun:test"

import {
  normalizeOpenCodeEvent,
  toLegacyEventShape,
} from "./opencode-event-normalizer"

describe("normalizeOpenCodeEvent", () => {
  test("passes through legacy properties envelopes", () => {
    const result = normalizeOpenCodeEvent({
      type: "session.status",
      properties: {
        sessionID: "ses_a",
        status: { type: "busy" },
      },
    })
    expect(result).toEqual({
      action: "emit",
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_a",
          status: { type: "busy" },
        },
      },
    })
  })

  test("maps current data/location session.status to legacy properties", () => {
    const result = normalizeOpenCodeEvent({
      id: "evt_1",
      type: "session.status",
      location: { path: "/repo/app" },
      data: {
        sessionID: "ses_b",
        status: { type: "retry", attempt: 1, message: "wait", next: 10 },
      },
    })
    expect(result.action).toBe("emit")
    if (result.action !== "emit") return
    expect(result.event.type).toBe("session.status")
    expect(result.event.properties).toEqual({
      sessionID: "ses_b",
      status: { type: "retry", attempt: 1, message: "wait", next: 10 },
    })
    expect(result.event.locationDirectory).toBe("/repo/app")
    expect(toLegacyEventShape(result.event)).toEqual({
      id: "evt_1",
      type: "session.status",
      properties: {
        sessionID: "ses_b",
        status: { type: "retry", attempt: 1, message: "wait", next: 10 },
      },
    })
  })

  test("preserves a legacy session.status properties directory as a routing hint", () => {
    const result = normalizeOpenCodeEvent({
      type: "session.status",
      properties: {
        directory: "/repo/legacy",
        sessionID: "ses_legacy",
        status: { type: "busy" },
      },
    })
    expect(result.action).toBe("emit")
    if (result.action !== "emit") return
    expect(result.event.locationDirectory).toBe("/repo/legacy")
    expect(result.event.properties).toEqual({
      sessionID: "ses_legacy",
      status: { type: "busy" },
    })
  })

  test("strips versioned type suffixes", () => {
    const result = normalizeOpenCodeEvent({
      type: "session.status.1",
      properties: { sessionID: "ses_a", status: { type: "idle" } },
    })
    expect(result.action).toBe("emit")
    if (result.action !== "emit") return
    expect(result.event.type).toBe("session.status")
  })

  test("filters durable sync replicas", () => {
    expect(normalizeOpenCodeEvent({
      type: "session.status",
      durable: { kind: "sync", aggregateID: "agg", seq: 1, version: 1 },
      data: { sessionID: "ses_a", status: { type: "busy" } },
    })).toEqual({ action: "drop", reason: "sync-duplicate" })

    expect(normalizeOpenCodeEvent({
      type: "session.status",
      durable: { sync: true },
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    })).toEqual({ action: "drop", reason: "sync-duplicate" })

    expect(normalizeOpenCodeEvent({
      type: "session.status",
      durable: { aggregateID: "sync:ses_a", seq: 1, version: 1 },
      properties: { sessionID: "ses_a", status: { type: "busy" } },
    })).toEqual({ action: "drop", reason: "sync-duplicate" })
  })

  test("unwraps global envelope and preserves directory", () => {
    const result = normalizeOpenCodeEvent({
      directory: "/repo",
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_g", status: { type: "busy" } },
      },
    })
    expect(result.action).toBe("emit")
    if (result.action !== "emit") return
    expect(result.event.locationDirectory).toBe("/repo")
    expect(result.event.properties.sessionID).toBe("ses_g")
  })

  test("exposes admission confirmation for session.next.prompt.admitted", () => {
    const result = normalizeOpenCodeEvent({
      type: "session.next.prompt.admitted",
      data: {
        timestamp: 1,
        sessionID: "ses_a",
        messageID: "msg_1",
        prompt: { text: "hi" },
        delivery: "queue",
      },
    })
    expect(result.action).toBe("emit")
    if (result.action !== "emit") return
    expect(result.event.admissionHint).toEqual({
      sessionID: "ses_a",
      messageID: "msg_1",
    })
    expect(result.event.domainActivityHint).toEqual({
      sessionID: "ses_a",
      kind: "activity",
    })
  })

  test("marks current step/text as domain activity and terminal ended as terminal", () => {
    const activity = normalizeOpenCodeEvent({
      type: "session.next.text.delta",
      data: {
        timestamp: 1,
        sessionID: "ses_a",
        assistantMessageID: "msg_a",
        textID: "txt_1",
        delta: "x",
      },
    })
    expect(activity.action).toBe("emit")
    if (activity.action !== "emit") return
    expect(activity.event.domainActivityHint).toEqual({
      sessionID: "ses_a",
      kind: "activity",
    })

    const terminal = normalizeOpenCodeEvent({
      type: "session.next.step.ended",
      data: {
        timestamp: 1,
        sessionID: "ses_a",
        assistantMessageID: "msg_a",
        finish: "stop",
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })
    expect(terminal.action).toBe("emit")
    if (terminal.action !== "emit") return
    expect(terminal.event.domainActivityHint).toEqual({
      sessionID: "ses_a",
      kind: "terminal",
    })
  })

  test("does not invent legacy Message/Part from current text events", () => {
    const result = normalizeOpenCodeEvent({
      type: "session.next.text.delta",
      data: {
        timestamp: 1,
        sessionID: "ses_a",
        assistantMessageID: "msg_a",
        textID: "txt_1",
        delta: "hello",
      },
    })
    expect(result.action).toBe("emit")
    if (result.action !== "emit") return
    // Stays as session.next.* — never rewritten to message.part.delta.
    expect(result.event.type).toBe("session.next.text.delta")
    expect("partID" in result.event.properties).toBe(false)
  })

  test("drops invalid frames", () => {
    expect(normalizeOpenCodeEvent(null)).toEqual({ action: "drop", reason: "invalid" })
    expect(normalizeOpenCodeEvent({})).toEqual({ action: "drop", reason: "invalid" })
    expect(normalizeOpenCodeEvent({ type: "session.status" })).toEqual({
      action: "drop",
      reason: "invalid",
    })
  })
})
