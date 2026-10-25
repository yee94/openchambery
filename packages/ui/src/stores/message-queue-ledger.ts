import '@/lib/brand-storage-bootstrap';
import { isDurableURL } from "@/sync/input-draft-types"
import { parseDraftComposerDocument, parseDraftMentions, type DraftComposerDocument, type DraftMention } from "@/sync/input-draft-types"
import { serializeComposerDocument } from "@/composer/document"
import { describeComposerDocumentResources } from "@/composer/extensions"

export const MESSAGE_QUEUE_LEDGER_KEY = "yuri_message_queue_ledger_v4"
export const LEGACY_MESSAGE_QUEUE_KEY = "message-queue-store"
export type QueueLedgerScope = { state: "bound"; transportIdentity: string; directory: string; sessionID: string } | { state: "unbound-legacy"; sessionID: string }
type QueueAttachmentSourceDTO = { source: "local" | "vscode" | "server"; serverPath?: string; vscodePath?: string; vscodeSource?: "file" | "selection" }
type QueueAttachmentFieldsDTO = { attachmentID: string; occurrenceRefID: string; filename: string; mimeType: string; size: number } & QueueAttachmentSourceDTO
export type QueueAttachmentRefDTO = QueueAttachmentFieldsDTO & { version: 1; locator: { kind: "blob"; blobID: string } | { kind: "url"; url: string } }
export type QueueAttachmentIssueDTO = QueueAttachmentFieldsDTO & { reason: "legacy-blob-url" | "legacy-bytes-missing" | "legacy-unbound-data" | "missing-blob" }
export type QueueItemDTO = { version: 1; queueItemID: string; operationID: string; messageID: string; owner: QueueLedgerScope; content: string; composerDocument?: DraftComposerDocument; composerMentions?: DraftMention[]; attachments: QueueAttachmentRefDTO[]; attachmentIssues: QueueAttachmentIssueDTO[]; createdAt: number; sendConfig?: { providerID: string; modelID: string; agent?: string; variant?: string }; status: "queued" | "sending" | "retrying" | "reconciling" | "unresolved" | "failed"; attemptCount: number; nextAttemptAt?: number; reconciliationStartedAt?: number; reconciliationDeadlineAt?: number; reconciliationChecks?: number; reconciliationNextCheckAt?: number; failureKind?: "pre-dispatch" | "ambiguous-dispatch" | "definitive" }
export type QueueLedgerSnapshotV4 = { version: 4; queues: Record<string, QueueItemDTO[]>; migration: { v3State: "pending" | "complete" | "degraded" } }
export type QueueLedgerParseIssue = { scopeKey?: string; queueItemID?: string; operationID?: string; path: string; reason: string }
export type QueueLedgerParseResult = { status: "ok" | "corrupt"; snapshot: QueueLedgerSnapshotV4; issues: QueueLedgerParseIssue[]; degradedScopeKeys: string[] }
export type QueueLedgerDetailedRead = { raw: string | null; snapshot: QueueLedgerSnapshotV4 | null; status: "empty" | "ok" | "partial" | "corrupt"; issues: QueueLedgerParseIssue[]; degradedScopeKeys: string[] }
export type QueueLedgerMetadataErrorCode = "unavailable" | "quota" | "corrupt" | "serialization" | "cancelled"
export type QueueLedgerResult<T> = { ok: true; value: T } | { ok: false; error: { code: QueueLedgerMetadataErrorCode } }
export type QueueLedgerMetadataSink = { read: (key: string) => Promise<QueueLedgerResult<string | null>>; write: (key: string, value: string) => Promise<QueueLedgerResult<void>>; remove: (key: string) => Promise<QueueLedgerResult<void>> }

export const QUEUE_LEDGER_LIMITS = { scopes: 128, totalItems: 2048, attachmentsPerItem: 64, issuesPerItem: 64, string: 8192, content: 200000, dataURL: 25 * 1024 * 1024, bytes: 25 * 1024 * 1024 } as const
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((key) => keys.includes(key))
const str = (v: unknown, max = QUEUE_LEDGER_LIMITS.string): v is string => typeof v === "string" && v.length > 0 && v.length <= max
const safe = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const issue = (scopeKey: string | undefined, candidate: unknown, path: string, reason: string): QueueLedgerParseIssue => { const item = plain(candidate) ? candidate : {}; return { ...(scopeKey ? { scopeKey } : {}), ...(str(item.queueItemID) ? { queueItemID: item.queueItemID } : {}), ...(str(item.operationID) ? { operationID: item.operationID } : {}), path, reason } }
export const queueLedgerScopeKey = (scope: QueueLedgerScope): string => scope.state === "bound" ? `bound:${JSON.stringify([scope.transportIdentity, scope.directory, scope.sessionID])}` : `unbound-legacy:${JSON.stringify([scope.sessionID])}`
export const parseQueueLedgerScopeKey = (key: unknown): QueueLedgerScope | undefined => {
  if (typeof key !== "string") return undefined
  const parsed = key.startsWith("bound:") ? (() => { try { return JSON.parse(key.slice("bound:".length)) } catch { return undefined } })() : key.startsWith("unbound-legacy:") ? (() => { try { return JSON.parse(key.slice("unbound-legacy:".length)) } catch { return undefined } })() : undefined
  const candidate = key.startsWith("bound:") && Array.isArray(parsed) && parsed.length === 3 ? { state: "bound", transportIdentity: parsed[0], directory: parsed[1], sessionID: parsed[2] } : key.startsWith("unbound-legacy:") && Array.isArray(parsed) && parsed.length === 1 ? { state: "unbound-legacy", sessionID: parsed[0] } : undefined
  const value = scope(candidate)
  return value && queueLedgerScopeKey(value) === key ? value : undefined
}
export const emptyQueueLedgerSnapshot = (): QueueLedgerSnapshotV4 => ({ version: 4, queues: {}, migration: { v3State: "pending" } })
const scope = (v: unknown): QueueLedgerScope | undefined => !plain(v) || !str(v.state) ? undefined : v.state === "bound" && only(v, ["state", "transportIdentity", "directory", "sessionID"]) && str(v.transportIdentity) && str(v.directory) && str(v.sessionID) ? { state: "bound", transportIdentity: v.transportIdentity, directory: v.directory, sessionID: v.sessionID } : v.state === "unbound-legacy" && only(v, ["state", "sessionID"]) && str(v.sessionID) ? { state: "unbound-legacy", sessionID: v.sessionID } : undefined
const occurrenceMatches = (value: string, attachmentID: string): boolean => { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) && ((parsed.length === 2 && parsed[0] === "root" && parsed[1] === attachmentID) || (parsed.length === 3 && typeof parsed[1] === "string" && parsed[0] === "part" && parsed[2] === attachmentID)) } catch { return false } }
const attachmentFields = ["attachmentID", "occurrenceRefID", "filename", "mimeType", "size", "source", "serverPath", "vscodePath", "vscodeSource"] as const
type QueueAttachmentMeta = QueueAttachmentFieldsDTO
const attachmentMeta = (v: Record<string, unknown>): QueueAttachmentMeta | undefined => {
  if (!str(v.attachmentID) || !str(v.occurrenceRefID) || !occurrenceMatches(v.occurrenceRefID, v.attachmentID) || !str(v.filename) || typeof v.mimeType !== "string" || v.mimeType.length > QUEUE_LEDGER_LIMITS.string || !safe(v.size)) return undefined
  const fields = { attachmentID: v.attachmentID, occurrenceRefID: v.occurrenceRefID, filename: v.filename, mimeType: v.mimeType, size: v.size }
  if (v.source === "local" && v.serverPath === undefined && v.vscodePath === undefined && v.vscodeSource === undefined) return { ...fields, source: "local" }
  if (v.source === "server" && str(v.serverPath) && v.vscodePath === undefined && v.vscodeSource === undefined) return { ...fields, source: "server", serverPath: v.serverPath }
  if (v.source === "vscode" && v.serverPath === undefined && str(v.vscodePath) && (v.vscodeSource === "file" || v.vscodeSource === "selection")) return { ...fields, source: "vscode", vscodePath: v.vscodePath, vscodeSource: v.vscodeSource }
  return undefined
}
export const parseQueueAttachmentRefDTO = (v: unknown): QueueAttachmentRefDTO | undefined => {
  if (!plain(v) || !only(v, [...attachmentFields, "version", "locator"]) || v.version !== 1) return undefined
  const meta = attachmentMeta(v); if (!meta || !plain(v.locator)) return undefined
  const locator = v.locator.kind === "blob" && only(v.locator, ["kind", "blobID"]) && str(v.locator.blobID) ? { kind: "blob" as const, blobID: v.locator.blobID } : v.locator.kind === "url" && only(v.locator, ["kind", "url"]) && isDurableURL(v.locator.url) ? { kind: "url" as const, url: v.locator.url } : undefined
  return locator ? { version: 1, ...meta, locator } : undefined
}
const parseIssue = (v: unknown): QueueAttachmentIssueDTO | undefined => {
  if (!plain(v) || !only(v, [...attachmentFields, "reason"])) return undefined
  const meta = attachmentMeta(v)
  return meta && ["legacy-blob-url", "legacy-bytes-missing", "legacy-unbound-data", "missing-blob"].includes(v.reason as string) ? { ...meta, reason: v.reason as QueueAttachmentIssueDTO["reason"] } : undefined
}
const parseComposerDocument = (value: unknown, content: string): DraftComposerDocument | undefined => {
  if (!plain(value) || !only(value, ["text", "references"]) || typeof value.text !== "string") return undefined
  const document = parseDraftComposerDocument(value.text, value.references)
  const serialized = document && serializeComposerDocument(document, "queue-canonical")
  return serialized && serialized.ok && serialized.text === content ? document : undefined
}
const parseComposerMentions = (value: unknown, document: DraftComposerDocument | undefined): DraftMention[] | undefined => {
  if (value === undefined) return []
  if (!document) return undefined
  const mentions = parseDraftMentions(document.text, value)
  return !mentions || mentions.some((mention) => document.references.some((reference) => mention.range.start < reference.end && reference.start < mention.range.end)) ? undefined : mentions
}
const parseItem = (v: unknown, normalizeSending: boolean): QueueItemDTO | undefined => {
  const keys = ["version", "queueItemID", "operationID", "messageID", "owner", "content", "composerDocument", "composerMentions", "attachments", "attachmentIssues", "createdAt", "sendConfig", "status", "attemptCount", "nextAttemptAt", "reconciliationStartedAt", "reconciliationDeadlineAt", "reconciliationChecks", "reconciliationNextCheckAt", "failureKind"]
  if (!plain(v) || !only(v, keys) || v.version !== 1 || !str(v.queueItemID) || !str(v.operationID) || !str(v.messageID) || typeof v.content !== "string" || v.content.length > QUEUE_LEDGER_LIMITS.content || !safe(v.createdAt) || !safe(v.attemptCount) || !Array.isArray(v.attachments) || v.attachments.length > QUEUE_LEDGER_LIMITS.attachmentsPerItem || !Array.isArray(v.attachmentIssues) || v.attachmentIssues.length > QUEUE_LEDGER_LIMITS.issuesPerItem || !["queued", "sending", "retrying", "reconciling", "unresolved", "failed"].includes(v.status as string)) return undefined
  const owner = scope(v.owner), attachments = v.attachments.map(parseQueueAttachmentRefDTO), attachmentIssues = v.attachmentIssues.map(parseIssue), composerDocument = v.composerDocument === undefined ? undefined : parseComposerDocument(v.composerDocument, v.content), composerMentions = parseComposerMentions(v.composerMentions, composerDocument)
  if (!owner || (v.composerDocument !== undefined && !composerDocument) || (v.composerMentions !== undefined && !composerMentions) || !attachments.every(Boolean) || !attachmentIssues.every(Boolean)) return undefined
  const attachmentIDs = new Set((attachments as QueueAttachmentRefDTO[]).map((attachment) => attachment.occurrenceRefID))
  const referencedAttachmentIDs = new Set(composerDocument ? describeComposerDocumentResources(composerDocument).flatMap((resource) => resource.type === "attachment" ? [resource.attachmentRefID] : []) : [])
  if (attachmentIDs.size !== attachments.length || new Set((attachmentIssues as QueueAttachmentIssueDTO[]).map((x) => x.occurrenceRefID)).size !== attachmentIssues.length || (attachmentIssues as QueueAttachmentIssueDTO[]).some((x) => attachmentIDs.has(x.occurrenceRefID)) || [...referencedAttachmentIDs].some((id) => !attachmentIDs.has(id)) || (v.sendConfig !== undefined && (!plain(v.sendConfig) || !only(v.sendConfig, ["providerID", "modelID", "agent", "variant"]) || !str(v.sendConfig.providerID) || !str(v.sendConfig.modelID) || [v.sendConfig.agent, v.sendConfig.variant].some((x) => x !== undefined && !str(x))))) return undefined
  const numeric = [v.nextAttemptAt, v.reconciliationStartedAt, v.reconciliationDeadlineAt, v.reconciliationChecks, v.reconciliationNextCheckAt]
  const reconciliation = v.reconciliationStartedAt !== undefined && v.reconciliationDeadlineAt !== undefined && v.reconciliationChecks !== undefined && (v.reconciliationDeadlineAt as number) >= (v.reconciliationStartedAt as number)
  const noReconciliation = v.reconciliationStartedAt === undefined && v.reconciliationDeadlineAt === undefined && v.reconciliationChecks === undefined && v.reconciliationNextCheckAt === undefined
  const noRetry = v.nextAttemptAt === undefined
  const noFailure = v.failureKind === undefined
  const stateValid = v.status === "queued" || v.status === "sending" ? noRetry && noReconciliation && noFailure && attachmentIssues.length === 0 : v.status === "retrying" ? v.nextAttemptAt !== undefined && v.failureKind === "pre-dispatch" && noReconciliation && attachmentIssues.length === 0 : v.status === "reconciling" ? noRetry && reconciliation && v.failureKind === "ambiguous-dispatch" && attachmentIssues.length === 0 : v.status === "unresolved" ? (noRetry && reconciliation && v.failureKind === "ambiguous-dispatch" && attachmentIssues.length === 0) || (noRetry && noReconciliation && noFailure && attachmentIssues.length > 0) : noRetry && noReconciliation && v.failureKind === "definitive" && attachmentIssues.length === 0
  if (numeric.some((x) => x !== undefined && !safe(x)) || !stateValid) return undefined
  const sending = v.status === "sending" && normalizeSending, deadline = sending ? v.createdAt + 30_000 : v.reconciliationDeadlineAt
  if (sending && !safe(deadline)) return undefined
  const started = sending ? v.createdAt : v.reconciliationStartedAt, checks = sending ? 0 : v.reconciliationChecks
  return { version: 1, queueItemID: v.queueItemID, operationID: v.operationID, messageID: v.messageID, owner, content: v.content, ...(composerDocument ? { composerDocument } : {}), ...(composerMentions?.length ? { composerMentions } : {}), attachments: attachments as QueueAttachmentRefDTO[], attachmentIssues: attachmentIssues as QueueAttachmentIssueDTO[], createdAt: v.createdAt, ...(v.sendConfig ? { sendConfig: clone(v.sendConfig) as QueueItemDTO["sendConfig"] } : {}), status: sending ? "reconciling" : v.status as QueueItemDTO["status"], attemptCount: v.attemptCount, ...(v.nextAttemptAt === undefined ? {} : { nextAttemptAt: v.nextAttemptAt as number }), ...(started === undefined ? {} : { reconciliationStartedAt: started as number, reconciliationDeadlineAt: deadline! as number, reconciliationChecks: checks! as number, ...(v.reconciliationNextCheckAt === undefined ? {} : { reconciliationNextCheckAt: v.reconciliationNextCheckAt as number }) }), ...(sending ? { failureKind: "ambiguous-dispatch" as const } : v.failureKind ? { failureKind: v.failureKind as QueueItemDTO["failureKind"] } : {}) }
}
export const parseQueueLedgerSnapshot = (v: unknown, options: { normalizeSending?: boolean } = {}): QueueLedgerParseResult => {
  const corrupt = (reason: string) => ({ status: "corrupt" as const, snapshot: emptyQueueLedgerSnapshot(), issues: [issue(undefined, undefined, "$", reason)], degradedScopeKeys: [] })
  if (!plain(v) || !only(v, ["version", "queues", "migration"]) || v.version !== 4 || !plain(v.queues) || !plain(v.migration) || !only(v.migration, ["v3State"]) || !["pending", "complete", "degraded"].includes(v.migration.v3State as string) || Object.keys(v.queues).length > QUEUE_LEDGER_LIMITS.scopes) return corrupt("snapshot")
  let count = 0; const queues: Record<string, QueueItemDTO[]> = {}, issues: QueueLedgerParseIssue[] = [], degraded = new Set<string>(), queueItemIDs = new Map<string, string>(), operationIDs = new Map<string, string>(), messageIDs = new Map<string, string>()
  const add = (scopeKey: string, candidate: unknown, path: string, reason: string) => { issues.push(issue(scopeKey, candidate, path, reason)); degraded.add(scopeKey) }
  for (const [key, raw] of Object.entries(v.queues)) {
    if (!parseQueueLedgerScopeKey(key)) { add(key, raw, `$.queues.${JSON.stringify(key)}`, "scope"); continue }
    if (!Array.isArray(raw)) { add(key, raw, `$.queues.${JSON.stringify(key)}`, "queue"); continue }
    const valid: QueueItemDTO[] = []
    for (let index = 0; index < raw.length; index++) {
      if (++count > QUEUE_LEDGER_LIMITS.totalItems) return corrupt("item-limit")
      const candidate = raw[index], path = `$.queues.${JSON.stringify(key)}[${index}]`, parsed = parseItem(candidate, options.normalizeSending === true)
      if (!parsed || queueLedgerScopeKey(parsed.owner) !== key) { add(key, candidate, path, "item"); continue }
      const duplicate = [[queueItemIDs, parsed.queueItemID, "duplicate-queue-item-id"], [operationIDs, parsed.operationID, "duplicate-operation-id"], [messageIDs, parsed.messageID, "duplicate-message-id"]] as const
      const duplicateEntry = duplicate.find(([ids, id]) => ids.has(id))
      if (duplicateEntry) { const [ids, , reason] = duplicateEntry; add(key, candidate, path, reason); degraded.add(ids.get(duplicateEntry[1])!); continue }
      queueItemIDs.set(parsed.queueItemID, key); operationIDs.set(parsed.operationID, key); messageIDs.set(parsed.messageID, key); valid.push(parsed)
    }
    if (valid.length) queues[key] = valid
  }
  return { status: "ok", snapshot: clone({ version: 4, queues, migration: { v3State: v.migration.v3State as QueueLedgerSnapshotV4["migration"]["v3State"] } }), issues, degradedScopeKeys: [...degraded] }
}
export const serializeQueueLedgerSnapshot = (snapshot: QueueLedgerSnapshotV4): QueueLedgerResult<string> => { const parsed = parseQueueLedgerSnapshot(snapshot); if (parsed.status === "corrupt" || parsed.issues.length) return { ok: false, error: { code: "corrupt" } }; try { return { ok: true, value: JSON.stringify(parsed.snapshot) } } catch { return { ok: false, error: { code: "serialization" } } } }
const unavailable = <T>(): QueueLedgerResult<T> => ({ ok: false, error: { code: "unavailable" } })
const storageResult = <T>(error: unknown): QueueLedgerResult<T> => ({ ok: false, error: { code: error instanceof DOMException && error.name === "QuotaExceededError" ? "quota" : "unavailable" } })
export const createQueueLedgerStorageSink = (storage: Storage | null | undefined): QueueLedgerMetadataSink => ({ read: async (key) => { if (!storage) return unavailable(); try { return { ok: true, value: storage.getItem(key) } } catch (error) { return storageResult(error) } }, write: async (key, value) => { if (!storage) return unavailable(); try { storage.setItem(key, value); return { ok: true, value: undefined } } catch (error) { return storageResult(error) } }, remove: async (key) => { if (!storage) return unavailable(); try { storage.removeItem(key); return { ok: true, value: undefined } } catch (error) { return storageResult(error) } } })
export const createDefaultQueueLedgerSink = (): QueueLedgerMetadataSink => { try { return createQueueLedgerStorageSink(typeof window === "undefined" ? null : window.localStorage) } catch { return createQueueLedgerStorageSink(null) } }
export const readQueueLedgerSnapshotDetailed = async (sink: QueueLedgerMetadataSink): Promise<QueueLedgerResult<QueueLedgerDetailedRead>> => { const read = await sink.read(MESSAGE_QUEUE_LEDGER_KEY); if (!read.ok) return read; if (read.value === null) return { ok: true, value: { raw: null, snapshot: null, status: "empty", issues: [], degradedScopeKeys: [] } }; try { const parsed = parseQueueLedgerSnapshot(JSON.parse(read.value), { normalizeSending: true }); return { ok: true, value: { raw: read.value, snapshot: parsed.status === "ok" ? parsed.snapshot : null, status: parsed.status === "corrupt" ? "corrupt" : parsed.issues.length ? "partial" : "ok", issues: parsed.issues, degradedScopeKeys: parsed.degradedScopeKeys } } } catch { return { ok: true, value: { raw: read.value, snapshot: null, status: "corrupt", issues: [issue(undefined, undefined, "$", "json")], degradedScopeKeys: [] } } } }
export const readQueueLedgerSnapshot = async (sink: QueueLedgerMetadataSink): Promise<QueueLedgerResult<QueueLedgerSnapshotV4 | null>> => { const detailed = await readQueueLedgerSnapshotDetailed(sink); if (!detailed.ok) return detailed; return detailed.value.status === "empty" ? { ok: true, value: null } : detailed.value.status === "ok" ? { ok: true, value: detailed.value.snapshot! } : { ok: false, error: { code: "corrupt" } } }
export const writeQueueLedgerSnapshot = async (sink: QueueLedgerMetadataSink, snapshot: QueueLedgerSnapshotV4): Promise<QueueLedgerResult<void>> => { const encoded = serializeQueueLedgerSnapshot(snapshot); return encoded.ok ? sink.write(MESSAGE_QUEUE_LEDGER_KEY, encoded.value) : encoded }
export type QueueLedgerRepository = { readDetailed?: () => Promise<QueueLedgerResult<QueueLedgerDetailedRead>>; read?: () => Promise<QueueLedgerResult<QueueLedgerSnapshotV4 | null>>; persist: (snapshot: QueueLedgerSnapshotV4) => Promise<QueueLedgerResult<void>>; flush: () => Promise<void>; setEnabled: (enabled: boolean) => Promise<void>; cancelPending: () => void }
export const createQueueLedgerRepository = (sink: QueueLedgerMetadataSink): QueueLedgerRepository => {
  let enabled = true, pending: Array<{ snapshot: QueueLedgerSnapshotV4; resolve: (value: QueueLedgerResult<void>) => void }> = [], running = false; const waiters = new Set<() => void>()
  const settle = () => { if (!running && pending.length === 0) { for (const resolve of waiters) resolve(); waiters.clear() } }
  const drain = () => { if (running) return; const next = pending.shift(); if (!next) { settle(); return }; running = true; void writeQueueLedgerSnapshot(sink, next.snapshot).then(next.resolve).finally(() => { running = false; drain() }) }
  const cancel = () => { const cancelled = pending; pending = []; cancelled.forEach((entry) => entry.resolve({ ok: false, error: { code: "cancelled" } })); settle() }
  return { readDetailed: () => readQueueLedgerSnapshotDetailed(sink), read: () => readQueueLedgerSnapshot(sink), persist: (snapshot) => { if (!enabled) return Promise.resolve({ ok: false, error: { code: "cancelled" } }); const parsed = parseQueueLedgerSnapshot(snapshot); if (parsed.status === "corrupt" || parsed.issues.length) return Promise.resolve({ ok: false, error: { code: "corrupt" } }); const queued = clone(parsed.snapshot); return new Promise((resolve) => { pending.push({ snapshot: queued, resolve }); drain() }) }, flush: () => !running && pending.length === 0 ? Promise.resolve() : new Promise((resolve) => waiters.add(resolve)), setEnabled: async (next) => { enabled = next; if (!enabled) cancel(); await (!running && pending.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiters.add(resolve))) }, cancelPending: cancel }
}
