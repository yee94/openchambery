/**
 * `session.status=retry` with an `action` is a quota / account prompt,
 * not an ordinary error toast.
 *
 * Official shape:
 * `{ type: "retry", attempt, message, next, action?: { reason, provider, title, message, label, link? } }`
 */

export type SessionRetryAction = {
  reason: string
  provider: string
  title: string
  message: string
  label: string
  link?: string
}

export type SessionRetryStatus = {
  type: "retry"
  attempt?: number
  message?: string
  next?: number
  action?: SessionRetryAction
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function parseSessionRetryAction(value: unknown): SessionRetryAction | null {
  if (!record(value)) return null
  const reason = asString(value.reason)
  const provider = asString(value.provider)
  const title = asString(value.title)
  const message = asString(value.message)
  const label = asString(value.label)
  if (!reason || !provider || !title || !message || !label) return null
  return {
    reason,
    provider,
    title,
    message,
    label,
    ...(asString(value.link) ? { link: asString(value.link) } : {}),
  }
}

export function isSessionRetryAction(status: unknown): status is SessionRetryStatus & { action: SessionRetryAction } {
  if (!record(status) || status.type !== "retry") return false
  return parseSessionRetryAction(status.action) !== null
}

export function resolveRetryActionCopy(
  status: unknown,
  t: (key: string) => string,
): { title: string; message: string; label: string; link?: string } | null {
  if (!isSessionRetryAction(status)) return null
  const action = status.action
  const fallbackTitle = action.reason === "account_rate_limit"
    ? t("chat.retry.action.account")
    : t("chat.retry.action.quota")
  return {
    title: action.title || fallbackTitle,
    message: action.message || status.message || fallbackTitle,
    label: action.label || t("chat.retry.action.open"),
    ...(action.link ? { link: action.link } : {}),
  }
}

export function shouldToastSessionRetryAsError(status: unknown): boolean {
  return !isSessionRetryAction(status)
}
