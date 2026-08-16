/**
 * Production selector for transcript diagnostics.
 *
 * Web / Electron renderer / Capacitor / VS Code webview persist through
 * IndexedDB. Tests inject a memory sink. Recording is off unless the client
 * is a prerelease build. Stable builds stay off.
 */

import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"

import {
  commandPurpose,
  commandSseType,
  createMemoryTranscriptDiagnosticsSink,
  createTranscriptDiagnosticsRecorder,
  diagnosticsExportEventCount,
  diagnosticsExportFileName,
  diagnosticsKindForCommand,
  diagnosticsSourceForCommand,
  isPrereleaseClientVersion,
  snapshotTranscriptDiagnostics,
  type TranscriptDiagnosticsEvent,
  type TranscriptDiagnosticsRecorder,
  type TranscriptDiagnosticsSink,
} from "./transcript-diagnostics"
import type {
  TranscriptCommand,
  TranscriptData,
  TranscriptHydrationState,
  TranscriptRequestState,
} from "./transcript-repository"
import { createIndexedDBTranscriptDiagnosticsSink } from "./transcript-diagnostics-indexeddb"

declare const __APP_VERSION__: string | undefined

export type TranscriptDiagnosticsRuntimeKind = "memory" | "indexeddb"

export function getClientPackageVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : ""
}

export function isTranscriptDiagnosticsOffered(version: string = getClientPackageVersion()): boolean {
  return isPrereleaseClientVersion(version)
}

export function resolveTranscriptDiagnosticsRuntimeKind(
  deps: { hasIndexedDB?: () => boolean } = {},
): TranscriptDiagnosticsRuntimeKind {
  const hasIndexedDB = deps.hasIndexedDB ?? (() => typeof globalThis.indexedDB !== "undefined")
  return hasIndexedDB() ? "indexeddb" : "memory"
}

export type TranscriptDiagnosticsRuntimeDeps = {
  createMemorySink?: () => TranscriptDiagnosticsSink
  createIndexedDBSink?: () => TranscriptDiagnosticsSink
  isEnabled?: () => boolean
}

let recorder: TranscriptDiagnosticsRecorder | undefined

export function isTranscriptDiagnosticsEnabled(version: string = getClientPackageVersion()): boolean {
  return isTranscriptDiagnosticsOffered(version)
}

export function createRuntimeTranscriptDiagnosticsRecorder(
  deps: TranscriptDiagnosticsRuntimeDeps = {},
): TranscriptDiagnosticsRecorder {
  const kind = resolveTranscriptDiagnosticsRuntimeKind()
  const sink = kind === "indexeddb"
    ? (deps.createIndexedDBSink ?? createIndexedDBTranscriptDiagnosticsSink)()
    : (deps.createMemorySink ?? createMemoryTranscriptDiagnosticsSink)()
  return createTranscriptDiagnosticsRecorder({
    sink,
    isEnabled: deps.isEnabled ?? isTranscriptDiagnosticsEnabled,
  })
}

export function getTranscriptDiagnosticsRecorder(): TranscriptDiagnosticsRecorder {
  recorder ??= createRuntimeTranscriptDiagnosticsRecorder()
  return recorder
}

export function recordTranscriptDiagnostics(event: TranscriptDiagnosticsEvent): void {
  getTranscriptDiagnosticsRecorder().record(event)
}

export function recordTranscriptCommandDiagnostics(input: {
  directory: string
  sessionID: string
  transport?: string
  generation?: number
  command: TranscriptCommand
  transcript?: TranscriptData
  request?: TranscriptRequestState
  hydration?: TranscriptHydrationState
  error?: unknown
}): void {
  const kind = diagnosticsKindForCommand(input.command)
  if (!kind) return
  recordTranscriptDiagnostics(snapshotTranscriptDiagnostics({
    kind,
    sessionID: input.sessionID,
    directory: input.directory,
    transport: input.transport,
    generation: input.generation,
    transcript: input.transcript,
    request: input.request,
    hydration: input.hydration,
    command: input.command.type,
    purpose: commandPurpose(input.command),
    sseType: commandSseType(input.command),
    source: diagnosticsSourceForCommand(input.command),
    error: input.error,
  }))
}

export async function exportTranscriptDiagnosticsReport(): Promise<string> {
  const local = await getTranscriptDiagnosticsRecorder().exportReport()
  const runtimeExport = getRegisteredRuntimeAPIs()?.diagnostics?.downloadLogs
  if (!runtimeExport) return local
  try {
    const native = await runtimeExport()
    if (typeof native?.content === "string" && native.content.trim()) {
      return native.content
    }
  } catch {
    // Native export is optional; the local ring buffer remains authoritative.
  }
  return local
}

export function downloadDiagnosticsReport(content: string, fileName = diagnosticsExportFileName()): boolean {
  if (typeof document === "undefined") return false
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return true
}

export async function exportAndDownloadClientDiagnostics(): Promise<{
  content: string
  fileName: string
  downloaded: boolean
  eventCount: number
}> {
  const content = await exportTranscriptDiagnosticsReport()
  const fileName = diagnosticsExportFileName()
  return {
    content,
    fileName,
    downloaded: downloadDiagnosticsReport(content, fileName),
    eventCount: diagnosticsExportEventCount(content),
  }
}

export async function clearTranscriptDiagnostics(): Promise<void> {
  await getTranscriptDiagnosticsRecorder().clear()
}

export { diagnosticsExportEventCount, diagnosticsExportFileName, snapshotTranscriptDiagnostics }
