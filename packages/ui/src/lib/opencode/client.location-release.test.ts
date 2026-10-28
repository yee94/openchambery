import { beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }))
vi.mock("@/lib/runtime-fetch", () => ({ runtimeFetch: transport.fetch }))
import { opencodeClient } from "./client"
import { createLocationRelease, WORKTREE_LOCATION_RELEASE_DELAY_MS } from "@/sync/location-release"

beforeEach(() => {
  transport.fetch.mockReset()
  ;(opencodeClient as unknown as { liveLocationsFlight: unknown }).liveLocationsFlight = null
})

function respond(shells: unknown[] = [], forms: unknown[] = [], live: string[] = ["/work tree"]) {
  const requests: Request[] = []
  transport.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    requests.push(request)
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    if (new URL(request.url).pathname === "/api/debug/location") return Response.json(live.map((directory) => ({ directory })))
    return Response.json({ location: { directory: "/work tree" }, data: new URL(request.url).pathname.endsWith("/shell") ? shells : forms })
  })
  return requests
}

describe("location release generated SDK chain", () => {
  it("checks only explicit location shell/form and evicts with the generated DELETE", async () => {
    const requests = respond()
    const abort = new AbortController()
    expect(await opencodeClient.checkLocationReleaseUse("/work tree", abort.signal)).toBe("free")
    await opencodeClient.releaseLocation("/work tree", abort.signal)
    expect(requests.map((r) => [r.method, new URL(r.url).pathname])).toEqual([
      ["GET", "/api/debug/location"], ["GET", "/api/shell"], ["GET", "/api/form"], ["DELETE", "/api/debug/location"],
    ])
    for (const request of requests.slice(1)) expect(new URL(request.url).searchParams.get("location[directory]")).toBe("/work tree")
    abort.abort()
    expect(requests.slice(1).every((r) => r.signal.aborted)).toBe(true)
  })

  it("never probes a Location that is not booted", async () => {
    const requests = respond([], [], ["/other"])
    expect(await opencodeClient.checkLocationReleaseUse("/work tree", new AbortController().signal)).toBe("free")
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual(["/api/debug/location"])
  })

  it("lists pending forms and permissions only in live Locations", async () => {
    const requests = respond([], [], ["/live"])
    await opencodeClient.listPendingQuestions({ directories: ["/live", "/cold"] })
    await opencodeClient.listPendingPermissions({ directories: ["/live", "/cold"] })
    const scoped = requests
      .map((r) => new URL(r.url).searchParams.get("location[directory]"))
      .filter(Boolean)
    expect(scoped).toEqual(["/live", "/live"])
    expect(requests.filter((r) => new URL(r.url).pathname === "/api/debug/location")).toHaveLength(1)
  })

  it("rejects unreadable inventory without probing historical scopes", async () => {
    const requests: Request[] = []
    transport.fetch.mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      if (new URL(request.url).pathname === "/api/debug/location") return new Response("unavailable", { status: 503 })
      return Response.json({ location: { directory: "/cold" }, data: [] })
    })
    await expect(opencodeClient.listPendingQuestions({ directories: ["/cold"] })).rejects.toThrow()
    await expect(opencodeClient.listPendingPermissions({ directories: ["/cold"] })).rejects.toThrow()
    await expect(opencodeClient.checkLocationReleaseUse("/cold", new AbortController().signal)).rejects.toThrow()
    expect(requests.some((r) => new URL(r.url).searchParams.get("location[directory]") === "/cold")).toBe(false)
  })

  it.each(["shell", "form"])("protects remote pending %s", async (kind) => {
    respond(kind === "shell" ? [{ status: "running" }] : [], kind === "form" ? [{ id: "form_1" }] : [])
    expect(await opencodeClient.checkLocationReleaseUse("/work tree", new AbortController().signal)).toBe("busy")
  })

  it("propagates probe and eviction errors instead of empty success", async () => {
    transport.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }))
    await expect(opencodeClient.checkLocationReleaseUse("/work tree", new AbortController().signal)).rejects.toThrow()
    await expect(opencodeClient.releaseLocation("/work tree", new AbortController().signal)).rejects.toThrow()
  })

  it("runs the production coordinator through the facade and real generated SDK", async () => {
    vi.useFakeTimers()
    const requests = respond()
    const release = createLocationRelease({
      eligible: () => true, isCurrentDirectory: () => false, isRuntimeCurrent: () => true,
      directoryUse: () => "free",
      checkRemoteUse: (directory, signal) => opencodeClient.checkLocationReleaseUse(directory, signal),
      release: (directory, signal) => opencodeClient.releaseLocation(directory, signal),
    })
    try {
      release.directoryChanged("/work tree", "/project")
      await vi.advanceTimersByTimeAsync(WORKTREE_LOCATION_RELEASE_DELAY_MS)
      expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1)
    } finally {
      release.dispose()
      vi.useRealTimers()
    }
  })
})
