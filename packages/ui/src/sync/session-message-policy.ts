/**
 * Session history window policy — **limit means authored-user turns**.
 *
 * Link tier (product turn budgets):
 * - **local** — 本机 / 局域网 direct 连接，网络好，turn 窗口更大
 * - **relay** — 经 private Relay 隧道，首屏与 prepend 固定 **2 轮**
 *
 * Surface (only used for optional legacy helpers; product turns are link-tiered):
 * - desktop / mobile — no longer shrinks turn budgets when on local LAN
 *
 * OpenCode still pages by message count on the wire. Host→OpenCode `scanLimit`
 * is server-owned (`_inner_scanLimit`); clients omit it by default.
 */

import { isRelayModeActive } from "@/lib/relay/runtime-tunnel"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

/** Load surface (legacy helpers / optional tooling). */
export type SessionMessageLoadSurface = "desktop" | "mobile"

/**
 * Transport link tier for product turn limits.
 * local = direct 本机/局域网; relay = active E2EE tunnel.
 */
export type SessionMessageLinkTier = "local" | "relay"

/** First paint turns on 本机 / 局域网. */
const INITIAL_TURN_LIMIT_LOCAL = 6
/** First paint turns over Relay. */
const INITIAL_TURN_LIMIT_RELAY = 2
/** History prepend turns on 本机 / 局域网. */
const HISTORY_TURN_LIMIT_LOCAL = 6
/** History prepend turns over Relay. */
const HISTORY_TURN_LIMIT_RELAY = 2

/** SDK message refetch after edits (not a product history limit). */
const MESSAGE_REFETCH_MESSAGE_LIMIT = 100
/** SDK message window for post-send confirmation (not product history). */
const SEND_CONFIRMATION_MESSAGE_LIMIT = 30

/**
 * Resolve UI surface (desktop vs mobile). Turn budgets no longer depend on this
 * when the link is local; kept for callers that still pass surface.
 */
export function resolveSessionMessageLoadSurface(): SessionMessageLoadSurface {
  return isMobileSurfaceRuntime() ? "mobile" : "desktop"
}

/** Active transport: relay tunnel vs direct local/LAN. */
export function resolveSessionMessageLinkTier(): SessionMessageLinkTier {
  return isRelayModeActive() ? "relay" : "local"
}

/**
 * Product `limit` for initial / recovery / materialize: authored-user turns.
 * Local/LAN higher; Relay fixed at 2.
 */
export function getInitialSessionTurnLimit(
  link: SessionMessageLinkTier = resolveSessionMessageLinkTier(),
): number {
  return link === "relay" ? INITIAL_TURN_LIMIT_RELAY : INITIAL_TURN_LIMIT_LOCAL
}

/** @deprecated Use getInitialSessionTurnLimit — limit means turns. */
export function getInitialSessionTurnBudget(
  linkOrSurface?: SessionMessageLinkTier | SessionMessageLoadSurface,
): number {
  const link = resolveLinkArg(linkOrSurface)
  return getInitialSessionTurnLimit(link)
}

/**
 * Product `limit` for prepend / loadMore: authored-user turns for one Host page.
 * Local/LAN higher; Relay fixed at 2.
 */
export function getHistorySessionTurnLimit(
  link: SessionMessageLinkTier = resolveSessionMessageLinkTier(),
): number {
  return link === "relay" ? HISTORY_TURN_LIMIT_RELAY : HISTORY_TURN_LIMIT_LOCAL
}

/** @deprecated Use getHistorySessionTurnLimit — limit means turns. */
export function getHistorySessionTurnBudget(
  linkOrSurface?: SessionMessageLinkTier | SessionMessageLoadSurface,
): number {
  return getHistorySessionTurnLimit(resolveLinkArg(linkOrSurface))
}

/**
 * Purpose → product turn limit (not message count).
 */
export function resolveSessionMessageTurnLimit(
  purpose: "initial" | "prepend" | "recovery" | "materialize",
  link: SessionMessageLinkTier = resolveSessionMessageLinkTier(),
): number {
  if (purpose === "prepend") return getHistorySessionTurnLimit(link)
  return getInitialSessionTurnLimit(link)
}

/**
 * @deprecated Host scan is server-owned (`_inner_scanLimit`). Kept only for rare
 * explicit client overrides; default path does not send scanLimit.
 */
export function getSessionTurnPageScanLimit(
  _surface: SessionMessageLoadSurface = resolveSessionMessageLoadSurface(),
): number {
  return 100
}

/**
 * @deprecated Product limit is turns — use getInitialSessionTurnLimit.
 */
export function getInitialSessionMessageLimit(
  linkOrSurface?: SessionMessageLinkTier | SessionMessageLoadSurface,
): number {
  return getInitialSessionTurnLimit(resolveLinkArg(linkOrSurface))
}

/**
 * @deprecated Host scan is server-owned; do not use as product limit.
 */
export function getSessionHistoryMessageLimit(
  _surface: SessionMessageLoadSurface = resolveSessionMessageLoadSurface(),
): number {
  return getSessionTurnPageScanLimit()
}

/** Recovery product limit (turns) — same as initial for the active link. */
export function getSessionRecoveryMessageLimit(
  link: SessionMessageLinkTier = resolveSessionMessageLinkTier(),
): number {
  return getInitialSessionTurnLimit(link)
}

/** Materialize product limit (turns) — same as initial for the active link. */
export function getSessionMaterializationMessageLimit(
  link: SessionMessageLinkTier = resolveSessionMessageLinkTier(),
): number {
  return getInitialSessionTurnLimit(link)
}

/** SDK message refetch window after edits (message count, not product limit). */
export function getMessageRefetchLimit(): number {
  return MESSAGE_REFETCH_MESSAGE_LIMIT
}

/** SDK post-send confirmation window (message count, not product limit). */
export function getSendConfirmationRefetchLimit(): number {
  return SEND_CONFIRMATION_MESSAGE_LIMIT
}

function resolveLinkArg(
  linkOrSurface?: SessionMessageLinkTier | SessionMessageLoadSurface,
): SessionMessageLinkTier {
  if (linkOrSurface === "relay" || linkOrSurface === "local") return linkOrSurface
  // Legacy surface args ("desktop" | "mobile") ignored for turn budgets — use live link.
  return resolveSessionMessageLinkTier()
}
