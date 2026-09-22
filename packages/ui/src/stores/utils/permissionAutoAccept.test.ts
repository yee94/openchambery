import { describe, expect, test } from "bun:test"
import type { Session } from '@/lib/opencode/v2-types';import { autoRespondsPermission, type PermissionAutoAcceptMap } from "./permissionAutoAccept"

function makeSession(id: string, parentID?: string): Session {
  return { id, parentID } as Session
}

describe("autoRespondsPermission", () => {
  test("defaults to allow when autoAccept is empty", () => {
    expect(autoRespondsPermission({
      autoAccept: {},
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(true)
  })

  test("returns true when session has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: true }
    expect(autoRespondsPermission({
      autoAccept,
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(true)
  })

  test("returns false when session has autoAccept disabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: false }
    expect(autoRespondsPermission({
      autoAccept,
      sessions: [makeSession("s1")],
      sessionID: "s1",
    })).toBe(false)
  })

  test("returns true when parent has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { parent: true }
    const sessions = [
      makeSession("parent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(true)
  })

  test("returns true when grandparent has autoAccept enabled", () => {
    const autoAccept: PermissionAutoAcceptMap = { grandparent: true }
    const sessions = [
      makeSession("grandparent"),
      makeSession("parent", "grandparent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(true)
  })

  test("uses a prebuilt session index for lineage lookup", () => {
    const parent = makeSession("parent")
    const child = makeSession("child", "parent")
    expect(autoRespondsPermission({
      autoAccept: { parent: true },
      sessions: [],
      sessionById: new Map([[parent.id, parent], [child.id, child]]),
      sessionID: "child",
    })).toBe(true)
  })

  test("defaults to allow when only a sibling has an explicit policy", () => {
    const autoAccept: PermissionAutoAcceptMap = { sibling: true }
    const sessions = [
      makeSession("parent"),
      makeSession("sibling", "parent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(true)
  })

  test("child autoAccept overrides parent", () => {
    const autoAccept: PermissionAutoAcceptMap = { parent: true, child: false }
    const sessions = [
      makeSession("parent"),
      makeSession("child", "parent"),
    ]
    expect(autoRespondsPermission({
      autoAccept,
      sessions,
      sessionID: "child",
    })).toBe(false)
  })

  test("defaults to allow for a session with no explicit policy", () => {
    const autoAccept: PermissionAutoAcceptMap = { s1: true }
    expect(autoRespondsPermission({
      autoAccept,
      sessions: [],
      sessionID: "unknown",
    })).toBe(true)
  })
})
