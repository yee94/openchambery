import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@/lib/opencode/v2-types"

import { runTranscriptDurableStoreContract } from "./transcript-durable-store.contract"
import {
  createIndexedDBTranscriptDurableStore,
  MemoryTranscriptDurableTwoStoreDriver,
} from "./transcript-durable-store-indexeddb"
import type { TranscriptDurableScope } from "./transcript-durable-store"

const SCOPE: TranscriptDurableScope = {
  transport: "local",
  generation: 1,
  directory: "/workspace",
  sessionID: "ses_1",
}

const user = (id: string, created: number, text = id): { info: Message; parts: Part[] } => ({
  info: { id, sessionID: SCOPE.sessionID, role: "user", time: { created } } as Message,
  parts: [{ id: `${id}-p`, messageID: id, sessionID: SCOPE.sessionID, type: "text", text } as Part],
})

runTranscriptDurableStoreContract("indexeddb", () =>
  createIndexedDBTranscriptDurableStore({
    driver: new MemoryTranscriptDurableTwoStoreDriver(),
  }),
)

describe("IndexedDB transcript durable two-store driver", () => {
  test("rolls back index and content when the action throws", async () => {
    const driver = new MemoryTranscriptDurableTwoStoreDriver()
    const store = createIndexedDBTranscriptDurableStore({ driver })
    const { info, parts } = user("msg_keep", 10, "keep")
    expect((await store.upsertSettled(SCOPE, info, parts)).status).toBe("written")

    try {
      await driver.transaction(async (transaction) => {
        await transaction.putIndex({
          id: '["local",1,"/workspace","ses_1","msg_ghost"]',
          scope: SCOPE,
          scopeKey: JSON.stringify(["local", 1, "/workspace", "ses_1"]),
          generationKey: JSON.stringify(["local", 1]),
          messageID: "msg_ghost",
          sortKey: { created: 11, messageID: "msg_ghost" },
          contentHash: "x",
          completeness: "full",
          partCompleteness: ["full"],
          byteSize: 1,
          lastAccessedAt: 1,
        })
        await transaction.putContent({
          id: '["local",1,"/workspace","ses_1","msg_ghost"]',
          info: user("msg_ghost", 11).info,
          parts: user("msg_ghost", 11).parts,
        })
        throw new Error("action failure")
      })
      throw new Error("action failure committed")
    } catch (error) {
      expect(error instanceof Error && error.message === "action failure").toBe(true)
    }

    const session = await store.readSession(SCOPE)
    expect(session.records.map((record) => record.messageID)).toEqual(["msg_keep"])
    expect(await store.readMessage(SCOPE, "msg_ghost")).toBeUndefined()
  })

  test("repairs a dangling index so session reads stay consistent", async () => {
    const driver = new MemoryTranscriptDurableTwoStoreDriver()
    const store = createIndexedDBTranscriptDurableStore({ driver })
    const { info, parts } = user("msg_live", 10, "live")
    expect((await store.upsertSettled(SCOPE, info, parts)).status).toBe("written")

    await driver.transaction(async (transaction) => {
      await transaction.putIndex({
        id: '["local",1,"/workspace","ses_1","msg_orphan"]',
        scope: SCOPE,
        scopeKey: JSON.stringify(["local", 1, "/workspace", "ses_1"]),
        generationKey: JSON.stringify(["local", 1]),
        messageID: "msg_orphan",
        sortKey: { created: 20, messageID: "msg_orphan" },
        contentHash: "orphan",
        completeness: "full",
        partCompleteness: ["full"],
        byteSize: 8,
        lastAccessedAt: 2,
      })
    })

    const session = await store.readSession(SCOPE)
    expect(session.records.map((record) => record.messageID)).toEqual(["msg_live"])
    expect(await store.readMessage(SCOPE, "msg_orphan")).toBeUndefined()
  })

  test("under-budget eviction does not rescan every index row after the first check", async () => {
    const inner = new MemoryTranscriptDurableTwoStoreDriver()
    let fullScans = 0
    const driver = {
      transaction: <T,>(action: Parameters<typeof inner.transaction<T>>[0]) =>
        inner.transaction<T>((transaction) => action({
          ...transaction,
          getAllIndexes: () => {
            fullScans += 1
            return transaction.getAllIndexes()
          },
        })),
      destroy: () => inner.destroy(),
    }
    const store = createIndexedDBTranscriptDurableStore({ driver })
    const budget = 1024 * 1024
    for (let index = 0; index < 5; index += 1) {
      const { info, parts } = user(`msg_${index}`, index)
      await store.upsertSettled(SCOPE, info, parts)
      await store.evictToBytes(budget)
    }
    expect(fullScans).toBeLessThanOrEqual(1)
    expect((await store.readSession(SCOPE)).records).toHaveLength(5)
  })

  test("tracked byte total still evicts once writes exceed the budget", async () => {
    const store = createIndexedDBTranscriptDurableStore({ driver: new MemoryTranscriptDurableTwoStoreDriver() })
    const first = user("msg_old", 1, "x".repeat(400))
    await store.upsertSettled(SCOPE, first.info, first.parts)
    const firstSize = (await store.readMessage(SCOPE, "msg_old"))!.byteSize
    expect((await store.evictToBytes(firstSize)).evicted).toBe(0)
    const second = user("msg_new", 2, "y".repeat(400))
    await store.upsertSettled(SCOPE, second.info, second.parts)
    const result = await store.evictToBytes(firstSize + 10)
    expect(result.evicted).toBe(1)
    expect((await store.readSession(SCOPE)).records.map((record) => record.messageID)).toEqual(["msg_new"])
  })

  test("clearAll drops index and content together and accepts a later write", async () => {
    const driver = new MemoryTranscriptDurableTwoStoreDriver()
    const store = createIndexedDBTranscriptDurableStore({ driver })
    const first = user("msg_old", 10, "old")
    expect((await store.upsertSettled(SCOPE, first.info, first.parts)).status).toBe("written")
    await store.clearAll()
    expect((await store.readSession(SCOPE)).records).toEqual([])
    expect(await store.readMessage(SCOPE, "msg_old")).toBeUndefined()

    const next = user("msg_new", 11, "new")
    expect((await store.upsertSettled(SCOPE, next.info, next.parts)).status).toBe("written")
    const session = await store.readSession(SCOPE)
    expect(session.records.map((record) => record.messageID)).toEqual(["msg_new"])
    expect((await store.readMessage(SCOPE, "msg_new"))?.messageID).toBe("msg_new")
  })
})
