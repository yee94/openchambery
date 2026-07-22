import { describe, expect, mock, test } from "bun:test"

let mobileSurfaceRuntime = false
let vscodeRuntime = false

mock.module("@/lib/runtimeSurface", () => ({
  isMobileSurfaceRuntime: () => mobileSurfaceRuntime,
}))

mock.module("@/lib/desktop", () => ({
  isVSCodeRuntime: () => vscodeRuntime,
}))

const { getInitialSessionMessagePageSize } = await import("./session-message-page-size")

describe("getInitialSessionMessagePageSize", () => {
  test("selects the shared initial page size for every runtime", () => {
    mobileSurfaceRuntime = true
    vscodeRuntime = false
    expect(getInitialSessionMessagePageSize()).toBe(16)

    mobileSurfaceRuntime = false
    vscodeRuntime = false
    expect(getInitialSessionMessagePageSize()).toBe(30)

    mobileSurfaceRuntime = false
    vscodeRuntime = true
    expect(getInitialSessionMessagePageSize()).toBe(30)
  })
})
