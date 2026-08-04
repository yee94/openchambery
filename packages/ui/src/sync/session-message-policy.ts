/**
 * Session message page-size policy.
 *
 * Every surface (web, desktop/Electron, VS Code, Capacitor/hosted mobile,
 * and private Relay tunnels) shares one initial/recovery/materialize page size
 * so bootstrap never diverges by transport.
 *
 * Prepend / loadMore uses the Host turn-page API (`turns=3`); the history
 * value below is the Host-side upstream `scanLimit` chunk only — not a client
 * message return count.
 */

/** Initial / recovery / materialize page size for every runtime and transport. */
const SESSION_MESSAGE_INITIAL_LIMIT = 30
/**
 * Host turn-page upstream scan chunk (`scanLimit`). Not a client "return 100
 * messages" page size — Host returns turn-bounded records for `turns=3`.
 */
const SESSION_MESSAGE_HISTORY_LIMIT = 100
/** Full-ish refetch after mutations that need more than one initial page. */
const MESSAGE_REFETCH_LIMIT = 100
/** Bounded refetch after send to confirm the optimistic user message. */
const SEND_CONFIRMATION_REFETCH_LIMIT = 30

/**
 * Initial session message page size for bootstrap / first paint.
 */
export function getInitialSessionMessageLimit(): number {
  return SESSION_MESSAGE_INITIAL_LIMIT
}

/**
 * Host scan chunk for turn-page upstream reads (`scanLimit=100`).
 * Client prepend commits turn-bounded Host records, not a fixed 100-message page.
 */
export function getSessionHistoryMessageLimit(): number {
  return SESSION_MESSAGE_HISTORY_LIMIT
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
