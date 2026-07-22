import { isVSCodeRuntime } from "@/lib/desktop"
import { isRelayModeActive } from "@/lib/relay/runtime-tunnel"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

const DEFAULT_INITIAL_MESSAGE_PAGE_SIZE = 30
const MOBILE_INITIAL_MESSAGE_PAGE_SIZE = 16
const RELAY_MOBILE_MESSAGE_PAGE_SIZE = 5
const VSCODE_INITIAL_MESSAGE_PAGE_SIZE = 30
const DEFAULT_HISTORY_MESSAGE_PAGE_SIZE = 30

export function getInitialSessionMessagePageSize(): number {
  if (isVSCodeRuntime()) return VSCODE_INITIAL_MESSAGE_PAGE_SIZE
  if (isMobileSurfaceRuntime()) {
    return isRelayModeActive() ? RELAY_MOBILE_MESSAGE_PAGE_SIZE : MOBILE_INITIAL_MESSAGE_PAGE_SIZE
  }
  return DEFAULT_INITIAL_MESSAGE_PAGE_SIZE
}

export function getSessionHistoryMessagePageSize(): number {
  if (isVSCodeRuntime()) return DEFAULT_HISTORY_MESSAGE_PAGE_SIZE
  if (isMobileSurfaceRuntime() && isRelayModeActive()) return RELAY_MOBILE_MESSAGE_PAGE_SIZE
  return DEFAULT_HISTORY_MESSAGE_PAGE_SIZE
}
