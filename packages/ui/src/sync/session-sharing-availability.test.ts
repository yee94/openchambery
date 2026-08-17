import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { isSessionSharingAvailable, SESSION_SHARING_AVAILABLE } from "./session-sharing-availability"

const here = dirname(fileURLToPath(import.meta.url))

describe("ticket 11 V2 session sharing unavailable", () => {
  test("V2 sharing is off and share menus are gated", () => {
    expect(SESSION_SHARING_AVAILABLE).toBe(false)
    expect(isSessionSharingAvailable()).toBe(false)
    const node = readFileSync(join(here, "../components/session/sidebar/SessionNodeItem.tsx"), "utf8")
    const mobile = readFileSync(join(here, "../components/chat/MobileSessionStatusBar.tsx"), "utf8")
    const actions = readFileSync(join(here, "session-actions.ts"), "utf8")
    expect(node).toContain("isSessionSharingAvailable")
    expect(mobile).toContain("isSessionSharingAvailable")
    expect(node).toContain("sessions.sidebar.session.menu.share")
    expect(actions).toContain("isSessionSharingAvailable")
    expect(actions).not.toContain("assistant_message_mirror")
  })
})
