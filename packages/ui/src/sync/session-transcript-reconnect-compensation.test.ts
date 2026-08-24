import { afterEach, describe, expect, test } from "vitest"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/react-query"

import {
  createQueryTranscriptRepository,
} from "./transcript-repository-query-adapter"
import {
  collectImmediateCompensationSessions,
  createTranscriptReconnectCompensationController,
  type QueryTranscriptCompensationRepository,
} from "./session-transcript-reconnect-compensation"
import {
  isUserAuthoredTurnBoundaryMessage,
  selectStableTranscriptAnchorMessageID,
} from "./session-transcript-recovery-checkpoint"
import type { SessionTranscriptReconcilePage } from "./session-transcript-reconcile-api"
import {
  registerTranscriptReconnectCompensationController,
  notifyTranscriptReconnectCompensation,
  notifyTranscriptReconnectDisconnect,
  hasTranscriptReconnectCompensationController,
} from "./transcript-reconnect-compensation-runtime"
import { isTranscriptResyncInFlight } from "./transcript-resync-flight"
import type { SessionTranscriptFetcher } from "./session-message-query"
import { seedCanonicalTranscriptQuery } from "./session-transcript-query-cache"

const TRANSPORT = "test-transport"
const GENERATION = 1
const DIRECTORY = "/repo"

function msg(
  id: string,
  role: "user" | "assistant",
  extras: Partial<Message> = {},
): Message {
  return {
    id,
    sessionID: "ses_1",
    role,
    time: { created: 1 },
    ...extras,
  } as Message
}

function part(id: string, messageID: string, type = "text", text = "x"): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

function reconcilePage(
  overrides: Partial<SessionTranscriptReconcilePage> = {},
): SessionTranscriptReconcilePage {
  return {
    records: [],
    anchorFound: true,
    capturedHeadMessageID: "msg_head",
    latestHeadMessageID: "msg_head",
    continuation: null,
    complete: true,
    resetRequired: false,
    scannedRecords: 0,
    responseBytes: 0,
    ...overrides,
  }
}

function createFetcher(records: Array<{ info: Message; parts?: Part[] }>): SessionTranscriptFetcher {
  return async () => ({
    records,
    complete: true,
    turnCount: records.filter((r) => r.info.role === "user").length,
  })
}

function createRepo(client: QueryClient, fetcher?: SessionTranscriptFetcher) {
  return createQueryTranscriptRepository({
    client,
    transport: TRANSPORT,
    generation: GENERATION,
    probe: {
      getTransport: () => TRANSPORT,
      getGeneration: () => GENERATION,
    },
    fetcher: fetcher ?? createFetcher([]),
  }) as QueryTranscriptCompensationRepository
}

describe("isUserAuthoredTurnBoundaryMessage / selectStableTranscriptAnchorMessageID", () => {
  test("selects newest authored user turn; skips assistant heads", () => {
    const transcript = {
      messageOrder: ["u1", "a1", "u2", "a2"],
      messagesByID: {
        u1: msg("u1", "user"),
        a1: msg("a1", "assistant"),
        u2: msg("u2", "user"),
        a2: msg("a2", "assistant"),
      },
      partsByMessageID: {
        u1: [part("p1", "u1")],
        a1: [part("p2", "a1")],
        u2: [part("p3", "u2")],
        a2: [part("p4", "a2")],
      },
    }
    expect(selectStableTranscriptAnchorMessageID(transcript)).toBe("u2")
  })

  test("skips fully synthetic, subtask, compaction user rows", () => {
    expect(
      isUserAuthoredTurnBoundaryMessage(msg("s1", "user"), [
        { id: "p", messageID: "s1", type: "text", text: "x", synthetic: true } as Part,
      ]),
    ).toBe(false)
    expect(
      isUserAuthoredTurnBoundaryMessage(msg("s2", "user"), [
        { id: "p", messageID: "s2", type: "subtask" } as Part,
      ]),
    ).toBe(false)
    expect(
      isUserAuthoredTurnBoundaryMessage(msg("s3", "user"), [
        { id: "p", messageID: "s3", type: "compaction" } as Part,
      ]),
    ).toBe(false)
    expect(
      isUserAuthoredTurnBoundaryMessage(msg("s4", "user"), [part("p", "s4")]),
    ).toBe(true)
  })

  test("honors clientRole when role is absent", () => {
    const message = {
      id: "u1",
      sessionID: "ses_1",
      clientRole: "user",
      time: { created: 1 },
    } as unknown as Message
    expect(isUserAuthoredTurnBoundaryMessage(message, [])).toBe(true)
  })
})

describe("collectImmediateCompensationSessions", () => {
  test("unions active, viewed, busy/retry with viewed first", () => {
    const result = collectImmediateCompensationSessions({
      directory: DIRECTORY,
      activeScopes: [
        { directory: DIRECTORY, sessionID: "ses_active" },
        { directory: DIRECTORY, sessionID: "ses_busy" },
      ],
      viewed: { directory: DIRECTORY, sessionID: "ses_viewed" },
      busyOrRetrySessionIDs: ["ses_busy", "ses_retry"],
    })
    expect(result.map((r) => r.sessionID)).toEqual([
      "ses_viewed",
      "ses_busy",
      "ses_retry",
      "ses_active",
    ])
  })

  test("keeps context-panel viewed sessions ahead of main viewed and active", () => {
    const result = collectImmediateCompensationSessions({
      directory: DIRECTORY,
      activeScopes: [{ directory: DIRECTORY, sessionID: "ses_active" }],
      viewedSessions: [
        { directory: DIRECTORY, sessionID: "ses_panel_child" },
        { directory: DIRECTORY, sessionID: "ses_main" },
      ],
      viewed: { directory: DIRECTORY, sessionID: "ses_main" },
      busyOrRetrySessionIDs: [],
    })
    expect(result.map((r) => r.sessionID)).toEqual([
      "ses_panel_child",
      "ses_main",
      "ses_active",
    ])
  })

  test("ignores viewed from another directory", () => {
    const result = collectImmediateCompensationSessions({
      directory: DIRECTORY,
      activeScopes: [],
      viewed: { directory: "/other", sessionID: "ses_viewed" },
      busyOrRetrySessionIDs: ["ses_a"],
    })
    expect(result.map((r) => r.sessionID)).toEqual(["ses_a"])
  })
})

describe("createTranscriptReconnectCompensationController", () => {
  let client: QueryClient
  let controllers: Array<ReturnType<typeof createTranscriptReconnectCompensationController>> = []

  afterEach(() => {
    for (const c of controllers) c.destroy()
    controllers = []
    registerTranscriptReconnectCompensationController(null)
    client?.clear()
  })

  function makeController(options: {
    repo?: QueryTranscriptCompensationRepository
    fetchReconcile?: (
      input: Parameters<
        NonNullable<
          Parameters<typeof createTranscriptReconnectCompensationController>[0]["fetchReconcile"]
        >
      >[0],
    ) => Promise<SessionTranscriptReconcilePage>
    busy?: Record<string, string[]>
    viewed?: { directory: string; sessionID: string } | null
    generation?: number
    directoryConcurrency?: number
    now?: () => number
    confirmSessionStatus?: (
      ref: { directory: string; sessionID: string },
      hint: { tailOpen: boolean },
    ) => Promise<void>
    destructiveResetDedupeMs?: number
  } = {}) {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const repo = options.repo ?? createRepo(client)
    let generation = options.generation ?? GENERATION
    const controller = createTranscriptReconnectCompensationController({
      client,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: (directory) => options.busy?.[directory] ?? [],
      getViewedSession: () => options.viewed ?? null,
      transport: TRANSPORT,
      generation,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => generation,
      },
      directoryConcurrency: options.directoryConcurrency ?? 2,
      fetchReconcile: options.fetchReconcile,
      now: options.now,
      confirmSessionStatus: options.confirmSessionStatus,
      destructiveResetDedupeMs: options.destructiveResetDedupeMs,
    })
    controllers.push(controller)
    return {
      client,
      repo,
      controller,
      setGeneration: (next: number) => {
        generation = next
      },
    }
  }

  test("first ready isReconnect:false skips gap compensation (no fetch)", async () => {
    let fetches = 0
    const { controller, repo } = makeController({
      fetchReconcile: async () => {
        fetches += 1
        return reconcilePage()
      },
    })
    // Seed a session so capture would schedule work if compensation ran.
    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: null,
      runtimeGeneration: GENERATION,
      reason: "ready",
      transport: "ws",
      isReconnect: false,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(fetches).toBe(0)
  })

  test("viewed reconcile marks resync flight in-flight; success and failure both clear it", async () => {
    const user = msg("u1", "user")
    let releaseFetch!: (page: SessionTranscriptReconcilePage) => void
    const gate = new Promise<SessionTranscriptReconcilePage>((resolve) => {
      releaseFetch = resolve
    })
    let fetchCalls = 0
    const localClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(localClient, createFetcher([{ info: user, parts: [part("p1", "u1")] }]))
    const controller = createTranscriptReconnectCompensationController({
      client: localClient,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        fetchCalls += 1
        if (fetchCalls === 1) return gate
        throw new Error("network down")
      },
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })

    // First compensation round: gated fetch holds the reconcile in flight.
    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: 1,
      runtimeGeneration: GENERATION,
      reason: "ready",
      transport: "ws",
      isReconnect: true,
    })
    for (let i = 0; i < 100 && !isTranscriptResyncInFlight("ses_1", DIRECTORY); i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(isTranscriptResyncInFlight("ses_1", DIRECTORY)).toBe(true)

    releaseFetch(reconcilePage())
    for (let i = 0; i < 100 && isTranscriptResyncInFlight("ses_1", DIRECTORY); i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(isTranscriptResyncInFlight("ses_1", DIRECTORY)).toBe(false)

    // Second round: a failed fetch must clear the flight too (finally-ended).
    controller.captureCheckpoints({ lastEventID: "evt_2", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_2",
      disconnectedAt: 2,
      runtimeGeneration: GENERATION,
      reason: "ready",
      transport: "ws",
      isReconnect: true,
    })
    for (let i = 0; i < 100 && !isTranscriptResyncInFlight("ses_1", DIRECTORY); i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(isTranscriptResyncInFlight("ses_1", DIRECTORY)).toBe(true)
    for (let i = 0; i < 100 && isTranscriptResyncInFlight("ses_1", DIRECTORY); i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(isTranscriptResyncInFlight("ses_1", DIRECTORY)).toBe(false)
  })

  test("checkpoint is fixed before compensation; anchor is authored user", async () => {
    const user = msg("u1", "user")
    const assistant = msg("a1", "assistant")
    const fetcher = createFetcher([
      { info: user, parts: [part("p1", "u1")] },
      { info: assistant, parts: [part("p2", "a1")] },
    ])
    const { controller, repo, client: qc } = makeController({
      repo: createRepo(new QueryClient({ defaultOptions: { queries: { retry: false } } }), fetcher),
    })
    // Use the same client as controller
    void qc
    const harness = makeController({
      fetchReconcile: async () =>
        reconcilePage({
          records: [
            { info: user, parts: [part("p1", "u1")] },
            { info: assistant, parts: [part("p2", "a1")] },
          ],
          capturedHeadMessageID: "a1",
          latestHeadMessageID: "a1",
        }),
    })
    const realRepo = createRepo(harness.client, fetcher)
    // Rebuild controller with real repo bound to same client
    harness.controller.destroy()
    const controller2 = createTranscriptReconnectCompensationController({
      client: harness.client,
      repository: realRepo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () =>
        reconcilePage({
          records: [
            { info: user, parts: [part("p1", "u1")] },
            { info: assistant, parts: [part("p2", "a1")] },
          ],
          capturedHeadMessageID: "a1",
          latestHeadMessageID: "a1",
        }),
    })
    controllers.push(controller2)

    await realRepo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })

    // Retain as active observer so session is in immediate set.
    const unsub = realRepo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller2.captureCheckpoints({ lastEventID: "evt_gap", reason: "disconnect" })
    const cp = controller2.getCheckpoint({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(cp?.anchorMessageID).toBe("u1")
    expect(cp?.lastEventID).toBe("evt_gap")
    expect(cp?.state).toBe("pending")

    // Mutate transcript after capture — checkpoint must stay fixed.
    realRepo.apply(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      {
        type: "http-page",
        purpose: "recovery",
        page: {
          records: [{ info: msg("u_new", "user"), parts: [part("pn", "u_new")] }],
          complete: true,
          turnCount: 1,
        },
      },
    )
    const cpAfter = controller2.getCheckpoint({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(cpAfter?.anchorMessageID).toBe("u1")

    unsub()
    void controller
    void repo
  })

  test("serial continuation within one round; multi-round head chase", async () => {
    const user = msg("u1", "user")
    const a1 = msg("a1", "assistant")
    const a2 = msg("a2", "assistant")
    const a3 = msg("a3", "assistant")
    const fetcher = createFetcher([
      { info: user, parts: [part("p1", "u1")] },
      { info: a1, parts: [part("p2", "a1")] },
    ])
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, fetcher)
    const calls: Array<{ anchor?: string; continuation?: string }> = []

    let pageStep = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async (input) => {
        calls.push({
          anchor: input.anchor,
          continuation: input.continuation,
        })
        pageStep += 1
        // Round 1 page 1: partial continuation
        if (pageStep === 1) {
          return reconcilePage({
            records: [{ info: a2, parts: [part("p3", "a2")] }],
            capturedHeadMessageID: "a2",
            latestHeadMessageID: "a3",
            continuation: "cont_1",
            complete: false,
          })
        }
        // Round 1 page 2: complete round with captured a2, latest still a3
        if (pageStep === 2) {
          return reconcilePage({
            records: [{ info: a3, parts: [part("p4", "a3")] }],
            capturedHeadMessageID: "a2",
            latestHeadMessageID: "a3",
            continuation: null,
            complete: true,
          })
        }
        // Round 2: anchor = previous captured head a2; now stable
        return reconcilePage({
          records: [],
          capturedHeadMessageID: "a3",
          latestHeadMessageID: "a3",
          continuation: null,
          complete: true,
        })
      },
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    // Wait for flights
    for (let i = 0; i < 50; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(calls.length).toBeGreaterThanOrEqual(3)
    // First request uses anchor, second uses continuation, third new round anchor.
    expect(calls[0]?.anchor).toBe("u1")
    expect(calls[1]?.continuation).toBe("cont_1")
    expect(calls[2]?.anchor).toBe("a2")

    const transcript = repo.getTranscript({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    // Boundary must remain from ensureInitial (exhausted), not reconcile complete.
    expect(transcript.boundary.kind).toBe("exhausted")
    expect(transcript.messageOrder).toContain("a2")
    expect(transcript.messageOrder).toContain("a3")

    const cp = controller.getCheckpoint({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(cp?.state).toBe("complete")

    unsub()
  })

  test("resetRequired invokes destructiveReset and clears old chain", async () => {
    const user = msg("u1", "user")
    const a1 = msg("a1", "assistant")
    const tailUser = msg("u_tail", "user")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let ensureCalls = 0
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => {
        ensureCalls += 1
        if (ensureCalls === 1) {
          return {
            records: [
              { info: user, parts: [part("p1", "u1")] },
              { info: a1, parts: [part("p2", "a1")] },
            ],
            complete: false,
            cursor: "cur_old",
            turnCount: 1,
          }
        }
        return {
          records: [{ info: tailUser, parts: [part("pt", "u_tail")] }],
          complete: true,
          turnCount: 1,
        }
      },
    }) as QueryTranscriptCompensationRepository

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () =>
        reconcilePage({
          resetRequired: true,
          complete: true,
          records: [],
          continuation: null,
        }),
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    for (let i = 0; i < 50; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    const transcript = repo.getTranscript({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(transcript.messageOrder).toEqual(["u_tail"])
    expect(transcript.messageOrder).not.toContain("u1")
    expect(ensureCalls).toBeGreaterThanOrEqual(2)

    unsub()
  })

  test("repeated resetRequired within dedupe window degrades to ensureInitial", async () => {
    const user = msg("u1", "user")
    const openAssistant = msg("a_open", "assistant")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let clock = 1_000
    let destructiveCalls = 0
    let ensureInitialCalls = 0
    const confirmCalls: Array<{ sessionID: string; tailOpen: boolean }> = []

    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => ({
        records: [
          { info: user, parts: [part("p1", "u1")] },
          { info: openAssistant, parts: [part("p2", "a_open")] },
        ],
        complete: true,
        turnCount: 1,
      }),
    }) as QueryTranscriptCompensationRepository
    const originalEnsure = repo.ensureInitial.bind(repo)
    repo.ensureInitial = async (scope) => {
      ensureInitialCalls += 1
      return originalEnsure(scope)
    }
    const originalDestructive = repo.destructiveReset.bind(repo)
    repo.destructiveReset = async (scope) => {
      destructiveCalls += 1
      return originalDestructive(scope)
    }

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      now: () => clock,
      destructiveResetDedupeMs: 1_000,
      confirmSessionStatus: async (ref, hint) => {
        confirmCalls.push({ sessionID: ref.sessionID, tailOpen: hint.tailOpen })
      },
      fetchReconcile: async () =>
        reconcilePage({
          resetRequired: true,
          complete: true,
          records: [],
          continuation: null,
        }),
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    const runFlight = async () => {
      controller.captureCheckpoints({ lastEventID: `evt_${clock}`, reason: "disconnect" })
      controller.onCompensation({
        lastEventId: `evt_${clock}`,
        disconnectedAt: clock,
        runtimeGeneration: GENERATION,
        reason: "reconnect",
        transport: "ws",
        isReconnect: true,
      })
      for (let i = 0; i < 80; i += 1) {
        if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
        await new Promise((r) => setTimeout(r, 10))
      }
    }

    await runFlight()
    expect(destructiveCalls).toBe(1)
    const ensureAfterFirst = ensureInitialCalls
    expect(confirmCalls).toEqual([{ sessionID: "ses_1", tailOpen: true }])

    // Second independent flight inside the dedupe window → ensure, not reset.
    clock += 100
    await runFlight()
    expect(destructiveCalls).toBe(1)
    expect(ensureInitialCalls).toBeGreaterThan(ensureAfterFirst)
    expect(confirmCalls).toEqual([
      { sessionID: "ses_1", tailOpen: true },
      { sessionID: "ses_1", tailOpen: true },
    ])

    unsub()
  })

  test("resetRequired after dedupe window expires runs destructive again", async () => {
    const user = msg("u1", "user")
    const openAssistant = msg("a_open", "assistant")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let clock = 1_000
    let destructiveCalls = 0

    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => ({
        records: [
          { info: user, parts: [part("p1", "u1")] },
          { info: openAssistant, parts: [part("p2", "a_open")] },
        ],
        complete: true,
        turnCount: 1,
      }),
    }) as QueryTranscriptCompensationRepository
    const originalDestructive = repo.destructiveReset.bind(repo)
    repo.destructiveReset = async (scope) => {
      destructiveCalls += 1
      return originalDestructive(scope)
    }

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      now: () => clock,
      destructiveResetDedupeMs: 1_000,
      fetchReconcile: async () =>
        reconcilePage({
          resetRequired: true,
          complete: true,
          records: [],
          continuation: null,
        }),
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    const runFlight = async () => {
      controller.captureCheckpoints({ lastEventID: `evt_${clock}`, reason: "disconnect" })
      controller.onCompensation({
        lastEventId: `evt_${clock}`,
        disconnectedAt: clock,
        runtimeGeneration: GENERATION,
        reason: "reconnect",
        transport: "ws",
        isReconnect: true,
      })
      for (let i = 0; i < 80; i += 1) {
        if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
        await new Promise((r) => setTimeout(r, 10))
      }
    }

    await runFlight()
    expect(destructiveCalls).toBe(1)

    clock += 1_001
    await runFlight()
    expect(destructiveCalls).toBe(2)

    unsub()
  })

  test("confirmSessionStatus rejection does not fail the reconcile flight", async () => {
    const user = msg("u1", "user")
    const openAssistant = msg("a_open", "assistant")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let confirmCalls = 0

    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => ({
        records: [
          { info: user, parts: [part("p1", "u1")] },
          { info: openAssistant, parts: [part("p2", "a_open")] },
        ],
        complete: true,
        turnCount: 1,
      }),
    }) as QueryTranscriptCompensationRepository

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      confirmSessionStatus: async () => {
        confirmCalls += 1
        throw new Error("status confirm failed")
      },
      fetchReconcile: async () =>
        reconcilePage({
          resetRequired: true,
          complete: true,
          records: [],
          continuation: null,
        }),
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller.captureCheckpoints({ lastEventID: "evt_confirm", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_confirm",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })
    for (let i = 0; i < 80; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(confirmCalls).toBe(1)
    expect(controller.isSessionInFlight(DIRECTORY, "ses_1")).toBe(false)
    const cp = controller.getCheckpoint({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    // Successful destructive path clears the checkpoint (not left in error).
    expect(cp).toBeUndefined()

    unsub()
  })

  test("anchorless checkpoint takes non-destructive ensure path", async () => {
    // Transcript with only assistant messages → no stable user anchor.
    const a1 = msg("a1", "assistant")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let ensureInitialCalls = 0
    let destructiveCalls = 0
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => ({
        records: [{ info: a1, parts: [part("p1", "a1")] }],
        complete: true,
        turnCount: 0,
      }),
    }) as QueryTranscriptCompensationRepository
    const originalEnsure = repo.ensureInitial.bind(repo)
    repo.ensureInitial = async (scope) => {
      ensureInitialCalls += 1
      return originalEnsure(scope)
    }
    const originalDestructive = repo.destructiveReset.bind(repo)
    repo.destructiveReset = async (scope) => {
      destructiveCalls += 1
      return originalDestructive(scope)
    }

    let reconcileCalls = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        reconcileCalls += 1
        return reconcilePage()
      },
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    const cp = controller.getCheckpoint({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(cp?.anchorMessageID).toBe(null)

    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    for (let i = 0; i < 50; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(reconcileCalls).toBe(0)
    expect(destructiveCalls).toBe(0)
    expect(ensureInitialCalls).toBeGreaterThanOrEqual(2)
    expect(
      repo.getTranscript({
        directory: DIRECTORY,
        sessionID: "ses_1",
        transport: TRANSPORT,
        generation: GENERATION,
      }).messageOrder,
    ).toContain("a1")
    unsub()
  })

  test("subtask-only child session survives reconnect ensure failure without wipe", async () => {
    const subtaskUser = msg("u_sub", "user")
    const assistant = msg("a_sub", "assistant")
    const subtaskPart = { id: "p_sub", messageID: "u_sub", sessionID: "ses_child", type: "subtask" } as Part
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let ensureInitialCalls = 0
    let destructiveCalls = 0
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => ({
        records: [
          { info: subtaskUser, parts: [subtaskPart] },
          { info: assistant, parts: [part("p_a", "a_sub")] },
        ],
        complete: true,
        turnCount: 0,
      }),
    }) as QueryTranscriptCompensationRepository
    const originalEnsure = repo.ensureInitial.bind(repo)
    repo.ensureInitial = async (scope) => {
      ensureInitialCalls += 1
      if (ensureInitialCalls === 1) return originalEnsure(scope)
      throw new Error("tail_fetch_failed")
    }
    const originalDestructive = repo.destructiveReset.bind(repo)
    repo.destructiveReset = async (scope) => {
      destructiveCalls += 1
      return originalDestructive(scope)
    }

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => ["ses_child"],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_main" }),
      getViewedSessions: () => [
        { directory: DIRECTORY, sessionID: "ses_child" },
        { directory: DIRECTORY, sessionID: "ses_main" },
      ],
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => reconcilePage(),
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_child",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_child", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    expect(
      selectStableTranscriptAnchorMessageID(
        repo.getTranscript({
          directory: DIRECTORY,
          sessionID: "ses_child",
          transport: TRANSPORT,
          generation: GENERATION,
        }),
      ),
    ).toBe(null)

    controller.captureCheckpoints({ lastEventID: "evt_child", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_child",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    for (let i = 0; i < 50; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_child")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(destructiveCalls).toBe(0)
    expect(ensureInitialCalls).toBeGreaterThanOrEqual(2)
    expect(
      repo.getTranscript({
        directory: DIRECTORY,
        sessionID: "ses_child",
        transport: TRANSPORT,
        generation: GENERATION,
      }).messageOrder,
    ).toEqual(["u_sub", "a_sub"])
    unsub()
  })

  test("directory concurrency is at most 2", async () => {
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const sessions = ["ses_a", "ses_b", "ses_c", "ses_d"]
    const fetcher: SessionTranscriptFetcher = async (input) => ({
      records: [
        {
          info: msg(`u_${input.sessionID}`, "user", { sessionID: input.sessionID }),
          parts: [part(`p_${input.sessionID}`, `u_${input.sessionID}`)],
        },
      ],
      complete: true,
      turnCount: 1,
    })
    const repo = createRepo(clientLocal, fetcher)

    let inFlight = 0
    let maxInFlight = 0
    const releaseGates: Array<() => void> = []

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => sessions,
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      directoryConcurrency: 2,
      fetchReconcile: async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise<void>((resolve) => {
          releaseGates.push(() => {
            inFlight -= 1
            resolve()
          })
        })
        return reconcilePage({
          capturedHeadMessageID: "h",
          latestHeadMessageID: "h",
        })
      },
    })
    controllers.push(controller)

    for (const sessionID of sessions) {
      await repo.ensureInitial({
        directory: DIRECTORY,
        sessionID,
        transport: TRANSPORT,
        generation: GENERATION,
      })
    }

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    // Let pumps start
    await new Promise((r) => setTimeout(r, 30))
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(inFlight).toBeLessThanOrEqual(2)

    // Release all
    while (releaseGates.length > 0) {
      const release = releaseGates.shift()!
      release()
      await new Promise((r) => setTimeout(r, 5))
    }
    for (let i = 0; i < 50; i += 1) {
      if (sessions.every((s) => !controller.isSessionInFlight(DIRECTORY, s))) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  test("generation switch cancels in-flight and discards commit", async () => {
    const user = msg("u1", "user")
    const fetcher = createFetcher([{ info: user, parts: [part("p1", "u1")] }])
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let generation = GENERATION
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => generation,
      },
      fetcher,
    }) as QueryTranscriptCompensationRepository

    let resolveFetch: (() => void) | undefined
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => generation,
      },
      fetchReconcile: async () => {
        await new Promise<void>((resolve) => {
          resolveFetch = resolve
        })
        return reconcilePage({
          records: [{ info: msg("a_gap", "assistant"), parts: [part("pg", "a_gap")] }],
          capturedHeadMessageID: "a_gap",
          latestHeadMessageID: "a_gap",
        })
      },
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    await new Promise((r) => setTimeout(r, 20))
    expect(controller.isSessionInFlight(DIRECTORY, "ses_1")).toBe(true)

    // Switch generation and cancel
    generation = GENERATION + 1
    controller.cancelAll("runtime_switch")
    resolveFetch?.()
    await new Promise((r) => setTimeout(r, 30))

    const transcript = repo.getTranscript({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    // Old generation data must not have received the gap message.
    expect(transcript.messageOrder).not.toContain("a_gap")

    unsub()
  })

  test("single-flight: double schedule does not double-fetch", async () => {
    const user = msg("u1", "user")
    const fetcher = createFetcher([{ info: user, parts: [part("p1", "u1")] }])
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, fetcher)
    let fetches = 0
    let release: (() => void) | undefined

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        fetches += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return reconcilePage({
          capturedHeadMessageID: "u1",
          latestHeadMessageID: "u1",
        })
      },
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const unsub = repo.subscribe(
      { directory: DIRECTORY, sessionID: "ses_1", transport: TRANSPORT, generation: GENERATION },
      () => {},
    )

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    const trigger = {
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws" as const,
      isReconnect: true,
    }
    controller.onCompensation(trigger)
    controller.onCompensation(trigger)
    await new Promise((r) => setTimeout(r, 20))
    expect(fetches).toBe(1)
    release?.()
    for (let i = 0; i < 30; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fetches).toBe(1)
    unsub()
  })

  test("SSE live revision race: reconcile page does not erase newer live message", async () => {
    const user = msg("u1", "user")
    const liveAssistant = msg("a1", "assistant")
    const staleAssistant = {
      ...msg("a1", "assistant"),
      time: { created: 1 },
    } as unknown as Message
    // Same part ID as the SSE update below: in-flight HTTP must not overwrite
    // the live-newer completion/text with a lagging reconcile snapshot.
    const sharedPartID = "p_shared"
    const fetcher = createFetcher([
      { info: user, parts: [part("p1", "u1")] },
      { info: liveAssistant, parts: [part(sharedPartID, "a1", "text", "live")] },
    ])
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, fetcher)

    let releaseFetch: (() => void) | undefined
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => ({ directory: DIRECTORY, sessionID: "ses_1" }),
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        await new Promise<void>((resolve) => {
          releaseFetch = resolve
        })
        return reconcilePage({
          records: [
            { info: user, parts: [part("p1", "u1")] },
            {
              info: staleAssistant,
              parts: [part(sharedPartID, "a1", "text", "stale-lagging")],
            },
          ],
          capturedHeadMessageID: "a1",
          latestHeadMessageID: "a1",
        })
      },
    })
    controllers.push(controller)

    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const scope = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    const unsub = repo.subscribe(scope, () => {})

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })
    await new Promise((r) => setTimeout(r, 10))

    // Advance live revision via SSE while HTTP is in flight — same part ID,
    // completed / non-streaming text that a lagging reconcile must not clobber.
    const before = repo.getTranscript(scope)
    repo.apply(scope, {
      type: "sse-event",
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: sharedPartID,
            messageID: "a1",
            sessionID: "ses_1",
            type: "text",
            text: "live-newer",
            time: { start: 1, end: 2 },
          },
        },
      } as never,
    })
    const mid = repo.getTranscript(scope)
    expect(mid.liveRevision).toBeGreaterThan(before.liveRevision)
    const midShared = (mid.partsByMessageID["a1"] ?? []).find((p) => p.id === sharedPartID)
    expect((midShared as { text?: string } | undefined)?.text).toBe("live-newer")

    releaseFetch?.()
    for (let i = 0; i < 40; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_1")) break
      await new Promise((r) => setTimeout(r, 10))
    }

    const after = repo.getTranscript(scope)
    // Boundary preserved.
    expect(after.boundary).toEqual(before.boundary)
    // Stale recovery/reconcile is insert-only for messages and skip-existing for
    // parts: keep live-newer, never reintroduce the lagging snapshot text.
    const parts = after.partsByMessageID["a1"] ?? []
    const shared = parts.find((p) => p.id === sharedPartID)
    expect((shared as { text?: string } | undefined)?.text).toBe("live-newer")
    const texts = parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text?: string }).text)
    expect(texts).toContain("live-newer")
    expect(texts).not.toContain("stale-lagging")
    expect(texts).not.toContain("live")

    unsub()
  })

  test("canonical-only directory + busy session gets checkpoint before ready and schedules task", async () => {
    // listDirectories omits /other; busy session only appears via canonical cache.
    const OTHER_DIR = "/other"
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = msg("u_busy", "user")
    const fetcher: SessionTranscriptFetcher = async (input) => ({
      records: [
        {
          info: msg(`u_${input.sessionID}`, "user", { sessionID: input.sessionID }),
          parts: [part(`p_${input.sessionID}`, `u_${input.sessionID}`)],
        },
      ],
      complete: true,
      turnCount: 1,
    })
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher,
    }) as QueryTranscriptCompensationRepository

    // Seed canonical transcript under a directory that listDirectories will omit.
    await repo.ensureInitial({
      directory: OTHER_DIR,
      sessionID: "ses_busy_only",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    // Also seed the user message id used as anchor for clarity.
    repo.apply(
      {
        directory: OTHER_DIR,
        sessionID: "ses_busy_only",
        transport: TRANSPORT,
        generation: GENERATION,
      },
      {
        type: "http-page",
        purpose: "recovery",
        page: {
          records: [{ info: user, parts: [part("p_busy", "u_busy")] }],
          complete: true,
          turnCount: 1,
        },
      },
    )

    const busyMap: Record<string, string[]> = {
      [OTHER_DIR]: ["ses_busy_only"],
    }
    let reconcileFetches = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      // Intentionally omit OTHER_DIR — only canonical + busy must discover it.
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: (directory) => busyMap[directory] ?? [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async (input) => {
        reconcileFetches += 1
        expect(input.sessionID).toBe("ses_busy_only")
        expect(input.directory).toBe(OTHER_DIR)
        return reconcilePage({
          capturedHeadMessageID: "u_busy",
          latestHeadMessageID: "u_busy",
        })
      },
    })
    controllers.push(controller)

    // Capture before ready (replay phase): checkpoint must exist for busy session.
    controller.captureCheckpoints({ lastEventID: "evt_busy", reason: "disconnect" })
    const cp = controller.getCheckpoint({
      directory: OTHER_DIR,
      sessionID: "ses_busy_only",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(cp).toBeDefined()
    expect(cp?.lastEventID).toBe("evt_busy")
    expect(cp?.directory).toBe(OTHER_DIR)
    expect(cp?.sessionID).toBe("ses_busy_only")

    // Ready: busy session under canonical-only directory enters the task queue.
    controller.onCompensation({
      lastEventId: "evt_busy",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    for (let i = 0; i < 50; i += 1) {
      if (!controller.isSessionInFlight(OTHER_DIR, "ses_busy_only") && reconcileFetches > 0) {
        break
      }
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(reconcileFetches).toBeGreaterThanOrEqual(1)
  })

  test("retained-only scope without canonical entry is in capture + immediate set", async () => {
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let ensureCalls = 0
    const user = msg("u1", "user")
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => {
        ensureCalls += 1
        return {
          records: [{ info: user, parts: [part("p1", "u1")] }],
          complete: true,
          turnCount: 1,
        }
      },
    }) as QueryTranscriptCompensationRepository
    const budget = repo.getCacheBudget!()

    // Retain a session that has no canonical InfiniteData yet (subscribe before ensure).
    const releaseRetain = budget.activeRegistry.retain({
      transport: TRANSPORT,
      generation: GENERATION,
      directory: DIRECTORY,
      sessionID: "ses_retained_only",
    })

    // No listCanonical entry for this session.
    expect(
      budget.listCanonical({ transport: TRANSPORT, generation: GENERATION })
        .some((e) => e.scope.sessionID === "ses_retained_only"),
    ).toBe(false)
    expect(
      budget.activeRegistry.listRetained()
        .some((s) => s.sessionID === "ses_retained_only"),
    ).toBe(true)

    let reconcileFetches = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      cacheBudget: budget,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        reconcileFetches += 1
        return reconcilePage({
          capturedHeadMessageID: "u1",
          latestHeadMessageID: "u1",
        })
      },
    })
    controllers.push(controller)

    // Capture includes retained-only scope even without canonical pages.
    controller.captureCheckpoints({ lastEventID: "evt_ret", reason: "disconnect" })
    const cp = controller.getCheckpoint({
      directory: DIRECTORY,
      sessionID: "ses_retained_only",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(cp).toBeDefined()
    expect(cp?.lastEventID).toBe("evt_ret")
    // Empty transcript → no stable user anchor yet.
    expect(cp?.anchorMessageID).toBe(null)

    controller.onCompensation({
      lastEventId: "evt_ret",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    for (let i = 0; i < 50; i += 1) {
      if (!controller.isSessionInFlight(DIRECTORY, "ses_retained_only") && ensureCalls > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    // Immediate set scheduled the retained session; anchorless path ensures tail
    // (non-destructive ensureInitial) rather than Host reconcile.
    expect(ensureCalls).toBeGreaterThanOrEqual(1)
    expect(reconcileFetches).toBe(0)
    releaseRetain()
  })

  test("inactive stale + ensureOnObserve runs ensure", async () => {
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    seedCanonicalTranscriptQuery(
      clientLocal,
      {
        transport: TRANSPORT,
        generation: GENERATION,
        directory: DIRECTORY,
        sessionID: "ses_inactive",
      },
      { pages: [], pageParams: [] },
    )
    let ensureCalls = 0
    const repo = createQueryTranscriptRepository({
      client: clientLocal,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetcher: async () => {
        ensureCalls += 1
        return {
          records: [{ info: msg("u1", "user"), parts: [part("p1", "u1")] }],
          complete: true,
          turnCount: 1,
        }
      },
    }) as QueryTranscriptCompensationRepository

    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => reconcilePage(),
    })
    controllers.push(controller)

    controller.captureCheckpoints({ lastEventID: "evt_1", reason: "disconnect" })
    controller.onCompensation({
      lastEventId: "evt_1",
      disconnectedAt: Date.now(),
      runtimeGeneration: GENERATION,
      reason: "reconnect",
      transport: "ws",
      isReconnect: true,
    })

    const result = await controller.ensureOnObserve({
      directory: DIRECTORY,
      sessionID: "ses_inactive",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    expect(result).not.toBe(null)
    expect(ensureCalls).toBeGreaterThanOrEqual(1)
  })

  test("observe-time head check fetches once; TTL skips the second observe", async () => {
    const user = msg("u1", "user")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, createFetcher([{ info: user, parts: [part("p1", "u1")] }]))
    let fetches = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        fetches += 1
        return reconcilePage({
          records: [],
          capturedHeadMessageID: "u1",
          latestHeadMessageID: "u1",
          complete: true,
        })
      },
    })
    controllers.push(controller)
    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })

    const scope = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    const first = await controller.ensureOnObserve(scope)
    expect(first).toBe(null)
    for (let i = 0; i < 50; i += 1) {
      if (fetches > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fetches).toBe(1)

    const second = await controller.ensureOnObserve(scope)
    expect(second).toBe(null)
    await new Promise((r) => setTimeout(r, 30))
    expect(fetches).toBe(1)
  })

  test("observe-time empty reconcile page leaves canonical unchanged and does not error", async () => {
    const user = msg("u1", "user")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, createFetcher([{ info: user, parts: [part("p1", "u1")] }]))
    let fetches = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        fetches += 1
        return reconcilePage({
          records: [],
          capturedHeadMessageID: "u1",
          latestHeadMessageID: "u1",
          complete: true,
        })
      },
    })
    controllers.push(controller)
    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const scope = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    const before = [...repo.getTranscript(scope).messageOrder]
    expect(before).toEqual(["u1"])

    await controller.ensureOnObserve(scope)
    for (let i = 0; i < 50; i += 1) {
      if (fetches > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fetches).toBe(1)
    expect(repo.getTranscript(scope).messageOrder).toEqual(before)
    expect(repo.getRequestState?.(scope)?.status).not.toBe("error")
  })

  test("observe-time reconcile upserts new records into canonical", async () => {
    const user = msg("u1", "user")
    const next = msg("a2", "assistant")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, createFetcher([{ info: user, parts: [part("p1", "u1")] }]))
    let fetches = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        fetches += 1
        return reconcilePage({
          records: [{ info: next, parts: [part("p2", "a2")] }],
          capturedHeadMessageID: "a2",
          latestHeadMessageID: "a2",
          complete: true,
        })
      },
    })
    controllers.push(controller)
    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const scope = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    expect(repo.getTranscript(scope).messageOrder).toEqual(["u1"])

    await controller.ensureOnObserve(scope)
    for (let i = 0; i < 50; i += 1) {
      if (repo.getTranscript(scope).messageOrder.includes("a2")) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fetches).toBe(1)
    expect(repo.getTranscript(scope).messageOrder).toContain("a2")
    expect(repo.getRequestState?.(scope)?.status).not.toBe("error")
  })

  test("observe-time reconcile fetch failure is silent and leaves state unchanged", async () => {
    const user = msg("u1", "user")
    const clientLocal = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const repo = createRepo(clientLocal, createFetcher([{ info: user, parts: [part("p1", "u1")] }]))
    let fetches = 0
    const controller = createTranscriptReconnectCompensationController({
      client: clientLocal,
      repository: repo,
      listDirectories: () => [DIRECTORY],
      getBusyOrRetrySessionIDs: () => [],
      getViewedSession: () => null,
      transport: TRANSPORT,
      generation: GENERATION,
      probe: {
        getTransport: () => TRANSPORT,
        getGeneration: () => GENERATION,
      },
      fetchReconcile: async () => {
        fetches += 1
        throw new Error("network down")
      },
    })
    controllers.push(controller)
    await repo.ensureInitial({
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    })
    const scope = {
      directory: DIRECTORY,
      sessionID: "ses_1",
      transport: TRANSPORT,
      generation: GENERATION,
    }
    const before = [...repo.getTranscript(scope).messageOrder]
    const beforeStatus = repo.getRequestState?.(scope)?.status

    await controller.ensureOnObserve(scope)
    for (let i = 0; i < 50; i += 1) {
      if (fetches > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fetches).toBe(1)
    expect(repo.getTranscript(scope).messageOrder).toEqual(before)
    expect(repo.getRequestState?.(scope)?.status).toBe(beforeStatus)
    expect(repo.getRequestState?.(scope)?.status).not.toBe("error")
  })
})

describe("transcript-reconnect-compensation-runtime seam", () => {
  afterEach(() => {
    registerTranscriptReconnectCompensationController(null)
  })

  test("unregistered seam is no-op (no dual-write)", () => {
    expect(hasTranscriptReconnectCompensationController()).toBe(false)
    notifyTranscriptReconnectDisconnect({ lastEventID: "x", reason: "d" })
    notifyTranscriptReconnectCompensation({
      lastEventId: "x",
      disconnectedAt: 1,
      runtimeGeneration: 1,
      reason: "r",
      transport: "ws",
      isReconnect: true,
    })
  })

  test("registered controller receives disconnect and compensation", () => {
    const events: string[] = []
    registerTranscriptReconnectCompensationController({
      captureCheckpoints: () => {
        events.push("capture")
      },
      onCompensation: (t) => {
        events.push(t.isReconnect ? "reconnect" : "first")
      },
      ensureOnObserve: async () => null,
      cancelAll: () => {
        events.push("cancel")
      },
      getCheckpoint: () => undefined,
      isSessionInFlight: () => false,
      destroy: () => {},
    })
    expect(hasTranscriptReconnectCompensationController()).toBe(true)
    notifyTranscriptReconnectDisconnect({ lastEventID: "e", reason: "d" })
    notifyTranscriptReconnectCompensation({
      lastEventId: "e",
      disconnectedAt: 1,
      runtimeGeneration: 1,
      reason: "r",
      transport: "ws",
      isReconnect: false,
    })
    notifyTranscriptReconnectCompensation({
      lastEventId: "e",
      disconnectedAt: 1,
      runtimeGeneration: 1,
      reason: "r",
      transport: "ws",
      isReconnect: true,
    })
    expect(events).toEqual(["capture", "first", "reconnect"])
  })
})
