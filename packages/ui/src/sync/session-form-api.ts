/**
 * Official OpenCode v2 session forms (not questions).
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode-ai/client` is not approved for this cut. GET/POST go through
 * the existing Host shallow proxy + `runtimeFetch`.
 *
 * - list: GET `/api/session/:sessionID/form`
 * - reply: POST `/api/session/:sessionID/form/:formID/reply` body `{ answer }`
 * - cancel: POST `/api/session/:sessionID/form/:formID/cancel`
 *
 * Form IDs start with `frm_`. Failures must throw — never empty success.
 */

import { runtimeFetch } from "../lib/runtime-fetch"

export type SessionFormValue = string | number | boolean | string[]
export type SessionFormAnswer = Record<string, SessionFormValue>

export type SessionFormOption = {
  value: string
  label: string
  description?: string
}

export type SessionFormWhen = {
  key: string
  op: "eq" | "neq"
  value: string | number | boolean
}

export type SessionFormField =
  | {
      key: string
      type: "string"
      title?: string
      description?: string
      required?: boolean
      when?: SessionFormWhen[]
      placeholder?: string
      default?: string
      options?: SessionFormOption[]
    }
  | {
      key: string
      type: "number" | "integer"
      title?: string
      description?: string
      required?: boolean
      when?: SessionFormWhen[]
      default?: number
    }
  | {
      key: string
      type: "boolean"
      title?: string
      description?: string
      required?: boolean
      when?: SessionFormWhen[]
      default?: boolean
    }
  | {
      key: string
      type: "multiselect"
      title?: string
      description?: string
      required?: boolean
      when?: SessionFormWhen[]
      options: SessionFormOption[]
      default?: string[]
    }
  | {
      key: string
      type: "external"
      url: string
      title?: string
      description?: string
    }

export type SessionFormInfo = {
  id: string
  sessionID: string
  title: string
  fields: SessionFormField[]
  metadata?: Record<string, unknown>
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function throwHttp(label: string, status: number, detail?: string): never {
  const suffix = detail ? `: ${detail}` : ""
  const error = new Error(`${label} (${status})${suffix}`) as Error & { status?: number }
  error.status = status
  throw error
}

async function readFailedDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim()
  } catch {
    return ""
  }
}

async function parseJsonBody(response: Response, label: string): Promise<unknown> {
  const contentType = response.headers.get("content-type")
  if (isHtmlContentType(contentType)) {
    throw new Error(`${label}: unexpected HTML response`)
  }
  if (response.status === 204) return null
  const text = await response.text()
  if (!text.trim()) {
    if (response.ok) return null
    throw new Error(`${label}: empty response`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label}: malformed JSON`)
  }
}

function directoryQuery(directory?: string | null): Record<string, string> {
  return directory ? { directory } : {}
}

function parseOption(value: unknown): SessionFormOption | null {
  if (!record(value)) return null
  const optionValue = asString(value.value)
  const label = asString(value.label)
  if (!optionValue || !label) return null
  return {
    value: optionValue,
    label,
    ...(asString(value.description) ? { description: asString(value.description) } : {}),
  }
}

function parseField(value: unknown): SessionFormField | null {
  if (!record(value)) return null
  const key = asString(value.key)
  const type = asString(value.type)
  if (!key || !type) return null
  const title = asString(value.title)
  const description = asString(value.description)
  if (type === "external") {
    const url = asString(value.url)
    if (!url) return null
    return { key, type, url, ...(title ? { title } : {}), ...(description ? { description } : {}) }
  }
  if (type === "string") {
    const options = Array.isArray(value.options) ? value.options.flatMap((entry) => {
      const option = parseOption(entry)
      return option ? [option] : []
    }) : undefined
    return {
      key,
      type,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(typeof value.required === "boolean" ? { required: value.required } : {}),
      ...(asString(value.placeholder) ? { placeholder: asString(value.placeholder) } : {}),
      ...(typeof value.default === "string" ? { default: value.default } : {}),
      ...(options && options.length > 0 ? { options } : {}),
    }
  }
  if (type === "number" || type === "integer") {
    return {
      key,
      type,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(typeof value.required === "boolean" ? { required: value.required } : {}),
      ...(typeof value.default === "number" ? { default: value.default } : {}),
    }
  }
  if (type === "boolean") {
    return {
      key,
      type,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(typeof value.required === "boolean" ? { required: value.required } : {}),
      ...(typeof value.default === "boolean" ? { default: value.default } : {}),
    }
  }
  if (type === "multiselect") {
    const options = Array.isArray(value.options) ? value.options.flatMap((entry) => {
      const option = parseOption(entry)
      return option ? [option] : []
    }) : []
    if (options.length === 0) return null
    return {
      key,
      type,
      options,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(typeof value.required === "boolean" ? { required: value.required } : {}),
      ...(Array.isArray(value.default) ? { default: value.default.filter((item): item is string => typeof item === "string") } : {}),
    }
  }
  return null
}

export function parseSessionFormInfo(payload: unknown): SessionFormInfo {
  const root = record(payload) ? payload : null
  const item = root && record(root.data) ? root.data : root && record(root.form) ? root.form : root
  if (!item) {
    throw new Error("session form: expected form payload")
  }
  const id = asString(item.id)
  const sessionID = asString(item.sessionID)
  const title = asString(item.title)
  if (!id || !id.startsWith("frm_") || !sessionID || !title) {
    throw new Error("session form: missing id, sessionID, or title")
  }
  const fields = Array.isArray(item.fields) ? item.fields.flatMap((entry) => {
    const field = parseField(entry)
    return field ? [field] : []
  }) : []
  if (fields.length === 0) {
    throw new Error("session form: expected fields")
  }
  return {
    id,
    sessionID,
    title,
    fields,
    ...(record(item.metadata) ? { metadata: item.metadata } : {}),
  }
}

export function parseSessionFormList(payload: unknown): SessionFormInfo[] {
  const root = record(payload) ? payload : null
  const items = root && Array.isArray(root.data) ? root.data : Array.isArray(payload) ? payload : null
  if (!items) {
    throw new Error("session form: expected list payload")
  }
  return items.map((entry) => parseSessionFormInfo(entry))
}

export function sessionFormListPath(sessionID: string): string {
  return `/api/session/${encodeURIComponent(sessionID)}/form`
}

export function sessionFormReplyPath(sessionID: string, formID: string): string {
  return `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`
}

export function sessionFormCancelPath(sessionID: string, formID: string): string {
  return `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/cancel`
}

export async function listSessionForms(input: {
  sessionID: string
  directory?: string | null
  signal?: AbortSignal
}): Promise<SessionFormInfo[]> {
  const response = await runtimeFetch(sessionFormListPath(input.sessionID), {
    method: "GET",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session form list", response.status, await readFailedDetail(response))
  }
  return parseSessionFormList(await parseJsonBody(response, "session form list"))
}

export async function postSessionFormReply(input: {
  sessionID: string
  formID: string
  answer: SessionFormAnswer
  directory?: string | null
  signal?: AbortSignal
}): Promise<void> {
  const response = await runtimeFetch(sessionFormReplyPath(input.sessionID, input.formID), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: directoryQuery(input.directory),
    body: JSON.stringify({ answer: input.answer }),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session form reply", response.status, await readFailedDetail(response))
  }
}

export async function postSessionFormCancel(input: {
  sessionID: string
  formID: string
  directory?: string | null
  signal?: AbortSignal
}): Promise<void> {
  const response = await runtimeFetch(sessionFormCancelPath(input.sessionID, input.formID), {
    method: "POST",
    query: directoryQuery(input.directory),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session form cancel", response.status, await readFailedDetail(response))
  }
}
