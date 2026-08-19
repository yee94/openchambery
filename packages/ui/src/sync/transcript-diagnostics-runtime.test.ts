import { afterEach, describe, expect, test, vi } from "vitest"

const { saveFileCalls, getSaveFileResult, setSaveFileResult } = vi.hoisted(() => {
  const saveFileCalls: Array<unknown> = []
  let saveFileResult: { cancelled?: boolean } = { cancelled: false }
  return {
    saveFileCalls,
    getSaveFileResult: () => saveFileResult,
    setSaveFileResult: (next: { cancelled?: boolean }) => {
      saveFileResult = next
    },
  }
})

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({
    saveFile: async (payload: unknown) => {
      saveFileCalls.push(payload)
      return getSaveFileResult()
    },
  }),
}))

vi.mock("@/lib/platform", () => ({
  isCapacitorApp: () => true,
}))

vi.mock("../lib/platform", () => ({
  isCapacitorApp: () => true,
}))

vi.mock("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: () => null,
}))

afterEach(() => {
  saveFileCalls.length = 0
  setSaveFileResult({ cancelled: false })
})

describe("downloadDiagnosticsReport", () => {
  test("uses the native save picker on Capacitor and does not copy", async () => {
    const { downloadDiagnosticsReport } = await import("./transcript-diagnostics-runtime")
    const outcome = await downloadDiagnosticsReport('{"eventCount":1}', "openchamber-diagnostics.json")
    expect(outcome).toBe("saved")
    expect(saveFileCalls).toHaveLength(1)
    expect(saveFileCalls[0]).toEqual({
      dataBase64: btoa('{"eventCount":1}'),
      mimeType: "application/json",
      filename: "openchamber-diagnostics.json",
    })
  })

  test("treats a dismissed native picker as cancelled", async () => {
    setSaveFileResult({ cancelled: true })
    const { downloadDiagnosticsReport } = await import("./transcript-diagnostics-runtime")
    expect(await downloadDiagnosticsReport("{}", "export.json")).toBe("cancelled")
  })

  test("sends a large diagnostics payload to the native saver", async () => {
    const content = `{"eventCount":1,"pad":"${"x".repeat(200_000)}"}`
    const { downloadDiagnosticsReport } = await import("./transcript-diagnostics-runtime")
    expect(await downloadDiagnosticsReport(content, "openchamber-diagnostics.json")).toBe("saved")
    const payload = saveFileCalls[0] as { dataBase64: string }
    expect(payload.dataBase64.length).toBeGreaterThan(200_000)
  })
})
