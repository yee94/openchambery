import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLocationRelease, directoryUse, isWorktreeDirectory, WORKTREE_LOCATION_RELEASE_DELAY_MS as delay } from "./location-release"
import { INITIAL_STATE, type State } from "./types"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { useSessionFormStore } from "./session-form-store"
import type { WorktreeMetadata } from "@/types/worktree"

const worktree = (path: string): WorktreeMetadata => ({ path, projectDirectory: "/project", branch: "test", label: "Test" })
const catalog = new Map([["/project", [worktree("/worktree"), worktree("/project")]]])
const complete = (): State => ({ ...INITIAL_STATE, status: "complete", session_status_snapshot_at: 1 })

function setup() {
  let current = "/worktree"
  let runtime = true
  const deps = {
    eligible: (directory: string) => isWorktreeDirectory(directory, catalog),
    isCurrentDirectory: (directory: string) => directory === current,
    isRuntimeCurrent: () => runtime,
    directoryUse: vi.fn((): "free" | "busy" | "unknown" => "free"),
    checkRemoteUse: vi.fn(async (_directory: string, _signal: AbortSignal): Promise<"free" | "busy" | "unknown"> => "free"),
    release: vi.fn(async (_directory: string, _signal: AbortSignal) => {}),
  }
  const release = createLocationRelease(deps)
  return {
    ...deps, ...release,
    leave(next = "/project") { const previous = current; current = next; release.directoryChanged(previous, next) },
    changeRuntime() { runtime = false },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  useGlobalSessionStatusStore.setState({ statusById: new Map() })
  useSessionFormStore.setState({ forms: {} })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe("best-effort location release", () => {
  it("only probes the left worktree after five minutes, then releases once", async () => {
    const release = setup()
    release.leave()
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(release.checkRemoteUse).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(release.checkRemoteUse).toHaveBeenCalledTimes(1)
    expect(release.release).toHaveBeenCalledWith("/worktree", expect.any(AbortSignal))
    await vi.advanceTimersByTimeAsync(delay * 2)
    expect(release.release).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("never schedules project roots or unknown paths; normalizes catalog paths", async () => {
    const release = setup()
    release.directoryChanged("/project", "/elsewhere")
    release.directoryChanged("/unknown", "/elsewhere")
    await vi.advanceTimersByTimeAsync(delay)
    expect(release.checkRemoteUse).not.toHaveBeenCalled()
    expect(isWorktreeDirectory("/worktree/", catalog)).toBe(true)
    expect(isWorktreeDirectory("/project/", catalog)).toBe(false)
    expect(isWorktreeDirectory("c:\\work\\", new Map([["C:/root", [worktree("C:/work")]]]))).toBe(true)
  })

  it("reentry cancels and a later departure gets its full delay", async () => {
    const release = setup()
    release.leave()
    await vi.advanceTimersByTimeAsync(delay - 1)
    release.leave("/worktree")
    await vi.advanceTimersByTimeAsync(delay)
    expect(release.release).not.toHaveBeenCalled()
    release.leave()
    await vi.advanceTimersByTimeAsync(delay)
    expect(release.release).toHaveBeenCalledTimes(1)
  })

  it.each(["local", "remote"])("defers %s busy use without polling other directories", async (source) => {
    const release = setup()
    if (source === "local") release.directoryUse.mockReturnValueOnce("busy")
    else release.checkRemoteUse.mockResolvedValueOnce("busy")
    release.leave()
    await vi.advanceTimersByTimeAsync(delay)
    expect(release.release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(delay)
    expect(release.release).toHaveBeenCalledTimes(1)
  })

  it.each(["unknown", "failure"])("skips %s without treating it as idle", async (reason) => {
    const release = setup()
    if (reason === "unknown") release.directoryUse.mockReturnValue("unknown")
    else release.checkRemoteUse.mockRejectedValue(new Error("offline"))
    release.leave()
    await vi.advanceTimersByTimeAsync(delay * 3)
    expect(release.release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["reentry", "runtime", "dispose", "busy", "unknown"])("rechecks %s after async probes", async (change) => {
    const release = setup()
    let finish!: (value: "free") => void
    release.checkRemoteUse.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    release.leave()
    await vi.advanceTimersByTimeAsync(delay)
    const signal = release.checkRemoteUse.mock.calls[0][1]
    if (change === "reentry") release.leave("/worktree")
    if (change === "runtime") release.changeRuntime()
    if (change === "dispose") release.dispose()
    if (change === "busy" || change === "unknown") release.directoryUse.mockReturnValue(change)
    finish("free")
    await vi.advanceTimersByTimeAsync(0)
    expect(release.release).not.toHaveBeenCalled()
    expect(signal.aborted).toBe(true)
    release.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("times out even if transport ignores abort; late resolution cannot evict", async () => {
    const release = setup()
    let finish!: (value: "free") => void
    release.checkRemoteUse.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    release.leave()
    await vi.advanceTimersByTimeAsync(delay + 10_000)
    expect(release.checkRemoteUse.mock.calls[0][1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    finish("free")
    await vi.advanceTimersByTimeAsync(0)
    expect(release.release).not.toHaveBeenCalled()
  })

  it("disposal destroys timers and cancels in-flight release", async () => {
    const release = setup()
    release.release.mockImplementation(() => new Promise(() => {}))
    release.leave()
    await vi.advanceTimersByTimeAsync(delay)
    release.dispose()
    expect(release.release.mock.calls[0][1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("directory usage authority", () => {
  it("requires a completed child and a successful status snapshot", () => {
    expect(directoryUse("/worktree", undefined)).toBe("unknown")
    expect(directoryUse("/worktree", INITIAL_STATE)).toBe("unknown")
    expect(directoryUse("/worktree", { ...complete(), session_status_snapshot_at: undefined })).toBe("unknown")
    expect(directoryUse("/worktree", complete())).toBe("free")
  })

  it("protects execution, retry, permission, question, generic form and global activity", () => {
    for (const type of ["busy", "retry"] as const) {
      expect(directoryUse("/worktree", { ...complete(), session_status: { s: { type } as State["session_status"][string] } })).toBe("busy")
    }
    expect(directoryUse("/worktree", { ...complete(), permission: { s: [{ id: "p", sessionID: "s", permission: "shell", patterns: [], metadata: {}, always: [] }] } })).toBe("busy")
    expect(directoryUse("/worktree", { ...complete(), question: { s: [{ id: "q", sessionID: "s", questions: [] }] } })).toBe("busy")
    useSessionFormStore.setState({ forms: { s: [{ id: "f", sessionID: "s", title: "Form", fields: [] }] } })
    expect(directoryUse("/worktree", { ...complete(), session: [{ id: "s" }] } as State)).toBe("busy")
    useGlobalSessionStatusStore.setState({ statusById: new Map([["s", { status: "busy", directory: "/worktree/" }]]) })
    expect(directoryUse("/worktree", complete())).toBe("busy")
    expect(directoryUse("/other", complete())).toBe("free")
  })
})
