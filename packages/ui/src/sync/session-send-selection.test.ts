import { beforeEach, describe, expect, test, vi } from "vitest"

const {
  directorySessions,
  allSessions,
  setStateCalls,
} = vi.hoisted(() => ({
  directorySessions: [] as Array<Record<string, unknown>>,
  allSessions: [] as Array<Record<string, unknown>>,
  setStateCalls: [] as Array<unknown>,
}))

vi.mock("./sync-refs", () => ({
  getDirectoryState: (directory?: string) => {
    if (!directory) return undefined
    return { session: directorySessions }
  },
  getAllSyncSessions: () => allSessions,
  getSyncChildStores: () => ({
    getChild: () => ({
      getState: () => ({ session: directorySessions }),
      setState: (patch: unknown) => {
        setStateCalls.push(patch)
        if (typeof patch === "function") {
          const next = (patch as (s: { session: typeof directorySessions }) => {
            session: typeof directorySessions
          })({ session: directorySessions })
          if (next?.session) {
            directorySessions.length = 0
            directorySessions.push(...next.session)
          }
        }
      },
    }),
    ensureChild: () => ({
      getState: () => ({ session: directorySessions }),
      setState: (patch: unknown) => {
        setStateCalls.push(patch)
        if (typeof patch === "function") {
          const next = (patch as (s: { session: typeof directorySessions }) => {
            session: typeof directorySessions
          })({ session: directorySessions })
          if (next?.session) {
            directorySessions.length = 0
            directorySessions.push(...next.session)
          }
        }
      },
    }),
  }),
}))

import {
  normalizeSelectionVariant,
  patchLocalSessionSelection,
  readSessionModelId,
  resolveSendSelection,
  toOfficialModelRef,
} from "./session-send-selection"

const SESSION = "ses_switch_1"
const DIRECTORY = "/workspace/project"

describe("resolveSendSelection / official model switch boundary", () => {
  beforeEach(() => {
    directorySessions.length = 0
    allSessions.length = 0
    setStateCalls.length = 0
  })

  test("same session.model as desired → no switch (new session already set)", () => {
    directorySessions.push({
      id: SESSION,
      agent: "build",
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      variant: "default",
      agent: "build",
    })).toEqual({ model: undefined, agent: undefined })
  })

  test("session.variant default vs UI omitted variant → no redundant /model (FIX-GATE same-model repeat)", () => {
    // Real authority after switch echoes variant:"default"; composer omits it.
    directorySessions.push({
      id: SESSION,
      agent: "build",
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      // no variant — matches switch-fix-network.json repeat body
    })).toEqual({ model: undefined, agent: undefined })

    directorySessions.length = 0
    directorySessions.push({
      id: SESSION,
      model: { id: "mimo-v2.6-flash", providerID: "opencode-go", variant: "default" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "opencode-go",
      modelID: "mimo-v2.6-flash",
    }).model).toBeUndefined()
  })

  test("explicit non-default variant still switches; clear high→default/omit switches", () => {
    directorySessions.push({
      id: SESSION,
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      variant: "high",
    }).model).toEqual({
      id: "glm-5.3-flash",
      providerID: "zai-coding-plan",
      variant: "high",
    })

    directorySessions[0] = {
      id: SESSION,
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "high" },
    }
    // Clear to official default / omit — still a real change from "high".
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
    }).model).toEqual({
      id: "glm-5.3-flash",
      providerID: "zai-coding-plan",
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      variant: "default",
    }).model).toEqual({
      id: "glm-5.3-flash",
      providerID: "zai-coding-plan",
    })
  })

  test("provider or id change always switches even when both sides use default variant", () => {
    directorySessions.push({
      id: SESSION,
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "opencode-go",
      modelID: "mimo-v2.6-flash",
    }).model).toEqual({
      id: "mimo-v2.6-flash",
      providerID: "opencode-go",
    })
  })

  test("zai → Go: metadata would send B but session still A → switch model with id not modelID", () => {
    directorySessions.push({
      id: SESSION,
      agent: "build",
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
    })
    const resolved = resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "opencode-go",
      modelID: "mimo-v2.6-flash",
      variant: "default",
      agent: "build",
    })
    // Switch body omits official default sentinel (matches real /model payloads).
    expect(resolved.model).toEqual({
      id: "mimo-v2.6-flash",
      providerID: "opencode-go",
    })
    expect(resolved.agent).toBeUndefined()
    // Official wire field is id
    expect(resolved.model && "modelID" in resolved.model).toBe(false)
  })

  test("Go → zai reverse also requires switch", () => {
    directorySessions.push({
      id: SESSION,
      agent: "build",
      model: { id: "mimo-v2.6-flash", providerID: "opencode-go" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
    }).model).toEqual({
      id: "glm-5.3-flash",
      providerID: "zai-coding-plan",
    })
  })

  test("empty/whitespace variant equals official default sentinel (no switch)", () => {
    directorySessions.push({
      id: SESSION,
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan", variant: "default" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      variant: "  ",
    }).model).toBeUndefined()
  })

  test("agent change without model change only switches agent", () => {
    directorySessions.push({
      id: SESSION,
      agent: "build",
      model: { id: "glm-5.3-flash", providerID: "zai-coding-plan" },
    })
    expect(resolveSendSelection(SESSION, DIRECTORY, {
      providerID: "zai-coding-plan",
      modelID: "glm-5.3-flash",
      agent: "plan",
    })).toEqual({
      model: undefined,
      agent: "plan",
    })
  })

  test("unknown session state still requests model switch", () => {
    expect(resolveSendSelection("ses_missing", DIRECTORY, {
      providerID: "opencode-go",
      modelID: "mimo-v2.6-flash",
      agent: "build",
    })).toEqual({
      model: { id: "mimo-v2.6-flash", providerID: "opencode-go" },
      agent: "build",
    })
  })

  test("reads wire model.id and legacy model.modelID", () => {
    expect(readSessionModelId({
      id: "s",
      model: { id: "wire-id", providerID: "p" },
    } as never)).toBe("wire-id")
    expect(readSessionModelId({
      id: "s",
      model: { modelID: "legacy-id", providerID: "p" },
    } as never)).toBe("legacy-id")
  })

  test("toOfficialModelRef omits empty variant", () => {
    expect(toOfficialModelRef({
      providerID: "p",
      modelID: "m",
      variant: "",
    })).toEqual({ id: "m", providerID: "p" })
    expect(normalizeSelectionVariant("  high  ")).toBe("high")
  })

  test("patchLocalSessionSelection updates directory session.model after switch", () => {
    directorySessions.push({
      id: SESSION,
      agent: "build",
      model: { id: "old", providerID: "a" },
    })
    patchLocalSessionSelection(SESSION, DIRECTORY, {
      model: { id: "mimo-v2.6-flash", providerID: "opencode-go", variant: "default" },
    })
    expect(directorySessions[0]?.model).toEqual({
      id: "mimo-v2.6-flash",
      providerID: "opencode-go",
      variant: "default",
    })
    expect(setStateCalls.length).toBeGreaterThan(0)
  })
})
