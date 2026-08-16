import { afterEach, describe, expect, mock, test } from "bun:test"

const saveFileCalls: Array<unknown> = []
let saveFileResult: { cancelled?: boolean } = { cancelled: false }

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isPluginAvailable: () => true,
  },
  registerPlugin: () => ({
    saveFile: async (payload: unknown) => {
      saveFileCalls.push(payload)
      return saveFileResult
    },
  }),
}))

mock.module("@/lib/platform", () => ({
  isCapacitorApp: () => true,
}))

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: () => null,
}))

afterEach(() => {
  saveFileCalls.length = 0
  saveFileResult = { cancelled: false }
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
    saveFileResult = { cancelled: true }
    const { downloadDiagnosticsReport } = await import("./transcript-diagnostics-runtime")
    expect(await downloadDiagnosticsReport("{}", "export.json")).toBe("cancelled")
  })
})
