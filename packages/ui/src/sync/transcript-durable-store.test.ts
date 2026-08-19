import { describe, expect, test } from "bun:test"

import {
  DEFAULT_TRANSCRIPT_DURABLE_BYTE_BUDGET,
  MOBILE_TRANSCRIPT_DURABLE_BYTE_BUDGET,
  VSCODE_TRANSCRIPT_DURABLE_BYTE_BUDGET,
  getTranscriptDurableByteBudget,
} from "./session-cache-limits"
import { runTranscriptDurableStoreContract } from "./transcript-durable-store.contract"
import { createMemoryTranscriptDurableStore } from "./transcript-durable-store"

runTranscriptDurableStoreContract("memory", () => createMemoryTranscriptDurableStore())

describe("transcript durable byte budget", () => {
  test("uses 4 / 12 / 40 MiB for vscode / mobile / default", () => {
    expect(VSCODE_TRANSCRIPT_DURABLE_BYTE_BUDGET).toBe(4 * 1024 * 1024)
    expect(MOBILE_TRANSCRIPT_DURABLE_BYTE_BUDGET).toBe(12 * 1024 * 1024)
    expect(DEFAULT_TRANSCRIPT_DURABLE_BYTE_BUDGET).toBe(40 * 1024 * 1024)
    expect([
      VSCODE_TRANSCRIPT_DURABLE_BYTE_BUDGET,
      MOBILE_TRANSCRIPT_DURABLE_BYTE_BUDGET,
      DEFAULT_TRANSCRIPT_DURABLE_BYTE_BUDGET,
    ]).toContain(getTranscriptDurableByteBudget())
  })
})
