import { describe, expect, test } from "bun:test"
import { ChildStoreManager } from "./child-store"
import { readScopedSessionStatus, subscribeScopedSessionStatuses } from "./scoped-session-status"

describe("scoped session status", () => {
  test("keeps duplicate session IDs isolated by directory and resolves snapshot completeness", () => {
    const manager = new ChildStoreManager()
    const a = manager.ensureChild("/a", { bootstrap: false })
    const b = manager.ensureChild("/b", { bootstrap: false })
    a.setState({ session_status: { shared: { type: "busy" } }, session_status_snapshot_at: 1 })
    b.setState({ session_status: {}, session_status_snapshot_at: 1 })

    expect(readScopedSessionStatus(manager, { directory: "/a", sessionID: "shared" })).toBe("busy")
    expect(readScopedSessionStatus(manager, { directory: "/b", sessionID: "shared" })).toBe("idle")
    expect(readScopedSessionStatus(manager, { directory: "/a", sessionID: "missing" })).toBe("idle")
    expect(readScopedSessionStatus(manager, { directory: "/missing", sessionID: "shared" })).toBe("unknown")
    manager.disposeAll()
  })

  test("notifies only for requested status entries, snapshots, and target registry stores", () => {
    const manager = new ChildStoreManager()
    const a = manager.ensureChild("/a", { bootstrap: false })
    let notifications = 0
    const unsubscribe = subscribeScopedSessionStatuses(manager, [
      { directory: "/a", sessionID: "shared" },
      { directory: "/b", sessionID: "shared" },
    ], () => { notifications += 1 })

    a.setState({ todo: { other: [] } })
    a.setState({ session_status: { other: { type: "busy" } } })
    expect(notifications).toBe(0)

    a.setState({ session_status: { shared: { type: "busy" }, other: { type: "busy" } } })
    expect(notifications).toBe(1)
    a.setState({ session_status_snapshot_at: 1 })
    expect(notifications).toBe(2)

    const b = manager.ensureChild("/b", { bootstrap: false })
    expect(notifications).toBe(3)
    b.setState({ session_status: { shared: { type: "idle" } } })
    expect(notifications).toBe(4)

    unsubscribe()
    manager.disposeAll()
  })
})
