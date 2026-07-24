/**
 * Selection Store — per-session model, agent, and variant selections.
 * Extracted from session-ui-store for subscription isolation.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { createDeferredSafeJSONStorage } from "@/stores/utils/safeStorage"

type ModelSelection = { providerId: string; modelId: string }
type LastUsedProvider = { providerID: string; modelID: string }
type AgentModelSelectionEntries = [string, [string, ModelSelection][]][]
/** sessionId → agentName → "providerId/modelId" → variant */
type AgentModelVariantSelectionEntries = [string, [string, [string, string][]][]][]

type PersistedSelectionState = {
  sessionModelSelections?: [string, ModelSelection][]
  sessionAgentSelections?: [string, string][]
  sessionAgentModelSelections?: AgentModelSelectionEntries
  sessionAgentModelVariantSelections?: AgentModelVariantSelectionEntries
  lastUsedProvider?: LastUsedProvider | null
}

export type SelectionState = {
  sessionModelSelections: Map<string, ModelSelection>
  sessionAgentSelections: Map<string, string>
  sessionAgentModelSelections: Map<string, Map<string, ModelSelection>>
  sessionAgentModelVariantSelections: Map<string, Map<string, Map<string, string>>>
  lastUsedProvider: LastUsedProvider | null

  saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void
  getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null
  saveSessionAgentSelection: (sessionId: string, agentName: string) => void
  getSessionAgentSelection: (sessionId: string) => string | null
  saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void
  getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null
  saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void
  getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined
}

const isPersistedSelectionState = (state: unknown): state is PersistedSelectionState => (
  typeof state === "object" && state !== null
)

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0

// Maximum number of sessions to persist to local storage to prevent unbounded growth
const MAX_PERSISTED_SESSIONS = 150

const parseVariantEntries = (
  raw: unknown,
): Map<string, Map<string, Map<string, string>>> => {
  const result = new Map<string, Map<string, Map<string, string>>>()
  if (!Array.isArray(raw)) {
    return result
  }

  for (const sessionEntry of raw) {
    if (!Array.isArray(sessionEntry) || sessionEntry.length < 2) continue
    const [sessionId, agentArray] = sessionEntry
    if (!isNonEmptyString(sessionId) || !Array.isArray(agentArray)) continue

    const agentMap = new Map<string, Map<string, string>>()
    for (const agentEntry of agentArray) {
      if (!Array.isArray(agentEntry) || agentEntry.length < 2) continue
      const [agentName, modelArray] = agentEntry
      if (!isNonEmptyString(agentName) || !Array.isArray(modelArray)) continue

      const modelMap = new Map<string, string>()
      for (const modelEntry of modelArray) {
        if (!Array.isArray(modelEntry) || modelEntry.length < 2) continue
        const [modelKey, variant] = modelEntry
        if (!isNonEmptyString(modelKey) || !isNonEmptyString(variant)) continue
        modelMap.set(modelKey, variant)
      }
      if (modelMap.size > 0) {
        agentMap.set(agentName, modelMap)
      }
    }
    if (agentMap.size > 0) {
      result.set(sessionId, agentMap)
    }
  }

  return result
}

export const useSelectionStore = create<SelectionState>()(
  persist(
    (set, get) => ({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariantSelections: new Map(),
      lastUsedProvider: null,

      saveSessionModelSelection: (sessionId, providerId, modelId) =>
        set((s) => {
          const map = new Map(s.sessionModelSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, { providerId, modelId })
          return { sessionModelSelections: map, lastUsedProvider: { providerID: providerId, modelID: modelId } }
        }),

      getSessionModelSelection: (sessionId) => get().sessionModelSelections.get(sessionId) ?? null,

      saveSessionAgentSelection: (sessionId, agentName) =>
        set((s) => {
          if (s.sessionAgentSelections.get(sessionId) === agentName) return s
          const map = new Map(s.sessionAgentSelections)
          map.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          map.set(sessionId, agentName)
          return { sessionAgentSelections: map }
        }),

      getSessionAgentSelection: (sessionId) => get().sessionAgentSelections.get(sessionId) ?? null,

      saveAgentModelForSession: (sessionId, agentName, providerId, modelId) =>
        set((s) => {
          const existing = s.sessionAgentModelSelections.get(sessionId)?.get(agentName)
          if (existing?.providerId === providerId && existing?.modelId === modelId) return s
          const outer = new Map(s.sessionAgentModelSelections)
          const inner = new Map(outer.get(sessionId) ?? new Map())

          outer.delete(sessionId) // Delete first to ensure it moves to the end of insertion order (MRU)
          inner.set(agentName, { providerId, modelId })
          outer.set(sessionId, inner)

          return { sessionAgentModelSelections: outer }
        }),

      getAgentModelForSession: (sessionId, agentName) =>
        get().sessionAgentModelSelections.get(sessionId)?.get(agentName) ?? null,

      saveAgentModelVariantForSession: (sessionId, agentName, providerId, modelId, variant) =>
        set((s) => {
          const key = `${providerId}/${modelId}`
          const outer = new Map(s.sessionAgentModelVariantSelections)
          const existingAgentMap = outer.get(sessionId)
          const agentMap = new Map(existingAgentMap ?? new Map())
          const existingModelMap = agentMap.get(agentName)
          const modelMap = new Map(existingModelMap ?? new Map())

          if (!variant) {
            if (!modelMap.has(key)) {
              return s
            }
            modelMap.delete(key)
            if (modelMap.size === 0) {
              agentMap.delete(agentName)
            } else {
              agentMap.set(agentName, modelMap)
            }
            outer.delete(sessionId)
            if (agentMap.size > 0) {
              outer.set(sessionId, agentMap)
            }
            return { sessionAgentModelVariantSelections: outer }
          }

          if (modelMap.get(key) === variant) {
            return s
          }

          outer.delete(sessionId) // MRU: re-insert session at the end
          modelMap.set(key, variant)
          agentMap.set(agentName, modelMap)
          outer.set(sessionId, agentMap)
          return { sessionAgentModelVariantSelections: outer }
        }),

      getAgentModelVariantForSession: (sessionId, agentName, providerId, modelId) => {
        const key = `${providerId}/${modelId}`
        return get().sessionAgentModelVariantSelections.get(sessionId)?.get(agentName)?.get(key)
      },
    }),
    {
      name: "selection-store",
      version: 2,
      storage: createDeferredSafeJSONStorage(),
      partialize: (state) => {
        // Convert Maps to arrays and slice to keep only the most recent MAX_PERSISTED_SESSIONS
        const models = Array.from(state.sessionModelSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agents = Array.from(state.sessionAgentSelections.entries()).slice(-MAX_PERSISTED_SESSIONS)
        const agentModels = Array.from(state.sessionAgentModelSelections.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [sessionId, Array.from(agentMap.entries())])
        const agentVariants = Array.from(state.sessionAgentModelVariantSelections.entries())
          .slice(-MAX_PERSISTED_SESSIONS)
          .map(([sessionId, agentMap]) => [
            sessionId,
            Array.from(agentMap.entries()).map(([agentName, modelMap]) => [
              agentName,
              Array.from(modelMap.entries()),
            ]),
          ])

        return {
          sessionModelSelections: models,
          sessionAgentSelections: agents,
          sessionAgentModelSelections: agentModels,
          sessionAgentModelVariantSelections: agentVariants,
          lastUsedProvider: state.lastUsedProvider,
        }
      },
      merge: (persistedState: unknown, currentState) => {
        const persisted = isPersistedSelectionState(persistedState) ? persistedState : undefined
        const agentModelSelections = new Map<string, Map<string, ModelSelection>>()
        if (Array.isArray(persisted?.sessionAgentModelSelections)) {
          for (const entry of persisted.sessionAgentModelSelections) {
            if (!Array.isArray(entry) || entry.length < 2) continue
            const [sessionId, agentArray] = entry
            if (!isNonEmptyString(sessionId) || !Array.isArray(agentArray)) continue
            const inner = new Map<string, ModelSelection>()
            for (const agentEntry of agentArray) {
              if (!Array.isArray(agentEntry) || agentEntry.length < 2) continue
              const [agentName, selection] = agentEntry
              if (
                !isNonEmptyString(agentName)
                || typeof selection !== "object"
                || selection === null
                || !isNonEmptyString((selection as ModelSelection).providerId)
                || !isNonEmptyString((selection as ModelSelection).modelId)
              ) {
                continue
              }
              inner.set(agentName, {
                providerId: (selection as ModelSelection).providerId,
                modelId: (selection as ModelSelection).modelId,
              })
            }
            if (inner.size > 0) {
              agentModelSelections.set(sessionId, inner)
            }
          }
        }

        return {
          ...currentState,
          lastUsedProvider: persisted?.lastUsedProvider ?? currentState.lastUsedProvider,
          sessionModelSelections: new Map(
            Array.isArray(persisted?.sessionModelSelections) ? persisted.sessionModelSelections : [],
          ),
          sessionAgentSelections: new Map(
            Array.isArray(persisted?.sessionAgentSelections) ? persisted.sessionAgentSelections : [],
          ),
          sessionAgentModelSelections: agentModelSelections,
          sessionAgentModelVariantSelections: parseVariantEntries(
            persisted?.sessionAgentModelVariantSelections,
          ),
        }
      },
      migrate: (persistedState: unknown) => {
        // Scaffold for future schema migrations; v1→v2 adds variant map (empty default).
        return persistedState
      }
    }
  )
)
