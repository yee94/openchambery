import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SESSION_MERGE_STRATEGY,
  resolveSessionMergeStrategy,
  shouldDropStalePage,
  shouldPreserveStreamingParts,
  type SessionMergeStrategy,
  type SessionMessagePagePurpose,
} from "../session-merge-strategy"

/**
 * Exhaustive purpose list — every listed item must be a valid purpose (`satisfies`),
 * and every purpose must be listed (see the exhaustiveness test below).
 * Adding a union member without updating this fails type-check.
 */
const PURPOSES = ["initial", "prepend", "recovery", "materialize"] as const satisfies readonly SessionMessagePagePurpose[]

/** MissingPurpose is `never` only when PURPOSES covers the full union. */
type MissingPurpose = Exclude<SessionMessagePagePurpose, (typeof PURPOSES)[number]>
type AssertNever<T extends never> = T

const RESOLUTION_TABLE: ReadonlyArray<{
  purpose: SessionMessagePagePurpose
  stale: boolean
  expected: SessionMergeStrategy
}> = [
  {
    purpose: "initial",
    stale: false,
    expected: {
      id: "initial",
      onStale: "drop",
      messages: "insert-only",
      parts: "replace",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "initial",
    stale: true,
    expected: {
      id: "initial",
      onStale: "drop",
      messages: "insert-only",
      parts: "replace",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "prepend",
    stale: false,
    expected: {
      id: "history",
      onStale: "drop",
      messages: "insert-only",
      parts: "skip-existing",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "prepend",
    stale: true,
    expected: {
      id: "history",
      onStale: "drop",
      messages: "insert-only",
      parts: "skip-existing",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "materialize",
    stale: false,
    expected: {
      id: "materialize",
      onStale: "drop",
      messages: "insert-only",
      parts: "replace",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "materialize",
    stale: true,
    expected: {
      id: "materialize",
      onStale: "drop",
      messages: "insert-only",
      parts: "replace",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "recovery",
    stale: false,
    expected: {
      id: "recovery",
      onStale: "backfill",
      messages: "upsert",
      parts: "replace",
      preserveStreaming: "assistant",
    },
  },
  {
    purpose: "recovery",
    stale: true,
    expected: {
      id: "recovery-backfill",
      onStale: "backfill",
      messages: "insert-only",
      parts: "replace",
      preserveStreaming: "assistant",
    },
  },
]

describe("resolveSessionMergeStrategy", () => {
  test("PURPOSES covers every SessionMessagePagePurpose", () => {
    // AssertNever requires MissingPurpose = never; a new union member fails type-check here.
    const exhaustive: AssertNever<MissingPurpose> = undefined as never
    expect(exhaustive).toBe(undefined)
  })

  for (const { purpose, stale, expected } of RESOLUTION_TABLE) {
    test(`purpose=${purpose} stale=${stale} resolves fully`, () => {
      const resolved = resolveSessionMergeStrategy({ purpose, stale })
      expect(resolved).toEqual(expected)
    })
  }

  // Staleness must downgrade exactly one dimension (messages: upsert → insert-only)
  // so a reconnect page fills SSE gaps without overwriting live objects.
  test("recovery staleness downgrades only messages", () => {
    const current = resolveSessionMergeStrategy({ purpose: "recovery", stale: false })
    const stale = resolveSessionMergeStrategy({ purpose: "recovery", stale: true })

    expect(stale.onStale).toBe(current.onStale)
    expect(stale.parts).toBe(current.parts)
    expect(stale.preserveStreaming).toBe(current.preserveStreaming)
    expect(current.messages).toBe("upsert")
    expect(stale.messages).toBe("insert-only")
    expect(stale.messages).not.toBe(current.messages)
  })

  for (const purpose of PURPOSES) {
    test(`omitting stale for purpose=${purpose} matches stale:false`, () => {
      expect(resolveSessionMergeStrategy({ purpose })).toEqual(
        resolveSessionMergeStrategy({ purpose, stale: false }),
      )
    })
  }

  test("returned strategies are frozen singletons", () => {
    const resolved = resolveSessionMergeStrategy({ purpose: "initial" })
    expect(Object.isFrozen(resolved)).toBe(true)
  })
})

describe("shouldDropStalePage", () => {
  for (const purpose of PURPOSES) {
    test(`purpose=${purpose} agrees with resolve onStale`, () => {
      const drops = shouldDropStalePage(purpose)
      const onStale = resolveSessionMergeStrategy({ purpose, stale: true }).onStale
      expect(drops).toBe(onStale === "drop")
    })
  }

  test("drops initial/prepend/materialize; keeps recovery", () => {
    expect(shouldDropStalePage("initial")).toBe(true)
    expect(shouldDropStalePage("prepend")).toBe(true)
    expect(shouldDropStalePage("materialize")).toBe(true)
    expect(shouldDropStalePage("recovery")).toBe(false)
  })
})

describe("shouldPreserveStreamingParts", () => {
  const assistantOnly: SessionMergeStrategy = {
    id: "test-assistant",
    onStale: "drop",
    messages: "insert-only",
    parts: "replace",
    preserveStreaming: "assistant",
  }
  const allRoles: SessionMergeStrategy = {
    id: "test-all",
    onStale: "drop",
    messages: "insert-only",
    parts: "replace",
    preserveStreaming: "all",
  }
  const none: SessionMergeStrategy = {
    id: "test-none",
    onStale: "drop",
    messages: "insert-only",
    parts: "replace",
    preserveStreaming: "none",
  }

  test('preserveStreaming="assistant" only for assistant role', () => {
    expect(shouldPreserveStreamingParts(assistantOnly, "assistant")).toBe(true)
    expect(shouldPreserveStreamingParts(assistantOnly, "user")).toBe(false)
    expect(shouldPreserveStreamingParts(assistantOnly, "system")).toBe(false)
    expect(shouldPreserveStreamingParts(assistantOnly, undefined)).toBe(false)
  })

  test('preserveStreaming="all" for every role including undefined', () => {
    expect(shouldPreserveStreamingParts(allRoles, "assistant")).toBe(true)
    expect(shouldPreserveStreamingParts(allRoles, "user")).toBe(true)
    expect(shouldPreserveStreamingParts(allRoles, "system")).toBe(true)
    expect(shouldPreserveStreamingParts(allRoles, undefined)).toBe(true)
  })

  test('preserveStreaming="none" for every role including assistant', () => {
    expect(shouldPreserveStreamingParts(none, "assistant")).toBe(false)
    expect(shouldPreserveStreamingParts(none, "user")).toBe(false)
    expect(shouldPreserveStreamingParts(none, "system")).toBe(false)
    expect(shouldPreserveStreamingParts(none, undefined)).toBe(false)
  })
})

describe("DEFAULT_SESSION_MERGE_STRATEGY", () => {
  test('deep-equals resolve for purpose "initial"', () => {
    expect(DEFAULT_SESSION_MERGE_STRATEGY).toEqual(
      resolveSessionMergeStrategy({ purpose: "initial" }),
    )
  })
})
