/**
 * Production selector for transcript diagnostics.
 *
 * Web / Electron renderer / Capacitor / VS Code webview persist through
 * IndexedDB. Tests inject a memory sink. Recording is off unless the client
 * is enabled. About defaults the switch on for prerelease builds and off
 * for stable. The user can override that default.
 */

import { Capacitor, registerPlugin } from "@capacitor/core"

import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { isCapacitorApp } from "@/lib/platform"

type OpenChamberMediaPlugin = {
  saveFile: (options: {
    dataBase64: string
    mimeType?: string
    filename?: string
  }) => Promise<{ cancelled?: boolean }>
}

const OpenChamberMedia = registerPlugin<OpenChamberMediaPlugin>("OpenChamberMedia")

export type DiagnosticsDownloadOutcome = "saved" | "downloaded" | "cancelled" | "failed"

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function isNativeFileSaveAvailable(): boolean {
  return isCapacitorApp() && typeof Capacitor !== "undefined" && Capacitor.isPluginAvailable("OpenChamberMedia")
}

import {
  commandPurpose,
  commandSseType,
  createMemoryTranscriptDiagnosticsSink,
  createTranscriptDiagnosticsRecorder,
  diagnosticsExportEventCount,
  diagnosticsExportFileName,
  diagnosticsKindForCommand,
  diagnosticsSourceForCommand,
  parseTranscriptDiagnosticsPreference,
  resolveTranscriptDiagnosticsEnabled,
  snapshotTranscriptDiagnostics,
  TRANSCRIPT_DIAGNOSTICS_PREFERENCE_KEY,
  type TranscriptDiagnosticsEvent,
  type TranscriptDiagnosticsHydration,
  type TranscriptDiagnosticsRecorder,
  type TranscriptDiagnosticsSink,
} from "./transcript-diagnostics"
import type {
  TranscriptCommand,
  TranscriptData,
  TranscriptRequestState,
} from "./transcript-repository"
import { createIndexedDBTranscriptDiagnosticsSink } from "./transcript-diagnostics-indexeddb"

declare const __APP_VERSION__: string | undefined

export type TranscriptDiagnosticsRuntimeKind = "memory" | "indexeddb"

export function getClientPackageVersion(): string {
  return typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__ ? __APP_VERSION__ : ""
}

export function readTranscriptDiagnosticsPreference(): boolean | null {
  if (typeof localStorage === "undefined") return null
  try {
    return parseTranscriptDiagnosticsPreference(localStorage.getItem(TRANSCRIPT_DIAGNOSTICS_PREFERENCE_KEY))
  } catch {
    return null
  }
}

export function setTranscriptDiagnosticsEnabled(enabled: boolean): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(TRANSCRIPT_DIAGNOSTICS_PREFERENCE_KEY, enabled ? "true" : "false")
  } catch {
    // Preference is best-effort; recording still follows the in-memory toggle.
  }
}

export function isTranscriptDiagnosticsOffered(version: string = getClientPackageVersion()): boolean {
  return resolveTranscriptDiagnosticsEnabled({ version })
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
  return resolveTranscriptDiagnosticsEnabled({
    version,
    preference: readTranscriptDiagnosticsPreference(),
  })
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
  hydration?: TranscriptDiagnosticsHydration
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

export async function downloadDiagnosticsReport(content: string, fileName = diagnosticsExportFileName()): Promise<DiagnosticsDownloadOutcome> {
  if (isNativeFileSaveAvailable()) {
    const result = await OpenChamberMedia.saveFile({
      dataBase64: encodeUtf8Base64(content),
      mimeType: "application/json",
      filename: fileName,
    })
    return result?.cancelled ? "cancelled" : "saved"
  }
  if (typeof document === "undefined") return "failed"
  const blob = new Blob([content], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return "downloaded"
}

export async function exportAndDownloadClientDiagnostics(): Promise<{
  content: string
  fileName: string
  outcome: DiagnosticsDownloadOutcome
  eventCount: number
}> {
  const content = await exportTranscriptDiagnosticsReport()
  const fileName = diagnosticsExportFileName()
  return {
    content,
    fileName,
    outcome: await downloadDiagnosticsReport(content, fileName),
    eventCount: diagnosticsExportEventCount(content),
  }
}

export async function clearTranscriptDiagnostics(): Promise<void> {
  await getTranscriptDiagnosticsRecorder().clear()
}

export { diagnosticsExportEventCount, diagnosticsExportFileName, snapshotTranscriptDiagnostics }
