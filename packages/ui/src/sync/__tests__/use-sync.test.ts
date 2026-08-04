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
  test("keeps reactive tail retries above zero and covers rendered messages", () => {
    expect(getReactiveSessionMessageRequestLimit({
      recordedLimit: 0,
      renderedMessageCount: 0,
    })).toBeGreaterThan(0)
    expect(getReactiveSessionMessageRequestLimit({
      recordedLimit: 16,
      renderedMessageCount: 40,
    })).toBe(40)
  })

  test("initial (no before) still uses initial SDK page sizing, not scanLimit 100 as return count", () => {
    expect(getReactiveSessionMessageRequestLimit({
      recordedLimit: 0,
      renderedMessageCount: 0,
    })).toBe(30)
  })
})

/**
 * loadMessages is a React hook callback; full injection of queryPage is hard
 * without mounting useSync. These source-contract tests pin the intended split:
 * - initial / tail → official SDK session.messages
 * - prepend / loadMore (before set) → fetchSessionTurnPage (turn-page API)
 *
 * Limitation: this does not execute the hook; it fails if the production wiring
 * drifts before a deeper seam exists.
 */
describe("loadMessages transport split source contract (turn-page for prepend)", () => {
  const useSyncSource = readFileSync(join(here, "../use-sync.ts"), "utf8")

  test("imports fetchSessionTurnPage from session-turn-page-api", () => {
    expect(
      useSyncSource.includes('from "./session-turn-page-api"')
      || useSyncSource.includes("from './session-turn-page-api'"),
    ).toBe(true)
    expect(useSyncSource.includes("fetchSessionTurnPage")).toBe(true)
  })

  test("prepend/loadMore path uses turn-page API", () => {
    expect(useSyncSource.includes("fetchSessionTurnPage")).toBe(true)
    expect(/fetchSessionTurnPage\s*\(/.test(useSyncSource)).toBe(true)
  })

  test("turn-page gate requires purpose === 'prepend' && before (not bare before)", () => {
    // Malformed callers with only `before` must not hit Host turn-page.
    expect(
      /purpose\s*===\s*['"]prepend['"]\s*&&\s*before|options\?\.purpose\s*===\s*['"]prepend['"]\s*&&\s*before/.test(
        useSyncSource,
      )
      || /options\?\.purpose\s*===\s*['"]prepend['"][\s\S]{0,80}before/.test(useSyncSource),
    ).toBe(true)
    // Must not gate solely on `if (before)` for the turn-page branch.
    expect(/if\s*\(\s*before\s*\)\s*\{[\s\S]*?fetchSessionTurnPage/.test(useSyncSource)).toBe(false)
  })

  test("turn-page complete uses strict page.complete (no || !cursor mask)", () => {
    expect(useSyncSource.includes("page.complete || !cursor")).toBe(false)
    expect(useSyncSource.includes("page.complete ||!cursor")).toBe(false)
    // Positive: complete field is taken from the strict page payload.
    expect(/complete:\s*page\.complete\b/.test(useSyncSource)).toBe(true)
  })

  test("initial path still references official SDK session.messages", () => {
    expect(useSyncSource.includes("scopedClient.session.messages(")).toBe(true)
  })
})
