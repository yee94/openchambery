import { beforeEach, describe, expect, test, vi } from "vitest"
import type { Event, Session } from "@opencode-ai/sdk/v2/client"

const { currentSessions, upsertedSessions } = vi.hoisted(() => ({
  currentSessions: [] as Session[],
  upsertedSessions: [] as Session[],
}))

vi.mock("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
      },
    }),
  },
}))

vi.mock("../../stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: currentSessions,
      archivedSessions: [] as Session[],
      upsertSession: (session: Session) => {
        upsertedSessions.push(session)
      },
    }),
  },
}))

import { applySessionEventToGlobalSessions } from "../session-event-router"
import { getSessionIdFromPayload } from "../sync-context"

const buildSession = (title: string, time: Session["time"]): Session => ({
  id: "ses_1",
  title,
  time,
} as Session)

const buildEvent = (session: Session): Event => ({
  type: "session.updated",
  properties: {
    info: session,
  },
} as Event)

describe("applySessionEventToGlobalSessions", () => {
  beforeEach(() => {
    currentSessions.length = 0
    upsertedSessions.length = 0
  })

  test("skips stale global session.updated echoes after a newer rename", () => {
    currentSessions.push(buildSession("New Title", { created: 1, updated: 20 }))

    applySessionEventToGlobalSessions(buildEvent(buildSession("Old Title", { created: 1, updated: 10 })))

    expect(upsertedSessions).toEqual([])
  })

  test("skips time-only session updates and renderer-side index writes", () => {
    currentSessions.push(buildSession("Same Title", { created: 1, updated: 10 }))

    applySessionEventToGlobalSessions(buildEvent(buildSession("Same Title", { created: 1, updated: 20 })))

    expect(upsertedSessions).toEqual([])
  })

  test("applies visible session updates", () => {
    currentSessions.push(buildSession("Old Title", { created: 1, updated: 10 }))

    applySessionEventToGlobalSessions(buildEvent(buildSession("New Title", { created: 1, updated: 20 })))

    expect(upsertedSessions).toHaveLength(1)
  })
})

describe("getSessionIdFromPayload", () => {
  test("extracts properties.sessionID for session.idle", () => {
    expect(getSessionIdFromPayload({
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event)).toBe("ses_1")
  })

  test("extracts properties.sessionID for session.error", () => {
    expect(getSessionIdFromPayload({
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event)).toBe("ses_1")
  })
})
