import { isVSCodeRuntime } from "@/lib/desktop"
import { isRelayModeActive } from "@/lib/relay/runtime-tunnel"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

/** Desktop / Web / Electron / VS Code initial page size. */
const DEFAULT_INITIAL_MESSAGE_LIMIT = 30
/** Capacitor / hosted mobile initial page size (non-relay). */
const MOBILE_INITIAL_MESSAGE_LIMIT = 16
/**
 * Relay mobile keeps a smaller page to bound private-tunnel payload cost.
 * History uses the same value; recovery/materialize track initial.
 */
const RELAY_MOBILE_MESSAGE_LIMIT = 5
/** VS Code matches the shared desktop initial page size. */
const VSCODE_INITIAL_MESSAGE_LIMIT = 30
/** Default history page size outside relay-mobile. */
const DEFAULT_HISTORY_MESSAGE_LIMIT = 30
/** Full-ish refetch after mutations that need more than one initial page. */
const MESSAGE_REFETCH_LIMIT = 100
/** Bounded refetch after send to confirm the optimistic user message. */
const SEND_CONFIRMATION_REFETCH_LIMIT = 30

/**
 * Initial session message page size for bootstrap / first paint.
 * Runtime order: VS Code → mobile (relay vs local) → default desktop.
 */
export function getInitialSessionMessageLimit(): number {
  if (isVSCodeRuntime()) return VSCODE_INITIAL_MESSAGE_LIMIT
  if (isMobileSurfaceRuntime()) {
    return isRelayModeActive() ? RELAY_MOBILE_MESSAGE_LIMIT : MOBILE_INITIAL_MESSAGE_LIMIT
  }
  return DEFAULT_INITIAL_MESSAGE_LIMIT
}

/**
 * History (older messages) page size when paging with `before`.
 * Only relay mobile uses the constrained page; all other surfaces share 30.
 */
export function getSessionHistoryMessageLimit(): number {
  if (isVSCodeRuntime()) return DEFAULT_HISTORY_MESSAGE_LIMIT
  if (isMobileSurfaceRuntime() && isRelayModeActive()) return RELAY_MOBILE_MESSAGE_LIMIT
  return DEFAULT_HISTORY_MESSAGE_LIMIT
}

/** Reconnect / recovery fetch limit — same as initial for the active runtime. */
export function getSessionRecoveryMessageLimit(): number {
  return getInitialSessionMessageLimit()
}

/** Lazy session materialization fetch limit — same as initial for the active runtime. */
export function getSessionMaterializationMessageLimit(): number {
  return getInitialSessionMessageLimit()
}

/** Broad message refetch after edits / queue reconciliation. */
export function getMessageRefetchLimit(): number {
  return MESSAGE_REFETCH_LIMIT
}

/** Post-send confirmation refetch window. */
export function getSendConfirmationRefetchLimit(): number {
  return SEND_CONFIRMATION_REFETCH_LIMIT
}
