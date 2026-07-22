import { expect, test } from "bun:test"
import { createQueueLedgerRepository, parseQueueAttachmentRefDTO, parseQueueLedgerScopeKey, parseQueueLedgerSnapshot, QUEUE_LEDGER_LIMITS, queueLedgerScopeKey, readQueueLedgerSnapshot, readQueueLedgerSnapshotDetailed, serializeQueueLedgerSnapshot, type QueueAttachmentIssueDTO, type QueueItemDTO, type QueueLedgerMetadataSink, type QueueLedgerSnapshotV4 } from "./message-queue-ledger"

const item = (ids = ["q", "o", "m"]): QueueItemDTO => ({ version: 1, queueItemID: ids[0]!, operationID: ids[1]!, messageID: ids[2]!, owner: { state: "bound", transportIdentity: "t", directory: "/d", sessionID: "s" }, content: "text", attachments: [], attachmentIssues: [], createdAt: 1, status: "queued", attemptCount: 0 })
const snapshot = (...items: QueueItemDTO[]): QueueLedgerSnapshotV4 => ({ version: 4, queues: { [queueLedgerScopeKey(items[0]?.owner ?? item().owner)]: items }, migration: { v3State: "complete" } })
const sink = (raw: string | null, write: (value: string) => Promise<{ ok: true; value: undefined }> = async () => ({ ok: true, value: undefined })) : QueueLedgerMetadataSink => ({ read: async () => ({ ok: true, value: raw }), write: async (_key, value) => write(value), remove: async () => ({ ok: true, value: undefined }) })
const attachmentIssue = (): QueueAttachmentIssueDTO => ({ attachmentID: "a", occurrenceRefID: '["root","a"]', filename: "a", mimeType: "text/plain", size: 1, source: "local", reason: "missing-blob" })

test("partial reads retain raw, issues, and degraded scopes while compatibility read is corrupt", async () => { const valid = item(), key = queueLedgerScopeKey(valid.owner), raw = JSON.stringify({ version: 4, queues: { [key]: [valid, { queueItemID: "bad", operationID: "op", broken: true }] }, migration: { v3State: "complete" } }), detailed = await readQueueLedgerSnapshotDetailed(sink(raw)); if (!detailed.ok) throw new Error("read failed"); expect(detailed.value.status).toBe("partial"); expect(detailed.value.raw).toBe(raw); expect(detailed.value.snapshot?.queues[key]).toEqual([valid]); expect(detailed.value.issues[0]?.scopeKey).toBe(key); expect(detailed.value.issues[0]?.queueItemID).toBe("bad"); expect(detailed.value.issues[0]?.operationID).toBe("op"); expect(typeof detailed.value.issues[0]?.path).toBe("string"); expect(detailed.value.degradedScopeKeys).toEqual([key]); expect((await readQueueLedgerSnapshot(sink(raw))).ok).toBe(false) })
test("null, corrupt, and full reads preserve their distinct outcomes", async () => { const empty = await readQueueLedgerSnapshotDetailed(sink(null)); if (!empty.ok) throw new Error("read failed"); expect(empty.value.status).toBe("empty"); const corrupt = await readQueueLedgerSnapshotDetailed(sink("{")); if (!corrupt.ok) throw new Error("read failed"); expect(corrupt.value.raw).toBe("{"); expect(corrupt.value.status).toBe("corrupt"); const full = await readQueueLedgerSnapshotDetailed(sink(JSON.stringify(snapshot(item())))); expect(full.ok).toBe(true) })
test("top-level limits and malformed top-level values are corrupt", () => { expect(parseQueueLedgerSnapshot({ version: 4, queues: new Map(), migration: { v3State: "complete" } }).status).toBe("corrupt"); const queues = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`x${index}`, []])); expect(parseQueueLedgerSnapshot({ version: 4, queues, migration: { v3State: "complete" } }).status).toBe("corrupt"); const many = Array.from({ length: 2049 }, (_, index) => item([`q${index}`, `o${index}`, `m${index}`])); expect(parseQueueLedgerSnapshot(snapshot(...many)).status).toBe("corrupt") })
test("global queue, operation, and message IDs degrade every involved scope", () => { const reasons = { queueItemID: "duplicate-queue-item-id", operationID: "duplicate-operation-id", messageID: "duplicate-message-id" } as const; for (const duplicate of ["queueItemID", "operationID", "messageID"] as const) { const first = item(["q1", "o1", "m1"]), second = item(["q2", "o2", "m2"]); second[duplicate] = first[duplicate]; second.owner = { ...second.owner, sessionID: "s2" }; const value = { version: 4 as const, queues: { [queueLedgerScopeKey(first.owner)]: [first], [queueLedgerScopeKey(second.owner)]: [second] }, migration: { v3State: "complete" as const } }; const parsed = parseQueueLedgerSnapshot(value); expect(parsed.issues[0]?.reason).toBe(reasons[duplicate]); expect(parsed.degradedScopeKeys).toHaveLength(2) } })
test("state matrix accepts each legal persisted state and rejects residue", () => { const legal: QueueItemDTO[] = [item(), { ...item(["q2", "o2", "m2"]), status: "sending" }, { ...item(["q3", "o3", "m3"]), status: "retrying", nextAttemptAt: 2, failureKind: "pre-dispatch" }, { ...item(["q4", "o4", "m4"]), status: "reconciling", reconciliationStartedAt: 1, reconciliationDeadlineAt: 2, reconciliationChecks: 0, failureKind: "ambiguous-dispatch" }, { ...item(["q5", "o5", "m5"]), status: "unresolved", reconciliationStartedAt: 1, reconciliationDeadlineAt: 2, reconciliationChecks: 0, failureKind: "ambiguous-dispatch" }, { ...item(["q6", "o6", "m6"]), status: "unresolved", attachmentIssues: [attachmentIssue()] }, { ...item(["q7", "o7", "m7"]), status: "failed", failureKind: "definitive" }]; for (const value of legal) expect(parseQueueLedgerSnapshot(snapshot(value)).issues).toHaveLength(0); const invalid = { ...legal[3]!, reconciliationDeadlineAt: 0 }; expect(parseQueueLedgerSnapshot(snapshot(invalid)).issues).toHaveLength(1) })
test("attachment issue bounds, occurrence identity, and conflicts are partial", () => { const invalid = item(); invalid.status = "unresolved"; invalid.attachmentIssues = [attachmentIssue(), attachmentIssue()]; expect(parseQueueLedgerSnapshot(snapshot(invalid)).issues).toHaveLength(1); invalid.attachmentIssues = Array.from({ length: 65 }, attachmentIssue); expect(parseQueueLedgerSnapshot(snapshot(invalid)).issues).toHaveLength(1); invalid.attachmentIssues = [attachmentIssue()]; invalid.attachments = [{ version: 1, attachmentID: "a", occurrenceRefID: '["root","a"]', filename: "a", mimeType: "text/plain", size: 1, source: "local", locator: { kind: "url", url: "https://example.test/a" } }]; expect(parseQueueLedgerSnapshot(snapshot(invalid)).issues).toHaveLength(1) })
test("serializer rejects unknown fields and runtime attachment values", () => { const value = item() as QueueItemDTO & { unknown?: boolean }; value.unknown = true; expect(serializeQueueLedgerSnapshot(snapshot(value)).ok).toBe(false); for (const url of ["data:text/plain,x", "blob:https://example.test/x"]) { const attached = item(); attached.attachments = [{ version: 1, attachmentID: "a", occurrenceRefID: '["root","a"]', filename: "a", mimeType: "text/plain", size: 1, source: "local", locator: { kind: "url", url } }]; expect(serializeQueueLedgerSnapshot(snapshot(attached)).ok).toBe(false) }; expect(parseQueueLedgerSnapshot(snapshot({ ...item(), attachments: [new Blob()] as never[] })).issues).toHaveLength(1); expect(parseQueueLedgerSnapshot(Object.assign(Object.create(null), snapshot(item()))).status).toBe("corrupt") })
test("serializer retains sending while hydration supplies ambiguous reconciliation", () => { const value = item(); value.status = "sending"; expect(serializeQueueLedgerSnapshot(snapshot(value)).ok).toBe(true); const hydrated = parseQueueLedgerSnapshot(snapshot(value), { normalizeSending: true }).snapshot.queues[queueLedgerScopeKey(value.owner)]![0]!; expect(hydrated.status).toBe("reconciling"); expect(hydrated.failureKind).toBe("ambiguous-dispatch"); expect(hydrated.reconciliationChecks).toBe(0) })
test("repository deep clones, resolves concurrent flushes, and converges disabled work", async () => { const releases: Array<() => void> = [], writes: string[] = []; const delayed = sink(null, async (value) => { writes.push(value); await new Promise<void>((resolve) => releases.push(resolve)); return { ok: true, value: undefined } }); const repository = createQueueLedgerRepository(delayed), first = snapshot(item()); const persisted = repository.persist(first); first.queues[queueLedgerScopeKey(item().owner)]![0]!.content = "changed"; const flushes = [repository.flush(), repository.flush(), repository.flush()]; await Promise.resolve(); releases.shift()!(); await persisted; await Promise.all(flushes); expect(JSON.parse(writes[0]!).queues[queueLedgerScopeKey(item().owner)][0].content).toBe("text"); const running = repository.persist(snapshot(item(["q2", "o2", "m2"]))); await Promise.resolve(); const pending = repository.persist(snapshot(item(["q3", "o3", "m3"]))); const disabled = repository.setEnabled(false); await Promise.resolve(); releases.shift()!(); const pendingResult = await pending; expect(pendingResult.ok).toBe(false); if (!pendingResult.ok) expect(pendingResult.error.code).toBe("cancelled"); await running; await disabled; const after = await repository.persist(snapshot(item(["q4", "o4", "m4"]))); expect(after.ok).toBe(false); if (!after.ok) expect(after.error.code).toBe("cancelled") })
test("attachment DTOs require complete metadata and enforce source matrices", () => {
  const base = { attachmentID: "a", occurrenceRefID: '["root","a"]', filename: "a", mimeType: "text/plain", size: 1 }
  const ref = (source: "local" | "server" | "vscode", fields = {}) => ({ version: 1, ...base, source, ...fields, locator: { kind: "url", url: "https://example.test/a" } })
  expect(parseQueueAttachmentRefDTO(ref("local"))).toBeDefined()
  expect(parseQueueAttachmentRefDTO(ref("server", { serverPath: "/a" }))).toBeDefined()
  expect(parseQueueAttachmentRefDTO(ref("vscode", { vscodePath: "/a", vscodeSource: "file" }))).toBeDefined()
  expect(parseQueueAttachmentRefDTO(ref("local", { serverPath: "/a" }))).toBe(undefined)
  expect(parseQueueAttachmentRefDTO(ref("local", { vscodePath: "/a", vscodeSource: "file" }))).toBe(undefined)
  expect(parseQueueAttachmentRefDTO(ref("server"))).toBe(undefined)
  expect(parseQueueAttachmentRefDTO(ref("server", { serverPath: "/a", vscodePath: "/b", vscodeSource: "file" }))).toBe(undefined)
  expect(parseQueueAttachmentRefDTO(ref("vscode", { vscodePath: "/a" }))).toBe(undefined)
  expect(parseQueueAttachmentRefDTO(ref("vscode", { vscodePath: "/a", vscodeSource: "file", serverPath: "/b" }))).toBe(undefined)
  const invalidIssue = { ...item(), status: "unresolved" as const, attachmentIssues: [{ ...base, source: "server", reason: "missing-blob" }] }
  expect(parseQueueLedgerSnapshot(snapshot(invalidIssue as QueueItemDTO)).issues).toHaveLength(1)
})
test("scope parser requires canonical bounded keys, including empty queues", () => {
  const bound = { state: "bound" as const, transportIdentity: "t", directory: "/d", sessionID: "s" }, unbound = { state: "unbound-legacy" as const, sessionID: "s" }
  expect(parseQueueLedgerScopeKey(queueLedgerScopeKey(bound))).toEqual(bound)
  expect(parseQueueLedgerScopeKey(queueLedgerScopeKey(unbound))).toEqual(unbound)
  expect(parseQueueLedgerScopeKey('bound:["t","/d","s"]')).toEqual(bound)
  expect(parseQueueLedgerScopeKey('bound: ["t","/d","s"]')).toBe(undefined)
  expect(parseQueueLedgerScopeKey('bound:["t","/d","s","extra"]')).toBe(undefined)
  expect(parseQueueLedgerScopeKey('["t","/d","s"]')).toBe(undefined)
  expect(parseQueueLedgerScopeKey(queueLedgerScopeKey({ ...bound, sessionID: "s".repeat(QUEUE_LEDGER_LIMITS.string) }))).toEqual({ ...bound, sessionID: "s".repeat(QUEUE_LEDGER_LIMITS.string) })
  expect(parseQueueLedgerScopeKey(queueLedgerScopeKey({ ...bound, sessionID: "s".repeat(QUEUE_LEDGER_LIMITS.string + 1) }))).toBe(undefined)
  const invalid = "bound:[\"t\",\"/d\",\"s\"] "
  const parsed = parseQueueLedgerSnapshot({ version: 4, queues: { [invalid]: [] }, migration: { v3State: "complete" } })
  expect(parsed.issues).toHaveLength(1); expect(parsed.degradedScopeKeys).toEqual([invalid]); expect(parsed.snapshot.queues).toEqual({})
})
test("sending hydration stays within safe integer time and normalized snapshots serialize", () => {
  const safeSending = { ...item(), status: "sending" as const, createdAt: Number.MAX_SAFE_INTEGER - 30_000 }
  const hydrated = parseQueueLedgerSnapshot(snapshot(safeSending), { normalizeSending: true })
  expect(hydrated.issues).toHaveLength(0)
  expect(hydrated.snapshot.queues[queueLedgerScopeKey(safeSending.owner)]![0]!.reconciliationDeadlineAt).toBe(Number.MAX_SAFE_INTEGER)
  const serialized = serializeQueueLedgerSnapshot(hydrated.snapshot)
  expect(serialized.ok).toBe(true)
  if (serialized.ok) expect(parseQueueLedgerSnapshot(JSON.parse(serialized.value)).snapshot).toEqual(hydrated.snapshot)
  const overflow = { ...item(), status: "sending" as const, createdAt: Number.MAX_SAFE_INTEGER - 29_999 }
  const invalid = parseQueueLedgerSnapshot(snapshot(overflow), { normalizeSending: true })
  expect(invalid.issues).toHaveLength(1); expect(invalid.snapshot.queues[queueLedgerScopeKey(overflow.owner)]).toBe(undefined)
})
test("composer sidecars require strict ranges and matching queue canonical content", () => {
  const sidecar: NonNullable<QueueItemDTO["composerDocument"]> = { text: "@Session", references: [{ id: "s", kind: "session", sessionId: "session", display: "@Session", start: 0, end: 8 }] }
  const valid = { ...item(), content: "@session:session", composerDocument: sidecar }
  expect(parseQueueLedgerSnapshot(snapshot(valid)).issues).toHaveLength(0)
  expect(parseQueueLedgerSnapshot(snapshot({ ...valid, content: "drift" })).issues).toHaveLength(1)
  expect(parseQueueLedgerSnapshot(snapshot({ ...valid, composerDocument: { ...sidecar, references: [{ ...sidecar.references[0], end: 9 }] } })).issues).toHaveLength(1)
})
test("composer ledger sidecars retain durable skill and command references", () => {
  const sidecar: NonNullable<QueueItemDTO["composerDocument"]> = { text: "/review /run", references: [
    { id: "skill", kind: "skill", skillName: "review", display: "/review", start: 0, end: 7 },
    { id: "command", kind: "command", commandName: "run", reference: "task-42", display: "/run", start: 8, end: 12 },
  ] }
  expect(parseQueueLedgerSnapshot(snapshot({ ...item(), content: "[skill:review] [command:task-42]", composerDocument: sidecar })).issues).toHaveLength(0)
})
