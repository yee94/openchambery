import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  getReconnectCandidateSessionIds,
  getReconnectMaterializationSessionIds,
  getReconnectTranscriptInvalidationSessionIds,
  getStatusWatchdogCandidateSessionIds,
} from "./reconnect-recovery"

function createSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    time: { created: 1, updated: 1 },
    version: "1",
    ...overrides,
  } as Session
}

describe("getReconnectCandidateSessionIds", () => {
  test("includes non-idle and parent sessions from catalog/status", () => {
    const busyStatus = { type: "busy" } as SessionStatus

    expect(getReconnectCandidateSessionIds({
      session: [
        createSession("busy"),
        createSession("child", { parentID: "parent" }),
        createSession("parent"),
        createSession("idle"),
      ],
      session_status: { busy: busyStatus, idle: { type: "idle" } as SessionStatus },
    }).sort()).toEqual(["busy", "parent"])
  })

  test("includes the currently viewed session even when it looks idle", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
    }, {
      directory: "/repo",
      viewedSession: { directory: "/repo", sessionId: "active" },
    }).sort()).toContain("active")
  })

  test("does not include incomplete-assistant heuristics (Query compensation owns that)", () => {
    // Batch 2: no message/part incomplete materialization candidates.
    expect(getReconnectCandidateSessionIds({
      session: [createSession("blank")],
      session_status: { blank: { type: "idle" } as SessionStatus },
    })).toEqual([])
  })

  test("does not include a viewed session from another directory", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
    }, {
      directory: "/repo-a",
      viewedSession: { directory: "/repo-b", sessionId: "active" },
    }).sort()).not.toContain("active")
  })
})

describe("getReconnectMaterializationSessionIds", () => {
  test("materializes only the currently viewed candidate after reconnect", () => {
    expect(getReconnectMaterializationSessionIds(["busy-a", "viewed", "busy-b"], {
      directory: "/repo",
      viewedSession: { directory: "/repo", sessionId: "viewed" },
    })).toEqual(["viewed"])
  })

  test("materializes the viewed session even when it is absent from candidates", () => {
    expect(getReconnectMaterializationSessionIds(["busy-a", "busy-b"], {
      directory: "/repo",
      viewedSession: { directory: "/repo", sessionId: "viewed" },
    })).toEqual(["viewed"])
  })

  test("does not materialize a viewed session from another directory", () => {
    expect(getReconnectMaterializationSessionIds(["viewed"], {
      directory: "/repo-a",
      viewedSession: { directory: "/repo-b", sessionId: "viewed" },
    })).toEqual([])
  })

  test("does not fetch session detail for background candidates", () => {
    expect(getReconnectMaterializationSessionIds(["busy-a", "busy-b"], {
      directory: "/repo",
      viewedSession: null,
    })).toEqual([])
  })
})

describe("getReconnectTranscriptInvalidationSessionIds", () => {
  test("returns empty — Query reconnect compensation owns transcript invalidation", () => {
    expect(getReconnectTranscriptInvalidationSessionIds()).toEqual([])
    expect(getReconnectTranscriptInvalidationSessionIds({})).toEqual([])
  })
})

describe("getStatusWatchdogCandidateSessionIds", () => {
  test("polls only sessions with live active status", () => {
    expect(getStatusWatchdogCandidateSessionIds({
      session: [createSession("busy"), createSession("stale-history")],
      session_status: {
        busy: { type: "busy" } as SessionStatus,
        idle: { type: "idle" } as SessionStatus,
      },
    })).toEqual(["busy"])
  })
})
