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
  test("product limit is turns — floor is link-tier initial (local 3 when not on relay)", () => {
    // Default test env has no active relay → local tier.
    expect(getReactiveSessionMessageRequestLimit({
      recordedLimit: 0,
    })).toBe(3)
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
 * Tail/prepend paging transport moved out of the useSync hook into the Query
 * transcript repository, so these structural contracts pin the production
 * adapter that now issues the Host turn-page request. Behaviour is covered by
 * `../use-sync.test.ts` (boundary meta, load plan) and
 * `../session-turn-page-api.test.ts` (request and response shape).
 */
describe("Host turn-page transport source contract (production transcript repository)", () => {
  const productionSource = readFileSync(join(here, "../transcript-repository-production.ts"), "utf8")

  test("paging goes through the Host turn-page purpose helper", () => {
    expect(
      productionSource.includes('from "./session-turn-page-api"')
      || productionSource.includes("from './session-turn-page-api'"),
    ).toBe(true)
    expect(productionSource.includes("fetchHostSessionTurnPageForPurpose(")).toBe(true)
  })

  test("turn-page complete uses strict page.complete (no || !cursor mask)", () => {
    expect(productionSource.includes("page.complete || !cursor")).toBe(false)
    expect(productionSource.includes("page.complete ||!cursor")).toBe(false)
    expect(/complete:\s*page\.complete\b/.test(productionSource)).toBe(true)
  })
})