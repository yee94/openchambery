import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import { ChildStoreManager } from "./child-store"
import { createMemoryTranscriptDurableStore } from "./transcript-durable-store"
import type { TranscriptDurableStore } from "./transcript-durable-store"
import {
  clearCurrentRuntimeTranscriptCache,
  createRuntimeTranscriptDurableStore,
  resolveTranscriptDurableRuntimeKind,
} from "./transcript-durable-store-runtime"
import { mountProductionTranscriptStack } from "./transcript-repository-production"

const SCOPE = {
  transport: "local",
  generation: 1,
  directory: "/workspace",
  sessionID: "ses_1",
}

const info = { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message
const parts = [{ id: "p1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hi" }] as Part[]

const spyStore = (label: string, inner = createMemoryTranscriptDurableStore()) => {
  const calls: string[] = []
  const store: TranscriptDurableStore = {
    readSession: async (scope) => {
      calls.push(`${label}:readSession`)
      return inner.readSession(scope)
    },
    readMessage: async (scope, messageID) => {
      calls.push(`${label}:readMessage`)
      return inner.readMessage(scope, messageID)
    },
    upsertSettled: async (scope, nextInfo, nextParts) => {
      calls.push(`${label}:upsertSettled`)
      return inner.upsertSettled(scope, nextInfo, nextParts)
    },
    removeMessage: async (scope, messageID) => {
      calls.push(`${label}:removeMessage`)
      return inner.removeMessage(scope, messageID)
    },
    clearSession: async (scope) => {
      calls.push(`${label}:clearSession`)
      return inner.clearSession(scope)
    },
    clearGeneration: async (generation) => {
      calls.push(`${label}:clearGeneration`)
      return inner.clearGeneration(generation)
    },
    evictToBytes: async (maxBytes, options) => {
      calls.push(`${label}:evictToBytes`)
      return inner.evictToBytes(maxBytes, options)
    },
    clearAll: async () => {
      calls.push(`${label}:clearAll`)
      return inner.clearAll()
    },
    destroy: async () => {
      calls.push(`${label}:destroy`)
      return inner.destroy()
    },
  }
  return { store, calls, inner }
}

describe("runtime transcript durable store selection", () => {
  test("Electron + local origin uses HTTP; web / vscode / capacitor / remote desktop use IndexedDB", () => {
    expect(resolveTranscriptDurableRuntimeKind({
      isDesktopShell: () => true,
      isDesktopLocalOriginActive: () => true,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
    })).toBe("http")
    expect(resolveTranscriptDurableRuntimeKind({
      isDesktopShell: () => false,
      isDesktopLocalOriginActive: () => false,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
    })).toBe("indexeddb")
    expect(resolveTranscriptDurableRuntimeKind({
      isDesktopShell: () => false,
      isDesktopLocalOriginActive: () => false,
      isVSCodeRuntime: () => true,
      isCapacitorApp: () => false,
    })).toBe("indexeddb")
    expect(resolveTranscriptDurableRuntimeKind({
      isDesktopShell: () => false,
      isDesktopLocalOriginActive: () => false,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => true,
    })).toBe("indexeddb")
    expect(resolveTranscriptDurableRuntimeKind({
      isDesktopShell: () => true,
      isDesktopLocalOriginActive: () => false,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
    })).toBe("indexeddb")
  })

  test("each operation follows the live runtime choice", async () => {
    const http = spyStore("http")
    const idb = spyStore("idb")
    let local = true
    const store = createRuntimeTranscriptDurableStore({
      isDesktopShell: () => true,
      isDesktopLocalOriginActive: () => local,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
      createHttpStore: () => http.store,
      createIndexedDBStore: () => idb.store,
    })
    await store.upsertSettled(SCOPE, info, parts)
    local = false
    await store.readSession(SCOPE)
    expect(http.calls).toEqual(["http:upsertSettled"])
    expect(idb.calls).toEqual(["idb:readSession"])
  })

  test("clearGeneration always clears HTTP and IndexedDB", async () => {
    const http = spyStore("http")
    const idb = spyStore("idb")
    const store = createRuntimeTranscriptDurableStore({
      isDesktopShell: () => true,
      isDesktopLocalOriginActive: () => true,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
      createHttpStore: () => http.store,
      createIndexedDBStore: () => idb.store,
    })
    await http.inner.upsertSettled(SCOPE, info, parts)
    await idb.inner.upsertSettled({ ...SCOPE, transport: "remote" }, info, parts)
    await store.clearGeneration({ transport: "local", generation: 1 })
    expect(http.calls).toContain("http:clearGeneration")
    expect(idb.calls).toContain("idb:clearGeneration")
    expect((await http.inner.readSession(SCOPE)).records).toEqual([])
    expect((await idb.inner.readSession({ ...SCOPE, transport: "remote" })).records).toHaveLength(1)
    await store.clearGeneration({ transport: "remote", generation: 1 })
    expect((await idb.inner.readSession({ ...SCOPE, transport: "remote" })).records).toEqual([])
  })

  test("clearAll and clearCurrentRuntimeTranscriptCache hit only the live backend", async () => {
    const http = spyStore("http")
    const idb = spyStore("idb")
    await http.inner.upsertSettled(SCOPE, info, parts)
    await idb.inner.upsertSettled({ ...SCOPE, transport: "remote" }, info, parts)
    const deps = {
      isDesktopShell: () => true,
      isDesktopLocalOriginActive: () => true,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
      createHttpStore: () => http.store,
      createIndexedDBStore: () => idb.store,
    }
    const store = createRuntimeTranscriptDurableStore(deps)
    await store.clearAll()
    expect(http.calls).toContain("http:clearAll")
    expect(idb.calls).not.toContain("idb:clearAll")
    expect((await http.inner.readSession(SCOPE)).records).toEqual([])
    expect((await idb.inner.readSession({ ...SCOPE, transport: "remote" })).records).toHaveLength(1)

    const webHttp = spyStore("web-http")
    const webIdb = spyStore("web-idb")
    await webIdb.inner.upsertSettled(SCOPE, info, parts)
    await clearCurrentRuntimeTranscriptCache({
      isDesktopShell: () => false,
      isDesktopLocalOriginActive: () => false,
      isVSCodeRuntime: () => false,
      isCapacitorApp: () => false,
      createHttpStore: () => webHttp.store,
      createIndexedDBStore: () => webIdb.store,
    })
    expect(webIdb.calls).toContain("web-idb:clearAll")
    expect(webHttp.calls).not.toContain("web-http:clearAll")
    expect((await webIdb.inner.readSession(SCOPE)).records).toEqual([])
  })

  test("destroy does not wipe either backend", async () => {
    const http = spyStore("http")
    const idb = spyStore("idb")
    const store = createRuntimeTranscriptDurableStore({
      isDesktopShell: () => true,
      isDesktopLocalOriginActive: () => true,
      createHttpStore: () => http.store,
      createIndexedDBStore: () => idb.store,
    })
    await store.upsertSettled(SCOPE, info, parts)
    await store.destroy()
    expect(http.calls).not.toContain("http:destroy")
    expect(idb.calls).not.toContain("idb:destroy")
    expect((await http.inner.readSession(SCOPE)).records).toHaveLength(1)
  })
})

describe("production transcript stack durable assembly", () => {
  test("injected durableStore wins over the runtime default", async () => {
    const injected = spyStore("injected")
    await injected.inner.upsertSettled(SCOPE, info, parts)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const stack = mountProductionTranscriptStack({
      client,
      childStores: new ChildStoreManager(),
      durableStore: injected.store,
    })
    await stack.repository.ensureInitial({
      directory: SCOPE.directory,
      sessionID: SCOPE.sessionID,
      transport: SCOPE.transport,
      generation: SCOPE.generation,
    }).catch(() => undefined)
    expect(injected.calls).toContain("injected:readSession")
    stack.destroy()
    expect(injected.calls).not.toContain("injected:destroy")
    expect((await injected.inner.readSession(SCOPE)).records).toHaveLength(1)
  })

  test("omitted durableStore mounts the production runtime adapter and destroy keeps the cache", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const stack = mountProductionTranscriptStack({
      client,
      childStores: new ChildStoreManager(),
    })
    expect(stack.repository).toBeDefined()
    stack.destroy()
  })
})
