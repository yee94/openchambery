import { describe, expect, test } from "bun:test"
import type { Part, Session } from "@opencode-ai/sdk/v2"

import {
  areRequestArraysReferentiallyEqual,
  collectScopedBlockingRequests,
  collectTaskDispatchEdgesFromParts,
} from "./scoped-blocking-requests"

const session = (id: string, parentID?: string): Session => ({ id, parentID }) as Session

const taskPart = (input: {
  parentSessionId?: string
  sessionId?: string
  status?: string
  metadataAt?: "state" | "none"
}): Part => ({
  type: "tool",
  tool: "task",
  state: {
    status: input.status ?? "running",
    ...(input.metadataAt === "none" || (!input.parentSessionId && !input.sessionId)
      ? {}
      : { metadata: { parentSessionId: input.parentSessionId, sessionId: input.sessionId } }),
  },
}) as Part

describe("scoped blocking requests", () => {
  test("collects requests for the current session subtree", () => {
    const rootRequest = { id: "perm_root" }
    const childRequest = { id: "perm_child" }
    const grandchildRequest = { id: "perm_grandchild" }
    const siblingRequest = { id: "perm_sibling" }
    const empty: Array<typeof rootRequest> = []

    const result = collectScopedBlockingRequests(
      [
        session("ses_root"),
        session("ses_child", "ses_root"),
        session("ses_grandchild", "ses_child"),
        session("ses_sibling"),
      ],
      {
        ses_root: [rootRequest],
        ses_child: [childRequest],
        ses_grandchild: [grandchildRequest],
        ses_sibling: [siblingRequest],
      },
      "ses_root",
      empty,
    )

    expect(result).toEqual([rootRequest, childRequest, grandchildRequest])
  })

  test("returns the provided empty array when no scoped requests exist", () => {
    const empty: Array<{ id: string }> = []

    expect(collectScopedBlockingRequests([session("ses_root")], {}, "ses_root", empty)).toBe(empty)
    expect(collectScopedBlockingRequests([session("ses_root")], {}, null, empty)).toBe(empty)
  })

  test("compares request arrays by item identity", () => {
    const first = { id: "perm_1" }
    const second = { id: "perm_2" }

    expect(areRequestArraysReferentiallyEqual([first, second], [first, second])).toBe(true)
    expect(areRequestArraysReferentiallyEqual([first, second], [second, first])).toBe(false)
    expect(areRequestArraysReferentiallyEqual([first], [{ id: "perm_1" }])).toBe(false)
  })

  test("collects task dispatch edges only from running task parts", () => {
    const edges = collectTaskDispatchEdgesFromParts([
      taskPart({ parentSessionId: "ses_parent", sessionId: "ses_child" }),
      taskPart({ parentSessionId: "ses_parent", sessionId: "ses_done", status: "completed" }),
      taskPart({ status: "running", metadataAt: "none" }),
      { type: "tool", tool: "bash", state: { status: "running" } } as Part,
    ])

    expect(edges).toEqual([{ parentSessionId: "ses_parent", sessionId: "ses_child" }])
  })

  test("includes running-task child requests when catalog parentID points at a pre-fork lineage", () => {
    // Fork scenario: dispatching session ses_fork (fork of ses_origin) reused a
    // task_id whose child session ses_fixer still has parentID = ses_origin.
    // Without the dispatch edge the child question is unreachable from
    // ses_fork's catalog subtree.
    const empty: Array<{ id: string }> = []
    const childQuestion = { id: "que_child" }
    const unrelatedQuestion = { id: "que_other" }

    const withoutEdge = collectScopedBlockingRequests(
      [
        session("ses_fork"),
        session("ses_origin"),
        session("ses_fixer", "ses_origin"),
      ],
      {
        ses_fixer: [childQuestion],
      },
      "ses_fork",
      empty,
    )
    expect(withoutEdge).toBe(empty)

    const withEdge = collectScopedBlockingRequests(
      [
        session("ses_fork"),
        session("ses_origin"),
        session("ses_fixer", "ses_origin"),
      ],
      {
        ses_fixer: [childQuestion],
      },
      "ses_fork",
      empty,
      [{ parentSessionId: "ses_fork", sessionId: "ses_fixer" }],
    )
    expect(withEdge).toEqual([childQuestion])

    // The dispatch edge never leaks requests into unrelated roots.
    const otherRoot = collectScopedBlockingRequests(
      [session("ses_unrelated")],
      {
        ses_fixer: [unrelatedQuestion],
      },
      "ses_unrelated",
      empty,
      [{ parentSessionId: "ses_fork", sessionId: "ses_fixer" }],
    )
    expect(otherRoot).toBe(empty)
  })

  test("dispatch edges extend the subtree transitively", () => {
    const empty: Array<{ id: string }> = []
    const deepQuestion = { id: "que_deep" }

    const result = collectScopedBlockingRequests(
      [
        session("ses_root"),
        session("ses_child", "ses_grandparent"),
        session("ses_grandchild", "ses_child"),
      ],
      {
        ses_grandchild: [deepQuestion],
      },
      "ses_root",
      empty,
      [{ parentSessionId: "ses_root", sessionId: "ses_child" }],
    )
    expect(result).toEqual([deepQuestion])
  })
})
