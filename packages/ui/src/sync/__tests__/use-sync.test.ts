import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2/client"

import { getReactiveSessionMessageRequestLimit, hasSessionMessageBoundary } from "../use-sync"

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

  test("keeps before pagination at 30 messages", () => {
    expect(getReactiveSessionMessageRequestLimit({
      before: "cursor",
      recordedLimit: 100,
      renderedMessageCount: 100,
    })).toBe(30)
  })
})
