import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// bun's mock.module is process-global and mutates the module record in place.
// mock.restore() does NOT put the original export functions back, so after this
// suite we re-install the pristine snapshots so sibling suites keep the real
// implementation.
//
// Snapshot via cache-busted URLs: a sibling suite (e.g. session-actions.test.ts)
// may already have installed an incomplete mock.module for these keys before
// this file is evaluated. A plain import would snapshot the poisoned record;
// a unique query string forces a fresh load of the real source module.
const pristineTag = encodeURIComponent(import.meta.url)
const pristineRuntimeSurface = {
  ...(await import(`@/lib/runtimeSurface?openchamber-pristine=${pristineTag}`)),
}
const pristineDesktop = {
  ...(await import(`@/lib/desktop?openchamber-pristine=${pristineTag}`)),
}
const pristineRuntimeTunnel = {
  ...(await import(`@/lib/relay/runtime-tunnel?openchamber-pristine=${pristineTag}`)),
}

// Sticky mock keys: bun may bind mocks under the alias and/or the extensionless file URL.
const runtimeSurfaceKeys = [
  "@/lib/runtimeSurface",
  new URL("../lib/runtimeSurface", import.meta.url).href,
] as const
const desktopKeys = [
  "@/lib/desktop",
  new URL("../lib/desktop", import.meta.url).href,
] as const
const runtimeTunnelKeys = [
  "@/lib/relay/runtime-tunnel",
  new URL("../lib/relay/runtime-tunnel", import.meta.url).href,
] as const

let mobileSurfaceRuntime = false
let vscodeRuntime = false
let relayModeActive = false

function installModuleMocks() {
  // Spread pristine exports so incomplete sticky mocks from sibling suites are
  // replaced with a complete surface (only the flag readers are overridden).
  for (const key of runtimeSurfaceKeys) {
    mock.module(key, () => ({
      ...pristineRuntimeSurface,
      isMobileSurfaceRuntime: () => mobileSurfaceRuntime,
    }))
  }

  for (const key of desktopKeys) {
    mock.module(key, () => ({
      ...pristineDesktop,
      isVSCodeRuntime: () => vscodeRuntime,
    }))
  }

  for (const key of runtimeTunnelKeys) {
    mock.module(key, () => ({
      ...pristineRuntimeTunnel,
      isRelayModeActive: () => relayModeActive,
    }))
  }
}

function restorePristineModules() {
  for (const key of runtimeSurfaceKeys) {
    mock.module(key, () => ({ ...pristineRuntimeSurface }))
  }
  for (const key of desktopKeys) {
    mock.module(key, () => ({ ...pristineDesktop }))
  }
  for (const key of runtimeTunnelKeys) {
    mock.module(key, () => ({ ...pristineRuntimeTunnel }))
  }
}

// Bind SUT only after mocks are installed so it resolves mocked deps.
// Lazy: avoid installing mocks at file load time (that would poison later suites
// even if this file's tests never run — bun evaluates every listed file first).
type PolicyApi = typeof import("./session-message-policy")
let getInitialSessionMessageLimit: PolicyApi["getInitialSessionMessageLimit"]
let getSessionHistoryMessageLimit: PolicyApi["getSessionHistoryMessageLimit"]
let getSessionRecoveryMessageLimit: PolicyApi["getSessionRecoveryMessageLimit"]
let getSessionMaterializationMessageLimit: PolicyApi["getSessionMaterializationMessageLimit"]
let getMessageRefetchLimit: PolicyApi["getMessageRefetchLimit"]
let getSendConfirmationRefetchLimit: PolicyApi["getSendConfirmationRefetchLimit"]
let policyBound = false

async function ensurePolicyBound() {
  installModuleMocks()
  if (!policyBound) {
    const mod = await import("./session-message-policy")
    getInitialSessionMessageLimit = mod.getInitialSessionMessageLimit
    getSessionHistoryMessageLimit = mod.getSessionHistoryMessageLimit
    getSessionRecoveryMessageLimit = mod.getSessionRecoveryMessageLimit
    getSessionMaterializationMessageLimit = mod.getSessionMaterializationMessageLimit
    getMessageRefetchLimit = mod.getMessageRefetchLimit
    getSendConfirmationRefetchLimit = mod.getSendConfirmationRefetchLimit
    policyBound = true
  }
}

function setRuntime(input: {
  mobile?: boolean
  vscode?: boolean
  relay?: boolean
}) {
  mobileSurfaceRuntime = input.mobile ?? false
  vscodeRuntime = input.vscode ?? false
  relayModeActive = input.relay ?? false
}

beforeEach(async () => {
  await ensurePolicyBound()
  setRuntime({})
})

afterEach(() => {
  restorePristineModules()
})

afterAll(() => {
  restorePristineModules()
})

describe("getInitialSessionMessageLimit", () => {
  test("mobile initial is 16", () => {
    setRuntime({ mobile: true })
    expect(getInitialSessionMessageLimit()).toBe(16)
  })

  test("desktop/web/electron initial is 30", () => {
    setRuntime({})
    expect(getInitialSessionMessageLimit()).toBe(30)
  })

  test("VS Code initial is 30", () => {
    setRuntime({ vscode: true })
    expect(getInitialSessionMessageLimit()).toBe(30)
  })

  test("relay mobile initial stays 5", () => {
    setRuntime({ mobile: true, relay: true })
    expect(getInitialSessionMessageLimit()).toBe(5)
  })

  test("VS Code wins over mobile surface detection", () => {
    setRuntime({ mobile: true, vscode: true, relay: true })
    expect(getInitialSessionMessageLimit()).toBe(30)
  })
})

describe("getSessionHistoryMessageLimit", () => {
  test("relay mobile history is 5", () => {
    setRuntime({ mobile: true, relay: true })
    expect(getSessionHistoryMessageLimit()).toBe(5)
  })

  test("non-relay history is 30", () => {
    setRuntime({ mobile: true })
    expect(getSessionHistoryMessageLimit()).toBe(30)

    setRuntime({})
    expect(getSessionHistoryMessageLimit()).toBe(30)

    setRuntime({ vscode: true })
    expect(getSessionHistoryMessageLimit()).toBe(30)

    setRuntime({ relay: true })
    expect(getSessionHistoryMessageLimit()).toBe(30)
  })
})

describe("recovery and materialize limits track initial", () => {
  test("recovery limit equals initial for every runtime", () => {
    setRuntime({ mobile: true })
    expect(getSessionRecoveryMessageLimit()).toBe(getInitialSessionMessageLimit())

    setRuntime({ mobile: true, relay: true })
    expect(getSessionRecoveryMessageLimit()).toBe(getInitialSessionMessageLimit())

    setRuntime({})
    expect(getSessionRecoveryMessageLimit()).toBe(getInitialSessionMessageLimit())

    setRuntime({ vscode: true })
    expect(getSessionRecoveryMessageLimit()).toBe(getInitialSessionMessageLimit())
  })

  test("materialize limit equals initial for every runtime", () => {
    setRuntime({ mobile: true })
    expect(getSessionMaterializationMessageLimit()).toBe(getInitialSessionMessageLimit())

    setRuntime({ mobile: true, relay: true })
    expect(getSessionMaterializationMessageLimit()).toBe(getInitialSessionMessageLimit())

    setRuntime({})
    expect(getSessionMaterializationMessageLimit()).toBe(getInitialSessionMessageLimit())

    setRuntime({ vscode: true })
    expect(getSessionMaterializationMessageLimit()).toBe(getInitialSessionMessageLimit())
  })
})

describe("refetch limits", () => {
  test("message refetch limit is 100 across runtimes", () => {
    setRuntime({ mobile: true, relay: true })
    expect(getMessageRefetchLimit()).toBe(100)

    setRuntime({})
    expect(getMessageRefetchLimit()).toBe(100)

    setRuntime({ vscode: true })
    expect(getMessageRefetchLimit()).toBe(100)
  })

  test("send confirmation refetch limit is 30 across runtimes", () => {
    setRuntime({ mobile: true, relay: true })
    expect(getSendConfirmationRefetchLimit()).toBe(30)

    setRuntime({})
    expect(getSendConfirmationRefetchLimit()).toBe(30)

    setRuntime({ vscode: true })
    expect(getSendConfirmationRefetchLimit()).toBe(30)
  })
})
