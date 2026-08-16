import { describe, expect, test } from "bun:test"

import {
  createMemoryTranscriptDiagnosticsSink,
  createTranscriptDiagnosticsRecorder,
  diagnosticsExportEventCount,
  diagnosticsExportFileName,
  diagnosticsKindForCommand,
  diagnosticsSourceForCommand,
  isPrereleaseClientVersion,
  lastTranscriptMessageIDs,
  sanitizeDiagnosticsError,
  snapshotTranscriptDiagnostics,
} from "./transcript-diagnostics"
import type { TranscriptCommand } from "./transcript-repository"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

describe("transcript diagnostics", () => {
  test("offers recording only on prerelease versions", () => {
    expect(isPrereleaseClientVersion("1.16.134")).toBe(false)
    expect(isPrereleaseClientVersion("1.16.134-beta.5")).toBe(true)
    expect(isPrereleaseClientVersion("")).toBe(false)
    expect(isPrereleaseClientVersion(undefined)).toBe(false)
  })

  test("redacts credential-shaped errors and keeps ordinary codes", () => {
    expect(sanitizeDiagnosticsError("session.message failed")).toBe("session.message failed")
    expect(sanitizeDiagnosticsError(new Error("Bearer abc.def"))).toBe("redacted-error")
    expect(sanitizeDiagnosticsError("Authorization: token")).toBe("redacted-error")
  })

  test("snapshots identities and completeness without message bodies", () => {
    const event = snapshotTranscriptDiagnostics({
      kind: "http-page",
      sessionID: "ses_1",
      directory: "/repo",
      source: "network",
      durationMs: 42,
      transcript: {
        sessionID: "ses_1",
        messageOrder: ["m1", "m2", "m3", "m4", "m5"],
        messagesByID: {},
        partsByMessageID: {
          m5: [{ id: "p1", type: "text", text: "SECRET BODY" } as never, { id: "p2", type: "tool", slim: true } as never],
        },
        boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
        liveRevision: 0,
      },
      hydration: { sessionID: "ses_1", phase: "p0", p0Satisfied: true },
      command: "http-page",
      purpose: "initial",
      now: () => 10,
    })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain("SECRET BODY")
    expect(event.lastMessageIDs).toEqual(["m2", "m3", "m4", "m5"])
    expect(event.slimPartCount).toBe(1)
    expect(event.fullPartCount).toBe(1)
    expect(event.p0Satisfied).toBe(true)
    expect(event.source).toBe("network")
    expect(event.durationMs).toBe(42)
  })

  test("skips streaming part.delta and records other transcript commands", () => {
    expect(diagnosticsKindForCommand({
      type: "sse-event",
      event: { type: "message.part.delta" } as never,
    })).toBeNull()
    expect(diagnosticsKindForCommand({
      type: "sse-event",
      event: { type: "message.updated" } as never,
    })).toBe("sse-event")
    expect(diagnosticsKindForCommand({ type: "http-page", purpose: "initial", page: { records: [], complete: true } })).toBe("http-page")
    expect(diagnosticsSourceForCommand({
      type: "http-page",
      purpose: "initial",
      page: { records: [], complete: true },
    })).toBe("network")
    expect(diagnosticsSourceForCommand({
      type: "sse-event",
      event: { type: "message.updated" } as never,
    })).toBe("sse")
    expect(diagnosticsSourceForCommand({
      type: "materialize-snapshots",
      records: [],
    })).toBe("durable-cache")
  })

  test("recorder stays silent when disabled and exports a bounded ring when enabled", async () => {
    const sink = createMemoryTranscriptDiagnosticsSink({ limit: 2 })
    let enabled = false
    const recorder = createTranscriptDiagnosticsRecorder({ sink, isEnabled: () => enabled })
    recorder.record({ at: 1, feat: "transcript", kind: "http-page", sessionID: "ses_1" })
    expect(await sink.read()).toEqual([])

    enabled = true
    recorder.record({ at: 2, feat: "transcript", kind: "ensure-initial", sessionID: "ses_1" })
    recorder.record({ at: 3, feat: "transcript", kind: "hydration", sessionID: "ses_1" })
    recorder.record({ at: 4, feat: "transcript", kind: "request-error", sessionID: "ses_1", error: "timeout" })
    const events = await sink.read()
    expect(events.map((event) => event.at)).toEqual([3, 4])
    const report = JSON.parse(await recorder.exportReport()) as { schema: string; eventCount: number; feats: string[] }
    expect(report.schema).toBe("openchamber.client-diagnostics.v1")
    expect(report.eventCount).toBe(2)
    expect(report.feats).toEqual(["transcript"])
  })

  test("lastTranscriptMessageIDs keeps the newest tail", () => {
    expect(lastTranscriptMessageIDs(["a", "b"], 4)).toEqual(["a", "b"])
    expect(lastTranscriptMessageIDs(["a", "b", "c", "d", "e"], 4)).toEqual(["b", "c", "d", "e"])
  })

  test("export helpers name the file and read eventCount without throwing on junk", () => {
    expect(diagnosticsExportFileName(Date.UTC(2026, 7, 16, 12, 0, 0))).toBe(
      "openchamber-diagnostics-2026-08-16T12-00-00-000Z.json",
    )
    expect(diagnosticsExportEventCount('{"eventCount":3}')).toBe(3)
    expect(diagnosticsExportEventCount("not-json")).toBe(0)
  })
})
