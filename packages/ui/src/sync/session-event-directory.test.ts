import { describe, expect, test } from "bun:test"
import type { Event } from '@/sync/types'

import { getSessionInfoFromPayload } from "./session-event-router"

describe("getSessionInfoFromPayload", () => {
  test("uses the routed event directory when a created session omits it", () => {
    const session = getSessionInfoFromPayload({
      type: "session.created",
      properties: {
        info: {
          id: "ses_remote",
          title: "Created remotely",
          time: { created: 1, updated: 1 },
        },
      },
    } as Event, "/workspace/project") as { directory?: string }

    expect(session?.directory).toBe("/workspace/project")
  })

  test("preserves the directory provided by the session event", () => {
    const session = getSessionInfoFromPayload({
      type: "session.created",
      properties: {
        info: {
          id: "ses_remote",
          title: "Created remotely",
          directory: "/workspace/event-project",
          time: { created: 1, updated: 1 },
        },
      },
    } as Event, "/workspace/routed-project") as { directory?: string }

    expect(session?.directory).toBe("/workspace/event-project")
  })
})
