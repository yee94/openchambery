import { afterEach, describe, expect, test, vi } from "vitest"

import {
  createMemoryTranscriptDiagnosticsSink,
  createTranscriptDiagnosticsRecorder,
} from "./transcript-diagnostics"
import {
  recordTranscriptCommandDiagnostics,
  setTranscriptDiagnosticsRecorderForTests,
  shouldRecordTranscriptCommandDiagnostics,
} from "./transcript-diagnostics-runtime"
import type { TranscriptData } from "./transcript-repository"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

const emptyTranscript = (sessionID = "ses_1"): TranscriptData => ({
  sessionID,
  messageOrder: [],
  messagesByID: {},
  partsByMessageID: {},
  boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
  liveRevision: 0,
})

afterEach(() => {
  setTranscriptDiagnosticsRecorderForTests(undefined)
})

describe("transcript command diagnostics eligibility", () => {
  test("noise SSE delta and unchanged batches are not eligible", () => {
    const enabled = () => true
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: { type: "sse-event", event: { type: "message.part.delta" } as never },
      changed: true,
      isEnabled: enabled,
    })).toBe(false)
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: {
        type: "sse-event-batch",
        events: [
          { type: "message.part.delta" } as never,
          { type: "message.part.delta" } as never,
        ],
      },
      changed: true,
      isEnabled: enabled,
    })).toBe(false)
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: { type: "sse-event", event: { type: "message.updated" } as never },
      changed: false,
      isEnabled: enabled,
    })).toBe(false)
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: {
        type: "sse-event-batch",
        events: [{ type: "message.updated" } as never],
      },
      changed: false,
      isEnabled: enabled,
    })).toBe(false)
  })

  test("disabled switch blocks eligibility even for recordable commands", () => {
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: {
        type: "http-page",
        purpose: "initial",
        page: { records: [], complete: true },
      },
      isEnabled: () => false,
    })).toBe(false)
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: { type: "sse-event", event: { type: "message.updated" } as never },
      changed: true,
      isEnabled: () => false,
    })).toBe(false)
  })

  test("enabled recordable commands remain eligible", () => {
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: {
        type: "http-page",
        purpose: "initial",
        page: { records: [], complete: true },
      },
      isEnabled: () => true,
    })).toBe(true)
    expect(shouldRecordTranscriptCommandDiagnostics({
      command: { type: "sse-event", event: { type: "message.updated" } as never },
      changed: true,
      isEnabled: () => true,
    })).toBe(true)
  })

  test("disabled / noise / unchanged never invoke expensive suppliers", () => {
    let enabled = true
    const sink = createMemoryTranscriptDiagnosticsSink()
    setTranscriptDiagnosticsRecorderForTests(
      createTranscriptDiagnosticsRecorder({ sink, isEnabled: () => enabled }),
    )
    const transcriptSupplier = vi.fn(() => emptyTranscript())
    const requestSupplier = vi.fn(() => ({ sessionID: "ses_1", status: "ready" as const }))
    const hydrationSupplier = vi.fn(() => ({
      sessionID: "ses_1",
      phase: "p0",
      p0Satisfied: true,
    }))

    recordTranscriptCommandDiagnostics({
      directory: "/repo",
      sessionID: "ses_1",
      command: { type: "sse-event", event: { type: "message.part.delta" } as never },
      changed: true,
      transcript: transcriptSupplier,
      request: requestSupplier,
      hydration: hydrationSupplier,
      isEnabled: () => true,
    })
    expect(transcriptSupplier).not.toHaveBeenCalled()
    expect(requestSupplier).not.toHaveBeenCalled()
    expect(hydrationSupplier).not.toHaveBeenCalled()

    recordTranscriptCommandDiagnostics({
      directory: "/repo",
      sessionID: "ses_1",
      command: { type: "sse-event", event: { type: "message.updated" } as never },
      changed: false,
      transcript: transcriptSupplier,
      request: requestSupplier,
      hydration: hydrationSupplier,
      isEnabled: () => true,
    })
    expect(transcriptSupplier).not.toHaveBeenCalled()

    enabled = false
    recordTranscriptCommandDiagnostics({
      directory: "/repo",
      sessionID: "ses_1",
      command: {
        type: "http-page",
        purpose: "initial",
        page: { records: [], complete: true },
      },
      transcript: transcriptSupplier,
      request: requestSupplier,
      hydration: hydrationSupplier,
      isEnabled: () => false,
    })
    expect(transcriptSupplier).not.toHaveBeenCalled()
    expect(requestSupplier).not.toHaveBeenCalled()
    expect(hydrationSupplier).not.toHaveBeenCalled()
  })

  test("enabled recordable path resolves suppliers once and records", async () => {
    const sink = createMemoryTranscriptDiagnosticsSink()
    setTranscriptDiagnosticsRecorderForTests(
      createTranscriptDiagnosticsRecorder({ sink, isEnabled: () => true }),
    )
    const transcriptSupplier = vi.fn(() => emptyTranscript("ses_gate"))
    const requestSupplier = vi.fn(() => ({ sessionID: "ses_gate", status: "ready" as const }))
    const hydrationSupplier = vi.fn(() => ({
      sessionID: "ses_gate",
      phase: "p0",
      p0Satisfied: true,
    }))

    recordTranscriptCommandDiagnostics({
      directory: "/repo",
      sessionID: "ses_gate",
      command: {
        type: "http-page",
        purpose: "initial",
        page: { records: [], complete: true },
      },
      transcript: transcriptSupplier,
      request: requestSupplier,
      hydration: hydrationSupplier,
      isEnabled: () => true,
    })

    expect(transcriptSupplier).toHaveBeenCalledTimes(1)
    expect(requestSupplier).toHaveBeenCalledTimes(1)
    expect(hydrationSupplier).toHaveBeenCalledTimes(1)
    const events = await sink.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("http-page")
    expect(events[0]?.sessionID).toBe("ses_gate")
  })
})
