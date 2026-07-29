/**
 * Session message page-size policy.
 *
 * Every surface (web, desktop/Electron, VS Code, Capacitor/hosted mobile,
 * and private Relay tunnels) shares one page size so bootstrap, history
 * paging, recovery, and materialization never diverge by transport.
 */

/** Shared initial / history page size for every runtime and transport. */
const SESSION_MESSAGE_PAGE_LIMIT = 30
/** Full-ish refetch after mutations that need more than one initial page. */
const MESSAGE_REFETCH_LIMIT = 100
/** Bounded refetch after send to confirm the optimistic user message. */
const SEND_CONFIRMATION_REFETCH_LIMIT = 30

/**
 * Initial session message page size for bootstrap / first paint.
 */
export function getInitialSessionMessageLimit(): number {
  return SESSION_MESSAGE_PAGE_LIMIT
}

/**
 * History (older messages) page size when paging with `before`.
 */
export function getSessionHistoryMessageLimit(): number {
  return SESSION_MESSAGE_PAGE_LIMIT
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
