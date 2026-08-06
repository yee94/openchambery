import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Message } from "@opencode-ai/sdk/v2/client"

import { getReactiveSessionMessageRequestLimit, hasSessionMessageBoundary } from "../use-sync"

const here = dirname(fileURLToPath(import.meta.url))

describe("hasSessionMessageBoundary", () => {
  test("requires a user boundary while a cached page remains partial", () => {
    const assistant = { id: "assistant", role: "assistant" } as Message
    const user = { id: "user", role: "user" } as Message

    expect(hasSessionMessageBoundary([assistant], false)).toBe(false)
    expect(hasSessionMessageBoundary([assistant, user], false)).toBe(true)
    expect(hasSessionMessageBoundary([assistant], true)).toBe(true)
  })
})

describe("getReactiveSessionMessageRequestLimit", () => {
  test("product limit is turns — floor is link-tier initial (local 6 when not on relay)", () => {
    // Default test env has no active relay → local tier.
    expect(getReactiveSessionMessageRequestLimit({
      recordedLimit: 0,
    })).toBe(6)
    expect(getReactiveSessionMessageRequestLimit({
      recordedLimit: 8,
      renderedMessageCount: 999,
    })).toBe(8)
  })

  test("prepend uses history turn limit (local 4 when not on relay)", () => {
    expect(getReactiveSessionMessageRequestLimit({
      before: "cursor",
      recordedLimit: 0,
    })).toBe(4)
  })
})

/**
 * loadMessages is a React hook callback; full injection of queryPage is hard
 * without mounting useSync. Source contracts pin:
 * - tail (no before): Host turn-page with initial turn budget (2)
 * - prepend + before: Host turn-page with history turn budget
 * - bare before without purpose prepend: official SDK session.messages only
 */
describe("loadMessages transport split source contract (Host turn-page for tail + prepend)", () => {
  const useSyncSource = readFileSync(join(here, "../use-sync.ts"), "utf8")

  test("imports Host turn-page purpose helper", () => {
    expect(
      useSyncSource.includes('from "./session-turn-page-api"')
      || useSyncSource.includes("from './session-turn-page-api'"),
    ).toBe(true)
    expect(useSyncSource.includes("fetchHostSessionTurnPageForPurpose")).toBe(true)
  })

  test("Host turn-page is used for tail and prepend, not bare before alone", () => {
    expect(useSyncSource.includes("useHostTurnPage")).toBe(true)
    expect(useSyncSource.includes("fetchHostSessionTurnPageForPurpose")).toBe(true)
    // Bare `before` alone must not be the sole gate into Host turn-page.
    expect(/if\s*\(\s*before\s*\)\s*\{[\s\S]*?fetchHostSessionTurnPageForPurpose/.test(useSyncSource)).toBe(false)
    expect(/if\s*\(\s*before\s*\)\s*\{[\s\S]*?fetchSessionTurnPage/.test(useSyncSource)).toBe(false)
  })

  test("turn-page complete uses strict page.complete (no || !cursor mask)", () => {
    expect(useSyncSource.includes("page.complete || !cursor")).toBe(false)
    expect(useSyncSource.includes("page.complete ||!cursor")).toBe(false)
    expect(/complete:\s*page\.complete\b/.test(useSyncSource)).toBe(true)
  })

  test("SDK session.messages remains as bare-before fallback only", () => {
    expect(useSyncSource.includes("scopedClient.session.messages(")).toBe(true)
  })

  test("getMetaFor derives from the child-store boundary via syncMetaFromBoundary", () => {
    // The directory child store's session_history_boundary is the only
    // pagination fact source; the hook only adapts it (+ local loading flag).
    expect(useSyncSource.includes("syncMetaFromBoundary")).toBe(true)
    expect(useSyncSource.includes("session_history_boundary")).toBe(true)
  })

  test("loadMore rethrows settled prefetch errors for explicit load-earlier UX", () => {
    expect(useSyncSource.includes('prefetch?.status === "error"')).toBe(true)
    expect(useSyncSource.includes("session turn page failed")).toBe(true)
  })

  test("cursor-less incomplete history refreshes the tail before prepend", () => {
    expect(useSyncSource.includes("resolveSessionHistoryLoadPlan")).toBe(true)
    expect(useSyncSource.includes('plan.kind === "recover-cursor"')).toBe(true)
    expect(useSyncSource.includes('purpose: "initial"')).toBe(true)
    expect(useSyncSource.includes("session history cursor unavailable after refresh")).toBe(true)
  })

  test("local loading flips publish a revision for immediate affordance updates", () => {
    expect(useSyncSource.includes("setLoadingRevision")).toBe(true)
    expect(useSyncSource.includes("loadingRevision")).toBe(true)
    expect(useSyncSource.includes("loadingRef")).toBe(true)
    // Returned sync identity must move with loadingRevision so ChatContainer
    // historyMeta.loading cannot stay stuck true after the flight clears.
    expect(useSyncSource).toMatch(/loadingRevision\s*\]/)
  })
})
