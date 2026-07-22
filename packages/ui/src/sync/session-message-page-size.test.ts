import { describe, expect, mock, test } from "bun:test"

let mobileSurfaceRuntime = false
let vscodeRuntime = false
let relayModeActive = false

mock.module("@/lib/runtimeSurface", () => ({
  isMobileSurfaceRuntime: () => mobileSurfaceRuntime,
}))

mock.module("@/lib/desktop", () => ({
  isVSCodeRuntime: () => vscodeRuntime,
}))

mock.module("@/lib/relay/runtime-tunnel", () => ({
  isRelayModeActive: () => relayModeActive,
}))

const { getInitialSessionMessagePageSize, getSessionHistoryMessagePageSize } = await import("./session-message-page-size")

describe("getInitialSessionMessagePageSize", () => {
  test("selects the shared initial page size for every runtime", () => {
    mobileSurfaceRuntime = true
    vscodeRuntime = false
    relayModeActive = false
    expect(getInitialSessionMessagePageSize()).toBe(16)

    relayModeActive = true
    expect(getInitialSessionMessagePageSize()).toBe(5)

    mobileSurfaceRuntime = false
    expect(getInitialSessionMessagePageSize()).toBe(30)

    vscodeRuntime = true
    expect(getInitialSessionMessagePageSize()).toBe(30)
  })
})

describe("getSessionHistoryMessagePageSize", () => {
  test("uses five-message pages only for relay mobile history", () => {
    mobileSurfaceRuntime = true
    vscodeRuntime = false
    relayModeActive = true
    expect(getSessionHistoryMessagePageSize()).toBe(5)

    relayModeActive = false
    expect(getSessionHistoryMessagePageSize()).toBe(30)

    mobileSurfaceRuntime = false
    relayModeActive = true
    expect(getSessionHistoryMessagePageSize()).toBe(30)
  })
})
