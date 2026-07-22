import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

const DEFAULT_INITIAL_MESSAGE_PAGE_SIZE = 30
const MOBILE_INITIAL_MESSAGE_PAGE_SIZE = 16
const VSCODE_INITIAL_MESSAGE_PAGE_SIZE = 30

export function getInitialSessionMessagePageSize(): number {
  if (isVSCodeRuntime()) return VSCODE_INITIAL_MESSAGE_PAGE_SIZE
  if (isMobileSurfaceRuntime()) return MOBILE_INITIAL_MESSAGE_PAGE_SIZE
  return DEFAULT_INITIAL_MESSAGE_PAGE_SIZE
}
