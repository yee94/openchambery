import { createIndexedDBTranscriptDurableStore } from "../../ui/src/sync/transcript-durable-store-indexeddb"
import type { TranscriptDurableScope, TranscriptDurableStore } from "../../ui/src/sync/transcript-durable-store"
import type { Message, Part } from "@opencode-ai/sdk/v2"

type Evidence = { name: string }

const DATABASE_NAME = "openchamber-transcript-durable-evidence"

const SCOPE: TranscriptDurableScope = {
  transport: "local",
  generation: 1,
  directory: "/workspace",
  sessionID: "ses_1",
}

const expect: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const user = (id: string, created: number, text = id): { info: Message; parts: Part[] } => ({
  info: { id, sessionID: SCOPE.sessionID, role: "user", time: { created } } as Message,
  parts: [{ id: `${id}-p`, messageID: id, sessionID: SCOPE.sessionID, type: "text", text } as Part],
})

const assistant = (
  id: string,
  created: number,
  input: { finish?: string; text?: string; slim?: boolean } = {},
): { info: Message; parts: Part[] } => ({
  info: {
    id,
    sessionID: SCOPE.sessionID,
    role: "assistant",
    time: { created },
    ...(input.finish ? { finish: input.finish } : {}),
  } as Message,
  parts: [{
    id: `${id}-p`,
    messageID: id,
    sessionID: SCOPE.sessionID,
    type: "text",
    text: input.text ?? "done",
    ...(input.slim ? { slim: true } : {}),
  } as Part],
})

const openStore = (): TranscriptDurableStore => createIndexedDBTranscriptDurableStore({ databaseName: DATABASE_NAME })

const idsOf = async (store: TranscriptDurableStore): Promise<string[]> =>
  (await store.readSession(SCOPE)).records.map((record) => record.messageID)

const deleteTestDatabase = (): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(DATABASE_NAME)
  request.onsuccess = () => resolve()
  request.onerror = () => reject(request.error ?? new DOMException("Database cleanup failed", "UnknownError"))
  request.onblocked = () => reject(new DOMException("Database cleanup blocked", "InvalidStateError"))
})

const databaseExists = async (): Promise<boolean> => {
  if (!indexedDB.databases) return false
  const databases = await indexedDB.databases()
  return databases.some((database) => database.name === DATABASE_NAME)
}

const run = async (): Promise<Evidence[]> => {
  const evidence: Evidence[] = []
  await deleteTestDatabase()

  const first = openStore()
  const persisted = user("msg_persist", 10, "still-here")
  expect((await first.upsertSettled(SCOPE, persisted.info, persisted.parts)).status === "written", "persist write failed")
  const reopened = openStore()
  const reopenedRow = await reopened.readMessage(SCOPE, "msg_persist")
  expect(reopenedRow?.contentHash === (await first.readMessage(SCOPE, "msg_persist"))?.contentHash, "reopen lost the persisted hash")
  expect((reopenedRow?.parts[0] as { text?: string } | undefined)?.text === "still-here", "reopen lost persisted parts")
  evidence.push({ name: "reopen persists across store instances" })

  const full = assistant("msg_asst", 20, { finish: "stop", text: "full body" })
  expect((await reopened.upsertSettled(SCOPE, full.info, full.parts)).status === "written", "full write failed")
  const slim = assistant("msg_asst", 20, { finish: "stop", text: "summary", slim: true })
  const downgrade = await reopened.upsertSettled(SCOPE, slim.info, slim.parts)
  expect(downgrade.status === "skipped" && downgrade.reason === "slim-downgrade", "slim downgrade was not skipped")
  const afterSlim = openStore()
  const kept = await afterSlim.readMessage(SCOPE, "msg_asst")
  expect(kept?.completeness === "full", "reopen promoted a slim record")
  expect((kept?.parts[0] as { text?: string } | undefined)?.text === "full body", "reopen lost the full body")
  evidence.push({ name: "full record outranks slim after reopen" })

  const older = user("msg_a", 30, "aaaa")
  const middle = user("msg_b", 40, "bbbb")
  const newer = user("msg_c", 50, "cccc")
  expect((await afterSlim.upsertSettled(SCOPE, older.info, older.parts)).status === "written", "delete setup a failed")
  expect((await afterSlim.upsertSettled(SCOPE, middle.info, middle.parts)).status === "written", "delete setup b failed")
  expect((await afterSlim.upsertSettled(SCOPE, newer.info, newer.parts)).status === "written", "delete setup c failed")
  await afterSlim.removeMessage(SCOPE, "msg_b")
  const afterDelete = openStore()
  const remaining = await idsOf(afterDelete)
  expect(remaining.includes("msg_a") && remaining.includes("msg_c") && !remaining.includes("msg_b"), "delete did not survive reopen")
  expect(await afterDelete.readMessage(SCOPE, "msg_b") === undefined, "deleted message reappeared")
  evidence.push({ name: "removeMessage persists across reopen" })

  await afterDelete.destroy()
  const evictStore = openStore()
  const firstWrite = await evictStore.upsertSettled(SCOPE, user("msg_old", 60, "aaaaaaaa").info, user("msg_old", 60, "aaaaaaaa").parts)
  const secondWrite = await evictStore.upsertSettled(SCOPE, user("msg_mid", 70, "bbbbbbbb").info, user("msg_mid", 70, "bbbbbbbb").parts)
  const thirdWrite = await evictStore.upsertSettled(SCOPE, user("msg_new", 80, "cccccccc").info, user("msg_new", 80, "cccccccc").parts)
  expect(firstWrite.status === "written" && secondWrite.status === "written" && thirdWrite.status === "written", "evict setup failed")
  if (firstWrite.status !== "written" || secondWrite.status !== "written" || thirdWrite.status !== "written") return evidence
  expect((await evictStore.upsertSettled(SCOPE, user("msg_old", 60, "aaaaaaaa").info, user("msg_old", 60, "aaaaaaaa").parts)).status === "skipped", "evict touch was not skipped")
  const budget = firstWrite.record.byteSize + thirdWrite.record.byteSize
  const evicted = await evictStore.evictToBytes(budget)
  expect(evicted.evicted === 1 && evicted.freedBytes === secondWrite.record.byteSize, "LRU did not drop the untouched mid row")
  const afterEvict = openStore()
  const evictedIds = await idsOf(afterEvict)
  expect(evictedIds.includes("msg_old") && evictedIds.includes("msg_new") && !evictedIds.includes("msg_mid"), "LRU eviction did not survive reopen")
  evidence.push({ name: "evictToBytes LRU persists across reopen" })

  await afterEvict.destroy()
  const empty = openStore()
  expect((await empty.readSession(SCOPE)).records.length === 0, "destroy left records in a new instance")
  await empty.destroy()
  expect(await databaseExists() === false, "destroy did not delete the IndexedDB database")
  evidence.push({ name: "destroy deletes the database" })

  return evidence
}

declare global {
  interface Window {
    __OPENCHAMBER_TRANSCRIPT_DURABLE_INDEXEDDB_EVIDENCE__?: Promise<{ ok: true; evidence: Evidence[] } | { ok: false; error: string }>
  }
}

window.__OPENCHAMBER_TRANSCRIPT_DURABLE_INDEXEDDB_EVIDENCE__ = run()
  .then(async (evidence) => {
    try { await deleteTestDatabase() } catch { /* Evidence already recorded destroy; leftover cleanup is best-effort. */ }
    return { ok: true as const, evidence }
  })
  .catch(async (error) => {
    try { await deleteTestDatabase() } catch { /* Cleanup failure is reported with the test failure. */ }
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  })
