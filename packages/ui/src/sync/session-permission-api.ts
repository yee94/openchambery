/**
 * Official OpenCode v2 session permission reply.
 *
 * SDK gap: `@opencode-ai/sdk@1.18.4` is not the v2 authority, and
 * `@opencode-ai/client` is not approved for this cut. POST goes through the
 * existing Host shallow proxy + `runtimeFetch`.
 *
 * POST `/api/session/:sessionID/permission/:requestID/reply`
 * body `{ reply: "once" | "always" | "reject", message? }`
 *
 * Server-side reject fails this request and every other pending request for
 * the same session. The client must drop the whole session pending set after
 * a successful reject — not only the replied id.
 */

import { runtimeFetch } from "../lib/runtime-fetch"

export type PermissionReply = "once" | "always" | "reject"

export type PostSessionPermissionReplyInput = {
  sessionID: string
  requestID: string
  reply: PermissionReply
  message?: string
  directory?: string | null
  signal?: AbortSignal
}

const isHtmlContentType = (value: string | null): boolean => {
  if (!value) return false
  return value.toLowerCase().includes("text/html")
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

function directoryQuery(directory?: string | null): Record<string, string> {
  return directory ? { directory } : {}
}

export function sessionPermissionReplyPath(sessionID: string, requestID: string): string {
  return `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`
}

export async function postSessionPermissionReply(input: PostSessionPermissionReplyInput): Promise<void> {
  const response = await runtimeFetch(sessionPermissionReplyPath(input.sessionID, input.requestID), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: directoryQuery(input.directory),
    body: JSON.stringify({
      reply: input.reply,
      ...(input.message ? { message: input.message } : {}),
    }),
    signal: input.signal,
  })
  if (!response.ok) {
    throwHttp("session permission reply", response.status, await readFailedDetail(response))
  }
  if (response.status !== 204) {
    const contentType = response.headers.get("content-type")
    if (isHtmlContentType(contentType)) {
      throw new Error("session permission reply: unexpected HTML response")
    }
  }
}
