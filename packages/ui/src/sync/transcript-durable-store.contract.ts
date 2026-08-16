/**
 * Adapter-agnostic contract for TranscriptDurableStore.
 *
 * Assertions stay on the public surface: timeline order, identity isolation,
 * slim/full precedence, settled writes, hash skip, and post-delete / post-evict
 * session consistency. Internal map/table fields are out of scope so IndexedDB
 * and SQLite can reuse this suite unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import type {
  TranscriptDurableScope,
  TranscriptDurableStore,
  TranscriptDurableRecord,
} from "./transcript-durable-store"

export type TranscriptDurableStoreFactory = () => TranscriptDurableStore | Promise<TranscriptDurableStore>

const SCOPE: TranscriptDurableScope = {
  transport: "local",
  generation: 1,
  directory: "/workspace",
  sessionID: "ses_1",
}

const otherScope = (patch: Partial<TranscriptDurableScope>): TranscriptDurableScope => ({
  ...SCOPE,
  ...patch,
})

const userInfo = (id: string, created: number): Message =>
  ({
    id,
    sessionID: SCOPE.sessionID,
    role: "user",
    time: { created },
  }) as Message

const assistantInfo = (
  id: string,
  created: number,
  settled?: { finish?: string; completed?: number },
): Message =>
  ({
    id,
    sessionID: SCOPE.sessionID,
    role: "assistant",
    time: { created, ...(settled?.completed !== undefined ? { completed: settled.completed } : {}) },
    ...(settled?.finish ? { finish: settled.finish } : {}),
  }) as Message

const textPart = (id: string, messageID: string, text: string, slim = false): Part =>
  ({
    id,
    messageID,
    sessionID: SCOPE.sessionID,
    type: "text",
    text,
    ...(slim ? { slim: true } : {}),
  }) as Part

const idsOf = (records: readonly TranscriptDurableRecord[]): string[] => records.map((record) => record.messageID)

const writeUser = async (
  store: TranscriptDurableStore,
  id: string,
  created: number,
  text = id,
  scope: TranscriptDurableScope = SCOPE,
) => store.upsertSettled(scope, userInfo(id, created), [textPart(`${id}-p`, id, text)])

const writeAssistant = async (
  store: TranscriptDurableStore,
  id: string,
  created: number,
  input: { finish?: string; completed?: number; text?: string; slim?: boolean } = {},
  scope: TranscriptDurableScope = SCOPE,
) =>
  store.upsertSettled(
    scope,
    assistantInfo(id, created, { finish: input.finish, completed: input.completed }),
    [textPart(`${id}-p`, id, input.text ?? "done", input.slim === true)],
  )

export function runTranscriptDurableStoreContract(
  label: string,
  createStore: TranscriptDurableStoreFactory,
): void {
  describe(`TranscriptDurableStore contract (${label})`, () => {
    let store: TranscriptDurableStore

    beforeEach(async () => {
      store = await createStore()
    })

    afterEach(async () => {
      await store.destroy()
    })

    test("round-trips a settled message with derived hash, size, and per-part completeness", async () => {
      const written = await writeUser(store, "msg_user", 10, "hello")
      expect(written.status).toBe("written")
      if (written.status !== "written") return

      expect(written.record.messageID).toBe("msg_user")
      expect(written.record.scope).toEqual(SCOPE)
      expect(written.record.completeness).toBe("full")
      expect(written.record.partCompleteness).toEqual(["full"])
      expect(written.record.contentHash.length).toBe(64)
      expect(written.record.byteSize).toBeGreaterThan(0)
      expect(written.record.sortKey).toEqual({ created: 10, messageID: "msg_user" })

      const byId = await store.readMessage(SCOPE, "msg_user")
      expect(byId?.info).toEqual(written.record.info)
      expect(byId?.parts).toEqual(written.record.parts)
      expect(byId?.contentHash).toBe(written.record.contentHash)

      const session = await store.readSession(SCOPE)
      expect(idsOf(session.records)).toEqual(["msg_user"])
      expect(session.byteSize).toBe(session.records[0]?.byteSize)
    })

    test("same content hash skips the write and refreshes lastAccessedAt", async () => {
      const first = await writeUser(store, "msg_user", 10, "hello")
      expect(first.status).toBe("written")
      if (first.status !== "written") return

      const second = await writeUser(store, "msg_user", 10, "hello")
      expect(second.status).toBe("skipped")
      if (second.status !== "skipped" || !second.record) return
      expect(second.reason).toBe("unchanged")
      expect(second.record.contentHash).toBe(first.record.contentHash)
      expect(second.record.byteSize).toBe(first.record.byteSize)
      expect(second.record.lastAccessedAt).toBeGreaterThan(first.record.lastAccessedAt)

      const changed = await writeUser(store, "msg_user", 10, "hello-edited")
      expect(changed.status).toBe("written")
      if (changed.status !== "written") return
      expect(changed.record.contentHash).not.toEqual(first.record.contentHash)
    })

    test("a full record is not replaced by a later slim write", async () => {
      const full = await writeAssistant(store, "msg_asst", 20, { finish: "stop", text: "full body" })
      expect(full.status).toBe("written")
      if (full.status !== "written") return
      expect(full.record.completeness).toBe("full")
      expect(full.record.partCompleteness).toEqual(["full"])

      const slim = await writeAssistant(store, "msg_asst", 20, { finish: "stop", text: "summary", slim: true })
      expect(slim.status).toBe("skipped")
      if (slim.status !== "skipped") return
      expect(slim.reason).toBe("slim-downgrade")
      expect(slim.record?.completeness).toBe("full")
      expect(slim.record?.parts).toEqual(full.record.parts)

      const kept = await store.readMessage(SCOPE, "msg_asst")
      expect(kept?.completeness).toBe("full")
      expect((kept?.parts[0] as { text?: string } | undefined)?.text).toBe("full body")
    })

    test("a slim record upgrades when a full write arrives", async () => {
      const slim = await writeAssistant(store, "msg_asst", 20, { completed: 21, text: "summary", slim: true })
      expect(slim.status).toBe("written")
      if (slim.status !== "written") return
      expect(slim.record.completeness).toBe("slim")
      expect(slim.record.partCompleteness).toEqual(["slim"])

      const full = await writeAssistant(store, "msg_asst", 20, { completed: 21, text: "full body" })
      expect(full.status).toBe("written")
      if (full.status !== "written") return
      expect(full.record.completeness).toBe("full")
      expect(full.record.partCompleteness).toEqual(["full"])
      expect(full.record.contentHash).not.toEqual(slim.record.contentHash)
    })

    test("open assistant rows are not persisted; users and settled assistants are", async () => {
      const open = await writeAssistant(store, "msg_open", 30, { text: "streaming" })
      expect(open).toEqual({ status: "skipped", reason: "not-settled" })
      expect(await store.readMessage(SCOPE, "msg_open")).toBeUndefined()

      const user = await writeUser(store, "msg_user", 31)
      expect(user.status).toBe("written")

      const finished = await writeAssistant(store, "msg_finish", 32, { finish: "stop" })
      expect(finished.status).toBe("written")

      const completed = await writeAssistant(store, "msg_done", 33, { completed: 34 })
      expect(completed.status).toBe("written")

      const session = await store.readSession(SCOPE)
      expect(idsOf(session.records)).toEqual(["msg_user", "msg_finish", "msg_done"])
    })

    test("sorts by time.created then messageID, not by id rank or insert order", async () => {
      await writeUser(store, "msg_z", 100)
      await writeUser(store, "msg_a", 200)
      await writeUser(store, "msg_m", 100)

      const session = await store.readSession(SCOPE)
      expect(idsOf(session.records)).toEqual(["msg_m", "msg_z", "msg_a"])
      expect(session.records.map((record) => record.sortKey)).toEqual([
        { created: 100, messageID: "msg_m" },
        { created: 100, messageID: "msg_z" },
        { created: 200, messageID: "msg_a" },
      ])
    })

    test("identical content under different messageIDs stays two rows", async () => {
      const first = await writeUser(store, "msg_one", 10, "same")
      const second = await writeUser(store, "msg_two", 11, "same")
      expect(first.status).toBe("written")
      expect(second.status).toBe("written")
      expect(idsOf((await store.readSession(SCOPE)).records)).toEqual(["msg_one", "msg_two"])
    })

    test("transport, generation, directory, and sessionID isolate records", async () => {
      await writeUser(store, "msg_home", 10, "home")
      await writeUser(store, "msg_transport", 10, "other", otherScope({ transport: "relay" }))
      await writeUser(store, "msg_generation", 10, "other", otherScope({ generation: 2 }))
      await writeUser(store, "msg_directory", 10, "other", otherScope({ directory: "/other" }))
      await writeUser(store, "msg_session", 10, "other", otherScope({ sessionID: "ses_2" }))

      expect(idsOf((await store.readSession(SCOPE)).records)).toEqual(["msg_home"])
      expect(idsOf((await store.readSession(otherScope({ transport: "relay" }))).records)).toEqual(["msg_transport"])
      expect(idsOf((await store.readSession(otherScope({ generation: 2 }))).records)).toEqual(["msg_generation"])
      expect(idsOf((await store.readSession(otherScope({ directory: "/other" }))).records)).toEqual(["msg_directory"])
      expect(idsOf((await store.readSession(otherScope({ sessionID: "ses_2" }))).records)).toEqual(["msg_session"])
    })

    test("removeMessage leaves the remaining session ordered and sized", async () => {
      const first = await writeUser(store, "msg_a", 10)
      const middle = await writeUser(store, "msg_b", 20)
      const last = await writeUser(store, "msg_c", 30)
      expect(first.status).toBe("written")
      expect(middle.status).toBe("written")
      expect(last.status).toBe("written")
      if (first.status !== "written" || last.status !== "written") return

      await store.removeMessage(SCOPE, "msg_b")
      await store.removeMessage(SCOPE, "msg_missing")

      const session = await store.readSession(SCOPE)
      expect(idsOf(session.records)).toEqual(["msg_a", "msg_c"])
      expect(session.byteSize).toBe(first.record.byteSize + last.record.byteSize)
      expect(await store.readMessage(SCOPE, "msg_b")).toBeUndefined()
    })

    test("clearSession and clearGeneration do not cross their boundaries", async () => {
      await writeUser(store, "msg_keep_session", 10, "keep", otherScope({ sessionID: "ses_2" }))
      await writeUser(store, "msg_drop_session", 10)
      await writeUser(store, "msg_keep_generation", 10, "keep", otherScope({ generation: 2 }))
      await writeUser(store, "msg_drop_generation", 11)

      await store.clearSession(SCOPE)
      expect(idsOf((await store.readSession(SCOPE)).records)).toEqual([])
      expect(idsOf((await store.readSession(otherScope({ sessionID: "ses_2" }))).records)).toEqual(["msg_keep_session"])
      expect(idsOf((await store.readSession(otherScope({ generation: 2 }))).records)).toEqual(["msg_keep_generation"])

      await writeUser(store, "msg_gen1", 12)
      await store.clearGeneration({ transport: SCOPE.transport, generation: 1 })
      expect(idsOf((await store.readSession(SCOPE)).records)).toEqual([])
      expect(idsOf((await store.readSession(otherScope({ sessionID: "ses_2" }))).records)).toEqual([])
      expect(idsOf((await store.readSession(otherScope({ generation: 2 }))).records)).toEqual(["msg_keep_generation"])
    })

    test("evictToBytes drops the least-recently accessed unprotected rows", async () => {
      const first = await writeUser(store, "msg_old", 10, "aaaaaaaa")
      const second = await writeUser(store, "msg_mid", 20, "bbbbbbbb")
      const third = await writeUser(store, "msg_new", 30, "cccccccc")
      expect(first.status).toBe("written")
      expect(second.status).toBe("written")
      expect(third.status).toBe("written")
      if (first.status !== "written" || second.status !== "written" || third.status !== "written") return

      const touched = await writeUser(store, "msg_old", 10, "aaaaaaaa")
      expect(touched.status).toBe("skipped")

      const budget = first.record.byteSize + third.record.byteSize
      const evicted = await store.evictToBytes(budget)
      expect(evicted.evicted).toBe(1)
      expect(evicted.freedBytes).toBe(second.record.byteSize)
      expect(evicted.remainingBytes).toBe(budget)

      const session = await store.readSession(SCOPE)
      expect(idsOf(session.records)).toEqual(["msg_old", "msg_new"])
      expect(session.byteSize).toBe(budget)
      expect(await store.readMessage(SCOPE, "msg_mid")).toBeUndefined()
    })

    test("evictToBytes keeps protected scopes and leaves each session consistent", async () => {
      const protectedScope = SCOPE
      const evictable = otherScope({ sessionID: "ses_2" })
      const kept = await writeUser(store, "msg_keep", 10, "keep-keep", protectedScope)
      const dropped = await writeUser(store, "msg_drop", 20, "drop-drop", evictable)
      expect(kept.status).toBe("written")
      expect(dropped.status).toBe("written")
      if (kept.status !== "written" || dropped.status !== "written") return

      const evicted = await store.evictToBytes(0, { protect: [protectedScope] })
      expect(evicted.evicted).toBe(1)
      expect(evicted.freedBytes).toBe(dropped.record.byteSize)
      expect(evicted.remainingBytes).toBe(kept.record.byteSize)

      const protectedSession = await store.readSession(protectedScope)
      expect(idsOf(protectedSession.records)).toEqual(["msg_keep"])
      expect(protectedSession.byteSize).toBe(kept.record.byteSize)

      const cleared = await store.readSession(evictable)
      expect(cleared.records).toEqual([])
      expect(cleared.byteSize).toBe(0)
    })

    test("evictToBytes keeps every protected scope when the budget is already full", async () => {
      const first = await writeUser(store, "msg_a", 10, "keep-a", SCOPE)
      const second = await writeUser(store, "msg_b", 20, "keep-b", otherScope({ sessionID: "ses_2" }))
      expect(first.status).toBe("written")
      expect(second.status).toBe("written")
      if (first.status !== "written" || second.status !== "written") return

      const evicted = await store.evictToBytes(0, {
        protect: [SCOPE, otherScope({ sessionID: "ses_2" })],
      })
      expect(evicted.evicted).toBe(0)
      expect(evicted.freedBytes).toBe(0)
      expect(evicted.remainingBytes).toBe(first.record.byteSize + second.record.byteSize)
      expect(idsOf((await store.readSession(SCOPE)).records)).toEqual(["msg_a"])
      expect(idsOf((await store.readSession(otherScope({ sessionID: "ses_2" }))).records)).toEqual(["msg_b"])
    })

    test("clearAll empties every scope and accepts a later write", async () => {
      await writeUser(store, "msg_home", 10)
      await writeUser(store, "msg_other", 10, "other", otherScope({ generation: 2 }))
      await store.clearAll()

      expect((await store.readSession(SCOPE)).records).toEqual([])
      expect((await store.readSession(otherScope({ generation: 2 }))).records).toEqual([])
      expect(await store.readMessage(SCOPE, "msg_home")).toBeUndefined()

      const written = await writeUser(store, "msg_after", 11, "after")
      expect(written.status).toBe("written")
      expect(idsOf((await store.readSession(SCOPE)).records)).toEqual(["msg_after"])
    })

    test("destroy empties every scope", async () => {
      await writeUser(store, "msg_home", 10)
      await writeUser(store, "msg_other", 10, "other", otherScope({ generation: 2 }))
      await store.destroy()

      expect((await store.readSession(SCOPE)).records).toEqual([])
      expect((await store.readSession(otherScope({ generation: 2 }))).records).toEqual([])
      expect(await store.readMessage(SCOPE, "msg_home")).toBeUndefined()
    })
  })
}
