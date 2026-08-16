import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import type { RuntimeFetchOptions } from "@/lib/runtime-fetch"

import {
  TRANSCRIPT_CACHE_ROUTE_PREFIX,
  createHttpTranscriptDurableStore,
} from "./transcript-durable-store-http"
import type { TranscriptDurableScope } from "./transcript-durable-store"

const SCOPE: TranscriptDurableScope = {
  transport: "local",
  generation: 1,
  directory: "/workspace",
  sessionID: "ses_1",
}

const info = { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message
const parts = [{ id: "p1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hi" }] as Part[]

const record = {
  scope: SCOPE,
  messageID: "msg_1",
  info,
  parts,
  partCompleteness: ["full"] as const,
  completeness: "full" as const,
  contentHash: "abc",
  byteSize: 12,
  lastAccessedAt: 7,
  sortKey: { created: 1, messageID: "msg_1" },
}

type Captured = { path: string; init?: RuntimeFetchOptions }

const jsonResponse = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
  })

const captureFetch = (handler: (captured: Captured) => Response | Promise<Response>) => {
  const calls: Captured[] = []
  const fetchFn = async (path: string, init?: RuntimeFetchOptions) => {
    const captured = { path, init }
    calls.push(captured)
    return handler(captured)
  }
  return { calls, store: createHttpTranscriptDurableStore({ fetch: fetchFn }) }
}

describe("HTTP transcript durable store", () => {
  test("reads a session through the OpenChamber prefix and query scope", async () => {
    const { calls, store } = captureFetch(() =>
      jsonResponse(200, { available: true, scope: SCOPE, records: [record], byteSize: 12 }),
    )
    const session = await store.readSession(SCOPE)
    expect(calls[0]?.path).toBe(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/session`)
    expect(calls[0]?.init?.method).toBe("GET")
    expect(calls[0]?.init?.query).toEqual({
      transport: "local",
      generation: "1",
      directory: "/workspace",
      sessionID: "ses_1",
    })
    expect(session.records.map((item) => item.messageID)).toEqual(["msg_1"])
    expect(session.byteSize).toBe(12)
  })

  test("reads one message and maps 404 to a miss", async () => {
    const found = captureFetch(() => jsonResponse(200, { available: true, record }))
    expect((await found.store.readMessage(SCOPE, "msg_1"))?.messageID).toBe("msg_1")
    expect(found.calls[0]?.path).toBe(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`)
    expect(found.calls[0]?.init?.query).toEqual({
      transport: "local",
      generation: "1",
      directory: "/workspace",
      sessionID: "ses_1",
      messageID: "msg_1",
    })

    const missing = captureFetch(() => jsonResponse(404, { error: "message_not_found" }))
    expect(await missing.store.readMessage(SCOPE, "msg_missing")).toBeUndefined()
  })

  test("upserts the ticket 08 body and parses written / skipped", async () => {
    const written = captureFetch(() => jsonResponse(200, { status: "written", record }))
    const result = await written.store.upsertSettled(SCOPE, info, parts)
    expect(written.calls[0]?.path).toBe(`${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`)
    expect(written.calls[0]?.init?.method).toBe("PUT")
    expect(JSON.parse(String(written.calls[0]?.init?.body))).toEqual({ scope: SCOPE, info, parts })
    expect(result.status).toBe("written")

    const skipped = captureFetch(() => jsonResponse(200, { status: "skipped", reason: "unchanged", record }))
    expect((await skipped.store.upsertSettled(SCOPE, info, parts)).status).toBe("skipped")
  })

  test("delete and evict use the route verbs and 204 success", async () => {
    const { calls, store } = captureFetch((captured) => {
      if (captured.path.endsWith("/evict")) {
        return jsonResponse(200, { evicted: 1, freedBytes: 8, remainingBytes: 0 })
      }
      return new Response(null, { status: 204 })
    })
    await store.removeMessage(SCOPE, "msg_1")
    await store.clearSession(SCOPE)
    await store.clearGeneration({ transport: "local", generation: 1 })
    await store.clearAll()
    const evicted = await store.evictToBytes(0, { protect: [SCOPE] })
    expect(calls.map((item) => [item.init?.method, item.path])).toEqual([
      ["DELETE", `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/message`],
      ["DELETE", `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/session`],
      ["DELETE", `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/generation`],
      ["DELETE", `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/all`],
      ["POST", `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/evict`],
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ scope: SCOPE, messageID: "msg_1" })
    expect(evicted).toEqual({ evicted: 1, freedBytes: 8, remainingBytes: 0 })
  })

  test("501 is a disabled miss and does not throw", async () => {
    const { store } = captureFetch(() => jsonResponse(501, { error: "Transcript cache is unavailable for this runtime" }))
    expect((await store.readSession(SCOPE)).records).toEqual([])
    expect(await store.readMessage(SCOPE, "msg_1")).toBeUndefined()
    expect(await store.upsertSettled(SCOPE, info, parts)).toEqual({ status: "skipped", reason: "unchanged" })
    await store.removeMessage(SCOPE, "msg_1")
    await store.clearSession(SCOPE)
    await store.clearAll()
    expect(await store.evictToBytes(10)).toEqual({ evicted: 0, freedBytes: 0, remainingBytes: 0 })
  })

  test("400/500 throw the payload error so Query can degrade", async () => {
    const bad = captureFetch(() => jsonResponse(400, { error: "Invalid transcript cache scope" }))
    await expect(bad.store.readSession(SCOPE)).rejects.toThrow("Invalid transcript cache scope")
    const failed = captureFetch(() => jsonResponse(500, { error: "Transcript cache request failed" }))
    await expect(failed.store.upsertSettled(SCOPE, info, parts)).rejects.toThrow("Transcript cache request failed")
  })

  test("malformed 2xx bodies throw instead of inventing rows", async () => {
    const { store } = captureFetch(() => jsonResponse(200, { records: "nope" }))
    await expect(store.readSession(SCOPE)).rejects.toThrow("Invalid transcript cache session")
  })

  test("clearAll is the current-runtime wipe; destroy still issues no request", async () => {
    const cleared = captureFetch(() => new Response(null, { status: 204 }))
    await cleared.store.clearAll()
    expect(cleared.calls.map((item) => [item.init?.method, item.path])).toEqual([
      ["DELETE", `${TRANSCRIPT_CACHE_ROUTE_PREFIX}/all`],
    ])

    const { calls, store } = captureFetch(() => jsonResponse(200, {}))
    await store.destroy()
    expect(calls).toEqual([])
  })

  test("destroy does not issue a cache-clearing request", async () => {
    const { calls, store } = captureFetch(() => jsonResponse(200, {}))
    await store.destroy()
    expect(calls).toEqual([])
  })
})
