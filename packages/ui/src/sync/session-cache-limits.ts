/**
 * Platform session-cache capacity targets.
 *
 * Shared by the child-store eviction path (use-sync) and the QueryCache
 * transcript LRU (session-transcript-query-cache). Values match the existing
 * product budgets: VS Code = 4, mobile = 12, default desktop/web = 40.
 */

import { isVSCodeRuntime } from "@/lib/desktop"
import { isMobileSurfaceRuntime } from "@/lib/runtimeSurface"

import { SESSION_CACHE_LIMIT } from "./types"

export { SESSION_CACHE_LIMIT }

export const VSCODE_SESSION_CACHE_LIMIT = 4

// Mobile surfaces keep a slightly larger session cache than VS Code: with the
// previous limit of 4, routine session switching on a phone evicted sessions
// aggressively, and each eviction forced a full re-materialization tail-page
// pull on the next visit. 12 keeps the recency window big enough to cover a
// typical mobile session-switching session without measurably increasing
// resident memory (messages/parts remain the dominant footprint and are
// bounded per session by the tail page size).
export const MOBILE_SESSION_CACHE_LIMIT = 12

/** True when the runtime uses the smaller constrained session cache budgets. */
export function isConstrainedSessionRuntime(): boolean {
  return isVSCodeRuntime() || isMobileSurfaceRuntime()
}

/** Resolve the platform session capacity target for inactive transcript retention. */
export function getEffectiveSessionCacheLimit(): number {
  if (isVSCodeRuntime()) return VSCODE_SESSION_CACHE_LIMIT
  if (isMobileSurfaceRuntime()) return MOBILE_SESSION_CACHE_LIMIT
  return SESSION_CACHE_LIMIT
}
