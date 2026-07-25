import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"

import {
  beginSessionMessageLoad,
  failSessionMessageLoad,
  getSessionPrefetch,
  setSessionPrefetch,
} from "../session-prefetch-cache"
import type { SessionMessageReducerState } from "../session-message-reducer"

// bun's mock.module is process-global and mutates the module record in place.
// mock.restore() does NOT put the original export functions back, so after this
// suite we re-install the pristine snapshots so sibling suites keep the real
// implementation.
//
// Snapshot via cache-busted URLs: a sibling suite (e.g. session-actions.test.ts)
// may already have installed an incomplete mock.module for these keys before
// this file is evaluated. A plain import would snapshot the poisoned record;
// a unique query string forces a fresh load of the real source module.
const pristineTag = encodeURIComponent(import.meta.url)
const pristineRuntimeSurface = {
  ...(await import(`@/lib/runtimeSurface?openchamber-pristine=${pristineTag}`)),
}
const pristineDesktop = {
  ...(await import(`@/lib/desktop?openchamber-pristine=${pristineTag}`)),
}
const pristineRuntimeTunnel = {
  ...(await import(`@/lib/relay/runtime-tunnel?openchamber-pristine=${pristineTag}`)),
}

// Sticky mock keys: bun may bind mocks under the alias and/or the extensionless file URL.
const runtimeSurfaceKeys = [
  "@/lib/runtimeSurface",
  new URL("../../lib/runtimeSurface", import.meta.url).href,
] as const
const desktopKeys = [
  "@/lib/desktop",
  new URL("../../lib/desktop", import.meta.url).href,
] as const
const runtimeTunnelKeys = [
  "@/lib/relay/runtime-tunnel",
  new URL("../../lib/relay/runtime-tunnel", import.meta.url).href,
] as const

let mobileSurfaceRuntime = false
let vscodeRuntime = false
let relayModeActive = false

function installModuleMocks() {
  // Spread pristine exports so incomplete sticky mocks from sibling suites are
  // replaced with a complete surface (only the flag readers are overridden).
  for (const key of runtimeSurfaceKeys) {
    mock.module(key, () => ({
      ...pristineRuntimeSurface,
      isMobileSurfaceRuntime: () => mobileSurfaceRuntime,
    }))
  }

  for (const key of desktopKeys) {
    mock.module(key, () => ({
      ...pristineDesktop,
      isVSCodeRuntime: () => vscodeRuntime,
    }))
  }

  for (const key of runtimeTunnelKeys) {
    mock.module(key, () => ({
      ...pristineRuntimeTunnel,
      isRelayModeActive: () => relayModeActive,
    }))
  }
}

function restorePristineModules() {
  for (const key of runtimeSurfaceKeys) {
    mock.module(key, () => ({ ...pristineRuntimeSurface }))
  }
  for (const key of desktopKeys) {
    mock.module(key, () => ({ ...pristineDesktop }))
  }
  for (const key of runtimeTunnelKeys) {
    mock.module(key, () => ({ ...pristineRuntimeTunnel }))
  }
}

// Bind SUT only after mocks are installed so it resolves mocked deps.
// Lazy: avoid installing mocks at file load time (that would poison later suites
// even if this file's tests never run — bun evaluates every listed file first).
type LoaderApi = typeof import("../session-message-loader")
let MAX_ASSISTANT_TAIL_PARENT_LOADS: LoaderApi["MAX_ASSISTANT_TAIL_PARENT_LOADS"]
let findMissingAssistantParentUserIDs: LoaderApi["findMissingAssistantParentUserIDs"]
let loadSessionMessage: LoaderApi["loadSessionMessage"]
let loadSessionMessagePage: LoaderApi["loadSessionMessagePage"]
let loadSessionMessagePageTransport: LoaderApi["loadSessionMessagePageTransport"]
let recoverAssistantTailBoundary: LoaderApi["recoverAssistantTailBoundary"]
let resolveSessionMessagePageLimit: LoaderApi["resolveSessionMessagePageLimit"]
let loaderBound = false

async function ensureLoaderBound() {
  installModuleMocks()
  if (!loaderBound) {
    const mod = await import("../session-message-loader")
    MAX_ASSISTANT_TAIL_PARENT_LOADS = mod.MAX_ASSISTANT_TAIL_PARENT_LOADS
    findMissingAssistantParentUserIDs = mod.findMissingAssistantParentUserIDs
    loadSessionMessage = mod.loadSessionMessage
    loadSessionMessagePage = mod.loadSessionMessagePage
    loadSessionMessagePageTransport = mod.loadSessionMessagePageTransport
    recoverAssistantTailBoundary = mod.recoverAssistantTailBoundary
    resolveSessionMessagePageLimit = mod.resolveSessionMessagePageLimit
    loaderBound = true
  }
}

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

const record = (id: string, role: "user" | "assistant", parentID?: string) => ({
  info: { id, role, parentID } as Message & { role: string; parentID?: string },
  parts: [] as Part[],
})

function message(id: string, role: "user" | "assistant" = "assistant", parentID?: string): Message {
  return {
    id,
    sessionID: "ses_1",
    role,
    ...(parentID ? { parentID } : {}),
    time: { created: 1 },
  } as Message
}

function part(id: string, messageID: string, text = id): Part {
  return { id, messageID, sessionID: "ses_1", type: "text", text } as Part
}

function emptyState(): SessionMessageReducerState {
  return { message: {}, part: {} }
}

type StoreHarness = {
  state: SessionMessageReducerState
  commits: Array<{ message: Record<string, Message[]>; part: Record<string, Part[]> }>
  getStoreState: () => SessionMessageReducerState
  commitStore: (next: { message: Record<string, Message[]>; part: Record<string, Part[]>; changed: boolean }) => void
}

function createStore(initial: SessionMessageReducerState = emptyState()): StoreHarness {
  const harness: StoreHarness = {
    state: initial,
    commits: [],
    getStoreState: () => harness.state,
    commitStore: (next) => {
      if (!next.changed) return
      harness.state = { ...harness.state, message: next.message, part: next.part }
      harness.commits.push({ message: next.message, part: next.part })
    },
  }
  return harness
}

beforeEach(async () => {
  await ensureLoaderBound()
  mobileSurfaceRuntime = false
  vscodeRuntime = false
  relayModeActive = false
})

afterEach(() => {
  restorePristineModules()
})

afterAll(() => {
  restorePristineModules()
})

describe("loadSessionMessagePageTransport (legacy single-flight)", () => {
  test("coalesces imperative and reactive requests for the same runtime session page", async () => {
    let calls = 0
    let release: ((value: string) => void) | undefined
    const request = () => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const input = {
      runtimeKey: "runtime-a",
      directory: "/repo",
      sessionID: "ses_1",
      limit: 30,
      request,
    }
    const imperative = loadSessionMessagePageTransport(input)
    const reactive = loadSessionMessagePageTransport(input)

    expect(calls).toBe(1)
    release?.("page")
    expect(await imperative).toBe("page")
    expect(await reactive).toBe("page")
  })

  test("legacy loadSessionMessagePage overload still single-flights transport requests", async () => {
    let calls = 0
    let release: ((value: string) => void) | undefined
    const request = () => {
      calls += 1
      return new Promise<string>((resolve) => {
        release = resolve
      })
    }

    const input = {
      runtimeKey: "runtime-legacy",
      directory: "/repo",
      sessionID: "ses_legacy",
      limit: 30,
      request,
    }
    const a = loadSessionMessagePage(input)
    const b = loadSessionMessagePage(input)
    expect(calls).toBe(1)
    release?.("ok")
    expect(await a).toBe("ok")
    expect(await b).toBe("ok")
  })

  test("keeps cursor and runtime pages independent", async () => {
    let calls = 0
    const request = async () => ++calls

    await Promise.all([
      loadSessionMessagePageTransport({ runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", limit: 30, request }),
      loadSessionMessagePageTransport({ runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", limit: 30, before: "msg_20", request }),
      loadSessionMessagePageTransport({ runtimeKey: "runtime-b", directory: "/repo", sessionID: "ses_1", limit: 30, request }),
    ])

    expect(calls).toBe(3)
  })

  test("clears a failed request so the next attempt can retry", async () => {
    let calls = 0
    const request = async () => {
      calls += 1
      if (calls === 1) throw new Error("not ready")
      return "recovered"
    }

    const input = { runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", limit: 30, request }
    await expect(loadSessionMessagePageTransport(input)).rejects.toThrow("not ready")
    const recovered = await loadSessionMessagePageTransport(input)
    expect(recovered).toBe("recovered")
    expect(calls).toBe(2)
  })

  test("keeps different limits independent for the same tail cursor", async () => {
    let calls = 0
    const request = async () => ++calls

    await Promise.all([
      loadSessionMessagePageTransport({ runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", limit: 30, request }),
      loadSessionMessagePageTransport({ runtimeKey: "runtime-a", directory: "/repo", sessionID: "ses_1", limit: 100, request }),
    ])

    expect(calls).toBe(2)
  })
})

describe("assistant-tail helpers", () => {
  test("recovers missing user parents for an assistant-only tail", async () => {
    const recovered = await recoverAssistantTailBoundary({
      records: [record("assistant", "assistant", "user")],
      complete: false,
      requestMessage: async (messageID) => record(messageID, "user"),
    })

    expect(recovered.records.map((item) => item.info.id)).toEqual(["assistant", "user"])
    expect(recovered.boundaryFound).toBe(true)
    expect(recovered.partial).toBe(false)
  })

  test("keeps a user boundary and complete pages free of parent requests", async () => {
    let calls = 0
    const requestMessage = async (messageID: string) => {
      calls += 1
      return record(messageID, "user")
    }

    await recoverAssistantTailBoundary({
      records: [record("user", "user"), record("assistant", "assistant", "missing")],
      complete: false,
      requestMessage,
    })
    await recoverAssistantTailBoundary({
      records: [record("assistant", "assistant", "missing")],
      complete: true,
      requestMessage,
    })
    expect(calls).toBe(0)
  })

  test("deduplicates parent IDs and caps exact parent requests", () => {
    const records = Array.from({ length: MAX_ASSISTANT_TAIL_PARENT_LOADS + 3 }, (_, index) =>
      record(`assistant-${index}`, "assistant", `user-${index}`),
    )
    records.push(record("assistant-duplicate", "assistant", "user-0"))
    expect(findMissingAssistantParentUserIDs(records)).toEqual(
      Array.from({ length: MAX_ASSISTANT_TAIL_PARENT_LOADS }, (_, index) => `user-${index}`),
    )
  })

  test("clears a failed parent request for retry", async () => {
    let calls = 0
    const input = {
      runtimeKey: "runtime-a",
      directory: "/repo",
      sessionID: "ses_1",
      messageID: "msg_1",
      request: async () => {
        calls += 1
        if (calls === 1) throw new Error("not ready")
        return "recovered"
      },
    }
    await expect(loadSessionMessage(input)).rejects.toThrow("not ready")
    expect(await loadSessionMessage(input)).toBe("recovered")
    expect(calls).toBe(2)
  })
})

describe("resolveSessionMessagePageLimit (policy integration)", () => {
  test("initial / recovery / materialize track initial policy; prepend uses history", () => {
    expect(resolveSessionMessagePageLimit("initial")).toBe(30)
    expect(resolveSessionMessagePageLimit("recovery")).toBe(30)
    expect(resolveSessionMessagePageLimit("materialize")).toBe(30)
    expect(resolveSessionMessagePageLimit("prepend")).toBe(30)

    mobileSurfaceRuntime = true
    expect(resolveSessionMessagePageLimit("initial")).toBe(16)
    expect(resolveSessionMessagePageLimit("recovery")).toBe(16)
    expect(resolveSessionMessagePageLimit("materialize")).toBe(16)
    expect(resolveSessionMessagePageLimit("prepend")).toBe(30)

    relayModeActive = true
    expect(resolveSessionMessagePageLimit("initial")).toBe(5)
    expect(resolveSessionMessagePageLimit("prepend")).toBe(5)
    expect(resolveSessionMessagePageLimit("recovery")).toBe(5)
  })
})

describe("loadSessionMessagePage — application orchestration", () => {
  const directory = "/app-loader"
  const sessionID = "ses_app"
  const runtimeKey = "runtime-app"

  test("initial, prepend, recovery, and materialize share one entry and use purpose limits", async () => {
    const queryCalls: Array<{ limit: number; before?: string }> = []
    const store = createStore()

    for (const purpose of ["initial", "prepend", "recovery", "materialize"] as const) {
      queryCalls.length = 0
      store.state = emptyState()
      store.commits = []

      const result = await loadSessionMessagePage({
        purpose,
        runtimeKey: `${runtimeKey}-${purpose}`,
        directory,
        sessionID,
        before: purpose === "prepend" ? "msg_z" : undefined,
        deps: {
          queryPage: async ({ limit, before }) => {
            queryCalls.push({ limit, before })
            return {
              records: [{ info: message("msg_1", "user"), parts: [part("prt_1", "msg_1")] }],
              complete: purpose !== "prepend",
              cursor: purpose === "prepend" ? "msg_1" : undefined,
            }
          },
          getStoreState: store.getStoreState,
          commitStore: (reduced) => {
            store.commitStore({
              message: reduced.message,
              part: reduced.part,
              changed: reduced.changed,
            })
          },
          skipPartTypes: SKIP_PARTS,
        },
      })

      expect(result.status).toBe("ready")
      expect(result.applied).toBe(true)
      expect(queryCalls).toHaveLength(1)
      expect(queryCalls[0]?.limit).toBe(resolveSessionMessagePageLimit(purpose))
      if (purpose === "prepend") {
        expect(queryCalls[0]?.before).toBe("msg_z")
      }
      expect(store.commits.length).toBeGreaterThan(0)
    }
  })

  test("loading → ready status is complete and records prefetch meta", async () => {
    const statuses: string[] = []
    const store = createStore()
    let release: (() => void) | undefined

    const pending = loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: `${runtimeKey}-status`,
      directory: `${directory}-status`,
      sessionID,
      deps: {
        queryPage: () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                records: [{ info: message("msg_1", "user"), parts: [part("prt_1", "msg_1")] }],
                complete: true,
              })
          }),
        getStoreState: store.getStoreState,
        commitStore: (reduced) => {
          store.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        skipPartTypes: SKIP_PARTS,
        onLoading: () => statuses.push("loading"),
        onReady: () => statuses.push("ready"),
        onError: () => statuses.push("error"),
      },
    })

    expect(statuses).toEqual(["loading"])
    expect(getSessionPrefetch(`${directory}-status`, sessionID, `${runtimeKey}-status`)?.status).toBe("loading")

    release?.()
    const result = await pending
    expect(result.status).toBe("ready")
    expect(statuses).toEqual(["loading", "ready"])
    expect(getSessionPrefetch(`${directory}-status`, sessionID, `${runtimeKey}-status`)?.status).toBe("ready")
  })

  test("request failure preserves existing transcript and surfaces error status", async () => {
    const existing = message("msg_keep", "user")
    const existingPart = part("prt_keep", "msg_keep")
    const store = createStore({
      message: { [sessionID]: [existing] },
      part: { msg_keep: [existingPart] },
      meta: { limit: 1, cursor: undefined, complete: true },
    })
    const dir = `${directory}-fail`
    const rk = `${runtimeKey}-fail`
    setSessionPrefetch({ directory: dir, sessionID, runtimeKey: rk, limit: 1, complete: true })

    const result = await loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: rk,
      directory: dir,
      sessionID,
      deps: {
        queryPage: async () => {
          throw new Error("network down")
        },
        getStoreState: store.getStoreState,
        commitStore: (reduced) => {
          store.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        skipPartTypes: SKIP_PARTS,
      },
    })

    expect(result.status).toBe("error")
    expect(result.applied).toBe(false)
    expect(result.error).toContain("network down")
    expect(store.commits).toHaveLength(0)
    expect(store.state.message[sessionID]).toEqual([existing])
    expect(store.state.part.msg_keep).toEqual([existingPart])
    expect(getSessionPrefetch(dir, sessionID, rk)?.status).toBe("error")
    expect(getSessionPrefetch(dir, sessionID, rk)?.limit).toBe(30)
  })

  test("provider remount commits the shared transport response into a new store", async () => {
    let release: ((value: {
      records: Array<{ info: Message; parts: Part[] }>
      complete: boolean
    }) => void) | undefined
    let queryCalls = 0

    const queryPage = () => {
      queryCalls += 1
      return new Promise<{
        records: Array<{ info: Message; parts: Part[] }>
        complete: boolean
      }>((resolve) => {
        release = resolve
      })
    }

    const storeA = createStore()
    const storeB = createStore()
    const dir = `${directory}-remount`
    const rk = `${runtimeKey}-remount`

    const loadA = loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: rk,
      directory: dir,
      sessionID,
      deps: {
        queryPage,
        getStoreState: storeA.getStoreState,
        commitStore: (reduced) => {
          storeA.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        skipPartTypes: SKIP_PARTS,
      },
    })

    const loadB = loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: rk,
      directory: dir,
      sessionID,
      deps: {
        queryPage,
        getStoreState: storeB.getStoreState,
        commitStore: (reduced) => {
          storeB.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        skipPartTypes: SKIP_PARTS,
      },
    })

    expect(queryCalls).toBe(1)
    release?.({
      records: [{ info: message("msg_1", "user"), parts: [part("prt_1", "msg_1")] }],
      complete: true,
    })

    const [resultA, resultB] = await Promise.all([loadA, loadB])
    expect(resultA.status).toBe("ready")
    expect(resultB.status).toBe("ready")
    expect(storeA.commits).toHaveLength(1)
    expect(storeB.commits).toHaveLength(1)
    expect(storeA.state.message[sessionID]?.map((item) => item.id)).toEqual(["msg_1"])
    expect(storeB.state.message[sessionID]?.map((item) => item.id)).toEqual(["msg_1"])
  })

  test("live revision advance blocks a stale snapshot from overwriting the store", async () => {
    const existing = message("msg_live", "user")
    const existingPart = part("prt_live", "msg_live", "from sse")
    const store = createStore({
      message: { [sessionID]: [existing] },
      part: { msg_live: [existingPart] },
    })
    let liveRevision = 3

    const result = await loadSessionMessagePage({
      purpose: "recovery",
      runtimeKey: `${runtimeKey}-rev`,
      directory: `${directory}-rev`,
      sessionID,
      deps: {
        queryPage: async () => {
          liveRevision = 5
          return {
            records: [{ info: message("msg_stale", "user"), parts: [part("prt_stale", "msg_stale")] }],
            complete: true,
          }
        },
        getStoreState: store.getStoreState,
        commitStore: (reduced) => {
          store.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        getLiveRevision: () => liveRevision,
        skipPartTypes: SKIP_PARTS,
      },
    })

    expect(result.status).toBe("skipped")
    expect(result.applied).toBe(false)
    expect(store.commits).toHaveLength(0)
    expect(store.state.message[sessionID]?.[0]).toBe(existing)
    expect(store.state.part.msg_live?.[0]).toBe(existingPart)
  })

  test("assistant-only tail recovers the parent user message before commit", async () => {
    const store = createStore()
    const parentLoads: string[] = []

    const result = await loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: `${runtimeKey}-tail`,
      directory: `${directory}-tail`,
      sessionID,
      deps: {
        queryPage: async () => ({
          records: [{
            info: message("msg_assistant", "assistant", "msg_user"),
            parts: [part("prt_a", "msg_assistant")],
          }],
          complete: false,
          cursor: "msg_assistant",
        }),
        queryMessage: async ({ messageID }) => {
          parentLoads.push(messageID)
          return {
            info: message(messageID, "user"),
            parts: [part(`prt_${messageID}`, messageID)],
          }
        },
        getStoreState: store.getStoreState,
        commitStore: (reduced) => {
          store.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        skipPartTypes: SKIP_PARTS,
      },
    })

    expect(result.status).toBe("ready")
    expect(parentLoads).toEqual(["msg_user"])
    expect(store.state.message[sessionID]?.map((item) => item.id).sort()).toEqual(["msg_assistant", "msg_user"])
  })

  test("explicit limit override bypasses policy for the query", async () => {
    const store = createStore()
    let usedLimit = 0

    await loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: `${runtimeKey}-limit`,
      directory: `${directory}-limit`,
      sessionID,
      limit: 100,
      deps: {
        queryPage: async ({ limit }) => {
          usedLimit = limit
          return {
            records: [{ info: message("msg_1", "user"), parts: [part("prt_1", "msg_1")] }],
            complete: true,
          }
        },
        getStoreState: store.getStoreState,
        commitStore: (reduced) => {
          store.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        skipPartTypes: SKIP_PARTS,
      },
    })

    expect(usedLimit).toBe(100)
  })

  test("isStale after fetch skips store commit", async () => {
    const store = createStore()
    let stale = false

    const result = await loadSessionMessagePage({
      purpose: "initial",
      runtimeKey: `${runtimeKey}-stale`,
      directory: `${directory}-stale`,
      sessionID,
      deps: {
        queryPage: async () => {
          stale = true
          return {
            records: [{ info: message("msg_1", "user"), parts: [part("prt_1", "msg_1")] }],
            complete: true,
          }
        },
        getStoreState: store.getStoreState,
        commitStore: (reduced) => {
          store.commitStore({
            message: reduced.message,
            part: reduced.part,
            changed: reduced.changed,
          })
        },
        isStale: () => stale,
        skipPartTypes: SKIP_PARTS,
      },
    })

    expect(result.status).toBe("skipped")
    expect(result.applied).toBe(false)
    expect(store.commits).toHaveLength(0)
  })
})
