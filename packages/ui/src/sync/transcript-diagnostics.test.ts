import { describe, expect, test } from "bun:test"

import {
  captureTranscriptCanonicalSnapshot,
  createMemoryTranscriptDiagnosticsSink,
  createTranscriptDiagnosticsRecorder,
  diagnosticsExportEventCount,
  diagnosticsExportFileName,
  diagnosticsHttpStatus,
  diagnosticsKindForCommand,
  diagnosticsSourceForCommand,
  diagnosticsSessionStatusType,
  diffTranscriptCanonicalSnapshots,
  isPrereleaseClientVersion,
  extractDiagnosticsUserText,
  lastTranscriptMessageIDs,
  parseTranscriptDiagnosticsPreference,
  resolveTaskClickOutcome,
  resolveTranscriptDiagnosticsEnabled,
  sanitizeDiagnosticsError,
  snapshotTaskClickDiagnostics,
  snapshotTaskRowDiagnostics,
  snapshotTranscriptDiagnostics,
  taskRowDiagnosticsSignature,
} from "./transcript-diagnostics"
import { UNKNOWN_SESSION_HISTORY_BOUNDARY } from "./types"

describe("transcript diagnostics", () => {
  test("offers recording only on prerelease versions", () => {
    expect(isPrereleaseClientVersion("1.16.134")).toBe(false)
    expect(isPrereleaseClientVersion("1.16.134-beta.5")).toBe(true)
    expect(isPrereleaseClientVersion("")).toBe(false)
    expect(isPrereleaseClientVersion(undefined)).toBe(false)
  })

  test("defaults the About switch on for beta and off for stable", () => {
    expect(resolveTranscriptDiagnosticsEnabled({ version: "1.16.134" })).toBe(false)
    expect(resolveTranscriptDiagnosticsEnabled({ version: "1.16.134-beta.9" })).toBe(true)
    expect(resolveTranscriptDiagnosticsEnabled({ version: "1.16.134", preference: true })).toBe(true)
    expect(resolveTranscriptDiagnosticsEnabled({ version: "1.16.134-beta.9", preference: false })).toBe(false)
    expect(parseTranscriptDiagnosticsPreference(null)).toBeNull()
    expect(parseTranscriptDiagnosticsPreference("true")).toBe(true)
    expect(parseTranscriptDiagnosticsPreference("false")).toBe(false)
  })

  test("redacts credential-shaped errors and keeps ordinary codes", () => {
    expect(sanitizeDiagnosticsError("session.message failed")).toBe("session.message failed")
    expect(sanitizeDiagnosticsError(new Error("Bearer abc.def"))).toBe("redacted-error")
    expect(sanitizeDiagnosticsError("Authorization: token")).toBe("redacted-error")
  })

  test("extracts http status from typed errors and failed(status) messages", () => {
    expect(diagnosticsHttpStatus(Object.assign(new Error("session.message failed (502): timeout"), { status: 502 }))).toBe(502)
    expect(diagnosticsHttpStatus("ensureInitial failed (404): missing")).toBe(404)
    expect(diagnosticsHttpStatus("plain timeout")).toBeUndefined()
  })

  test("snapshots identities and completeness without assistant bodies", () => {
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
      error: Object.assign(new Error("session.message failed (502): timeout"), { status: 502 }),
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
    expect(event.httpStatus).toBe(502)
    expect(event.error).toBe("session.message failed (502): timeout")
  })

  test("skips streaming part.delta and records other transcript commands", () => {
    expect(diagnosticsKindForCommand({
      type: "sse-event",
      event: { type: "message.part.delta" } as never,
    })).toBeNull()
    expect(diagnosticsKindForCommand({
      type: "sse-event-batch",
      events: [{ type: "message.part.delta" } as never, { type: "message.part.delta" } as never],
    })).toBeNull()
    expect(diagnosticsKindForCommand({
      type: "sse-event-batch",
      events: [{ type: "message.part.delta" } as never, { type: "message.updated" } as never],
    })).toBe("sse-event")
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

  test("keeps bounded user text and redacts credential-shaped user text", () => {
    expect(extractDiagnosticsUserText([
      { id: "p1", type: "text", text: "确保已经完成修复了" } as never,
      { id: "p2", type: "file", filename: "a.png" } as never,
    ])).toBe("确保已经完成修复了")
    expect(extractDiagnosticsUserText([
      { id: "p1", type: "text", text: "Bearer abc.def" } as never,
    ])).toBe("redacted-text")
    expect(extractDiagnosticsUserText([
      { id: "p1", type: "text", text: "a".repeat(401) } as never,
    ])).toBe(`${"a".repeat(400)}…`)
  })

  test("lastTranscriptMessageIDs keeps the newest tail", () => {
    expect(lastTranscriptMessageIDs(["a", "b"], 4)).toEqual(["a", "b"])
    expect(lastTranscriptMessageIDs(["a", "b", "c", "d", "e"], 4)).toEqual(["b", "c", "d", "e"])
  })

  test("records assistant identity-missing facts without values", () => {
    const identified = {
      id: "m1",
      sessionID: "ses_1",
      role: "assistant",
      mode: "explorer",
      providerID: "deepseek",
      modelID: "deepseek-v4-flash",
      time: { created: 1 },
    }
    const identityless = {
      id: "m2",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 2 },
    }
    const transcript = {
      sessionID: "ses_1",
      messageOrder: ["m1", "m2"],
      messagesByID: { m1: identified, m2: identityless },
      partsByMessageID: {},
      boundary: UNKNOWN_SESSION_HISTORY_BOUNDARY,
      liveRevision: 0,
    }

    const event = snapshotTranscriptDiagnostics({
      kind: "sse-event",
      sessionID: "ses_1",
      transcript: transcript as never,
      now: () => 10,
    })
    expect(event.identityMissingCount).toBe(1)
    expect(JSON.stringify(event)).not.toContain("explorer")
    expect(JSON.stringify(event)).not.toContain("deepseek")

    const before = captureTranscriptCanonicalSnapshot(transcript as never)
    expect(before.messages[1]?.identityMissing).toBe(true)
    expect(before.messages[0]?.identityMissing).toBe(false)

    const after = captureTranscriptCanonicalSnapshot({
      ...transcript,
      messagesByID: {
        m1: { ...identified, mode: undefined, providerID: undefined, modelID: undefined },
        m2: identityless,
      },
    } as never)
    const diff = diffTranscriptCanonicalSnapshots(before, after)
    expect(diff.identityLost).toEqual(["m1"])
  })

  test("export helpers name the file and read eventCount without throwing on junk", () => {
    expect(diagnosticsExportFileName(Date.UTC(2026, 7, 16, 12, 0, 0))).toBe(
      "openchamber-diagnostics-2026-08-16T12-00-00-000Z.json",
    )
    expect(diagnosticsExportEventCount('{"eventCount":3}')).toBe(3)
    expect(diagnosticsExportEventCount("not-json")).toBe(0)
  })
})

describe("task diagnostics", () => {
  const facts = {
    sessionID: "ses_parent",
    partID: "prt_1",
    messageID: "msg_1",
    directory: "/repo",
    directoryPresent: true,
    childSessionPresent: false,
    toolStatus: "running",
    finalized: false,
    backgroundRunning: false,
    effectiveActive: true,
    suppressLoading: false,
    delegating: false,
    childStatus: "missing",
    parentStatus: "busy",
    idleConfirmed: false,
    navigateCapability: true,
    surfaceKind: "primary",
    taskStartedAt: 100,
  }

  test("row snapshots keep identities and omit titles", () => {
    const event = snapshotTaskRowDiagnostics({ ...facts, now: () => 10 })
    expect(event.at).toBe(10)
    expect(event.feat).toBe("task")
    expect(event.kind).toBe("task-row")
    expect(event.sessionID).toBe("ses_parent")
    expect(event.partID).toBe("prt_1")
    expect(event.childSessionPresent).toBe(false)
    expect(event.childStatus).toBe("missing")
    expect(event.parentStatus).toBe("busy")
    expect(event.effectiveActive).toBe(true)
    expect(event.directoryPresent).toBe(true)
    expect(JSON.stringify(event)).not.toContain("Oracle")
    expect(JSON.stringify(event)).not.toContain("Review")
  })

  test("click outcomes distinguish queued, capability-off, and opened", () => {
    expect(resolveTaskClickOutcome({
      opened: false,
      navigateCapability: true,
      childSessionPresent: false,
      directoryPresent: true,
    })).toBe("queued")
    expect(resolveTaskClickOutcome({
      opened: false,
      navigateCapability: false,
      childSessionPresent: true,
      directoryPresent: true,
    })).toBe("capability-off")
    expect(diagnosticsSessionStatusType(undefined)).toBe("missing")
    expect(diagnosticsSessionStatusType({ type: "idle" })).toBe("idle")
    const opened = snapshotTaskClickDiagnostics({
      ...facts,
      childSessionPresent: true,
      childSessionID: "ses_child",
      opened: true,
      clickSource: "row",
      now: () => 11,
    })
    expect(opened.feat).toBe("task")
    expect(opened.kind).toBe("task-click")
    expect(opened.clickSource).toBe("row")
    expect(opened.clickOutcome).toBe("opened")
    expect(opened.childSessionID).toBe("ses_child")
    expect(opened.childSessionPresent).toBe(true)
  })

  test("row signatures ignore object identity and change when status facts change", () => {
    expect(taskRowDiagnosticsSignature(facts)).toBe(taskRowDiagnosticsSignature({ ...facts }))
    expect(taskRowDiagnosticsSignature(facts)).not.toBe(taskRowDiagnosticsSignature({
      ...facts,
      childSessionPresent: true,
      childSessionID: "ses_child",
      childStatus: "busy",
    }))
  })

  test("enabled recorder includes the task feat in the export", async () => {
    const sink = createMemoryTranscriptDiagnosticsSink({ limit: 4 })
    const recorder = createTranscriptDiagnosticsRecorder({ sink, isEnabled: () => true })
    recorder.record({ at: 1, feat: "transcript", kind: "http-page", sessionID: "ses_parent" })
    recorder.record(snapshotTaskRowDiagnostics({ ...facts, now: () => 2 }))
    const report = JSON.parse(await recorder.exportReport()) as { feats: string[]; eventCount: number }
    expect(report.eventCount).toBe(2)
    expect(report.feats).toEqual(["transcript", "task"])
  })

  test("disabled recorder stays silent for task events", async () => {
    const sink = createMemoryTranscriptDiagnosticsSink()
    const recorder = createTranscriptDiagnosticsRecorder({ sink, isEnabled: () => false })
    recorder.record(snapshotTaskClickDiagnostics({
      ...facts,
      opened: false,
      clickSource: "row",
      now: () => 3,
    }))
    expect(await sink.read()).toEqual([])
  })
})
