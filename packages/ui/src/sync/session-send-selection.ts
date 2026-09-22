/**
 * Session model/agent selection for OpenCode 2.x sends.
 *
 * The runner uses authoritative `session.model` / `session.agent` for the next
 * turn. Prompt metadata alone does not change them. Before prompt, switch only
 * when the desired composer selection differs from the session record
 * (POST /api/session/:id/model body `{ model: { id, providerID, variant? } }`).
 *
 * Aligns with official 2.0.12 and the message-queue serial submit boundary.
 */

import type { ModelRef, Session } from "@/lib/opencode/v2-types"

import { getAllSyncSessions, getDirectoryState, getSyncChildStores } from "./sync-refs"

export type DesiredSendSelection = {
  providerID: string
  modelID: string
  variant?: string
  agent?: string
}

/** Official wire ModelRef — field is `id`, not `modelID`. */
export type OfficialModelRef = {
  id: string
  providerID: string
  variant?: string
}

export type ResolvedSendSelection = {
  /** Present only when the session must switch model before prompt. */
  model?: OfficialModelRef
  /** Present only when the session must switch agent before prompt. */
  agent?: string
}

const trimKey = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Official OpenCode ModelRef uses the literal variant `"default"` as the
 * no-effort / catalog-default sentinel (session rows often echo it after a
 * switch). Composer picks omit variant when using the default. Treat both as
 * equivalent so same provider/id re-sends do not POST a redundant `/model`.
 *
 * This is the schema sentinel on the **variant field**, not a model id named
 * "default". Explicit non-default variants (`high`, custom names, …) stay
 * distinct; clearing a real variant still differs from `"default"`/absent.
 */
/** Official ModelRef sentinel — not exported; comparison-only. */
const OFFICIAL_DEFAULT_VARIANT_SENTINEL = "default"

/** Empty / whitespace / official `"default"` → no explicit variant. */
export function normalizeSelectionVariant(value: unknown): string | undefined {
  const trimmed = trimKey(value)
  if (!trimmed) return undefined
  if (trimmed === OFFICIAL_DEFAULT_VARIANT_SENTINEL) return undefined
  return trimmed
}

/**
 * Read authoritative model id from a session row. Wire and some projections
 * use `model.id`; older local shapes may still carry `modelID`.
 */
export function readSessionModelId(session: Session | null | undefined): string | undefined {
  const model = session?.model as { id?: unknown; modelID?: unknown } | undefined
  return trimKey(model?.id) ?? trimKey(model?.modelID)
}

export function readSessionModelProviderId(session: Session | null | undefined): string | undefined {
  const model = session?.model as { providerID?: unknown } | undefined
  return trimKey(model?.providerID)
}

export function readSessionModelVariant(session: Session | null | undefined): string | undefined {
  const model = session?.model as { variant?: unknown } | undefined
  return normalizeSelectionVariant(model?.variant)
}

export function toOfficialModelRef(desired: DesiredSendSelection): OfficialModelRef {
  const variant = normalizeSelectionVariant(desired.variant)
  return {
    id: desired.modelID.trim(),
    providerID: desired.providerID.trim(),
    ...(variant ? { variant } : {}),
  }
}

/**
 * Compare desired composer selection against authoritative session.model /
 * session.agent. Returns only fields that must switch before the next prompt.
 *
 * Unknown session (not in directory/global catalog yet) → switch model (and
 * agent when requested) so the first prompt after create still lands correctly
 * when local state has not hydrated session.model.
 */
export function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: DesiredSendSelection,
): ResolvedSendSelection {
  const providerID = trimKey(desired.providerID)
  const modelID = trimKey(desired.modelID)
  if (!providerID || !modelID) {
    return {
      agent: trimKey(desired.agent),
    }
  }

  const sessions = getDirectoryState(directory)?.session ?? getAllSyncSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)

  const desiredModel = toOfficialModelRef({
    providerID,
    modelID,
    variant: desired.variant,
  })
  const sessionModelId = readSessionModelId(session)
  const sessionProviderId = readSessionModelProviderId(session)
  const sessionVariant = readSessionModelVariant(session)
  const desiredVariant = normalizeSelectionVariant(desiredModel.variant)

  const modelChanged = !session
    || !sessionModelId
    || !sessionProviderId
    || sessionProviderId !== desiredModel.providerID
    || sessionModelId !== desiredModel.id
    || sessionVariant !== desiredVariant

  const desiredAgent = trimKey(desired.agent)
  const sessionAgent = trimKey(session?.agent)
  const agentChanged = Boolean(desiredAgent) && sessionAgent !== desiredAgent

  return {
    model: modelChanged ? desiredModel : undefined,
    agent: agentChanged ? desiredAgent : undefined,
  }
}

/**
 * After a successful switch, update directory-scoped session rows so the next
 * resolve sees authoritative selection without waiting for session.updated SSE.
 * No-op when the child store is not bootstrapped.
 */
export function patchLocalSessionSelection(
  sessionId: string,
  directory: string | null | undefined,
  selection: { model?: OfficialModelRef | ModelRef; agent?: string },
): void {
  if (!sessionId) return
  if (!selection.model && !selection.agent) return

  try {
    const stores = getSyncChildStores()
    const dir = (typeof directory === "string" && directory.length > 0)
      ? directory
      : undefined
    if (!dir) return
    const child = stores.getChild?.(dir) ?? stores.ensureChild?.(dir, { bootstrap: false })
    if (!child?.getState || !child?.setState) return

    child.setState((state: {
      session?: Session[]
    }) => {
      const list = state.session
      if (!Array.isArray(list)) return state
      const index = list.findIndex((row) => row.id === sessionId)
      if (index < 0) return state
      const current = list[index]
      if (!current) return state

      const nextModel = selection.model
        ? {
          id: (selection.model as OfficialModelRef).id
            ?? (selection.model as { modelID?: string }).modelID
            ?? "",
          providerID: selection.model.providerID,
          ...((selection.model as OfficialModelRef).variant
            ? { variant: (selection.model as OfficialModelRef).variant }
            : {}),
        }
        : current.model

      const next: Session = {
        ...current,
        ...(selection.model && nextModel?.id && nextModel.providerID
          ? { model: nextModel as Session["model"] }
          : {}),
        ...(selection.agent ? { agent: selection.agent } : {}),
      }
      if (next === current) return state
      const session = list.slice()
      session[index] = next
      return { ...state, session }
    })
  } catch {
    // SyncProvider may be unmounted in unit tests — ignore.
  }
}
