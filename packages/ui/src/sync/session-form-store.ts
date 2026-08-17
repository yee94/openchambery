/**
 * Pending session forms for the current conversation.
 *
 * Forms are not questions. Live `form.created` / `form.replied` /
 * `form.cancelled` events update this store; list GET hydrates the
 * current session. Failures must not clear pending forms.
 */

import { create } from "zustand"

import {
  listSessionForms,
  parseSessionFormInfo,
  type SessionFormInfo,
} from "./session-form-api"

type SessionFormStore = {
  forms: Record<string, SessionFormInfo[]>
  upsert: (form: SessionFormInfo) => void
  remove: (sessionID: string, formID: string) => void
  replaceSession: (sessionID: string, forms: SessionFormInfo[]) => void
  formsForSession: (sessionID: string) => SessionFormInfo[]
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export const useSessionFormStore = create<SessionFormStore>((set, get) => ({
  forms: {},
  upsert: (form) => set((state) => {
    const current = state.forms[form.sessionID] ?? []
    const index = current.findIndex((item) => item.id === form.id)
    const next = index >= 0
      ? current.map((item, itemIndex) => (itemIndex === index ? form : item))
      : [...current, form]
    return { forms: { ...state.forms, [form.sessionID]: next } }
  }),
  remove: (sessionID, formID) => set((state) => {
    const current = state.forms[sessionID]
    if (!current?.length) return state
    const next = current.filter((item) => item.id !== formID)
    if (next.length === current.length) return state
    const forms = { ...state.forms }
    if (next.length > 0) forms[sessionID] = next
    else delete forms[sessionID]
    return { forms }
  }),
  replaceSession: (sessionID, nextForms) => set((state) => ({
    forms: { ...state.forms, [sessionID]: nextForms },
  })),
  formsForSession: (sessionID) => get().forms[sessionID] ?? [],
}))

export function applySessionFormLiveEvent(event: { type?: string; properties?: unknown }): boolean {
  const properties = record(event.properties) ? event.properties : null
  if (!properties) return false

  if (event.type === "form.created") {
    try {
      const form = parseSessionFormInfo(properties.form ?? properties)
      useSessionFormStore.getState().upsert(form)
      return true
    } catch {
      return false
    }
  }

  if (event.type === "form.replied" || event.type === "form.cancelled") {
    const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : ""
    const formID = typeof properties.id === "string" ? properties.id : ""
    if (!sessionID || !formID) return false
    useSessionFormStore.getState().remove(sessionID, formID)
    return true
  }

  return false
}

export async function refreshSessionForms(input: {
  sessionID: string
  directory?: string | null
  signal?: AbortSignal
}): Promise<void> {
  const forms = await listSessionForms(input)
  useSessionFormStore.getState().replaceSession(input.sessionID, forms)
}
