import { afterEach, describe, expect, test, vi } from "vitest"
import type { OpenCodeClient } from "@/lib/opencode/v2-types"
import { bootstrapDirectory } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

vi.mock("./sync-refs", () => ({ emitSyncConfigChanged: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

describe("directory bootstrap deferred services", () => {
  test.each([false, true])("keeps real errors visible without an unavailable LSP failure (VCS failure: %s)", async (failVcs) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const vcsError = new Error("VCS access denied")
    let state: State = { ...INITIAL_STATE }
    const sdk = {
      location: { get: async () => ({ directory: "/repo", project: { id: "project_1", directory: "/repo" } }) },
      config: { get: async () => [] },
      session: { active: async () => ({}) },
      vcs: { get: async () => {
        if (failVcs) throw vcsError
        return { data: { branch: "main" } }
      } },
      form: { list: vi.fn(async () => ({ data: [] })) },
      permission: { request: { list: vi.fn(async () => ({ data: [] })) } },
    }
    await bootstrapDirectory({
      directory: "/repo",
      sdk: sdk as unknown as OpenCodeClient,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
      global: { config: {}, projects: [] },
    })
    // Deferred allSettled must finish before checking its diagnostics.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.status).toBe("complete")
    expect(sdk.form.list).toHaveBeenCalledOnce()
    expect(sdk.permission.request.list).toHaveBeenCalledOnce()
    if (failVcs) {
      expect(error).toHaveBeenCalledExactlyOnceWith("[bootstrap] deferred phase failed for /repo", vcsError)
    } else {
      expect(state.vcs).toEqual({ branch: "main" })
      expect(error).not.toHaveBeenCalled()
    }
  })
})
